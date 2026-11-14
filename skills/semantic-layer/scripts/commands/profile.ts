import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { bool, list, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { findTable, qualifiedName } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { inScope } from "../lib/patterns.ts";
import { emitPlan, executePlanPartial, removePlan, resultsInput, withMaxRows } from "../lib/plan.ts";
import { applyProfile, EMPTY_SAMPLE_REASON, protectedColumns, redactSnapshot, summarizeTable } from "../lib/profile.ts";
import { listModels, loadSource, paths, requireSnapshot, saveSnapshot } from "../lib/project.ts";
import { effectiveScope } from "../lib/table-list.ts";
import { buildProfilePlan, MAX_TOP_COLUMNS, topQueryId } from "../lib/sql/profile.ts";
import type { Snapshot, SnapshotTable, SourceConfig } from "../lib/types.ts";

const DEFAULT_TOP_VALUES = 10;
// Tables larger than this deserve profile.sample_rows.
const LARGE_TABLE_ROWS = 10_000_000;

interface Skipped {
  table: string;
  reason: string;
}

const spec: CommandSpec = {
  summary:
    "Profile in-scope tables (row counts, nulls, distinct counts, ranges, top values) into the snapshot, table by table: a table the database refuses (no SELECT permission, a timeout) is skipped with its reason and the rest are saved. A rerun profiles only the tables still missing or skipped; --all (or --refresh) profiles every table again. Protected columns keep counts (and min and max for numbers and dates) and no top values. --redact rewrites the snapshot's protected profiles, and removes hashed values, without querying.",
  usage: "profile --source <source> [--tables t1,t2] [--all] [--refresh] [--emit-sql] [--results <file>] [--plan <plan_id>] [--redact]",
  options: {
    source: { type: "string" },
    tables: { type: "string", multiple: true },
    all: { type: "boolean" },
    refresh: { type: "boolean" },
    "emit-sql": { type: "boolean" },
    results: { type: "string" },
    plan: { type: "string" },
    redact: { type: "boolean" },
  },
  async run({ values }, ctx) {
    const sourceName = str(values, "source");
    if (!sourceName) throw new UserError("--source is required.");
    const source = loadSource(ctx.root, sourceName);
    const snapshot = requireSnapshot(ctx.root, sourceName);
    // --all and --refresh are one switch: profile every table again.
    const refresh = bool(values, "refresh") || bool(values, "all");
    const emitSql = bool(values, "emit-sql");
    const resultsFile = str(values, "results");
    if (emitSql && resultsFile) throw new UserError("Pass --emit-sql or --results, not both.");
    const input = resultsInput(ctx, values);
    if (bool(values, "redact")) {
      const others = [
        list(values, "tables").length ? "--tables" : "",
        bool(values, "all") ? "--all" : "",
        bool(values, "refresh") ? "--refresh" : "",
        emitSql ? "--emit-sql" : "",
        resultsFile ? "--results" : "",
        input.planId !== undefined ? "--plan" : "",
      ].filter(Boolean);
      if (others.length) throw new UserError(`--redact reads no database and takes no ${others.join(", ")}.`);
      return redactOnly(ctx, source, snapshot);
    }

    const scope = effectiveScope(ctx.root, source);
    const named = list(values, "tables");
    let candidates: SnapshotTable[];
    if (named.length) {
      const unknown: string[] = [];
      const found = new Map<string, SnapshotTable>();
      for (const ref of named) {
        const t = findTable(snapshot.tables, ref);
        if (t) found.set(qualifiedName(t), t);
        else unknown.push(ref);
      }
      if (unknown.length) {
        throw new UserError(
          `Unknown table${unknown.length === 1 ? "" : "s"} in source "${sourceName}": ${unknown.join(", ")}. ` +
            "Use a qualified schema.table name when a bare name is ambiguous; `sl tables` lists them.",
        );
      }
      const outOfScope = [...found.keys()].filter((q) => !inScope(scope, found.get(q)!));
      if (outOfScope.length) {
        throw new UserError(
          `${outOfScope.join(", ")} ${outOfScope.length === 1 ? "is" : "are"} out of scope for source "${sourceName}". ` +
            `Profile in-scope tables only, or change the scope with \`sl scope --source ${sourceName} ... --write\`.`,
        );
      }
      candidates = [...found.values()];
    } else {
      candidates = snapshot.tables.filter((t) => inScope(scope, t));
    }

    const skipped: Skipped[] = [];
    // Without --all a run takes what is missing: tables never profiled and tables the last run skipped.
    const selected = candidates.filter((t) => {
      if (refresh || !t.profiled_at || t.profile_skipped) return true;
      skipped.push({ table: qualifiedName(t), reason: "already profiled" });
      return false;
    });

    const settings = {
      sample_rows: setting(source.profile?.sample_rows, "sample_rows", 1, sourceName),
      top_values: setting(source.profile?.top_values, "top_values", 0, sourceName) ?? DEFAULT_TOP_VALUES,
    };
    // The model files are read before any query runs, so one that fails to parse stops the run
    // first. Columns protected before profiling (by tag, ignored_columns, name or an earlier
    // profile) get no top-values query; ones flagged only by this profile are redacted after it.
    const models = sourceModels(ctx.root, source);
    const protect = protectedColumns(snapshot.tables, models, source.dialect);
    const warnings: string[] = [];
    if (source.dialect === "bigquery" && selected.length) {
      warnings.push(
        `BigQuery bills the bytes each query reads, and this profile reads ${selected.length} table${selected.length === 1 ? "" : "s"}. ` +
          "Emit the plan with --emit-sql and dry-run each query (bq query --dry_run) to see what it would bill before running it" +
          (settings.sample_rows ? "." : `; set profile.sample_rows in sources/${sourceName}.yaml to read large tables through TABLESAMPLE.`),
      );
    }
    if (!settings.sample_rows) {
      for (const t of selected) {
        if ((t.row_count ?? 0) > LARGE_TABLE_ROWS) {
          warnings.push(
            `${qualifiedName(t)} has about ${t.row_count!.toLocaleString("en-US")} rows and is profiled with full scans. ` +
              `Set profile.sample_rows in sources/${sourceName}.yaml to profile a sample.`,
          );
        }
      }
    }
    const details = buildProfilePlan(source, selected, { ...settings, protect });
    const { capped } = details;
    // A top-values query returns at most top_values rows per column it reads.
    const plan = withMaxRows(
      details.plan,
      Object.fromEntries(
        selected.flatMap((t) => {
          const cols = details.top_columns.get(qualifiedName(t));
          return cols ? [[topQueryId(t), cols.length * settings.top_values + 1] as const] : [];
        }),
      ),
    );
    for (const q of details.sorted_samples) {
      warnings.push(
        `${q} is a view, an external table or has no row estimate (as a partitioned Postgres parent may not), so TABLESAMPLE cannot read it: ` +
          "its sample sorts every row, which reads the whole table.",
      );
    }
    for (const c of capped) {
      warnings.push(`${c.table}: top values cover the first ${MAX_TOP_COLUMNS} text and boolean columns; ${c.columns.length} more have none.`);
    }
    for (const w of warnings) ctx.err(`warning: ${w}`);

    if (emitSql) {
      if (!selected.length) ctx.err(nothingMessage(candidates.length, named.length > 0));
      ctx.out(formatJson(emitPlan(ctx, plan, { name: "profile", values, keepsPartial: true })));
      return 0;
    }

    if (!selected.length) {
      if (ctx.json) ctx.out(formatJson({ source: sourceName, profiled: [], skipped, warnings }));
      else ctx.out(nothingMessage(candidates.length, named.length > 0));
      return 0;
    }

    // Each table's queries run on their own: a failure skips that table and the rest are saved.
    const outcome = await executePlanPartial(plan, {
      root: ctx.root,
      source,
      env: ctx.env,
      ...input,
      group: (id) => id.replace(/^(stats|top):/, ""),
      timeoutHint: `${settings.sample_rows ? "lower" : "set"} profile.sample_rows`,
      known: new Set(selected.flatMap((t) => [t.schema ?? "", t.name, qualifiedName(t), ...t.columns.map((c) => c.name)]).map((n) => n.toLowerCase())),
    });
    const wanted = new Set(selected.map(qualifiedName));
    const { snapshot: measured, empty_samples, failed } = applyProfile(snapshot, details, outcome.results, ctx.now().toISOString(), outcome.failed);
    for (const f of failed) {
      wanted.delete(f.table);
      skipped.push(f);
    }
    for (const e of empty_samples) {
      wanted.delete(e.table);
      skipped.push({ table: e.table, reason: EMPTY_SAMPLE_REASON });
      const w =
        `The sample of ${e.table} read no rows of its ${e.row_count.toLocaleString("en-US")}: TABLESAMPLE picks whole storage blocks and reached none. ` +
        "Its earlier profile, if any, is kept. To profile it, raise profile.sample_rows (or remove it) in " +
        `sources/${sourceName}.yaml and run sl profile --source ${sourceName} --tables ${e.table} --refresh.`;
      warnings.push(w);
      ctx.err(`warning: ${w}`);
    }
    // The snapshot is saved whatever succeeded: it records why each skipped table was skipped.
    const { snapshot: updated, redacted } = redactSnapshot(measured, protectedColumns(measured.tables, models, source.dialect), wanted);
    saveSnapshot(ctx.root, updated);
    // Stored top values can hold raw values of columns this profile only now protects, so a plan
    // finished here is removed.
    if (input.planId !== undefined) removePlan(ctx.root, input.planId);

    const profiled = updated.tables
      .filter((t) => wanted.has(qualifiedName(t)))
      .map((t) => ({
        table: qualifiedName(t),
        row_count: t.row_count ?? 0,
        sampled: t.columns.some((c) => c.profile?.sampled === true),
        ...summarizeTable(t, source.dialect),
      }));
    // Non-zero only when no table was profiled.
    const code = profiled.length ? 0 : 1;

    if (ctx.json) {
      ctx.out(formatJson({ source: sourceName, profiled, skipped, warnings, redacted }));
      return code;
    }
    const lines = profiled.map(
      (p) =>
        `${p.table}: ${p.row_count.toLocaleString("en-US")} rows${p.sampled ? " (statistics from a sample)" : ""}; ` +
        `candidate keys: ${p.candidate_keys.join(", ") || "none"}; ` +
        `low-cardinality: ${p.low_cardinality.join(", ") || "none"}`,
    );
    if (redacted.length) {
      lines.push(`Protected columns, stored with counts only (no top values, and min and max only for numbers and dates): ${redacted.join(", ")}.`);
    }
    const already = skipped.filter((x) => x.reason === "already profiled").length;
    if (already) lines.push(`Skipped ${already} already profiled table${already === 1 ? "" : "s"}; pass --all to profile ${already === 1 ? "it" : "them"} again.`);
    lines.push(`Profiled ${profiled.length} table${profiled.length === 1 ? "" : "s"} into ${paths(ctx.root).snapshot(sourceName)}.`);
    if (input.planId !== undefined) lines.push(`Removed plan ${input.planId} and its stored results, which the snapshot now holds.`);
    if (failed.length) {
      lines.push(
        `Skipped ${failed.length} table${failed.length === 1 ? "" : "s"} the database did not answer for${profiled.length ? "; the rest are saved" : ""}:`,
        ...failed.map((f) => `  ${f.table}: ${f.reason}`),
        `Next: fix what each reason names (ask the database's owner for SELECT on the table and USAGE on its schema, or change what a timeout names), or leave a table out with ` +
          `sl scope --source ${sourceName} --exclude <table> --write; then run sl profile --source ${sourceName} again, which profiles only the tables still missing.`,
      );
    }
    if (profiled.length) {
      lines.push(
        "Which columns are protected is a heuristic of names, tags and profiles: review the snapshot's top values before committing it, " +
          "and tag any personal column it missed, then run sl profile --redact. A protected number or date column keeps its min and max, " +
          "which are real values (the oldest birth date, the lowest number).",
      );
    }
    ctx.out(lines.join("\n"));
    return code;
  },
};

// The source's model files as read, for protectedColumns.
function sourceModels(root: string, source: SourceConfig): unknown[] {
  return listModels(root, source.source).map((l) => l.model as unknown);
}

// sl profile --redact: rewrites the snapshot's profiles of protected columns, and of any column
// holding hashed values, to counts only, reading no database.
function redactOnly(ctx: CommandContext, source: SourceConfig, snapshot: Snapshot): number {
  const { snapshot: updated, redacted } = redactSnapshot(snapshot, protectedColumns(snapshot.tables, sourceModels(ctx.root, source), source.dialect));
  if (redacted.length) saveSnapshot(ctx.root, updated);
  const file = paths(ctx.root).snapshot(source.source);
  if (ctx.json) ctx.out(formatJson({ source: source.source, redacted }));
  else if (redacted.length) ctx.out(`Redacted ${redacted.length} column profile${redacted.length === 1 ? "" : "s"} in ${file}: ${redacted.join(", ")}.`);
  else ctx.out(`Nothing to redact: ${file} holds no raw values of protected columns and no hashed values.`);
  return 0;
}

// A profile setting from sources/<s>.yaml: an integer of at least `min`, or undefined when unset.
function setting(value: unknown, key: string, min: number, sourceName: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new UserError(`profile.${key} in sources/${sourceName}.yaml must be an integer of at least ${min}, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function nothingMessage(candidates: number, named: boolean): string {
  if (!candidates) return "Nothing to profile: no tables are in scope. Check the source's scope with `sl scope`.";
  return `Nothing to profile: ${named ? "the named" : `all ${candidates} in-scope`} table${candidates === 1 ? " is" : "s are"} already profiled. Pass --all to profile ${candidates === 1 ? "it" : "them"} again.`;
}

export default spec;

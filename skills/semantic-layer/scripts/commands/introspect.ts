import { relative } from "node:path";
import type { CommandSpec } from "../lib/command.ts";
import { bool, list, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { buildSnapshot, snapshotCounts } from "../lib/introspect.ts";
import { qualifiedName } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { filterInScope } from "../lib/patterns.ts";
import { emitPlan, executePlan, resultsInput } from "../lib/plan.ts";
import { listModels, loadProject, loadSnapshot, loadSource, paths, projectSettings, saveSnapshot } from "../lib/project.ts";
import { changeLines, diffSnapshots, modeledTables, type SnapshotDiff } from "../lib/snapshot-diff.ts";
import { profileState } from "../lib/status.ts";
import { introspectionPlan, schemaMatcher } from "../lib/sql/introspection.ts";
import type { Scope, Snapshot, SnapshotTable, SourceConfig, TableKind } from "../lib/types.ts";

// Datasets named by scope.include patterns such as "analytics.*", for a BigQuery
// source introspected without --schemas.
function scopeSchemas(source: SourceConfig): string[] {
  const out = new Set<string>();
  for (const p of source.scope?.include ?? []) {
    if (p.startsWith("re:")) continue;
    const dot = p.lastIndexOf(".");
    if (dot <= 0) continue;
    const schema = p.slice(0, dot);
    if (!/[*?]/.test(schema)) out.add(schema);
  }
  return [...out];
}

const KIND_WORDS: Record<TableKind, [string, string]> = {
  table: ["table", "tables"],
  view: ["view", "views"],
  external: ["external table", "external tables"],
};

function kindPhrase(byKind: Map<TableKind, number>): string {
  const parts = (["table", "view", "external"] as TableKind[])
    .filter((k) => byKind.has(k))
    .map((k) => {
      const n = byKind.get(k)!;
      return `${n} ${KIND_WORDS[k][n === 1 ? 0 : 1]}`;
    });
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
}

function countByKind(tables: SnapshotTable[]): Map<TableKind, number> {
  const byKind = new Map<TableKind, number>();
  for (const t of tables) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
  return byKind;
}

// Names short and plain enough to pass to --tables unquoted.
const PLAIN_NAME = /^[A-Za-z0-9_.]+$/;
const MAX_NAMED = 8;

// Counts the in-scope tables that have no row count, by kind, and says how they get one,
// e.g. "3 views have no row count yet; sl profile measures them." A table profiled before
// (a view whose row count a re-introspect cleared) is skipped by plain sl profile, so those
// are named apart with the sl profile --refresh command that measures them. Out-of-scope
// tables are left out, since sl profile reads in-scope tables only. Null when every
// in-scope table has a row count.
export function rowCountNote(snapshot: Snapshot, scope?: Scope): { count: number; note: string } | null {
  const missing = filterInScope(scope, snapshot.tables).filter((t) => typeof t.row_count !== "number");
  if (!missing.length) return null;
  const fresh = missing.filter((t) => !t.profiled_at);
  const profiled = missing.filter((t) => t.profiled_at);
  const sentences: string[] = [];
  if (fresh.length) {
    const one = fresh.length === 1;
    sentences.push(`${kindPhrase(countByKind(fresh))} ${one ? "has" : "have"} no row count yet; sl profile measures ${one ? "it" : "them"}.`);
  }
  if (profiled.length) {
    const one = profiled.length === 1;
    const names = profiled.map(qualifiedName);
    const tablesFlag = names.length <= MAX_NAMED && names.every((n) => PLAIN_NAME.test(n)) ? ` --tables ${names.join(",")}` : "";
    sentences.push(
      `${kindPhrase(countByKind(profiled))} profiled earlier ${one ? "has" : "have"} no row count; ` +
        `sl profile --refresh${tablesFlag} measures ${one ? "it" : "them"}.`,
    );
  }
  return { count: missing.length, note: sentences.join(" ") };
}

// Whether a diff touches a table one of `models` is built on: a modeled table that gained, lost or
// retyped columns, or one the new snapshot no longer has. Model files that do not parse count as
// touched, so the hint sends the agent to sl validate, which names them.
function touchesModeledTables(diff: SnapshotDiff | null, previous: Snapshot | null | undefined, next: Snapshot, models: () => unknown[]): boolean {
  if (!diff || (!diff.columns.length && !diff.tables_removed.length)) return false;
  let list: unknown[];
  try {
    list = models();
  } catch {
    return true;
  }
  const before = previous ? modeledTables(previous, list) : new Set<string>();
  const after = modeledTables(next, list) ?? new Set<string>();
  const modeled = new Set([...(before ?? []), ...after]);
  return diff.columns.some((c) => modeled.has(c.table)) || diff.tables_removed.some((t) => modeled.has(t));
}

// The hint introspect ends with once the snapshot holds tables and the scope is focused: sl profile
// while an in-scope table's profile is not complete (profiled_at unset, partial ones included), else
// sl validate when a modeled table changed, else sl status.
function nextHint(snapshot: Snapshot, scope: Scope | undefined, modeledChanged: boolean): string {
  const unprofiled = filterInScope(scope, snapshot.tables).filter((t) => profileState(t) !== "yes");
  if (unprofiled.length) return `Next: sl profile --source ${snapshot.source}`;
  return modeledChanged ? "Next: sl validate" : "Next: sl status";
}

const spec: CommandSpec = {
  summary: "Capture tables, columns, keys and row estimates into the source's snapshot.",
  usage: "introspect --source <source> [--schemas a,b] [--emit-sql] [--results <file>] [--plan <plan_id>]",
  options: {
    source: { type: "string" },
    schemas: { type: "string", multiple: true },
    "emit-sql": { type: "boolean" },
    results: { type: "string" },
    plan: { type: "string" },
  },
  async run({ values }, ctx) {
    const sourceName = str(values, "source");
    if (!sourceName) throw new UserError("--source is required.");
    const project = loadProject(ctx.root);
    const source = loadSource(ctx.root, sourceName);
    let schemas = list(values, "schemas");
    if (!schemas.length && source.dialect === "bigquery") schemas = scopeSchemas(source);
    const plan = introspectionPlan(source, { schemas });

    const input = resultsInput(ctx, values);
    if (bool(values, "emit-sql")) {
      ctx.out(formatJson(emitPlan(ctx, plan, { name: "introspect", values })));
      return 0;
    }
    const results = await executePlan(plan, { root: ctx.root, source, env: ctx.env, ...input });

    const previous = loadSnapshot(ctx.root, source.source);
    const snapshot = buildSnapshot(source, results, ctx.now().toISOString(), previous);
    if (schemas.length && previous) {
      // A run restricted to some schemas leaves the others' tables as they were.
      const wanted = schemaMatcher(source.dialect, schemas);
      const fresh = new Set(snapshot.tables.map((t) => `${t.schema ?? ""}\u0000${t.name}`));
      for (const t of previous.tables) {
        const k = `${t.schema ?? ""}\u0000${t.name}`;
        if (!wanted(t.schema) && !fresh.has(k)) snapshot.tables.push(t);
      }
      snapshot.tables.sort((a, b) => `${a.schema ?? ""}.${a.name}`.localeCompare(`${b.schema ?? ""}.${b.name}`));
    }
    saveSnapshot(ctx.root, snapshot);
    const changes = previous ? diffSnapshots(previous, snapshot) : null;

    const counts = snapshotCounts(snapshot);
    const inScope = filterInScope(source.scope, snapshot.tables).length;
    const { focus_threshold } = projectSettings(project);
    const snapshotPath = paths(ctx.root).snapshot(source.source);
    const unknownRows = rowCountNote(snapshot, source.scope);
    const next =
      counts.tables === 0
        ? `No tables found. Check that the connection can read the catalog${schemas.length ? ` and that ${schemas.join(", ")} exist` : ""}.`
        : inScope > focus_threshold
          ? `${inScope} tables are in scope, more than the focus threshold of ${focus_threshold}. Run \`sl tables --source ${source.source} --groups\` to pick a focus.`
          : nextHint(
              snapshot,
              source.scope,
              touchesModeledTables(changes, previous, snapshot, () => listModels(ctx.root, source.source).map((l) => l.model)),
            );

    if (ctx.json) {
      ctx.out(
        formatJson({
          source: source.source,
          ...counts,
          in_scope: inScope,
          no_row_count: unknownRows?.count ?? 0,
          ...(unknownRows ? { row_count_note: unknownRows.note } : {}),
          snapshot: snapshotPath,
          changes,
          next,
        }),
      );
    } else {
      ctx.out(
        `Introspected ${source.source}: ${counts.tables} tables, ${counts.columns} columns, ` +
          `${counts.primary_keys} primary keys, ${counts.foreign_keys} foreign keys.`,
      );
      ctx.out(`Wrote ${relative(ctx.cwd, snapshotPath) || snapshotPath}.`);
      const modeled = changes ? modeledTables(snapshot, () => listModels(ctx.root, source.source).map((l) => l.model), source.scope) : undefined;
      for (const line of changeLines(changes, source.source, modeled)) ctx.out(line);
      if (unknownRows) ctx.out(unknownRows.note);
      ctx.out(next);
    }
    return 0;
  },
};
export default spec;

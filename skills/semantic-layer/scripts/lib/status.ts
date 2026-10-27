// Progress of a semantic layer, read from its files alone, and the next step
// the skill should take. Nothing here touches a database.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { evaluateAccess, type AccessVisibility } from "./access.ts";
import { canRun } from "./adapters/index.ts";
import { findTable, qualifiedName } from "./naming.ts";
import { inScope } from "./patterns.ts";
import {
  listGoldens,
  listModels,
  listSourceNames,
  loadAccess,
  loadMetrics,
  loadProject,
  loadSnapshot,
  loadSource,
  paths,
  projectSettings,
  stem,
  type LoadedGolden,
  type LoadedModel,
} from "./project.ts";
import { rankTables } from "./rank.ts";
import { incomingKeyColumns, missingColumns, unreferencedColumns } from "./snapshot-diff.ts";
import type { AccessMode, Approval, Dialect, Metric, SnapshotMethod, SnapshotTable, SourceConfig } from "./types.ts";

// Golden count below which the verify phase stays open.
export const MIN_APPROVED_GOLDENS = 5;

export interface ApprovalCount {
  approved: number;
  draft: number;
}

export interface BatchEntry {
  table: string;
  model: string | null;
  model_status: "missing" | "draft";
  score: number;
  reasons: string[];
}

export interface SnapshotSummary {
  method: SnapshotMethod;
  captured_at: string;
  tables: number;
  in_scope: number;
  // In-scope tables that carry a profile.
  profiled: number;
}

export interface SourceStatus {
  source: string;
  dialect: Dialect;
  // The CLI can open a live connection: duckdb, or postgres with connection.env set.
  runnable: boolean;
  snapshot: SnapshotSummary | null;
  needs_focus: boolean;
  models: { total: number; approved: number; draft: number };
  dimensions: ApprovalCount;
  measures: ApprovalCount;
  joins: ApprovalCount;
  joins_without_evidence: number;
  unchecked_joins: string[];
  open_questions: number;
  tables_without_model: number;
  unmodeled_tables: string[];
  unprofiled_tables: string[];
  // Draft models on in-scope tables; only these hold the interview phase open.
  draft_models: string[];
  // Approved models on in-scope tables that still hold draft dimensions, measures or joins.
  // They do not block later phases; the handoff names them.
  models_with_draft_fields: string[];
  // Draft dimensions, measures and joins of models on in-scope tables, as model.field.
  draft_fields: string[];
  // Models whose table is out of scope or missing from the snapshot; the interview and check-join phases skip them.
  out_of_scope_models: string[];
  // Columns of the tables under in-scope models that no field, join key or primary key reads and
  // that ignored_columns does not list; sl draft --new-columns drafts them.
  new_columns: NewColumn[];
  // Columns that fields read (an expr that is one bare or quoted column) and that the snapshot no
  // longer has, for every model whose table is in the snapshot, in scope or not. A table with no
  // known columns and SQL keywords such as current_date are not checked, as sl validate checks them.
  missing_columns: MissingColumn[];
  // Models whose table is not in the snapshot.
  missing_tables: MissingTable[];
  next_batch: BatchEntry[];
}

export interface NewColumn {
  model: string;
  column: string;
  type: string;
}

export interface MissingColumn {
  model: string;
  field: string;
  column: string;
}

export interface MissingTable {
  model: string;
  table: string;
}

export type Phase =
  | "add-source"
  | "introspect"
  | "drift"
  | "scope"
  | "profile"
  | "draft"
  | "interview"
  | "check-join"
  | "metrics"
  | "access"
  | "verify"
  | "done";

export interface NextStep {
  phase: Phase;
  message: string;
  command: string;
  source?: string;
  // True when the command records the owner's approval (sl approve, sl goldens confirm):
  // it runs only after the owner says yes to its readback.
  after_owner_yes: boolean;
}

// Visible counts for the default audience, and the approved models, fields and metrics hidden from it
// by a protected tag (pii, sensitive).
export interface DefaultAudience {
  models: number;
  fields: number;
  metrics: number;
  hidden_by_protected_tags: number;
}

// A next step before after_owner_yes is derived from its command.
type Step = Omit<NextStep, "after_owner_yes">;

// Whether a command records the owner's approval, so it waits for their yes.
export function needsOwnerYes(command: string): boolean {
  return /^sl (approve|goldens confirm)(\s|$)/.test(command);
}

export interface ProjectStatus {
  project: string;
  settings: { focus_threshold: number; batch_size: number };
  sources: SourceStatus[];
  metrics: ApprovalCount;
  // Names of the metrics in metrics.yaml that are not approved.
  draft_metrics: string[];
  // open_questions counts access.yaml's top-level and per-role open questions. mode is access.yaml's
  // mode as the access evaluator reads it (open without access.yaml), and default_audience what a
  // user with no attributes and no assigned roles sees of the reported sources.
  access: {
    state: "missing" | "draft" | "approved";
    roles: number;
    restrictions: number;
    open_questions: number;
    mode: AccessMode;
    default_audience: DefaultAudience;
  };
  // Open questions across the reported sources' models and access.yaml.
  open_questions: number;
  goldens: ApprovalCount;
  // Names of the goldens that are not approved; a golden without a string name goes by its file name.
  draft_goldens: string[];
  // Roles in access.yaml that no approved golden uses. A golden without a role key uses
  // access.yaml's default_role.
  roles_without_goldens: string[];
  next_batch: { source: string; tables: BatchEntry[] } | null;
  next_step: NextStep;
}

// The number of strings in a value read from YAML that should be a string list.
function stringCount(v: unknown): number {
  return Array.isArray(v) ? v.filter((q) => typeof q === "string" && q.trim() !== "").length : 0;
}

// Open questions in access.yaml, at the top level and per role. The file is read
// defensively: anything that is not a list of strings counts as none.
function accessOpenQuestions(access: unknown): number {
  if (!access || typeof access !== "object") return 0;
  const a = access as { open_questions?: unknown; roles?: unknown };
  const roles = Array.isArray(a.roles) ? a.roles : [];
  return (
    stringCount(a.open_questions) +
    roles.reduce<number>((n, r) => n + (r && typeof r === "object" ? stringCount((r as { open_questions?: unknown }).open_questions) : 0), 0)
  );
}

// The role names of access.yaml, read defensively: entries without a string name are skipped.
function roleNames(access: unknown): string[] {
  const roles = access && typeof access === "object" ? (access as { roles?: unknown }).roles : undefined;
  if (!Array.isArray(roles)) return [];
  return roles.flatMap((r) => {
    const name = r && typeof r === "object" ? (r as { name?: unknown }).name : undefined;
    return typeof name === "string" && name !== "" ? [name] : [];
  });
}

function count(items: (Approval | undefined)[]): ApprovalCount {
  const out = { approved: 0, draft: 0 };
  for (const i of items) {
    if (!i) continue;
    if (i.status === "approved") out.approved++;
    else out.draft++;
  }
  return out;
}

// Names of the metrics that are not approved, matching what count() counts as draft: every entry
// but an empty one. An entry without a string name goes by its place in the list, as metrics[1].
function draftMetricNames(metrics: unknown[]): string[] {
  return metrics.flatMap((m, i) => {
    if (!m) return [];
    const { name, status } = (typeof m === "object" ? m : {}) as { name?: unknown; status?: unknown };
    if (status === "approved") return [];
    return [typeof name === "string" && name !== "" ? name : `metrics[${i}]`];
  });
}

// Names of the goldens that are not approved, matching what count() counts as draft: every golden
// but an empty file. A golden goes by the name inside the file, or the file's stem.
function draftGoldenNames(goldens: LoadedGolden[]): string[] {
  return goldens.flatMap(({ path, golden }) => {
    if (!golden) return [];
    const g = typeof golden === "object" ? (golden as { name?: unknown; status?: unknown }) : {};
    if (g.status === "approved") return [];
    return [typeof g.name === "string" && g.name !== "" ? g.name : stem(basename(path))];
  });
}

function draftFields(m: LoadedModel["model"]): string[] {
  return [...(m.dimensions ?? []), ...(m.measures ?? []), ...(m.joins ?? [])]
    .filter((f) => f.status !== "approved")
    .map((f) => `${m.model}.${f.name}`);
}

// Whether the CLI can open a live connection for the source, not only emit query plans.
function liveRunnable(config: SourceConfig): boolean {
  if (!canRun(config)) return false;
  return config.dialect === "duckdb" || !!config.connection?.env;
}

// Whether the dimension or measure `field` of a model is approved.
function approvedField(m: LoadedModel["model"], field: string): boolean {
  const fields = [...(Array.isArray(m.dimensions) ? m.dimensions : []), ...(Array.isArray(m.measures) ? m.measures : [])];
  return fields.some((f) => f?.name === field && f.status === "approved");
}

// The approved fields that read a column the snapshot no longer has, and the approved models whose
// table it no longer has; either opens the drift phase.
interface Drift {
  columns: MissingColumn[];
  tables: MissingTable[];
}

// A source's status, and its drift.
interface SourceReport {
  status: SourceStatus;
  drift: Drift;
}

// The rule sl validate applies to an expr that is one column: a bare identifier that is not a SQL
// keyword such as current_date, or a column quoted the way the dialect quotes.
const BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOUBLE_QUOTED_IDENT = /^"((?:[^"]|"")+)"$/;
const BACKTICK_IDENT = /^`((?:[^`]|``)+)`$/;
const SQL_LITERALS = new Set(["true", "false", "null", "current_date", "current_timestamp", "current_time", "now"]);

// Whether `expr` names `column` the way sl validate checks a column reference.
function checkedColumnRef(expr: unknown, column: string, dialect: Dialect): boolean {
  if (typeof expr !== "string") return false;
  const t = expr.trim();
  const backticks = dialect === "bigquery" || dialect === "databricks";
  const quoted = t.match(backticks ? BACKTICK_IDENT : DOUBLE_QUOTED_IDENT);
  if (quoted) return (backticks ? quoted[1]!.replace(/``/g, "`") : quoted[1]!.replace(/""/g, '"')) === column;
  return t === column && BARE_IDENT.test(t) && !SQL_LITERALS.has(t.toLowerCase());
}

// The columns a model's fields read that `table` does not have, limited to what sl validate reports,
// so that drift clears once validate is clean. A table with no known columns is not checked.
function fieldMissingColumns(m: LoadedModel["model"], table: SnapshotTable, dialect: Dialect): { field: string; column: string }[] {
  if (!Array.isArray(table.columns) || !table.columns.length) return [];
  const fields = [...(Array.isArray(m.dimensions) ? m.dimensions : []), ...(Array.isArray(m.measures) ? m.measures : [])];
  return missingColumns(m, table).filter((x) => fields.some((f) => f?.name === x.field && checkedColumnRef(f.expr, x.column, dialect)));
}

function sourceStatus(root: string, name: string, settings: ProjectStatus["settings"]): SourceReport {
  const config = loadSource(root, name);
  const snapshot = loadSnapshot(root, name);
  const models = listModels(root, name).map((l) => l.model);
  const dims = models.flatMap((m) => m.dimensions ?? []);
  const measures = models.flatMap((m) => m.measures ?? []);
  const joins = models.flatMap((m) => (m.joins ?? []).map((j) => ({ model: m.model, join: j })));

  // Qualified table name (lowercase) -> the model built on it; the models whose table is in the
  // snapshot, and those on in-scope tables.
  const byTable = new Map<string, LoadedModel["model"]>();
  const resolved = new Map<LoadedModel["model"], SnapshotTable>();
  const scopedModels = new Map<LoadedModel["model"], SnapshotTable>();
  const missingTables: MissingTable[] = [];
  if (snapshot) {
    for (const m of models) {
      const t = typeof m.table === "string" ? findTable(snapshot.tables, m.table) : undefined;
      if (!t) {
        if (typeof m.table === "string") missingTables.push({ model: m.model, table: m.table });
        continue;
      }
      byTable.set(qualifiedName(t).toLowerCase(), m);
      resolved.set(m, t);
      if (inScope(config.scope, t)) scopedModels.set(m, t);
    }
  }
  const active = models.filter((m) => scopedModels.has(m));
  const newColumns: NewColumn[] = [];
  for (const m of active) {
    const t = scopedModels.get(m)!;
    for (const c of unreferencedColumns(m, t, config.dialect, incomingKeyColumns(m, models))) {
      newColumns.push({ model: m.model, column: c.name, type: c.type });
    }
  }
  // A model out of scope is still served, so a column it reads is checked wherever its table is.
  const missing: MissingColumn[] = [];
  const drift: Drift = { columns: [], tables: [] };
  for (const [m, t] of resolved) {
    for (const x of fieldMissingColumns(m, t, config.dialect)) {
      missing.push({ model: m.model, ...x });
      if (approvedField(m, x.field)) drift.columns.push({ model: m.model, ...x });
    }
  }
  const approvedModels = new Set(models.filter((m) => m.status === "approved").map((m) => m.model));
  drift.tables = missingTables.filter((x) => approvedModels.has(x.model));

  const tables = snapshot?.tables ?? [];
  const scoped = tables.filter((t) => inScope(config.scope, t));
  const ranked = rankTables(tables).filter((r) => inScope(config.scope, r.table));
  const nextBatch: BatchEntry[] = [];
  for (const r of ranked) {
    if (nextBatch.length >= settings.batch_size) break;
    const m = byTable.get(r.qualified.toLowerCase());
    if (m?.status === "approved") continue;
    nextBatch.push({ table: r.qualified, model: m?.model ?? null, model_status: m ? "draft" : "missing", score: r.score, reasons: r.reasons });
  }

  const unmodeled = scoped.filter((t) => !byTable.has(qualifiedName(t).toLowerCase())).map(qualifiedName);
  const unprofiled = scoped.filter((t) => !t.profiled_at).map(qualifiedName);
  const unchecked = active.flatMap((m) => (m.joins ?? []).filter((j) => !j.evidence).map((j) => `${m.model}.${j.name}`));
  const modelCount = count(models);

  const status: SourceStatus = {
    source: name,
    dialect: config.dialect,
    runnable: liveRunnable(config),
    snapshot: snapshot
      ? {
          method: snapshot.method,
          captured_at: snapshot.captured_at,
          tables: tables.length,
          in_scope: scoped.length,
          profiled: scoped.length - unprofiled.length,
        }
      : null,
    needs_focus: scoped.length > settings.focus_threshold,
    models: { total: models.length, ...modelCount },
    dimensions: count(dims),
    measures: count(measures),
    joins: count(joins.map((j) => j.join)),
    joins_without_evidence: unchecked.length,
    unchecked_joins: unchecked,
    open_questions: models.reduce((n, m) => n + (m.open_questions?.length ?? 0), 0),
    tables_without_model: unmodeled.length,
    unmodeled_tables: unmodeled,
    unprofiled_tables: unprofiled,
    draft_models: active.filter((m) => m.status !== "approved").map((m) => m.model),
    models_with_draft_fields: active.filter((m) => m.status === "approved" && draftFields(m).length > 0).map((m) => m.model),
    draft_fields: active.flatMap(draftFields),
    out_of_scope_models: models.filter((m) => !scopedModels.has(m)).map((m) => m.model),
    new_columns: newColumns,
    missing_columns: missing,
    missing_tables: missingTables,
    next_batch: nextBatch,
  };
  return { status, drift };
}

// The first `max` names, and how many more there are.
export function preview(names: string[], max = 5): string {
  return names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", ");
}

// What nextStep reads beyond the reported status: the drift per source, whether access.yaml parsed
// to a mapping that sl approve can mark, and why the access evaluator could not read access.yaml as
// written (null when it could).
interface StepContext {
  drift: Map<string, Drift>;
  accessReadable: boolean;
  accessProblem: string | null;
}

const OPEN_BASELINE = "everyone sees every approved model, field and metric except those tagged pii or sensitive";
const EXCEPTIONS_QUESTION = "is there anything some people should not see?";

function nextStep(status: Omit<ProjectStatus, "next_step" | "next_batch">, allSources: number, ctx: StepContext): Step {
  const { sources } = status;
  if (allSources === 0) {
    return {
      phase: "add-source",
      message: "No data sources yet. Ask the owner which database, warehouse or lake to start with.",
      command: "sl add-source --name <source> --dialect <dialect>",
    };
  }

  const noSnap = sources.find((s) => !s.snapshot);
  if (noSnap) {
    const s = noSnap.source;
    return noSnap.runnable
      ? {
          phase: "introspect",
          source: s,
          message: `Source "${s}" has no snapshot. Introspect it, or import shared schema context with sl import.`,
          command: `sl introspect --source ${s}`,
        }
      : {
          phase: "introspect",
          source: s,
          message:
            `Source "${s}" (${noSnap.dialect}) has no snapshot. Emit the introspection plan and run it with your own tool, ` +
            `or import an information_schema export, dbt manifest or DDL with sl import --source ${s}.`,
          command: `sl introspect --source ${s} --emit-sql`,
        };
  }

  const empty = sources.find((s) => s.snapshot!.tables === 0);
  if (empty) {
    const s = empty.source;
    return {
      phase: "introspect",
      source: s,
      message:
        `The snapshot of "${s}" holds no tables. Check that the connection or the imported file covers the schemas the owner means, ` +
        `then introspect again or import with sl import --source ${s}.`,
      command: empty.runnable ? `sl introspect --source ${s}` : `sl introspect --source ${s} --emit-sql`,
    };
  }

  // An approved field that reads a column the table no longer has gives wrong answers or fails, so
  // it comes before anything else once the snapshot is in.
  const drifted = sources.find((s) => {
    const d = ctx.drift.get(s.source);
    return !!d && (d.columns.length > 0 || d.tables.length > 0);
  });
  if (drifted) {
    const s = drifted.source;
    const d = ctx.drift.get(s)!;
    const parts: string[] = [];
    if (d.columns.length) {
      const items = d.columns.map((x) => `${x.model}.${x.field} (reads ${x.column})`);
      parts.push(`${items.length} approved field(s) in "${s}" read a column the snapshot no longer has: ${preview(items)}.`);
    }
    if (d.tables.length) {
      const items = d.tables.map((x) => `${x.model} (${x.table})`);
      parts.push(`${items.length} approved model(s) in "${s}" are built on a table the snapshot no longer has: ${preview(items)}.`);
    }
    return {
      phase: "drift",
      source: s,
      message:
        `The table changed: ${parts.join(" ")} ` +
        "Read the affected items back to the owner: revoke each with sl approve --revoke, point it at the column or table that " +
        "replaced it or remove it, and approve it again only after the owner confirms the readback.",
      command: "sl validate",
    };
  }

  const unscoped = sources.find((s) => s.snapshot!.in_scope === 0);
  if (unscoped) {
    const s = unscoped.source;
    return {
      phase: "scope",
      source: s,
      message:
        `The scope of "${s}" selects none of its ${unscoped.snapshot!.tables} tables. Preview the groups and ask the owner again ` +
        `which schemas, prefixes (fct_*), suffixes (*_daily) or names to focus on, then save it with sl scope --source ${s} --include <pattern> --write.`,
      command: `sl tables --source ${s} --groups`,
    };
  }

  const wide = sources.find((s) => s.needs_focus);
  if (wide) {
    const s = wide.source;
    return {
      phase: "scope",
      source: s,
      message:
        `Source "${s}" has ${wide.snapshot!.in_scope} tables in scope, more than the focus threshold of ${status.settings.focus_threshold}. ` +
        "Ask the owner which tables to focus on: by schema, prefix (fct_*), suffix (*_daily) or name. Preview the groups, then save " +
        `the choice with sl scope --source ${s} --include <pattern> --write. To keep them all, raise settings.focus_threshold in semantic.yaml.`,
      command: `sl tables --source ${s} --groups`,
    };
  }

  const unprofiled = sources.find((s) => s.runnable && s.unprofiled_tables.length > 0);
  if (unprofiled) {
    const s = unprofiled.source;
    return {
      phase: "profile",
      source: s,
      message: `${unprofiled.unprofiled_tables.length} in-scope table(s) in "${s}" have no profile: ${preview(unprofiled.unprofiled_tables)}.`,
      command: `sl profile --source ${s}`,
    };
  }

  const unmodeled = sources.find((s) => s.tables_without_model > 0);
  if (unmodeled) {
    const s = unmodeled.source;
    return {
      phase: "draft",
      source: s,
      message: `${unmodeled.tables_without_model} in-scope table(s) in "${s}" have no model: ${preview(unmodeled.unmodeled_tables)}.`,
      command: `sl draft --source ${s}`,
    };
  }

  const grown = sources.find((s) => s.new_columns.length > 0);
  if (grown) {
    const s = grown.source;
    const cols = grown.new_columns.map((c) => `${c.model}.${c.column} (${c.type})`);
    return {
      phase: "draft",
      source: s,
      message:
        `${cols.length} column(s) of modeled tables in "${s}" have no field and are not in ignored_columns: ${preview(cols)}. ` +
        "Draft them as new fields; approved items stay as they are.",
      command: `sl draft --source ${s} --new-columns`,
    };
  }

  // Only draft models hold the interview open; draft fields inside approved models are
  // reported in draft_fields and models_with_draft_fields and named in the handoff.
  const drafty = sources.find((s) => s.draft_models.length > 0);
  if (drafty) {
    const s = drafty.source;
    const batchModels = drafty.next_batch
      .map((b) => b.model)
      .filter((m): m is string => m !== null && drafty.draft_models.includes(m));
    const models = batchModels.length ? batchModels : drafty.draft_models.slice(0, 1);
    const target = models[0]!;
    const what = batchModels.length
      ? `the next batch in "${s}": ${batchModels.join(", ")}`
      : `the draft models in "${s}": ${preview(drafty.draft_models)}`;
    // A join is measured before it is read back, so an unchecked join in the batch comes first.
    const join = drafty.unchecked_joins.find((j) => models.includes(j.split(".")[0]!));
    return {
      phase: "interview",
      source: s,
      message:
        `Interview the owner about ${what}. Read each dimension, measure and join back in plain English and approve it ` +
        "on its own only after the owner confirms that readback; then settle the model's open questions, grain and key, " +
        "read the model back and approve it once they confirm. Fields the owner leaves for later stay draft and go in the handoff.",
      command: join
        ? `sl check-join --source ${s} --model ${join.split(".")[0]} --join ${join.split(".")[1]}`
        : `sl approve --target ${s}.${target} --by "<owner>"`,
    };
  }

  const unchecked = sources.find((s) => s.joins_without_evidence > 0);
  if (unchecked) {
    const s = unchecked.source;
    const [model, join] = unchecked.unchecked_joins[0]!.split(".");
    return {
      phase: "check-join",
      source: s,
      message: `${unchecked.joins_without_evidence} join(s) in "${s}" have no evidence: ${preview(unchecked.unchecked_joins)}.`,
      command: `sl check-join --source ${s} --model ${model} --join ${join}`,
    };
  }

  const measures = sources.reduce((n, s) => n + s.measures.approved + s.measures.draft, 0);
  if (measures > 0 && status.metrics.approved === 0) {
    return {
      phase: "metrics",
      message:
        status.metrics.draft > 0
          ? `${status.metrics.draft} metric(s) in metrics.yaml are drafts. Read them back to the owner and approve what they confirm.`
          : "No metrics yet. Ask the owner which ratios and derived figures they report, and write them to metrics.yaml as drafts.",
      command: status.metrics.draft > 0 ? `sl approve --target metric:<name> --by "<owner>"` : "sl validate",
    };
  }

  const { access } = status;
  // An approved access.yaml the evaluator cannot read as written, or one that is closed with no roles,
  // shows nobody anything, so the access phase stays open.
  const closedEmpty = access.mode === "closed" && access.roles === 0;
  if (access.state !== "approved" || ctx.accessProblem !== null || closedEmpty) {
    const questions = access.open_questions;
    const approved = access.state === "approved" ? "access.yaml is approved, but " : "access.yaml is a draft, and ";
    if (access.state === "missing") {
      return {
        phase: "access",
        message:
          `No access.yaml, so access is open: ${OPEN_BASELINE}. Ask the owner the exceptions question: ${EXCEPTIONS_QUESTION} ` +
          "Write access.yaml as a draft with mode open (or closed for an allowlist) and the roles, restrictions and tags they name, " +
          "even when there are none, then read it back and approve it once they confirm.",
        command: "sl validate",
      };
    }
    if (!ctx.accessReadable) {
      return {
        phase: "access",
        message:
          "access.yaml holds no rules yet (it is empty or not a mapping), so nothing in it applies and access is treated as closed: " +
          `nobody sees anything, and it has no roles yet. Ask the owner the exceptions question: ${EXCEPTIONS_QUESTION} ` +
          "Write mode open (or closed for an allowlist) and the roles, restrictions and tags they name as a draft, " +
          "then read it back and approve it once they confirm.",
        command: "sl validate",
      };
    }
    if (ctx.accessProblem !== null) {
      return {
        phase: "access",
        message:
          `${approved}${ctx.accessProblem} Ask the owner what they meant, fix access.yaml until sl validate reports no access issue, ` +
          "then read the mode, every role and every restriction back to them and approve it once they confirm." +
          (questions ? ` Settle its ${questions} open question(s) too.` : ""),
        command: "sl validate",
      };
    }
    if (closedEmpty) {
      return {
        phase: "access",
        message:
          `${access.state === "approved" ? "access.yaml is approved, but it" : "access.yaml"} is closed and has no roles yet, so nobody sees anything. Ask the owner who may see what: roles with allow.models, ` +
          "row filters and denied fields or tags. Write them as a draft." +
          (questions ? ` Settle its ${questions} open question(s) with them.` : ""),
        command: "sl validate",
      };
    }
    if (access.roles === 0 && access.restrictions === 0) {
      return {
        phase: "access",
        message:
          `access.yaml is open and has no roles yet: ${OPEN_BASELINE}. Ask the owner the exceptions question: ${EXCEPTIONS_QUESTION} ` +
          "Write the roles, restrictions and tags they name as a draft; when there are none, read the open baseline back and approve access.yaml once they confirm." +
          (questions ? ` Settle its ${questions} open question(s) with them.` : ""),
        command: ctx.accessReadable && !questions ? `sl approve --target access --by "<owner>"` : "sl validate",
      };
    }
    return {
      phase: "access",
      message:
        `access.yaml is a draft in ${access.mode} mode with ${access.roles} role(s) and ${access.restrictions} restriction(s). ` +
        "Read the mode, every role and every restriction back to the owner and approve it once they confirm." +
        (questions ? ` Settle its ${questions} open question(s) first.` : ""),
      command: `sl approve --target access --by "<owner>"`,
    };
  }

  const uncovered = status.roles_without_goldens;
  const roleNote = uncovered.length ? ` Roles without an approved golden: ${uncovered.join(", ")}.` : "";
  if (status.goldens.approved < MIN_APPROVED_GOLDENS) {
    return {
      phase: "verify",
      message:
        `${status.goldens.approved} of ${MIN_APPROVED_GOLDENS} approved goldens. Ask the owner for questions with known answers, ` +
        "run each golden and record it once they confirm the rows." +
        roleNote,
      command: `sl goldens run --name <golden>`,
    };
  }

  // Every role is verified by at least one approved golden that runs as it.
  if (uncovered.length) {
    const role = uncovered[0]!;
    const others = uncovered.slice(1);
    return {
      phase: "verify",
      message:
        `Role ${role} has no approved golden: write and confirm a golden that runs as role ${role} (role: ${role}), ` +
        "reading its rows back to the owner before confirming." +
        (others.length ? ` Then do the same for ${others.map((r) => `role ${r}`).join(", ")}.` : ""),
      command: `sl goldens run --name <golden>`,
    };
  }

  // Draft metrics, goldens and fields may stay deliberately: the owner can defer them, and
  // the handoff names each one.
  const fields = sources.flatMap((s) => s.draft_fields.map((f) => `${s.source}.${f}`));
  const left = [
    status.draft_metrics.length ? `draft metric(s) ${status.draft_metrics.join(", ")}` : "",
    status.draft_goldens.length ? `draft golden(s) ${status.draft_goldens.join(", ")}` : "",
    fields.length ? `draft field(s) ${fields.join(", ")}` : "",
  ].filter(Boolean);
  return {
    phase: "done",
    message:
      "Every phase the CLI can measure is complete. Rerun sl validate after any change." +
      (left.length ? ` Name in the handoff the ${left.join("; ")}.` : "") +
      " Before the handoff, tick the coverage checklist in references/verification.md; every figure the owner gave needs a golden, draft or approved.",
    command: "sl validate",
  };
}

// Why the access evaluator could not read access.yaml as written, as a clause about the file, or null: a file it treats as
// invalid (nothing in it applies and access is closed), or a mode that is not open or closed.
function accessProblem(v: AccessVisibility): string | null {
  if (v.access_file === "invalid") {
    return "it cannot be read as written (sl validate names the entry), so nothing in it applies and access is treated as closed: nobody sees anything.";
  }
  const mode = v.skipped.find((s) => s.path === "mode");
  if (mode) return `its mode is unreadable (${mode.message}), so a user sees only what a role's allow.models matches.`;
  return null;
}

// What the default audience sees of the given sources, counted the way the access evaluator's
// summary counts the whole layer.
function defaultAudience(v: AccessVisibility, sourceNames: Set<string>): DefaultAudience {
  const sources = v.sources.filter((s) => sourceNames.has(s.source));
  const models = sources.flatMap((s) => s.models);
  const fields = models.flatMap((m) => m.fields);
  const metrics = sources.flatMap((s) => s.metrics);
  const visible = (xs: { visible: boolean }[]) => xs.filter((x) => x.visible).length;
  const byTag = (x: { status: string; reasons: string[] }) => x.status === "approved" && x.reasons.some((r) => r.startsWith("protected_tag:"));
  return {
    models: visible(models),
    fields: visible(fields),
    metrics: visible(metrics),
    hidden_by_protected_tags: [...models, ...fields, ...metrics].filter(byTag).length,
  };
}

// Reads the project and every source (or only `only`) and works out where the layer stands.
export function computeStatus(root: string, only?: string): ProjectStatus {
  const project = loadProject(root);
  const settings = projectSettings(project);
  // The default source comes first, so its tables are interviewed first.
  const names = listSourceNames(root).sort((x, y) => Number(y === project.default_source) - Number(x === project.default_source));
  if (only) loadSource(root, only);
  const reports = (only ? [only] : names).map((s) => sourceStatus(root, s, settings));
  const sources = reports.map((r) => r.status);
  const drift = new Map(reports.map((r) => [r.status.source, r.drift]));

  const metricsFile = loadMetrics(root);
  const metrics: Metric[] = Array.isArray(metricsFile?.metrics) ? metricsFile.metrics : [];
  const access = loadAccess(root);
  // A file that holds only comments parses to null but still exists: a draft with no roles.
  const accessState: ProjectStatus["access"]["state"] = access
    ? access.status === "approved"
      ? "approved"
      : "draft"
    : existsSync(paths(root).access)
      ? "draft"
      : "missing";
  const audience = evaluateAccess(root);
  const loadedGoldens = listGoldens(root);
  const goldens = loadedGoldens.map((g) => g.golden);
  const accessQuestions = accessOpenQuestions(access);
  const defaultRole = access && typeof access.default_role === "string" ? access.default_role : undefined;
  const goldenRoles = new Set(
    goldens
      .filter((g) => g && typeof g === "object" && g.status === "approved")
      .map((g) => (typeof g.role === "string" ? g.role : g.role == null ? defaultRole : undefined))
      .filter((r): r is string => r !== undefined),
  );

  const base = {
    project: project.name,
    settings,
    sources,
    metrics: count(metrics),
    draft_metrics: draftMetricNames(metrics),
    access: {
      state: accessState,
      roles: Array.isArray(access?.roles) ? access.roles.length : 0,
      restrictions: Array.isArray(access?.restrictions) ? access.restrictions.length : 0,
      open_questions: accessQuestions,
      mode: audience.mode,
      default_audience: defaultAudience(audience, new Set(sources.map((s) => s.source))),
    },
    open_questions: sources.reduce((n, s) => n + s.open_questions, accessQuestions),
    goldens: count(goldens),
    draft_goldens: draftGoldenNames(loadedGoldens),
    roles_without_goldens: roleNames(access).filter((r) => !goldenRoles.has(r)),
  };
  const found = nextStep(base, names.length, {
    drift,
    accessReadable: accessState === "missing" || (!!access && typeof access === "object" && !Array.isArray(access)),
    accessProblem: accessProblem(audience),
  });
  const step: NextStep = { ...found, after_owner_yes: needsOwnerYes(found.command) };
  const batchSource = sources.find((s) => s.source === step.source && s.next_batch.length) ?? sources.find((s) => s.next_batch.length);
  return {
    ...base,
    next_batch: batchSource ? { source: batchSource.source, tables: batchSource.next_batch } : null,
    next_step: step,
  };
}

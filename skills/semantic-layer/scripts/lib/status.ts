// Progress of a semantic layer, read from its files alone, and the next step
// the skill should take. Nothing here touches a database.
import { existsSync } from "node:fs";
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
  type LoadedModel,
} from "./project.ts";
import { rankTables } from "./rank.ts";
import type { Approval, Dialect, SnapshotMethod, SourceConfig } from "./types.ts";

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
  // Draft models on in-scope tables.
  draft_models: string[];
  // Approved models on in-scope tables that still hold draft dimensions, measures or joins.
  models_with_draft_fields: string[];
  // Draft dimensions, measures and joins of models on in-scope tables, as model.field.
  draft_fields: string[];
  // Models whose table is out of scope or missing from the snapshot; the interview and check-join phases skip them.
  out_of_scope_models: string[];
  next_batch: BatchEntry[];
}

export type Phase =
  | "add-source"
  | "introspect"
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
}

export interface ProjectStatus {
  project: string;
  settings: { focus_threshold: number; batch_size: number };
  sources: SourceStatus[];
  metrics: ApprovalCount;
  access: { state: "missing" | "draft" | "approved"; roles: number };
  goldens: ApprovalCount;
  next_batch: { source: string; tables: BatchEntry[] } | null;
  next_step: NextStep;
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

function sourceStatus(root: string, name: string, settings: ProjectStatus["settings"]): SourceStatus {
  const config = loadSource(root, name);
  const snapshot = loadSnapshot(root, name);
  const models = listModels(root, name).map((l) => l.model);
  const dims = models.flatMap((m) => m.dimensions ?? []);
  const measures = models.flatMap((m) => m.measures ?? []);
  const joins = models.flatMap((m) => (m.joins ?? []).map((j) => ({ model: m.model, join: j })));

  // Qualified table name (lowercase) -> the model built on it, and the models on in-scope tables.
  const byTable = new Map<string, LoadedModel["model"]>();
  const scopedModels = new Set<LoadedModel["model"]>();
  if (snapshot) {
    for (const m of models) {
      const t = typeof m.table === "string" ? findTable(snapshot.tables, m.table) : undefined;
      if (!t) continue;
      byTable.set(qualifiedName(t).toLowerCase(), m);
      if (inScope(config.scope, t)) scopedModels.add(m);
    }
  }
  const active = models.filter((m) => scopedModels.has(m));

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

  return {
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
    next_batch: nextBatch,
  };
}

function preview(names: string[], max = 5): string {
  return names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", ");
}

function nextStep(status: Omit<ProjectStatus, "next_step" | "next_batch">, allSources: number): NextStep {
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

  const drafty = sources.find((s) => s.draft_models.length > 0 || s.models_with_draft_fields.length > 0);
  if (drafty) {
    const s = drafty.source;
    const batchModels = drafty.next_batch.map((b) => b.model).filter((m): m is string => m !== null);
    const target = batchModels[0] ?? drafty.draft_models[0] ?? drafty.models_with_draft_fields[0]!;
    const what = batchModels.length
      ? `the next batch in "${s}": ${batchModels.join(", ")}`
      : `the draft models in "${s}": ${preview([...drafty.draft_models, ...drafty.models_with_draft_fields])}`;
    // The first draft field of the target model, else the model itself once its fields are settled.
    const field = drafty.draft_fields.find((f) => f.startsWith(`${target}.`));
    return {
      phase: "interview",
      source: s,
      message:
        `Interview the owner about ${what}. Read each dimension, measure and join back in plain English and approve it ` +
        "on its own once the owner confirms it; then settle the model's open questions, grain and key and approve the model.",
      command: `sl approve --target ${s}.${field ?? target} --by "<owner>"`,
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

  if (status.access.state !== "approved") {
    if (status.access.state === "draft" && status.access.roles === 0) {
      return {
        phase: "access",
        message: "access.yaml has no roles yet. Ask the owner who may see what: roles, row filters and denied fields or tags. Write them as a draft.",
        command: "sl validate",
      };
    }
    return status.access.state === "missing"
      ? {
          phase: "access",
          message: "No access.yaml. Ask the owner who may see what: roles, row filters and denied fields or tags. Write it as a draft.",
          command: "sl validate",
        }
      : {
          phase: "access",
          message: "access.yaml is a draft. Read every role back to the owner and approve it once they confirm.",
          command: `sl approve --target access --by "<owner>"`,
        };
  }

  if (status.goldens.approved < MIN_APPROVED_GOLDENS) {
    return {
      phase: "verify",
      message:
        `${status.goldens.approved} of ${MIN_APPROVED_GOLDENS} approved goldens. Ask the owner for questions with known answers, ` +
        "run each golden and record it once they confirm the rows.",
      command: `sl goldens run --name <golden>`,
    };
  }

  return { phase: "done", message: "Every phase is complete. Rerun sl validate after any change.", command: "sl validate" };
}

// Reads the project and every source (or only `only`) and works out where the layer stands.
export function computeStatus(root: string, only?: string): ProjectStatus {
  const project = loadProject(root);
  const settings = projectSettings(project);
  const names = listSourceNames(root);
  if (only) loadSource(root, only);
  const sources = (only ? [only] : names).map((s) => sourceStatus(root, s, settings));

  const metrics = loadMetrics(root).metrics ?? [];
  const access = loadAccess(root);
  // A file that holds only comments parses to null but still exists: a draft with no roles.
  const accessState: ProjectStatus["access"]["state"] = access
    ? access.status === "approved"
      ? "approved"
      : "draft"
    : existsSync(paths(root).access)
      ? "draft"
      : "missing";
  const goldens = listGoldens(root).map((g) => g.golden);

  const base = {
    project: project.name,
    settings,
    sources,
    metrics: count(metrics),
    access: { state: accessState, roles: access?.roles?.length ?? 0 },
    goldens: count(goldens),
  };
  const step = nextStep(base, names.length);
  const batchSource = sources.find((s) => s.source === step.source && s.next_batch.length) ?? sources.find((s) => s.next_batch.length);
  return {
    ...base,
    next_batch: batchSource ? { source: batchSource.source, tables: batchSource.next_batch } : null,
    next_step: step,
  };
}

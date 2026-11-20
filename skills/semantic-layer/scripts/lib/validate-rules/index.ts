// The seam for validation rules kept outside lib/validate.ts. Every other .ts file in this directory
// is a rule module whose default export takes a RuleContext and reports through ctx.error and
// ctx.warn. The modules load once, in sorted file order, on the first validation, and run in that
// order after every check of lib/validate.ts, so adding a rule file needs no edit to a shared file.
// Loading on first use rather than at import lets a rule module import helpers from lib/validate.ts.
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { AccessFile, Golden, MetricsFile, Model, Project, Snapshot, SnapshotTable, SourceConfig } from "../types.ts";
import type { IdentRules, JoinRef, Reporting, SqlRole } from "../validate.ts";

// A file the Validator has read: its path relative to the semantic root, its stem, its parsed data
// and whether it passed its JSON Schema.
export interface LoadedFile<T> {
  readonly file: string;
  readonly stem: string;
  readonly data: T;
  readonly valid: boolean;
}

// A view of what the Validator has loaded, the lookups a rule needs and the two reporting calls,
// which are the Validator's own error and warn with every argument passed through. The view is
// read-only by type: a rule reads the data and never changes it.
export interface RuleContext extends Reporting {
  readonly root: string;
  readonly project: LoadedFile<Project> | undefined;
  readonly sources: ReadonlyMap<string, LoadedFile<SourceConfig>>;
  readonly snapshots: ReadonlyMap<string, LoadedFile<Snapshot>>;
  // source -> model name -> model
  readonly models: ReadonlyMap<string, ReadonlyMap<string, LoadedFile<Model>>>;
  readonly metrics: LoadedFile<MetricsFile> | undefined;
  readonly access: LoadedFile<AccessFile> | undefined;
  readonly goldens: readonly LoadedFile<Golden>[];
  // The snapshot table of a source by name; snapshot is false when the source has no usable snapshot.
  snapshotTable(source: string, table: string): { snapshot: boolean; table?: SnapshotTable };
  // How the source's SQL resolves an identifier against its snapshot's column names.
  identRules(source: string): IdentRules;
  // Checks a SQL fragment of a model against its columns and joins, reporting what it finds, and
  // returns the join references it resolved.
  checkSqlRefs(file: string, path: string, sql: unknown, model: Model, role: SqlRole): JoinRef[];
  // Every path of at most maxHops to-one joins from one model to another, as model.join steps.
  joinPaths(source: string, from: string, to: string, maxHops?: number): string[][];
  // Whether the owner's latest reply in the ledger for a target is a yes to this hash of it.
  hasYes(ref: string, hash: string): boolean;
  // The text of the readback item the owner's latest yes to this hash of a target answered, as the
  // readback kept it in .semlayer/pending; undefined when there is no such yes or the file is gone.
  yesReadbackText(ref: string, hash: string): string | undefined;
}

export type Rule = (ctx: RuleContext) => void;

const DIR = import.meta.dir;

// The rule modules of a directory, in sorted file order. A module without a default function is a
// mistake in this repository, so it stops validation with the file's name.
export function loadRules(dir: string): { file: string; rule: Rule }[] {
  const load = createRequire(join(dir, "index.ts"));
  const out: { file: string; rule: Rule }[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".ts") || file === "index.ts" || file.endsWith(".test.ts") || file.endsWith(".d.ts")) continue;
    const rule = (load(join(dir, file)) as { default?: unknown }).default;
    if (typeof rule !== "function") throw new Error(`${join(dir, file)} has no default export function (ctx: RuleContext) => void`);
    out.push({ file, rule: rule as Rule });
  }
  return out;
}

let cached: { file: string; rule: Rule }[] | undefined;

function rules(): { file: string; rule: Rule }[] {
  cached ??= loadRules(DIR);
  return cached;
}

// Runs every rule module once against the view.
export function runRules(ctx: RuleContext): void {
  for (const { rule } of rules()) rule(ctx);
}

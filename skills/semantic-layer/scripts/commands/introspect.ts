import { relative, resolve } from "node:path";
import type { CommandSpec } from "../lib/command.ts";
import { bool, list, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { buildSnapshot, snapshotCounts } from "../lib/introspect.ts";
import { formatJson } from "../lib/output.ts";
import { filterInScope } from "../lib/patterns.ts";
import { executePlan } from "../lib/plan.ts";
import { loadProject, loadSnapshot, loadSource, paths, projectSettings, saveSnapshot } from "../lib/project.ts";
import { introspectionPlan, schemaMatcher } from "../lib/sql/introspection.ts";
import type { SourceConfig } from "../lib/types.ts";

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

const spec: CommandSpec = {
  summary: "Capture tables, columns, keys and row estimates into the source's snapshot.",
  usage: "introspect --source <source> [--schemas a,b] [--emit-sql] [--results <file>]",
  options: {
    source: { type: "string" },
    schemas: { type: "string", multiple: true },
    "emit-sql": { type: "boolean" },
    results: { type: "string" },
  },
  async run({ values }, ctx) {
    const sourceName = str(values, "source");
    if (!sourceName) throw new UserError("--source is required.");
    const project = loadProject(ctx.root);
    const source = loadSource(ctx.root, sourceName);
    let schemas = list(values, "schemas");
    if (!schemas.length && source.dialect === "bigquery") schemas = scopeSchemas(source);
    const plan = introspectionPlan(source, { schemas });

    if (bool(values, "emit-sql")) {
      ctx.out(formatJson(plan));
      return 0;
    }
    const resultsFile = str(values, "results");
    const results = await executePlan(plan, {
      root: ctx.root,
      source,
      env: ctx.env,
      resultsFile: resultsFile ? resolve(ctx.cwd, resultsFile) : undefined,
    });

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

    const counts = snapshotCounts(snapshot);
    const inScope = filterInScope(source.scope, snapshot.tables).length;
    const { focus_threshold } = projectSettings(project);
    const snapshotPath = paths(ctx.root).snapshot(source.source);
    const next =
      counts.tables === 0
        ? `No tables found. Check that the connection can read the catalog${schemas.length ? ` and that ${schemas.join(", ")} exist` : ""}.`
        : inScope > focus_threshold
          ? `${inScope} tables are in scope, more than the focus threshold of ${focus_threshold}. Run \`sl tables --source ${source.source} --groups\` to pick a focus.`
          : `Next: sl profile --source ${source.source}`;

    if (ctx.json) {
      ctx.out(formatJson({ source: source.source, ...counts, in_scope: inScope, snapshot: snapshotPath, next }));
    } else {
      ctx.out(
        `Introspected ${source.source}: ${counts.tables} tables, ${counts.columns} columns, ` +
          `${counts.primary_keys} primary keys, ${counts.foreign_keys} foreign keys.`,
      );
      ctx.out(`Wrote ${relative(ctx.cwd, snapshotPath) || snapshotPath}.`);
      ctx.out(next);
    }
    return 0;
  },
};
export default spec;

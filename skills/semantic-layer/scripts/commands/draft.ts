import { existsSync } from "node:fs";
import { relative } from "node:path";
import { type Document, isMap, isSeq, Scalar } from "yaml";
import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { bool, list } from "../lib/command.ts";
import { draftModels, draftNewColumns } from "../lib/draft.ts";
import { UserError } from "../lib/errors.ts";
import { findTable, qualifiedName } from "../lib/naming.ts";
import { formatJson, formatTable } from "../lib/output.ts";
import { inScope, matchesPattern, validatePattern } from "../lib/patterns.ts";
import { listModels, loadProject, loadSource, paths, projectSettings, requireSnapshot } from "../lib/project.ts";
import { effectiveScope } from "../lib/table-list.ts";
import { rankTables } from "../lib/rank.ts";
import type { Model, Scope, Snapshot, SnapshotTable, SourceConfig } from "../lib/types.ts";
import { updateYaml, writeYaml } from "../lib/yaml.ts";
import { sourceFlag } from "./tables.ts";

interface DraftedEntry {
  model: string;
  table: string;
  path: string;
  dimensions: number;
  measures: number;
  joins: number;
  open_questions: number;
}

interface SkippedEntry {
  table: string;
  reason: string;
}

function isPattern(ref: string): boolean {
  return ref.startsWith("re:") || /[*?]/.test(ref);
}

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// The snapshot tables --tables names, by lowercase qualified name. Globs and qualified or
// unambiguous bare names; an unknown or ambiguous name is an error.
function resolveTableRefs(snapshot: Snapshot, refs: string[], sourceName: string): Set<string> {
  const picked = new Set<string>();
  const unknown: string[] = [];
  const keyOf = (t: SnapshotTable) => qualifiedName(t).toLowerCase();
  for (const ref of refs) {
    if (isPattern(ref)) {
      const problem = validatePattern(ref);
      if (problem) throw new UserError(problem);
      const hits = snapshot.tables.filter((t) => matchesPattern(ref, t));
      if (!hits.length) unknown.push(ref);
      for (const t of hits) picked.add(keyOf(t));
    } else {
      const t = findTable(snapshot.tables, ref);
      if (t) {
        picked.add(keyOf(t));
        continue;
      }
      const same = ref.includes(".") ? [] : snapshot.tables.filter((x) => x.name.toLowerCase() === ref.toLowerCase());
      if (same.length > 1) {
        throw new UserError(`"${ref}" is in several schemas (${same.map(qualifiedName).sort().join(", ")}); pass the qualified name.`);
      }
      unknown.push(ref);
    }
  }
  if (unknown.length) {
    throw new UserError(
      `No table matches ${unknown.map((n) => `"${n}"`).join(", ")} in the ${sourceName} snapshot. ` +
        `Run \`sl tables --source ${sourceName} --all\` for the names.`,
    );
  }
  return picked;
}

interface UpdatedEntry {
  model: string;
  // The new dimensions and measures.
  added: string[];
  // The new joins.
  joins: string[];
  skipped: { column: string; reason: string }[];
  // New joins whose target table has no model yet.
  unmodeled: { join: string; to: string; table: string }[];
}

const keyName = (k: unknown) => String((k as { value?: unknown } | null)?.value ?? k);

// Appends items to the sequence at `key`, creating it before `before` (the first of those keys
// present) when the model has none, so every existing line of the file stays as it is. An empty
// sequence (`key: []`) becomes a block list, and the comment on its line moves to the key's line.
function appendItems(doc: Document, key: string, items: unknown[], before: string[]): void {
  if (!items.length) return;
  const node = doc.get(key, true);
  if (isSeq(node) && node.items.length) {
    for (const item of items) node.items.push(doc.createNode(item));
    return;
  }
  const root = doc.contents;
  if (!node && isMap(root)) {
    const at = root.items.findIndex((p) => before.includes(keyName(p.key)));
    if (at >= 0) {
      root.items.splice(at, 0, doc.createPair(key, items));
      return;
    }
  }
  const at = isMap(root) ? root.items.findIndex((p) => keyName(p.key) === key) : -1;
  if (isMap(root) && at >= 0 && isSeq(node) && (node.comment || node.commentBefore)) {
    // The pair is replaced whole, so its new key line carries the comment.
    const name = new Scalar(key);
    const comments = [(root.items[at]!.key as { comment?: string | null } | null)?.comment, node.comment].filter((c): c is string => !!c);
    if (comments.length) name.comment = comments.join(" ");
    const pair = doc.createPair(name, items);
    if (node.commentBefore) (pair.value as { commentBefore?: string | null }).commentBefore = node.commentBefore;
    root.items[at] = pair;
    return;
  }
  doc.set(key, doc.createNode(items));
}

// sl draft --new-columns: drafts the columns no existing model on an in-scope table reads, into the
// table's model that reads the most of its columns.
function draftNewColumnsCommand(
  ctx: CommandContext,
  snapshot: Snapshot,
  source: SourceConfig,
  scope: Scope,
  stripPrefixes: string[],
  refs: string[],
): number {
  const sourceName = source.source;
  const picked = refs.length ? resolveTableRefs(snapshot, refs, sourceName) : null;
  const loaded = listModels(ctx.root, sourceName).filter((l) => l.model && typeof l.model === "object");
  const existing = loaded.map((l) => l.model);
  const modeledKeys = new Set<string>();
  for (const m of existing) {
    const t = typeof m.table === "string" ? findTable(snapshot.tables, m.table) : undefined;
    if (t) modeledKeys.add(qualifiedName(t).toLowerCase());
  }
  const knownTables = snapshot.tables.filter((t) => inScope(scope, t) || modeledKeys.has(qualifiedName(t).toLowerCase()));
  const updated: (UpdatedEntry & { table: string; path: string })[] = [];
  for (const { path, model } of loaded) {
    if (typeof model.table !== "string" || typeof model.model !== "string") continue;
    const table = findTable(snapshot.tables, model.table);
    if (!table || !inScope(scope, table)) continue;
    if (picked && !picked.has(qualifiedName(table).toLowerCase())) continue;
    const r = draftNewColumns(snapshot, table, model as Model, existing, { source: sourceName, stripPrefixes, knownTables });
    if (!r.columns.length) continue;
    updateYaml(path, (doc) => {
      appendItems(doc, "open_questions", r.open_questions, ["ignored_columns", "dimensions", "measures", "joins"]);
      appendItems(doc, "ignored_columns", r.skipped.map((x) => x.column), ["dimensions", "measures", "joins"]);
      appendItems(doc, "dimensions", r.dimensions, ["measures", "joins"]);
      appendItems(doc, "measures", r.measures, ["joins"]);
      appendItems(doc, "joins", r.joins, []);
    });
    updated.push({
      model: model.model,
      added: [...r.dimensions, ...r.measures].map((f) => f.name),
      joins: r.joins.map((j) => j.name),
      skipped: r.skipped,
      unmodeled: r.unmodeled,
      table: qualifiedName(table),
      path,
    });
  }

  if (ctx.json) {
    ctx.out(formatJson({ source: sourceName, updated: updated.map(({ model, added, joins, skipped }) => ({ model, added, joins, skipped })) }));
    return 0;
  }
  if (!updated.length) {
    ctx.out(`No new columns in ${sourceName}: every column of a modeled in-scope table is read by a field or listed in ignored_columns.`);
    return 0;
  }
  const lines = [`Drafted new columns into ${plural(updated.length, "model")} in ${sourceName}:`];
  for (const u of updated) {
    const parts: string[] = [];
    if (u.added.length) parts.push(`added ${u.added.join(", ")}`);
    if (u.joins.length) parts.push(`added ${u.joins.length === 1 ? "the join" : "the joins"} ${u.joins.join(", ")}`);
    if (u.skipped.length) parts.push(`left out ${u.skipped.map((x) => `${x.column} (${x.reason})`).join(", ")}, now in ignored_columns`);
    lines.push(`  ${u.model} (${u.table}, ${relative(ctx.cwd, u.path) || u.path}): ${parts.join("; ")}`);
  }
  // A join to a table with no model fails sl validate and sl check-join until that table is drafted.
  const draftFirst = [...new Set(updated.flatMap((u) => u.unmodeled.map((x) => x.table)))];
  lines.push(
    "",
    "Each new field is a draft with an open question, and the model's own status is unchanged. " +
      `Next: read each new item back to the owner, ${
        draftFirst.length ? `draft ${listPhrase(draftFirst)} first (\`sl draft --source ${sourceName} --tables ${draftFirst.join(",")}\`), ` : ""
      }${updated.some((u) => u.joins.length) ? "run `sl check-join` on each new join, " : ""}then run \`sl validate\`.`,
  );
  ctx.out(lines.join("\n"));
  return 0;
}

const spec: CommandSpec = {
  summary:
    "Write draft models for in-scope tables that have none, with inferred keys and joins. Never overwrites a model. " +
    "With --new-columns, add draft fields for the columns existing models do not read yet.",
  usage:
    "draft --source <source> [--tables t,...] [--strip-prefix p,...] [--force]\n" +
    "draft --source <source> --new-columns [--tables t,...]",
  options: {
    source: { type: "string" },
    tables: { type: "string", multiple: true },
    "strip-prefix": { type: "string", multiple: true },
    force: { type: "boolean" },
    "new-columns": { type: "boolean" },
  },
  async run({ values }, ctx) {
    const project = loadProject(ctx.root);
    const sourceName = sourceFlag(values, project);
    const source = loadSource(ctx.root, sourceName);
    const scope = effectiveScope(ctx.root, source);
    const snapshot = requireSnapshot(ctx.root, sourceName);
    const { focus_threshold } = projectSettings(project);
    // --strip-prefix is saved in the source config the first time, so later drafts name models the same way.
    const flagPrefixes = list(values, "strip-prefix");
    const stripPrefixes = flagPrefixes.length ? flagPrefixes : (source.draft?.strip_prefixes ?? []);
    const force = bool(values, "force");
    if (bool(values, "new-columns")) {
      // --new-columns reads the source's saved strip prefixes and drafts whatever the focus threshold.
      for (const flag of ["force", "strip-prefix"] as const) {
        if (values[flag] !== undefined) {
          throw new UserError(`--${flag} applies only when drafting new models; --new-columns works without it. Run it again without --${flag}.`);
        }
      }
      return draftNewColumnsCommand(ctx, snapshot, source, scope, stripPrefixes, list(values, "tables"));
    }

    const existing = listModels(ctx.root, sourceName).map((l) => l.model).filter((m) => m && typeof m === "object");
    // Qualified table (lowercase) -> the model already built on it.
    const modeled = new Map<string, string>();
    for (const m of existing) {
      if (typeof m.table !== "string") continue;
      const t = findTable(snapshot.tables, m.table);
      const key = (t ? qualifiedName(t) : m.table).toLowerCase();
      if (!modeled.has(key)) modeled.set(key, m.model);
    }
    const keyOf = (t: SnapshotTable) => qualifiedName(t).toLowerCase();
    const scoped = snapshot.tables.filter((t) => inScope(scope, t));
    const ranked = rankTables(snapshot.tables).map((r) => r.table);

    const skipped: SkippedEntry[] = [];
    const refs = list(values, "tables");
    let selected: SnapshotTable[];
    if (refs.length) {
      const picked = resolveTableRefs(snapshot, refs, sourceName);
      selected = [];
      for (const t of ranked) {
        if (!picked.has(keyOf(t))) continue;
        const model = modeled.get(keyOf(t));
        if (model) skipped.push({ table: qualifiedName(t), reason: `already modeled as ${model}` });
        else if (!inScope(scope, t))
          skipped.push({
            table: qualifiedName(t),
            reason: `out of scope; add it with \`sl scope --source ${sourceName} --tables ${qualifiedName(t)} --write\``,
          });
        else selected.push(t);
      }
    } else {
      selected = ranked.filter((t) => inScope(scope, t) && !modeled.has(keyOf(t)));
      for (const t of ranked) {
        const model = modeled.get(keyOf(t));
        if (model && inScope(scope, t)) skipped.push({ table: qualifiedName(t), reason: `already modeled as ${model}` });
      }
      if (selected.length > focus_threshold && !force) {
        throw new UserError(
          `${selected.length} in-scope tables in "${sourceName}" have no model, more than the focus threshold of ${focus_threshold}. ` +
            `Focus first: \`sl tables --source ${sourceName} --groups\` shows table groups and suggested patterns, and ` +
            `\`sl scope --source ${sourceName} --include <pattern> --write\` narrows the scope. ` +
            `Or name tables with --tables (globs such as fct_* work), or pass --force to draft all ${selected.length}.`,
        );
      }
    }

    const knownTables = snapshot.tables.filter((t) => inScope(scope, t) || modeled.has(keyOf(t)));
    const { models, notes } = draftModels(snapshot, selected, existing, { source: sourceName, stripPrefixes, knownTables });

    const drafted: DraftedEntry[] = [];
    for (const model of models) {
      const path = paths(ctx.root).model(sourceName, model.model);
      if (existsSync(path)) {
        skipped.push({ table: model.table, reason: `model file ${path} already exists` });
        continue;
      }
      writeYaml(path, model);
      drafted.push({
        model: model.model,
        table: model.table,
        path,
        dimensions: model.dimensions.length,
        measures: model.measures.length,
        joins: model.joins?.length ?? 0,
        open_questions: model.open_questions?.length ?? 0,
      });
    }

    if (flagPrefixes.length && drafted.length && JSON.stringify(flagPrefixes) !== JSON.stringify(source.draft?.strip_prefixes ?? [])) {
      updateYaml(paths(ctx.root).source(sourceName), (doc) => doc.setIn(["draft", "strip_prefixes"], flagPrefixes));
    }

    if (ctx.json) {
      ctx.out(formatJson({ source: sourceName, drafted, skipped }));
      return 0;
    }

    const lines: string[] = [];
    if (!drafted.length) {
      lines.push(
        skipped.length || scoped.length
          ? `Nothing drafted in ${sourceName}.`
          : `Nothing to draft in ${sourceName}: no table is in scope.`,
      );
    } else {
      lines.push(`Drafted ${plural(drafted.length, "model")} in ${sourceName}:`);
      lines.push(
        formatTable(
          drafted.map((d) => ({
            model: d.model,
            table: d.table,
            dims: d.dimensions,
            measures: d.measures,
            joins: d.joins,
            questions: d.open_questions,
          })),
        ),
      );
    }
    if (skipped.length) {
      lines.push("", `Skipped ${plural(skipped.length, "table")}:`);
      for (const s of skipped) lines.push(`  ${s.table}: ${s.reason}`);
    }
    if (notes.length) {
      lines.push("", "Notes:");
      for (const n of notes) lines.push(`  ${n}`);
    }
    if (drafted.length) {
      lines.push(
        "",
        `Every item is a draft. Next: answer each model's open questions with the owner, ` +
          `run \`sl check-join\` on each join, then \`sl validate\`.`,
      );
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

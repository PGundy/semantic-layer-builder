import { existsSync } from "node:fs";
import type { CommandSpec } from "../lib/command.ts";
import { bool, list } from "../lib/command.ts";
import { draftModels } from "../lib/draft.ts";
import { UserError } from "../lib/errors.ts";
import { findTable, qualifiedName } from "../lib/naming.ts";
import { formatJson, formatTable } from "../lib/output.ts";
import { inScope, matchesPattern, validatePattern } from "../lib/patterns.ts";
import { listModels, loadProject, loadSource, paths, projectSettings, requireSnapshot } from "../lib/project.ts";
import { rankTables } from "../lib/rank.ts";
import type { SnapshotTable } from "../lib/types.ts";
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const spec: CommandSpec = {
  summary: "Write draft models for in-scope tables that have none, with inferred keys and joins. Never overwrites a model.",
  usage: "draft --source <source> [--tables t,...] [--strip-prefix p,...] [--force]",
  options: {
    source: { type: "string" },
    tables: { type: "string", multiple: true },
    "strip-prefix": { type: "string", multiple: true },
    force: { type: "boolean" },
  },
  async run({ values }, ctx) {
    const project = loadProject(ctx.root);
    const sourceName = sourceFlag(values, project);
    const source = loadSource(ctx.root, sourceName);
    const snapshot = requireSnapshot(ctx.root, sourceName);
    const { focus_threshold } = projectSettings(project);
    // --strip-prefix is saved in the source config the first time, so later drafts name models the same way.
    const flagPrefixes = list(values, "strip-prefix");
    const stripPrefixes = flagPrefixes.length ? flagPrefixes : (source.draft?.strip_prefixes ?? []);
    const force = bool(values, "force");

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
    const scoped = snapshot.tables.filter((t) => inScope(source.scope, t));
    const ranked = rankTables(snapshot.tables).map((r) => r.table);

    const skipped: SkippedEntry[] = [];
    const refs = list(values, "tables");
    let selected: SnapshotTable[];
    if (refs.length) {
      const picked = new Set<string>();
      const unknown: string[] = [];
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
      selected = [];
      for (const t of ranked) {
        if (!picked.has(keyOf(t))) continue;
        const model = modeled.get(keyOf(t));
        if (model) skipped.push({ table: qualifiedName(t), reason: `already modeled as ${model}` });
        else if (!inScope(source.scope, t))
          skipped.push({
            table: qualifiedName(t),
            reason: `out of scope; add it with \`sl scope --source ${sourceName} --tables ${qualifiedName(t)} --write\``,
          });
        else selected.push(t);
      }
    } else {
      selected = ranked.filter((t) => inScope(source.scope, t) && !modeled.has(keyOf(t)));
      for (const t of ranked) {
        const model = modeled.get(keyOf(t));
        if (model && inScope(source.scope, t)) skipped.push({ table: qualifiedName(t), reason: `already modeled as ${model}` });
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

    const knownTables = snapshot.tables.filter((t) => inScope(source.scope, t) || modeled.has(keyOf(t)));
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

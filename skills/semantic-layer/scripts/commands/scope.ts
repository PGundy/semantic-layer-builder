import { type Document, isMap, isScalar, isSeq, type YAMLMap } from "yaml";
import type { CommandSpec, OptionValues } from "../lib/command.ts";
import { bool, list } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { findTable, qualifiedName } from "../lib/naming.ts";
import { formatJson, formatTable } from "../lib/output.ts";
import { filterInScope, literalPattern, unmatchedPatterns, validatePattern } from "../lib/patterns.ts";
import { loadProject, loadSource, paths, projectSettings, requireSnapshot } from "../lib/project.ts";
import type { Scope } from "../lib/types.ts";
import { updateYaml } from "../lib/yaml.ts";
import { sourceFlag } from "./tables.ts";

// Repeated pattern flags. A value may hold several globs separated by commas;
// a re: pattern is taken whole, since a regex may contain commas.
function patterns(values: OptionValues, key: string): string[] {
  const v = values[key];
  const raw = Array.isArray(v) ? (v as unknown[]).map(String) : typeof v === "string" ? [v] : [];
  return raw
    .flatMap((s) => (s.trim().startsWith("re:") ? [s] : s.split(",")))
    .map((s) => s.trim())
    .filter(Boolean);
}

// The identity of a pattern. Globs match case-insensitively, so they compare
// lowercased; a re: body stays exact, since case changes a regex's meaning (\d, \D),
// and so does a pattern with a "quoted" part, which matches case included.
function patternKey(p: string): string {
  return p.startsWith("re:") || p.includes('"') ? p : p.toLowerCase();
}

// Drops repeats by patternKey, keeping the first spelling.
function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    const k = patternKey(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Brings the scope map's include or exclude list to `wanted`, editing the
// existing sequence in place so its comments and flow or block style survive:
// unchanged lists are left alone, dropped items are deleted, new ones appended.
function setList(doc: Document, node: YAMLMap, key: "include" | "exclude", wanted: string[]): void {
  if (!wanted.length) {
    node.delete(key);
    return;
  }
  const seq = node.get(key, true);
  if (!isSeq(seq)) {
    node.set(key, doc.createNode(wanted));
    return;
  }
  const values = seq.items.map((item) => (isScalar(item) ? String(item.value) : undefined));
  const same = values.length === wanted.length && values.every((v, i) => v === wanted[i]);
  if (same) return;
  const keep = new Set(wanted);
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v === undefined || !keep.has(v) || values.indexOf(v) !== i) seq.items.splice(i, 1);
  }
  const present = new Set(seq.items.map((item) => (isScalar(item) ? String(item.value) : "")));
  for (const v of wanted) if (!present.has(v)) seq.items.push(doc.createNode(v));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const spec: CommandSpec = {
  summary: "Preview the tables a scope change selects; --write saves it to sources/<source>.yaml.",
  usage:
    "scope --source <source> [--include <pattern>]... [--exclude <pattern>]... [--remove <pattern>]... " +
    "[--tables a,b] [--clear] [--write]",
  options: {
    source: { type: "string" },
    include: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
    remove: { type: "string", multiple: true },
    tables: { type: "string", multiple: true },
    clear: { type: "boolean" },
    write: { type: "boolean" },
  },
  async run({ values }, ctx) {
    const project = loadProject(ctx.root);
    const sourceName = sourceFlag(values, project);
    const source = loadSource(ctx.root, sourceName);
    const snapshot = requireSnapshot(ctx.root, sourceName);
    const tables = [...snapshot.tables].sort((a, b) => compare(qualifiedName(a), qualifiedName(b)));
    const { focus_threshold } = projectSettings(project);

    const includes = patterns(values, "include");
    const excludes = patterns(values, "exclude");
    const removes = patterns(values, "remove");
    for (const p of [...includes, ...excludes, ...removes]) {
      const problem = validatePattern(p);
      if (problem) throw new UserError(problem);
    }

    const unknown: string[] = [];
    const tablePatterns: string[] = [];
    for (const name of list(values, "tables")) {
      const t = findTable(tables, name);
      if (t) {
        tablePatterns.push(literalPattern(t));
        continue;
      }
      const same = name.includes(".") ? [] : tables.filter((x) => x.name.toLowerCase() === name.toLowerCase());
      if (same.length > 1) {
        throw new UserError(`"${name}" is in several schemas (${same.map(qualifiedName).join(", ")}); pass the qualified name.`);
      }
      unknown.push(name);
    }
    if (unknown.length) {
      throw new UserError(
        `No table named ${unknown.map((n) => `"${n}"`).join(", ")} in the ${sourceName} snapshot. ` +
          `Run \`sl tables --source ${sourceName} --all\` for the names.`,
      );
    }

    const current: Scope = source.scope ?? {};
    const base: Scope = bool(values, "clear") ? {} : current;
    const removeSet = new Set(removes.map(patternKey));
    const kept = (p: string) => !removeSet.has(patternKey(p));
    const include = dedupe([...(base.include ?? []), ...includes, ...tablePatterns]).filter(kept);
    const exclude = dedupe([...(base.exclude ?? []), ...excludes]).filter(kept);
    const known = new Set(
      [...(current.include ?? []), ...(current.exclude ?? []), ...includes, ...excludes, ...tablePatterns].map(patternKey),
    );
    const notFound = removes.filter((p) => !known.has(patternKey(p)));
    const next: Scope = {};
    if (include.length) next.include = include;
    if (exclude.length) next.exclude = exclude;

    const before = filterInScope(current, tables).map(qualifiedName);
    const afterTables = filterInScope(next, tables);
    const after = afterTables.map(qualifiedName);
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const added = after.filter((t) => !beforeSet.has(t));
    const removed = before.filter((t) => !afterSet.has(t));
    const unmatched = unmatchedPatterns(next, tables);
    const needsFocus = after.length > focus_threshold;

    const warnings: string[] = [];
    for (const p of unmatched) {
      warnings.push(`Pattern "${p}" matches no table in the snapshot; check its spelling against \`sl tables --source ${sourceName} --all\`.`);
    }
    for (const p of notFound) warnings.push(`--remove "${p}" is not in the scope; nothing to remove.`);
    if (!after.length) warnings.push("No table is in scope.");
    if (needsFocus) {
      warnings.push(
        `${after.length} tables are in scope, more than the focus threshold of ${focus_threshold}. ` +
          "Ask the owner to narrow the focus further before drafting models.",
      );
    }

    const write = bool(values, "write");
    if (write) {
      updateYaml(paths(ctx.root).source(sourceName), (doc) => {
        if (!include.length && !exclude.length) {
          doc.delete("scope");
          return;
        }
        const node = doc.get("scope", true);
        if (!isMap(node)) {
          doc.set("scope", doc.createNode(next));
          return;
        }
        setList(doc, node, "include", include);
        setList(doc, node, "exclude", exclude);
      });
    }

    const tableRows = afterTables.map((t) => ({ table: qualifiedName(t), rows: t.row_count ?? null }));
    if (ctx.json) {
      ctx.out(
        formatJson({
          source: sourceName,
          scope: next,
          before_count: before.length,
          after_count: after.length,
          added,
          removed,
          unmatched_patterns: unmatched,
          needs_focus: needsFocus,
          written: write,
          focus_threshold,
          tables: tableRows,
          warnings,
        }),
      );
      return 0;
    }

    const lines: string[] = [];
    lines.push(`Scope for ${sourceName}:`);
    lines.push(`  include: ${include.length ? include.join(", ") : "(everything)"}`);
    lines.push(`  exclude: ${exclude.length ? exclude.join(", ") : "(nothing)"}`);
    lines.push("");
    lines.push(`Added (${added.length}): ${added.length ? added.join(", ") : "none"}`);
    lines.push(`Removed (${removed.length}): ${removed.length ? removed.join(", ") : "none"}`);
    lines.push("");
    lines.push(`In scope: ${plural(after.length, "table")} of ${tables.length} (was ${before.length}).`);
    if (tableRows.length) {
      lines.push(
        formatTable(
          tableRows.map((r) => ({ table: r.table, rows: r.rows === null ? "?" : r.rows.toLocaleString("en-US") })),
          ["table", "rows"],
        ),
      );
    }
    for (const w of warnings) lines.push(`Warning: ${w}`);
    lines.push("");
    lines.push(
      write
        ? `Saved the scope to ${paths(ctx.root).source(sourceName)}.`
        : "Preview only; nothing was written. Rerun with --write to save this scope.",
    );
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

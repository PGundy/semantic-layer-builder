import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { type Document, isMap, isScalar, isSeq, type YAMLMap } from "yaml";
import type { CommandSpec, OptionValues } from "../lib/command.ts";
import { bool, list, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { findTable, qualifiedName } from "../lib/naming.ts";
import { formatJson, formatTable } from "../lib/output.ts";
import { checkPattern, filterInScope, literalPattern, matchesPattern, unmatchedPatterns, validatePattern } from "../lib/patterns.ts";
import { loadProject, loadSource, paths, projectSettings, requireSnapshot } from "../lib/project.ts";
import {
  combineScope,
  parseTableList,
  problemsMessage,
  renderTableList,
  rootPath,
  type SourceTableList,
  sourceTableList,
  type TableListEntry,
} from "../lib/table-list.ts";
import type { Scope, SnapshotTable } from "../lib/types.ts";
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

// Most entries the human preview lists one per line; --json lists them all.
const ENTRY_LINES = 20;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Refuses to replace an existing file whose text differs from `text` unless --force, and a path
// that is a directory or a symbolic link. `shown` names the file as the user wrote it.
function checkReplace(path: string, shown: string, text: string, force: boolean, how: string): void {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isDirectory()) throw new UserError(`${shown} is a directory; give a file path such as scope/<source>.txt.`);
  if (stat.isSymbolicLink()) throw new UserError(`${shown} is a symbolic link, which could lead outside the semantic root; give a plain file path.`);
  if (!force && readFileSync(path, "utf8") !== text) {
    throw new UserError(`${shown} already exists with other contents, so it is not replaced. Compare the two, then ${how} with --force to replace it.`);
  }
}

// The --to-file target, resolved from the semantic root: refused outside it and on the project's
// own files and the directories sl manages.
function toFilePath(root: string, arg: string): string {
  const target = rootPath(root, arg, "--to-file");
  const rel = relative(resolve(root), target).split(sep).join("/").toLowerCase();
  const own = ["semantic.yaml", "metrics.yaml", "access.yaml", ".gitignore"];
  const dirs = ["sources", "snapshots", "models", "goldens", ".sl"];
  if (own.includes(rel) || dirs.some((d) => rel === d || rel.startsWith(`${d}/`))) {
    throw new UserError(`--to-file ${arg} is one of the files sl manages; give another path, such as scope/<source>.txt.`);
  }
  return target;
}

// One entry of the previewed scope and where it comes from: "scope.include[i]" or "scope.exclude[i]"
// (its index in the saved source file), "tables_file line n", or the flag that gives it now.
interface ScopeEntry {
  origin: string;
  entry: string;
  kind: "include" | "exclude";
}

// Quotes a value for a POSIX shell when it holds anything beyond plain name characters.
function shellArg(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// A flag value that patterns() reads back whole: a glob without a comma, or a re: pattern, with no
// white space at either end.
function flagSafe(p: string): boolean {
  return p.trim() === p && (p.startsWith("re:") || !p.includes(","));
}

// A pattern that can be given as a flag value and selects exactly `t` of `tables`, or null.
// literalPattern comes first; a name a flag would split at a comma gets an escaped re: pattern.
function flagPatternFor(t: SnapshotTable, tables: SnapshotTable[]): string | null {
  for (const p of [literalPattern(t), `re:${qualifiedName(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`]) {
    if (!flagSafe(p) || checkPattern(p)) continue;
    const hit = tables.filter((x) => matchesPattern(p, x));
    if (hit.length === 1 && hit[0] === t) return p;
  }
  return null;
}

// The table-list line that names `t` exactly, case included: every part quoted.
function fileLine(t: SnapshotTable): string {
  const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
  return t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = row;
  }
  return prev[b.length]!;
}

// The table --explain names: table, schema.table or catalog.schema.table, any case. An unknown
// name is an error listing up to five close names; a bare name in several schemas lists them.
function explainTable(tables: SnapshotTable[], ref: string, source: string): SnapshotTable {
  const t = findTable(tables, ref);
  if (t) return t;
  const lower = ref.toLowerCase();
  const same = ref.includes(".") ? [] : tables.filter((x) => x.name.toLowerCase() === lower);
  if (same.length > 1) {
    throw new UserError(`"${ref}" is in several schemas (${same.map(qualifiedName).join(", ")}); pass the qualified name to --explain.`);
  }
  const target = ref.includes(".") ? (x: SnapshotTable) => qualifiedName(x).toLowerCase() : (x: SnapshotTable) => x.name.toLowerCase();
  const limit = Math.max(2, Math.floor(lower.length / 3));
  const close = tables
    .map((x) => {
      const name = target(x);
      // One name inside the other counts as close only when the shorter has 3 characters or more.
      const inside = Math.min(name.length, lower.length) >= 3 && (name.includes(lower) || lower.includes(name));
      return { name: qualifiedName(x), d: inside ? 0 : editDistance(lower, name) };
    })
    .filter((c) => c.d <= limit)
    .sort((a, b) => a.d - b.d || compare(a.name, b.name))
    .slice(0, 5);
  const hint = close.length ? ` Close names: ${close.map((c) => c.name).join(", ")}.` : "";
  throw new UserError(`No table named "${ref}" in the ${source} snapshot.${hint} Run \`sl tables --source ${source} --all\` for every name.`);
}

function entryText(e: ScopeEntry, file: string | undefined): string {
  const where = e.origin.startsWith("tables_file line ") && file ? `${file} line ${e.origin.slice(17)}` : e.origin;
  return `${e.kind} "${e.entry}" (${where})`;
}

const spec: CommandSpec = {
  summary: "Preview the tables a scope change selects; --write saves it to sources/<source>.yaml.",
  usage:
    "scope --source <source> [--include <pattern>]... [--exclude <pattern>]... [--remove <pattern>]... " +
    "[--tables a,b] [--from-file <path>] [--to-file <path>] [--force] [--clear] [--write] [--explain <table>]",
  options: {
    "from-file": { type: "string" },
    "to-file": { type: "string" },
    force: { type: "boolean" },
    source: { type: "string" },
    include: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
    remove: { type: "string", multiple: true },
    tables: { type: "string", multiple: true },
    clear: { type: "boolean" },
    write: { type: "boolean" },
    explain: { type: "string" },
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

    const fromArg = str(values, "from-file");
    const toArg = str(values, "to-file");
    const force = bool(values, "force");
    const clear = bool(values, "clear");
    if (fromArg !== undefined && toArg !== undefined) {
      throw new UserError("Pass --from-file or --to-file, not both: --from-file imports a table-list file, --to-file writes the selection to one.");
    }
    if (force && fromArg === undefined && toArg === undefined) {
      throw new UserError("--force only lets --from-file --write or --to-file replace an existing file; run the command again without it.");
    }

    const warnings: string[] = [];
    // The saved table-list file. One that is missing or has problems stops the command, unless
    // this run replaces or clears it.
    let currentList: SourceTableList | null = null;
    try {
      currentList = sourceTableList(ctx.root, source);
    } catch (e) {
      if (!(e instanceof UserError) || (fromArg === undefined && !clear)) throw e;
      warnings.push(`The saved table-list file is left out of the current scope: ${e.message.split("\n")[0]}`);
    }
    let nextList: { rel: string; entries: TableListEntry[]; line: (p: string) => number | undefined } | null =
      currentList && !clear ? { rel: currentList.rel, entries: currentList.entries, line: (p) => currentList!.entries.find((e) => e.pattern === p)?.line } : null;
    let fromText: string | undefined;
    if (fromArg !== undefined) {
      const fromPath = resolve(ctx.cwd, fromArg);
      if (!fromArg.trim() || !existsSync(fromPath) || !statSync(fromPath).isFile()) {
        throw new UserError(`No table-list file at ${fromPath}. Give the path of a text file with one table or pattern per line.`);
      }
      fromText = readFileSync(fromPath, "utf8");
      const parsed = parseTableList(fromText);
      if (parsed.problems.length) {
        throw new UserError(`${problemsMessage(fromArg, parsed.problems)}\nFix the file and run \`sl scope --source ${sourceName} --from-file ${fromArg}\` again.`);
      }
      nextList = { rel: `scope/${sourceName}.txt`, entries: parsed.entries, line: (p) => parsed.entries.find((e) => e.pattern === p)?.line };
    }

    const current: Scope = source.scope ?? {};
    const base: Scope = clear ? {} : current;
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
    if (nextList) next.tables_file = nextList.rel;
    const nextScope = combineScope(next, nextList?.entries ?? []);

    const before = filterInScope(combineScope(current, currentList?.entries ?? []), tables).map(qualifiedName);
    const afterTables = filterInScope(nextScope, tables);
    const after = afterTables.map(qualifiedName);
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const added = after.filter((t) => !beforeSet.has(t));
    const removed = before.filter((t) => !afterSet.has(t));
    const unmatched = unmatchedPatterns(nextScope, tables);
    const needsFocus = after.length > focus_threshold;

    // Every entry of the previewed scope with its origin: the lists, then the file's lines.
    const savedIndex = (list: string[] | undefined, p: string) => (list ?? []).findIndex((x) => patternKey(x) === patternKey(p));
    const includeKeys = new Set(includes.map(patternKey));
    const entries: ScopeEntry[] = [
      ...include.map((p): ScopeEntry => {
        const i = savedIndex(base.include, p);
        return { origin: i >= 0 ? `scope.include[${i}]` : includeKeys.has(patternKey(p)) ? "--include" : "--tables", entry: p, kind: "include" };
      }),
      ...exclude.map((p): ScopeEntry => {
        const i = savedIndex(base.exclude, p);
        return { origin: i >= 0 ? `scope.exclude[${i}]` : "--exclude", entry: p, kind: "exclude" };
      }),
      ...(nextList?.entries ?? []).map((e): ScopeEntry => ({ origin: `tables_file line ${e.line}`, entry: e.pattern, kind: e.kind })),
    ];
    const fileShown = fromArg ?? nextList?.rel;

    const explainArg = str(values, "explain");
    if (explainArg !== undefined) {
      if (bool(values, "write") || toArg !== undefined) {
        throw new UserError(`--explain only reads; run \`sl scope --source ${sourceName} --explain ${shellArg(explainArg)}\` without --write or --to-file.`);
      }
      if (!explainArg.trim()) {
        throw new UserError(`--explain needs a table name, such as \`sl scope --source ${sourceName} --explain orders\`; run \`sl tables --source ${sourceName} --all\` for the names.`);
      }
      const t = explainTable(tables, explainArg, sourceName);
      const name = qualifiedName(t);
      const hits = entries.filter((e) => matchesPattern(e.entry, t));
      const hitExclude = hits.find((e) => e.kind === "exclude");
      const hitInclude = hits.find((e) => e.kind === "include");
      const noInclude = !entries.some((e) => e.kind === "include");
      const decider = hitExclude ?? (noInclude ? undefined : hitInclude);
      const inScopeNow = !hitExclude && (noInclude || hitInclude !== undefined);
      const kind = decider?.kind ?? (noInclude ? "empty_include" : "no_match");
      const rule =
        kind === "exclude"
          ? "Exclude wins: a table an exclude entry matches is out of scope, whatever include entries match it."
          : kind === "include"
            ? "A table is in scope when an include entry matches it and no exclude entry does."
            : kind === "empty_include"
              ? "The include list is empty, so every table no exclude entry matches is in scope."
              : "No entry matches it, and the include list is not empty, so only tables an include entry matches are in scope.";
      const also = hits.filter((e) => e !== decider);
      if (ctx.json) {
        ctx.out(
          formatJson({
            source: sourceName,
            table: name,
            in_scope: inScopeNow,
            decided_by: { origin: decider?.origin ?? null, entry: decider?.entry ?? null, kind },
            also_matched: also,
            rule,
          }),
        );
        return 0;
      }
      const cmd = `sl scope --source ${sourceName}`;
      // The table-list file a fix goes in, as --from-file reads it from the working directory.
      const listFile = fileShown ?? `scope/${sourceName}.txt`;
      const listArg = shellArg(fromArg ?? (relative(ctx.cwd, resolve(ctx.root, nextList?.rel ?? listFile)) || listFile));
      const viaFile = (line: string) => `add the line \`${line}\` to ${listFile} and run \`${cmd} --from-file ${listArg} --write\``;
      const exact = flagPatternFor(t, tables);
      let next: string;
      if (inScopeNow) {
        next = exact
          ? `To leave it out, run \`${cmd} --exclude ${shellArg(exact)}\`, then add --write to save it.`
          : `To leave it out, ${viaFile(`!${fileLine(t)}`)}.`;
      } else {
        // Every exclude entry that matches the table has to go, and with a non-empty include list
        // an include has to match it.
        const steps: string[] = [];
        const saved = hits.filter((e) => e.origin.startsWith("scope.exclude"));
        const removable = saved.filter((e) => flagSafe(e.entry));
        if (removable.length) {
          const count = tables.filter((x) => removable.some((e) => matchesPattern(e.entry, x))).length;
          const flags = removable.map((e) => `--remove ${shellArg(e.entry)}`).join(" ");
          const what = removable.length === 1 ? "the entry, which matches" : "the entries, which match";
          steps.push(`preview \`${cmd} ${flags}\` (it removes ${what} ${plural(count, "table")}), then add --write`);
        }
        for (const e of saved.filter((x) => !removable.includes(x))) steps.push(`delete ${e.origin} ("${e.entry}") from sources/${sourceName}.yaml`);
        const given = hits.filter((e) => e.origin === "--exclude");
        if (given.length) steps.push(`drop ${given.map((e) => `--exclude ${shellArg(e.entry)}`).join(" and ")} from the command`);
        const fileHits = hits.filter((e) => e.kind === "exclude" && e.origin.startsWith("tables_file line "));
        if (fileHits.length) {
          const nums = fileHits.map((e) => e.origin.slice(17));
          steps.push(`delete or narrow line${nums.length === 1 ? "" : "s"} ${nums.join(", ")} of ${listFile}, then run \`${cmd} --from-file ${listArg} --write\``);
        }
        if (!noInclude && !hitInclude) {
          const plainName = !name.includes(",") && name.trim() === name;
          steps.push(
            plainName
              ? `bring it in with \`${cmd} --tables ${shellArg(name)}\`, then add --write`
              : exact
                ? `bring it in with \`${cmd} --include ${shellArg(exact)}\`, then add --write`
                : viaFile(fileLine(t)),
          );
        }
        const lead = hits.filter((e) => e.kind === "exclude").length > 1 ? "Every exclude entry that matches it has to go. " : "";
        next = `${lead}To bring it ${kind === "no_match" ? "in" : "back"}, ${steps.join("; ")}.`;
      }
      const lines = [`${name} is ${inScopeNow ? "in" : "out of"} scope for ${sourceName}.`];
      if (decider) lines.push(`Decided by: ${entryText(decider, fileShown)}.`);
      lines.push(rule);
      if (also.length) lines.push(`Also matched: ${also.map((e) => entryText(e, fileShown)).join("; ")}.`);
      lines.push(next);
      ctx.out(lines.join("\n"));
      return 0;
    }
    const entryCounts = entries.map((e) => {
      const matches = tables.filter((t) => matchesPattern(e.entry, t)).length;
      return { ...e, matches, unmatched: matches === 0 };
    });
    const bySchema = new Map<string, number>();
    for (const t of afterTables) bySchema.set(t.schema ?? "", (bySchema.get(t.schema ?? "") ?? 0) + 1);
    const schemaCounts = [...bySchema].sort((a, b) => compare(a[0], b[0])).map(([schema, n]) => ({ schema: schema || null, tables: n }));

    const inLists = new Set([...include, ...exclude]);
    for (const p of unmatched) {
      const line = inLists.has(p) ? undefined : nextList?.line(p);
      const where = line === undefined ? "" : ` (${nextList!.rel} line ${line})`;
      warnings.push(`Pattern "${p}"${where} matches no table in the snapshot; check its spelling against \`sl tables --source ${sourceName} --all\`.`);
    }
    const fileKeys = new Set((nextList?.entries ?? []).map((e) => patternKey(e.pattern)));
    for (const p of notFound) {
      warnings.push(
        fileKeys.has(patternKey(p))
          ? `--remove "${p}" is in the table-list file ${nextList!.rel}; edit that file, then import it again with --from-file --write.`
          : `--remove "${p}" is not in the scope; nothing to remove.`,
      );
    }
    if (!after.length) warnings.push("No table is in scope.");
    if (needsFocus) {
      warnings.push(
        `${after.length} tables are in scope, more than the focus threshold of ${focus_threshold}. ` +
          "Ask the owner to narrow the focus further before drafting models.",
      );
    }

    const write = bool(values, "write");
    // Every check runs before anything is written.
    let copyTo: string | undefined;
    if (write && fromText !== undefined) {
      copyTo = rootPath(ctx.root, nextList!.rel, "The table-list file");
      checkReplace(copyTo, nextList!.rel, fromText, force, `rerun \`sl scope --source ${sourceName} --from-file ${fromArg} --write\``);
    }
    let toPath: string | undefined;
    let toText: string | undefined;
    if (toArg !== undefined) {
      if (!afterTables.length) throw new UserError("No table is in scope, so there is nothing to write; an empty table-list file would select every table. Widen the scope first.");
      toPath = toFilePath(ctx.root, toArg);
      toText = renderTableList(sourceName, afterTables, tables);
      checkReplace(toPath, toArg, toText, force, `rerun \`sl scope --source ${sourceName} --to-file ${toArg}\``);
    }
    if (copyTo !== undefined && fromText !== undefined) {
      mkdirSync(dirname(copyTo), { recursive: true });
      writeFileSync(copyTo, fromText);
    }
    if (toPath !== undefined && toText !== undefined) {
      mkdirSync(dirname(toPath), { recursive: true });
      writeFileSync(toPath, toText);
    }
    if (write) {
      updateYaml(paths(ctx.root).source(sourceName), (doc) => {
        if (!include.length && !exclude.length && !nextList) {
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
        if (!nextList) node.delete("tables_file");
        else if (node.get("tables_file") !== nextList.rel) node.set("tables_file", nextList.rel);
      });
    }
    const fileCounts = nextList && {
      path: nextList.rel,
      include: nextList.entries.filter((e) => e.kind === "include").length,
      exclude: nextList.entries.filter((e) => e.kind === "exclude").length,
    };
    const toRel = toPath === undefined ? null : relative(resolve(ctx.root), toPath).split(sep).join("/");

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
          tables_file: fileCounts ?? null,
          to_file: toRel,
          focus_threshold,
          tables: tableRows,
          entries: entryCounts,
          by_schema: schemaCounts,
          warnings,
        }),
      );
      return 0;
    }

    const lines: string[] = [];
    lines.push(`Scope for ${sourceName}:`);
    lines.push(`  include: ${include.length ? include.join(", ") : fileCounts?.include ? "(only the table-list file's entries)" : "(everything)"}`);
    lines.push(`  exclude: ${exclude.length ? exclude.join(", ") : fileCounts?.exclude ? "(only the table-list file's entries)" : "(nothing)"}`);
    if (fileCounts) lines.push(`  tables file: ${fileCounts.path} (${plural(fileCounts.include, "include")}, ${plural(fileCounts.exclude, "exclude")})`);
    lines.push("");
    lines.push(`Added (${added.length}): ${added.length ? added.join(", ") : "none"}`);
    lines.push(`Removed (${removed.length}): ${removed.length ? removed.join(", ") : "none"}`);
    lines.push("");
    lines.push(`In scope: ${plural(after.length, "table")} of ${tables.length} (was ${before.length}).`);
    if (schemaCounts.length > 1) lines.push(`By schema: ${schemaCounts.map((c) => `${c.schema ?? "(none)"} ${c.tables}`).join(", ")}`);
    if (entryCounts.length) {
      lines.push("Matches per entry:");
      for (const e of entryCounts.slice(0, ENTRY_LINES)) lines.push(`  ${entryText(e, fileShown)}: ${plural(e.matches, "table")}`);
      if (entryCounts.length > ENTRY_LINES) {
        lines.push(`  ... and ${entryCounts.length - ENTRY_LINES} more; rerun with --json to list every entry.`);
      }
    }
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
    if (toRel !== null) {
      const shown = relative(ctx.cwd, toPath!) || toPath!;
      lines.push(`Wrote ${plural(afterTables.length, "table")} to ${toRel}.`);
      if (!write) lines.push(`The source file is unchanged. To make the file this source's selection, run \`sl scope --source ${sourceName} --from-file ${shown} --write\`.`);
    }
    if (write) {
      if (copyTo !== undefined) lines.push(`Copied ${fromArg} to ${nextList!.rel}.`);
      lines.push(`Saved the scope to ${paths(ctx.root).source(sourceName)}. Next: \`sl validate\`.`);
    } else if (toRel === null) {
      lines.push(
        fromArg !== undefined
          ? `Preview only; nothing was written. Rerun with --write to copy ${fromArg} to ${nextList!.rel} and save this scope.`
          : "Preview only; nothing was written. Rerun with --write to save this scope.",
      );
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

// Table-list files (spec: Scope patterns, Table-list files): one selection entry per line in the
// grammar of patterns.ts, "!" for an exclude, "#" comments and blank lines allowed. A source's
// scope.tables_file names one, relative to the semantic root; its entries join scope.include and
// scope.exclude. Every command that decides scope reads the combined scope through effectiveScope,
// so none can leave the file out.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { UserError } from "./errors.ts";
import { qualifiedName } from "./naming.ts";
import { checkPattern, type ListEntry, literalPattern, parseEntry } from "./patterns.ts";
import type { Scope, SourceConfig } from "./types.ts";

type Named = { schema?: string | null; name: string };

export interface TableListEntry extends ListEntry {
  // 1-based line of the file.
  line: number;
}

export interface TableListProblem {
  line: number;
  // 1-based character of the line where the problem is.
  column: number;
  message: string;
}

export interface TableList {
  entries: TableListEntry[];
  problems: TableListProblem[];
}

// The text of a line before its comment: a # at the start of the line or after a space or tab
// starts one, unless it is inside a "quoted" part of a name. As in patterns.ts, a quote opens a
// quoted part only where a part starts (after the indent and any "!", or right after a "."), ""
// inside one is a quote, and elsewhere a quote is an ordinary character. A re: entry has no
// quoted parts.
function withoutComment(line: string): string {
  let start = line.length - line.trimStart().length;
  if (line[start] === "!") {
    start++;
    while (/\s/.test(line[start] ?? "")) start++;
  }
  const regex = line.startsWith("re:", start);
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
    if (c === '"' && !regex && (i === start || (i > start && line[i - 1] === "."))) {
      let j = i + 1;
      while (j < line.length && !(line[j] === '"' && line[j + 1] !== '"')) j += line[j] === '"' ? 2 : 1;
      i = j;
    }
  }
  return line;
}

// Reads a table-list file's text. Lines end in LF or CRLF; a leading byte-order mark is dropped.
// Every entry is checked with checkPattern, and each problem keeps its line and character.
export function parseTableList(text: string): TableList {
  const entries: TableListEntry[] = [];
  const problems: TableListProblem[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const body = withoutComment(raw.replace(/\r$/, ""));
    let entry: ListEntry | null;
    try {
      entry = parseEntry(body);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      problems.push({ line, column: body.indexOf("!") + 1, message: e.message });
      return;
    }
    if (!entry) return;
    // Where the pattern starts in the line: after the indent, and after "!" and its spaces.
    let start = body.length - body.trimStart().length;
    if (entry.kind === "exclude") {
      start++;
      while (/\s/.test(body[start] ?? "")) start++;
    }
    const problem = checkPattern(entry.pattern);
    if (problem) problems.push({ line, column: start + problem.offset + 1, message: problem.message });
    else entries.push({ ...entry, line });
  });
  return { entries, problems };
}

function inside(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// The absolute path of a path relative to the semantic root, refused when it is absolute, empty, or
// leads outside the root, a symbolic link on the way included.
export function rootPath(root: string, rel: string, what: string): string {
  if (!rel.trim()) throw new UserError(`${what} is empty; give a path inside the semantic root, such as scope/<source>.txt.`);
  if (isAbsolute(rel)) throw new UserError(`${what} ${rel} is an absolute path; give a path relative to the semantic root ${root}, such as scope/<source>.txt.`);
  const base = resolve(root);
  const target = resolve(base, rel);
  if (!inside(base, target)) throw new UserError(`${what} ${rel} is outside the semantic root ${root}; give a path inside it, such as scope/<source>.txt.`);
  if (existsSync(base)) {
    let dir = target;
    while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
    const realBase = realpathSync(base);
    const realDir = realpathSync(dir);
    if (realDir !== realBase && !realDir.startsWith(realBase + sep)) {
      throw new UserError(`${what} ${rel} leads outside the semantic root ${root} through a link; give a path inside it.`);
    }
  }
  return target;
}

export interface SourceTableList extends TableList {
  // As scope.tables_file spells it.
  rel: string;
  path: string;
  exists: boolean;
}

// Reads the table-list file a source names; throws a UserError when its path is unusable.
export function readSourceTableList(root: string, rel: string): SourceTableList {
  const path = rootPath(root, rel, "scope.tables_file");
  if (!existsSync(path)) return { rel, path, exists: false, entries: [], problems: [] };
  if (!statSync(path).isFile()) throw new UserError(`scope.tables_file ${rel} is not a file; give the path of a table-list file, such as scope/<source>.txt.`);
  return { rel, path, exists: true, ...parseTableList(readFileSync(path, "utf8")) };
}

// The problems of a table-list file as one message, at most five of them, naming `file`.
export function problemsMessage(file: string, problems: TableListProblem[]): string {
  const shown = problems.slice(0, 5).map((p) => `  ${file} line ${p.line}, character ${p.column}: ${p.message}`);
  const more = problems.length > 5 ? [`  ... and ${problems.length - 5} more.`] : [];
  return [`The table-list file ${file} has ${problems.length} problem${problems.length === 1 ? "" : "s"}:`, ...shown, ...more].join("\n");
}

// The entries of the source's table-list file, or none when it names none. A missing file or one
// with problems is an error naming the command that fixes it.
export function sourceTableList(root: string, source: SourceConfig): SourceTableList | null {
  const rel: unknown = source.scope?.tables_file;
  if (rel === undefined) return null;
  const name = source.source;
  const fix =
    `To fix it, edit scope.tables_file in sources/${name}.yaml, import a file with \`sl scope --source ${name} --from-file <path> --write\`, ` +
    `or drop the saved scope with \`sl scope --source ${name} --clear --write\`.`;
  if (typeof rel !== "string") throw new UserError(`scope.tables_file in sources/${name}.yaml must be a path inside the semantic root, such as scope/${name}.txt. ${fix}`);
  let list: SourceTableList;
  try {
    list = readSourceTableList(root, rel);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    throw new UserError(`${e.message} ${fix}`);
  }
  if (!list.exists) {
    throw new UserError(
      `sources/${source.source}.yaml names the table-list file ${rel} in scope.tables_file, but it does not exist. ` +
        `Import one with \`sl scope --source ${source.source} --from-file <path> --write\`, or remove scope.tables_file.`,
    );
  }
  if (list.problems.length) {
    throw new UserError(`${problemsMessage(rel, list.problems)}\nFix the file and run the command again; \`sl validate\` lists every problem.`);
  }
  return list;
}

// A scope with a table-list file's entries joined to its include and exclude lists: includes add
// up, excludes add up, and exclude still wins. The result names no file.
export function combineScope(scope: Scope | undefined, entries: readonly ListEntry[]): Scope {
  const include = [...(scope?.include ?? []), ...entries.filter((e) => e.kind === "include").map((e) => e.pattern)];
  const exclude = [...(scope?.exclude ?? []), ...entries.filter((e) => e.kind === "exclude").map((e) => e.pattern)];
  const out: Scope = {};
  if (include.length) out.include = include;
  if (exclude.length) out.exclude = exclude;
  return out;
}

// The scope that decides which of the source's tables are in scope: scope.include and
// scope.exclude with the entries of scope.tables_file. Use it wherever inScope or filterInScope
// reads a source's scope.
export function effectiveScope(root: string, source: SourceConfig): Scope {
  const list = sourceTableList(root, source);
  return combineScope(source.scope, list?.entries ?? []);
}

// A name another reader of the file could take for something else: a leading ! or #, a leading
// re:, white space before a #, space at either end, or a letter outside ASCII, whose case folding
// can match more than one name.
function risky(part: string): boolean {
  return /^[!#]|^re:|\s#|^\s|\s$/i.test(part) || part.includes('"') || /[^\x00-\x7f]/.test(part);
}

// The line that names one table exactly. Both parts are quoted, matching case included, when the
// plain spelling would be misread or when another table of `all` differs from it only in case.
function exactLine(table: Named, collide: boolean): string {
  const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
  if (!collide && !risky(table.name) && !risky(table.schema ?? "")) return literalPattern(table);
  return table.schema ? `${quote(table.schema)}.${quote(table.name)}` : quote(table.name);
}

// A table-list file naming exactly the `selected` tables of `all`, sorted, under a header comment.
// A name with a line break cannot be one line of the file, so it is refused.
export function renderTableList(source: string, selected: Named[], all: Named[]): string {
  const broken = selected.find((t) => /[\r\n]/.test(qualifiedName(t)));
  if (broken) {
    throw new UserError(
      `The table ${JSON.stringify(qualifiedName(broken))} has a line break in its name, so a table-list file cannot name it. ` +
        `Leave it out with \`sl scope --source ${source} --exclude <pattern>\`, then run --to-file again.`,
    );
  }
  const seen = new Map<string, number>();
  for (const t of all) {
    const k = qualifiedName(t).toLowerCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const lines = selected
    .map((t) => exactLine(t, (seen.get(qualifiedName(t).toLowerCase()) ?? 0) > 1))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const header = [
    `# Tables in scope for source ${source}: ${selected.length} table${selected.length === 1 ? "" : "s"}, written by sl scope --to-file.`,
    "# One entry per line: an exact name, a glob, re:<regex>, or !<entry> to exclude. # starts a comment.",
  ];
  return `${[...header, ...lines].join("\n")}\n`;
}

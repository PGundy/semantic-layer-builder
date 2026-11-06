// Clusters a source's tables by schema, name prefix and name suffix, so an
// owner facing many tables can pick a few scope patterns instead of naming
// tables one by one. Each group carries a ready scope pattern and a suggestion.
import { qualifiedName } from "./naming.ts";
import { checkPattern, inScope, literalPattern, type MatchIndex, matchesPattern, matchIndex } from "./patterns.ts";
import { MIGRATION_TABLES, NOISE_WORDS, PIPELINE_WORDS, classifyTable, noiseReason } from "./rank.ts";
import type { Scope, SnapshotTable } from "./types.ts";

export type GroupKind = "schema" | "prefix" | "suffix" | "noise";
export type Suggestion = "include" | "exclude" | "neutral";

export interface TableGroup {
  kind: GroupKind;
  key: string;
  pattern: string;
  tables: string[];
  // The sum of the known row counts; null when no table in the group has one.
  total_rows: number | null;
  // How many tables in the group have no row count yet.
  rows_unknown: number;
  in_scope: number;
  suggestion: Suggestion;
  reason: string;
}

const KIND_ORDER: Record<GroupKind, number> = { schema: 0, prefix: 1, suffix: 2, noise: 3 };

// A date at the end of a table name: _2024, _202401, _2024_01, _20240101, _2024_01_01.
const DATE_SUFFIX = /_((19|20)\d{2}(_?\d{2}){0,2}|\d{8})$/i;
export const DATE_PATTERN = "re:.*_((19|20)\\d{2}(_?\\d{2}){0,2}|\\d{8})";
export const DATE_KEY = "_<date>";

// One regex that selects the same names as noiseReason(): a noise or pipeline word as a token
// between separators, a date at the end, a migration table or a leading underscore. It names
// rules, not tables, so it stays short and also catches tables added later.
export const NOISE_PATTERN =
  `re:(.*[_.-])?(${[...NOISE_WORDS, ...PIPELINE_WORDS].join("|")})([_.-].*)?` +
  `|.*_((19|20)\\d{2}(_?\\d{2}){0,2}|\\d{8})` +
  `|${MIGRATION_TABLES.join("|")}` +
  `|_.*`;

const RAW_WORDS = new Set(["raw", "src", "source"]);
const STAGING_WORDS = new Set(["stg", "staging", "int", "intermediate"]);

function tokens(name: string): string[] {
  return name.toLowerCase().split("_");
}

function quoted(part: string): string {
  return `"${part.replaceAll('"', '""')}"`;
}

// A spelling that reads as something else at the start of a pattern or of a table-list line: re:
// (a regex), ! (an exclude), # (a comment), or white space that a flag or the file trims.
function misread(s: string): boolean {
  return /^(re:|[!#\s])|\s$/i.test(s);
}

// A schema spelled as it stands in a pattern would mean something else when one of its
// dot-separated parts starts with a quote (an unclosed quoted part), it holds * or ?, or it is misread.
function schemaNeedsQuotes(schema: string): boolean {
  return /[*?]/.test(schema) || schema.split(".").some((p) => p.startsWith('"')) || misread(schema);
}

// The same for the start of a table name: a leading quote, a wildcard, a dot, or a misread start.
function prefixNeedsQuotes(prefix: string): boolean {
  return prefix.startsWith('"') || /[*?.]/.test(prefix) || misread(prefix);
}

// A schema or prefix group's key and pattern. A spelling that needs quotes is quoted and keeps its
// case, since a quoted part matches case included; any other is lowercased and matches any case.
function schemaGroup(schema: string): { key: string; pattern: string } {
  return schemaNeedsQuotes(schema) ? { key: schema, pattern: `${quoted(schema)}.*` } : { key: schema.toLowerCase(), pattern: `${schema.toLowerCase()}.*` };
}

function prefixGroup(prefix: string): { key: string; pattern: string } {
  return prefixNeedsQuotes(prefix) ? { key: prefix, pattern: `${quoted(prefix)}_*` } : { key: prefix.toLowerCase(), pattern: `${prefix.toLowerCase()}_*` };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Code-unit order, so the result does not depend on the runtime's locale.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Rated {
  suggestion: Suggestion;
  reason: string;
}

// Suggestion for a group named by a word: a schema name or a prefix's first token.
function rateWord(word: string, kind: "schema" | "prefix", count: number, label: string): Rated {
  if (kind === "prefix" && (word === "fct" || word === "fact"))
    return { suggestion: "include", reason: "Fact tables: one row per event or transaction, where most measures live." };
  if (kind === "prefix" && word === "dim")
    return { suggestion: "include", reason: "Dimension tables: the customers, products and other things that facts describe." };
  if (RAW_WORDS.has(word))
    return { suggestion: "exclude", reason: "Raw copies of source systems; model the cleaned tables built from them instead." };
  if (STAGING_WORDS.has(word))
    return { suggestion: "exclude", reason: "Staging tables, intermediate steps on the way to the final tables." };
  if (word === "tmp" || word === "temp" || word === "scratch")
    return { suggestion: "exclude", reason: "Temporary or scratch tables that are not meant to be queried." };
  if (word === "backup" || word === "bak" || word === "archive" || word === "archived" || word === "old")
    return { suggestion: "exclude", reason: "Backup or archived copies of other tables." };
  return {
    suggestion: "neutral",
    reason: kind === "schema" ? `${plural(count, "table")} in schema ${label}.` : `${plural(count, "table")} whose names start with ${label}.`,
  };
}

function rateSuffix(token: string, count: number): Rated {
  if (NOISE_WORDS.includes(token))
    return { suggestion: "exclude", reason: `Names end in _${token}, which usually marks temporary, backup or archived copies.` };
  if (/^v\d+$/.test(token))
    return { suggestion: "neutral", reason: `Versioned tables; ask the owner which version is current before modeling both.` };
  return { suggestion: "neutral", reason: `${plural(count, "table")} whose names end in _${token}.` };
}

interface Member {
  table: SnapshotTable;
  qualified: string;
  // Position in the tables groupTables was given.
  index: number;
}

function build(kind: GroupKind, key: string, pattern: string, members: Member[], rated: Rated, scope?: Scope): TableGroup {
  const sorted = [...members].sort((a, b) => compare(a.qualified, b.qualified));
  const known = sorted.filter((m) => typeof m.table.row_count === "number");
  return {
    kind,
    key,
    pattern,
    tables: sorted.map((m) => m.qualified),
    total_rows: known.length ? known.reduce((sum, m) => sum + (m.table.row_count as number), 0) : null,
    rows_unknown: sorted.length - known.length,
    in_scope: sorted.filter((m) => inScope(scope, m.table)).length,
    suggestion: rated.suggestion,
    reason: rated.reason,
  };
}

function push(map: Map<string, Member[]>, key: string, member: Member): void {
  const list = map.get(key);
  if (list) list.push(member);
  else map.set(key, [member]);
}

// True when the pattern is usable and selects exactly the listed members out of all tables,
// so saving the pattern selects the tables the group shows.
function exact(pattern: string, list: Member[], index: MatchIndex<SnapshotTable>): boolean {
  if (checkPattern(pattern)) return false;
  const hits = index.matched(pattern);
  return index.count(pattern) === list.length && list.every((m) => hits[m.index] === 1);
}

// Groups tables by schema, prefix and suffix, plus one group of likely noise.
// A schema, prefix or suffix group is listed only when its pattern selects
// exactly its tables; a suffix with glob characters, or one that dated tables
// also end in, would otherwise select more than the group shows. A schema or
// prefix that a pattern cannot spell plainly (a leading quote, a wildcard) is
// quoted, so its pattern parses and names it exactly.
export function groupTables(tables: SnapshotTable[], scope?: Scope): TableGroup[] {
  const members: Member[] = tables.map((t, index) => ({ table: t, qualified: qualifiedName(t), index }));
  const index = matchIndex(tables);
  const groups: TableGroup[] = [];
  const add = (kind: GroupKind, key: string, pattern: string, list: Member[], rated: Rated): void => {
    if (exact(pattern, list, index)) groups.push(build(kind, key, pattern, list, rated, scope));
  };

  // Schemas are keyed lowercased, since plain patterns match case-insensitively.
  const bySchema = new Map<string, Member[]>();
  const schemaPattern = new Map<string, string>();
  for (const m of members) {
    if (!m.table.schema) continue;
    const g = schemaGroup(m.table.schema);
    push(bySchema, g.key, m);
    schemaPattern.set(g.key, g.pattern);
  }
  if (bySchema.size > 1) {
    for (const [schema, list] of bySchema) {
      if (list.length < 2) continue;
      add("schema", schema, schemaPattern.get(schema)!, list, rateWord(schema.toLowerCase(), "schema", list.length, schema));
    }
  }

  const byPrefix = new Map<string, Member[]>();
  const byPrefix2 = new Map<string, Member[]>();
  const prefixPattern = new Map<string, string>();
  // A two-token prefix's parent, the key of its first token.
  const parentKey = new Map<string, string>();
  const bySuffix = new Map<string, Member[]>();
  const dated: Member[] = [];
  for (const m of members) {
    const parts = tokens(m.table.name);
    const spelled = m.table.name.split("_");
    if (parts.length >= 2 && parts[0]) {
      const one = prefixGroup(spelled[0]!);
      push(byPrefix, one.key, m);
      prefixPattern.set(one.key, one.pattern);
      if (parts.length >= 3 && parts[1]) {
        const two = prefixGroup(`${spelled[0]}_${spelled[1]}`);
        push(byPrefix2, two.key, m);
        prefixPattern.set(two.key, two.pattern);
        parentKey.set(two.key, one.key);
      }
    }
    if (DATE_SUFFIX.test(m.table.name)) {
      dated.push(m);
      continue;
    }
    const last = parts[parts.length - 1];
    if (parts.length >= 2 && last && parts.slice(0, -1).some(Boolean)) push(bySuffix, last, m);
  }

  for (const [first, list] of byPrefix) {
    if (list.length < 2) continue;
    add("prefix", `${first}_`, prefixPattern.get(first)!, list, rateWord(first.toLowerCase(), "prefix", list.length, `${first}_`));
  }
  for (const [two, list] of byPrefix2) {
    const first = parentKey.get(two)!;
    const parent = byPrefix.get(first)?.length ?? 0;
    if (list.length < 2 || list.length >= parent) continue;
    add("prefix", `${two}_`, prefixPattern.get(two)!, list, rateWord(first.toLowerCase(), "prefix", list.length, `${two}_`));
  }

  for (const [last, list] of bySuffix) {
    if (list.length < 2) continue;
    add("suffix", `_${last}`, `*_${last}`, list, rateSuffix(last, list.length));
  }
  if (dated.length >= 2) {
    const rated: Rated = { suggestion: "exclude", reason: "Names end in a date: usually dated snapshots or partitions of another table." };
    add("suffix", DATE_KEY, DATE_PATTERN, dated, rated);
  }

  const noisy = members.filter((m) => noiseReason(m.table.name) !== null);
  if (noisy.length) {
    const rated: Rated = {
      suggestion: "exclude",
      reason:
        "Tables that look like noise: temporary, backup or dated copies, migration bookkeeping, pipeline-tool tables (etl, airflow, fivetran, airbyte, dbt) and names starting with an underscore.",
    };
    groups.push(build("noise", "noise", NOISE_PATTERN, noisy, rated, scope));
  }

  return groups.sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.tables.length - a.tables.length || compare(a.key, b.key),
  );
}

export interface SuggestedScope {
  include: string[];
  exclude: string[];
}

// One scope built from the groups: the patterns of the include-suggested groups
// (less one whose tables another included group already holds), and excludes for
// the excludable tables those includes select. A table is excludable when classifyTable
// (lib/rank.ts, the judgement sl baseline uses) calls it excludable: noise, or staging by a raw or
// staging name prefix, schema or comment phrase, not by an int_ prefix alone. A table is also excludable when its
// schema group is exclude-suggested (raw.*, tmp.*, staging.*). An exclude-suggested group's
// pattern is used when every table it adds to the excludes is excludable; the excludable tables
// no such group covers are named exactly, by literalPattern. With no include group, the scope selects every table, so
// the excludes cover every excludable table and every exclude-suggested schema.
export function suggestScope(tables: SnapshotTable[], groups: TableGroup[]): SuggestedScope {
  const includeGroups = groups.filter((g) => g.suggestion === "include" && g.kind !== "noise");
  const tableSets = new Map(includeGroups.map((g) => [g, new Set(g.tables)]));
  const kept = includeGroups.filter(
    (g) =>
      !includeGroups.some(
        (o) =>
          o !== g &&
          o.tables.length >= g.tables.length &&
          g.tables.every((t) => tableSets.get(o)!.has(t)) &&
          (o.tables.length > g.tables.length || includeGroups.indexOf(o) < includeGroups.indexOf(g)),
      ),
  );
  const include = kept.map((g) => g.pattern);
  const selected = tables.filter((t) => !include.length || include.some((p) => matchesPattern(p, t)));
  const byName = new Map(tables.map((t) => [qualifiedName(t), t]));
  const caughtNoise = new Set(selected.filter((t) => classifyTable(t)?.excludable === true).map(qualifiedName));
  const selectedNames = new Set(selected.map(qualifiedName));
  const excludable = new Set(caughtNoise);
  for (const g of groups) {
    if (g.kind !== "schema" || g.suggestion !== "exclude") continue;
    for (const t of g.tables) if (selectedNames.has(t)) excludable.add(t);
  }

  const exclude: string[] = [];
  const covered = new Set<string>();
  const candidates = groups
    .filter((g) => g.suggestion === "exclude" && g.kind !== "noise")
    .sort((a, b) => b.tables.length - a.tables.length || compare(a.pattern, b.pattern));
  for (const g of candidates) {
    const hit = g.tables.filter((t) => selectedNames.has(t));
    if (!hit.length || !hit.every((t) => excludable.has(t)) || hit.every((t) => covered.has(t))) continue;
    exclude.push(g.pattern);
    for (const t of hit) covered.add(t);
  }
  for (const t of [...caughtNoise].sort(compare)) if (!covered.has(t)) exclude.push(literalPattern(byName.get(t)!));
  return { include, exclude };
}

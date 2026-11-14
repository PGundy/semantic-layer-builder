import { type AccessLayer, andList, CHANGED_SINCE_APPROVAL, loadAccessLayer } from "./access.ts";
import { type CompileResult, compileLayer, compileRequest, type Refused } from "./compiler/index.ts";
import { UserError } from "./errors.ts";
import { PROTECTED_VALUE } from "./output.ts";
import { loadSnapshot, loadSource } from "./project.ts";
import { findField, parseRequestField } from "./refs.ts";
import { assertReadOnly, tokenize } from "./sql-guard.ts";
import type { Dialect, Golden, Metric, Model, QueryPlan, ResultRows, SourceConfig } from "./types.ts";
import { NAME_PATTERN } from "./types.ts";

export const MAX_DIFFS = 10;
// The relative tolerance a golden records when none is agreed (--tolerance) or kept in its file.
export const DEFAULT_TOLERANCE = 0.005;

export interface CompareOptions {
  ordered: boolean;
  tolerance: number;
  // Columns (lowercase) whose values the differences show as [protected].
  protectedColumns?: string[];
  // The request's grouping columns (see groupingColumns), matched ignoring case. Their values
  // compare exactly whatever the tolerance, and an unordered comparison pairs rows by them.
  groupingColumns?: string[];
}

export interface CompareResult {
  ok: boolean;
  diffs: string[];
}

type Row = Record<string, unknown>;

// A string that spells a number when compared with a number or bigint.
const NUMERIC_STRING = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;
// A string written the way databases print decimals: no padding, no leading zeros,
// no exponent. Two such strings compare by value ("150.50" and "150.5").
const CANONICAL_DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const INTEGER_STRING = /^-?(0|[1-9]\d*)$/;

// The number a value stands for: a finite number, a bigint, or a string that spells one.
function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && NUMERIC_STRING.test(v)) return Number(v);
  return null;
}

function isNull(v: unknown): boolean {
  return v === null || v === undefined;
}

// Whether a value reads as a figure: a number, a bigint or a canonical decimal string.
function isFigure(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "bigint") return true;
  return typeof v === "string" && CANONICAL_DECIMAL.test(v);
}

// The exact integer a value stands for, when it is one.
function asBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isInteger(v) ? BigInt(v) : null;
  if (typeof v === "string") {
    const t = v.trim();
    return INTEGER_STRING.test(t.replace(/^\+/, "")) ? BigInt(t.replace(/^\+/, "")) : null;
  }
  return null;
}

// A canonical decimal string with trailing fractional zeros removed ("150.50" -> "150.5").
function normalizeDecimal(s: string): string {
  const [int, frac = ""] = s.split(".");
  const f = frac.replace(/0+$/, "");
  const out = f ? `${int}.${f}` : (int ?? s);
  return out === "-0" ? "0" : out;
}

// A JSON rendering with object keys sorted, so key order does not matter.
function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (typeof val === "bigint") return val.toString();
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(Object.keys(val as Record<string, unknown>).sort().map((k) => [k, (val as Record<string, unknown>)[k]]));
    }
    return val;
  });
}

function show(v: unknown): string {
  if (isNull(v)) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object") return canonicalJson(v);
  return String(v);
}

// Whether both values are whole numbers: an integer number, a bigint or a string that spells an
// integer (two strings only when both are written canonically, as databases print them).
function bothWhole(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string" && !(INTEGER_STRING.test(a) && INTEGER_STRING.test(b))) return false;
  return asBigInt(a) !== null && asBigInt(b) !== null;
}

// Two whole numbers are equal only when they are the same integer, whatever the tolerance: a count
// of 1000 is never 1001, and a year is never the next one. The tolerance applies when at least one
// side is not a whole number.
function numbersEqual(a: unknown, b: unknown, tolerance: number): boolean {
  if (bothWhole(a, b)) return asBigInt(a) === asBigInt(b);
  if (tolerance <= 0 && typeof a === "string" && typeof b === "string") return normalizeDecimal(a) === normalizeDecimal(b);
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na === null || nb === null) return false;
  if (tolerance <= 0) return na === nb;
  return Math.abs(na - nb) <= tolerance * Math.max(Math.abs(na), Math.abs(nb));
}

// Whether two cell values agree: two whole numbers exactly, other numbers within the relative
// tolerance, a numeric string against a number by value, two canonical decimal strings by
// value, other strings exactly, null only with null, objects by their key-sorted JSON.
export function valuesEqual(a: unknown, b: unknown, tolerance: number): boolean {
  if (isNull(a) || isNull(b)) return isNull(a) && isNull(b);
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return true;
    return CANONICAL_DECIMAL.test(a) && CANONICAL_DECIMAL.test(b) && numbersEqual(a, b, tolerance);
  }
  const numA = typeof a === "number" || typeof a === "bigint";
  const numB = typeof b === "number" || typeof b === "bigint";
  if ((numA && (numB || typeof b === "string")) || (numB && typeof a === "string")) return numbersEqual(a, b, tolerance);
  if (typeof a === "object" || typeof b === "object") return canonicalJson(a) === canonicalJson(b);
  return a === b;
}

function columnsOf(rows: Row[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

// Rank of a value's kind in the canonical sort: null, figure, boolean, string, other.
function kindRank(v: unknown): number {
  if (isNull(v)) return 0;
  if (isFigure(v)) return 1;
  if (typeof v === "boolean") return 2;
  if (typeof v === "string") return 3;
  return 4;
}

function compareValues(a: unknown, b: unknown): number {
  const ka = kindRank(a);
  const kb = kindRank(b);
  if (ka !== kb) return ka - kb;
  if (ka === 0) return 0;
  if (ka === 1) return asNumber(a)! - asNumber(b)!;
  if (ka === 2) return Number(a) - Number(b);
  const sa = typeof a === "string" ? a : canonicalJson(a);
  const sb = typeof b === "string" ? b : canonicalJson(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// Columns in canonical key order: those holding any value that is not a figure (the
// row's labels) first, then the figures, each group by name.
function keyOrder(columns: string[], rows: Row[]): { labels: string[]; order: string[] } {
  const labels: string[] = [];
  const figures: string[] = [];
  for (const c of [...columns].sort()) {
    const values = rows.map((r) => r[c]).filter((v) => !isNull(v));
    if (values.length && values.every(isFigure)) figures.push(c);
    else labels.push(c);
  }
  return { labels, order: [...labels, ...figures] };
}

// Indexes of the rows in canonical order; the rows themselves keep their positions.
function sortedIndexes(rows: Row[], order: string[]): number[] {
  return rows
    .map((_, i) => i)
    .sort((x, y) => {
      for (const c of order) {
        const d = compareValues(rows[x]![c], rows[y]![c]);
        if (d !== 0) return d;
      }
      return x - y;
    });
}

// How a difference shows a cell: a protected column's non-null value as [protected].
type Shower = (column: string, v: unknown) => string;

function shower(hidden: Set<string>): Shower {
  return (column, v) => (hidden.has(column.toLowerCase()) && !isNull(v) ? PROTECTED_VALUE : show(v));
}

function describeRow(row: Row, see: Shower): string {
  return `{${Object.keys(row)
    .map((c) => `${c}: ${see(c, row[c])}`)
    .join(", ")}}`;
}

const GROUPING_EXACT = "grouping columns compare exactly";
const WHOLE_EXACT = "whole numbers compare exactly";

// How the cells of one comparison compare and show.
interface Cells {
  // The columns both sides have, and those of them that are grouping columns.
  columns: string[];
  grouping: string[];
  tolerance: number;
  // The protected columns, in lowercase, and how a difference shows a cell.
  hidden: Set<string>;
  see: Shower;
}

function cellEquals(k: Cells, column: string, a: unknown, b: unknown): boolean {
  return valuesEqual(a, b, k.grouping.includes(column) ? 0 : k.tolerance);
}

function rowEquals(k: Cells, a: Row, b: Row): boolean {
  return k.columns.every((c) => cellEquals(k, c, a[c], b[c]));
}

// Why a difference stands though the golden has a tolerance, in parentheses: the reason given, or
// the rule that compared this cell exactly. Empty at tolerance 0, where every cell compares exactly.
function exactNote(k: Cells, reason: string | undefined): string {
  return k.tolerance > 0 && reason ? ` (${reason})` : "";
}

function cellDiffs(label: string, expected: Row, actual: Row, k: Cells): string[] {
  const out: string[] = [];
  for (const c of k.columns) {
    const e = expected[c];
    const a = actual[c];
    if (cellEquals(k, c, e, a)) continue;
    // A protected column's difference does not say its values are whole numbers.
    const why = k.grouping.includes(c) ? GROUPING_EXACT : bothWhole(e, a) && !k.hidden.has(c.toLowerCase()) ? WHOLE_EXACT : undefined;
    out.push(`${label}, column ${c}: expected ${k.see(c, e)}, got ${k.see(c, a)}${exactNote(k, why)}.`);
  }
  return out;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function compareOrdered(expected: Row[], actual: Row[], k: Cells): string[] {
  const { see } = k;
  const diffs: string[] = [];
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const a = actual[i];
    if (e && a) diffs.push(...cellDiffs(`Row ${i + 1}`, e, a, k));
    else if (e) diffs.push(`Row ${i + 1}: expected ${describeRow(e, see)}, but the results end before it.`);
    else if (a) diffs.push(`Row ${i + 1}: got ${describeRow(a, see)}, which is not expected.`);
  }
  return diffs;
}

// Walks expected rows in canonical order, pairs each with a result row that agrees in
// full, then pairs the rest so a changed figure reads as one cell diff against its own row:
// by the grouping columns when the request has any, else by the label columns when there
// are any, otherwise with the result row that shares the most cells (at least half of
// them). Row numbers are positions in expected.rows and in the results.
function compareUnordered(expected: Row[], actual: Row[], k: Cells): string[] {
  const { columns, grouping, see } = k;
  const { labels, order } = keyOrder(columns, [...expected, ...actual]);
  const expOrder = sortedIndexes(expected, order);
  const actOrder = sortedIndexes(actual, order);
  const used = new Set<number>();
  const freeActual = (pred: (a: Row) => boolean): number => {
    const j = actOrder.find((n) => !used.has(n) && pred(actual[n]!));
    return j ?? -1;
  };

  const leftover: number[] = [];
  for (const i of expOrder) {
    const j = freeActual((a) => rowEquals(k, expected[i]!, a));
    if (j >= 0) used.add(j);
    else leftover.push(i);
  }

  const diffs: string[] = [];
  const unmatched: number[] = [];
  for (const i of leftover) {
    const e = expected[i]!;
    let j = -1;
    let key: string[] = grouping.length ? grouping : labels;
    if (key.length) {
      j = freeActual((a) => key.every((c) => valuesEqual(e[c], a[c], 0)));
    } else if (columns.length > 1) {
      let best = 0;
      for (const n of actOrder) {
        if (used.has(n)) continue;
        const shared = columns.filter((c) => cellEquals(k, c, e[c], actual[n]![c]));
        if (shared.length > best && shared.length * 2 >= columns.length) {
          best = shared.length;
          j = n;
          key = shared;
        }
      }
    }
    if (j >= 0) {
      used.add(j);
      const label = key.map((c) => `${c}=${see(c, e[c])}`).join(", ");
      diffs.push(...cellDiffs(`Row ${i + 1} (${label})`, e, actual[j]!, k));
    } else unmatched.push(i);
  }
  // With grouping columns, a row is unmatched when no result row has its grouping values.
  const why = exactNote(k, grouping.length ? GROUPING_EXACT : undefined);
  for (const i of unmatched) diffs.push(`Row ${i + 1}: expected ${describeRow(expected[i]!, see)}, but no result row matches it${why}.`);
  for (const n of actOrder) {
    if (!used.has(n)) diffs.push(`Result row ${n + 1}: got ${describeRow(actual[n]!, see)}, which is not expected.`);
  }
  return diffs;
}

// Compares a golden's expected rows with the rows a query returned. The values of
// opts.groupingColumns and any two whole numbers compare exactly; opts.tolerance applies to the
// other figures. A difference in a cell that compared exactly though the tolerance is above zero
// says which rule made it exact. The differences show the values of opts.protectedColumns as
// [protected], and say nothing of whether they are whole numbers.
export function compareRows(expected: Row[], actual: Row[], opts: CompareOptions): CompareResult {
  const tolerance = Math.max(0, opts.tolerance);
  const hidden = new Set((opts.protectedColumns ?? []).map((c) => c.toLowerCase()));
  const see = shower(hidden);
  const expectedColumns = columnsOf(expected);
  const actualColumns = columnsOf(actual);
  const diffs: string[] = [];
  const missing = expectedColumns.filter((c) => !actualColumns.includes(c));
  const extra = actualColumns.filter((c) => !expectedColumns.includes(c));
  if (missing.length) diffs.push(`Expected column${missing.length === 1 ? "" : "s"} ${missing.join(", ")} missing from the results.`);
  if (extra.length) diffs.push(`Result column${extra.length === 1 ? "" : "s"} ${extra.join(", ")} not in the expected rows.`);
  if (expected.length !== actual.length) {
    diffs.push(`Expected ${plural(expected.length, "row")}, got ${plural(actual.length, "row")}.`);
  }
  const common = expectedColumns.filter((c) => actualColumns.includes(c));
  const wanted = new Set((opts.groupingColumns ?? []).map((c) => c.toLowerCase()));
  const cells: Cells = { columns: common, grouping: common.filter((c) => wanted.has(c.toLowerCase())), tolerance, hidden, see };
  diffs.push(...(opts.ordered ? compareOrdered(expected, actual, cells) : compareUnordered(expected, actual, cells)));
  if (diffs.length <= MAX_DIFFS) return { ok: diffs.length === 0, diffs };
  const shown = diffs.slice(0, MAX_DIFFS - 1);
  shown.push(`${diffs.length - shown.length} more differences not shown.`);
  return { ok: false, diffs: shown };
}

export function goldenQueryId(name: string): string {
  return `golden:${name}`;
}

// The query id of a golden's cross_check_sql, next to its compiled query golden:<name>.
export function crossCheckQueryId(name: string): string {
  return `golden:${name}:cross_check`;
}

// The hand-written query a golden's compiled request is checked against: cross_check_sql, else
// the older key sql, read as it. Undefined when the golden has neither.
export function crossCheckSql(golden: Golden): string | undefined {
  const raw = typeof golden.cross_check_sql === "string" ? golden.cross_check_sql : typeof golden.sql === "string" ? golden.sql : undefined;
  return raw?.trim() ? raw.trim() : undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// The layer with every model, field, join, metric and access.yaml read as approved, and no
// approval hash compared: what a draft golden's request compiles against before its fields are.
function approvedLayer(layer: AccessLayer): AccessLayer {
  const approve = <T>(xs: T[] | undefined): T[] | undefined => (Array.isArray(xs) ? xs.map((x) => (isObj(x) ? { ...x, status: "approved" } : x)) : xs);
  return {
    ...layer,
    compare_hashes: false,
    models: layer.models.map((m) => ({ ...m, status: "approved", dimensions: approve(m.dimensions)!, measures: approve(m.measures)!, joins: approve(m.joins) })),
    metrics: approve(layer.metrics) ?? [],
    access: isObj(layer.access) ? { ...layer.access, status: "approved" } : layer.access,
  };
}

// Compiles a golden's request from the current YAML as the role and user it runs as, the way
// sl sql does. An approved golden compiles strictly: a draft field, or an approved one changed
// since its approval, is refused. Any other golden previews its request with every item read as
// approved, so its rows can be read back to the owner before its fields are approved.
// A layer too malformed for the compiler to read is a refusal that names sl validate.
export function compileGolden(root: string, golden: Golden): CompileResult {
  const role = typeof golden.role === "string" ? golden.role : undefined;
  const attributes = isObj(golden.user) ? golden.user : {};
  const source = loadSource(root, golden.request.source);
  try {
    if (golden.status === "approved") return compileRequest(root, golden.request, { ...(role ? { role } : {}), user: attributes });
    return compileLayer({
      layer: approvedLayer(loadAccessLayer(root)),
      source,
      snapshot: loadSnapshot(root, source.source),
      request: golden.request,
      user: { attributes, roles: role ? [role] : [] },
      root,
    });
  } catch (e) {
    if (e instanceof UserError || !(e instanceof TypeError)) throw e;
    const message = `the compiler could not read the layer (${e.message.split("\n")[0]}); run sl validate`;
    return { ok: false, source: source.source, reason: message, refusals: [{ code: "invalid_layer", message }] };
  }
}

// The grouping columns of a golden: the result columns of its compiled request's dimensions and
// time grains (order_date:year is the column order_date_year). A golden whose request does not
// compile, checked by its cross_check_sql alone, has none the comparison can name.
export function groupingColumns(compiled: CompileResult | undefined): string[] {
  return compiled?.ok ? compiled.columns.filter((c) => c.kind === "dimension").map((c) => c.name) : [];
}

// Whether a refusal is only that the compiler does not support the source's dialect.
export function onlyUnsupportedDialect(r: CompileResult): boolean {
  return !r.ok && r.refusals.every((x) => x.code === "unsupported_dialect");
}

// The approve targets a refusal waits on: those the first hidden reference awaits (an item changed
// since its approval or a draft, its model, or a measure that hides a metric), a draft access.yaml,
// or, when an access rule hides the reference too, the draft or changed item its message names.
function awaitedTargets(r: Refused): string[] {
  for (const x of r.refusals) {
    if (x.code !== "not_visible") continue;
    if (x.awaits?.length) return x.awaits;
    if (x.ref === "access.yaml") return ["access"];
    const changed = x.message.includes(CHANGED_SINCE_APPROVAL) ? /sl approve --target (\S+)/.exec(x.message)?.[1] : undefined;
    if (changed) return [changed];
    const hidden = /measure_hidden:([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)/.exec(x.message)?.[1];
    if (hidden) return [`${r.source}.${hidden}`];
    if (/\((draft|draft, [^)]*)\)/.test(x.message) && x.ref) return [x.ref.includes(".") ? `${r.source}.${x.ref.split(":")[0]}` : `metric:${x.ref}`];
  }
  return [];
}

// The step that resolves a golden's refusal: the refusal's own, approving the item it waits on
// (a draft access.yaml included) after the owner's yes, sl validate for a layer error, else sl sql
// for the details. The recheck is goldens check for a golden with expected rows, else goldens run.
export function refusalNext(golden: Golden, r: Refused): string {
  const own = r.refusals.find((x) => x.next)?.next;
  if (own) return own;
  const targets = awaitedTargets(r);
  const confirmed = (golden.expected?.rows?.length ?? 0) > 0;
  const recheck = confirmed ? `sl goldens check --name ${golden.name}` : `sl goldens run --name ${golden.name}`;
  if (targets.length) {
    const after = confirmed ? `; if its rows changed, confirm again only on the owner's yes` : "";
    const it = targets.length > 1 ? "them" : "it";
    return `Read ${andList(targets)} back to the owner with sl readback --targets ${targets.join(",")} and approve ${it} on their yes, then run ${recheck}${after}.`;
  }
  if (r.refusals.some((x) => x.code === "invalid_layer")) return `Run sl validate and fix what it reports, then run ${recheck}.`;
  if (onlyUnsupportedDialect(r)) {
    return (
      `sl sql compiles postgres and duckdb sources only: write the golden's query by hand from the model YAML as cross_check_sql, ` +
      `then run sl goldens run --name ${golden.name} --emit-sql to plan it.`
    );
  }
  return `Run sl sql --request goldens/${golden.name}.yaml to see why, fix the request or the layer, then run ${recheck}.`;
}

// A request value or user attribute as a SQL literal: text quoted, with '' for a quote (and on
// postgres as E'...' with backslashes doubled when it holds one), finite numbers as written (in
// parentheses when negative; on postgres quoted, so that like an unbound parameter the literal
// takes the type of the column it is compared with), booleans as true and false. Anything else
// is refused.
function sqlLiteral(v: unknown, dialect: Dialect, n: number): string {
  if (typeof v === "string") {
    const quoted = v.replaceAll("'", "''");
    return dialect === "postgres" && v.includes("\\") ? `E'${quoted.replaceAll("\\", "\\\\")}'` : `'${quoted}'`;
  }
  if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "bigint") {
    if (dialect === "postgres") return `'${v}'`;
    return v < 0 ? `(${v})` : String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  throw new UserError(`Parameter $${n} of the compiled query is ${JSON.stringify(v) ?? String(v)}; a golden's filter values and user attributes are text, numbers or true and false.`);
}

// The compiled SQL with each bound parameter ($1, $2, ...) written as a literal, read with the
// tokenizer the read-only check uses, so a marker inside a string or a comment is left alone. The
// query then runs through the read-only adapters, and a plan's SQL runs in any tool as it stands.
export function inlineParams(sql: string, params: readonly unknown[], dialect: Dialect): string {
  let out = "";
  let at = 0;
  for (const t of tokenize(sql)) {
    if (t.kind !== "param") continue;
    const n = Number(t.text.slice(1));
    if (!(n >= 1 && n <= params.length)) throw new UserError(`The compiled query reads parameter ${t.text}, which it does not bind; run sl validate.`);
    out += sql.slice(at, t.pos) + sqlLiteral(params[n - 1], dialect, n);
    at = t.end;
  }
  return out + sql.slice(at);
}

// The plan that runs a golden against its request's source: its request compiled from the YAML
// (query golden:<name>) when it compiles, and its cross_check_sql (golden:<name>:cross_check) when
// it has one. A golden with neither is refused with the compiler's reason.
export function goldenPlan(golden: Golden, source: SourceConfig, compiled?: CompileResult): QueryPlan {
  const purpose = golden.question || `Golden ${golden.name}`;
  const queries: QueryPlan["queries"] = [];
  if (compiled?.ok) queries.push({ id: goldenQueryId(golden.name), purpose, sql: inlineParams(compiled.sql, compiled.params, source.dialect) });
  const cross = crossCheckSql(golden);
  if (cross !== undefined) {
    try {
      assertReadOnly(cross);
    } catch (e) {
      throw new UserError(`Golden "${golden.name}": ${(e as Error).message}`);
    }
    queries.push({ id: crossCheckQueryId(golden.name), purpose: `${purpose} (cross_check_sql)`, sql: cross });
  }
  if (queries.length) return { command: "goldens", source: source.source, dialect: source.dialect, queries };
  if (compiled && !compiled.ok) throw new UserError(`Golden "${golden.name}" does not compile from the current YAML: ${compiled.reason}. ${refusalNext(golden, compiled)}`);
  throw new UserError(`Golden "${golden.name}" has no cross_check_sql, and its request was not compiled.`);
}

export interface GoldenJudgement extends CompareResult {
  // How the compiled rows and the cross_check_sql rows compare with the expected rows, each when it ran.
  compiled?: "pass" | "fail";
  cross_check?: "pass" | "fail";
}

// Compares a golden's expected rows with its compiled rows and its cross_check_sql rows, each when
// it ran. With both, every difference names the query it is in, and the first says which differs.
export function judgeGolden(expected: Row[], compiled: Row[] | undefined, cross: Row[] | undefined, opts: CompareOptions): GoldenJudgement {
  const c = compiled && compareRows(expected, compiled, opts);
  const x = cross && compareRows(expected, cross, opts);
  const verdict = (key: "compiled" | "cross_check", r: CompareResult | undefined) => (r ? { [key]: r.ok ? "pass" : "fail" } : {});
  if (!c || !x) {
    const only = c ?? x;
    return { ok: only?.ok ?? false, diffs: only?.diffs ?? [], ...verdict("compiled", c), ...verdict("cross_check", x) };
  }
  const diffs: string[] = [];
  if (!c.ok && x.ok) diffs.push("The rows compiled from the YAML differ from expected.rows, and cross_check_sql still gives them: the layer no longer computes the confirmed figure.");
  if (c.ok && !x.ok) diffs.push("cross_check_sql differs from expected.rows, and the rows compiled from the YAML match them: fix cross_check_sql or remove it.");
  if (!c.ok && !x.ok) diffs.push("Both the rows compiled from the YAML and cross_check_sql differ from expected.rows.");
  diffs.push(...c.diffs.map((d) => `Compiled: ${d}`), ...x.diffs.map((d) => `cross_check_sql: ${d}`));
  return { ok: c.ok && x.ok, diffs, ...verdict("compiled", c), ...verdict("cross_check", x) };
}

// The measure references a metric combines, in the exact model.measure form sl approve
// accepts: a ratio's numerator and denominator, or an expr's {model.measure} placeholders
// with no spaces. Anything else is left to sl validate and sl approve.
const MEASURE_REF = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
function metricMeasures(metric: Metric): string[] {
  if (metric.type === "ratio") {
    return [metric.numerator, metric.denominator].filter((r): r is string => typeof r === "string" && MEASURE_REF.test(r));
  }
  if (typeof metric.expr !== "string") return [];
  return [...metric.expr.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!).filter((r) => MEASURE_REF.test(r));
}

// Whether a model has the field lists findField reads; a malformed model is skipped.
function readableModel(m: unknown): m is Model {
  if (!m || typeof m !== "object") return false;
  const { dimensions, measures, joins } = m as Partial<Record<"dimensions" | "measures" | "joins", unknown>>;
  return [dimensions, measures, joins].every(
    (v) => v === undefined || v === null || (Array.isArray(v) && v.every((x) => !!x && typeof x === "object")),
  );
}

// The draft dimensions, measures and metrics a golden's request uses, as approve
// targets (source.model.field, metric:<name>), in the order the request names them.
// A metric used by the request also contributes the draft measures it combines.
// References that resolve to nothing, and models or metrics too malformed to read, are
// left to sl validate.
export function goldenDraftFields(golden: Golden, models: Model[], metrics: Metric[]): string[] {
  const request = golden.request;
  if (!request || typeof request !== "object") return [];
  const usableModels = (Array.isArray(models) ? models : []).filter(readableModel);
  const usableMetrics = (Array.isArray(metrics) ? metrics : []).filter((m): m is Metric => !!m && typeof m === "object");
  const source = request.source;
  const out = new Set<string>();
  const field = (ref: string): void => {
    const parsed = parseRequestField(ref);
    if (!parsed) return;
    const model = usableModels.find((m) => m.model === parsed.model && m.source === source);
    if (!model) return;
    const match = findField(model, parsed.field);
    if (!match || match.kind === "join") return;
    if (match.item.status !== "approved") out.add(`${source}.${model.model}.${parsed.field}`);
  };
  const ref = (r: unknown): void => {
    if (typeof r !== "string") return;
    if (r.includes(".")) return field(r);
    if (!NAME_PATTERN.test(r)) return;
    const metric = usableMetrics.find((m) => m.name === r && (m.source ?? source) === source);
    if (!metric) return;
    if (metric.status !== "approved") out.add(`metric:${metric.name}`);
    for (const measure of metricMeasures(metric)) field(measure);
  };
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  for (const m of list(request.measures)) ref(m);
  for (const d of list(request.dimensions)) ref(d);
  for (const f of list(request.filters)) ref((f as { field?: unknown } | null)?.field);
  for (const o of list(request.order_by)) ref((o as { field?: unknown } | null)?.field);
  return [...out];
}

// The column names of a result, in the order the first row that holds each one gives.
export function resultColumns(rows: ResultRows): string[] {
  return columnsOf(rows);
}

// The result columns that show a currency figure: a column named (ignoring case) like a measure
// or metric of the request whose format is currency. A request measure model.measure names the
// column measure, and a metric its own name; a column the golden's sql aliases otherwise (such as
// total_revenue for revenue) is not matched. Malformed models and metrics are skipped.
export function currencyColumns(golden: Golden, models: Model[], metrics: Metric[], columns: string[]): string[] {
  const request = golden.request;
  if (!request || typeof request !== "object" || !Array.isArray(request.measures)) return [];
  const usableModels = (Array.isArray(models) ? models : []).filter(readableModel);
  const usableMetrics = (Array.isArray(metrics) ? metrics : []).filter((m): m is Metric => !!m && typeof m === "object");
  const names = new Set<string>();
  for (const r of request.measures) {
    if (typeof r !== "string") continue;
    if (r.includes(".")) {
      const parsed = parseRequestField(r);
      const model = parsed && usableModels.find((m) => m.model === parsed.model && m.source === request.source);
      const match = model ? findField(model, parsed.field) : undefined;
      if (match?.kind === "measure" && (match.item as { format?: unknown }).format === "currency") names.add(parsed!.field.toLowerCase());
      continue;
    }
    const metric = usableMetrics.find((m) => m.name === r && (m.source ?? request.source) === request.source);
    if (metric?.format === "currency") names.add(r.toLowerCase());
  }
  return columns.filter((c) => names.has(c.toLowerCase()));
}

// A figure shown to two decimals, for display only: a number, a bigint or a string that spells a
// number. The rounding works on the decimal digits, half away from zero, so a number shows its
// shortest decimal form rounded (2.675 shows 2.68) and a string never loses digits to a float. A
// figure that rounds to zero shows 0.00. Anything else is returned as it is.
export function twoDecimals(v: unknown): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? roundDecimalString(plainDecimal(String(v))) : v;
  if (typeof v === "bigint") return `${v}.00`;
  if (typeof v === "string" && NUMERIC_STRING.test(v)) return roundDecimalString(plainDecimal(v));
  return v;
}

// A numeric string (NUMERIC_STRING) as a plain decimal: optional "-", integer digits without
// leading zeros, then "." and fraction digits when it has any. An exponent is applied by moving
// the decimal point.
function plainDecimal(text: string): string {
  let t = text.trim();
  let neg = false;
  if (t.startsWith("-") || t.startsWith("+")) {
    neg = t.startsWith("-");
    t = t.slice(1);
  }
  const [mantissa, exp = "0"] = t.split(/[eE]/);
  const [int = "", frac = ""] = mantissa!.split(".");
  const digits = int + frac;
  const point = int.length + Number(exp);
  let whole: string;
  let fraction: string;
  if (point <= 0) {
    whole = "0";
    fraction = "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    whole = digits + "0".repeat(point - digits.length);
    fraction = "";
  } else {
    whole = digits.slice(0, point);
    fraction = digits.slice(point);
  }
  whole = whole.replace(/^0+(?=\d)/, "") || "0";
  return `${neg ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

// A plain decimal rounded to two places, half away from zero, by carrying through its digits.
function roundDecimalString(plain: string): string {
  const neg = plain.startsWith("-");
  const [int, frac = ""] = (neg ? plain.slice(1) : plain).split(".");
  let digits = int! + frac.padEnd(2, "0").slice(0, 2);
  if (frac.length > 2 && frac[2]! >= "5") {
    const out = digits.split("");
    let i = out.length - 1;
    while (i >= 0 && out[i] === "9") out[i--] = "0";
    if (i >= 0) out[i] = String(Number(out[i]) + 1);
    else out.unshift("1");
    digits = out.join("");
  }
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, "") || "0";
  const shown = `${whole}.${digits.slice(-2)}`;
  return neg && /[1-9]/.test(shown) ? `-${shown}` : shown;
}

// Rows for display with the given columns' figures shown to two decimals; the rows themselves are
// not changed.
export function displayRows(rows: ResultRows, currency: string[]): ResultRows {
  if (!currency.length) return rows;
  return rows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const c of currency) if (c in out) out[c] = twoDecimals(out[c]);
    return out;
  });
}

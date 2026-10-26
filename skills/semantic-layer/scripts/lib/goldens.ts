import { UserError } from "./errors.ts";
import { assertReadOnly } from "./sql-guard.ts";
import type { Golden, QueryPlan, ResultRows, SourceConfig } from "./types.ts";

export const MAX_DIFFS = 10;

export interface CompareOptions {
  ordered: boolean;
  tolerance: number;
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

function numbersEqual(a: unknown, b: unknown, tolerance: number): boolean {
  if (tolerance <= 0) {
    if (typeof a === "string" && typeof b === "string") return normalizeDecimal(a) === normalizeDecimal(b);
    const ia = asBigInt(a);
    const ib = asBigInt(b);
    if (ia !== null && ib !== null) return ia === ib;
  }
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na === null || nb === null) return false;
  if (tolerance <= 0) return na === nb;
  return Math.abs(na - nb) <= tolerance * Math.max(Math.abs(na), Math.abs(nb));
}

// Whether two cell values agree: numbers within the relative tolerance, a numeric
// string against a number by value, two canonical decimal strings by value, other
// strings exactly, null only with null, objects by their key-sorted JSON.
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

function rowEquals(a: Row, b: Row, columns: string[], tolerance: number): boolean {
  return columns.every((c) => valuesEqual(a[c], b[c], tolerance));
}

function describeRow(row: Row): string {
  return `{${Object.keys(row)
    .map((c) => `${c}: ${show(row[c])}`)
    .join(", ")}}`;
}

function cellDiffs(label: string, expected: Row, actual: Row, columns: string[], tolerance: number): string[] {
  const out: string[] = [];
  for (const c of columns) {
    if (!valuesEqual(expected[c], actual[c], tolerance)) {
      out.push(`${label}, column ${c}: expected ${show(expected[c])}, got ${show(actual[c])}.`);
    }
  }
  return out;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function compareOrdered(expected: Row[], actual: Row[], columns: string[], tolerance: number): string[] {
  const diffs: string[] = [];
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const a = actual[i];
    if (e && a) diffs.push(...cellDiffs(`Row ${i + 1}`, e, a, columns, tolerance));
    else if (e) diffs.push(`Row ${i + 1}: expected ${describeRow(e)}, but the results end before it.`);
    else if (a) diffs.push(`Row ${i + 1}: got ${describeRow(a)}, which is not expected.`);
  }
  return diffs;
}

// Walks expected rows in canonical order, pairs each with a result row that agrees in
// full, then pairs the rest so a changed figure reads as one cell diff: by the label
// columns when there are any, otherwise with the result row that shares the most cells
// (at least half of them). Row numbers are positions in expected.rows and in the results.
function compareUnordered(expected: Row[], actual: Row[], columns: string[], tolerance: number): string[] {
  const { labels, order } = keyOrder(columns, [...expected, ...actual]);
  const expOrder = sortedIndexes(expected, order);
  const actOrder = sortedIndexes(actual, order);
  const used = new Set<number>();
  const freeActual = (pred: (a: Row) => boolean): number => {
    const j = actOrder.find((k) => !used.has(k) && pred(actual[k]!));
    return j ?? -1;
  };

  const leftover: number[] = [];
  for (const i of expOrder) {
    const j = freeActual((a) => rowEquals(expected[i]!, a, columns, tolerance));
    if (j >= 0) used.add(j);
    else leftover.push(i);
  }

  const diffs: string[] = [];
  const unmatched: number[] = [];
  for (const i of leftover) {
    const e = expected[i]!;
    let j = -1;
    let key: string[] = labels;
    if (labels.length) {
      j = freeActual((a) => labels.every((c) => valuesEqual(e[c], a[c], 0)));
    } else if (columns.length > 1) {
      let best = 0;
      for (const k of actOrder) {
        if (used.has(k)) continue;
        const shared = columns.filter((c) => valuesEqual(e[c], actual[k]![c], tolerance));
        if (shared.length > best && shared.length * 2 >= columns.length) {
          best = shared.length;
          j = k;
          key = shared;
        }
      }
    }
    if (j >= 0) {
      used.add(j);
      const label = key.map((c) => `${c}=${show(e[c])}`).join(", ");
      diffs.push(...cellDiffs(`Row ${i + 1} (${label})`, e, actual[j]!, columns, tolerance));
    } else unmatched.push(i);
  }
  for (const i of unmatched) diffs.push(`Row ${i + 1}: expected ${describeRow(expected[i]!)}, but no result row matches it.`);
  for (const k of actOrder) {
    if (!used.has(k)) diffs.push(`Result row ${k + 1}: got ${describeRow(actual[k]!)}, which is not expected.`);
  }
  return diffs;
}

// Compares a golden's expected rows with the rows a query returned.
export function compareRows(expected: Row[], actual: Row[], opts: CompareOptions): CompareResult {
  const tolerance = Math.max(0, opts.tolerance);
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
  diffs.push(
    ...(opts.ordered
      ? compareOrdered(expected, actual, common, tolerance)
      : compareUnordered(expected, actual, common, tolerance)),
  );
  if (diffs.length <= MAX_DIFFS) return { ok: diffs.length === 0, diffs };
  const shown = diffs.slice(0, MAX_DIFFS - 1);
  shown.push(`${diffs.length - shown.length} more differences not shown.`);
  return { ok: false, diffs: shown };
}

export function goldenQueryId(name: string): string {
  return `golden:${name}`;
}

// The one-query plan that runs a golden's SQL against its request's source.
export function goldenPlan(golden: Golden, source: SourceConfig): QueryPlan {
  if (typeof golden.sql !== "string" || !golden.sql.trim()) throw new UserError(`Golden "${golden.name}" has no sql.`);
  try {
    assertReadOnly(golden.sql);
  } catch (e) {
    throw new UserError(`Golden "${golden.name}": ${(e as Error).message}`);
  }
  return {
    command: "goldens",
    source: source.source,
    dialect: source.dialect,
    queries: [{ id: goldenQueryId(golden.name), purpose: golden.question || `Golden ${golden.name}`, sql: golden.sql.trim() }],
  };
}

// The column names of a result, in the order the first row that holds each one gives.
export function resultColumns(rows: ResultRows): string[] {
  return columnsOf(rows);
}

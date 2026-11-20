// What the stored data already shows about whether a model's primary_key is unique, with no query: the
// profile's distinct count for a one-column key, and the duplicate-pair count a bridge join's evidence
// holds for the bridge model's two key columns. The validate rule model.primary_key_not_unique and the
// model's readback use these words.
import { approximateDistinct } from "./sql/profile.ts";
import { throughCurrent } from "./readback-bridge.ts";
import type { Dialect, Join, Model, SnapshotTable } from "./types.ts";

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const lower = (xs: string[]) => xs.map((x) => x.toLowerCase()).sort().join("\u0000");

// A one-column key whose profile of the whole table, counted exactly, has fewer distinct values than
// non-null rows. A sampled profile, one with no sampled flag, an estimating dialect and a table with no
// row count say nothing.
export function repeatedKey(model: Model, table: SnapshotTable | undefined, dialect?: Dialect): { distinct: number; rows: number } | undefined {
  const pk = strs(model.primary_key);
  if (pk.length !== 1 || !table || !dialect || approximateDistinct(dialect)) return undefined;
  const p = (Array.isArray(table.columns) ? table.columns : []).find((c) => typeof c?.name === "string" && c.name.toLowerCase() === pk[0]!.toLowerCase())?.profile;
  if (!p || p.sampled !== false || p.redacted) return undefined;
  const { distinct_count: distinct, null_fraction: nulls } = p;
  if (typeof distinct !== "number" || typeof nulls !== "number" || typeof table.row_count !== "number") return undefined;
  const rows = Math.round(table.row_count * (1 - nulls));
  return distinct < rows ? { distinct, rows } : undefined;
}

// A bridge model whose primary_key is exactly the two columns of a bridge join through it (the column that
// matches the model's rows and the one that matches the target), while that join's current evidence counts
// bridge rows repeating a pair.
export function repeatedPairs(bridge: Model, models: Iterable<Model>): { rows: number; repeated: number; columns: string[] } | undefined {
  const pk = strs(bridge.primary_key);
  if (pk.length !== 2) return undefined;
  for (const m of models) {
    for (const j of (Array.isArray(m?.joins) ? m.joins : []) as Join[]) {
      if (!j || typeof j !== "object") continue;
      const ev = j.evidence?.through;
      if (!j.through || typeof j.through !== "object" || j.through.model !== bridge.model || !ev || typeof ev !== "object" || !throughCurrent(j, ev) || !(ev.duplicate_rows > 0) || typeof ev.bridge_rows !== "number") continue;
      const columns = [...(Array.isArray(j.keys) ? j.keys : []).map((k) => k?.to), ...(Array.isArray(j.through.keys) ? j.through.keys : []).map((k) => k?.from)];
      if (columns.length === 2 && columns.every((c) => typeof c === "string") && lower(columns) === lower(pk)) return { rows: ev.bridge_rows, repeated: ev.duplicate_rows, columns: pk };
    }
  }
  return undefined;
}

// The fact for a model, in the words of the warning and of the readback (without the next step), or
// undefined when the stored data shows none.
export function keyRepeats(model: Model, table: SnapshotTable | undefined, dialect: Dialect | undefined, models: Iterable<Model>): string | undefined {
  const one = repeatedKey(model, table, dialect);
  if (one) return `the profile of ${model.table} counts ${num(one.distinct)} distinct values in ${num(one.rows)} rows, so rows cannot be told apart by this key`;
  const pairs = repeatedPairs(model, models);
  if (pairs) {
    const [a, b] = pairs.columns as [string, string];
    return `check-join measured that ${num(pairs.repeated)} of ${num(pairs.rows)} rows of ${model.model} ${pairs.repeated === 1 ? "repeats" : "repeat"} a (${a}, ${b}) pair, so rows cannot be told apart by this key`;
  }
  return undefined;
}

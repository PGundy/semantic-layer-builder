import { describe, expect, test } from "bun:test";
import {
  changeLines,
  describeDiff,
  diffSnapshots,
  incomingKeyColumns,
  isEmptyDiff,
  missingColumns,
  modeledTables,
  referencedColumns,
  sqlIdentifiers,
  unreferencedColumns,
} from "../skills/semantic-layer/scripts/lib/snapshot-diff.ts";
import type { Model, Snapshot, SnapshotTable } from "../skills/semantic-layer/scripts/lib/types.ts";

function snap(tables: SnapshotTable[]): Snapshot {
  return { snapshot_version: 1, source: "wh", dialect: "duckdb", captured_at: "2026-01-15T12:00:00.000Z", method: "manual", tables };
}
function tbl(schema: string | null, name: string, columns: [string, string][]): SnapshotTable {
  return { schema, name, kind: "table", columns: columns.map(([n, type]) => ({ name: n, type })) };
}

describe("diffSnapshots", () => {
  const before = snap([
    tbl("s", "orders", [
      ["id", "integer"],
      ["status", "varchar"],
      ["amount", "integer"],
      ["legacy_flag", "boolean"],
    ]),
    tbl("s", "old_table", [["id", "integer"]]),
    tbl("s", "customers", [["id", "integer"]]),
  ]);

  test("reports added and removed tables, and added, removed and retyped columns", () => {
    const after = snap([
      tbl("s", "orders", [
        ["id", "integer"],
        ["status", "varchar"],
        ["amount", "decimal(12,2)"],
        ["notes", "text"],
      ]),
      tbl("s", "customers", [["id", "integer"]]),
      tbl("s", "refunds", [["id", "integer"]]),
    ]);
    const diff = diffSnapshots(before, after);
    expect(diff).toEqual({
      tables_added: ["s.refunds"],
      tables_removed: ["s.old_table"],
      columns: [
        {
          table: "s.orders",
          added: [{ name: "notes", type: "text" }],
          removed: ["legacy_flag"],
          retyped: [{ name: "amount", from: "integer", to: "decimal(12,2)" }],
        },
      ],
    });
    expect(isEmptyDiff(diff)).toBe(false);
    expect(describeDiff(diff)).toEqual([
      "1 table added: s.refunds.",
      "1 table removed: s.old_table.",
      "s.orders: added notes (text); removed legacy_flag; retyped amount from integer to decimal(12,2).",
    ]);
  });

  test("names and types match ignoring case and spacing", () => {
    const after = snap([
      tbl("S", "ORDERS", [
        ["ID", "INTEGER"],
        ["Status", " VARCHAR "],
        ["amount", "Integer"],
        ["legacy_flag", "BOOLEAN"],
      ]),
      tbl("s", "old_table", [["id", "integer"]]),
      tbl("s", "customers", [["id", "integer"]]),
    ]);
    const diff = diffSnapshots(before, after);
    expect(diff).toEqual({ tables_added: [], tables_removed: [], columns: [] });
    expect(isEmptyDiff(diff)).toBe(true);
    expect(describeDiff(diff)).toEqual([]);
  });

  test("exact names match first; ignoring case is the fallback only when it is unambiguous", () => {
    // Postgres keeps "T" and t apart: with both present before and after, each matches itself.
    const two = snap([tbl("a", "t", [["x", "int"]]), tbl("a", "T", [["y", "int"]])]);
    expect(diffSnapshots(two, two)).toEqual({ tables_added: [], tables_removed: [], columns: [] });
    // t disappears and "T" stays: a removal, not a column change on "T".
    expect(diffSnapshots(two, snap([tbl("a", "T", [["y", "int"]])]))).toEqual({ tables_added: [], tables_removed: ["a.t"], columns: [] });
    // Only the case changed and nothing else has the name: the same table.
    expect(diffSnapshots(snap([tbl("a", "t", [["x", "int"]])]), snap([tbl("a", "T", [["x", "int"]])]))).toEqual({
      tables_added: [],
      tables_removed: [],
      columns: [],
    });
    // Two tables differing only in case where one stood before: the exact one pairs, the other is new.
    expect(diffSnapshots(snap([tbl("a", "t", [["x", "int"]])]), two)).toEqual({ tables_added: ["a.T"], tables_removed: [], columns: [] });
    // Columns follow the same rule: "Amount" and amount are two columns when both exist.
    const cols = diffSnapshots(snap([tbl(null, "t", [["amount", "int"]])]), snap([tbl(null, "t", [["amount", "int"], ["Amount", "text"]])]));
    expect(cols.columns).toEqual([{ table: "t", added: [{ name: "Amount", type: "text" }], removed: [], retyped: [] }]);
    // Ambiguous case-only matches are not guessed: both sides are reported.
    const amb = diffSnapshots(snap([tbl(null, "t", [["A", "int"], ["a", "int"]])]), snap([tbl(null, "t", [["A", "int"], ["Ab", "int"]])]));
    expect(amb.columns).toEqual([{ table: "t", added: [{ name: "Ab", type: "int" }], removed: ["a"], retyped: [] }]);
  });

  test("with no previous snapshot every table is added", () => {
    expect(diffSnapshots(null, before)).toEqual({ tables_added: ["s.orders", "s.old_table", "s.customers"], tables_removed: [], columns: [] });
  });

  test("unqualified tables use their bare names", () => {
    const diff = diffSnapshots(snap([tbl(null, "t", [["a", "int"]])]), snap([tbl(null, "t", [["b", "int"]])]));
    expect(diff.columns).toEqual([{ table: "t", added: [{ name: "b", type: "int" }], removed: ["a"], retyped: [] }]);
  });

  test("long lists are shortened", () => {
    const many = Array.from({ length: 12 }, (_, i) => tbl("s", `t${String(i).padStart(2, "0")}`, [["id", "int"]]));
    const lines = describeDiff(diffSnapshots(snap([]), snap(many)));
    expect(lines[0]).toBe("12 tables added: s.t00, s.t01, s.t02, s.t03, s.t04, s.t05, s.t06, s.t07, s.t08, s.t09, ....");
    const changed = Array.from({ length: 3 }, (_, i) => tbl("s", `c${i}`, [["id", "int"]]));
    const changedAfter = changed.map((t) => ({ ...t, columns: [...t.columns, { name: "x", type: "int" }] }));
    expect(describeDiff(diffSnapshots(snap(changed), snap(changedAfter)), 2)).toEqual([
      "s.c0: added x (int).",
      "s.c1: added x (int).",
      "... and 1 more changed tables.",
    ]);
  });

  test("changeLines says nothing without a previous snapshot, and names the follow-up commands", () => {
    expect(changeLines(null, "wh")).toEqual([]);
    expect(changeLines({ tables_added: [], tables_removed: [], columns: [] }, "wh")).toEqual([
      "No tables or columns changed since the previous snapshot.",
    ]);
    const lines = changeLines(
      { tables_added: [], tables_removed: [], columns: [{ table: "s.t", added: [{ name: "x", type: "int" }], removed: [], retyped: [] }] },
      "wh",
    );
    expect(lines).toEqual([
      "Changes since the previous snapshot:",
      "  s.t: added x (int).",
      "Columns were added: `sl draft --source wh --new-columns` drafts the new columns of modeled tables.",
    ]);
    const lost = changeLines({ tables_added: [], tables_removed: ["s.gone"], columns: [] }, "wh");
    expect(lost[lost.length - 1]).toBe(
      "Removed or retyped columns and tables: `sl validate` reports the fields that read a removed column; read the affected fields back to the owner.",
    );
  });

  test("changeLines with the modeled tables names only those that gained columns", () => {
    const diff = {
      tables_added: [],
      tables_removed: [],
      columns: [
        { table: "s.t", added: [{ name: "x", type: "int" }], removed: [], retyped: [] },
        { table: "s.u", added: [{ name: "y", type: "int" }], removed: [], retyped: [] },
        { table: "s.v", added: [], removed: [], retyped: [{ name: "z", from: "int", to: "bigint" }] },
      ],
    };
    expect(changeLines(diff, "wh", new Set(["s.u", "s.v"]))).toContain("Modeled tables gained columns (s.u): `sl draft --source wh --new-columns` drafts them.");
    const none = changeLines(diff, "wh", new Set(["s.v"]));
    expect(none.some((l) => l.includes("--new-columns"))).toBe(false);
  });

  test("modeledTables keeps in-scope tables a model is built on, as the snapshot spells them", () => {
    const s = snap([tbl("s", "Orders", [["id", "int"]]), tbl("s", "items", [["id", "int"]]), tbl("x", "logs", [["id", "int"]])]);
    const models = [{ table: "s.orders" }, { table: "x.logs" }, { table: "s.missing" }, { model: "no_table" }, null];
    expect([...modeledTables(s, models, { include: ["s.*"] })!]).toEqual(["s.Orders"]);
    expect([...modeledTables(s, () => models)!]).toEqual(["s.Orders", "x.logs"]);
    expect(
      modeledTables(s, () => {
        throw new Error("bad yaml");
      }),
    ).toBeUndefined();
  });
});

describe("column usage", () => {
  const table = tbl("s", "orders", [
    ["id", "integer"],
    ["customer_id", "integer"],
    ["status", "varchar"],
    ["amount_cents", "bigint"],
    ["Order Date", "date"],
    ["payload", "struct"],
    ["is_test", "boolean"],
    ["region", "varchar"],
    ["notes", "text"],
    ["date", "date"],
    ["ignored_one", "text"],
  ]);
  const model: Model = {
    model: "orders",
    source: "wh",
    table: "s.orders",
    status: "draft",
    primary_key: ["id"],
    ignored_columns: ["IGNORED_ONE"],
    dimensions: [
      { name: "status", expr: "upper(status) -- notes in a comment", type: "string", status: "draft" },
      { name: "order_date", expr: '"Order Date"', type: "time", status: "draft" },
      { name: "kind", expr: "payload.kind::varchar", type: "string", status: "draft" },
      { name: "customer_region", expr: "customer.region", type: "string", status: "draft" },
    ],
    measures: [
      { name: "revenue", expr: "amount_cents * 0.01", agg: "sum", filter: "not is_test and status <> 'notes'", status: "draft" },
      { name: "day_count", expr: "date_trunc('day', now())", agg: "count_distinct", status: "draft" },
    ],
    joins: [{ name: "customer", to: "customers", keys: [{ from: "customer_id", to: "id" }], relationship: "many_to_one", status: "draft" }],
  };

  test("sqlIdentifiers skips strings, comments, calls, casts and dotted tails", () => {
    expect(sqlIdentifiers("upper(status) || 'x' /* c */ -- d\n + payload.kind::int + \"Q\".y")).toEqual([
      { v: "status", quoted: false },
      { v: "payload", quoted: false },
      { v: "Q", quoted: true },
    ]);
    // BigQuery reads "..." as a string and backticks as names.
    expect(sqlIdentifiers('a = "b" and `c d` = 1', "bigquery")).toEqual([
      { v: "a", quoted: false },
      { v: "and", quoted: false },
      { v: "c d", quoted: true },
    ]);
  });

  test("sqlIdentifiers skips words in keyword positions: cast and literal types, units and time zones", () => {
    const ids = (sql: string, dialect?: Parameters<typeof sqlIdentifiers>[1]) => sqlIdentifiers(sql, dialect).map((i) => i.v);
    expect(ids("extract(year from ordered_at)")).toEqual(["from", "ordered_at"]);
    expect(ids("EXTRACT(Month FROM created_at) + date_part(day, x)")).toEqual(["FROM", "created_at", "x"]);
    expect(ids("cast(amount as decimal(10,2))")).toEqual(["amount", "as"]);
    expect(ids("cast(ts as date) = date '2024-01-01'")).toEqual(["ts", "as"]);
    expect(ids("cast(ts as timestamp with time zone)")).toEqual(["ts", "as"]);
    expect(ids("ts::double precision + y")).toEqual(["ts", "y"]);
    expect(ids("created_at at time zone 'UTC'")).toEqual(["created_at", "at"]);
    expect(ids("ts > now() - interval '7 days'")).toEqual(["ts"]);
    expect(ids("date_add(d, interval 1 day)", "bigquery")).toEqual(["d", "interval"]);
    expect(ids("datediff(day, opened_at, closed_at)", "snowflake")).toEqual(["opened_at", "closed_at"]);
    expect(ids("date_diff(closed_at, opened_at, day)", "bigquery")).toEqual(["closed_at", "opened_at"]);
    expect(ids("timestamp_trunc(coalesce(a, b), hour)", "bigquery")).toEqual(["a", "b"]);
    // A column that is only named like a unit, outside a unit position, is still a column.
    expect(ids("coalesce(day, 0) + date_trunc('month', month)")).toEqual(["day", "month"]);
    expect(ids("date_trunc('month', month)", "postgres")).toEqual(["month"]);
    expect(ids("date_trunc(d, month)", "duckdb")).toEqual(["d", "month"]);
    expect(ids("datediff(day, a, b)", "postgres")).toEqual(["day", "a", "b"]);
    expect(ids("year = 2024 and date is not null")).toEqual(["year", "and", "date", "is", "not", "null"]);
  });

  test("a new column named like a unit or a type next to an extract or cast expr is still unreferenced", () => {
    const t = tbl(null, "orders", [
      ["id", "int"],
      ["created_at", "timestamp"],
      ["amount", "int"],
      ["year", "int"],
      ["date", "date"],
      ["zone", "text"],
    ]);
    const m: Model = {
      model: "orders",
      source: "wh",
      table: "orders",
      status: "draft",
      primary_key: ["id"],
      dimensions: [
        { name: "order_year", expr: "extract(year from created_at)", type: "number", status: "draft" },
        { name: "order_day", expr: "cast(created_at at time zone 'UTC' as date)", type: "time", status: "draft" },
      ],
      measures: [{ name: "revenue", expr: "cast(amount as decimal(10,2))", agg: "sum", status: "draft" }],
    };
    expect(referencedColumns(m, t)).toEqual(["id", "created_at", "amount"]);
    expect(unreferencedColumns(m, t).map((c) => c.name)).toEqual(["year", "date", "zone"]);
  });

  test("referencedColumns reads exprs, filters, join keys, the primary key and incoming keys", () => {
    // region is read through the customer join, so it is not this table's column; date is only a call.
    expect(referencedColumns(model, table, "duckdb")).toEqual(["id", "customer_id", "status", "amount_cents", "Order Date", "payload", "is_test"]);
    expect(referencedColumns(model, table, "duckdb", ["notes"])).toContain("notes");
  });

  test("unreferencedColumns leaves out ignored_columns, ignoring case", () => {
    expect(unreferencedColumns(model, table, "duckdb").map((c) => c.name)).toEqual(["region", "notes", "date"]);
    expect(unreferencedColumns({ ...model, ignored_columns: undefined }, table, "duckdb").map((c) => c.name)).toEqual([
      "region",
      "notes",
      "date",
      "ignored_one",
    ]);
  });

  test("a quoted name matches its column exactly; a bare one ignores case", () => {
    const t = tbl(null, "t", [
      ["Amount", "int"],
      ["amount", "int"],
      ["Status", "text"],
    ]);
    const m: Model = {
      model: "t",
      source: "wh",
      table: "t",
      status: "draft",
      dimensions: [{ name: "s", expr: "STATUS", type: "string", status: "draft" }],
      measures: [{ name: "a", expr: '"Amount"', agg: "sum", status: "draft" }],
    };
    expect(referencedColumns(m, t)).toEqual(["Amount", "Status"]);
  });

  test("incomingKeyColumns collects the keys other models join on", () => {
    const other = { model: "payments", joins: [{ name: "order", to: "orders", keys: [{ from: "order_id", to: "id" }], relationship: "many_to_one", status: "draft" }] } as Model;
    expect(incomingKeyColumns(model, [model, other])).toEqual(["id"]);
    expect(incomingKeyColumns(model, [{ model: "x" } as Model])).toEqual([]);
  });

  test("missingColumns names bare and quoted exprs that are not columns", () => {
    const t = tbl(null, "t", [["a", "int"]]);
    const m: Model = {
      model: "t",
      source: "wh",
      table: "t",
      status: "draft",
      dimensions: [
        { name: "a", expr: "A", type: "number", status: "draft" },
        { name: "gone", expr: "gone_col", type: "string", status: "draft" },
        { name: "q", expr: '"Gone Too"', type: "string", status: "draft" },
        { name: "lit", expr: "true", type: "boolean", status: "draft" },
        { name: "sql", expr: "upper(other)", type: "string", status: "draft" },
      ],
      measures: [{ name: "m", expr: "vanished", agg: "sum", status: "draft" }],
    };
    expect(missingColumns(m, t)).toEqual([
      { field: "gone", column: "gone_col" },
      { field: "q", column: "Gone Too" },
      { field: "m", column: "vanished" },
    ]);
  });
});

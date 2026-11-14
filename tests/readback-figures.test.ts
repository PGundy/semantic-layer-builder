// HR-10: readbacks show a measure's or metric's figure on today's data, as evidence outside the
// approval hash. The Acme warehouse runs on DuckDB from the synthetic fixture, and once on a live
// Postgres when PG_URL is set.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadPostgres } from "../fixtures/acme/load-postgres.ts";
import { readCsvSql, WAREHOUSE_TABLES } from "../fixtures/acme/schema.ts";
import { renderReadbacks } from "../skills/semantic-layer/scripts/lib/readback.ts";
import { figureTimeout, readbackFigures } from "../skills/semantic-layer/scripts/lib/readback-figures.ts";
import type { PendingReadback } from "../skills/semantic-layer/scripts/lib/types.ts";
import { schemaIssues } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, PG_URL, sl, tempDir } from "./helpers.ts";

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const DATA = join(import.meta.dir, "..", "fixtures", "acme", "data");
let warehouse = "";

// The Acme warehouse tables in schema acme of one DuckDB file, shared by the file's tests (read-only).
beforeAll(async () => {
  warehouse = join(tempDir("figures-db"), "warehouse.duckdb");
  const instance = await DuckDBInstance.create(warehouse);
  const cx = await instance.connect();
  await cx.run("create schema acme");
  for (const tb of WAREHOUSE_TABLES) await cx.run(`create table acme.${tb.name} as select * from ${readCsvSql(join(DATA, "warehouse", `${tb.name}.csv`), tb)}`);
  cx.closeSync();
  instance.closeSync();
});

// A copy of Acme whose warehouse source reads the DuckDB file (or `source`, a source file's text).
function acme(source = `source: warehouse\ndialect: duckdb\nconnection:\n  database: ${JSON.stringify(warehouse)}\n`): string {
  const root = join(tempDir("figures"), "semantic");
  cpSync(ACME, root, { recursive: true });
  writeFileSync(join(root, "sources", "warehouse.yaml"), source);
  return root;
}

interface Item {
  target: string;
  text: string;
  content_hash: string;
  evidence?: PendingReadback["items"][number]["evidence"];
}

async function readback(root: string, targets: string, env: Record<string, string | undefined> = {}): Promise<Item[]> {
  const r = await sl(root, ["readback", "--targets", targets, "--json"], env);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return r.json<{ items: Item[] }>().items;
}

// The same figures written by hand on the DuckDB file, independent of the compiler.
async function direct(sql: string): Promise<Record<string, unknown>> {
  const instance = await DuckDBInstance.create(warehouse, { access_mode: "READ_ONLY" });
  const cx = await instance.connect();
  const rows = (await cx.runAndReadAll(sql)).getRowObjectsJson();
  cx.closeSync();
  instance.closeSync();
  return rows[0] as Record<string, unknown>;
}

const REVENUE_ROWS = `from acme.fct_orders o left join acme.dim_customers c on o.customer_id = c.customer_id
  where o.status in ('completed', 'shipped') and coalesce(c.is_test_account, false) = false and coalesce(c.email, '') not like '%@example-test.com'`;

describe("the figure on a connected source", () => {
  test("a measure: its total and the rows behind it, through the compiler, as the hand-written query gives them", async () => {
    const root = acme();
    const [item] = await readback(root, "warehouse.orders.revenue");
    const want = await direct(`select sum(o.amount_cents) as cents, count(*) as n ${REVENUE_ROWS}`);
    expect(item!.evidence!.figure).toBeCloseTo(Number(want.cents) / 100, 6);
    expect(item!.evidence!.row_count).toBe(Number(want.n));
    expect(item!.text).toContain("Measured from the data, no need to confirm:\n- On today's data it comes to 535,381.93 USD, over the 4,049 rows it counts, before any role's row filter.\n");
  });

  test("a ratio metric: its figure, and each measure it combines with its rows", async () => {
    const root = acme();
    const [aov] = await readback(root, "metric:average_order_value");
    const want = await direct(`select sum(o.amount_cents) / 100.0 / count(*) as aov, count(*) as n ${REVENUE_ROWS}`);
    expect(aov!.evidence!.figure).toBeCloseTo(Number(want.aov), 9);
    expect(aov!.evidence!.parts!.map((p) => [p.ref, p.row_count])).toEqual([
      ["orders.revenue", Number(want.n)],
      ["orders.order_count", Number(want.n)],
    ]);
    expect(aov!.text).toContain(
      "- On today's data it comes to 132.23 USD, before any role's row filter: orders.revenue 535,381.93 over 4,049 rows; orders.order_count 4,049 over 4,049 rows.",
    );
    // The pending file stores the figure as evidence, and matches the schema.
    const stored = JSON.parse(readFileSync(join(root, ".sl", "pending", "rb_0001.json"), "utf8")) as PendingReadback;
    expect(stored.items[0]!.evidence).toEqual(aov!.evidence!);
    expect(schemaIssues("pending", stored, ".sl/pending/rb_0001.json")).toEqual([]);
  });

  test("the figure is outside the approval hash: byte-identical with and without it, and equal to the recorded approved_hash", async () => {
    const root = acme();
    const targets = ["warehouse.orders.revenue", "warehouse.orders.order_count", "metric:average_order_value", "metric:net_revenue"];
    const figures = await readbackFigures(root, targets, {});
    expect([...figures.values()].every((f) => f.not_shown === undefined)).toBe(true);
    const withFigures = renderReadbacks(root, targets, new Map(), figures);
    const without = renderReadbacks(root, targets);
    expect(withFigures.map((r) => r.content_hash)).toEqual(without.map((r) => r.content_hash));
    expect(withFigures.map((r) => r.text)).not.toEqual(without.map((r) => r.text));
    const orders = readYaml<{ measures: { name: string; approved_hash: string }[] }>(join(root, "models", "warehouse", "orders.yaml"));
    const metrics = readYaml<{ metrics: { name: string; approved_hash: string }[] }>(join(root, "metrics.yaml"));
    expect(withFigures.map((r) => r.content_hash)).toEqual([
      orders.measures.find((m) => m.name === "revenue")!.approved_hash,
      orders.measures.find((m) => m.name === "order_count")!.approved_hash,
      metrics.metrics.find((m) => m.name === "average_order_value")!.approved_hash,
      metrics.metrics.find((m) => m.name === "net_revenue")!.approved_hash,
    ]);
    // sl approve accepts the yes to an item read back with its figure.
    const items = await readback(root, "warehouse.orders.revenue");
    expect(items[0]!.content_hash).toBe(withFigures[0]!.content_hash);
  });

  test("a dimension runs no query: it shows the profile's stored values", async () => {
    const root = acme();
    expect((await readbackFigures(root, ["warehouse.orders.status", "warehouse.orders", "access"], {})).size).toBe(0);
    const [status] = await readback(root, "warehouse.orders.status");
    expect(status!.evidence).toBeUndefined();
    expect(status!.text).toContain("    > 'completed': 3,950 rows");
  });
});

describe("a figure that is not shown says why and blocks nothing", () => {
  test("an export source: no figure, with the reason and the upgrade", async () => {
    const root = acme("source: warehouse\ndialect: postgres\nintake:\n  mode: export\n  reason: No outside connections.\n  export:\n    file: exports/warehouse.csv\n");
    const [revenue, aov] = await readback(root, "warehouse.orders.revenue,metric:average_order_value");
    const why =
      "source warehouse is an export source, which sl does not query; the figure comes once it has a connection (sl setup --source warehouse --dialect postgres --env <VAR>)";
    expect(revenue!.evidence).toEqual({ not_shown: why });
    expect(aov!.evidence).toEqual({ not_shown: why });
    expect(revenue!.text).toContain(`- Figure not shown: ${why}.`);
  });

  test("a protected column never appears: a total over it is not computed, and its values are in no output", async () => {
    const root = acme();
    const f = join(root, "models", "warehouse", "customers.yaml");
    const extra =
      "  - name: last_email\n    agg: max\n    expr: email\n    format: integer\n" +
      "  - name: tagged_count\n    agg: count\n    tags: [pii]\n    format: integer\n" +
      "  - name: emails\n    agg: count_distinct\n    expr: email\n    format: integer\n";
    writeFileSync(f, readFileSync(f, "utf8").replace("measures: []\n", `measures:\n${extra}`));
    const r = await sl(root, ["readback", "--targets", "warehouse.customers.last_email,warehouse.customers.tagged_count,warehouse.customers.emails", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const items = r.json<{ items: Item[] }>().items;
    expect(items[0]!.evidence).toEqual({ not_shown: "it reads the protected column email, so its total is not shown" });
    expect(items[1]!.evidence).toEqual({ not_shown: "customers.tagged_count is tagged pii, so its total is not shown" });
    // A count of distinct values is a count, never a value.
    const want = await direct("select count(distinct email) as n, count(*) as rows from acme.dim_customers");
    expect(items[2]!.evidence).toEqual({ figure: Number(want.n), row_count: Number(want.rows) });
    const max = String((await direct("select max(email) as m from acme.dim_customers")).m);
    const stored = readFileSync(join(root, ".sl", "pending", "rb_0001.json"), "utf8");
    expect(max).toContain("@");
    for (const out of [r.out, stored]) expect(out).not.toContain(max);
  });

  test("a failed query names its reason and the other items still get theirs; a missing database is one line", async () => {
    const root = acme();
    const f = join(root, "models", "warehouse", "orders.yaml");
    writeFileSync(f, readFileSync(f, "utf8").replace("measures:\n", "measures:\n  - name: broken\n    agg: sum\n    expr: no_such_column\n    format: integer\n"));
    const [broken, revenue] = await readback(root, "warehouse.orders.broken,warehouse.orders.revenue");
    // The database's message, its quoted text left out: it may quote a value (failureReason).
    expect(broken!.evidence!.not_shown).toStartWith("Binder Error: Referenced column");
    expect(broken!.text).toMatch(/\n- Figure not shown: Binder Error: Referenced column .*\.\n/);
    expect(revenue!.evidence!.figure).toBeCloseTo(535381.93, 6);
    const gone = acme(`source: warehouse\ndialect: duckdb\nconnection:\n  database: ${JSON.stringify(join(tempDir("none"), "missing.duckdb"))}\n`);
    const [r] = await readback(gone, "warehouse.orders.revenue");
    expect(r!.evidence!.not_shown).toStartWith("sl cannot connect to source warehouse");
    expect(r!.evidence!.not_shown).toEndWith("sl next names the step that connects it");
    expect(r!.evidence!.not_shown).not.toContain("\n");
  });

  test("a figure past its deadline reads timed out with the commands that get it; the figure after it on the source is still computed", async () => {
    expect(figureTimeout({})).toBe(10_000);
    expect(figureTimeout({ SL_STATEMENT_TIMEOUT_MS: "60000" })).toBe(10_000);
    expect(figureTimeout({ SL_STATEMENT_TIMEOUT_MS: "250" })).toBe(250);
    expect(figureTimeout({ SL_STATEMENT_TIMEOUT_MS: "0" })).toBe(10_000);
    // The Acme warehouse plus a view over a long range, which makes its total slow to compute.
    const file = join(tempDir("slow"), "slow.duckdb");
    cpSync(warehouse, file);
    const instance = await DuckDBInstance.create(file);
    const cx = await instance.connect();
    await cx.run("create view acme.big as select range as x from range(100000000000)");
    cx.closeSync();
    instance.closeSync();
    const root = acme(`source: warehouse\ndialect: duckdb\nconnection:\n  database: ${JSON.stringify(file)}\n`);
    writeFileSync(join(root, "models", "warehouse", "big.yaml"), BIG);
    const started = Date.now();
    // The slow figure first: the timeout is its own, and the readback goes on to the next one.
    const figures = await readbackFigures(root, ["warehouse.big.total", "warehouse.orders.revenue"], { SL_STATEMENT_TIMEOUT_MS: "50" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(figures.get("warehouse.big.total")).toEqual({ not_shown: `timed out after 0.05 s, so the readback went on without it; ${BY_HAND}` });
    expect(figures.get("warehouse.orders.revenue")!.figure).toBeCloseTo(535381.93, 6);
  }, 30_000);
});

const BIG = "model: big\ntable: acme.big\nstatus: draft\nprimary_key: [x]\ndimensions: []\nmeasures:\n  - name: total\n    agg: count\n    filter: x % 7 = 3\n    format: integer\n";
const BY_HAND = `sl sql --source warehouse --request '{"measures":["big.total"]}' prints its query, and sl run --source warehouse --sql runs it with a longer timeout`;

describe("the readback reads as the owner's words", () => {
  test("a batch prints a who-sees block once; a different block is printed in full", async () => {
    const root = acme();
    const items = await readback(root, "warehouse.orders,warehouse.orders.order_date,warehouse.orders.status,warehouse.orders.revenue,metric:net_revenue");
    const all = items.map((i) => i.text).join("\n");
    expect(all.split("Who sees it once approved (access.yaml is approved, mode open):").length - 1).toBe(2);
    expect(items[0]!.text).toContain("Who sees it once approved (access.yaml is approved, mode open):\n- Default audience (a user with no role): sees it.\n- Role sales: sees it, only on the rows its row filter on warehouse.orders allows.");
    for (const i of items.slice(1, 4)) expect(i.text).toContain("\nWho sees it once approved: the same as item 1.\n");
    expect(items[4]!.text).toContain("- Role analyst: sees it.");
  });

  test("the access readback names every role and what it adds or takes away", async () => {
    const root = acme();
    const f = join(root, "access.yaml");
    // A role that takes something away, to read both directions.
    writeFileSync(f, readFileSync(f, "utf8").replace("restrictions:\n", "  - name: contractor\n    assign_when: user.department in ['vendor', 'agency']\n    deny:\n      models: [warehouse.customers]\nrestrictions:\n"));
    const [access] = await readback(root, "access");
    const roles = readYaml<{ roles: { name: string }[] }>(f).roles.map((r) => r.name);
    expect(roles).toEqual(["analyst", "finance", "sales", "contractor"]);
    for (const r of roles) expect(access!.text).toContain(`\n- Role ${r}, held when `);
    expect(access!.text).toContain("- Role contractor, held when the user's department is 'vendor' or 'agency'. Compared with a user with no role:\n  - It adds: nothing.\n  - It takes away: the table warehouse.customers.");
    expect(access!.text).toContain("  - It adds: the table warehouse.refunds; metric net_revenue.\n  - It takes away: nothing.\n  - It sees every row.");
  });

  test("in closed mode a user with no role sees nothing, said in one line, and each role lists what it adds", async () => {
    const root = acme();
    const f = join(root, "access.yaml");
    writeFileSync(
      f,
      readFileSync(f, "utf8")
        .replace("mode: open", "mode: closed")
        .replace("    assign_when: user.department == 'finance'\n", "    assign_when: user.department == 'finance'\n    allow:\n      models: [warehouse.orders, warehouse.refunds]\n"),
    );
    const [access] = await readback(root, "access");
    expect(access!.text).toContain("\n- A user with no role sees nothing.\n");
    expect(access!.text).toContain("- Role finance, held when the user's department is 'finance'. Compared with a user with no role:\n");
    expect(access!.text).toContain("  - It adds: the table warehouse.orders; the table warehouse.refunds; metric average_order_value; metric net_revenue.\n");
  });

  test("a golden's tolerance line says it applies to figures with decimals, and whole numbers and grouping columns match exactly", async () => {
    const root = acme();
    const r = await sl(root, ["readback", "--targets", "golden:revenue_by_region_2025", "--tolerance", "0.005", "--json"]);
    expect(r.code).toBe(0);
    const text = r.json<{ items: Item[] }>().items[0]!.text;
    expect(text).toContain("- Tolerance: 0.005: on later runs a figure with decimals may move up to 0.5% either way; whole numbers and grouping columns must match exactly.");
  });
});

describe("live Postgres", () => {
  const db = `sl_figures_${process.pid}_${Date.now()}`;
  let url = "";
  let admin: SQL | undefined;
  beforeAll(async () => {
    if (!PG_URL) return;
    assertLocalPg(PG_URL);
    admin = new SQL({ url: PG_URL, max: 1 });
    const u = new URL(PG_URL);
    u.pathname = `/${db}`;
    url = u.toString();
    await admin.unsafe(`CREATE DATABASE "${db}"`);
    await loadPostgres(url, DATA, "acme");
  }, 120_000);
  afterAll(async () => {
    if (!admin) return;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {});
    await admin.close();
  });

  test.skipIf(!PG_URL)("the committed Acme layer on Postgres shows the same figures as on DuckDB, read-only", async () => {
    const root = join(tempDir("figures-pg"), "semantic");
    cpSync(ACME, root, { recursive: true });
    const items = await readback(root, "warehouse.orders.revenue,metric:average_order_value,warehouse.customers.email", { WAREHOUSE_URL: url });
    expect(items[0]!.evidence!.figure).toBeCloseTo(535381.93, 6);
    expect(items[0]!.evidence!.row_count).toBe(4049);
    expect(items[1]!.text).toContain("- On today's data it comes to 132.23 USD, before any role's row filter:");
    expect(items[2]!.evidence).toBeUndefined();
    const duck = await readback(acme(), "warehouse.orders.revenue,metric:average_order_value");
    expect(items.slice(0, 2).map((i) => i.content_hash)).toEqual(duck.map((i) => i.content_hash));
  }, 60_000);

  test.skipIf(!PG_URL)("on Postgres a timed-out figure is cancelled by the server, and the figure after it is still computed", async () => {
    const pg = new SQL({ url, max: 1 });
    await pg.unsafe("CREATE VIEW acme.big AS SELECT g AS x FROM generate_series(1::bigint, 3000000000::bigint) g");
    await pg.close();
    const root = join(tempDir("figures-pg-slow"), "semantic");
    cpSync(ACME, root, { recursive: true });
    writeFileSync(join(root, "models", "warehouse", "big.yaml"), BIG);
    const [big, revenue] = await readback(root, "warehouse.big.total,warehouse.orders.revenue", { WAREHOUSE_URL: url, SL_STATEMENT_TIMEOUT_MS: "200" });
    expect(big!.evidence).toEqual({ not_shown: `timed out after 0.2 s, so the readback went on without it; ${BY_HAND}` });
    expect(revenue!.evidence!.figure).toBeCloseTo(535381.93, 6);
  }, 60_000);
});

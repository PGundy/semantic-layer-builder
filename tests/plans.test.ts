import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openQueryAdapter, planId } from "../skills/semantic-layer/scripts/lib/plan.ts";
import { loadSource } from "../skills/semantic-layer/scripts/lib/project.ts";
import type { QueryPlan, StoredPlan } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { duckdbSource, initProject, sl, tempRoot } from "./helpers.ts";

// Resumable query plans (spec: Query-plan protocol, Stored plans). All data is synthetic.

const WAREHOUSE = [
  "create table customers (customer_id integer primary key, email varchar, segment varchar, birth_date date)",
  "insert into customers select i, 'person' || i || '@example.test', case when i % 3 = 0 then 'smb' else 'enterprise' end, " +
    "date '1980-01-01' + i::integer from range(1, 31) t(i)",
  "create table orders (order_id integer primary key, customer_id integer references customers(customer_id), status varchar, amount decimal(10,2))",
  "insert into orders select i, 1 + i % 30, case when i % 4 = 0 then 'cancelled' else 'paid' end, i * 1.5 from range(1, 61) t(i)",
];

type Emitted = QueryPlan & { plan_id: string; path: string; queries: (QueryPlan["queries"][number] & { max_rows: number })[] };

interface StatusJson {
  plan_id: string;
  queries: { id: string; stored: boolean; rows?: number; max_rows: number }[];
  remaining: string[];
  complete: boolean;
  finish: string;
  next: string;
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function setup(): Promise<{ root: string; dir: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  await duckdbSource(t.root, t.dir, "wh", WAREHOUSE);
  return t;
}

// Runs every query of a plan as the agent's own tool would, writing one rows file per query.
async function runQueries(root: string, dir: string, plan: QueryPlan): Promise<Map<string, string>> {
  const adapter = await openQueryAdapter(root, loadSource(root, "wh"), {});
  const files = new Map<string, string>();
  try {
    for (const [i, q] of plan.queries.entries()) {
      const { rows } = await adapter.query(q.sql);
      // Upper-case column names, as a warehouse tool might return them.
      const file = join(dir, `rows-${i}.json`);
      writeFileSync(file, JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toUpperCase(), v])))));
      files.set(q.id, file);
    }
  } finally {
    await adapter.close();
  }
  return files;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

async function emit(root: string, args: string[]): Promise<Emitted> {
  const r = await sl(root, [...args, "--emit-sql"]);
  expect(r.code).toBe(0);
  return r.json<Emitted>();
}

async function addAll(root: string, plan: Emitted, files: Map<string, string>): Promise<void> {
  for (const q of plan.queries) {
    const r = await sl(root, ["results", "add", "--plan", plan.plan_id, "--query", q.id, "--file", files.get(q.id)!]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  }
}

describe("emit, add each result, status, finish", () => {
  test("introspect: the finished snapshot equals a live run's", async () => {
    const t = await setup();
    const plan = await emit(t.root, ["introspect", "--source", "wh"]);
    expect(plan.plan_id).toMatch(/^[0-9a-f]{12}$/);
    expect(plan.path).toBe(join(t.root, ".sl", "plans", `${plan.plan_id}.json`));
    const stored = JSON.parse(readFileSync(plan.path, "utf8")) as StoredPlan;
    expect(stored.finish).toBe(`sl introspect --source wh --plan ${plan.plan_id}`);
    expect(stored.queries).toEqual(plan.queries);

    const files = await runQueries(t.root, t.dir, plan);
    const before = await sl(t.root, ["results", "status", "--plan", plan.plan_id, "--json"]);
    expect(before.json<StatusJson>()).toMatchObject({ complete: false, remaining: plan.queries.map((q) => q.id) });
    expect(before.json<StatusJson>().next).toContain(`sl results add --plan ${plan.plan_id} --query tables`);

    const [first, ...rest] = plan.queries;
    const partial = await sl(t.root, ["results", "add", "--plan", plan.plan_id, "--query", first!.id, "--file", files.get(first!.id)!, "--json"]);
    expect(partial.json<{ state: string; remaining: string[] }>()).toMatchObject({ state: "added", remaining: rest.map((q) => q.id) });
    const early = await sl(t.root, ["introspect", "--source", "wh", "--plan", plan.plan_id]);
    expect(early.code).toBe(1);
    expect(early.err).toContain(`still needs results for: ${rest.map((q) => q.id).join(", ")}`);
    expect(early.err).toContain(`sl results status --plan ${plan.plan_id}`);

    await addAll(t.root, plan, files);
    const done = await sl(t.root, ["results", "status", "--plan", plan.plan_id, "--json"]);
    expect(done.json<StatusJson>()).toMatchObject({ complete: true, remaining: [], next: `Next: ${stored.finish}` });
    const human = await sl(t.root, ["results", "status", "--plan", plan.plan_id]);
    expect(human.out).toContain(`${plan.queries.length} of ${plan.queries.length} results stored`);
    expect(human.out).toContain(`Next: sl introspect --source wh --plan ${plan.plan_id}`);

    const finished = await sl(t.root, ["introspect", "--source", "wh", "--plan", plan.plan_id, "--json"]);
    expect(finished.code).toBe(0);
    const fromPlan = readFileSync(join(t.root, "snapshots", "wh.json"), "utf8");
    const live = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(live.code).toBe(0);
    expect(readFileSync(join(t.root, "snapshots", "wh.json"), "utf8")).toBe(fromPlan);
    expect(JSON.parse(fromPlan).tables.map((x: { name: string }) => x.name)).toEqual(["customers", "orders"]);
    // Introspect keeps its plan: finishing again gives the same snapshot.
    expect((await sl(t.root, ["introspect", "--source", "wh", "--plan", plan.plan_id])).code).toBe(0);
  });

  test("profile: the finished snapshot equals a live run's, and the plan is removed", async () => {
    const t = await setup();
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    const introspected = readFileSync(join(t.root, "snapshots", "wh.json"), "utf8");
    const plan = await emit(t.root, ["profile", "--source", "wh"]);
    expect(plan.queries.map((q) => q.id)).toEqual(["stats:main.customers", "top:main.customers", "stats:main.orders", "top:main.orders"]);
    // Default top_values 10: customers' top values read segment only (email is protected), orders' status.
    expect(plan.queries.map((q) => q.max_rows)).toEqual([2, 11, 2, 11]);

    const files = await runQueries(t.root, t.dir, plan);
    await addAll(t.root, plan, files);
    const finished = await sl(t.root, ["profile", "--source", "wh", "--plan", plan.plan_id]);
    expect(finished.code).toBe(0);
    expect(finished.out).toContain(`Removed plan ${plan.plan_id}`);
    expect(existsSync(plan.path)).toBe(false);
    expect(existsSync(join(t.root, ".sl", "plans", plan.plan_id))).toBe(false);
    const fromPlan = readFileSync(join(t.root, "snapshots", "wh.json"), "utf8");

    writeFileSync(join(t.root, "snapshots", "wh.json"), introspected);
    expect((await sl(t.root, ["profile", "--source", "wh"])).code).toBe(0);
    expect(readFileSync(join(t.root, "snapshots", "wh.json"), "utf8")).toBe(fromPlan);
    const status = await sl(t.root, ["results", "status", "--plan", plan.plan_id]);
    expect(status.code).toBe(1);
    expect(status.err).toContain(`No query plan ${plan.plan_id}`);
  });
});

describe("max_rows", () => {
  test("a result of exactly max_rows rows is refused as possibly cut off; more or fewer are stored", async () => {
    const t = await setup();
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    const plan = await emit(t.root, ["profile", "--source", "wh", "--tables", "orders"]);
    const top = plan.queries.find((q) => q.id === "top:main.orders")!;
    expect(top.max_rows).toBe(11);
    const file = join(t.dir, "cut.json");
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ column_index: 2, value: `v${i}`, n: 1, rank_in_column: i + 1 }));
    writeFileSync(file, JSON.stringify(rows(11)));
    const cut = await sl(t.root, ["results", "add", "--plan", plan.plan_id, "--query", top.id, "--file", file]);
    expect(cut.code).toBe(1);
    expect(cut.err).toContain('The result of "top:main.orders" has 11 rows, exactly its max_rows');
    expect(cut.err).toContain("sl results add");
    expect(existsSync(join(t.root, ".sl", "plans", plan.plan_id))).toBe(false);

    writeFileSync(file, JSON.stringify(rows(10)));
    expect((await sl(t.root, ["results", "add", "--plan", plan.plan_id, "--query", top.id, "--file", file])).code).toBe(0);
    const stats = join(t.dir, "stats.json");
    writeFileSync(stats, JSON.stringify([{ row_count: 1 }, { row_count: 2 }]));
    const two = await sl(t.root, ["results", "add", "--plan", plan.plan_id, "--query", "stats:main.orders", "--file", stats]);
    expect(two.code).toBe(1);
    expect(two.err).toContain("exactly its max_rows");
  });

  test("every query of an emitted plan declares max_rows", async () => {
    const t = await setup();
    const plan = await emit(t.root, ["introspect", "--source", "wh"]);
    expect(Object.fromEntries(plan.queries.map((q) => [q.id, q.max_rows]))).toEqual({
      tables: 200_000,
      columns: 5_000_000,
      primary_keys: 2_000_000,
      foreign_keys: 2_000_000,
    });
  });
});

describe("refusals", () => {
  test("unknown or malformed plan ids and unknown query ids", async () => {
    const t = await setup();
    const plan = await emit(t.root, ["introspect", "--source", "wh"]);
    const file = join(t.dir, "rows.json");
    writeFileSync(file, "[]");

    const unknown = await sl(t.root, ["results", "status", "--plan", "0123456789ab"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("No query plan 0123456789ab");
    expect(unknown.err).toContain("--emit-sql");
    for (const bad of ["../../x", "ABC", "0123456789abc"]) {
      const r = await sl(t.root, ["results", "add", "--plan", bad, "--query", "tables", "--file", file]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("is not a plan id");
    }
    const finish = await sl(t.root, ["introspect", "--source", "wh", "--plan", "0123456789ab"]);
    expect(finish.code).toBe(1);
    expect(finish.err).toContain("No query plan 0123456789ab");

    const query = await sl(t.root, ["results", "add", "--plan", plan.plan_id, "--query", "nope", "--file", file]);
    expect(query.code).toBe(1);
    expect(query.err).toContain(`Plan ${plan.plan_id} has no query "nope"`);
    expect(query.err).toContain("tables, columns, primary_keys, foreign_keys");
    expect(filesUnder(join(t.root, ".sl", "plans")).map((f) => f.slice(t.root.length))).toEqual([
      `/.sl/plans/${plan.plan_id}.json`,
      "/.sl/plans/.gitignore",
    ].sort());
  });

  test("a rows file that is not an array of objects, or has two columns differing in case", async () => {
    const t = await setup();
    const plan = await emit(t.root, ["introspect", "--source", "wh"]);
    const file = join(t.dir, "rows.json");
    const add = () => sl(t.root, ["results", "add", "--plan", plan.plan_id, "--query", "tables", "--file", file]);
    writeFileSync(file, JSON.stringify({ tables: [] }));
    expect((await add()).err).toContain("must hold a JSON array of row objects");
    writeFileSync(file, JSON.stringify([{ a: 1 }, [1]]));
    expect((await add()).err).toContain("row 2 is not an object");
    writeFileSync(file, JSON.stringify([{ Name: 1, NAME: 2 }]));
    expect((await add()).err).toContain("more than one column named");
    writeFileSync(file, "not json");
    expect((await add()).err).toContain("invalid JSON");
    const missing = await sl(t.root, ["results", "add", "--plan", plan.plan_id, "--query", "tables", "--file", join(t.dir, "missing.json")]);
    expect(missing.err).toContain(`missing.json. Save the rows of query "tables" there as a JSON array of row objects`);
    expect(missing.err).toContain(`sl results add --plan ${plan.plan_id} --query tables`);
  });

  test("--plan with --results or --emit-sql, a stale plan and an edited plan file", async () => {
    const t = await setup();
    const plan = await emit(t.root, ["introspect", "--source", "wh"]);
    const both = await sl(t.root, ["introspect", "--source", "wh", "--plan", plan.plan_id, "--results", "x.json"]);
    expect(both.err).toContain("Pass --plan <id> or --results <file>, not both.");
    const emitToo = await sl(t.root, ["introspect", "--source", "wh", "--plan", plan.plan_id, "--emit-sql"]);
    expect(emitToo.code).toBe(1);
    expect(emitToo.err).toContain("pass one of them");

    await addAll(t.root, plan, await runQueries(t.root, t.dir, plan));
    const stale = await sl(t.root, ["introspect", "--source", "wh", "--schemas", "main", "--plan", plan.plan_id]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain(`Plan ${plan.plan_id} is not the plan this command builds now`);
    expect(stale.err).toContain("--emit-sql");

    const stored = JSON.parse(readFileSync(plan.path, "utf8")) as StoredPlan;
    stored.queries[0]!.sql = "select 1";
    writeFileSync(plan.path, JSON.stringify(stored));
    const edited = await sl(t.root, ["results", "status", "--plan", plan.plan_id]);
    expect(edited.code).toBe(1);
    expect(edited.err).toContain(`no longer gives plan id ${plan.plan_id}`);
    // finish is outside the plan id; an edited one that is not an sl command line is refused.
    await emit(t.root, ["introspect", "--source", "wh"]);
    const original = JSON.parse(readFileSync(plan.path, "utf8")) as StoredPlan;
    for (const finish of [`sl introspect --source wh; touch x --plan ${plan.plan_id}`, `sl run --sql 'select 1' --plan ${plan.plan_id}`]) {
      writeFileSync(plan.path, JSON.stringify({ ...original, finish }));
      const r = await sl(t.root, ["results", "status", "--plan", plan.plan_id]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("changed after it was written");
    }
    writeFileSync(plan.path, JSON.stringify({ ...original, finish: `sl introspect --source wh --tables 'a b'\\'' c' --plan ${plan.plan_id}` }));
    expect((await sl(t.root, ["results", "status", "--plan", plan.plan_id])).code).toBe(0);
    writeFileSync(plan.path, JSON.stringify({ ...stored, max_rows: 3 }));
    expect((await sl(t.root, ["results", "status", "--plan", plan.plan_id])).err).toContain("is not a valid query plan");
  });

  test("results needs a subcommand and its flags", async () => {
    const t = await setup();
    expect((await sl(t.root, ["results"])).err).toContain("Pass a subcommand: add, status.");
    expect((await sl(t.root, ["results", "add", "--plan", "0123456789ab"])).err).toContain("results add needs --query");
    expect((await sl(t.root, ["results", "status"])).err).toContain("results status needs --plan");
    const extra = await sl(t.root, ["results", "status", "extra", "--plan", "0123456789ab"]);
    expect(extra.err).toContain('Unexpected argument "extra". Run sl results add --plan <plan_id>');
  });
});

describe("re-adding and re-emitting", () => {
  test("adding the same rows again changes nothing; different rows replace them", async () => {
    const t = await setup();
    const plan = await emit(t.root, ["introspect", "--source", "wh"]);
    const files = await runQueries(t.root, t.dir, plan);
    const add = (file: string) => sl(t.root, ["results", "add", "--plan", plan.plan_id, "--query", "tables", "--file", file, "--json"]);
    expect((await add(files.get("tables")!)).json<{ state: string }>().state).toBe("added");
    const [stored] = filesUnder(join(t.root, ".sl", "plans", plan.plan_id));
    const bytes = readFileSync(stored!, "utf8");
    const again = await add(files.get("tables")!);
    expect(again.json<{ state: string; rows: number }>()).toMatchObject({ state: "unchanged", rows: 2 });
    expect(readFileSync(stored!, "utf8")).toBe(bytes);
    const human = await sl(t.root, ["results", "add", "--plan", plan.plan_id, "--query", "tables", "--file", files.get("tables")!]);
    expect(human.out).toContain('The same 2 rows were already stored for "tables"; nothing changed.');
    expect(human.out).toContain("3 of 4 queries still need results.");
    expect(human.out).toContain("Next: run query \"columns\"");

    const empty = join(t.dir, "empty.json");
    writeFileSync(empty, "[]");
    expect((await add(empty)).json<{ state: string }>().state).toBe("replaced");
    expect(JSON.parse(readFileSync(stored!, "utf8"))).toEqual({ query: "tables", rows: [] });
  });

  test("emitting the same plan again reuses its id and file and keeps its stored results", async () => {
    const t = await setup();
    const plan = await emit(t.root, ["introspect", "--source", "wh"]);
    const bytes = readFileSync(plan.path, "utf8");
    await addAll(t.root, plan, await runQueries(t.root, t.dir, plan));
    const again = await emit(t.root, ["introspect", "--source", "wh"]);
    expect(again.plan_id).toBe(plan.plan_id);
    expect(readFileSync(plan.path, "utf8")).toBe(bytes);
    expect((await sl(t.root, ["results", "status", "--plan", plan.plan_id, "--json"])).json<StatusJson>().complete).toBe(true);
    expect(planId(again)).toBe(plan.plan_id);
    const other = await emit(t.root, ["introspect", "--source", "wh", "--schemas", "main"]);
    expect(other.plan_id).not.toBe(plan.plan_id);
  });
});

describe("backward compatibility", () => {
  test("the emitted JSON keeps every field and gains plan_id, path and max_rows; a note names the next commands", async () => {
    const t = await setup();
    const r = await sl(t.root, ["introspect", "--source", "wh", "--emit-sql"]);
    const plan = r.json<Emitted>();
    expect(Object.keys(plan)).toEqual(["command", "source", "dialect", "queries", "plan_id", "path"]);
    expect(plan).toMatchObject({ command: "introspect", source: "wh", dialect: "duckdb" });
    for (const q of plan.queries) expect(Object.keys(q)).toEqual(["id", "purpose", "sql", "max_rows"]);
    expect(r.err).toContain(`Wrote plan ${plan.plan_id}`);
    expect(r.err).toContain(`sl results add --plan ${plan.plan_id} --query <query id> --file <rows.json>`);
    expect(r.err).toContain(`sl introspect --source wh --plan ${plan.plan_id}`);
  });

  test("--results <file> works unchanged, and ignores max_rows", async () => {
    const t = await setup();
    const plan = await emit(t.root, ["introspect", "--source", "wh"]);
    const files = await runQueries(t.root, t.dir, plan);
    const results = Object.fromEntries([...files].map(([id, f]) => [id, JSON.parse(readFileSync(f, "utf8"))]));
    const file = join(t.dir, "results.json");
    writeFileSync(file, JSON.stringify(results));
    const fromFile = await sl(t.root, ["introspect", "--source", "wh", "--results", file, "--json"]);
    expect(fromFile.code).toBe(0);
    expect(fromFile.err).toBe("");
    const snapshot = readFileSync(join(t.root, "snapshots", "wh.json"), "utf8");
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    expect(readFileSync(join(t.root, "snapshots", "wh.json"), "utf8")).toBe(snapshot);
  });
});

describe("other commands finish from a plan", () => {
  test("check-join and goldens run", async () => {
    const t = await setup();
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    writeYaml(join(t.root, "models", "wh", "orders.yaml"), {
      model: "orders",
      source: "wh",
      table: "main.orders",
      status: "approved",
      approved_by: "Test Owner",
      approved_at: "2026-01-15",
      primary_key: ["order_id"],
      dimensions: [{ name: "status", expr: "status", type: "string", status: "approved", approved_by: "Test Owner", approved_at: "2026-01-15" }],
      measures: [{ name: "orders", agg: "count", description: "Orders.", status: "approved", approved_by: "Test Owner", approved_at: "2026-01-15" }],
      joins: [{ name: "customer", to: "customers", keys: [{ from: "customer_id", to: "customer_id" }], relationship: "many_to_one", status: "draft" }],
    });
    writeYaml(join(t.root, "models", "wh", "customers.yaml"), {
      model: "customers",
      source: "wh",
      table: "main.customers",
      status: "draft",
      primary_key: ["customer_id"],
      dimensions: [],
      measures: [],
    });
    const joinPlan = await emit(t.root, ["check-join", "--source", "wh", "--all", "--no-write"]);
    expect(joinPlan.queries.map((q) => [q.id, q.max_rows])).toEqual([["join:orders.customer", 2]]);
    await addAll(t.root, joinPlan, await runQueries(t.root, t.dir, joinPlan));
    const joinStatus = await sl(t.root, ["results", "status", "--plan", joinPlan.plan_id, "--json"]);
    expect(joinStatus.json<StatusJson>().finish).toBe(`sl check-join --source wh --all --no-write --plan ${joinPlan.plan_id}`);
    const fromPlan = await sl(t.root, ["check-join", "--source", "wh", "--all", "--no-write", "--plan", joinPlan.plan_id, "--json"]);
    expect(fromPlan.code).toBe(0);
    const live = await sl(t.root, ["check-join", "--source", "wh", "--all", "--no-write", "--json"]);
    expect(fromPlan.json()).toEqual(live.json());

    writeYaml(join(t.root, "goldens", "orders_by_status.yaml"), {
      name: "orders_by_status",
      question: "How many orders are there per status?",
      request: { source: "wh", measures: ["orders.orders"], dimensions: ["orders.status"], order_by: [{ field: "orders.status" }] },
      sql: "select status, count(*) as orders from main.orders group by status order by status",
      status: "draft",
    });
    const goldenPlan = await emit(t.root, ["goldens", "run", "--name", "orders_by_status"]);
    // The request compiled from the YAML, and the golden's cross_check_sql (written under its older name sql).
    expect(goldenPlan.queries.map((q) => [q.id, q.max_rows])).toEqual([
      ["golden:orders_by_status", 10_000],
      ["golden:orders_by_status:cross_check", 10_000],
    ]);
    await addAll(t.root, goldenPlan, await runQueries(t.root, t.dir, goldenPlan));
    const run = await sl(t.root, ["goldens", "run", "--name", "orders_by_status", "--plan", goldenPlan.plan_id, "--json"]);
    expect(run.code).toBe(0);
    expect(run.json<{ rows: unknown[] }>().rows).toEqual([
      { status: "cancelled", orders: 15 },
      { status: "paid", orders: 45 },
    ]);

    const golden = readYaml<Record<string, unknown>>(join(t.root, "goldens", "orders_by_status.yaml"));
    writeYaml(join(t.root, "goldens", "orders_by_status.yaml"), {
      ...golden,
      expected: { tolerance: 0, rows: [{ status: "cancelled", orders: 15 }, { status: "paid", orders: 45 }] },
      status: "approved",
      confirmed_by: "Test Owner",
      confirmed_at: "2026-01-15",
    });
    const checkPlan = await emit(t.root, ["goldens", "check", "--source", "wh"]);
    expect(checkPlan.queries.map((q) => q.id)).toEqual(["golden:orders_by_status", "golden:orders_by_status:cross_check"]);
    // The same query as goldens run's plan: the same plan, whose results are stored already.
    expect(checkPlan.plan_id).toBe(goldenPlan.plan_id);
    const status = await sl(t.root, ["results", "status", "--plan", checkPlan.plan_id, "--json"]);
    expect(status.json<StatusJson>().next).toBe(`Next: sl goldens check --source wh --plan ${checkPlan.plan_id}`);
    const check = await sl(t.root, ["goldens", "check", "--source", "wh", "--plan", checkPlan.plan_id, "--json"]);
    expect(check.json()).toEqual({ passed: 1, failed: 0, results: [{ name: "orders_by_status", ok: true, diffs: [], compiled: "pass", cross_check: "pass" }] });
  });
});

describe("protected values", () => {
  test("a profile plan reads protected text only through counts and a protected date through counts, min and max", async () => {
    const t = await setup();
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    // email is protected by its name; segment is tagged pii in a model.
    writeYaml(join(t.root, "models", "wh", "customers.yaml"), {
      model: "customers",
      source: "wh",
      table: "main.customers",
      status: "draft",
      dimensions: [{ name: "segment", expr: "segment", type: "string", status: "draft", tags: ["pii"] }],
      measures: [],
    });
    const plan = await emit(t.root, ["profile", "--source", "wh", "--tables", "customers"]);
    expect(plan.queries.map((q) => q.id)).toEqual(["stats:main.customers"]);
    for (const q of plan.queries) {
      for (const column of ["email", "segment"]) {
        // The column appears, and only inside count(...) or count(distinct ...).
        const counted = new RegExp(`count\\((distinct )?"?${column}"?\\)`, "g");
        expect(q.sql).toMatch(counted);
        expect(q.sql.replace(counted, "")).not.toMatch(new RegExp(`\\b${column}\\b`));
      }
      // birth_date is protected by its name; a date keeps its min and max, as the snapshot does.
      const aggregated = /(count\((distinct )?|min\(|max\()"?birth_date"?\)/g;
      expect(q.sql).toMatch(/min\("?birth_date"?\)/);
      expect(q.sql.replace(aggregated, "")).not.toMatch(/\bbirth_date\b/);
    }
    await addAll(t.root, plan, await runQueries(t.root, t.dir, plan));
    for (const f of filesUnder(join(t.root, ".sl", "plans"))) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toContain("@example.test");
      expect(text).not.toContain("enterprise");
    }
  });

  test("a golden result with a protected column is refused and not stored; no file under .sl/plans holds one", async () => {
    const t = await setup();
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    const golden = (name: string, sql: string) =>
      writeYaml(join(t.root, "goldens", `${name}.yaml`), {
        name,
        question: `Synthetic golden ${name}`,
        request: { source: "wh", measures: [], dimensions: [] },
        sql,
        status: "draft",
      });
    golden("emails", "select customer_id, email from main.customers order by customer_id limit 3");
    const plan = await emit(t.root, ["goldens", "run", "--name", "emails"]);
    const files = await runQueries(t.root, t.dir, plan);
    // The request names nothing to compile, so the plan runs the golden's cross_check_sql alone.
    const refused = await sl(t.root, ["results", "add", "--plan", plan.plan_id, "--query", "golden:emails:cross_check", "--file", files.get("golden:emails:cross_check")!]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('The result of "golden:emails:cross_check" has protected column email');
    expect(refused.err).toContain("sl goldens run --name emails --results <file>");
    expect(existsSync(join(t.root, ".sl", "plans", plan.plan_id))).toBe(false);

    golden("segments", "select segment, count(*) as customers from main.customers group by segment order by segment");
    const ok = await emit(t.root, ["goldens", "run", "--name", "segments"]);
    await addAll(t.root, ok, await runQueries(t.root, t.dir, ok));
    expect((await sl(t.root, ["goldens", "run", "--name", "segments", "--plan", ok.plan_id])).code).toBe(0);
    const stored = filesUnder(join(t.root, ".sl", "plans"));
    expect(stored.some((f) => f.includes(`${ok.plan_id}/results/`))).toBe(true);
    for (const f of stored) expect(readFileSync(f, "utf8")).not.toContain("@example.test");
  });
});

describe(".sl/plans is gitignored", () => {
  test("sl init writes a .gitignore naming it, and emitting writes one inside it", async () => {
    const t = await setup();
    expect(readFileSync(join(t.root, ".gitignore"), "utf8").split("\n")).toContain(".sl/plans/");
    await emit(t.root, ["introspect", "--source", "wh"]);
    expect(readFileSync(join(t.root, ".sl", "plans", ".gitignore"), "utf8")).toBe("*\n");
  });

  test("sl init appends to a .gitignore that exists, once", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(t.root, { recursive: true });
    writeFileSync(join(t.root, ".gitignore"), "# mine\n*.tmp");
    await initProject(t.root);
    // sl init also names the lock a writing command holds (tests/lock.test.ts).
    expect(readFileSync(join(t.root, ".gitignore"), "utf8")).toBe("# mine\n*.tmp\n.sl/plans/\n.sl/lock\n");
  });

  test("the example layer ignores it", () => {
    const example = join(import.meta.dir, "..", "examples", "acme", "semantic");
    expect(readFileSync(join(example, ".gitignore"), "utf8").split("\n")).toContain(".sl/plans/");
    expect(readYaml<{ name: string }>(join(example, "semantic.yaml")).name).toBeTruthy();
  });
});

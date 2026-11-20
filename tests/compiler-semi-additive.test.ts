// Semi-additive measures (spec: Metric semantics, Semi-additive measures): a measure with
// non_additive_dimension keeps each account's last (or first) balance in each period along a time
// dimension and is not added up across time, on DuckDB and on PostgreSQL; its filter and segments
// and the user's row filters narrow the rows before one is kept; a Sunday-week source keeps its own
// weeks; a ratio of two balances compiles through each part; mixing with an additive measure is
// refused with its code; validation, the approval hash and the readback cover the key. Every value
// is synthetic (fixtures/semantics/balances.sql), each expected number counted by hand there.
import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { integrity, itemApprovals } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { projectApprovals } from "../skills/semantic-layer/scripts/lib/approvals.ts";
import { type Compiled, type CompileResult, compileRequest, type Refused } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import type { QueryRequest } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, assertLocalPg, duckdbSource, initProject, PG_URL, semlayer, tempDir, tempRoot, uniqueSchema } from "./helpers.ts";

type Row = Record<string, unknown>;
type Obj = Record<string, unknown>;
const REPO = join(import.meta.dir, "..");
const ACME = join(REPO, "examples", "acme", "semantic");
const FIXTURE = readFileSync(join(REPO, "fixtures", "semantics", "balances.sql"), "utf8");

// The fixture's statements, comments left out, with the table renamed for a schema.
function balanceStatements(table = "balances"): string[] {
  return FIXTURE.split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\bbalances\b/, table));
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function compiled(r: CompileResult): Compiled {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}
function refused(r: CompileResult): Refused {
  if (r.ok) throw new Error(`compiled: ${r.sql}`);
  return r;
}

const ok = { status: "approved", approved_by: "Test Owner", approved_at: "2026-01-01" };
const LAST = { name: "snapshot_date", window: "last" };

function balancesModel(table: string, edit: (m: Obj) => void = () => {}): Obj {
  const m: Obj = {
    model: "balances",
    source: "bank",
    table,
    grain: "One row per account per day its balance was read.",
    primary_key: ["account_id", "snapshot_date"],
    ...ok,
    default_time_dimension: "snapshot_date",
    segments: [{ name: "savings", filter: "account_type = 'savings'", description: "Savings accounts." }],
    dimensions: [
      { name: "account_id", expr: "account_id", type: "number", ...ok },
      { name: "snapshot_date", expr: "snapshot_date", type: "time", time_grains: ["day", "week", "month"], description: "The day the balance was read.", ...ok },
      { name: "account_type", expr: "account_type", type: "string", ...ok },
    ],
    measures: [
      { name: "closing_balance", expr: "balance", agg: "sum", non_additive_dimension: LAST, description: "Balance at the end of the period.", ...ok },
      { name: "opening_balance", expr: "balance", agg: "sum", non_additive_dimension: { name: "snapshot_date", window: "first" }, description: "Balance at the start of the period.", ...ok },
      { name: "largest_balance", expr: "balance", agg: "max", non_additive_dimension: LAST, description: "The largest closing balance of one account.", ...ok },
      { name: "balance_rows", expr: "balance", agg: "sum", description: "Every row's balance added up.", ...ok },
      { name: "capped_savings", expr: "balance", agg: "sum", filter: "balance < 1260", segments: ["savings"], non_additive_dimension: LAST, description: "Savings balances under 1260.", ...ok },
      { name: "reading_count", agg: "count", description: "Balance readings.", ...ok },
    ],
  };
  edit(m);
  return m;
}
const METRICS = {
  metrics: [
    { name: "largest_share", source: "bank", type: "ratio", numerator: "balances.largest_balance", denominator: "balances.closing_balance", description: "The largest account's share of the closing balance.", ...ok },
    { name: "balance_per_reading", source: "bank", type: "ratio", numerator: "balances.closing_balance", denominator: "balances.reading_count", description: "Closing balance per reading.", ...ok },
  ],
};

async function duck(edit?: (m: Obj) => void, week?: string): Promise<{ root: string; dir: string; file: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "bank", balanceStatements());
  if (week) writeYaml(join(t.root, "sources", "bank.yaml"), { ...src, calendar: { week_start: week } });
  writeYaml(join(t.root, "models", "bank", "balances.yaml"), balancesModel("main.balances", edit));
  writeYaml(join(t.root, "metrics.yaml"), METRICS);
  return { root: t.root, dir: t.dir, file: src.connection!.database! };
}

async function runDuck(file: string, sql: string, params: unknown[] = []): Promise<Row[]> {
  const instance = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const cx = await instance.connect();
  try {
    await cx.run("SET TimeZone='UTC'");
    const p = await cx.prepare(sql);
    if (params.length) p.bind(params as DuckDBValue[]);
    return (await p.runAndReadAll()).getRowObjectsJson() as Row[];
  } finally {
    cx.closeSync();
    instance.closeSync();
  }
}

// The compiled query's rows with a first time column as text and every figure a number, so both
// dialects and hand-written SQL compare.
const asText = (c: Compiled) =>
  `select ${c.columns.map((x) => (x.kind === "dimension" ? `cast(${x.name} as text) as ${x.name}` : `cast(${x.name} as double precision) as ${x.name}`)).join(", ")} from (${c.sql}) q order by 1`;
const plain = (rows: Row[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) || typeof v === "number" ? Math.round(Number(v) * 10000) / 10000 : v])));
const req = (r: Partial<QueryRequest>): QueryRequest => ({ source: "bank", ...r }) as QueryRequest;
const byMonth = (measures: string[], extra: Partial<QueryRequest> = {}) => req({ measures, dimensions: ["balances.snapshot_date:month"], order_by: [{ field: "balances.snapshot_date:month" }], ...extra });

const LAST_BY_MONTH = [
  { snapshot_date_month: "2024-01-01", closing_balance: 1220 },
  { snapshot_date_month: "2024-02-01", closing_balance: 1500 },
];
const FIRST_BY_MONTH = [
  { snapshot_date_month: "2024-01-01", opening_balance: 1100 },
  { snapshot_date_month: "2024-02-01", opening_balance: 1180 },
];
const SUM_BY_MONTH = [
  { snapshot_date_month: "2024-01-01", balance_rows: 2470 },
  { snapshot_date_month: "2024-02-01", balance_rows: 5460 },
];
// Hand-written: the last row of each account in each month, then their sum.
const HAND_LAST = (table: string) =>
  `select cast(month as text) as snapshot_date_month, cast(sum(balance) as double precision) as closing_balance from (
     select account_id, cast(date_trunc('month', snapshot_date) as date) as month, balance,
            row_number() over (partition by account_id, date_trunc('month', snapshot_date) order by snapshot_date desc) as n
     from ${table}) t where n = 1 group by 1 order by 1`;
const HAND_SHARE = (table: string) =>
  `select cast(month as text) as snapshot_date_month, cast(max(balance) as double precision) / sum(balance) as largest_share from (
     select account_id, cast(date_trunc('month', snapshot_date) as date) as month, balance,
            row_number() over (partition by account_id, date_trunc('month', snapshot_date) order by snapshot_date desc) as n
     from ${table}) t where n = 1 group by 1 order by 1`;

describe("a semi-additive measure", () => {
  test("by month keeps each account's last balance, which differs from the sum of the days; no time dimension gives the latest", async () => {
    const { root, file } = await duck();
    const c = compiled(compileRequest(root, byMonth(["balances.closing_balance"])));
    expect(c.sql).toBe(
      [
        "select",
        `  "semi additive"."group_1" as "snapshot_date_month",`,
        `  sum("semi additive"."value_1") as "closing_balance"`,
        "from (",
        "  select distinct on (account_id, cast(date_trunc('month', snapshot_date) as date))",
        `    cast(date_trunc('month', snapshot_date) as date) as "group_1",`,
        `    balance as "value_1"`,
        `  from "main"."balances"`,
        "  order by account_id, cast(date_trunc('month', snapshot_date) as date), snapshot_date desc nulls last",
        `) as "semi additive"`,
        "group by 1",
        "order by 1 asc nulls last",
      ].join("\n"),
    );
    expect(plain(await runDuck(file, asText(c)))).toEqual(LAST_BY_MONTH);
    expect(plain(await runDuck(file, HAND_LAST("balances")))).toEqual(LAST_BY_MONTH);
    expect(plain(await runDuck(file, asText(compiled(compileRequest(root, byMonth(["balances.balance_rows"]))))))).toEqual(SUM_BY_MONTH);
    const latest = compiled(compileRequest(root, req({ measures: ["balances.closing_balance"] })));
    expect(plain(await runDuck(file, latest.sql))).toEqual([{ closing_balance: 1500 }]);
    // A bare :month reads the default time dimension and compiles the same.
    expect(compiled(compileRequest(root, req({ measures: ["balances.closing_balance"], dimensions: [":month"], order_by: [{ field: ":month" }] }))).sql).toBe(c.sql);
  });

  test("first returns the opening value, by month and overall", async () => {
    const { root, file } = await duck();
    const c = compiled(compileRequest(root, byMonth(["balances.opening_balance"])));
    expect(c.sql).toContain("snapshot_date asc nulls last");
    expect(plain(await runDuck(file, asText(c)))).toEqual(FIRST_BY_MONTH);
    expect(plain(await runDuck(file, compiled(compileRequest(root, req({ measures: ["balances.opening_balance"] }))).sql))).toEqual([{ opening_balance: 1100 }]);
  });

  test("its filter and segments narrow the rows before the last one is kept", async () => {
    const { root, file } = await duck();
    const c = compiled(compileRequest(root, byMonth(["balances.capped_savings"])));
    expect(c.sql).toContain("  where ((balance < 1260) and (account_type = 'savings'))\n  order by");
    expect(c.sql).not.toContain("filter (where");
    expect(plain(await runDuck(file, asText(c)))).toEqual([
      { snapshot_date_month: "2024-01-01", capped_savings: 1100 },
      { snapshot_date_month: "2024-02-01", capped_savings: 1250 },
    ]);
  });

  test("a user's row filter applies inside, before a row is kept: they get the last balance of the rows they may see", async () => {
    const { root, file } = await duck();
    writeYaml(join(root, "access.yaml"), { ...ok, mode: "open", roles: [{ name: "midmonth", row_filters: [{ model: "bank.balances", expr: "snapshot_date <= date '2024-02-15'" }] }] });
    const c = compiled(compileRequest(root, byMonth(["balances.closing_balance"], { filters: [{ field: "balances.account_type", op: "neq", value: "loan" }] }), { role: "midmonth" }));
    expect(c.sql).toContain("  where (snapshot_date <= date '2024-02-15')\n    and (account_type) <> $1\n  order by");
    expect(c.row_filters.map((r) => [r.model, r.in])).toEqual([["balances", "where"]]);
    expect(plain(await runDuck(file, asText(c).replace("$1", "'loan'")))).toEqual([
      { snapshot_date_month: "2024-01-01", closing_balance: 1220 },
      { snapshot_date_month: "2024-02-01", closing_balance: 1410 },
    ]);
  });

  test("a Sunday-week source keeps each account's last balance of its own weeks", async () => {
    const weeks = async (week: string | undefined) => {
      const { root, file } = await duck(undefined, week);
      const c = compiled(compileRequest(root, req({ measures: ["balances.closing_balance"], dimensions: ["balances.snapshot_date:week"], order_by: [{ field: "balances.snapshot_date:week" }] })));
      return plain(await runDuck(file, asText(c))).map((r) => [r.snapshot_date_week, r.closing_balance]);
    };
    expect(await weeks("sunday")).toEqual([
      ["2023-12-31", 1100],
      ["2024-01-14", 1250],
      ["2024-01-28", 1180],
      ["2024-02-04", 1370],
      ["2024-02-11", 1410],
      ["2024-02-25", 1500],
    ]);
    expect(await weeks(undefined)).toEqual([
      ["2024-01-01", 1100],
      ["2024-01-15", 1250],
      ["2024-01-29", 1180],
      ["2024-02-05", 1410],
      ["2024-02-26", 1500],
    ]);
  });

  test("grouped by another dimension it keeps each account's latest row in each group", async () => {
    const { root, file } = await duck();
    const c = compiled(compileRequest(root, req({ measures: ["balances.closing_balance", "balances.largest_balance"], dimensions: ["balances.account_type"], order_by: [{ field: "balances.account_type" }] })));
    expect(plain(await runDuck(file, c.sql))).toEqual([
      { account_type: "checking", closing_balance: 200, largest_balance: 200 },
      { account_type: "savings", closing_balance: 1300, largest_balance: 1300 },
    ]);
  });

  test("a ratio of two balances compiles through each part and equals hand-written SQL", async () => {
    const { root, file } = await duck();
    const c = compiled(compileRequest(root, byMonth(["largest_share"])));
    expect(c.sql).toContain("select distinct on (account_id, cast(date_trunc('month', snapshot_date) as date))");
    const want = [
      { snapshot_date_month: "2024-01-01", largest_share: Math.round((1100 / 1220) * 10000) / 10000 },
      { snapshot_date_month: "2024-02-01", largest_share: Math.round((1300 / 1500) * 10000) / 10000 },
    ];
    expect(plain(await runDuck(file, asText(c)))).toEqual(want);
    expect(plain(await runDuck(file, HAND_SHARE("balances")))).toEqual(want);
  });

  test("mixed with an additive measure, in a request or a metric's part, is refused with metric.semi_additive_mixed and the next step", async () => {
    const { root } = await duck();
    for (const r of [
      refused(compileRequest(root, byMonth(["balances.closing_balance", "balances.balance_rows"]))),
      refused(compileRequest(root, byMonth(["balances.closing_balance", "balances.opening_balance"]))),
      refused(compileRequest(root, byMonth(["balance_per_reading"]))),
      refused(compileRequest(root, byMonth(["balances.closing_balance"], { filters: [{ field: "balances.reading_count", op: "gt", value: 1 }] }))),
    ]) {
      expect(r.refusals.map((x) => x.code)).toEqual(["metric.semi_additive_mixed"]);
      expect(r.refusals[0]!.next).toContain("in a request of its own");
      expect(r.refusals[0]!.next).toContain("run semlayer sql again");
    }
    const r = refused(compileRequest(root, byMonth(["balances.closing_balance", "balances.balance_rows"])));
    expect(r.refusals[0]!.message).toBe(
      "balances.closing_balance is not added up across balances.snapshot_date (it keeps the last value in each period), and balances.balance_rows adds up across time, so one query cannot compute both",
    );
    // Two balances that share the dimension, window and filter compile together.
    expect(compileRequest(root, byMonth(["balances.closing_balance", "balances.largest_balance"])).ok).toBe(true);
  });

  test.skipIf(!PG_URL)("gives the same last and first balances on PostgreSQL, with the hand-written SQL", async () => {
    assertLocalPg(PG_URL);
    const schema = uniqueSchema("c3_bal");
    const db = new SQL({ url: PG_URL!, max: 1 });
    const t = tempRoot();
    cleanup = t.cleanup;
    try {
      await db.unsafe(`create schema "${schema}"`);
      for (const s of balanceStatements(`"${schema}".balances`)) await db.unsafe(s);
      await initProject(t.root);
      writeYaml(join(t.root, "sources", "bank.yaml"), { source: "bank", dialect: "postgres", connection: { env: "PG_URL" } });
      writeYaml(join(t.root, "models", "bank", "balances.yaml"), balancesModel(`${schema}.balances`));
      writeYaml(join(t.root, "metrics.yaml"), METRICS);
      const run = async (sql: string) =>
        plain(
          await db.begin("read only", async (tx) => {
            await tx.unsafe("set local time zone 'UTC'");
            return [...((await tx.unsafe(sql)) as Row[])];
          }),
        );
      expect(await run(asText(compiled(compileRequest(t.root, byMonth(["balances.closing_balance"])))))).toEqual(LAST_BY_MONTH);
      expect(await run(HAND_LAST(`"${schema}".balances`))).toEqual(LAST_BY_MONTH);
      expect(await run(asText(compiled(compileRequest(t.root, byMonth(["balances.balance_rows"])))))).toEqual(SUM_BY_MONTH);
      expect(await run(compiled(compileRequest(t.root, req({ measures: ["balances.closing_balance"] }))).sql)).toEqual([{ closing_balance: 1500 }]);
      expect(await run(asText(compiled(compileRequest(t.root, byMonth(["balances.opening_balance"])))))).toEqual(FIRST_BY_MONTH);
      expect(await run(compiled(compileRequest(t.root, req({ measures: ["balances.opening_balance"] }))).sql)).toEqual([{ opening_balance: 1100 }]);
      expect(await run(asText(compiled(compileRequest(t.root, byMonth(["balances.capped_savings"])))))).toEqual([
        { snapshot_date_month: "2024-01-01", capped_savings: 1100 },
        { snapshot_date_month: "2024-02-01", capped_savings: 1250 },
      ]);
      const share = await run(asText(compiled(compileRequest(t.root, byMonth(["largest_share"])))));
      expect(share).toEqual(await run(HAND_SHARE(`"${schema}".balances`)));
      expect(share.map((r) => r.largest_share)).toEqual([0.9016, 0.8667]);
    } finally {
      await db.unsafe(`drop schema if exists "${schema}" cascade`);
      await db.close();
    }
  });
});

describe("validation", () => {
  test("each wrong non_additive_dimension gives its code", async () => {
    const { root } = await duck((m) => {
      const ms = m.measures as Obj[];
      ms[0]!.non_additive_dimension = { name: "gone", window: "last" };
      ms[1]!.non_additive_dimension = { name: "account_type", window: "first" };
      ms[3]!.non_additive_dimension = LAST;
      ms[3]!.agg = "count_distinct";
    });
    const codes = validateProject(root)
      .filter((i) => i.code?.startsWith("metric.non_additive"))
      .map((i) => [i.path, i.code]);
    expect(codes).toEqual([
      ["measures[0].non_additive_dimension.name", "metric.non_additive_dimension_unknown"],
      ["measures[1].non_additive_dimension.name", "metric.non_additive_dimension_not_time"],
      ["measures[3].agg", "metric.non_additive_agg"],
    ]);
    const { root: nokey } = await duck((m) => {
      m.primary_key = ["account_id"];
    });
    expect(validateProject(nokey).filter((i) => i.code?.startsWith("metric.non_additive")).map((i) => [i.path, i.code])).toEqual(
      ["measures[0]", "measures[1]", "measures[2]", "measures[4]"].map((p) => [`${p}.non_additive_dimension.name`, "metric.non_additive_dimension_not_key"]),
    );
    const { root: quoted } = await duck((m) => {
      m.primary_key = ["account_id", '"snapshot_date"'];
    });
    expect(validateProject(quoted).filter((i) => i.code === "metric.non_additive_dimension_not_key")).toEqual([]);
    const { root: none } = await duck((m) => {
      delete m.primary_key;
      m.status = "draft";
    });
    expect(validateProject(none).filter((i) => i.code?.startsWith("metric.non_additive")).map((i) => i.code)).toEqual(Array(4).fill("metric.non_additive_no_primary_key"));
    const { root: shape } = await duck((m) => {
      (m.measures as Obj[])[0]!.non_additive_dimension = { name: "snapshot_date", window: "latest" };
    });
    expect(validateProject(shape).some((i) => i.level === "error" && i.path.startsWith("measures[0].non_additive_dimension"))).toBe(true);
    expect(validateProject((await duck()).root).filter((i) => i.level === "error")).toEqual([]);
  });
});

const hashes = (root: string) => new Map(itemApprovals(projectApprovals(root, false)).map((e) => [e.ref, e.hash]));

describe("approval hash and readback", () => {
  test("examples/acme and the demo keep every recorded hash", async () => {
    const dir = tempDir("c3-acme");
    const root = join(dir, "semantic");
    cpSync(ACME, root, { recursive: true });
    const recorded = itemApprovals(projectApprovals(root, false)).filter((e) => e.recorded_hash !== undefined);
    expect(recorded.length).toBeGreaterThan(20);
    expect(recorded.filter((e) => integrity(e, true) !== "current").map((e) => e.ref)).toEqual([]);
    const demo = tempDir("c3-demo");
    expect((await semlayer(demo, ["demo", "--dir", join(demo, "d")])).code).toBe(0);
    const demoRoot = join(demo, "d", "semantic");
    expect(itemApprovals(projectApprovals(demoRoot, false)).filter((e) => e.recorded_hash !== undefined && integrity(e, true) !== "current").map((e) => e.ref)).toEqual([]);
  });

  test("setting or changing non_additive_dimension marks that measure changed, and only it", async () => {
    const { root } = await duck((m) => delete (m.measures as Obj[])[3]!.non_additive_dimension);
    const file = join(root, "models", "bank", "balances.yaml");
    const before = hashes(root);
    const m = readYaml<Obj>(file);
    (m.measures as Obj[])[0]!.non_additive_dimension = { name: "snapshot_date", window: "first" };
    writeYaml(file, m);
    expect([...hashes(root)].filter(([r, h]) => before.get(r) !== h).map(([r]) => r)).toEqual(["bank.balances.closing_balance"]);
    delete (m.measures as Obj[])[0]!.non_additive_dimension;
    writeYaml(file, m);
    expect([...hashes(root)].filter(([r, h]) => before.get(r) !== h).map(([r]) => r)).toEqual(["bank.balances.closing_balance"]);
  });

  test("the readback says it is the last value along the dimension, not added up, keeps the filter list, and its figure is the last-value figure", async () => {
    const { root } = await duck((m) => {
      for (const item of [m, ...(m.dimensions as Obj[]), ...(m.measures as Obj[])]) {
        item.status = "draft";
        delete item.approved_by;
        delete item.approved_at;
      }
    });
    expect((await semlayer(root, ["introspect", "--source", "bank"])).code).toBe(0);
    const rb = await semlayer(root, ["readback", "--targets", "bank.balances.closing_balance,bank.balances.capped_savings,bank.balances.opening_balance,bank.balances.balance_rows", "--json"]);
    expect(rb.code).toBe(0);
    const [closing, capped, opening, rows] = rb.json<{ items: { text: string }[] }>().items.map((i) => i.text);
    expect(closing).toContain(
      "- Not added up across time: in each period it keeps the last value along balances.snapshot_date for each account_id (the latest one when no period is asked for), then adds those up.",
    );
    expect(closing).toContain("- On today's data it comes to 1,500, over the 2 rows it counts, before any role's row filter.");
    expect(opening).toContain("keeps the first value along balances.snapshot_date for each account_id (the earliest one when no period is asked for)");
    expect(opening).toContain("- On today's data it comes to 1,100, over the 2 rows it counts");
    expect(capped).toContain("- It counts only rows where:\n  1. balance is below 1260\n  2. account_type equals 'savings' (segment savings)");
    expect(capped).toContain("keeps the last value along balances.snapshot_date");
    expect(capped).toContain("- On today's data it comes to 1,250, over the 1 row it counts");
    expect(closing).toContain("  sum(balance) over the rows of distinct on (account_id, <period>) order by snapshot_date desc");
    expect(rows).not.toContain("Not added up");
    expect(rows).toContain("- On today's data it comes to 7,930, over the 13 rows it counts");
  });

  test("once approved, validate, status and the edit hook agree; changing the window sends it back", async () => {
    const { root, dir } = await duck((m) => {
      const c = (m.measures as Obj[])[0]!;
      c.status = "draft";
      delete c.approved_by;
      delete c.approved_at;
    });
    const r = await approveWithYes(root, ["--target", "bank.balances.closing_balance", "--by", "Test Owner"]);
    expect(r.code).toBe(0);
    const file = join(root, "models", "bank", "balances.yaml");
    const recorded = String((readYaml<Obj>(file).measures as Obj[])[0]!.approved_hash);
    expect(validateProject(root).filter((i) => i.level === "error")).toEqual([]);
    expect((await semlayer(root, ["status", "--json"])).json<{ changed_since_approval: string[] }>().changed_since_approval).toEqual([]);
    const entry = itemApprovals(projectApprovals(root, false)).find((e) => e.ref === "bank.balances.closing_balance")!;
    expect([entry.hash, integrity(entry, true)]).toEqual([recorded, "current"]);
    const good = readFileSync(file, "utf8");
    const changed = good.replace("window: last", "window: first");
    expect(changed).not.toBe(good);
    const denied = checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file, content: changed }, cwd: dir }));
    expect(denied.allow).toBe(false);
    const same = checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file, content: good }, cwd: dir }));
    expect(same.allow).toBe(true);
    writeFileSync(file, changed);
    expect(validateProject(root).filter((i) => i.code === "approval.hash_changed").map((i) => i.path)).toEqual(["measures[0]"]);
    expect((await semlayer(root, ["status", "--json"])).json<{ changed_since_approval: string[] }>().changed_since_approval).toEqual(["bank.balances.closing_balance"]);
  });
});

describe("a rename follows non_additive_dimension", () => {
  test("renaming the time dimension rewrites the measures' non_additive_dimension.name, so validate stays clean and comments stay", async () => {
    // The model's default_time_dimension names the same dimension and is rewritten with it.
    // Each measure gets its own copy of the key, so the file holds no YAML alias.
    const { root } = await duck((m) => {
      m.default_time_dimension = "snapshot_date";
      for (const x of m.measures as Obj[]) if (x.non_additive_dimension) x.non_additive_dimension = { ...(x.non_additive_dimension as Obj) };
    });
    const file = join(root, "models", "bank", "balances.yaml");
    writeFileSync(file, `# keep this note\n${readFileSync(file, "utf8")}`);
    const errors = () => validateProject(root).filter((i) => i.level === "error");
    expect(errors()).toEqual([]);
    const rn = await semlayer(root, ["rename", "bank.balances.snapshot_date", "read_on"]);
    expect(rn.err).toBe("");
    expect(rn.code).toBe(0);
    // The measures' hashes cover the key, so a rewritten key sends each back for approval, as the code does for any rewritten reference.
    expect(rn.out).toContain("bank.balances.closing_balance is approved and changed since its approval");
    expect(errors()).toEqual([]);
    const model = readYaml<{ default_time_dimension?: string; measures: { name: string; non_additive_dimension?: { name: string } }[] }>(file);
    expect(model.default_time_dimension).toBe("read_on");
    const names = model.measures.filter((m) => m.non_additive_dimension).map((m) => m.non_additive_dimension!.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n === "read_on")).toBe(true);
    expect(readFileSync(file, "utf8")).toStartWith("# keep this note\n");
  });
});

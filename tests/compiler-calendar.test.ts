// The calendar and the default time dimension (spec: Metric semantics, Calendar and default time
// dimension): a source's calendar.week_start moves where a week starts, on DuckDB and PostgreSQL and
// inside a metric's part; unset it compiles to the SQL of before; a measure's or model's
// default_time_dimension is what a bare :grain reads; both enter an approval hash only when set,
// so the hashes of examples/acme and of the demo stay as they were. All data is synthetic.
import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { integrity, itemApprovals } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { projectApprovals } from "../skills/semantic-layer/scripts/lib/approvals.ts";
import { weekStart } from "../skills/semantic-layer/scripts/lib/compiler/calendar.ts";
import { type Compiled, type CompileResult, compileRequest, type Refused } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import type { QueryRequest } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, assertLocalPg, duckdbSource, initProject, PG_URL, semlayer, tempDir, tempRoot, uniqueSchema } from "./helpers.ts";

type Row = Record<string, unknown>;
const REPO = join(import.meta.dir, "..");
const ACME = join(REPO, "examples", "acme", "semantic");

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

// Saturday 30 Dec 2023, Sunday 31 Dec, Monday 1 Jan 2024 and Wednesday 3 Jan; id 4 is big.
const ROWS = [
  [1, "2023-12-30", "2023-12-30 23:30:00", 10],
  [2, "2023-12-31", "2023-12-31 08:00:00", 20],
  [3, "2024-01-01", "2024-01-01 00:00:00", 30],
  [4, "2024-01-03", "2024-01-03 12:00:00", 400],
] as const;
const TABLE_SQL = (table: string) => [
  `create table ${table} (id integer, on_day date, ts timestamp, amount integer)`,
  `insert into ${table} values ${ROWS.map(([id, at, ts, amount]) => `(${id}, date '${at}', timestamp '${ts}', ${amount})`).join(", ")}`,
];

const ok = { status: "approved", approved_by: "Test Owner", approved_at: "2026-01-01" };
type Obj = Record<string, unknown>;

function eventsModel(table: string, edit: (m: Obj) => void = () => {}): Obj {
  const m: Obj = {
    model: "events",
    source: "cal",
    table,
    grain: "One row per event.",
    primary_key: ["id"],
    ...ok,
    default_time_dimension: "on_day",
    dimensions: [
      { name: "on_day", expr: "on_day", type: "time", time_grains: ["day", "week", "month"], description: "The event's day.", ...ok },
      { name: "ts", expr: "ts", type: "time", time_zone: "UTC", description: "When it happened, in UTC.", ...ok },
      { name: "size", expr: "case when amount >= 100 then 'big' else 'small' end", type: "string", ...ok },
    ],
    measures: [
      { name: "event_count", agg: "count", description: "Events.", ...ok },
      { name: "big_count", agg: "count", filter: "amount >= 100", description: "Big events.", ...ok },
      { name: "late_count", agg: "count", default_time_dimension: "ts", description: "Events, by when they happened.", ...ok },
    ],
  };
  edit(m);
  return m;
}
const METRICS = { metrics: [{ name: "big_share", source: "cal", type: "ratio", numerator: "events.big_count", denominator: "events.event_count", description: "Share of events that are big.", ...ok }] };

// A DuckDB project with the events table, its model and a ratio metric; `week` sets calendar.week_start.
async function duck(week?: string, edit?: (m: Obj) => void): Promise<{ root: string; dir: string; file: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "cal", TABLE_SQL("events"));
  if (week) writeYaml(join(t.root, "sources", "cal.yaml"), { ...src, calendar: { week_start: week } });
  writeYaml(join(t.root, "models", "cal", "events.yaml"), eventsModel("main.events", edit));
  writeYaml(join(t.root, "metrics.yaml"), METRICS);
  return { root: t.root, dir: t.dir, file: src.connection!.database! };
}

async function runDuck(file: string, sql: string): Promise<Row[]> {
  const instance = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const cx = await instance.connect();
  try {
    await cx.run("SET TimeZone='UTC'");
    return (await cx.runAndReadAll(sql)).getRowObjectsJson() as Row[];
  } finally {
    cx.closeSync();
    instance.closeSync();
  }
}

// The compiled query's rows with its first column as text, so both dialects compare.
const asText = (c: Compiled) => `select cast(${c.columns[0]!.name} as text) as bucket, ${c.columns.slice(1).map((x) => `cast(${x.name} as double precision) as ${x.name}`).join(", ")} from (${c.sql}) q order by 1`;
const plain = (rows: Row[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])));
const req = (r: Partial<QueryRequest>): QueryRequest => ({ source: "cal", ...r }) as QueryRequest;
const byWeek = (dim = "events.on_day:week", measures = ["events.event_count"]) => req({ measures, dimensions: [dim], order_by: [{ field: dim }] });

const SUNDAY_WEEKS = [
  { bucket: "2023-12-24", event_count: 1 },
  { bucket: "2023-12-31", event_count: 3 },
];
const MONDAY_WEEKS = [
  { bucket: "2023-12-25", event_count: 2 },
  { bucket: "2024-01-01", event_count: 2 },
];

describe("calendar.week_start", () => {
  test("with sunday, 2024-01-03 buckets to 2023-12-31; unset, it stays 2024-01-01 on DuckDB, for a date and a timestamp", async () => {
    const sunday = await duck("sunday");
    for (const dim of ["events.on_day:week", "events.ts:week"]) {
      const c = compiled(compileRequest(sunday.root, byWeek(dim)));
      expect(c.sql).toContain(`- interval '1 day' as date)`);
      expect(plain(await runDuck(sunday.file, asText(c)))).toEqual(SUNDAY_WEEKS);
    }
    const unset = await duck();
    for (const dim of ["events.on_day:week", "events.ts:week"]) {
      const c = compiled(compileRequest(unset.root, byWeek(dim)));
      expect(plain(await runDuck(unset.file, asText(c)))).toEqual(MONDAY_WEEKS);
    }
  });

  test("unset, or monday, compiles to exactly the SQL of before; other grains never move", async () => {
    const unset = await duck();
    const c = compiled(compileRequest(unset.root, byWeek()));
    expect(c.sql).toBe(['select', `  cast(date_trunc('week', on_day) as date) as "on_day_week",`, `  count(*) as "event_count"`, `from "main"."events"`, "group by 1", "order by 1 asc nulls last"].join("\n"));
    const monday = await duck("monday");
    expect(compiled(compileRequest(monday.root, byWeek())).sql).toBe(c.sql);
    const sunday = await duck("sunday");
    const month = (root: string) => compiled(compileRequest(root, byWeek("events.on_day:month"))).sql;
    expect(month(sunday.root)).toBe(month(monday.root));
  });

  test("each day name shifts to the day before its week's Monday by the right amount", () => {
    expect(weekStart("x", "monday")).toBe("date_trunc('week', x)");
    expect(weekStart("x", "sunday")).toBe("date_trunc('week', (x) + interval '1 day') - interval '1 day'");
    expect(weekStart("x", "saturday")).toBe("date_trunc('week', (x) + interval '2 days') - interval '2 days'");
    expect(weekStart("x", "tuesday")).toBe("date_trunc('week', (x) + interval '6 days') - interval '6 days'");
  });

  test("applies inside a metric's part: a ratio grouped by week", async () => {
    const { root, file } = await duck("sunday");
    const c = compiled(compileRequest(root, byWeek("events.on_day:week", ["big_share"])));
    expect(c.sql).toContain("date_trunc('week', (on_day) + interval '1 day') - interval '1 day'");
    expect(plain(await runDuck(file, asText(c)))).toEqual([
      { bucket: "2023-12-24", big_share: 0 },
      { bucket: "2023-12-31", big_share: 1 / 3 },
    ]);
  });

  test.skipIf(!PG_URL)("gives the same weeks on PostgreSQL, unset and sunday, for a date and a timestamp", async () => {
    assertLocalPg(PG_URL);
    const schema = uniqueSchema("c2_cal");
    const db = new SQL({ url: PG_URL!, max: 1 });
    const t = tempRoot();
    cleanup = t.cleanup;
    try {
      await db.unsafe(`create schema "${schema}"`);
      for (const s of TABLE_SQL(`"${schema}".events`)) await db.unsafe(s);
      await initProject(t.root);
      writeYaml(join(t.root, "models", "cal", "events.yaml"), eventsModel(`${schema}.events`));
      writeYaml(join(t.root, "metrics.yaml"), METRICS);
      const run = async (sql: string) =>
        plain(
          await db.begin("read only", async (tx) => {
            await tx.unsafe("set local time zone 'UTC'");
            return [...((await tx.unsafe(sql)) as Row[])];
          }),
        );
      for (const [calendar, want] of [[undefined, MONDAY_WEEKS], [{ week_start: "sunday" }, SUNDAY_WEEKS]] as const) {
        writeYaml(join(t.root, "sources", "cal.yaml"), { source: "cal", dialect: "postgres", connection: { env: "PG_URL" }, ...(calendar ? { calendar } : {}) });
        for (const dim of ["events.on_day:week", "events.ts:week"]) expect(await run(asText(compiled(compileRequest(t.root, byWeek(dim)))))).toEqual(want);
      }
      const share = compiled(compileRequest(t.root, byWeek("events.on_day:week", ["big_share"])));
      expect(await run(asText(share))).toEqual([
        { bucket: "2023-12-24", big_share: 0 },
        { bucket: "2023-12-31", big_share: 1 / 3 },
      ]);
    } finally {
      await db.unsafe(`drop schema if exists "${schema}" cascade`);
      await db.close();
    }
  });

  test("accepts the seven day names and nothing else", async () => {
    const { root } = await duck("Sunday");
    const issues = validateProject(root).filter((i) => i.file === "sources/cal.yaml" && i.level === "error");
    expect(issues.map((i) => i.path)).toEqual(["calendar.week_start"]);
    for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) {
      writeYaml(join(root, "sources", "cal.yaml"), { ...readYaml<Obj>(join(root, "sources", "cal.yaml")), calendar: { week_start: day } });
      expect(validateProject(root).filter((i) => i.file === "sources/cal.yaml" && i.level === "error")).toEqual([]);
    }
  });
});

describe("default_time_dimension", () => {
  test("the readback of an item that names no default and has no week grain is the same text whatever the week start", async () => {
    const texts = async (week?: string) => {
      const { root } = await duck(week, (m) => delete m.default_time_dimension);
      const rb = await semlayer(root, ["readback", "--targets", "cal.events.size,cal.events.event_count,cal.events", "--json"]);
      expect(rb.code).toBe(0);
      return rb.json<{ items: { text: string }[] }>().items.map((i) => i.text);
    };
    const unset = await texts();
    expect(await texts("sunday")).toEqual(unset);
    expect(unset.join("\n")).not.toContain("by default");
  });

  test(":month reads the first measure's default, else its model's, and compiles as the field written in full", async () => {
    const { root } = await duck();
    const short = compiled(compileRequest(root, req({ measures: ["events.event_count"], dimensions: [":month"], order_by: [{ field: ":month" }] })));
    const full = compiled(compileRequest(root, req({ measures: ["events.event_count"], dimensions: ["events.on_day:month"], order_by: [{ field: "events.on_day:month" }] })));
    expect(short.sql).toBe(full.sql);
    expect(short.columns[0]).toEqual({ name: "on_day_month", ref: "events.on_day:month", kind: "dimension" });
    // The measure's own default comes first.
    const late = compiled(compileRequest(root, req({ measures: ["events.late_count"], dimensions: [":day"] })));
    expect(late.columns[0]!.ref).toBe("events.ts:day");
  });

  test(":month with no default is refused with metric.default_time_missing, saying how to set one", async () => {
    const { root } = await duck(undefined, (m) => delete m.default_time_dimension);
    const r = refused(compileRequest(root, req({ measures: ["events.event_count"], dimensions: [":month"] })));
    expect(r.refusals.map((x) => [x.code, x.ref, x.message])).toEqual([
      ["metric.default_time_missing", ":month", "the request names :month, but neither events.event_count nor model events names a default_time_dimension"],
    ]);
    expect(r.refusals[0]!.next).toBe(
      "Name the time dimension in full as model.<time dimension>:month, or semlayer set cal.events default_time_dimension <time dimension> (or on cal.events.event_count), read it back and approve it on the owner's yes, then run semlayer sql again.",
    );
    const metric = refused(compileRequest(root, req({ measures: ["big_share"], dimensions: [":month"] })));
    expect(metric.refusals.map((x) => x.code)).toEqual(["metric.default_time_missing"]);
    const cli = await semlayer(root, ["sql", "--source", "cal", "--request", JSON.stringify(req({ measures: ["events.event_count"], dimensions: [":week"] }))]);
    expect(cli.code).not.toBe(0);
    expect(cli.out + cli.err).toContain("semlayer set cal.events default_time_dimension");
  });

  test("a default that is not a time dimension, or no dimension, is a validation error with its code", async () => {
    const { root } = await duck(undefined, (m) => {
      m.default_time_dimension = "size";
      (m.measures as Obj[])[2]!.default_time_dimension = "gone";
    });
    const issues = validateProject(root).filter((i) => i.code?.startsWith("metric.default_time"));
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ["default_time_dimension", "metric.default_time_not_time"],
      ["measures[2].default_time_dimension", "metric.default_time_unknown"],
    ]);
    expect(issues[0]!.message).toContain("name one of its time dimensions (on_day, ts)");
  });
});

// Every item's current hash, by ref.
const hashes = (root: string) => new Map(itemApprovals(projectApprovals(root, false)).map((e) => [e.ref, e.hash]));

describe("approval hashes", () => {
  test("examples/acme and the demo keep every recorded hash, and an unset or monday calendar changes none", async () => {
    const dir = tempDir("c2-acme");
    const root = join(dir, "semantic");
    cpSync(ACME, root, { recursive: true });
    const entries = itemApprovals(projectApprovals(root, false));
    const recorded = entries.filter((e) => e.recorded_hash !== undefined);
    expect(recorded.length).toBeGreaterThan(20);
    expect(recorded.filter((e) => integrity(e, true) !== "current").map((e) => e.ref)).toEqual([]);
    expect(validateProject(root).filter((i) => i.code === "approval.hash_changed")).toEqual([]);
    const before = hashes(root);
    const file = join(root, "sources", "warehouse.yaml");
    const text = readFileSync(file, "utf8");
    for (const calendar of ["calendar: {}\n", "calendar:\n  week_start: monday\n"]) {
      writeFileSync(file, text + calendar);
      expect(hashes(root)).toEqual(before);
    }
    // Sunday changes the hash of each warehouse dimension with a week grain, and of nothing else.
    writeFileSync(file, `${text}calendar:\n  week_start: sunday\n`);
    const after = hashes(root);
    const moved = [...after].filter(([ref, h]) => before.get(ref) !== h).map(([ref]) => ref);
    const weekly = entries.filter((e) => e.kind === "dimension" && e.ref.startsWith("warehouse.") && e.item.type === "time" && (!Array.isArray(e.item.time_grains) || e.item.time_grains.includes("week")));
    expect(weekly.length).toBeGreaterThan(2);
    expect(moved.sort()).toEqual(weekly.map((e) => e.ref).sort());

    const demo = tempDir("c2-demo");
    expect((await semlayer(demo, ["demo", "--dir", join(demo, "d")])).code).toBe(0);
    const demoRoot = join(demo, "d", "semantic");
    expect(validateProject(demoRoot).filter((i) => i.code === "approval.hash_changed")).toEqual([]);
    const demoEntries = itemApprovals(projectApprovals(demoRoot, false));
    expect(demoEntries.filter((e) => e.recorded_hash !== undefined && integrity(e, true) !== "current").map((e) => e.ref)).toEqual([]);
  });

  test("setting or changing default_time_dimension after approval marks that item changed, and only it", async () => {
    const { root } = await duck(undefined, (m) => delete m.default_time_dimension);
    const before = hashes(root);
    const file = join(root, "models", "cal", "events.yaml");
    const m = readYaml<Obj>(file);
    writeYaml(file, { ...m, default_time_dimension: "on_day" });
    const model = hashes(root);
    expect([...model].filter(([r, h]) => before.get(r) !== h).map(([r]) => r)).toEqual(["cal.events"]);
    (m.measures as Obj[])[2]!.default_time_dimension = "on_day";
    writeYaml(file, m);
    expect([...hashes(root)].filter(([r, h]) => before.get(r) !== h).map(([r]) => r)).toEqual(["cal.events.late_count"]);
  });
});

describe("approving on a source whose weeks start on Sunday", () => {
  test("setup writes calendar.week_start; once approved, validate, status, readback and the edit hook agree; a new week start sends the dimension back", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const { file } = await duck();
    const db = join(t.dir, "cal.duckdb");
    cpSync(file, db);
    const setup = (week: string) => semlayer(t.root, ["setup", "--source", "cal", "--dialect", "duckdb", "--database", db, "--week-start", week]);
    expect((await setup("Sun")).err).toContain("--week-start names the day a week starts: one of monday, tuesday");
    const first = await setup("sunday");
    expect(first.code).toBe(0);
    const srcFile = join(t.root, "sources", "cal.yaml");
    expect(readYaml<Obj>(srcFile).calendar).toEqual({ week_start: "sunday" });
    // The owner's comment on the source survives the next setup.
    writeFileSync(srcFile, readFileSync(srcFile, "utf8").replace("week_start: sunday", "week_start: sunday # as finance counts weeks"));
    const draft = eventsModel("main.events", (m) => {
      for (const item of [m, ...(m.dimensions as Obj[]), ...(m.measures as Obj[])]) {
        item.status = "draft";
        delete item.approved_by;
        delete item.approved_at;
      }
    });
    writeYaml(join(t.root, "models", "cal", "events.yaml"), draft);
    const rb = await semlayer(t.root, ["readback", "--targets", "cal.events.on_day,cal.events.size,cal.events.late_count,cal.events", "--json"]);
    const text = rb.json<{ items: { target: string; text: string }[] }>().items.map((i) => i.text);
    expect(text[0]).toContain("- A week starts on Sunday (calendar.week_start of source cal).");
    expect(text[1]).not.toContain("A week starts");
    expect(text[2]).toContain("- Measured over events.ts by default.");
    expect(text[3]).toContain("- Its measures are measured over on_day by default, unless a measure names its own.");

    const r = await approveWithYes(t.root, ["--target", "cal.events.on_day", "--by", "Test Owner"]);
    expect(r.code).toBe(0);
    const recorded = String((readYaml<Obj>(join(t.root, "models", "cal", "events.yaml")).dimensions as Obj[])[0]!.approved_hash);
    expect(validateProject(t.root).filter((i) => i.level === "error")).toEqual([]);
    const status = await semlayer(t.root, ["status", "--json"]);
    expect(status.json<{ changed_since_approval: string[] }>().changed_since_approval).toEqual([]);
    const entry = itemApprovals(projectApprovals(t.root, false)).find((e) => e.ref === "cal.events.on_day")!;
    expect([entry.hash, integrity(entry, true)]).toEqual([recorded, "current"]);
    // The edit hook hashes it the same way: repairing the file to its approved text is allowed.
    const modelFile = join(t.root, "models", "cal", "events.yaml");
    const good = readFileSync(modelFile, "utf8");
    writeFileSync(modelFile, good.replace(/^grain: (.*)$/m, "<<<<<<< HEAD\ngrain: $1\n=======\ngrain: other\n>>>>>>> b"));
    const verdict = checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: modelFile, content: good }, cwd: t.dir }));
    expect(verdict.allow).toBe(true);
    writeFileSync(modelFile, good);
    // Changing what the owner approved is refused, so the hook's hash includes the week start.
    const changed = good.replace(/^(\s*- name: on_day\n\s*expr: ).*$/m, "$1ts");
    expect(changed).not.toBe(good);
    const denied = checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: modelFile, content: changed }, cwd: t.dir }));
    expect(denied.allow).toBe(false);

    // Saturday moves the approved week dimension back to changed, and nothing else.
    const again = await setup("saturday");
    expect(again.code).toBe(0);
    expect(again.out).toContain("calendar.week_start: saturday");
    expect(again.out).toContain("Weeks now start on saturday: each approved dimension of cal with a week grain changed");
    expect(readFileSync(srcFile, "utf8")).toContain("week_start: saturday # as finance counts weeks");
    expect(validateProject(t.root).filter((i) => i.code === "approval.hash_changed").map((i) => i.path)).toEqual(["dimensions[0]"]);
    expect((await semlayer(t.root, ["status", "--json"])).json<{ changed_since_approval: string[] }>().changed_since_approval).toEqual(["cal.events.on_day"]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groupTables, suggestScope } from "../skills/semantic-layer/scripts/lib/groups.ts";
import { qualifiedName } from "../skills/semantic-layer/scripts/lib/naming.ts";
import { checkPattern, matchesPattern } from "../skills/semantic-layer/scripts/lib/patterns.ts";
import type { Snapshot, SnapshotTable } from "../skills/semantic-layer/scripts/lib/types.ts";
import { writeJson } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, sl, tempRoot } from "./helpers.ts";

// sl scope --explain and the per-entry match counts of the scope preview (FR-1.4), and table
// groups built from names a pattern cannot spell plainly.

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function table(schema: string, name: string): SnapshotTable {
  return { schema, name, kind: "table", row_count: 10, columns: [{ name: "id", type: "integer" }] };
}

const TABLES: SnapshotTable[] = [
  table("analytics", "fct_orders"),
  table("analytics", "fct_payments"),
  table("analytics", "fct_orders_tmp"),
  table("analytics", "dim_customers"),
  table("analytics", "report_daily"),
  table("raw", "stg_orders"),
  table("raw", "stg_payments"),
  table("prod.sales", "orders"),
];

async function setup(scope?: string, list?: string): Promise<string> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  mkdirSync(join(t.root, "sources"), { recursive: true });
  const scopeText = scope ?? "";
  writeFileSync(join(t.root, "sources", "wh.yaml"), `source: wh\ndialect: duckdb\nconnection:\n  database: ":memory:"\n${scopeText}`);
  if (list !== undefined) {
    mkdirSync(join(t.root, "scope"), { recursive: true });
    writeFileSync(join(t.root, "scope", "wh.txt"), list);
  }
  const snapshot: Snapshot = { snapshot_version: 1, source: "wh", dialect: "duckdb", captured_at: "2026-01-15T12:00:00.000Z", method: "manual", tables: TABLES };
  writeJson(join(t.root, "snapshots", "wh.json"), snapshot);
  return t.root;
}

interface Explain {
  source: string;
  table: string;
  in_scope: boolean;
  decided_by: { origin: string | null; entry: string | null; kind: string };
  also_matched: { origin: string; entry: string; kind: string }[];
  rule: string;
}

async function explain(root: string, args: string[]): Promise<Explain> {
  const r = await sl(root, ["scope", "--source", "wh", ...args, "--json"]);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return r.json<Explain>();
}

const SAVED = `scope:\n  include: ["fct_*", "dim_*"]\n  exclude: ["*_tmp"]\n`;

describe("sl scope --explain", () => {
  test("an include entry of the saved scope", async () => {
    const root = await setup(SAVED);
    const r = await explain(root, ["--explain", "analytics.fct_orders"]);
    expect(r).toEqual({
      source: "wh",
      table: "analytics.fct_orders",
      in_scope: true,
      decided_by: { origin: "scope.include[0]", entry: "fct_*", kind: "include" },
      also_matched: [],
      rule: "A table is in scope when an include entry matches it and no exclude entry does.",
    });
    const human = await sl(root, ["scope", "--source", "wh", "--explain", "fct_orders"]);
    expect(human.out).toContain("analytics.fct_orders is in scope for wh.");
    expect(human.out).toContain('Decided by: include "fct_*" (scope.include[0]).');
    expect(human.out).toContain("sl scope --source wh --exclude analytics.fct_orders");
  });

  test("an exclude entry wins over an include that also matches", async () => {
    const root = await setup(SAVED);
    const r = await explain(root, ["--explain", "ANALYTICS.FCT_ORDERS_TMP"]);
    expect(r.table).toBe("analytics.fct_orders_tmp");
    expect(r.in_scope).toBe(false);
    expect(r.decided_by).toEqual({ origin: "scope.exclude[0]", entry: "*_tmp", kind: "exclude" });
    expect(r.also_matched).toEqual([{ origin: "scope.include[0]", entry: "fct_*", kind: "include" }]);
    expect(r.rule).toContain("Exclude wins");
    const human = await sl(root, ["scope", "--source", "wh", "--explain", "fct_orders_tmp"]);
    expect(human.out).toContain("is out of scope for wh.");
    expect(human.out).toContain("preview `sl scope --source wh --remove '*_tmp'` (it removes the entry, which matches 1 table), then add --write.");
  });

  test("a line of the table-list file", async () => {
    const root = await setup("scope:\n  tables_file: scope/wh.txt\n", "# finance\nfct_payments\n\n!raw.*\nstg_*\n");
    const inc = await explain(root, ["--explain", "fct_payments"]);
    expect(inc.decided_by).toEqual({ origin: "tables_file line 2", entry: "fct_payments", kind: "include" });
    const exc = await explain(root, ["--explain", "raw.stg_orders"]);
    expect(exc.in_scope).toBe(false);
    expect(exc.decided_by).toEqual({ origin: "tables_file line 4", entry: "raw.*", kind: "exclude" });
    expect(exc.also_matched).toEqual([{ origin: "tables_file line 5", entry: "stg_*", kind: "include" }]);
    const human = await sl(root, ["scope", "--source", "wh", "--explain", "raw.stg_orders"]);
    expect(human.out).toContain('Decided by: exclude "raw.*" (scope/wh.txt line 4).');
    expect(human.out).toContain("To bring it back, delete or narrow line 4 of scope/wh.txt, then run `sl scope --source wh --from-file scope/wh.txt --write`.");
  });

  test("an empty include means every table not excluded", async () => {
    const root = await setup(`scope:\n  exclude: ["*_tmp"]\n`);
    const r = await explain(root, ["--explain", "report_daily"]);
    expect(r).toMatchObject({ in_scope: true, decided_by: { origin: null, entry: null, kind: "empty_include" }, also_matched: [] });
    const none = await setup();
    expect((await explain(none, ["--explain", "prod.sales.orders"])).decided_by.kind).toBe("empty_include");
  });

  test("no entry matches while the include list is not empty", async () => {
    const root = await setup(SAVED);
    const r = await explain(root, ["--explain", "prod.sales.orders"]);
    expect(r).toMatchObject({ table: "prod.sales.orders", in_scope: false, decided_by: { origin: null, entry: null, kind: "no_match" } });
    const human = await sl(root, ["scope", "--source", "wh", "--explain", "prod.sales.orders"]);
    expect(human.out).toContain("No entry matches it");
    expect(human.out).toContain("sl scope --source wh --tables prod.sales.orders");
  });

  test("entries given now are explained with the flag that gives them", async () => {
    const root = await setup(SAVED);
    const inc = await explain(root, ["--include", "report_*", "--explain", "report_daily"]);
    expect(inc.decided_by).toEqual({ origin: "--include", entry: "report_*", kind: "include" });
    const tab = await explain(root, ["--tables", "raw.stg_orders", "--explain", "raw.stg_orders"]);
    expect(tab.decided_by).toEqual({ origin: "--tables", entry: "raw.stg_orders", kind: "include" });
    const exc = await explain(root, ["--exclude", "fct_payments", "--explain", "fct_payments"]);
    expect(exc.decided_by).toEqual({ origin: "--exclude", entry: "fct_payments", kind: "exclude" });
    const removed = await explain(root, ["--remove", "*_tmp", "--explain", "fct_orders_tmp"]);
    expect(removed.in_scope).toBe(true);
    // --explain only reads.
    const refused = await sl(root, ["scope", "--source", "wh", "--include", "x", "--explain", "fct_orders", "--write"]);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("--explain only reads");
    expect(readFileSync(join(root, "sources", "wh.yaml"), "utf8")).not.toContain("- x");
  });

  test("an unknown table is a plain error with close names", async () => {
    const root = await setup(SAVED);
    const r = await sl(root, ["scope", "--source", "wh", "--explain", "fct_order"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('No table named "fct_order" in the wh snapshot.');
    expect(r.err).toContain("Close names: analytics.fct_orders, analytics.fct_orders_tmp");
    expect(r.err).toContain("sl tables --source wh --all");
    const far = await sl(root, ["scope", "--source", "wh", "--explain", "zzzzzzzz"]);
    expect(far.err).not.toContain("Close names");
    const ambiguous = await sl(root, ["scope", "--source", "wh", "--explain", "orders"]);
    expect(ambiguous.err).toBe("");
    const two = await setup();
    writeJson(join(two, "snapshots", "wh.json"), {
      snapshot_version: 1,
      source: "wh",
      dialect: "duckdb",
      captured_at: "2026-01-15T12:00:00.000Z",
      method: "manual",
      tables: [table("a", "t"), table("b", "t")],
    });
    const both = await sl(two, ["scope", "--source", "wh", "--explain", "t"]);
    expect(both.err).toContain('"t" is in several schemas (a.t, b.t)');
  });

  test("with several matching excludes, the fix names every one of them", async () => {
    const root = await setup(`scope:\n  exclude: ["*_tmp", "analytics.*"]\n  tables_file: scope/wh.txt\n`, "!fct_*\n");
    const r = await explain(root, ["--explain", "fct_orders_tmp"]);
    expect(r.decided_by).toEqual({ origin: "scope.exclude[0]", entry: "*_tmp", kind: "exclude" });
    expect(r.also_matched.map((e) => e.origin)).toEqual(["scope.exclude[1]", "tables_file line 1"]);
    const human = await sl(root, ["scope", "--source", "wh", "--exclude", "analytics.fct_orders_tmp", "--explain", "fct_orders_tmp"]);
    expect(human.out).toContain("Every exclude entry that matches it has to go.");
    expect(human.out).toContain("preview `sl scope --source wh --remove '*_tmp' --remove 'analytics.*'` (it removes the entries, which match 5 tables)");
    expect(human.out).toContain("drop --exclude analytics.fct_orders_tmp from the command");
    expect(human.out).toContain("delete or narrow line 1 of scope/wh.txt");
    // Removing the saved excludes and clearing the file brings it back.
    const back = await explain(root, ["--remove", "*_tmp", "--remove", "analytics.*", "--clear", "--explain", "fct_orders_tmp"]);
    expect(back.in_scope).toBe(true);
  });

  test("an excluded table that no include matches also needs an include", async () => {
    const root = await setup(`scope:\n  include: ["dim_*"]\n  exclude: ["raw.*"]\n`);
    const human = await sl(root, ["scope", "--source", "wh", "--explain", "raw.stg_orders"]);
    expect(human.out).toContain("--remove 'raw.*'");
    expect(human.out).toContain("bring it in with `sl scope --source wh --tables raw.stg_orders`");
    expect((await explain(root, ["--remove", "raw.*", "--tables", "raw.stg_orders", "--explain", "raw.stg_orders"])).in_scope).toBe(true);
  });

  test("an empty --explain is refused and a short name is not close to everything", async () => {
    const root = await setup(SAVED);
    const empty = await sl(root, ["scope", "--source", "wh", "--explain", ""]);
    expect(empty.code).not.toBe(0);
    expect(empty.err).toContain("--explain needs a table name");
    writeJson(join(root, "snapshots", "wh.json"), {
      snapshot_version: 1,
      source: "wh",
      dialect: "duckdb",
      captured_at: "2026-01-15T12:00:00.000Z",
      method: "manual",
      tables: [table("s", "a"), table("s", "orders")],
    });
    const r = await sl(root, ["scope", "--source", "wh", "--explain", "salesx"]);
    expect(r.err).not.toContain("Close names");
  });

  test("the explanation is the same on every run", async () => {
    const root = await setup(SAVED, "fct_*\n!*_tmp\n");
    const args = ["scope", "--source", "wh", "--explain", "fct_orders_tmp"];
    const a = await sl(root, args);
    const b = await sl(root, args);
    expect(a.out).toBe(b.out);
  });
});

interface Preview {
  entries: { origin: string; entry: string; kind: string; matches: number; unmatched: boolean }[];
  by_schema: { schema: string | null; tables: number }[];
  unmatched_patterns: string[];
  added: string[];
}

describe("sl scope preview counts per entry", () => {
  test("--json lists every entry with its origin and match count", async () => {
    const root = await setup(`scope:\n  include: ["fct_*", "nope_*"]\n  exclude: ["*_tmp"]\n  tables_file: scope/wh.txt\n`, "dim_*\n!raw.*\n");
    const r = await sl(root, ["scope", "--source", "wh", "--include", "report_*", "--json"]);
    const p = r.json<Preview>();
    expect(p.entries).toEqual([
      { origin: "scope.include[0]", entry: "fct_*", kind: "include", matches: 3, unmatched: false },
      { origin: "scope.include[1]", entry: "nope_*", kind: "include", matches: 0, unmatched: true },
      { origin: "--include", entry: "report_*", kind: "include", matches: 1, unmatched: false },
      { origin: "scope.exclude[0]", entry: "*_tmp", kind: "exclude", matches: 1, unmatched: false },
      { origin: "tables_file line 1", entry: "dim_*", kind: "include", matches: 1, unmatched: false },
      { origin: "tables_file line 2", entry: "raw.*", kind: "exclude", matches: 2, unmatched: false },
    ]);
    expect(p.by_schema).toEqual([{ schema: "analytics", tables: 4 }]);
    expect(p.unmatched_patterns).toEqual(["nope_*"]);
    expect(p.added).toEqual(["analytics.report_daily"]);

    const human = await sl(root, ["scope", "--source", "wh", "--include", "report_*"]);
    expect(human.out).toContain("Matches per entry:");
    expect(human.out).toContain('  include "fct_*" (scope.include[0]): 3 tables');
    expect(human.out).toContain('  exclude "raw.*" (scope/wh.txt line 2): 2 tables');
    expect(human.out).toContain('Pattern "nope_*"');
    expect(human.out).toContain("Added (1): analytics.report_daily");
    const again = await sl(root, ["scope", "--source", "wh", "--include", "report_*", "--json"]);
    expect(again.out).toBe(r.out);
  });

  test("the human preview lists at most 20 entries and points to --json", async () => {
    const list = Array.from({ length: 25 }, (_, i) => `t_${i}`).join("\n");
    const root = await setup("scope:\n  tables_file: scope/wh.txt\n", `${list}\n`);
    const human = await sl(root, ["scope", "--source", "wh"]);
    expect(human.out).toContain("... and 5 more; rerun with --json to list every entry.");
    const p = (await sl(root, ["scope", "--source", "wh", "--json"])).json<Preview>();
    expect(p.entries).toHaveLength(25);
    expect(p.entries.every((e) => e.unmatched)).toBe(true);
  });

  test("counts by schema in the human preview", async () => {
    const root = await setup();
    const human = await sl(root, ["scope", "--source", "wh"]);
    expect(human.out).toContain("By schema: analytics 5, prod.sales 1, raw 2");
  });
});

describe("table groups from names a pattern cannot spell plainly", () => {
  const mk = (schema: string, name: string): SnapshotTable => ({ schema, name, kind: "table", row_count: 1, columns: [] });
  const TABS = [
    mk('"q', "a_x"),
    mk('"q', "a_y"),
    mk("s", '"p_x'),
    mk("s", '"p_y'),
    mk("s", '"P_z'),
    mk("s", "w*d_a"),
    mk("s", "w*d_b"),
    mk("s", "wxd_c"),
    mk("s", '"p_tmp'),
    mk("s", '"p_old_tmp'),
    mk("s", "pl_c"),
    mk("s2", "b_x"),
  ];

  test("groups with quote-leading names do not throw and select their tables", () => {
    const groups = groupTables(TABS);
    for (const g of groups) {
      expect([g.pattern, checkPattern(g.pattern)]).toEqual([g.pattern, null]);
      const matched = TABS.filter((t) => matchesPattern(g.pattern, t)).map(qualifiedName).sort();
      expect([g.pattern, matched]).toEqual([g.pattern, [...g.tables].sort()]);
    }
    const byPattern = Object.fromEntries(groups.map((g) => [g.pattern, g.tables]));
    expect(byPattern['"""q".*']).toEqual(['"q.a_x', '"q.a_y']);
    expect(byPattern['"""p"_*']).toEqual(['s."p_old_tmp', 's."p_tmp', 's."p_x', 's."p_y']);
    expect(byPattern['"w*d"_*']).toEqual(["s.w*d_a", "s.w*d_b"]);
    expect(groups.find((g) => g.pattern.includes('"P'))).toBeUndefined();
  });

  test("a schema or prefix that reads as a regex, an exclude, a comment or trimmed space is quoted", () => {
    const tabs = [
      mk("re:x", "t_1"),
      mk("re:x", "t_2"),
      mk("s", "re:y_a"),
      mk("s", "re:y_b"),
      mk("s", "!z_a"),
      mk("s", "!z_b"),
      mk("s", "#c_a"),
      mk("s", "#c_b"),
      mk("s", " sp_a"),
      mk("s", " sp_b"),
      mk("s2", "u_1"),
    ];
    const groups = groupTables(tabs);
    for (const g of groups) {
      expect([g.pattern, checkPattern(g.pattern)]).toEqual([g.pattern, null]);
      expect([g.pattern, tabs.filter((t) => matchesPattern(g.pattern, t)).map(qualifiedName).sort()]).toEqual([g.pattern, [...g.tables].sort()]);
    }
    expect(groups.map((g) => g.pattern)).toEqual(expect.arrayContaining(['"re:x".*', '"re:y"_*', '"!z"_*', '"#c"_*', '" sp"_*']));
  });

  test("the suggested excludes are exact patterns that parse", () => {
    const tabs = [mk("s", "fct_a"), mk("s", "fct_b"), mk("s", "fct_c_tmp"), mk("s", 'fct_"x_tmp'), mk("s", '"y_tmp')];
    const suggested = suggestScope(tabs, groupTables(tabs));
    for (const p of [...suggested.include, ...suggested.exclude]) expect([p, checkPattern(p)]).toEqual([p, null]);
    const kept = tabs.filter((t) => suggested.include.some((p) => matchesPattern(p, t)) && !suggested.exclude.some((p) => matchesPattern(p, t)));
    expect(kept.map((t) => t.name)).toEqual(["fct_a", "fct_b"]);
  });

  test("sl tables --groups runs with such names", async () => {
    const root = await setup();
    writeJson(join(root, "snapshots", "wh.json"), {
      snapshot_version: 1,
      source: "wh",
      dialect: "duckdb",
      captured_at: "2026-01-15T12:00:00.000Z",
      method: "manual",
      tables: TABS,
    });
    const r = await sl(root, ["tables", "--source", "wh", "--groups", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const again = await sl(root, ["tables", "--source", "wh", "--groups", "--json"]);
    expect(again.out).toBe(r.out);
  });
});

describe("--explain agrees with the preview and its commands work", () => {
  const mk = (schema: string, name: string): SnapshotTable => ({ schema, name, kind: "table", row_count: 1, columns: [] });
  async function withTables(tabs: SnapshotTable[], scope?: string, list?: string): Promise<string> {
    const root = await setup(scope, list);
    writeJson(join(root, "snapshots", "wh.json"), {
      snapshot_version: 1,
      source: "wh",
      dialect: "duckdb",
      captured_at: "2026-01-15T12:00:00.000Z",
      method: "manual",
      tables: tabs,
    });
    return root;
  }
  // The quoted value of the first `flag` in a suggested command, unquoted as a POSIX shell would.
  function flagValue(out: string, flag: string): string {
    const m = new RegExp(`${flag} ('(?:[^']|'\\\\'')*'|[^\\s\`]+)`).exec(out);
    expect([out, m]).not.toEqual([out, null]);
    const arg = m![1]!;
    return arg.startsWith("'") ? arg.slice(1, -1).replaceAll("'\\''", "'") : arg;
  }

  const TABS = [mk("a", "fct_x"), mk("a", "fct_y_tmp"), mk("a", "dim_z"), mk("b", "raw_q"), mk("b", "stg_w"), mk("c", "other")];
  const scenarios: [string, string, string | undefined, string[]][] = [
    ["no scope", "", undefined, []],
    ["include only", `scope:\n  include: ["fct_*"]\n`, undefined, []],
    ["excludes only", `scope:\n  exclude: ["*_tmp", "b.*"]\n`, undefined, []],
    ["lists and file", `scope:\n  include: ["fct_*"]\n  exclude: ["*_tmp"]\n  tables_file: scope/wh.txt\n`, "dim_*\n!b.*\nb.stg_w\n", []],
    ["flags given now", `scope:\n  include: ["fct_*"]\n`, undefined, ["--include", "dim_*", "--exclude", "fct_x", "--tables", "c.other"]],
    ["clear", `scope:\n  include: ["fct_*"]\n  tables_file: scope/wh.txt\n`, "!a.*\n", ["--clear", "--include", "b.*"]],
  ];
  for (const [label, scope, list, flags] of scenarios) {
    test(label, async () => {
      const root = await withTables(TABS, scope, list);
      const preview = (await sl(root, ["scope", "--source", "wh", ...flags, "--json"])).json<{ tables: { table: string }[]; entries: Preview["entries"] }>();
      const shown = new Set(preview.tables.map((r) => r.table));
      for (const e of preview.entries) expect(e.unmatched).toBe(e.matches === 0);
      for (const tab of TABS) {
        const q = qualifiedName(tab);
        const r = await explain(root, [...flags, "--explain", q]);
        expect([q, r.in_scope]).toEqual([q, shown.has(q)]);
      }
    });
  }

  for (const name of ["it's", '"q', "x y", "a,b"]) {
    test(`the suggested --exclude for a table named ${name} leaves out exactly it`, async () => {
      const root = await withTables([mk("s", name), mk("s", "a"), mk("s", "b"), mk("s", "other")]);
      const h = await sl(root, ["scope", "--source", "wh", "--explain", `s.${name}`]);
      expect(h.code).toBe(0);
      const r = await sl(root, ["scope", "--source", "wh", "--exclude", flagValue(h.out, "--exclude"), "--json"]);
      expect([r.code, r.err]).toEqual([0, ""]);
      expect(r.json<{ tables: { table: string }[] }>().tables.map((x) => x.table)).toEqual(["s.a", "s.b", "s.other"]);
    });
  }

  test("a table whose name has a comma is brought in by an exact re: pattern", async () => {
    const root = await withTables([mk("s", "a,b"), mk("s", "a"), mk("s", "b")], `scope:\n  include: ["s.a"]\n`);
    const h = await sl(root, ["scope", "--source", "wh", "--explain", "s.a,b"]);
    expect(h.out).toContain("bring it in with `sl scope --source wh --include 're:s\\.a,b'`");
    const r = await sl(root, ["scope", "--source", "wh", "--include", flagValue(h.out, "--include"), "--json"]);
    expect(r.json<{ tables: { table: string }[] }>().tables.map((x) => x.table)).toEqual(["s.a", "s.a,b"]);
  });

  test("--explain never writes, with --from-file either", async () => {
    const root = await withTables(TABS, `scope:\n  include: ["fct_*"]\n`);
    writeFileSync(join(root, "list.txt"), "dim_*\n");
    const before = readFileSync(join(root, "sources", "wh.yaml"), "utf8");
    const r = await explain(root, ["--from-file", "list.txt", "--explain", "dim_z"]);
    expect(r.decided_by.origin).toBe("tables_file line 1");
    expect(readFileSync(join(root, "sources", "wh.yaml"), "utf8")).toBe(before);
    expect(existsSync(join(root, "scope", "wh.txt"))).toBe(false);
  });
});

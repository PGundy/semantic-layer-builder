import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../skills/semantic-layer/scripts/lib/errors.ts";
import { DATE_PATTERN, groupTables, NOISE_PATTERN } from "../skills/semantic-layer/scripts/lib/groups.ts";
import {
  checkPattern,
  inScope,
  literalPattern,
  matchesDotted,
  matchesPattern,
  parseEntry,
  unmatchedPatterns,
  validatePattern,
} from "../skills/semantic-layer/scripts/lib/patterns.ts";
import { classifyTable, noiseReason, rankTables, stagingReasons } from "../skills/semantic-layer/scripts/lib/rank.ts";
import type { Snapshot, SnapshotTable } from "../skills/semantic-layer/scripts/lib/types.ts";
import { writeJson, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, sl, tempRoot } from "./helpers.ts";

const t = (schema: string | null, name: string) => ({ schema, name });

// Each row: pattern, table (schema or null, name), whether it matches.
type MatchCase = [string, string, string | null, string, boolean];
const MATCHES: MatchCase[] = [
  ["prefix", "fct_*", "public", "fct_orders", true],
  ["prefix, other table", "fct_*", "public", "dim_orders", false],
  ["suffix", "*_daily", null, "sales_daily", true],
  ["contains", "*orders*", "x", "stg_orders_v2", true],
  ["a whole schema", "analytics.*", "analytics", "anything", true],
  ["a whole schema, other schema", "analytics.*", "public", "anything", false],
  ["exact table name in any schema", "fct_orders", "analytics", "fct_orders", true],
  ["exact name is case-insensitive", "FCT_Orders", "analytics", "fct_orders", true],
  ["exact schema.table, other schema", "analytics.fct_orders", "raw", "fct_orders", false],
  ["exact schema.table", "Analytics.FCT_ORDERS", "analytics", "fct_orders", true],
  ["three-part exact name", "prod.analytics.orders", "prod.analytics", "orders", true],
  ["three-part glob over schemas", "prod.*.orders", "prod.analytics", "orders", true],
  ["three-part glob, other catalog", "prod.*.orders", "dev.analytics", "orders", false],
  ["two-part pattern on a three-part name names the schema as the snapshot does", "analytics.orders", "prod.analytics", "orders", false],
  ["BigQuery project.dataset as the schema", "my-proj.sales.*", "my-proj.sales", "daily", true],
  ["quoted mixed case matches exactly", '"OrderItems"', "shop", "OrderItems", true],
  ["quoted mixed case refuses another case", '"OrderItems"', "shop", "orderitems", false],
  ["unquoted mixed case ignores case", "orderitems", "shop", "OrderItems", true],
  ["quoted schema and table", '"Sales"."OrderItems"', "Sales", "OrderItems", true],
  ["quoted schema and table, schema in another case", '"Sales"."OrderItems"', "sales", "OrderItems", false],
  ["quoted name holding a dot matches the table name", '"orders.v2"', "public", "orders.v2", true],
  ["unquoted schema, quoted name holding a dot", 'PUBLIC."orders.v2"', "public", "orders.v2", true],
  ["quoted schema, glob table", '"Sales".fct_*', "Sales", "FCT_X", true],
  ["quoted schema, glob table, schema in another case", '"Sales".fct_*', "SALES", "fct_x", false],
  ["wildcards inside quotes are literal", '"fct_*"', "s", "fct_orders", false],
  ["wildcards inside quotes match themselves", '"fct_*"', "s", "fct_*", true],
  ["a doubled quote inside quotes is one quote", '"a""b"', "s", 'a"b', true],
  ["a quote inside a part is an ordinary character", 'a.odd"name', "a", 'odd"name', true],
  ["a quote inside a schema is an ordinary character", 'we"ird.*', 'we"ird', "a_x", true],
  ["case folds as a regex does: the Kelvin sign is not k", "k", null, "\u212A", false],
  ["regex alternation", "re:dim_(customer|product)s?", "p", "dim_customers", true],
  ["regex alternation, no option fits", "re:dim_(customer|product)s?", "p", "dim_regions", false],
  ["regex is always case-insensitive", "re:DIM_\\w+", "p", "dim_dates", true],
  ["regex with \\. matches the qualified name", "re:raw\\.raw_.*", "raw", "raw_orders", true],
  ["regex with \\., other schema", "re:raw\\.raw_.*", "analytics", "raw_orders", false],
  ["regex is anchored at both ends", "re:orders", "s", "stg_orders", false],
  ["regex without \\. ignores the schema", "re:.*orders", "orders_db", "events", false],
  ["? is one character", "FCT_?RDERS", null, "fct_orders", true],
  ["? is exactly one character", "fct_?", null, "fct_ab", false],
  ["_ is literal in a glob", "a_b", null, "axb", false],
  ["% is literal in a glob", "fct_%", null, "fct_%", true],
  ["% matches only itself", "fct_%", null, "fct_x", false],
  ["$ is literal in a glob", "cost$usd", null, "cost$usd", true],
  ["a dot is literal in a glob", "fct.orders", null, "fctxorders", false],
  ["regex metacharacters are literal in a glob", "a+b(c)[d]{1}^|", null, "a+b(c)[d]{1}^|", true],
  ["an escaped $ in a regex", "re:price\\$", null, "price$", true],
];

// Each row: pattern, the kind of problem, the 0-based offset of the problem in the pattern.
type RefusalCase = [string, string, "syntax" | "unsafe" | "too_long", number];
const REFUSALS: RefusalCase[] = [
  ["nested + in +", "re:(a+)+", "unsafe", 7],
  ["nested * in *", "re:(a*)*", "unsafe", 7],
  ["repeated overlapping choice", "re:(a|aa)+", "unsafe", 9],
  ["repeated word then optional space", "re:(\\w+\\s?)*", "unsafe", 11],
  ["repeated choice with an empty option", "re:(a|)+", "unsafe", 7],
  ["nested repeat under a large bounded repeat", "re:x(?:y+){2}", "unsafe", 10],
  ["nested repeat deeper inside", "re:t_((ab)+c)*", "unsafe", 13],
  ["four repeats in a row over the same characters", "re:a*a*a*a*", "unsafe", 10],
  ["four .* that a shared separator does not keep apart", "re:.*_.*_.*_.*", "unsafe", 13],
  ["bounded repeats in a row over the same character", `re:${"a{0,30}".repeat(10)}b`, "unsafe", 25],
  ["bounded repeats of an overlapping choice in a row", `re:${"(?:aa|a){1,9}".repeat(4)}b`, "unsafe", 24],
  ["overlapping choices in a row", `re:${"(a|a)".repeat(22)}b`, "unsafe", 93],
  ["optional characters in a row", `re:${"a?".repeat(20)}b`, "unsafe", 40],
  ["repeats kept apart only by parts that can match nothing", "re:a*b?a*b?a*b?a*", "unsafe", 16],
  ["two chains woven together", "re:x*y*x*y*x*y*x*", "unsafe", 16],
  ["turning off ignoring case", "re:(?-i:ABC)", "syntax", 3],
  ["over 512 characters", `re:${"a".repeat(513)}`, "too_long", 515],
  ["group never closed", "re:web_(.*", "syntax", 7],
  ["group never closed at the start", "re:(unclosed", "syntax", 3],
  ["a ) that closes no group, which would break the anchors", "re:a)|(b", "syntax", 4],
  ["range out of order", "re:x[z-a]", "syntax", 5],
  ["repeat with nothing before it", "re:*abc", "syntax", 3],
  ["repeat of a repeat", "re:ab+*", "syntax", 6],
  ["repeat numbers out of order", "re:a{2,1}", "syntax", 4],
  ["trailing backslash", "re:abc\\", "syntax", 6],
  ["class never closed", "re:x[abc", "syntax", 4],
  ["bad group syntax", "re:(?x)", "syntax", 3],
  ["duplicate group name", "re:(?<n>a)(?<n>b)", "syntax", 13],
  ["repeated anchor", "re:^*a", "syntax", 4],
  ["quote never closed", '"Orders', "syntax", 0],
  ["quote never closed after a schema", 'public."orders', "syntax", 7],
];

describe("selection grammar", () => {
  test.each(MATCHES)("%s: %p", (_label, pattern, schema, name, expected) => {
    expect(matchesPattern(pattern, t(schema, name))).toBe(expected);
  });

  test.each(REFUSALS)("refused, %s: %p", (_label, pattern, kind, offset) => {
    const problem = checkPattern(pattern);
    expect(problem).not.toBeNull();
    expect({ kind: problem!.kind, offset: problem!.offset }).toEqual({ kind, offset });
    expect(problem!.message).toContain(`character ${offset + 1}`);
    expect(problem!.message).toContain("run the command again; sl validate");
    expect(validatePattern(pattern)).toBe(problem!.message);
    expect(() => matchesPattern(pattern, t(null, "a"))).toThrow(UserError);
  });

  test("refusal messages say what is wrong in plain words", () => {
    expect(validatePattern("re:(a+)+")).toBe(
      'Unsafe regex in pattern "re:(a+)+": the "+" at character 8 repeats a part that holds another repeat (the "+" at character 6), ' +
        'and that can make matching extremely slow. Keep only one of the two repeats, for example "x+" instead of "(x+)+". ' +
        "Fix the pattern and run the command again; sl validate lists every pattern problem in the project.",
    );
    expect(validatePattern("re:(a|aa)+")).toContain('options "a" at character 5 and "aa" at character 7 can start with the same character');
    expect(validatePattern("re:web_(.*")).toStartWith('Invalid regex in pattern "re:web_(.*": the "(" at character 8 is never closed; add a ")".');
    expect(validatePattern("re:(?<n>a)(?<n>b)")).toContain('the group name "n" at character 14 is used twice');
    const long = validatePattern(`re:${"a".repeat(600)}`)!;
    expect(long).toContain("it has 600 characters and the limit is 512, so everything from character 516 on is over it");
    expect(long.length).toBeLessThan(400);
  });

  test("safe regexes, including bounded repeats and disjoint choices, are accepted", () => {
    for (const p of [
      "re:(a+)?",
      "re:(a|b)+",
      "re:(x{2})+",
      "re:dim_(customer|product)s?",
      "re:dim_(customer|product)s(_v\\d+)?",
      "re:events_\\d{4}(_\\d{2}){0,1}",
      "re:.*_(19|20)\\d{2}",
      "re:(?=fct_)\\w+",
      "re:(?<kind>fct|dim)_.*",
      "re:[\\w-]+",
      "re:[^_]+_[a-z]{1,3}",
      "re:.*_.*_.*",
      "re:[a-z]+_[a-z]+_[a-z]+_[a-z]+_\\d+",
      "re:a*b*c*d*e*",
      "re:a{0,30}a{0,30}a{0,30}b",
      "re:(fct|dim)_(orders|items)_(daily|weekly)",
      "re:(?i:abc)",
      `re:${"a".repeat(512)}`,
      DATE_PATTERN,
      NOISE_PATTERN,
    ]) {
      expect([p, validatePattern(p)]).toEqual([p, null]);
    }
  });

  test("checking a long regex is fast", () => {
    const started = performance.now();
    for (const p of [`re:${"[a-z]+_".repeat(73)}`, `re:${"x+y+".repeat(128)}`, `re:${"(?:fct|dim)_".repeat(42)}`]) expect([p, checkPattern(p)]).toEqual([p, null]);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("an accepted chain of bounded repeats matches fast", () => {
    const pattern = `re:${"a{0,30}".repeat(3)}b`;
    expect(checkPattern(pattern)).toBeNull();
    const started = performance.now();
    expect(matchesPattern(pattern, t(null, "a".repeat(200)))).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("a chain of bounded repeats is refused in plain words", () => {
    expect(validatePattern(`re:${"a{0,30}".repeat(4)}b`)).toContain(
      "the repeats and choices from character 5 to character 26 can match the same characters, so together they can split one name in too many ways",
    );
    expect(validatePattern("re:(?-i:ABC)")).toContain('the group at character 4 turns off ignoring case with "-i"');
  });

  test("literalPattern names one table exactly, whatever its name holds", () => {
    const names = [t("a", "plain"), t("a", 'odd"name'), t('"q', "x"), t("s", "fct_*"), t("s", "a?b"), t("public", "orders.v2"), t("prod.analytics", "orders"), t(null, '"x"')];
    expect(names.map(literalPattern)).toEqual(["a.plain", 'a."odd""name"', '"""q".x', 's."fct_*"', 's."a?b"', 'public."orders.v2"', "prod.analytics.orders", '"""x"""']);
    const decoys = [t("a", "Plain"), t("s", "fct_orders"), t("s", "axb"), t(null, "x")];
    for (const table of names) {
      const p = literalPattern(table);
      expect([p, checkPattern(p)]).toEqual([p, null]);
      expect([...names, ...decoys].filter((o) => matchesPattern(p, o))).toEqual(table.name === "plain" ? [table, decoys[0]!] : [table]);
    }
  });

  test("names holding a quote do not break table groups", () => {
    const mk = (schema: string, name: string): SnapshotTable => ({ schema, name, kind: "table", row_count: 1, columns: [] });
    const groups = groupTables([mk('we"ird', "a_x"), mk('we"ird', "a_y"), mk("s2", "b_x")]);
    expect(groups.find((g) => g.kind === "schema" && g.pattern === 'we"ird.*')?.tables).toEqual(['we"ird.a_x', 'we"ird.a_y']);
  });

  test("a glob cannot make matching slow", () => {
    const pattern = `${"*a".repeat(200)}*b`;
    const started = performance.now();
    expect(matchesPattern(pattern, t(null, "a".repeat(400)))).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("exclude wins and empty include means everything", () => {
    expect(inScope(undefined, t(null, "a"))).toBe(true);
    expect(inScope({}, t("any", "thing"))).toBe(true);
    expect(inScope({ exclude: ["*_tmp"] }, t(null, "a_tmp"))).toBe(false);
    expect(inScope({ exclude: ["*_tmp"] }, t(null, "a"))).toBe(true);
    expect(inScope({ include: ["fct_*"], exclude: ["*_v2"] }, t(null, "fct_orders_v2"))).toBe(false);
    expect(inScope({ include: ["fct_*"], exclude: ["*_v2"] }, t(null, "fct_orders"))).toBe(true);
    expect(inScope({ include: ["fct_orders"], exclude: ["fct_orders"] }, t("a", "fct_orders"))).toBe(false);
    expect(inScope({ include: ["re:events_.*"], exclude: ["re:.*_(19|20)\\d{2}"] }, t("a", "events_2024"))).toBe(false);
    expect(inScope({ include: ["re:events_.*"], exclude: ["re:.*_(19|20)\\d{2}"] }, t("a", "events_live"))).toBe(true);
    expect(inScope({ exclude: ['"Orders"'] }, t("a", "orders"))).toBe(true);
    expect(inScope({ exclude: ['"Orders"'] }, t("a", "Orders"))).toBe(false);
  });

  test("dotted access names", () => {
    expect(matchesDotted("warehouse.*", "warehouse.orders")).toBe(true);
    expect(matchesDotted("lake.*", "warehouse.orders")).toBe(false);
    expect(matchesDotted("orders", "warehouse.orders")).toBe(true);
  });

  test("a pattern that matches nothing is named once, in list order", () => {
    const tables = [t("a", "fct_orders"), t("a", "orders_tmp")];
    expect(unmatchedPatterns({ include: ["fct_*", "mart_*", "re:x_.*"], exclude: ["*_tmp", "*_bak", "mart_*"] }, tables)).toEqual(["mart_*", "re:x_.*", "*_bak"]);
    expect(unmatchedPatterns(undefined, tables)).toEqual([]);
  });

  test("table-list entries: ! excludes", () => {
    expect(parseEntry("fct_*")).toEqual({ kind: "include", pattern: "fct_*" });
    expect(parseEntry("!*_tmp")).toEqual({ kind: "exclude", pattern: "*_tmp" });
    expect(parseEntry("  ! raw.*  ")).toEqual({ kind: "exclude", pattern: "raw.*" });
    expect(parseEntry('!"Weird Name"')).toEqual({ kind: "exclude", pattern: '"Weird Name"' });
    expect(parseEntry("re:!x")).toEqual({ kind: "include", pattern: "re:!x" });
    expect(parseEntry("   ")).toBeNull();
    expect(() => parseEntry(" ! ")).toThrow('write the table or pattern to exclude, for example "!*_tmp"');
  });

  test("sl scope warns on a pattern that matches nothing and refuses an unsafe one", async () => {
    const tmp = tempRoot();
    try {
      await initProject(tmp.root);
      writeYaml(join(tmp.root, "sources", "wh.yaml"), { source: "wh", dialect: "duckdb", connection: { database: ":memory:" } });
      const snapshot: Snapshot = {
        snapshot_version: 1,
        source: "wh",
        dialect: "duckdb",
        captured_at: "2026-01-15T12:00:00.000Z",
        method: "manual",
        tables: [{ schema: "a", name: "fct_orders", kind: "table", row_count: 1, columns: [] }],
      };
      writeJson(join(tmp.root, "snapshots", "wh.json"), snapshot);
      const human = await sl(tmp.root, ["scope", "--source", "wh", "--include", "fct_*", "--include", "mart_*"]);
      expect(human.code).toBe(0);
      expect(human.out).toContain('Warning: Pattern "mart_*" matches no table in the snapshot; check its spelling against `sl tables --source wh --all`.');
      const json = (await sl(tmp.root, ["scope", "--source", "wh", "--include", "fct_*", "--exclude", "mart_*", "--json"])).json<{ unmatched_patterns: string[] }>();
      expect(json.unmatched_patterns).toEqual(["mart_*"]);
      const unsafe = await sl(tmp.root, ["scope", "--source", "wh", "--include", "re:(a+)+"]);
      expect(unsafe.code).toBe(1);
      expect(unsafe.err).toContain('the "+" at character 8 repeats a part that holds another repeat');

      writeYaml(join(tmp.root, "sources", "wh.yaml"), {
        source: "wh",
        dialect: "duckdb",
        connection: { database: ":memory:" },
        scope: { include: ["re:(\\w+\\s?)*", "re:" + "b".repeat(513)], exclude: ['"tmp'] },
      });
      const v = await sl(tmp.root, ["validate"]);
      expect(v.code).toBe(1);
      for (const s of ["scope.include[0]", "character 12", "scope.include[1]", "the limit is 512", "scope.exclude[0]", "the quote at character 1 is never closed"]) {
        expect(v.out + v.err).toContain(s);
      }
    } finally {
      tmp.cleanup();
    }
  });
});

test("sl scope --tables saves a name holding a quote or a wildcard as an exact pattern", async () => {
  const tmp = tempRoot();
  try {
    await initProject(tmp.root);
    writeYaml(join(tmp.root, "sources", "wh.yaml"), { source: "wh", dialect: "duckdb", connection: { database: ":memory:" } });
    const mk = (schema: string, name: string): SnapshotTable => ({ schema, name, kind: "table", row_count: 1, columns: [] });
    const snapshot: Snapshot = {
      snapshot_version: 1,
      source: "wh",
      dialect: "duckdb",
      captured_at: "2026-01-15T12:00:00.000Z",
      method: "manual",
      tables: [mk("a", 'odd"name'), mk("a", "plain"), mk('"q', "x"), mk("a", "fct_*"), mk("a", "fct_orders")],
    };
    writeJson(join(tmp.root, "snapshots", "wh.json"), snapshot);
    const r = await sl(tmp.root, ["scope", "--source", "wh", "--tables", 'a.odd"name,"q.x,a.fct_*', "--write", "--json"]);
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(r.json<{ tables: { table: string }[]; unmatched_patterns: string[] }>()).toMatchObject({
      scope: { include: ['a."odd""name"', '"""q".x', 'a."fct_*"'] },
      tables: [{ table: '"q.x' }, { table: "a.fct_*" }, { table: 'a.odd"name' }],
      unmatched_patterns: [],
    });
    expect(readFileSync(join(tmp.root, "sources", "wh.yaml"), "utf8")).toContain(`- a."odd""name"`);
  } finally {
    tmp.cleanup();
  }
});

describe("ranking", () => {
  const table = (name: string, rows: number, fks: string[] = []): SnapshotTable => ({
    schema: "public",
    name,
    kind: "table",
    row_count: rows,
    columns: [],
    foreign_keys: fks.map((f) => ({ columns: [`${f}_id`], references: { schema: "public", table: f, columns: ["id"] } })),
  });

  test("noise sinks and referenced tables rise", () => {
    const ranked = rankTables([table("orders_backup_2024", 100000), table("fct_orders", 10000, ["dim_customers"]), table("dim_customers", 500)]);
    expect(ranked.map((r) => r.table.name)).toEqual(["fct_orders", "dim_customers", "orders_backup_2024"]);
    expect(noiseReason("customers_tmp")).toContain("tmp");
    expect(noiseReason("events_20240101")).toContain("date");
    expect(noiseReason("fct_orders")).toBeNull();
  });

  test("pipeline bookkeeping and leading underscores are noise", () => {
    expect(noiseReason("etl_job_runs")).toBe('name contains "etl": pipeline bookkeeping');
    expect(noiseReason("dbt-run-results")).toContain("pipeline bookkeeping");
    expect(noiseReason("_migrations")).toBe("name starts with an underscore: tool bookkeeping");
    expect(noiseReason("schema_migrations")).toBe("migration bookkeeping table");
    expect(noiseReason("etlx_orders")).toBeNull();
  });

  test("one classifier for noise and staging: by name, schema and comment, noise first", () => {
    expect(classifyTable({ schema: "shop", name: "stg_sales" })).toEqual({ role: "staging", reasons: ["raw or staging naming"], excludable: true });
    expect(classifyTable({ schema: "raw", name: "orders" })).toEqual({ role: "staging", reasons: ["in the raw schema"], excludable: true });
    expect(classifyTable({ schema: "shop", name: "orders_feed", description: "Raw export, not cleaned." })!.role).toBe("staging");
    expect(classifyTable({ schema: "raw", name: "orders_tmp" })).toEqual({ role: "noise", reasons: ['name contains "tmp"'], excludable: true });
    // int_ names staging for the ranking only: a suggested scope keeps it.
    expect(classifyTable({ schema: "mfg", name: "int_shipments" })).toEqual({ role: "staging", reasons: ["intermediate (int_) naming"], excludable: false });
    expect(classifyTable({ schema: "shop", name: "orders" })).toBeNull();
    expect(stagingReasons({ schema: "staging", name: "raw_orders", description: "the landing table for orders" })).toEqual([
      "raw or staging naming",
      "in the staging schema",
      "the table comment says it is raw or uncleaned",
    ]);
  });

  test("raw, landing and stitch as ordinary business words are neither staging nor noise", () => {
    // The reviewer's probe: these were not staging or noise before the classifier was shared with the suggested scope.
    expect(classifyTable({ schema: "mfg", name: "materials", description: "Inventory of raw materials, one row per lot" })).toBeNull();
    expect(classifyTable({ schema: "mfg", name: "orders", description: "Orders as loaded; totals are raw sums before discounts" })).toBeNull();
    expect(classifyTable({ schema: "mfg", name: "landing_pages", description: "One row per marketing landing page" })).toBeNull();
    expect(classifyTable({ schema: "mfg", name: "stitch_counts" })).toBeNull();
    // Staging phrases still are.
    for (const description of ["Raw data from the ERP", "staging table for orders", "landing zone copy", "Not yet cleaned", "uncleaned rows"]) {
      expect([description, classifyTable({ schema: "s", name: "orders", description })?.role]).toEqual([description, "staging"]);
    }
    // A landing schema is still staging, and Stitch's own _sdc_ tables are still noise.
    expect(classifyTable({ schema: "landing", name: "orders" })?.role).toBe("staging");
    expect(classifyTable({ schema: "s", name: "_sdc_rejected" })?.role).toBe("noise");
  });

  test("staging by schema ranks below a table of the same size; pipeline tables sink like noise", () => {
    const t = (schema: string, name: string, rows: number): SnapshotTable => ({ schema, name, kind: "table", row_count: rows, columns: [] });
    const ranked = rankTables([t("raw", "orders", 1000), t("shop", "orders", 1000), t("ops", "etl_job_runs", 100000)]);
    expect(ranked.map((r) => r.qualified)).toEqual(["shop.orders", "raw.orders", "ops.etl_job_runs"]);
    expect(ranked[1]!.reasons).toContain("in the raw schema");
    expect(ranked[2]!.reasons).toContain('likely noise: name contains "etl": pipeline bookkeeping');
  });
});

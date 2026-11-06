import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { qualifiedName } from "../skills/semantic-layer/scripts/lib/naming.ts";
import { checkPattern, filterInScope } from "../skills/semantic-layer/scripts/lib/patterns.ts";
import { combineScope, parseTableList, renderTableList } from "../skills/semantic-layer/scripts/lib/table-list.ts";
import type { Snapshot, SnapshotTable } from "../skills/semantic-layer/scripts/lib/types.ts";
import { writeJson, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, sl, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function table(schema: string | null, name: string): SnapshotTable {
  return { schema, name, kind: "table", row_count: 10, columns: [{ name: "id", type: "integer" }] };
}

function snapshotOf(source: string, tables: SnapshotTable[]): Snapshot {
  return { snapshot_version: 1, source, dialect: "duckdb", captured_at: "2026-01-15T12:00:00.000Z", method: "manual", tables };
}

const SOURCE_YAML = (name: string) => `# Warehouse replica. Owner: Dana.
source: ${name}
dialect: duckdb # local file for tests
connection:
  database: ":memory:"
# Scope agreed on the first call.
scope:
  include: ["analytics.*"] # facts and dimensions
  exclude:
    - "*_backup" # never model backups
# Profile settings stay small in CI.
profile:
  top_values: 5
`;

async function project(sources: Record<string, SnapshotTable[]>, yaml: (name: string) => string = SOURCE_YAML): Promise<{ root: string; dir: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  mkdirSync(join(t.root, "sources"), { recursive: true });
  for (const [name, tables] of Object.entries(sources)) {
    writeFileSync(join(t.root, "sources", `${name}.yaml`), yaml(name));
    writeJson(join(t.root, "snapshots", `${name}.json`), snapshotOf(name, tables));
  }
  return { root: t.root, dir: t.dir };
}

interface ScopeJson {
  scope: { include?: string[]; exclude?: string[]; tables_file?: string };
  after_count: number;
  tables: { table: string }[];
  unmatched_patterns: string[];
  tables_file: { path: string; include: number; exclude: number } | null;
  to_file: string | null;
  warnings: string[];
  written: boolean;
}

async function scopeJson(root: string, args: string[]): Promise<ScopeJson> {
  const r = await sl(root, ["scope", ...args, "--json"]);
  if (r.code !== 0) throw new Error(r.err);
  return r.json<ScopeJson>();
}

// ---- A synthetic catalog of a few thousand tables and a 500-line file over it ----

const STEMS = [
  "orders", "order_items", "customers", "products", "payments", "refunds", "sessions", "events", "invoices", "shipments",
  "returns", "carts", "coupons", "stores", "regions", "employees", "suppliers", "inventory", "budgets", "forecasts",
];
const PREFIXES = ["fct_", "dim_", "stg_", "raw_", "rpt_", "tmp_"];
const SUFFIXES = ["", "_v2", "_daily", "_tmp", "_2024", "_2025_01", "_backup"];
const SCHEMAS = ["analytics", "raw", "marts"];

function catalog(): SnapshotTable[] {
  const out: SnapshotTable[] = [];
  for (const s of SCHEMAS) for (const p of PREFIXES) for (const stem of STEMS) for (const x of SUFFIXES) out.push(table(s, `${p}${stem}${x}`));
  out.push(table("Sales", "OrderBook"), table("sales", "orderbook"), table("analytics", "fct_orders.v3"), table("analytics", "fct_*odd"));
  return out;
}

// A deterministic generator (a linear congruential sequence), so the file is the same on every run.
function rng(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

// Writes 500 lines mixing comments, blank lines, exact names, globs, regexes and ! excludes, some
// with trailing comments, indents or CRLF endings, and returns the include and exclude lists the
// lines mean, built apart from the parser.
function tableListFile(tables: SnapshotTable[]): { text: string; include: string[]; exclude: string[] } {
  const next = rng(42);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(next() * xs.length)]!;
  const include: string[] = [];
  const exclude: string[] = [];
  const globs = ["analytics.fct_*", "*_daily", "marts.dim_*", "dim_?????", "rpt_*_v2", "analytics.stg_orders*", "\"Sales\".*"];
  const regexes = ["re:analytics\\.rpt_[a-z]+_(daily|v2)", "re:fct_(orders|items|refunds)_\\d{4}", "re:marts\\.dim_(customers|products)", "re:dim_[a-z_]+_2025_\\d{2}"];
  const excludes = ["*_tmp", "re:.*_backup", "raw.*", "tmp_*", "re:analytics\\.fct_[a-z]+_2024"];
  const lines: string[] = [];
  while (lines.length < 500) {
    const r = next();
    let line: string;
    if (r < 0.1) line = pick(["# Finance tables", "  # indented comment", "#", "## section ##"]);
    else if (r < 0.18) line = pick(["", "   ", "\t"]);
    else if (r < 0.66) {
      const t = pick(tables.filter((x) => x.schema !== "Sales" && x.schema !== "sales" && !x.name.includes(".") && !x.name.includes("*")));
      const p = next() < 0.85 ? `${t.schema}.${t.name}` : t.name;
      include.push(p);
      line = next() < 0.3 ? `${p}   # owner asked for it` : p;
    } else if (r < 0.78) {
      const p = pick(globs);
      include.push(p);
      line = next() < 0.3 ? `  ${p}\t# glob` : p;
    } else if (r < 0.86) {
      const p = pick(regexes);
      include.push(p);
      line = p;
    } else {
      const p = pick(excludes);
      exclude.push(p);
      line = next() < 0.5 ? `!${p}` : `!  ${p}  # leave out`;
    }
    lines.push(line);
  }
  const text = lines.map((l, i) => (i % 7 === 3 ? `${l}\r\n` : `${l}\n`)).join("");
  return { text, include, exclude };
}

describe("table-list file parsing", () => {
  test("comments, blank lines, CRLF, a byte-order mark and ! excludes", () => {
    const text = '﻿# header\r\nfct_*\r\n\r\n  dim_customers  # trailing\n!*_tmp\n! re:.*_backup # why\n"odd #name"\nre:a#b\nweird#name\n\t#tabbed\n';
    const { entries, problems } = parseTableList(text);
    expect(problems).toEqual([]);
    expect(entries).toEqual([
      { kind: "include", pattern: "fct_*", line: 2 },
      { kind: "include", pattern: "dim_customers", line: 4 },
      { kind: "exclude", pattern: "*_tmp", line: 5 },
      { kind: "exclude", pattern: "re:.*_backup", line: 6 },
      { kind: "include", pattern: '"odd #name"', line: 7 },
      { kind: "include", pattern: "re:a#b", line: 8 },
      { kind: "include", pattern: "weird#name", line: 9 },
    ]);
  });

  test("each problem names its line and the character where it is", () => {
    const text = ["ok_table", "# fine", "  !  re:(a+)+   # nested", '"unclosed', "!", "re:(x"].join("\r\n");
    const { entries, problems } = parseTableList(text);
    expect(entries.map((e) => e.pattern)).toEqual(["ok_table"]);
    expect(problems.map((p) => [p.line, p.column])).toEqual([
      [3, 6 + checkPattern("re:(a+)+")!.offset],
      [4, 1],
      [5, 1],
      [6, 1 + checkPattern("re:(x")!.offset],
    ]);
    expect(problems[0]!.message).toContain("re:(a+)+");
    expect(problems[2]!.message).toContain('nothing after "!"');
  });

  test("a quote opens a quoted part only where a part starts, as patterns.ts reads it", () => {
    const text = ['odd"name   # a note', 'a."b #c"  # x', '"x""y #z" # c', '! "n #m".t # why', 'a.b"c #d'].join("\n");
    const { entries, problems } = parseTableList(text);
    expect(problems).toEqual([]);
    expect(entries.map((e) => e.pattern)).toEqual(['odd"name', 'a."b #c"', '"x""y #z"', '"n #m".t', 'a.b"c']);
  });

  test("combineScope adds up includes and excludes, and exclude wins", () => {
    const tables = [table("a", "fct_x"), table("a", "fct_x_tmp"), table("a", "dim_y"), table("b", "z")];
    const names = (s: Parameters<typeof filterInScope>[0]) => filterInScope(s, tables).map(qualifiedName);
    expect(names(combineScope({ include: ["fct_*"] }, [{ kind: "include", pattern: "dim_*" }, { kind: "exclude", pattern: "*_tmp" }]))).toEqual(["a.fct_x", "a.dim_y"]);
    // Only excludes: every other table stays in scope.
    expect(names(combineScope({}, [{ kind: "exclude", pattern: "b.*" }]))).toEqual(["a.fct_x", "a.fct_x_tmp", "a.dim_y"]);
    // A file include does not bring back a table the lists exclude.
    expect(names(combineScope({ exclude: ["dim_*"] }, [{ kind: "include", pattern: "a.dim_y" }]))).toEqual([]);
  });
});

describe("a 500-line file selects what the equivalent include and exclude lists select", () => {
  test("on a catalog of a few thousand tables", async () => {
    const tables = catalog();
    expect(tables.length).toBeGreaterThan(2500);
    const { text, include, exclude } = tableListFile(tables);
    expect(text.split("\n").length - 1).toBe(500);
    const noScope = (name: string) => `source: ${name}\ndialect: duckdb\nconnection:\n  database: ":memory:"\n`;
    const { root, dir } = await project({ wf: tables, wl: tables }, noScope);
    writeYaml(join(root, "sources", "wl.yaml"), { source: "wl", dialect: "duckdb", connection: { database: ":memory:" }, scope: { include, exclude } });
    writeFileSync(join(dir, "finance.txt"), text);

    const preview = await scopeJson(root, ["--source", "wf", "--from-file", join(dir, "finance.txt")]);
    expect(preview.written).toBe(false);
    expect(existsSync(join(root, "scope"))).toBe(false);
    const saved = await scopeJson(root, ["--source", "wf", "--from-file", join(dir, "finance.txt"), "--write"]);
    expect(saved.tables_file).toEqual({ path: "scope/wf.txt", include: include.length, exclude: exclude.length });
    expect(readFileSync(join(root, "scope", "wf.txt"), "utf8")).toBe(text);

    const fromFile = (await scopeJson(root, ["--source", "wf"])).tables.map((t) => t.table);
    const fromLists = (await scopeJson(root, ["--source", "wl"])).tables.map((t) => t.table);
    const direct = filterInScope({ include, exclude }, tables).map(qualifiedName).sort();
    expect(fromFile.length).toBeGreaterThan(100);
    expect(fromFile.length).toBeLessThan(tables.length / 2);
    expect(fromFile).toEqual(fromLists);
    expect([...fromFile].sort()).toEqual(direct);
    expect(preview.tables.map((t) => t.table)).toEqual(fromFile);
    expect((await sl(root, ["tables", "--source", "wf", "--json"])).json<{ in_scope: number }>().in_scope).toBe(fromFile.length);
    expect((await sl(root, ["validate"])).code).toBe(0);
  });
});

describe("sl scope --from-file", () => {
  const TABLES = [table("analytics", "fct_orders"), table("analytics", "fct_orders_backup"), table("analytics", "dim_customers"), table("raw", "stg_orders"), table("raw", "stg_payments")];

  test("--write copies the file, sets scope.tables_file and keeps the source file's comments", async () => {
    const { root, dir } = await project({ wh: TABLES });
    writeFileSync(join(dir, "list.txt"), "# staging we model\nraw.stg_orders\n!analytics.dim_customers\n");
    const r = await sl(root, ["scope", "--source", "wh", "--from-file", join(dir, "list.txt"), "--write"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("tables file: scope/wh.txt (1 include, 1 exclude)");
    expect(r.out).toContain("Copied");
    expect(readFileSync(join(root, "sources", "wh.yaml"), "utf8")).toBe(
      SOURCE_YAML("wh").replace('    - "*_backup" # never model backups\n', '    - "*_backup" # never model backups\n  tables_file: scope/wh.txt\n'),
    );
    const now = await scopeJson(root, ["--source", "wh"]);
    expect(now.tables.map((t) => t.table)).toEqual(["analytics.fct_orders", "raw.stg_orders"]);
    // The same file again changes nothing.
    const again = await sl(root, ["scope", "--source", "wh", "--from-file", join(dir, "list.txt"), "--write"]);
    expect(again.code).toBe(0);
    expect(readFileSync(join(root, "sources", "wh.yaml"), "utf8")).toContain("tables_file: scope/wh.txt\n");
  });

  test("refuses to replace a different scope/<source>.txt without --force", async () => {
    const { root, dir } = await project({ wh: TABLES });
    mkdirSync(join(root, "scope"));
    writeFileSync(join(root, "scope", "wh.txt"), "raw.stg_payments\n");
    writeFileSync(join(dir, "list.txt"), "raw.stg_orders\n");
    const refused = await sl(root, ["scope", "--source", "wh", "--from-file", join(dir, "list.txt"), "--write"]);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("already exists with other contents");
    expect(refused.err).toContain("--force");
    expect(readFileSync(join(root, "scope", "wh.txt"), "utf8")).toBe("raw.stg_payments\n");
    expect(readFileSync(join(root, "sources", "wh.yaml"), "utf8")).toBe(SOURCE_YAML("wh"));
    const forced = await sl(root, ["scope", "--source", "wh", "--from-file", join(dir, "list.txt"), "--write", "--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(join(root, "scope", "wh.txt"), "utf8")).toBe("raw.stg_orders\n");
  });

  test("a file with bad entries is refused with each line and character, and nothing is written", async () => {
    const { root, dir } = await project({ wh: TABLES });
    writeFileSync(join(dir, "bad.txt"), "raw.stg_orders\n# ok\nre:(a|aa)+\n!\n");
    const r = await sl(root, ["scope", "--source", "wh", "--from-file", join(dir, "bad.txt"), "--write"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("has 2 problems");
    expect(r.err).toMatch(/bad\.txt line 3, character \d+: /);
    expect(r.err).toContain("bad.txt line 4, character 1: ");
    expect(existsSync(join(root, "scope"))).toBe(false);
    expect(readFileSync(join(root, "sources", "wh.yaml"), "utf8")).toBe(SOURCE_YAML("wh"));
  });

  test("unmatched file entries are warnings naming their line; --remove of a file entry says to edit the file", async () => {
    const { root, dir } = await project({ wh: TABLES });
    writeFileSync(join(dir, "list.txt"), "raw.stg_orders\n\nraw.no_such_table\n");
    await sl(root, ["scope", "--source", "wh", "--from-file", join(dir, "list.txt"), "--write"]);
    const j = await scopeJson(root, ["--source", "wh", "--remove", "raw.stg_orders"]);
    expect(j.unmatched_patterns).toEqual(["raw.no_such_table"]);
    expect(j.warnings.join("\n")).toContain('Pattern "raw.no_such_table" (scope/wh.txt line 3) matches no table');
    expect(j.warnings.join("\n")).toContain('--remove "raw.stg_orders" is in the table-list file scope/wh.txt');
  });

  test("--clear drops scope.tables_file", async () => {
    const { root, dir } = await project({ wh: TABLES });
    writeFileSync(join(dir, "list.txt"), "raw.stg_orders\n");
    await sl(root, ["scope", "--source", "wh", "--from-file", join(dir, "list.txt"), "--write"]);
    const j = await scopeJson(root, ["--source", "wh", "--clear", "--include", "dim_*", "--write"]);
    expect(j.scope).toEqual({ include: ["dim_*"] });
    expect(readFileSync(join(root, "sources", "wh.yaml"), "utf8")).not.toContain("tables_file");
  });
});

describe("sl scope --to-file", () => {
  // Names a plain spelling would misread, and two tables that differ only in case.
  const TRICKY = [
    table("analytics", "fct_orders"),
    table("analytics", "fct_orders_tmp"),
    table("analytics", "!bang"),
    table("analytics", "#hash"),
    table("analytics", "re:literal"),
    table("analytics", "has #space"),
    table("analytics", 'quo"te'),
    table("analytics", "star*name"),
    table("analytics", "dotted.name"),
    table("Sales", "OrderBook"),
    table("sales", "orderbook"),
    table("raw", "stg_orders"),
  ];

  test("round trip: --to-file then --from-file gives the same selection", async () => {
    const { root } = await project({ wh: TRICKY, wl: TRICKY });
    const first = await scopeJson(root, ["--source", "wh", "--include", '"Sales".*', "--exclude", "*_tmp", "--write"]);
    const selected = first.tables.map((t) => t.table);
    expect(selected).toContain("Sales.OrderBook");
    expect(selected).not.toContain("sales.orderbook");
    expect(selected).not.toContain("analytics.fct_orders_tmp");

    const out = await sl(root, ["scope", "--source", "wh", "--to-file", "scope/agreed.txt"]);
    expect(out.code).toBe(0);
    expect(out.out).toContain(`Wrote ${selected.length} tables to scope/agreed.txt.`);
    expect(out.out).toContain("--from-file");
    const text = readFileSync(join(root, "scope", "agreed.txt"), "utf8");
    expect(text.startsWith("# Tables in scope for source wh")).toBe(true);
    expect(text).toContain('"Sales"."OrderBook"\n');
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(lines).toEqual([...lines].sort());
    expect(lines.length).toBe(selected.length);
    // Deterministic: the same selection writes the same bytes, so a rerun needs no --force.
    expect((await sl(root, ["scope", "--source", "wh", "--to-file", "scope/agreed.txt"])).code).toBe(0);

    // The YAML of wl has the same include and exclude as SOURCE_YAML; the file alone must not widen it.
    const back = await scopeJson(root, ["--source", "wl", "--clear", "--from-file", join(root, "scope", "agreed.txt"), "--write"]);
    expect(back.tables.map((t) => t.table)).toEqual(selected);
    expect(back.unmatched_patterns).toEqual([]);
    // And on the source that wrote it, joined to its own lists.
    const same = await scopeJson(root, ["--source", "wh", "--from-file", join(root, "scope", "agreed.txt")]);
    expect(same.tables.map((t) => t.table)).toEqual(selected);
  });

  test("renderTableList reads back as exactly the selection", () => {
    const tables = catalog();
    const selected = tables.filter((_, i) => i % 3 === 0);
    const { entries, problems } = parseTableList(renderTableList("wh", selected, tables));
    expect(problems).toEqual([]);
    expect(filterInScope(combineScope({}, entries), tables)).toEqual(selected);
  });

  test("a name with a letter outside ASCII is quoted, so case folding cannot widen it; a line break is refused", () => {
    const all = [table("a", "xσ"), table("a", "xς"), table("a", "café"), table("a", "CAFÉ")];
    for (const selected of [[all[0]!], [all[2]!]]) {
      const { entries } = parseTableList(renderTableList("wh", selected, all));
      expect(filterInScope(combineScope({}, entries), all)).toEqual(selected);
    }
    const broken = [table("a", "x\nb"), table("a", "b")];
    expect(() => renderTableList("wh", broken, broken)).toThrow("line break");
  });

  test("writes a file whose name starts with .., keeps a plain file, and refuses a symbolic link", async () => {
    const { root, dir } = await project({ wh: TRICKY });
    const dots = await sl(root, ["scope", "--source", "wh", "--to-file", "..notes.txt"]);
    expect(dots.code).toBe(0);
    expect(existsSync(join(root, "..notes.txt"))).toBe(true);
    writeFileSync(join(dir, "outside.txt"), "x\n");
    symlinkSync(join(dir, "outside.txt"), join(root, "link.txt"));
    symlinkSync(join(dir, "nope.txt"), join(root, "dangling.txt"));
    for (const target of ["link.txt", "dangling.txt"]) {
      const r = await sl(root, ["scope", "--source", "wh", "--to-file", target, "--force"]);
      expect(r.code).not.toBe(0);
    }
    expect(readFileSync(join(dir, "outside.txt"), "utf8")).toBe("x\n");
    expect(existsSync(join(dir, "nope.txt"))).toBe(false);
  });

  test("refuses outside the root, the files sl manages, an empty selection and a different existing file", async () => {
    const { root } = await project({ wh: TRICKY });
    for (const [path, message] of [
      ["../out.txt", "outside the semantic root"],
      ["/tmp/out.txt", "absolute path"],
      ["sources/wh.yaml", "files sl manages"],
      ["semantic.yaml", "files sl manages"],
    ] as const) {
      const r = await sl(root, ["scope", "--source", "wh", "--to-file", path]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(message);
    }
    const empty = await sl(root, ["scope", "--source", "wh", "--clear", "--include", "nothing_*", "--to-file", "x.txt"]);
    expect(empty.err).toContain("nothing to write");
    writeFileSync(join(root, "x.txt"), "keep me\n");
    const r = await sl(root, ["scope", "--source", "wh", "--to-file", "x.txt"]);
    expect(r.err).toContain("already exists with other contents");
    expect(readFileSync(join(root, "x.txt"), "utf8")).toBe("keep me\n");
    expect((await sl(root, ["scope", "--source", "wh", "--to-file", "x.txt", "--force"])).code).toBe(0);
    const both = await sl(root, ["scope", "--source", "wh", "--to-file", "y.txt", "--from-file", "x.txt"]);
    expect(both.err).toContain("not both");
  });
});

describe("table-list files stay inside the semantic root", () => {
  test("a scope/ directory that links outside the root is refused for --from-file --write and --to-file", async () => {
    const { root, dir } = await project({ wh: [table("analytics", "fct_orders")] });
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(root, "scope"));
    writeFileSync(join(dir, "list.txt"), "raw.stg_orders\n");
    const from = await sl(root, ["scope", "--source", "wh", "--from-file", join(dir, "list.txt"), "--write"]);
    expect(from.code).not.toBe(0);
    expect(from.err).toContain("through a link");
    const to = await sl(root, ["scope", "--source", "wh", "--to-file", "scope/out.txt"]);
    expect(to.err).toContain("through a link");
    expect(readdirSync(join(dir, "elsewhere"))).toEqual([]);
    expect(readFileSync(join(root, "sources", "wh.yaml"), "utf8")).toBe(SOURCE_YAML("wh"));
  });
});

describe("validate checks scope.tables_file", () => {
  const TABLES = [table("analytics", "fct_orders"), table("raw", "stg_orders")];
  const withFile = (file: string) => (name: string) => `${SOURCE_YAML(name).replace("# Profile settings", `  tables_file: ${file}\n# Profile settings`)}`;

  test("a missing file is an error naming sl scope --from-file, and commands stop with the same fix", async () => {
    const { root } = await project({ wh: TABLES }, withFile("scope/wh.txt"));
    const v = await sl(root, ["validate", "--json"]);
    expect(v.code).toBe(1);
    const issue = v.json<{ issues: { file: string; path: string; message: string }[] }>().issues.find((i) => i.path === "scope.tables_file")!;
    expect(issue.file).toBe("sources/wh.yaml");
    expect(issue.message).toContain("sl scope --source wh --from-file <path> --write");
    for (const args of [["tables", "--source", "wh"], ["status"], ["draft", "--source", "wh"], ["baseline", "--source", "wh"], ["scope", "--source", "wh"]]) {
      const r = await sl(root, args);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("--from-file <path> --write");
    }
  });

  test("bad entries are errors at their line and character in the file", async () => {
    const { root } = await project({ wh: TABLES }, withFile("scope/wh.txt"));
    mkdirSync(join(root, "scope"));
    writeFileSync(join(root, "scope", "wh.txt"), "# list\nraw.stg_orders\n\n  re:(a*)*\n");
    const v = await sl(root, ["validate", "--json"]);
    expect(v.code).toBe(1);
    const issues = v.json<{ issues: { file: string; path: string; message: string }[] }>().issues.filter((i) => i.file === "scope/wh.txt");
    expect(issues.map((i) => i.path)).toEqual([`line 4, character ${3 + checkPattern("re:(a*)*")!.offset}`]);
    const r = await sl(root, ["tables", "--source", "wh"]);
    expect(r.err).toContain("scope/wh.txt line 4, character");
  });

  test("a tables_file that is a directory or not a string is a plain error, and --clear --write recovers", async () => {
    for (const value of ["scope", "5", "[a, b]"]) {
      const { root } = await project({ wh: TABLES }, withFile(value));
      mkdirSync(join(root, "scope"), { recursive: true });
      const v = await sl(root, ["validate", "--json"]);
      expect(v.code).toBe(1);
      const issue = v.json<{ issues: { path: string; message: string }[] }>().issues.find((i) => i.path === "scope.tables_file")!;
      expect(issue.message).toMatch(value === "scope" ? /is not a file/ : /must be string/);
      for (const args of [["tables", "--source", "wh"], ["status"], ["scope", "--source", "wh"]]) {
        const r = await sl(root, args);
        expect(r.code).toBe(1);
        expect(r.err).not.toMatch(/unexpected error|EISDIR|TypeError/);
        expect(r.err).toContain("sl scope --source wh --clear --write");
      }
      const c = await sl(root, ["scope", "--source", "wh", "--clear", "--write"]);
      expect(c.code).toBe(0);
      expect(readFileSync(join(root, "sources", "wh.yaml"), "utf8")).not.toContain("tables_file");
      expect((await sl(root, ["validate"])).code).toBe(0);
      cleanup?.();
      cleanup = undefined;
    }
  });

  test("--from-file --write into a source with no scope adds scope.tables_file and keeps comments", async () => {
    const plain = (name: string) => `# top\nsource: ${name}\ndialect: duckdb\nconnection:\n  database: ":memory:"\n# end comment\n`;
    const { root, dir } = await project({ wh: TABLES }, plain);
    writeFileSync(join(dir, "l.txt"), "raw.stg_orders\n");
    expect((await sl(root, ["scope", "--source", "wh", "--from-file", join(dir, "l.txt"), "--write"])).code).toBe(0);
    const y = readFileSync(join(root, "sources", "wh.yaml"), "utf8");
    expect(y).toContain("# top");
    expect(y).toContain("# end comment");
    expect(y).toContain("tables_file: scope/wh.txt");
    expect((await scopeJson(root, ["--source", "wh"])).tables.map((t) => t.table)).toEqual(["raw.stg_orders"]);
    expect((await sl(root, ["validate"])).code).toBe(0);
  });

  test("a path outside the root is an error", async () => {
    const { root } = await project({ wh: TABLES }, withFile("../outside.txt"));
    const v = await sl(root, ["validate", "--json"]);
    const issue = v.json<{ issues: { path: string; message: string }[] }>().issues.find((i) => i.path === "scope.tables_file")!;
    expect(issue.message).toContain("outside the semantic root");
  });
});

describe("every command that decides scope reads the table-list file", () => {
  const TABLES = [
    table("analytics", "fct_orders"),
    table("analytics", "dim_customers"),
    table("analytics", "dim_products"),
    table("raw", "stg_orders"),
    table("raw", "stg_payments"),
  ];
  const yaml = (name: string) => `source: ${name}\ndialect: duckdb\nconnection:\n  database: ":memory:"\nscope:\n  include: [analytics.fct_orders]\n  tables_file: scope/${name}.txt\n`;

  test("tables, status, draft, profile and baseline", async () => {
    const { root } = await project({ wh: TABLES }, yaml);
    mkdirSync(join(root, "scope"));
    writeFileSync(join(root, "scope", "wh.txt"), "dim_*\n!analytics.dim_products\nraw.stg_payments\n");
    const want = ["analytics.dim_customers", "analytics.fct_orders", "raw.stg_payments"];
    expect((await sl(root, ["tables", "--source", "wh", "--json"])).json<{ in_scope: number }>().in_scope).toBe(3);
    const status = (await sl(root, ["status", "--json"])).json<{ sources: { snapshot: { in_scope: number } }[] }>();
    expect(status.sources[0]!.snapshot.in_scope).toBe(3);
    expect((await sl(root, ["baseline", "--source", "wh", "--json"])).json<{ in_scope: number }>().in_scope).toBe(3);
    const draft = await sl(root, ["draft", "--source", "wh"]);
    expect(draft.code).toBe(0);
    const drafted = readdirSync(join(root, "models", "wh")).sort();
    expect(drafted.length).toBe(want.length);
    const profile = await sl(root, ["profile", "--source", "wh", "--tables", "analytics.dim_products"]);
    expect(profile.err).toContain("out of scope");
  });

  test("no command reads a source's scope without effectiveScope", () => {
    // A raw source.scope or config.scope handed to the scope helpers would leave the file out.
    const dir = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts");
    const allowed = new Set(["commands/scope.ts", "lib/table-list.ts", "lib/validate.ts", "lib/types.ts"]);
    const files: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else if (r.endsWith(".ts")) files.push(r);
      }
    };
    walk("");
    const bad = files.filter((f) => !allowed.has(f) && /\b(source|config|src|s|l\.data)\??\.scope\b/.test(readFileSync(join(dir, f), "utf8")));
    expect(bad).toEqual([]);
  });
});

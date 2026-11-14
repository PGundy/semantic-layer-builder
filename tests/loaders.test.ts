import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { listGoldens, listModels, loadAccess, loadMetrics, loadModel, loadProject, loadSnapshot, loadSource } from "../skills/semantic-layer/scripts/lib/project.ts";
import { schemaIssues, shapeIssue, shapeMessage } from "../skills/semantic-layer/scripts/lib/schema.ts";
import { schemaIssues as fromValidate } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import { type CliRun, sl, tempDir, tempRoot } from "./helpers.ts";

// Malformed layer files (HR-7): every loader checks a file's shape against its schema as it loads
// it, so a malformed file is one plain line and exit code 1 from every command, never a TypeError
// with a stack trace, and with --json one JSON object. All data is synthetic.

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const FIX = "Fix the file, or run sl validate for the full list.";

type Tree = Map<string, Buffer>;

function readTree(root: string): Tree {
  const out: Tree = new Map();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p), readFileSync(p));
    }
  };
  walk(root);
  return out;
}

function writeTree(root: string, tree: Tree): void {
  rmSync(root, { recursive: true, force: true });
  for (const [file, bytes] of tree) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), bytes);
  }
}

// The Acme example layer with one readback waiting for the owner and one answered and recorded
// in the ledger, so every file kind the tool loads is present.
let BASE: Tree;

async function baseTree(): Promise<Tree> {
  const root = join(tempDir(), "semantic");
  cpSync(ACME, root, { recursive: true });
  const ok = (r: CliRun) => {
    if (r.code !== 0) throw new Error(r.err);
    return r;
  };
  const answered = ok(await sl(root, ["readback", "--targets", "warehouse.orders.revenue", "--json"])).json<{ readback_id: string }>().readback_id;
  ok(await sl(root, ["reply", "--readback", answered, "--item", "1", "--text", "Yes, that is revenue.", "--by", "Dana Ruiz", "--verdict", "yes"]));
  ok(await sl(root, ["readback", "--targets", "warehouse.orders", "--json"]));
  return readTree(root);
}

beforeAll(async () => {
  BASE = await baseTree();
});

// A copy of the base layer with some files replaced (null removes one).
function layer(changes: Record<string, string | Buffer | null> = {}): string {
  const { root } = tempRoot();
  const tree = new Map(BASE);
  for (const [file, bytes] of Object.entries(changes)) {
    if (bytes === null) tree.delete(file);
    else tree.set(file, Buffer.from(bytes));
  }
  writeTree(root, tree);
  return root;
}

const STACK_LINE = /^\s+at .+(\(|:\d+:\d+)/m;

// The refusals that are not about a file's shape, which --json leaves as one plain line. A file
// that loads can still lack what a command was asked for: a readback target its model does not
// hold, a golden whose name or source is not there, and the focus threshold a semantic.yaml
// without settings applies.
const OWN_REFUSALS = [
  /^sl readback: Unknown target "(warehouse\.orders\.revenue|metric:average_order_value|access)": .* Run sl status /,
  /^sl readback: revenue_2025\.yaml holds a golden named /,
  /^sl readback: Golden "revenue_2025" has no request\.source\./,
  /^sl draft: \d+ in-scope tables in "warehouse" have no model, more than the focus threshold of \d+\. /,
];

// What every run must hold to, whatever the files look like.
function problems(r: CliRun, root: string, command: string, json: boolean): string[] {
  const out: string[] = [];
  if (r.code !== 0 && r.code !== 1) out.push(`exit code ${r.code}`);
  if (STACK_LINE.test(r.err)) out.push("a stack trace on stderr");
  if (/TypeError|unexpected error/.test(r.err + r.out)) out.push(`an unexpected error: ${(r.err + r.out).split("\n").find((l) => /TypeError|unexpected error/.test(l))}`);
  if (r.code === 1 && !r.err.trim() && !r.out.trim()) out.push("exit code 1 with no message");
  // A refused file is the last line of stderr, whole, and names the file from the semantic root.
  const refused = r.err.split("\n").findIndex((l) => l.includes(FIX));
  const line = r.err.split("\n")[refused] ?? "";
  if (refused >= 0 && (refused !== r.err.split("\n").length - 1 || !line.startsWith(`sl ${command}: `) || !line.endsWith(FIX) || line.includes(root))) out.push(`a refused file that is not one line from the semantic root: ${r.err.slice(0, 300)}`);
  if (refused >= 0 && r.code !== 1) out.push("a refused file with exit code 0");
  // Nothing of a file's bytes reaches the terminal as a control character.
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(r.err + r.out)) out.push("a control character in the output");
  if (json) {
    // A malformed file and a missing layer are a JSON object; of the other refusals, only the known ones stay plain.
    if (r.code === 1 && r.out === "") {
      const refusal = r.err.split("\n").find((l) => l.startsWith(`sl ${command}: `)) ?? "";
      if (!OWN_REFUSALS.some((known) => known.test(refusal))) out.push(`a refusal with no JSON object: ${r.err.slice(0, 200)}`);
      return out;
    }
    let data: unknown;
    try {
      data = JSON.parse(r.out);
    } catch {
      out.push(`stdout is not one JSON value: ${JSON.stringify(r.out.slice(0, 80))}`);
      return out;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) out.push("stdout is not a JSON object");
    else if ("error" in data) {
      const e = data as { error: unknown; next?: unknown };
      if (typeof e.error !== "string" || !e.error) out.push("error is not a message");
      if (r.code !== 1) out.push("a JSON error with exit code 0");
      if (typeof e.error === "string" && e.error.includes(FIX) && e.next !== "sl validate") out.push("a shape error whose next is not sl validate");
      if (typeof e.error === "string" && !r.err.endsWith(`sl ${command}: ${e.error}`)) out.push("a JSON error that is not the refusal on stderr");
    } else if (refused >= 0) out.push("a refused file whose JSON has no error");
  }
  return out;
}

// The commands the acceptance names, as an agent runs them on the Acme layer.
const COMMANDS_RUN: string[][] = [
  ["status"],
  ["next"],
  ["validate"],
  ["readback", "--targets", "warehouse.orders,warehouse.orders.revenue,metric:average_order_value,access,golden:revenue_2025", "--results", "results.json"],
  ["draft", "--source", "warehouse"],
  ["brief", "--source", "warehouse", "--tables", "acme.fct_orders"],
  ["access", "--roles", "sales", "--user", '{"department":"sales","employee_id":101}'],
];

type Format = "yaml" | "json" | "jsonl";

interface FileKind {
  kind: string;
  file: string;
  format: Format;
  // Variants of this kind only: wrong nested types that a general rewrite does not reach.
  extra?: Record<string, string>;
}

const KINDS: FileKind[] = [
  { kind: "semantic.yaml", file: "semantic.yaml", format: "yaml", extra: { "settings a list": "version: 1\nname: acme\nsettings: [12, 5]\n", "name a map": "version: 1\nname: {a: 1}\n" } },
  {
    kind: "a source",
    file: "sources/warehouse.yaml",
    format: "yaml",
    extra: { "connection a string": "source: warehouse\ndialect: postgres\nconnection: PG_URL\n", "scope a list": "source: warehouse\ndialect: postgres\nscope: [acme.*]\n" },
  },
  {
    kind: "a snapshot",
    file: "snapshots/warehouse.json",
    format: "json",
    extra: {
      "no tables": JSON.stringify({ snapshot_version: 1, source: "warehouse", dialect: "postgres", captured_at: "2026-01-01T00:00:00.000Z", method: "live" }),
      "tables a map": JSON.stringify({ snapshot_version: 1, source: "warehouse", dialect: "postgres", captured_at: "2026-01-01T00:00:00.000Z", method: "live", tables: { a: 1 } }),
      "a table with no columns": JSON.stringify({ snapshot_version: 1, source: "warehouse", dialect: "postgres", captured_at: "2026-01-01T00:00:00.000Z", method: "live", tables: [{ schema: "acme", name: "fct_orders", kind: "table" }] }),
    },
  },
  {
    kind: "a model",
    file: "models/warehouse/orders.yaml",
    format: "yaml",
    extra: {
      "dimensions a map": "model: orders\nsource: warehouse\ntable: acme.fct_orders\nstatus: draft\ndimensions: {a: 1}\nmeasures: []\n",
      "measures a string": "model: orders\nsource: warehouse\ntable: acme.fct_orders\nstatus: draft\ndimensions: []\nmeasures: revenue\n",
      "no dimensions or measures": "model: orders\nsource: warehouse\ntable: acme.fct_orders\nstatus: draft\n",
    },
  },
  { kind: "metrics.yaml", file: "metrics.yaml", format: "yaml", extra: { "metrics: 5": "metrics: 5\n", "metrics a map": "metrics:\n  average_order_value: {type: ratio}\n" } },
  { kind: "access.yaml", file: "access.yaml", format: "yaml", extra: { "roles a map": "status: draft\nmode: open\nroles:\n  sales: {assign_when: \"user.department == 'sales'\"}\n", "mode a list": "status: draft\nmode: [open]\n" } },
  { kind: "a golden", file: "goldens/revenue_2025.yaml", format: "yaml", extra: { "request a string": "name: revenue_2025\nquestion: Revenue?\nrequest: orders.revenue\nstatus: draft\n", "expected a list": "name: revenue_2025\nquestion: Revenue?\nrequest: {source: warehouse, measures: [orders.revenue]}\nstatus: approved\nexpected: [1]\n" } },
  { kind: "the ledger", file: ".sl/ledger.jsonl", format: "jsonl" },
  { kind: "a pending readback", file: ".sl/pending/rb_0002.json", format: "json", extra: { "items a map": '{"readback_id":"rb_0002","created_at":"2026-01-15T12:00:00.000Z","items":{"n":1}}' } },
];

const GARBAGE = Buffer.from(Array.from({ length: 96 }, (_, i) => [0x00, 0xff, 0xfe, 0x80, 0x1b, 0xc3, 0x28, 0x7b, 0x5b, 0x22, 0x0a, 0x09][(i * 7) % 12]!));

// Rewrites every value at one level of a document: the top-level values, each list's items, or each leaf.
function rewrite(v: unknown, where: "top" | "items" | "leaves", to: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return where === "items" ? v.map(() => to) : v.map((x) => rewrite(x, where, to, depth + 1));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, where === "top" && depth === 0 ? to : rewrite(x, where, to, depth + 1)]));
  }
  return where === "leaves" ? to : v;
}

// About ten malformed variants of one file, by name.
function variants(k: FileKind, valid: string): Record<string, string | Buffer> {
  const yaml = k.format === "yaml";
  const out: Record<string, string | Buffer> = {
    empty: "",
    null: yaml ? "null\n" : "null",
    "a number": "5\n",
    "a string": yaml ? "just some words\n" : '"just some words"',
    "a list": yaml ? "- a\n- b\n" : '["a", "b"]',
    "binary garbage": GARBAGE,
    "a syntax error": yaml ? "name: [1, 2\n  b: : :\n\t- x: {\n" : '{"readback_id": "rb_0002", "items": [',
  };
  const docs: unknown[] = k.format === "jsonl" ? valid.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [yaml ? parseYamlText(valid) : JSON.parse(valid)];
  // JSON is YAML too, so a rewritten YAML document is written as JSON.
  const render = (ds: unknown[]) => (k.format === "jsonl" ? ds.map((d) => `${JSON.stringify(d)}\n`).join("") : JSON.stringify(ds[0], null, 2));
  const shapes: [string, "top" | "items" | "leaves", unknown][] = [
    ["every top-level value null", "top", null],
    ["every top-level value a number", "top", 5],
    ["every top-level value a list", "top", [5, null, "x"]],
    ["every top-level value a map", "top", { a: { b: 1 } }],
    ["every list item a string", "items", "x"],
    ["every list item null", "items", null],
    ["every leaf a list", "leaves", [{ a: 1 }]],
    ["every leaf a map", "leaves", { a: 1 }],
  ];
  for (const [name, where, to] of shapes) out[name] = render(docs.map((d) => rewrite(d, where, to)));
  if (k.format === "jsonl") {
    out["a line cut off"] = valid.slice(0, valid.length - 40);
    out["lines that are not objects"] = 'null\n5\n"words"\n[1, 2]\n';
  }
  return { ...out, ...k.extra };
}

// The rows of the golden's two queries, so its readback needs no database.
const ROW = { revenue: 301050.82, order_count: 2239, average_order_value: 134.45771326485038 };
const RESULTS = JSON.stringify({ "golden:revenue_2025": [ROW], "golden:revenue_2025:cross_check": [ROW] });

async function runAll(root: string): Promise<string[]> {
  const failures: string[] = [];
  for (const json of [false, true]) {
    for (const args of COMMANDS_RUN) {
      const r = await sl(root, json ? [...args, "--json"] : args);
      for (const p of problems(r, root, args[0]!, json)) failures.push(`sl ${args[0]}${json ? " --json" : ""}: ${p}`);
    }
  }
  return failures;
}

describe("the commands on the well-formed layer", () => {
  test("each of the seven succeeds, with and without --json", async () => {
    const root = layer({ "results.json": RESULTS });
    expect(await runAll(root)).toEqual([]);
    for (const args of COMMANDS_RUN) {
      for (const json of [false, true]) {
        const r = await sl(layer({ "results.json": RESULTS }), json ? [...args, "--json"] : args);
        expect({ args, json, code: r.code, err: r.err }).toEqual({ args, json, code: 0, err: "" });
      }
    }
  });
});

describe("malformed files, each kind in about ten shapes, under seven commands with and without --json", () => {
  for (const k of KINDS) {
    test(
      k.kind,
      async () => {
        const failures: string[] = [];
        const all = variants(k, BASE.get(k.file)!.toString("utf8"));
        expect(Object.keys(all).length).toBeGreaterThanOrEqual(10);
        for (const [name, bytes] of Object.entries(all)) {
          const root = layer({ "results.json": RESULTS, [k.file]: bytes });
          for (const f of await runAll(root)) failures.push(`${k.file} (${name}): ${f}`);
          // sl validate lists the file among its errors, in a list that goes on past it.
          const v = await sl(root, ["validate", "--json"]);
          const report = v.code === 1 || v.code === 0 ? (JSON.parse(v.out) as { issues?: { level: string; file: string }[]; error?: string }) : {};
          const named = report.issues?.some((i) => i.level === "error" && i.file === k.file) || report.error?.includes(k.file);
          // An empty ledger has no answers yet, and a file with no list in it, or only lists of
          // text, can come through a rewrite of its list items still well formed.
          if ((k.format === "jsonl" && name === "empty") || name.startsWith("every list item")) continue;
          if (!(v.code === 1 && named)) failures.push(`${k.file} (${name}): sl validate does not name the file as an error (exit ${v.code})`);
          if (!report.issues) failures.push(`${k.file} (${name}): sl validate stops instead of listing (${report.error})`);
        }
        expect(failures).toEqual([]);
      },
      120_000,
    );
  }
});

describe("the four cases of the gap review", () => {
  const cases: { name: string; file: string; text: string; message: string }[] = [
    { name: "an empty model file", file: "models/warehouse/orders.yaml", text: "", message: `models/warehouse/orders.yaml: the file should be a map (found an empty file). ${FIX}` },
    {
      name: "a snapshot with no tables",
      file: "snapshots/warehouse.json",
      text: JSON.stringify({ snapshot_version: 1, source: "warehouse", dialect: "postgres", captured_at: "2026-01-01T00:00:00.000Z", method: "live" }),
      message: `snapshots/warehouse.json: tables should be a list (found nothing). ${FIX}`,
    },
    { name: "metrics: 5", file: "metrics.yaml", text: "metrics: 5\n", message: `metrics.yaml: metrics should be a list (found a number). ${FIX}` },
    { name: "a list where semantic.yaml wants a map", file: "semantic.yaml", text: "- version: 1\n- name: acme\n", message: `semantic.yaml: the file should be a map (found a list). ${FIX}` },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const root = layer({ "results.json": RESULTS, [c.file]: c.text });
      const plain = await sl(root, ["status"]);
      expect(plain).toMatchObject({ code: 1, out: "", err: `sl status: ${c.message}` });
      const json = await sl(root, ["status", "--json"]);
      expect(json.code).toBe(1);
      expect(json.json()).toEqual({ error: c.message, next: "sl validate" });
      expect(json.err).toBe(`sl status: ${c.message}`);
      // sl validate goes on past the file and lists it with everything else it finds.
      const v = await sl(root, ["validate", "--json"]);
      expect(v.code).toBe(1);
      expect(v.json<{ issues: { level: string; file: string }[] }>().issues.filter((i) => i.level === "error" && i.file === c.file).length).toBeGreaterThan(0);
      expect(await runAll(root)).toEqual([]);
    });
  }

  test("sl validate lists several malformed files in one run", async () => {
    const root = layer({ "metrics.yaml": "metrics: 5\n", "models/warehouse/orders.yaml": "", "goldens/revenue_2025.yaml": "- a\n", "snapshots/lake.json": "[]" });
    const v = await sl(root, ["validate", "--json"]);
    expect(v.code).toBe(1);
    const files = new Set(v.json<{ issues: { level: string; file: string }[] }>().issues.filter((i) => i.level === "error").map((i) => i.file));
    for (const f of ["metrics.yaml", "models/warehouse/orders.yaml", "goldens/revenue_2025.yaml", "snapshots/lake.json"]) expect(files).toContain(f);
  });
});

describe("no semantic root", () => {
  for (const command of ["status", "next", "validate"]) {
    test(`sl ${command} --json prints a JSON error naming sl init`, async () => {
      const { root } = tempRoot();
      const r = await sl(root, [command, "--json"]);
      expect(r.code).toBe(1);
      const data = r.json<{ error: string; next: string }>();
      expect(Object.keys(data).sort()).toEqual(["error", "next"]);
      expect(data.error).toContain("No semantic layer at");
      expect(data.error).toContain("sl init --name <name>");
      expect(data.next).toBe("sl init --name <name>");
      expect(r.err).toBe(`sl ${command}: ${data.error}`);
      const plain = await sl(root, [command]);
      expect(plain).toMatchObject({ code: 1, out: "", err: r.err });
    });
  }

  test("a refusal that names no next command stays one plain line under --json", async () => {
    const r = await sl(layer(), ["status", "--source", "nope", "--json"]);
    expect(r).toMatchObject({ code: 1, out: "", err: 'sl status: Unknown source "nope". Known sources: lake, warehouse.' });
    const flag = await sl(layer(), ["status", "--json", "--no-such-flag"]);
    expect(flag).toMatchObject({ code: 1, out: "" });
    expect(flag.err).toStartWith("sl status: ");
  });
});

describe("the loaders", () => {
  test("each returns the file when its shape is right", () => {
    const root = layer();
    expect(loadProject(root).name).toBe("acme");
    expect(loadSource(root, "warehouse").dialect).toBe("postgres");
    expect(loadSnapshot(root, "warehouse")!.tables.length).toBeGreaterThan(0);
    expect(listModels(root).length).toBe(12);
    expect(loadMetrics(root).metrics.length).toBeGreaterThan(0);
    expect(loadAccess(root)!.mode).toBe("open");
    expect(listGoldens(root).length).toBeGreaterThan(0);
  });

  test("each names the file from the root, the place, what was expected and what was found", () => {
    const snapshot = (rest: string) => `{"snapshot_version": 1, "source": "warehouse", "dialect": "postgres", "captured_at": "2026-01-01T00:00:00.000Z", "method": "live"${rest}}`;
    const cases: [Record<string, string>, (root: string) => unknown, string][] = [
      [{ "semantic.yaml": "version: 1\nname: acme\nsettings: 5\n" }, loadProject, "semantic.yaml: settings should be a map (found a number)."],
      [{ "semantic.yaml": "version: 1\nname: {a: 1}\n" }, loadProject, "semantic.yaml: name should be text (found a map)."],
      [{ "semantic.yaml": "version: 1\nname: acme\nsettings: {batch_size: {a: 1}}\n" }, loadProject, "semantic.yaml: settings.batch_size should be a whole number (found a map)."],
      [{ "semantic.yaml": "" }, loadProject, "semantic.yaml: the file should be a map (found an empty file)."],
      [{ "sources/warehouse.yaml": "source: warehouse\ndialect: postgres\nconnection: [a]\n" }, (r) => loadSource(r, "warehouse"), "sources/warehouse.yaml: connection should be a map (found a list)."],
      [{ "sources/warehouse.yaml": "source: warehouse\ndialect: {}\n" }, (r) => loadSource(r, "warehouse"), "sources/warehouse.yaml: dialect should be one of duckdb, postgres, snowflake, bigquery, databricks (found a map)."],
      [{ "sources/warehouse.yaml": "source: warehouse\ndialect: postgres\nscope: {include: [[a]]}\n" }, (r) => loadSource(r, "warehouse"), "sources/warehouse.yaml: scope.include[0] should be text (found a list)."],
      [{ "sources/warehouse.yaml": "just some words\n" }, (r) => loadSource(r, "warehouse"), "sources/warehouse.yaml: the file should be a map (found text)."],
      [{ "snapshots/warehouse.json": snapshot(', "tables": "none"') }, (r) => loadSnapshot(r, "warehouse"), "snapshots/warehouse.json: tables should be a list (found text)."],
      [{ "snapshots/warehouse.json": snapshot(', "tables": null') }, (r) => loadSnapshot(r, "warehouse"), "snapshots/warehouse.json: tables should be a list (found nothing)."],
      [{ "snapshots/warehouse.json": snapshot(', "tables": [], "scope_state": []') }, (r) => loadSnapshot(r, "warehouse"), "snapshots/warehouse.json: scope_state should be a map (found a list)."],
      [{ "snapshots/warehouse.json": snapshot(', "tables": [{"schema": "acme", "name": "fct_orders", "kind": "table"}]') }, (r) => loadSnapshot(r, "warehouse"), "snapshots/warehouse.json: tables[0].columns should be a list (found nothing)."],
      [{ "snapshots/warehouse.json": snapshot(', "tables": [{"schema": "acme", "name": "fct_orders", "kind": "table", "columns": [{"name": "id", "type": "integer"}, 7]}]') }, (r) => loadSnapshot(r, "warehouse"), "snapshots/warehouse.json: tables[0].columns[1] should be a map (found a number)."],
      [{ "models/lake/sessions.yaml": "model: sessions\nsource: lake\ntable: sessions\nstatus: draft\ndimensions: []\nmeasures: revenue\n" }, (r) => listModels(r), "models/lake/sessions.yaml: measures should be a list (found text)."],
      [{ "models/lake/sessions.yaml": "model: sessions\nsource: lake\ntable: sessions\nstatus: draft\ndimensions: [x, null]\nmeasures: []\n" }, (r) => listModels(r), "models/lake/sessions.yaml: dimensions[0] should be a map (found text)."],
      [{ "models/lake/sessions.yaml": "model: sessions\nsource: lake\ntable: sessions\nstatus: draft\ndimensions: []\nmeasures: [null]\n" }, (r) => loadModel(r, "lake", "sessions"), "models/lake/sessions.yaml: measures[0] should be a map (found nothing)."],
      [{ "models/lake/sessions.yaml": "model: sessions\nsource: lake\nstatus: draft\ndimensions: []\nmeasures: []\n" }, (r) => listModels(r, "lake"), "models/lake/sessions.yaml: table should be text (found nothing)."],
      [{ "models/lake/sessions.yaml": "# nothing yet\n" }, (r) => listModels(r, "lake"), "models/lake/sessions.yaml: the file should be a map (found an empty file)."],
      [{ "metrics.yaml": "metrics: [null, x, 5]\n" }, loadMetrics, "metrics.yaml: metrics[1] should be a map (found text)."],
      [{ "metrics.yaml": "- name: a\n" }, loadMetrics, "metrics.yaml: the file should be a map (found a list)."],
      [{ "access.yaml": "true\n" }, loadAccess, "access.yaml: the file should be a map (found true or false)."],
      [{ "access.yaml": "- roles\n" }, loadAccess, "access.yaml: the file should be a map (found a list)."],
      [{ "goldens/revenue_2025.yaml": "name: revenue_2025\nquestion: Q\nrequest: 5\nstatus: draft\n" }, listGoldens, "goldens/revenue_2025.yaml: request should be a map (found a number)."],
    ];
    for (const [changes, load, message] of cases) {
      const root = layer(changes);
      expect(() => load(root)).toThrow(`${message} ${FIX}`);
    }
  });

  test("a file that does not parse is refused in one line, from the root, with the parser's first line", async () => {
    const cases: [string, string, string][] = [
      ["metrics.yaml", "---\nmetrics: []\n---\nmetrics: []\n", "metrics.yaml: is not valid YAML (Source contains multiple documents; please use YAML.parseAllDocuments() at line 3, column 1)."],
      // The parser's later lines quote the file; none of them is printed.
      ["sources/warehouse.yaml", 'source: warehouse\ndescription: "never closed synthetic words\n', 'sources/warehouse.yaml: is not valid YAML (Missing closing "quote at line 3, column 1).'],
      ["snapshots/warehouse.json", '{"snapshot_version": 1, "tables": [', "snapshots/warehouse.json: is not valid JSON (JSON Parse error: Unexpected EOF)."],
    ];
    for (const [file, text, message] of cases) {
      const root = layer({ [file]: text });
      const plain = await sl(root, ["status"]);
      expect(plain).toMatchObject({ code: 1, out: "", err: `sl status: ${message} ${FIX}` });
      const json = await sl(root, ["status", "--json"]);
      expect(json.code).toBe(1);
      expect(json.json()).toEqual({ error: `${message} ${FIX}`, next: "sl validate" });
      expect(plain.err).not.toContain("synthetic words");
    }
  });

  test("a directory where a file belongs is refused in the same line, and sl validate lists it", async () => {
    const root = layer({ "models/warehouse/orders.yaml": null });
    mkdirSync(join(root, "models", "warehouse", "orders.yaml"));
    const message = `models/warehouse/orders.yaml: is a directory, not a file. ${FIX}`;
    const r = await sl(root, ["status", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json()).toEqual({ error: message, next: "sl validate" });
    expect(r.err).toBe(`sl status: ${message}`);
    const v = await sl(root, ["validate", "--json"]);
    expect(v.code).toBe(1);
    expect(v.json<{ issues: object[] }>().issues).toContainEqual({ level: "error", file: "models/warehouse/orders.yaml", path: "", message: "is a directory, not a file" });
  });

  test("a metrics.yaml, access.yaml or listed golden with nothing written yet loads as none, as it did, and sl validate lists the empty file", async () => {
    for (const text of ["metrics:\n", "{}\n", "metrics: []\n", "# no metrics yet\n", ""]) {
      const root = layer({ "metrics.yaml": text });
      expect(loadMetrics(root)).toEqual({ metrics: [] });
      expect((await sl(root, ["status", "--json"])).code).toBe(0);
    }
    const root = layer({ "results.json": RESULTS, "metrics.yaml": "# no metrics yet\n", "access.yaml": "# no rules yet\n", "goldens/later.yaml": "# nothing yet\n" });
    expect(loadAccess(root)).toBeNull();
    expect(listGoldens(root).find((g) => g.path.endsWith("later.yaml"))!.golden).toBeNull();
    expect((await sl(root, ["status", "--json"])).code).toBe(0);
    expect(await runAll(root)).toEqual([]);
    const files = (await sl(root, ["validate", "--json"])).json<{ issues: { level: string; file: string }[] }>().issues.filter((i) => i.level === "error").map((i) => i.file);
    for (const file of ["metrics.yaml", "access.yaml", "goldens/later.yaml"]) expect(files).toContain(file);
    // Asked for by name, the empty golden is refused like any other empty file.
    const r = await sl(root, ["goldens", "run", "--name", "later", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json()).toEqual({ error: `goldens/later.yaml: the file should be a map (found an empty file). ${FIX}`, next: "sl validate" });
  });

  test("what the commands read around in words of their own loads: a status and a tables_file of any shape, an empty item in metrics", async () => {
    const model = BASE.get("models/lake/sessions.yaml")!.toString("utf8").replace(/^status: .*$/m, "status: [approved]");
    expect(model).toContain("status: [approved]");
    const files = { "results.json": RESULTS, "models/lake/sessions.yaml": model, "metrics.yaml": `${BASE.get("metrics.yaml")!.toString("utf8")}  -\n` };
    const root = layer(files);
    expect(listModels(root, "lake").length).toBeGreaterThan(0);
    expect(loadMetrics(root).metrics.at(-1)).toBeNull();
    expect(await runAll(root)).toEqual([]);
    expect((await sl(root, ["status", "--json"])).code).toBe(0);
    // A tables_file that is a list loads, and the commands that read it say so in sl scope's words.
    const listed = layer({ ...files, "sources/lake.yaml": BASE.get("sources/lake.yaml")!.toString("utf8").replace("scope:\n", "scope:\n  tables_file: [a, b]\n") });
    expect(loadSource(listed, "lake").scope!.tables_file as unknown).toEqual(["a", "b"]);
    for (const args of COMMANDS_RUN) {
      const r = await sl(listed, args);
      expect(problems(r, listed, args[0]!, false)).toEqual([]);
      if (r.code === 1 && args[0] !== "validate") expect(r.err).toContain("sl scope --source lake --clear --write");
    }
    expect((await sl(listed, ["status"])).code).toBe(1);
    const paths = (await sl(listed, ["validate", "--json"])).json<{ issues: { file: string; path: string }[] }>().issues.map((i) => `${i.file}: ${i.path}`);
    for (const path of ["models/lake/sessions.yaml: status", "sources/lake.yaml: scope.tables_file", "metrics.yaml: metrics[2]"]) expect(paths).toContain(path);
  });

  test("a single value of another kind and a missing key load: the commands read around them and sl validate lists each", async () => {
    const root = layer({
      "results.json": RESULTS,
      "semantic.yaml": "version: 1\nname: acme\ncolour: blue\nsettings: {focus_threshold: many}\n",
      "models/lake/sessions.yaml": "model: sessions\nsource: lake\ntable: sessions\ndimensions:\n  - {name: 5, column: started_at, type: time}\nmeasures: []\n",
      // access.yaml's parts are read closed by lib/access.ts, which sl status reports.
      "access.yaml": "status: draft\nmode: closed\nrestrictions: everything\n",
    });
    expect(loadProject(root).name).toBe("acme");
    expect(listModels(root, "lake").some((l) => l.model.model === "sessions")).toBe(true);
    expect(loadAccess(root)!.restrictions as unknown).toBe("everything");
    for (const args of COMMANDS_RUN) expect(problems(await sl(root, [...args, "--json"]), root, args[0]!, true)).toEqual([]);
    const v = await sl(root, ["validate", "--json"]);
    expect(v.code).toBe(1);
    const issues = v.json<{ issues: { level: string; file: string; path: string }[] }>().issues.filter((i) => i.level === "error");
    expect(issues).toContainEqual(expect.objectContaining({ file: "semantic.yaml", path: "colour" }));
    expect(issues).toContainEqual(expect.objectContaining({ file: "semantic.yaml", path: "settings.focus_threshold" }));
    expect(issues).toContainEqual(expect.objectContaining({ file: "models/lake/sessions.yaml", path: "dimensions[0].name" }));
    expect(issues).toContainEqual(expect.objectContaining({ file: "models/lake/sessions.yaml", path: "status" }));
    expect(issues).toContainEqual(expect.objectContaining({ file: "access.yaml", path: "restrictions" }));
  });
});

describe("a wrong shape below the top level", () => {
  const files: [string, string, string][] = [
    ["semantic.yaml", "version: 1\nname: {a: 1}\n", "semantic.yaml: name should be text (found a map)."],
    ["sources/warehouse.yaml", "source: warehouse\ndialect: {}\n", "sources/warehouse.yaml: dialect should be one of duckdb, postgres, snowflake, bigquery, databricks (found a map)."],
    ["metrics.yaml", "metrics: [null, x, 5]\n", "metrics.yaml: metrics[1] should be a map (found text)."],
    ["models/warehouse/orders.yaml", "model: orders\nsource: warehouse\ntable: acme.fct_orders\nstatus: draft\ndimensions: [x, null]\nmeasures: [null]\n", "models/warehouse/orders.yaml: dimensions[0] should be a map (found text)."],
  ];
  for (const [file, text, message] of files) {
    test(`${file}: every command that loads it refuses it in the same words`, async () => {
      const root = layer({ "results.json": RESULTS, [file]: text });
      for (const args of COMMANDS_RUN.filter((a) => a[0] !== "validate")) {
        const r = await sl(root, [...args, "--json"]);
        // A command that never reads the file runs as it does on the well-formed layer.
        if (r.code === 0) continue;
        // The refusal is the last line of stderr (sl readback notes a golden that does not compile before it).
        expect({ args, code: r.code, out: r.json(), err: r.err.split("\n").at(-1) }).toEqual({ args, code: 1, out: { error: `${message} ${FIX}`, next: "sl validate" }, err: `sl ${args[0]}: ${message} ${FIX}` });
      }
      expect((await sl(root, ["status", "--json"])).code).toBe(1);
      expect((await sl(root, ["next", "--json"])).code).toBe(1);
    });
  }
});

describe("sl readback of a target whose file is malformed", () => {
  const cases: [string, string, string, string][] = [
    ["a model that does not parse", "models/warehouse/orders.yaml", "name: [1, 2\n  b: : :\n", "models/warehouse/orders.yaml: is not valid YAML ("],
    ["an empty model", "models/warehouse/orders.yaml", "", `models/warehouse/orders.yaml: the file should be a map (found an empty file). ${FIX}`],
    ["a golden that is a list", "goldens/revenue_2025.yaml", "- a\n- b\n", `goldens/revenue_2025.yaml: the file should be a map (found a list). ${FIX}`],
    ["a golden that is a number", "goldens/revenue_2025.yaml", "5", `goldens/revenue_2025.yaml: the file should be a map (found a number). ${FIX}`],
  ];
  for (const [name, file, text, message] of cases) {
    test(name, async () => {
      const root = layer({ "results.json": RESULTS, [file]: text });
      const target = file.startsWith("goldens/") ? ["--targets", "golden:revenue_2025", "--results", "results.json"] : ["--targets", "warehouse.orders"];
      const r = await sl(root, ["readback", ...target, "--json"]);
      expect(r.code).toBe(1);
      const data = r.json<{ error: string; next: string }>();
      expect(data.next).toBe("sl validate");
      expect(data.error).toStartWith(message);
      expect(data.error).toEndWith(FIX);
      expect(r.err).toBe(`sl readback: ${data.error}`);
      expect(existsSync(join(root, ".sl", "pending", "rb_0003.json"))).toBe(false);
    });
  }

  test("a pending readback that is not one is a JSON error for sl reply and sl review export", async () => {
    const root = layer({ ".sl/pending/rb_0002.json": '{"readback_id": "rb_0002", "created_at": "2026-01-15T12:00:00.000Z", "items": {"n": 1}}' });
    const reply = await sl(root, ["reply", "--readback", "rb_0002", "--item", "1", "--text", "Yes.", "--by", "Dana Ruiz", "--verdict", "yes", "--json"]);
    expect(reply.code).toBe(1);
    expect(reply.json()).toEqual({ error: ".sl/pending/rb_0002.json does not match its schema; run sl validate, then sl readback --targets <ref> again.", next: "sl validate" });
    const exported = await sl(root, ["review", "export", "--readback", "rb_0002", "--format", "md", "--json"]);
    expect(exported.code).toBe(1);
    expect(exported.json()).toEqual({ error: ".sl/pending/rb_0002.json is not a valid readback. Run sl validate to see why, then sl readback again.", next: "sl validate" });
  });

  test("a ledger with a line that is not an entry is a JSON error for sl reply and sl approve", async () => {
    const root = layer({ ".sl/ledger.jsonl": "[1, 2]\nnull\n" });
    const reply = await sl(root, ["reply", "--readback", "rb_0002", "--item", "1", "--text", "Yes.", "--by", "Dana Ruiz", "--verdict", "yes", "--json"]);
    expect(reply.code).toBe(1);
    expect(reply.json<{ error: string; next: string }>()).toMatchObject({ next: "sl validate" });
    expect(reply.json<{ error: string }>().error).toStartWith("Line 1 of .sl/ledger.jsonl is not a JSON object; nothing was written.");
    const approve = await sl(root, ["approve", "--target", "warehouse.products.launched_on", "--by", "Dana Ruiz", "--json"]);
    expect(approve.code).toBe(1);
    expect(approve.json<{ error: string; next: string }>()).toMatchObject({ next: "sl validate" });
    expect(approve.json<{ error: string }>().error).toStartWith(".sl/ledger.jsonl cannot be read: line 1 is not a reply or question line");
    expect(readFileSync(join(root, ".sl", "ledger.jsonl"), "utf8")).toBe("[1, 2]\nnull\n");
  });
});

describe("a failure of the tool itself", () => {
  beforeAll(() => {
    COMMANDS["fall-over"] = async () => ({
      default: {
        summary: "Fails whatever the files hold.",
        usage: "fall-over",
        options: {},
        async run() {
          throw new TypeError("a bug in the command");
        },
      },
    });
  });
  afterAll(() => {
    delete COMMANDS["fall-over"];
  });

  test("is exit code 2 with its own error, also when a layer file is incomplete", async () => {
    // sessions.yaml has no status, which sl validate lists and every command reads around.
    const incomplete = BASE.get("models/lake/sessions.yaml")!.toString("utf8").replace(/^status: .*\n/m, "");
    for (const root of [layer(), layer({ "models/lake/sessions.yaml": incomplete })]) {
      expect((await sl(root, ["status"])).code).toBe(0);
      const r = await sl(root, ["fall-over", "--json"]);
      expect(r).toMatchObject({ code: 2, out: "" });
      expect(r.err).toStartWith("sl fall-over: unexpected error: TypeError: a bug in the command");
      expect(r.err).not.toContain("sessions.yaml");
    }
  });
});

describe("the shared schema module", () => {
  test("lib/validate.ts hands on the one schemaIssues", () => {
    expect(fromValidate).toBe(schemaIssues);
  });

  test("shapeIssue is the first map, list or single value where another belongs, at any depth", () => {
    expect(shapeIssue("metrics", { metrics: 5 })).toEqual({ path: "metrics", expected: "a list", found: "a number" });
    expect(shapeIssue("model", null)).toEqual({ path: "", expected: "a map", found: "an empty file" });
    expect(shapeIssue("project", [1])).toEqual({ path: "", expected: "a map", found: "a list" });
    expect(shapeIssue("model", { table: "t", dimensions: {} })).toEqual({ path: "dimensions", expected: "a list", found: "a map" });
    expect(shapeIssue("golden", { expected: [] })).toEqual({ path: "expected", expected: "a map", found: "a list" });
    expect(shapeIssue("model", { table: "t", measures: [{ name: "a" }, 5] })).toEqual({ path: "measures[1]", expected: "a map", found: "a number" });
    expect(shapeIssue("model", { table: "t", dimensions: [{ name: ["a"] }] })).toEqual({ path: "dimensions[0].name", expected: "text", found: "a list" });
    expect(shapeIssue("source", { connection: { views: { v: { a: 1 } } } })).toEqual({ path: "connection.views.v", expected: "text", found: "a map" });
    expect(shapeIssue("access", [1])).toEqual({ path: "", expected: "a map", found: "a list" });
    expect(shapeMessage("metrics.yaml", { path: "metrics", expected: "a list", found: "a number" })).toBe(`metrics.yaml: metrics should be a list (found a number). ${FIX}`);
  });

  test("shapeIssue leaves to sl validate a single value of another kind, a missing key, an unknown key and a value outside its list", () => {
    expect(shapeIssue("model", { model: 5, table: "t", status: 5, dimensions: [{ name: 5 }] })).toBeNull();
    expect(shapeIssue("source", { dialect: 5, scope: { tables_file: 5 }, profile: { top_values: "many" } })).toBeNull();
    expect(shapeIssue("project", { version: 1, name: "acme", extra: true })).toBeNull();
    expect(shapeIssue("metrics", {})).toBeNull();
    expect(shapeIssue("model", { model: "m", source: "s", table: "t", status: "nonsense", dimensions: [], measures: [] })).toBeNull();
    // A key with no value reads as a key that is not there.
    expect(shapeIssue("model", { table: "t", dimensions: null, joins: null })).toBeNull();
    // access.yaml is checked no further than being a map: lib/access.ts reads its parts closed.
    expect(shapeIssue("access", { roles: "everyone", restrictions: 5 })).toBeNull();
    // The commands read a status, a tables_file and an empty metrics item in words of their own.
    expect(shapeIssue("model", { table: "t", status: ["x"], joins: [{ name: "j", status: { a: 1 } }] })).toBeNull();
    expect(shapeIssue("source", { scope: { tables_file: ["a"] } })).toBeNull();
    expect(shapeIssue("metrics", { metrics: [null, { name: "m" }] })).toBeNull();
    expect(shapeIssue("metrics", { metrics: [null, "m"] })).toEqual({ path: "metrics[1]", expected: "a map", found: "text" });
    expect(shapeIssue("model", { table: "t", measures: [null] })).toEqual({ path: "measures[0]", expected: "a map", found: "nothing" });
  });

  test("shapeIssue refuses a model with no table, and a snapshot without a key its schema requires at any depth", () => {
    expect(shapeIssue("model", { model: "m" })).toEqual({ path: "table", expected: "text", found: "nothing" });
    const column = { name: "id", type: "integer" };
    const snapshot = (tables: unknown) => ({ snapshot_version: 1, source: "wh", dialect: "postgres", captured_at: "2026-01-01T00:00:00.000Z", method: "live", tables });
    expect(shapeIssue("snapshot", snapshot([{ schema: null, name: "t", kind: "table", columns: [column] }]))).toBeNull();
    expect(shapeIssue("snapshot", { ...snapshot([]), method: undefined })).toEqual({ path: "method", expected: "one of live, information_schema, dbt_manifest, ddl, manual", found: "nothing" });
    expect(shapeIssue("snapshot", snapshot([{ schema: "s", name: "t", kind: "table" }]))).toEqual({ path: "tables[0].columns", expected: "a list", found: "nothing" });
    expect(shapeIssue("snapshot", snapshot([{ schema: "s", name: "t", kind: "table", columns: [column, { name: "x" }] }]))).toEqual({ path: "tables[0].columns[1].type", expected: "text", found: "nothing" });
  });

  test("a schema file exists for every kind a loader checks", () => {
    for (const kind of ["project", "source", "snapshot", "model", "metrics", "access", "golden", "pending", "ledger"]) {
      expect(existsSync(join(import.meta.dir, "..", "skills", "semantic-layer", "schemas", `${kind}.schema.json`))).toBe(true);
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { type CompileResult, compileRequest } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { rowFilterTextProblem } from "../skills/semantic-layer/scripts/lib/compiler/rowfilters.ts";
import { assertReadOnly } from "../skills/semantic-layer/scripts/lib/sql-guard.ts";
import { sqlTextProblem, type TextRole } from "../skills/semantic-layer/scripts/lib/sql-text.ts";
import type { Model, QueryRequest } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { duckdbSource, initProject, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const EXAMPLES = join(import.meta.dir, "..", "examples");
const ok = { status: "approved", approved_by: "Test Owner", approved_at: "2026-01-01" };
const MODEL_ROLES: TextRole[] = ["dimension expr", "measure expr", "measure filter", "metric expr"];

// Each hostile text, and the problem every role but a row filter reports for it.
const HOSTILE: [string, (role: TextRole) => string][] = [
  ["status = $1", (r) => `has the query parameter marker $1; a ${r} takes no values from outside, and only the compiler binds parameters`],
  ["amount * $2", (r) => `has the query parameter marker $2; a ${r} takes no values from outside, and only the compiler binds parameters`],
  [
    "meta ? 'k'",
    (r) => `has the query parameter marker ?; a ${r} takes no values from outside, and only the compiler binds parameters; for Postgres's jsonb ? operator, write jsonb_exists(<column>, '<key>')`,
  ],
  ["status = $region", (r) => `has the query parameter marker $region; a ${r} takes no values from outside, and only the compiler binds parameters`],
  ["sum(amount)) or (1 = 1", (r) => `closes a parenthesis it never opened; a ${r} must balance its parentheses`],
  ["coalesce(amount, 0", (r) => `leaves a parenthesis open; a ${r} must balance its parentheses`],
  ["amount; select 1", (r) => `has a semicolon; a ${r} is one SQL ${r.endsWith("filter") ? "predicate" : "expression"}`],
  ["status = 'open", () => "has an unclosed string, quoted name or comment"],
  ["amount /* note", () => "has an unclosed string, quoted name or comment"],
  ['"amount', () => "has an unclosed string, quoted name or comment"],
  ["region = {{ user.region }}", (r) => `has a {{ }} placeholder; a ${r} takes no values from outside, and only a row filter in access.yaml reads {{ user.<attribute> }}`],
  ["region = {{ region", (r) => `has a {{ }} placeholder; a ${r} takes no values from outside, and only a row filter in access.yaml reads {{ user.<attribute> }}`],
  // Postgres and DuckDB end a -- comment at a carriage return, so the text after it is SQL.
  ["status = 'zzz' -- note\r or region = $1", () => "has a carriage return outside a string; break its lines with a line feed only"],
  ["status = 'zzz' -- note\r) or (true", () => "has a carriage return outside a string; break its lines with a line feed only"],
];

describe("sqlTextProblem", () => {
  test("refuses parameter markers, unbalanced parentheses, semicolons, unclosed strings and comments, and placeholders in every model text", () => {
    for (const role of MODEL_ROLES) for (const [text, problem] of HOSTILE) expect([role, text, sqlTextProblem(text, role)]).toEqual([role, text, problem(role)]);
  });

  test("reads markers, parentheses and braces inside strings, quoted names and comments as text", () => {
    for (const text of [
      "status <> '$1 ? ; ( {{ user.x }}'",
      `"weird ? ( name"`,
      "amount -- $1 ? ; (\n",
      "amount /* $1 ? ; ( {{ }} */",
      "amount::numeric(18, 2) * 0.01",
      "coalesce(meta->>'k', 'none')",
      "$tag$ ( $1 $tag$",
      "price$usd * 2",
      "case when a then (b) else (c) end",
      "{'a': {'b': amount}}['a']['b'] + 41",
      "note <> 'line\rbreak'",
    ])
      for (const role of MODEL_ROLES) expect([role, text, sqlTextProblem(text, role)]).toEqual([role, text, undefined]);
  });

  test("names the jsonb function that replaces each ? operator", () => {
    const hint = (text: string) => sqlTextProblem(text, "dimension expr")!.split("; ").at(-1);
    expect(hint("meta ? 'k'")).toBe("for Postgres's jsonb ? operator, write jsonb_exists(<column>, '<key>')");
    expect(hint("meta @? '$.b'")).toBe("for Postgres's jsonb @? operator, write jsonb_path_exists(<column>, '<path>')");
    expect(hint("meta ?| array['a']")).toBe("for Postgres's jsonb ?| operator, write jsonb_exists_any(<column>, <keys>)");
    expect(hint("meta ?& array['a']")).toBe("for Postgres's jsonb ?& operator, write jsonb_exists_all(<column>, <keys>)");
  });

  test("the read-only check ends a -- comment at a carriage return, so a statement after it is refused", () => {
    expect(() => assertReadOnly("select 1 -- x\r; drop table t")).toThrow();
    expect(() => assertReadOnly("select 1 -- x\r")).not.toThrow();
  });

  test("a row filter keeps its own wording and its placeholders", () => {
    expect(rowFilterTextProblem("region = {{ user.region }}")).toBeUndefined();
    expect(rowFilterTextProblem("region = ?")).toBe(
      "has the query parameter marker ?; a row filter reads the user's values through {{ user.<attribute> }} only, and only the compiler binds parameters",
    );
    expect(rowFilterTextProblem("region = 'a';")).toBe("has a semicolon; a row filter is one SQL predicate");
    expect(rowFilterTextProblem("region = {{ user.region }}1")).toBe(
      "writes {{ user.region }} against a name or a number; put a space or an operator between them, so it binds as one parameter",
    );
  });
});

// --- a small synthetic shop with one model and one derived metric ---

const SHOP = [
  "create table orders (order_id integer, region varchar, status varchar, amount integer)",
  "insert into orders values (1, 'NE', 'done', 10), (2, 'NE', 'open', 20), (3, 'WC', 'done', 30)",
];

function ordersModel(): Model {
  return {
    model: "orders",
    source: "shop",
    table: "main.orders",
    ...ok,
    dimensions: [
      { name: "region", expr: "region", type: "string", ...ok },
      { name: "status", expr: "status", type: "string", ...ok },
    ],
    measures: [
      { name: "order_count", agg: "count", ...ok },
      { name: "revenue", agg: "sum", expr: "amount", filter: "status <> 'cancelled'", description: "Order value.", ...ok },
    ],
  } as unknown as Model;
}

async function shop(edit: (m: Model) => void = () => {}, metricExpr = "{orders.revenue} * 2") {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "shop", SHOP);
  const m = ordersModel();
  edit(m);
  writeYaml(join(t.root, "models", "shop", "orders.yaml"), m);
  writeYaml(join(t.root, "metrics.yaml"), { metrics: [{ name: "double_revenue", source: "shop", type: "derived", expr: metricExpr, description: "Twice revenue.", ...ok }] });
  return { root: t.root, file: src.connection!.database! };
}

const errors = (root: string, file: string) => validateProject(root).filter((i) => i.file === file && i.level === "error").map((i) => [i.path, i.message]);
const refusals = (r: CompileResult) => (r.ok ? [] : r.refusals.map((x) => [x.code, x.message]));
const REQUEST = { source: "shop", measures: ["orders.revenue"], filters: [{ field: "orders.region", op: "eq", value: "NE" }] } as QueryRequest;

async function runDuckdb(file: string, sql: string, params: unknown[]) {
  const instance = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const cx = await instance.connect();
  try {
    const p = await cx.prepare(sql);
    if (params.length) p.bind(params as DuckDBValue[]);
    return (await p.runAndReadAll()).getRowObjectsJson();
  } finally {
    cx.closeSync();
    instance.closeSync();
  }
}

describe("sl validate", () => {
  test("reports each problem at the field's path: dimension and measure exprs, measure filters and metric exprs", async () => {
    for (const [text, problem] of HOSTILE) {
      const { root } = await shop(
        (m) => {
          m.dimensions[1]!.expr = text;
          m.measures[1]!.expr = text;
          m.measures[1]!.filter = text;
        },
        `{orders.revenue} + ${text}`,
      );
      const got = errors(root, "models/shop/orders.yaml");
      expect(got).toContainEqual(["dimensions[1].expr", problem("dimension expr")]);
      expect(got).toContainEqual(["measures[1].expr", problem("measure expr")]);
      expect(got).toContainEqual(["measures[1].filter", problem("measure filter")]);
      // The metric's own problem replaces the generic "arithmetic only" message.
      const metric = errors(root, "metrics.yaml").filter(([p]) => p === "metrics[0].expr");
      expect(metric).toEqual([["metrics[0].expr", problem("metric expr")]]);
    }
  }, 30_000);

  test("a field with a text problem gets that one error at its path, not the subquery error too", async () => {
    const { root } = await shop((m) => (m.dimensions[1]!.expr = "amount; select 1"));
    expect(errors(root, "models/shop/orders.yaml").filter(([p]) => p === "dimensions[1].expr")).toEqual([
      ["dimensions[1].expr", "has a semicolon; a dimension expr is one SQL expression"],
    ]);
  });

  test("a metric expr that only leaves a parenthesis open is refused", async () => {
    const { root } = await shop(undefined, "({orders.revenue} * 2");
    expect(errors(root, "metrics.yaml")).toEqual([["metrics[0].expr", "leaves a parenthesis open; a metric expr must balance its parentheses"]]);
  });

  test("a model on a dialect the tokenizer does not read (backslash escapes) is not checked", async () => {
    const { root } = await shop();
    writeYaml(join(root, "sources", "bq.yaml"), { source: "bq", dialect: "bigquery", connection: { env: "BQ_URL" } });
    writeYaml(join(root, "models", "bq", "people.yaml"), {
      model: "people",
      source: "bq",
      table: "d.people",
      status: "draft",
      dimensions: [{ name: "is_obrien", expr: "name = 'O\\'Brien'", type: "boolean", status: "draft" }],
      measures: [],
    });
    expect(errors(root, "models/bq/people.yaml")).toEqual([]);
  });

  test("the example layers still validate", () => {
    for (const ex of ["acme", "acme-export"]) expect([ex, validateProject(join(EXAMPLES, ex, "semantic")).filter((i) => i.level === "error")]).toEqual([ex, []]);
  });
});

describe("sl sql", () => {
  test("refuses a hostile dimension expr, measure expr or filter as a layer error naming the field's path", async () => {
    for (const [text, problem] of HOSTILE) {
      for (const [edit, path, role, request] of [
        [(m: Model) => (m.measures[1]!.filter = text), "measures[1].filter (revenue)", "measure filter", REQUEST],
        [(m: Model) => (m.measures[1]!.expr = text), "measures[1].expr (revenue)", "measure expr", REQUEST],
        [(m: Model) => (m.dimensions[1]!.expr = text), "dimensions[1].expr (status)", "dimension expr", { ...REQUEST, dimensions: ["orders.status"] }],
        // A filter on the dimension reads its expr too.
        [(m: Model) => (m.dimensions[1]!.expr = text), "dimensions[1].expr (status)", "dimension expr", { ...REQUEST, filters: [{ field: "orders.status", op: "eq", value: "done" }] }],
      ] as const) {
        const { root } = await shop(edit);
        const r = compileRequest(root, request);
        expect(r.ok).toBe(false);
        expect(refusals(r)).toContainEqual(["invalid_layer", `model orders ${path} ${problem(role as TextRole)}`]);
        if (!r.ok) expect(r.refusals.find((x) => x.code === "invalid_layer")!.next).toContain("run sl validate");
      }
    }
  }, 30_000);

  test("a hostile measure filter cannot bind the request filter's value: it is refused, and a clean one binds only the request's values", async () => {
    // Were it compiled, $1 in the filter would read the request's 'NE' and count NE orders as revenue.
    const { root } = await shop((m) => (m.measures[1]!.filter = "region = $1"));
    expect(refusals(compileRequest(root, REQUEST))).toEqual([
      ["invalid_layer", "model orders measures[1].filter (revenue) has the query parameter marker $1; a measure filter takes no values from outside, and only the compiler binds parameters"],
    ]);
    const { root: r2 } = await shop((m) => (m.measures[1]!.filter = "region = ? or status = 'done'"));
    expect(compileRequest(r2, REQUEST).ok).toBe(false);
    // A marker inside a string or a comment is text: the params stay the request's own.
    const { root: r3, file } = await shop((m) => (m.measures[1]!.filter = "status <> '$1' /* not ? $2 */"));
    const c = compileRequest(r3, REQUEST);
    if (!c.ok) throw new Error(c.reason);
    expect(c.params).toEqual(["NE"]);
    expect(c.sql).toEndWith("where (region) = $1");
    expect(await runDuckdb(file, c.sql, c.params)).toEqual([{ revenue: "30" }]);
    // A marker after a -- comment ended by a carriage return is SQL, so it is refused too.
    const { root: r4 } = await shop((m) => (m.measures[1]!.filter = "status = 'zzz' -- note\r or region = $1"));
    expect(compileRequest(r4, REQUEST).ok).toBe(false);
  });

  test("refuses a request naming a metric whose expr cannot be placed in a query, as a layer error too", async () => {
    const { root } = await shop(undefined, "{orders.revenue} * $1");
    const r = compileRequest(root, { source: "shop", measures: ["double_revenue"] });
    // The metric compiler reads only {model.measure} placeholders, numbers and + - * / ( ), so the
    // marker never reaches the query.
    expect(refusals(r)).toEqual([
      ["invalid_layer", "metric double_revenue has an expr sl sql cannot read: it combines {model.measure} placeholders with numbers and + - * / ( ) only; run sl validate"],
    ]);
  });
});

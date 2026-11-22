// The schema question on a live server (spec: Schema scope, The schema question), on whatever server
// PG_URL names; the CI `compat` job runs it once per supported major version. tests/compat/two-schemas.sql
// is loaded with its two schemas renamed to unique ones, so it runs beside any other test.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { assertLocalPg, approveWithYes, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "../helpers.ts";

const sales = uniqueSchema("t_scope_sales");
const crm = uniqueSchema("t_scope_crm");
let pg: SQL | undefined;
let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

beforeAll(async () => {
  if (!PG_URL) return;
  assertLocalPg(PG_URL);
  pg = new SQL({ url: PG_URL, max: 1 });
  const script = readFileSync(join(import.meta.dir, "two-schemas.sql"), "utf8").replace(/\bsales\b/g, sales).replace(/\bcrm\b/g, crm);
  await pg.unsafe(script);
});

afterAll(async () => {
  if (!pg) return;
  await pg.unsafe(`drop schema if exists ${sales}, ${crm} cascade`);
  await pg.close();
});

interface Next {
  kind: string;
  phase: string;
  action: { command: string; args: string[] };
  ask_owner?: { text: string; options?: { answer: string; commands: string[] }[] };
}

const scopeErrors = async (root: string, env: Record<string, string>) => {
  const v = await semlayer(root, ["validate", "--json"], env);
  return v.json<{ issues: { level: string; code: string }[] }>().issues.filter((i) => i.code.startsWith("scope.")).map((i) => [i.level, i.code]);
};

describe("the schema question on postgres", () => {
  test.skipIf(!PG_URL)("next asks before any cross-schema join, draft waits for the primary, and validate passes only after the pair is approved", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const root = t.root;
    const env = { SEMLAYER_TEST_PG: PG_URL! };
    await initProject(root);
    const setup = ["setup", "--source", "pg", "--dialect", "postgres", "--env", "SEMLAYER_TEST_PG"];
    expect((await semlayer(root, [...setup, "--schemas", `${sales},${crm}`], env)).code).toBe(0);

    const asked = (await semlayer(root, ["next", "--json"], env)).json<Next>();
    expect(asked).toMatchObject({ kind: "ask_owner", phase: "scope", action: { command: "setup", args: [...setup.slice(1), "--primary", sales] } });
    expect(asked.ask_owner!.text).toStartWith(`Your data sits in more than one schema (${sales}, ${crm}). Is ${sales} enough for your questions?`);
    expect(asked.ask_owner!.options!.map((o) => o.answer)).toEqual([`No, keep to ${sales}`, `Yes, I also need ${crm}`, "Another schema holds what my questions are about"]);

    const refused = await semlayer(root, ["draft", "--source", "pg", "--json"], env);
    expect(refused.code).toBe(1);
    expect(refused.json()).toMatchObject({ code: "scope.primary_unset", next: `semlayer ${setup.join(" ")} --primary <schema>` });

    // The owner wants crm too: the primary first, then the tables, and a join written by hand.
    expect((await semlayer(root, [...setup, "--primary", sales], env)).code).toBe(0);
    const drafted = await semlayer(root, ["draft", "--source", "pg", "--json"], env);
    expect(drafted.json<{ drafted: { table: string }[]; left_out_schemas: { schema: string; tables: number }[] }>()).toMatchObject({
      drafted: expect.arrayContaining([expect.objectContaining({ table: `${sales}.orders` })]),
      left_out_schemas: [{ schema: crm, tables: 1 }],
    });
    const more = await semlayer(root, ["draft", "--source", "pg", "--tables", `${crm}.customers`, "--json"], env);
    const crmModel = more.json<{ drafted: { model: string }[] }>().drafted[0]!.model;
    const orders = join(root, "models", "pg", "orders.yaml");
    writeFileSync(
      orders,
      readFileSync(orders, "utf8").replace(
        /^joins:\n/m,
        `joins:\n  - name: buyer\n    to: ${crmModel}\n    keys:\n      - from: customer_id\n        to: customer_id\n    relationship: many_to_one\n    status: draft\n`,
      ),
    );
    expect(await scopeErrors(root, env)).toEqual([["error", "scope.cross_schema_undeclared"]]);
    expect((await semlayer(root, ["next", "--json"], env)).json<Next>().ask_owner?.options).toBeDefined();

    const pair = `schema-pair:pg:${sales}:${crm}`;
    expect((await semlayer(root, ["add-cross-schema", "--source", "pg", "--from", sales, "--to", crm, "--constraint", "orders_customer_fk"], env)).code).toBe(0);
    expect(await scopeErrors(root, env)).toEqual([["error", "scope.cross_schema_undeclared"]]);
    expect((await approveWithYes(root, ["--target", pair])).code).toBe(0);
    expect(await scopeErrors(root, env)).toEqual([]);
    expect((await semlayer(root, ["next", "--json"], env)).json<Next>().ask_owner?.options).toBeUndefined();
  });

  test.skipIf(!PG_URL)("add-cross-schema with a --to outside the schemas read refuses and names the setup --schemas command", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const env = { SEMLAYER_TEST_PG: PG_URL! };
    await initProject(t.root);
    expect((await semlayer(t.root, ["setup", "--source", "pg", "--dialect", "postgres", "--env", "SEMLAYER_TEST_PG", "--schemas", sales, "--primary", sales], env)).code).toBe(0);
    const r = await semlayer(t.root, ["add-cross-schema", "--source", "pg", "--from", sales, "--to", crm, "--constraint", "orders_customer_fk"], env);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`semlayer setup --source pg --dialect postgres --env SEMLAYER_TEST_PG --schemas ${sales},${crm}, which reads the catalog again`);
    // A single schema read asks nothing, though a foreign key leaves it.
    expect((await semlayer(t.root, ["next", "--json"], env)).json<Next>().ask_owner?.options).toBeUndefined();
  });
});

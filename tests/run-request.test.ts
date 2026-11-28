// semlayer run --request (spec: CLI, run): a request is compiled from the layer as semlayer sql compiles it and
// run with its parameters bound, so a figure can be shown without writing a golden. On a copy of the
// example layer, whose lake source is DuckDB over the Parquet files of fixtures/acme/data.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { semlayer } from "./helpers.ts";
import { releaseFixture } from "./release-fixture.ts";

const DATA = resolve(import.meta.dir, "..", "fixtures", "acme", "data");
const SPEND_2025 = {
  source: "lake",
  measures: ["marketing_spend.spend"],
  filters: [
    { field: "marketing_spend.spend_date", op: "gte", value: "2025-01-01" },
    { field: "marketing_spend.spend_date", op: "lt", value: "2026-01-01" },
  ],
};

interface Ran {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  protected_columns: string[];
  notes?: string[];
}

// The example layer with the lake's views read from absolute paths, so its DuckDB source runs from the copy.
function layer(): string {
  const root = releaseFixture();
  const lake = join(root, "sources", "lake.yaml");
  writeFileSync(lake, readFileSync(lake, "utf8").replaceAll("../../../fixtures/acme/data", DATA));
  return root;
}

describe("semlayer run --request", () => {
  test("runs a request with its parameters bound and gives the figure the golden records", async () => {
    const root = layer();
    const compiled = (await semlayer(root, ["sql", "--source", "lake", "--request", JSON.stringify(SPEND_2025), "--json"])).json<{ params: unknown[] }>();
    expect(compiled.params.length).toBe(2);
    const r = await semlayer(root, ["run", "--source", "lake", "--request", JSON.stringify(SPEND_2025), "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const out = r.json<Ran>();
    expect(out.columns).toEqual(["spend"]);
    expect(out.row_count).toBe(1);
    expect(Number(out.rows[0]!.spend)).toBeCloseTo(16502.34, 2);
    expect(out.protected_columns).toEqual([]);
  });

  test("takes a golden file as the request, as semlayer sql does, and prints the rows as a table", async () => {
    const root = layer();
    const r = await semlayer(root, ["run", "--source", "lake", "--request", join(root, "goldens", "spend_2025.yaml")]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("spend");
    expect(r.out).toContain("16502.34");
    expect(r.out).toContain("(1 row)");
  });

  test("gives the same rows as the compiled SQL run as a statement", async () => {
    const root = layer();
    const request = { source: "lake", measures: ["marketing_spend.spend"], dimensions: ["marketing_spend.channel"], order_by: [{ field: "marketing_spend.channel", direction: "asc" }] };
    const byRequest = (await semlayer(root, ["run", "--source", "lake", "--request", JSON.stringify(request), "--json"])).json<Ran>();
    const sql = (await semlayer(root, ["sql", "--source", "lake", "--request", JSON.stringify(request), "--json"])).json<{ sql: string; params: unknown[] }>();
    expect(sql.params).toEqual([]);
    const byStatement = (await semlayer(root, ["run", "--source", "lake", "--sql", sql.sql, "--json"])).json<Ran>();
    expect(byRequest.rows.length).toBeGreaterThan(1);
    expect(byRequest.rows).toEqual(byStatement.rows);
  });

  test("a request the layer cannot answer is refused as semlayer sql refuses it, with exit 1 and nothing run", async () => {
    const root = layer();
    const bad = JSON.stringify({ source: "lake", measures: ["marketing_spend.nope"] });
    const r = await semlayer(root, ["run", "--source", "lake", "--request", bad]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("semlayer run refused the request: measures[0] names marketing_spend.nope");
    const j = (await semlayer(root, ["run", "--source", "lake", "--request", bad, "--json"])).json<{ ok: boolean; refusals: { code: string }[]; next: string }>();
    expect(j.ok).toBe(false);
    expect(j.refusals.length).toBe(1);
    const viaSql = (await semlayer(root, ["sql", "--source", "lake", "--request", bad, "--json"])).json<{ refusals: { code: string }[] }>();
    expect(j.refusals[0]!.code).toBe(viaSql.refusals[0]!.code);
  });

  test("a draft field is not run: only what the owner approved answers a question", async () => {
    const root = layer();
    // The measure is returned to draft through the CLI, as the owner's withdrawal would be.
    expect((await semlayer(root, ["approve", "--target", "lake.marketing_spend.spend", "--revoke"])).code).toBe(0);
    const r = await semlayer(root, ["run", "--source", "lake", "--request", JSON.stringify(SPEND_2025)]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("semlayer run refused the request");
    expect(r.out).toBe("");
  });

  test("exactly one of --sql, --file and --request, and --role and --user only with --request", async () => {
    const root = layer();
    const both = await semlayer(root, ["run", "--source", "lake", "--sql", "select 1", "--request", JSON.stringify(SPEND_2025)]);
    expect(both.code).toBe(1);
    expect(both.err).toContain("Pass exactly one of --sql, --file or --request.");
    const none = await semlayer(root, ["run", "--source", "lake"]);
    expect(none.err).toContain("Pass exactly one of --sql, --file or --request.");
    const role = await semlayer(root, ["run", "--source", "lake", "--sql", "select 1", "--role", "analyst"]);
    expect(role.code).toBe(1);
    expect(role.err).toContain("--role goes with --request");
  });
});

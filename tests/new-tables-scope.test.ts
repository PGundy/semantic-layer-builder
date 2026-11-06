// FR-1.8: tables that enter the selection after a rerun of sl introspect or sl import are named as
// new in scope and routed to drafting; tables that leave it with approved models are warned about,
// and no model is deleted.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordScope, scopeLines, selectionMatcher, tablesFlag } from "../skills/semantic-layer/scripts/lib/snapshot-diff.ts";
import type { ProjectStatus } from "../skills/semantic-layer/scripts/lib/status.ts";
import type { Model, Snapshot, SnapshotTable, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbSource, initProject, sl, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

interface Changes {
  new_in_scope: string[];
  left_scope: string[];
  left_scope_with_models: { model: string; table: string }[];
}

const WAREHOUSE = [
  "create table fct_orders (order_id integer primary key, amount integer)",
  "create table fct_legacy (id integer primary key, amount integer)",
  "create table dim_customers (customer_id integer primary key, region varchar)",
  "create table stg_events (id integer)",
  "insert into fct_orders values (1, 10), (2, 20)",
  "insert into fct_legacy values (1, 5)",
  "insert into dim_customers values (1, 'north')",
];

// Runs statements on the warehouse file, leaving the source file (and its scope) as it is.
async function alter(dir: string, statements: string[]): Promise<void> {
  const instance = await DuckDBInstance.create(join(dir, "wh.duckdb"));
  const c = await instance.connect();
  for (const s of statements) await c.run(s);
  c.closeSync();
  instance.closeSync();
}

function approvedModel(name: string, table: string): Model {
  const approval = { status: "approved" as const, approved_by: "Dana", approved_at: "2026-01-10" };
  return {
    model: name,
    source: "wh",
    table,
    ...approval,
    description: `The ${table} table.`,
    grain: "One row per id.",
    primary_key: ["id"],
    dimensions: [{ name: "id", expr: "id", type: "number", description: "Id.", ...approval }],
    measures: [{ name: "total", expr: "amount", agg: "sum", description: "Total.", ...approval }],
  };
}

// A DuckDB warehouse scoped to fct_* and dim_*, introspected, with a draft model on every in-scope
// table (sl draft) and the model on fct_legacy approved.
async function warehouse(): Promise<{ root: string; dir: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "wh", WAREHOUSE);
  writeYaml(join(t.root, "sources", "wh.yaml"), { ...src, scope: { include: ["fct_*", "dim_*"] } } satisfies SourceConfig);
  expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
  expect((await sl(t.root, ["profile", "--source", "wh"])).code).toBe(0);
  expect((await sl(t.root, ["draft", "--source", "wh"])).code).toBe(0);
  writeYaml(join(t.root, "models", "wh", "legacy.yaml"), approvedModel("legacy", "main.fct_legacy"));
  return t;
}

async function status(root: string): Promise<ProjectStatus> {
  const r = await sl(root, ["status", "--json"]);
  if (r.code !== 0) throw new Error(r.err);
  return r.json<ProjectStatus>();
}

function snapshotOf(root: string): Snapshot {
  return JSON.parse(readFileSync(join(root, "snapshots", "wh.json"), "utf8")) as Snapshot;
}

describe("a re-introspect that finds tables new in scope", () => {
  test("a new table matching fct_* is new in scope, and status routes it to draft with that table", async () => {
    const t = await warehouse();
    expect((await status(t.root)).sources[0]!.new_in_scope).toEqual([]);
    await alter(t.dir, ["create table fct_returns (return_id integer primary key, amount integer)", "create table stg_more (id integer)"]);
    const r = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(r.code).toBe(0);
    // stg_more is a new table too, but out of scope.
    expect(r.json<{ changes: Changes & { tables_added: string[] } }>().changes).toMatchObject({
      tables_added: ["main.fct_returns", "main.stg_more"],
      new_in_scope: ["main.fct_returns"],
      left_scope: [],
      left_scope_with_models: [],
    });
    expect(snapshotOf(t.root).scope_state?.new_in_scope).toEqual(["main.fct_returns"]);

    // The new table is profiled first, then drafted by name.
    const before = await status(t.root);
    expect(before.sources[0]!.new_in_scope).toEqual(["main.fct_returns"]);
    expect(before.next_step).toMatchObject({ phase: "profile", command: "sl profile --source wh" });
    expect((await sl(t.root, ["profile", "--source", "wh"])).code).toBe(0);
    const st = await status(t.root);
    expect(st.next_step).toMatchObject({
      phase: "draft",
      source: "wh",
      command: "sl draft --source wh --tables main.fct_returns",
      after_owner_yes: false,
    });
    expect(st.next_step.message).toContain('1 table(s) in "wh" are new in scope and have no model: main.fct_returns.');
    expect((await sl(t.root, ["status"])).out).toContain("  new in scope, with no model yet: main.fct_returns");

    // Drafting it clears it.
    expect((await sl(t.root, ["draft", "--source", "wh", "--tables", "main.fct_returns"])).code).toBe(0);
    const after = await status(t.root);
    expect(after.sources[0]!.new_in_scope).toEqual([]);
    expect(after.next_step.phase).not.toBe("draft");
  });

  test("the text report names the new table and the command that drafts it; a rerun before drafting keeps it", async () => {
    const t = await warehouse();
    await alter(t.dir, ["create table fct_returns (return_id integer primary key)"]);
    const r = await sl(t.root, ["introspect", "--source", "wh"]);
    expect(r.out).toContain(
      ["  1 table added: main.fct_returns.", "New in scope, with no model yet: main.fct_returns. `sl draft --source wh --tables main.fct_returns` drafts it."].join("\n"),
    );
    // The second rerun has nothing new to report, but status still names the table.
    const again = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(again.json<{ changes: Changes }>().changes.new_in_scope).toEqual([]);
    expect((await status(t.root)).sources[0]!.new_in_scope).toEqual(["main.fct_returns"]);
  });

  test("a scope change that brings existing tables in reports them as new in scope on the rerun", async () => {
    const t = await warehouse();
    expect((await sl(t.root, ["scope", "--source", "wh", "--include", "stg_*", "--write"])).code).toBe(0);
    const r = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    const changes = r.json<{ changes: Changes & { tables_added: string[] } }>().changes;
    expect(changes.tables_added).toEqual([]);
    expect(changes.new_in_scope).toEqual(["main.stg_events"]);
    expect((await status(t.root)).sources[0]!.new_in_scope).toEqual(["main.stg_events"]);
  });

  test("other unmodeled tables are named after the new ones", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", WAREHOUSE);
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    await alter(t.dir, ["create table fct_returns (id integer)"]);
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    expect((await sl(t.root, ["profile", "--source", "wh"])).code).toBe(0);
    const st = await status(t.root);
    expect(st.next_step.command).toBe("sl draft --source wh --tables main.fct_returns");
    expect(st.next_step.message).toContain("4 other in-scope table(s) have no model either");
  });
});

describe("tables that leave scope with approved models", () => {
  test("dropping a modeled, approved table warns in introspect and in status, and keeps the model", async () => {
    const t = await warehouse();
    await alter(t.dir, ["drop table fct_legacy"]);
    const json = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(json.json<{ changes: Changes }>().changes).toMatchObject({
      new_in_scope: [],
      left_scope: ["main.fct_legacy"],
      left_scope_with_models: [{ model: "legacy", table: "main.fct_legacy" }],
    });
    // The snapshot keeps the table in left_scope while its approved model is there, and the model file stays.
    const snap = snapshotOf(t.root);
    expect(snap.scope_state?.left_scope).toEqual(["main.fct_legacy"]);
    expect(existsSync(join(t.root, "models", "wh", "legacy.yaml"))).toBe(true);

    const st = await status(t.root);
    expect(st.sources[0]!.left_scope_with_models).toEqual([{ model: "legacy", table: "main.fct_legacy" }]);
    // A table gone from the snapshot opens drift, which names what to do.
    expect(st.next_step.phase).toBe("drift");
    expect(st.next_step.message).toContain("legacy (main.fct_legacy)");
    expect((await sl(t.root, ["status"])).out).toContain("  left scope with approved models: legacy (main.fct_legacy)");
  });

  test("the text report of a dropped table warns and names what to do", async () => {
    const t = await warehouse();
    await alter(t.dir, ["drop table fct_legacy"]);
    const r = await sl(t.root, ["introspect", "--source", "wh"]);
    // The table is named once, among the tables removed, and the next command is sl status.
    expect(r.out).toContain("  1 table removed: main.fct_legacy.");
    expect(r.out).not.toContain("Left scope,");
    expect(r.out).toContain("Next: sl status");
    expect(r.out).toContain("Warning: left scope with approved models: legacy (main.fct_legacy). The models are kept and still served.");
    expect(r.out).toContain("`sl approve --target wh.<model> --revoke`");
  });

  test("a scope change that drops a modeled, approved table warns, and status routes to scope until the owner decides", async () => {
    const t = await warehouse();
    expect((await sl(t.root, ["scope", "--source", "wh", "--exclude", "fct_legacy", "--write"])).code).toBe(0);
    const r = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(r.json<{ changes: Changes & { tables_removed: string[] } }>().changes).toMatchObject({
      tables_removed: [],
      new_in_scope: [],
      left_scope: ["main.fct_legacy"],
      left_scope_with_models: [{ model: "legacy", table: "main.fct_legacy" }],
    });
    const text = await sl(t.root, ["introspect", "--source", "wh"]);
    // Measured against the selection the previous run recorded, the second rerun has nothing new to say...
    expect(text.out).not.toContain("left scope with approved models");
    expect(text.out).toContain("Next: sl status");
    // ...but status keeps the warning until the owner decides.
    const st = await status(t.root);
    expect(st.sources[0]!.left_scope_with_models).toEqual([{ model: "legacy", table: "main.fct_legacy" }]);
    expect(st.next_step).toMatchObject({
      phase: "scope",
      source: "wh",
      command: "sl scope --source wh --tables main.fct_legacy",
      after_owner_yes: false,
    });
    expect(st.next_step.message).toContain("Left scope with approved models: legacy (main.fct_legacy).");
    expect(st.next_step.message).toContain("sl approve --target wh.<model> --revoke");
    expect(readYaml<Model>(join(t.root, "models", "wh", "legacy.yaml")).status).toBe("approved");

    // Restoring the pattern clears it.
    expect((await sl(t.root, ["scope", "--source", "wh", "--remove", "fct_legacy", "--write"])).code).toBe(0);
    expect((await status(t.root)).sources[0]!.left_scope_with_models).toEqual([]);
  });

  test("revoking the model clears the warning", async () => {
    const t = await warehouse();
    expect((await sl(t.root, ["scope", "--source", "wh", "--exclude", "fct_legacy", "--write"])).code).toBe(0);
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    expect((await sl(t.root, ["approve", "--target", "wh.legacy", "--revoke"])).code).toBe(0);
    const st = await status(t.root);
    expect(st.sources[0]!.left_scope_with_models).toEqual([]);
    expect(st.next_step.phase).not.toBe("scope");
  });

  test("an approved model out of scope before this report is not warned about", async () => {
    const t = await warehouse();
    writeYaml(join(t.root, "models", "wh", "events.yaml"), approvedModel("events", "main.stg_events"));
    const r = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(r.json<{ changes: Changes }>().changes.left_scope_with_models).toEqual([]);
    expect((await status(t.root)).sources[0]!.left_scope_with_models).toEqual([]);
  });
});

describe("sl import gives the same report", () => {
  const HEADER = "table_schema,table_name,column_name,data_type,is_nullable,ordinal_position";
  const rows = (tables: string[]) => tables.flatMap((t) => [`shop,${t},id,integer,NO,1`, `shop,${t},amount,integer,YES,2`]);

  test("new and leaving tables, the draft command and the warning", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "shop.yaml"), { source: "shop", dialect: "snowflake", scope: { include: ["fct_*"] } } satisfies SourceConfig);
    const file = join(t.dir, "export.csv");
    writeFileSync(file, [HEADER, ...rows(["fct_orders", "fct_legacy", "stg_x"])].join("\n"));
    expect((await sl(t.root, ["import", "--source", "shop", "--file", file])).code).toBe(0);
    writeYaml(join(t.root, "models", "shop", "legacy.yaml"), { ...approvedModel("legacy", "shop.fct_legacy"), source: "shop" });
    writeYaml(join(t.root, "models", "shop", "orders.yaml"), { ...approvedModel("orders", "shop.fct_orders"), source: "shop", status: "draft" });

    writeFileSync(file, [HEADER, ...rows(["fct_orders", "fct_returns", "stg_x"])].join("\n"));
    const r = await sl(t.root, ["import", "--source", "shop", "--file", file, "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ changes: Changes; next: string }>();
    expect(out.changes).toMatchObject({
      new_in_scope: ["shop.fct_returns"],
      left_scope: ["shop.fct_legacy"],
      left_scope_with_models: [{ model: "legacy", table: "shop.fct_legacy" }],
    });
    // An approved model left scope, so the next command is sl status, whose drift and scope steps come first.
    expect(out.next).toBe("sl status");

    writeFileSync(file, [HEADER, ...rows(["fct_orders", "fct_legacy", "stg_x"])].join("\n"));
    expect((await sl(t.root, ["import", "--source", "shop", "--file", file])).code).toBe(0);
    writeFileSync(file, [HEADER, ...rows(["fct_orders", "fct_returns", "stg_x"])].join("\n"));
    const text = await sl(t.root, ["import", "--source", "shop", "--file", file]);
    expect(text.out).toContain("New in scope, with no model yet: shop.fct_returns. `sl draft --source shop --tables shop.fct_returns` drafts it.");
    expect(text.out).toContain("Warning: left scope with approved models: legacy (shop.fct_legacy).");

    // A plan-only source has no profile step, so the drift on the gone table comes first, then draft.
    const st = await status(t.root);
    expect(st.sources[0]!.new_in_scope).toEqual(["shop.fct_returns"]);
    expect(st.sources[0]!.left_scope_with_models).toEqual([{ model: "legacy", table: "shop.fct_legacy" }]);
    expect(st.next_step.phase).toBe("drift");
    expect((await sl(t.root, ["approve", "--target", "shop.legacy", "--revoke"])).code).toBe(0);
    expect((await status(t.root)).next_step).toMatchObject({ phase: "draft", command: "sl draft --source shop --tables shop.fct_returns" });
  });
});

describe("edges", () => {
  // A DuckDB warehouse with the given scope and intake, introspected once.
  async function base(statements: string[], scope?: SourceConfig["scope"], intake?: SourceConfig["intake"]) {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const src = await duckdbSource(t.root, t.dir, "wh", statements);
    writeYaml(join(t.root, "sources", "wh.yaml"), { ...src, ...(scope ? { scope } : {}), ...(intake ? { intake } : {}) } satisfies SourceConfig);
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    return t;
  }

  test("a model leaving scope and a table entering it in one rerun: the Next line agrees with status", async () => {
    const t = await base(["create table fct_a (id integer primary key, amount integer)", "create table fct_legacy (id integer primary key, amount integer)"], {
      include: ["fct_*"],
    });
    expect((await sl(t.root, ["profile", "--source", "wh"])).code).toBe(0);
    writeYaml(join(t.root, "models", "wh", "a.yaml"), approvedModel("a", "main.fct_a"));
    writeYaml(join(t.root, "models", "wh", "legacy.yaml"), approvedModel("legacy", "main.fct_legacy"));
    expect((await sl(t.root, ["scope", "--source", "wh", "--exclude", "fct_legacy", "--write"])).code).toBe(0);
    await alter(t.dir, ["create table fct_new (id integer primary key, amount integer)"]);
    const r = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(r.json<{ next: string; changes: Changes }>().changes.new_in_scope).toEqual(["main.fct_new"]);
    expect((await sl(t.root, ["profile", "--source", "wh"])).code).toBe(0);
    // Profiled, a rerun would otherwise say sl draft; status's scope step comes first.
    expect((await sl(t.root, ["introspect", "--source", "wh"])).out).toContain("Next: sl status");
    expect((await status(t.root)).next_step.phase).toBe("scope");
    // Once the owner revokes the model, the rerun names the new table to draft.
    expect((await sl(t.root, ["approve", "--target", "wh.legacy", "--revoke"])).code).toBe(0);
    expect((await sl(t.root, ["introspect", "--source", "wh"])).out).toContain("Next: sl draft --source wh --tables main.fct_new");
  });

  test("the scope step's command, followed with --write, settles the warning", async () => {
    const t = await base(["create table fct_a (id integer)", "create table fct_legacy (id integer, amount integer)"], { include: ["fct_*"] });
    writeYaml(join(t.root, "models", "wh", "legacy.yaml"), approvedModel("legacy", "main.fct_legacy"));
    // Narrow the include pattern, not an exclude, so the table stops matching.
    expect((await sl(t.root, ["scope", "--source", "wh", "--remove", "fct_*", "--write"])).code).toBe(0);
    expect((await sl(t.root, ["scope", "--source", "wh", "--include", "fct_a", "--write"])).code).toBe(0);
    const r = await sl(t.root, ["introspect", "--source", "wh"]);
    expect(r.out).toContain("Left scope, no longer matching the scope or intake.schemas: main.fct_legacy. `sl scope --source wh` shows what the scope selects.");
    expect(r.out).toContain("Warning: left scope with approved models: legacy (main.fct_legacy).");
    const st = await status(t.root);
    expect(st.next_step.command).toBe("sl scope --source wh --tables main.fct_legacy");
    expect((await sl(t.root, ["scope", "--source", "wh"])).code).toBe(0);
    expect((await sl(t.root, [...st.next_step.command.split(" ").slice(1), "--write"])).code).toBe(0);
    const after = await status(t.root);
    expect(after.sources[0]!.left_scope_with_models).toEqual([]);
    expect(after.next_step.phase).not.toBe("scope");
  });

  test("a dropped approved table that comes back clears the warning and is not new", async () => {
    const t = await base(["create table fct_a (id integer primary key, amount integer)", "create table fct_legacy (id integer primary key, amount integer)"], {
      include: ["fct_*"],
    });
    writeYaml(join(t.root, "models", "wh", "legacy.yaml"), approvedModel("legacy", "main.fct_legacy"));
    await alter(t.dir, ["drop table fct_legacy"]);
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    expect((await status(t.root)).sources[0]!.left_scope_with_models).toEqual([{ model: "legacy", table: "main.fct_legacy" }]);
    await alter(t.dir, ["create table fct_legacy (id integer primary key, amount integer)"]);
    const r = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(r.json<{ changes: Changes }>().changes.new_in_scope).toEqual([]);
    expect(snapshotOf(t.root).scope_state!.left_scope).toEqual([]);
    expect((await status(t.root)).sources[0]!.left_scope_with_models).toEqual([]);
  });

  test("an exact name added with sl scope --tables enters as new in scope", async () => {
    const t = await base(["create table fct_a (id integer)", "create table stg_x (id integer)"], { include: ["fct_*"] });
    expect((await sl(t.root, ["scope", "--source", "wh", "--tables", "main.stg_x", "--write"])).code).toBe(0);
    const r = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(r.json<{ changes: Changes }>().changes.new_in_scope).toEqual(["main.stg_x"]);
  });

  test("a snapshot written before scope_state still finds new tables", async () => {
    const t = await base(["create table fct_a (id integer)"], { include: ["fct_*"] });
    const snap = snapshotOf(t.root);
    delete snap.scope_state;
    writeFileSync(join(t.root, "snapshots", "wh.json"), JSON.stringify(snap, null, 2));
    await alter(t.dir, ["create table fct_b (id integer)"]);
    const r = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(r.json<{ changes: Changes }>().changes.new_in_scope).toEqual(["main.fct_b"]);
  });

  test("intake.schemas: a schema removed warns about its approved model, a schema added reports its tables", async () => {
    const t = await base(
      [
        "create schema marts",
        "create schema legacy",
        "create schema extra",
        "create table marts.fct_a (id integer)",
        "create table legacy.fct_old (id integer, amount integer)",
        "create table extra.fct_x (id integer)",
      ],
      undefined,
      { schemas: ["marts", "legacy"] },
    );
    writeYaml(join(t.root, "models", "wh", "old.yaml"), approvedModel("old", "legacy.fct_old"));
    const src = readYaml<SourceConfig>(join(t.root, "sources", "wh.yaml"));
    writeYaml(join(t.root, "sources", "wh.yaml"), { ...src, intake: { schemas: ["marts", "extra"] } });
    const r = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    const changes = r.json<{ changes: Changes }>().changes;
    expect(changes.new_in_scope).toEqual(["extra.fct_x"]);
    expect(changes.left_scope_with_models).toEqual([{ model: "old", table: "legacy.fct_old" }]);
    expect((await status(t.root)).sources[0]!.left_scope_with_models).toEqual([{ model: "old", table: "legacy.fct_old" }]);
  });

  test("a draft model leaving scope is named but not warned about", async () => {
    const t = await base(["create table fct_a (id integer)", "create table fct_b (id integer, amount integer)"], { include: ["fct_*"] });
    writeYaml(join(t.root, "models", "wh", "b.yaml"), { ...approvedModel("b", "main.fct_b"), status: "draft" });
    expect((await sl(t.root, ["scope", "--source", "wh", "--exclude", "fct_b", "--write"])).code).toBe(0);
    const r = await sl(t.root, ["introspect", "--source", "wh"]);
    expect(r.out).toContain("Left scope, no longer matching the scope or intake.schemas: main.fct_b.");
    expect(r.out).not.toContain("approved models");
  });

  test("a model whose table is written in another case still counts", async () => {
    const t = await base(["create table fct_a (id integer)", "create table fct_legacy (id integer, amount integer)"], { include: ["fct_*"] });
    writeYaml(join(t.root, "models", "wh", "legacy.yaml"), approvedModel("legacy", "MAIN.FCT_LEGACY"));
    expect((await sl(t.root, ["scope", "--source", "wh", "--exclude", "fct_legacy", "--write"])).code).toBe(0);
    const r = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(r.json<{ changes: Changes }>().changes.left_scope_with_models).toEqual([{ model: "legacy", table: "main.fct_legacy" }]);
  });

  test("status --json of a source with no snapshot has the new fields, empty", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", ["create table fct_a (id integer)"]);
    const st = await status(t.root);
    expect(st.sources[0]!.new_in_scope).toEqual([]);
    expect(st.sources[0]!.left_scope_with_models).toEqual([]);
  });
});

describe("determinism", () => {
  test("the same rerun from the same files gives the same report and snapshot", async () => {
    const t = await warehouse();
    expect((await sl(t.root, ["scope", "--source", "wh", "--exclude", "fct_legacy", "--write"])).code).toBe(0);
    await alter(t.dir, ["create table fct_b (id integer)", "create table fct_a (id integer)", "create table dim_z (id integer)"]);
    const path = join(t.root, "snapshots", "wh.json");
    const previous = readFileSync(path, "utf8");
    const runs: { text: string; json: string; snapshot: string }[] = [];
    for (let i = 0; i < 2; i++) {
      writeFileSync(path, previous);
      const json = (await sl(t.root, ["introspect", "--source", "wh", "--json"])).out;
      writeFileSync(path, previous);
      const text = (await sl(t.root, ["introspect", "--source", "wh"])).out;
      runs.push({ text, json, snapshot: readFileSync(path, "utf8") });
    }
    expect(runs[1]).toEqual(runs[0]!);
    expect(JSON.parse(runs[0]!.json).changes.new_in_scope).toEqual(["main.dim_z", "main.fct_a", "main.fct_b"]);
  });
});

describe("recordScope", () => {
  const tbl = (schema: string, name: string): SnapshotTable => ({ schema, name, kind: "table", columns: [] });
  const snap = (tables: SnapshotTable[], scope_state?: Snapshot["scope_state"]): Snapshot => ({
    snapshot_version: 1,
    source: "wh",
    dialect: "postgres",
    captured_at: "2026-01-01T00:00:00Z",
    method: "live",
    tables,
    ...(scope_state ? { scope_state } : {}),
  });
  const source: SourceConfig = { source: "wh", dialect: "postgres", intake: { schemas: ["marts"] } };
  const selected = selectionMatcher(source, { include: ["fct_*"] });

  test("the selection is the scope within intake.schemas", () => {
    expect(selected({ schema: "marts", name: "fct_a" })).toBe(true);
    expect(selected({ schema: "raw", name: "fct_a" })).toBe(false);
    expect(selected({ schema: "marts", name: "dim_a" })).toBe(false);
  });

  test("the first snapshot records the selection and reports nothing", () => {
    const next = snap([tbl("marts", "fct_b"), tbl("marts", "fct_a"), tbl("raw", "fct_c")]);
    expect(recordScope(null, next, selected, () => [])).toBeNull();
    expect(next.scope_state).toEqual({ in_scope: ["marts.fct_a", "marts.fct_b"], new_in_scope: [], left_scope: [] });
    expect(scopeLines(null, "wh")).toEqual([]);
  });

  test("a snapshot without scope_state counts its tables the current selection keeps as in scope before", () => {
    const previous = snap([tbl("marts", "fct_a"), tbl("marts", "dim_a")]);
    const next = snap([tbl("marts", "fct_a"), tbl("marts", "fct_new")]);
    expect(recordScope(previous, next, selected, () => [])).toEqual({ new_in_scope: ["marts.fct_new"], left_scope: [], left_scope_with_models: [] });
  });

  test("modeled tables are not new; left_scope keeps only tables with an approved model; entries carry over until settled", () => {
    const models = [
      { model: "a", table: "marts.fct_a", status: "approved" },
      { model: "back", table: "marts.fct_back", status: "draft" },
      { model: "gone", table: "fct_gone", status: "approved" },
    ];
    const previous = snap([tbl("marts", "fct_a"), tbl("marts", "fct_gone"), tbl("marts", "fct_x")], {
      in_scope: ["marts.fct_a", "marts.fct_gone", "marts.fct_older", "marts.fct_x"],
      new_in_scope: ["marts.fct_older"],
      left_scope: ["marts.fct_settled"],
    });
    const next = snap([tbl("marts", "fct_a"), tbl("marts", "fct_back"), tbl("marts", "fct_older"), tbl("marts", "fct_new")]);
    expect(recordScope(previous, next, selected, () => models)).toEqual({
      new_in_scope: ["marts.fct_new"],
      left_scope: ["marts.fct_gone", "marts.fct_x"],
      left_scope_with_models: [{ model: "gone", table: "marts.fct_gone" }],
    });
    expect(next.scope_state).toEqual({
      in_scope: ["marts.fct_a", "marts.fct_back", "marts.fct_new", "marts.fct_older"],
      new_in_scope: ["marts.fct_new", "marts.fct_older"],
      left_scope: ["marts.fct_gone"],
    });
  });

  test("model files that do not parse count as no models, and every leaving table is kept", () => {
    const previous = snap([tbl("marts", "fct_a")], { in_scope: ["marts.fct_a"], new_in_scope: [], left_scope: [] });
    const next = snap([tbl("marts", "fct_b")]);
    const changes = recordScope(previous, next, selected, () => {
      throw new Error("bad yaml");
    });
    expect(changes).toEqual({ new_in_scope: ["marts.fct_b"], left_scope: ["marts.fct_a"], left_scope_with_models: [] });
    expect(next.scope_state!.left_scope).toEqual(["marts.fct_a"]);
  });

  test("the draft command names the tables only when there are at most 8 and each is plain", () => {
    expect(tablesFlag(["marts.fct_a", "marts.fct_b"])).toBe(" --tables marts.fct_a,marts.fct_b");
    expect(tablesFlag([])).toBe("");
    expect(tablesFlag(["marts.Order Lines"])).toBe("");
    expect(tablesFlag(["marts.a,b"])).toBe("");
    expect(tablesFlag(["marts.fct_*"])).toBe("");
    expect(tablesFlag(Array.from({ length: 9 }, (_, i) => `marts.fct_${i}`))).toBe("");
    const lines = scopeLines({ new_in_scope: ["marts.Order Lines"], left_scope: [], left_scope_with_models: [] }, "wh");
    expect(lines[0]).toContain("`sl draft --source wh` drafts it.");
  });

  test("a table that left and is among the removed tables is not named again", () => {
    const changes = { new_in_scope: [], left_scope: ["marts.fct_gone", "marts.fct_x"], left_scope_with_models: [] };
    expect(scopeLines(changes, "wh", ["MARTS.FCT_GONE"])).toEqual([
      "Left scope, no longer matching the scope or intake.schemas: marts.fct_x. `sl scope --source wh` shows what the scope selects.",
    ]);
    expect(scopeLines(changes, "wh", ["marts.fct_gone", "marts.fct_x"])).toEqual([]);
  });
});

describe("validate", () => {
  test("a snapshot with scope_state passes sl validate", async () => {
    const t = await warehouse();
    await alter(t.dir, ["create table fct_returns (id integer)"]);
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    const r = await sl(t.root, ["validate", "--json"]);
    expect(r.out).not.toContain("snapshots/wh.json");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { needsOwnerYes, type ProjectStatus } from "../skills/semantic-layer/scripts/lib/status.ts";
import type { Model, Snapshot, SnapshotTable, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { writeJson, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { FIXED_NOW, sl, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function table(name: string, rows: number, extra: Partial<SnapshotTable> = {}): SnapshotTable {
  return {
    schema: "main",
    name,
    kind: "table",
    row_count: rows,
    primary_key: ["id"],
    columns: [
      { name: "id", type: "integer" },
      { name: "amount", type: "integer" },
    ],
    ...extra,
  };
}

// Ranked order: dim_customers (referenced), fct_orders (fact), web_events, stg_events (staging), orders_tmp (noise).
function tables(profiled: boolean): SnapshotTable[] {
  const at = profiled ? FIXED_NOW : null;
  return [
    table("dim_customers", 2000, { profiled_at: at }),
    table("fct_orders", 10000, {
      profiled_at: at,
      foreign_keys: [{ columns: ["customer_id"], references: { schema: "main", table: "dim_customers", columns: ["id"] } }],
    }),
    table("orders_tmp", 1000, { profiled_at: at }),
    table("stg_events", 1000, { profiled_at: at }),
    table("web_events", 50000, { profiled_at: at }),
  ];
}

const MODEL_NAMES: Record<string, string> = {
  dim_customers: "customers",
  fct_orders: "orders",
  orders_tmp: "orders_tmp",
  stg_events: "stg_events",
  web_events: "web_events",
};

function approval(approved: boolean) {
  return approved ? { status: "approved" as const, approved_by: "Dana", approved_at: "2026-01-15" } : { status: "draft" as const };
}

function model(tableName: string, approved: boolean, opts: { evidence?: boolean; questions?: string[] } = {}): Model {
  const m: Model = {
    model: MODEL_NAMES[tableName]!,
    source: "wh",
    table: `main.${tableName}`,
    ...approval(approved),
    description: `The ${tableName} table.`,
    grain: "One row per id.",
    primary_key: ["id"],
    open_questions: opts.questions ?? [],
    dimensions: [{ name: "id_dim", expr: "id", type: "number", description: "Id.", ...approval(approved) }],
    measures: [{ name: "total", expr: "amount", agg: "sum", description: "Total amount.", ...approval(approved) }],
  };
  if (tableName === "fct_orders") {
    m.joins = [
      {
        name: "customer",
        to: "customers",
        keys: [{ from: "customer_id", to: "id" }],
        relationship: "many_to_one",
        ...approval(approved),
        ...(opts.evidence
          ? {
              evidence: {
                checked_at: FIXED_NOW,
                left_rows: 10000,
                left_null_keys: 0,
                matched_rows: 10000,
                match_rate: 1,
                right_rows: 2000,
                right_key_unique: true,
                left_key_unique: false,
                max_fanout: 1,
                suggested_relationship: "many_to_one" as const,
              },
            }
          : {}),
      },
    ];
  }
  return m;
}

interface Build {
  sources?: boolean;
  dialect?: SourceConfig["dialect"];
  snapshot?: boolean;
  wide?: boolean;
  scope?: SourceConfig["scope"];
  profiled?: boolean;
  models?: "none" | "some" | "draft" | "approved";
  evidence?: boolean;
  metrics?: "none" | "draft" | "approved";
  access?: "missing" | "draft" | "approved";
  goldens?: number;
}

// Builds a project that has completed every phase the options allow.
function build(root: string, b: Build): void {
  writeYaml(join(root, "semantic.yaml"), { version: 1, name: "acme", settings: { focus_threshold: 12, batch_size: 3 } });
  if (b.sources === false) return;
  const src: SourceConfig = { source: "wh", dialect: b.dialect ?? "duckdb", connection: { database: "wh.duckdb" } };
  if (b.scope) src.scope = b.scope;
  writeYaml(join(root, "sources", "wh.yaml"), src);
  if (b.snapshot === false) return;
  const t = tables(b.profiled ?? true);
  if (b.wide) for (let i = 0; i < 10; i++) t.push(table(`extra_${String(i).padStart(2, "0")}`, 10));
  const snap: Snapshot = { snapshot_version: 1, source: "wh", dialect: src.dialect, captured_at: FIXED_NOW, method: "live", tables: t };
  writeJson(join(root, "snapshots", "wh.json"), snap);

  const mode = b.models ?? "approved";
  if (mode === "none") return;
  const names = mode === "some" ? ["fct_orders"] : Object.keys(MODEL_NAMES);
  for (const n of names) {
    const approved = mode === "approved";
    const m = model(n, approved, { evidence: b.evidence ?? true, questions: n === "fct_orders" ? ["Does total include tax?", "Is it net?"] : [] });
    writeYaml(join(root, "models", "wh", `${m.model}.yaml`), m);
  }

  const metrics = b.metrics ?? "approved";
  if (metrics !== "none") {
    writeYaml(join(root, "metrics.yaml"), {
      metrics: [
        { name: "avg_total", source: "wh", type: "ratio", numerator: "orders.total", denominator: "customers.total", description: "Avg.", ...approval(metrics === "approved") },
        { name: "draft_one", source: "wh", type: "derived", expr: "{orders.total}", description: "Draft.", status: "draft" },
      ],
    });
  }
  const access = b.access ?? "approved";
  if (access !== "missing") {
    writeYaml(join(root, "access.yaml"), {
      ...approval(access === "approved"),
      roles: [
        { name: "analyst", allow: { models: ["wh.*"] } },
        { name: "viewer", allow: { models: ["wh.orders"] } },
      ],
    });
  }
  const goldens = b.goldens ?? 5;
  for (let i = 0; i < goldens + 1; i++) {
    writeYaml(join(root, "goldens", `g${i}.yaml`), {
      name: `g${i}`,
      question: "How much?",
      request: { source: "wh", measures: ["orders.total"] },
      sql: "select 1",
      status: i < goldens ? "approved" : "draft",
      ...(i < goldens ? { confirmed_by: "Dana", confirmed_at: "2026-01-15" } : {}),
    });
  }
}

async function status(b: Build, args: string[] = []): Promise<ProjectStatus> {
  const t = tempRoot();
  cleanup = t.cleanup;
  build(t.root, b);
  const r = await sl(t.root, ["status", "--json", ...args]);
  if (r.code !== 0) throw new Error(r.err);
  return r.json<ProjectStatus>();
}

describe("status next_step", () => {
  test("no sources -> add-source", async () => {
    const s = await status({ sources: false });
    expect(s.next_step.phase).toBe("add-source");
    expect(s.next_step.command).toContain("sl add-source");
    expect(s.sources).toEqual([]);
    expect(s.next_batch).toBeNull();
  });

  test("a source without a snapshot -> introspect, or emit-sql for a plan-only dialect", async () => {
    const live = await status({ snapshot: false });
    expect(live.next_step).toMatchObject({ phase: "introspect", source: "wh", command: "sl introspect --source wh" });
    expect(live.sources[0]!.snapshot).toBeNull();
    const plan = await status({ snapshot: false, dialect: "snowflake" });
    expect(plan.next_step.phase).toBe("introspect");
    expect(plan.next_step.command).toBe("sl introspect --source wh --emit-sql");
    expect(plan.next_step.message).toContain("sl import");
  });

  test("too many in-scope tables -> scope, and a scope that narrows them clears it", async () => {
    const wide = await status({ wide: true, models: "none" });
    expect(wide.sources[0]!.needs_focus).toBe(true);
    expect(wide.sources[0]!.snapshot!.in_scope).toBe(15);
    expect(wide.next_step.phase).toBe("scope");
    expect(wide.next_step.message).toContain("which tables to focus on");
    expect(wide.next_step.command).toBe("sl tables --source wh --groups");

    const narrowed = await status({ wide: true, models: "none", scope: { exclude: ["extra_*"] } });
    expect(narrowed.sources[0]!.needs_focus).toBe(false);
    expect(narrowed.sources[0]!.snapshot!.in_scope).toBe(5);
    expect(narrowed.next_step.phase).toBe("draft");
  });

  test("a snapshot with no tables -> introspect again", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { models: "none" });
    writeJson(join(t.root, "snapshots", "wh.json"), { snapshot_version: 1, source: "wh", dialect: "duckdb", captured_at: FIXED_NOW, method: "live", tables: [] });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.next_step).toMatchObject({ phase: "introspect", source: "wh", command: "sl introspect --source wh" });
    expect(s.next_step.message).toContain("holds no tables");
  });

  test("a scope that selects no tables -> scope, asking the owner again", async () => {
    const s = await status({ models: "none", scope: { include: ["fact_*"] } });
    expect(s.sources[0]!.snapshot).toMatchObject({ tables: 5, in_scope: 0 });
    expect(s.next_step).toMatchObject({ phase: "scope", source: "wh", command: "sl tables --source wh --groups" });
    expect(s.next_step.message).toContain("selects none of its 5 tables");
    expect(s.next_step.message).toContain("ask the owner again");
  });

  test("a postgres source without connection.env skips profile; with it, profile runs", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { profiled: false, models: "none", dialect: "postgres" });
    writeYaml(join(t.root, "sources", "wh.yaml"), { source: "wh", dialect: "postgres" });
    const noEnv = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(noEnv.sources[0]!.runnable).toBe(false);
    expect(noEnv.next_step.phase).toBe("draft");
    writeYaml(join(t.root, "sources", "wh.yaml"), { source: "wh", dialect: "postgres", connection: { env: "WH_URL" } });
    const withEnv = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(withEnv.sources[0]!.runnable).toBe(true);
    expect(withEnv.next_step).toMatchObject({ phase: "profile", command: "sl profile --source wh" });
  });

  test("a postgres source without connection.env and no snapshot -> introspect plan", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { sources: false });
    writeYaml(join(t.root, "sources", "wh.yaml"), { source: "wh", dialect: "postgres" });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.next_step.command).toBe("sl introspect --source wh --emit-sql");
  });

  test("unprofiled in-scope tables on a runnable source -> profile; a plan-only source skips it", async () => {
    const s = await status({ profiled: false, models: "none" });
    expect(s.next_step).toMatchObject({ phase: "profile", command: "sl profile --source wh" });
    expect(s.sources[0]!.snapshot!.profiled).toBe(0);
    const plan = await status({ profiled: false, models: "none", dialect: "bigquery" });
    expect(plan.next_step.phase).toBe("draft");
  });

  test("in-scope tables without models -> draft", async () => {
    const s = await status({ models: "some" });
    expect(s.next_step).toMatchObject({ phase: "draft", command: "sl draft --source wh" });
    expect(s.sources[0]!.tables_without_model).toBe(4);
    expect(s.sources[0]!.unmodeled_tables).toEqual(["main.dim_customers", "main.orders_tmp", "main.stg_events", "main.web_events"]);
  });

  test("draft models -> interview the next batch; the command never approves a field", async () => {
    const s = await status({ models: "draft" });
    expect(s.next_step.phase).toBe("interview");
    expect(s.next_step.command).toBe('sl approve --target wh.customers --by "<owner>"');
    expect(s.next_step.command).not.toContain("--recursive");
    expect(s.next_step.message).toContain("customers, orders, web_events");
    expect(s.next_step.message).toContain("on its own only after the owner confirms that readback");
  });

  test("a draft model in the batch with an unchecked join -> check-join first", async () => {
    const s = await status({ models: "draft", evidence: false });
    expect(s.next_step).toMatchObject({ phase: "interview", command: "sl check-join --source wh --model orders --join customer" });
  });

  test("an unchecked join outside the batch does not replace the interview command", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    // Only customers is a draft model; the unchecked join sits on the approved orders model.
    writeYaml(join(t.root, "models", "wh", "customers.yaml"), { ...model("dim_customers", true), status: "draft", approved_by: undefined, approved_at: undefined });
    writeYaml(join(t.root, "models", "wh", "orders.yaml"), model("fct_orders", true, { evidence: false }));
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.next_step).toMatchObject({ phase: "interview", command: 'sl approve --target wh.customers --by "<owner>"' });
  });

  test("a draft model whose fields are approved -> approve the model itself", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    writeYaml(join(t.root, "models", "wh", "customers.yaml"), { ...model("dim_customers", true), status: "draft", approved_by: undefined, approved_at: undefined });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.next_step).toMatchObject({ phase: "interview", command: 'sl approve --target wh.customers --by "<owner>"' });
  });

  test("an approved model with draft fields does not block later phases; the fields are reported", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    const m = model("fct_orders", true, { evidence: true });
    m.measures[0] = { ...m.measures[0]!, status: "draft", approved_by: undefined, approved_at: undefined };
    writeYaml(join(t.root, "models", "wh", "orders.yaml"), m);
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    const w = s.sources[0]!;
    expect(w.draft_models).toEqual([]);
    expect(w.models_with_draft_fields).toEqual(["orders"]);
    expect(w.draft_fields).toEqual(["orders.total"]);
    expect(s.next_batch).toBeNull();
    expect(s.next_step.phase).toBe("done");
    expect(s.next_step.message).toContain("1 field(s) stay draft; name them in the handoff: wh.orders.total");

    const human = await sl(t.root, ["status"]);
    expect(human.out).toContain("draft fields in approved models: orders.total");
  });

  test("a draft field of an approved model in a draft model's batch is still not suggested for approval", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    const m = model("fct_orders", true, { evidence: true });
    m.measures[0] = { ...m.measures[0]!, status: "draft", approved_by: undefined, approved_at: undefined };
    writeYaml(join(t.root, "models", "wh", "orders.yaml"), m);
    writeYaml(join(t.root, "models", "wh", "web_events.yaml"), model("web_events", false));
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.next_step).toMatchObject({ phase: "interview", command: 'sl approve --target wh.web_events --by "<owner>"' });
    expect(s.next_step.message).toContain("web_events");
    expect(s.next_step.message).not.toContain("orders");
    expect(s.sources[0]!.models_with_draft_fields).toEqual(["orders"]);
  });

  test("a draft join without evidence in an approved model -> check-join, not interview", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    const m = model("fct_orders", true);
    m.joins![0] = { ...m.joins![0]!, status: "draft", approved_by: undefined, approved_at: undefined };
    writeYaml(join(t.root, "models", "wh", "orders.yaml"), m);
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.next_step).toMatchObject({ phase: "check-join", command: "sl check-join --source wh --model orders --join customer" });
  });

  test("draft models on out-of-scope tables do not hold the interview open", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { scope: { include: ["fct_*", "dim_*"] } });
    writeYaml(join(t.root, "models", "wh", "web_events.yaml"), model("web_events", false));
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    const w = s.sources[0]!;
    expect(w.draft_models).toEqual([]);
    expect(w.out_of_scope_models).toEqual(["orders_tmp", "stg_events", "web_events"]);
    expect(s.next_step.phase).toBe("done");
  });

  test("joins without evidence -> check-join", async () => {
    const s = await status({ evidence: false });
    expect(s.next_step).toMatchObject({ phase: "check-join", command: "sl check-join --source wh --model orders --join customer" });
    expect(s.sources[0]!.joins_without_evidence).toBe(1);
    expect(s.sources[0]!.unchecked_joins).toEqual(["orders.customer"]);
  });

  test("measures but no approved metrics -> metrics", async () => {
    const none = await status({ metrics: "none" });
    expect(none.next_step.phase).toBe("metrics");
    expect(none.metrics).toEqual({ approved: 0, draft: 0 });
    const draft = await status({ metrics: "draft" });
    expect(draft.next_step.phase).toBe("metrics");
    expect(draft.next_step.command).toContain("metric:");
  });

  test("access missing or draft -> access", async () => {
    const missing = await status({ access: "missing" });
    expect(missing.next_step.phase).toBe("access");
    expect(missing.access).toEqual({ state: "missing", roles: 0, open_questions: 0 });
    const draft = await status({ access: "draft" });
    expect(draft.next_step).toMatchObject({ phase: "access", command: 'sl approve --target access --by "<owner>"' });
    expect(draft.access).toEqual({ state: "draft", roles: 2, open_questions: 0 });
  });

  test("access open questions, top level and per role, are counted and named in the access step", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { access: "missing" });
    writeYaml(join(t.root, "access.yaml"), {
      status: "draft",
      open_questions: ["Does a joined row filter blank the columns?", 7],
      roles: [
        { name: "analyst", allow: { models: ["wh.*"] }, open_questions: ["Aggregates only?"] },
        { name: "viewer", allow: { models: ["wh.orders"] }, open_questions: "not a list" },
        "not a role",
      ],
    });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.access).toEqual({ state: "draft", roles: 3, open_questions: 2 });
    expect(s.open_questions).toBe(4);
    expect(s.next_step.message).toContain("Settle its 2 open question(s) first.");
    const human = await sl(t.root, ["status"]);
    expect(human.out).toContain("access draft (3 role(s), 2 open question(s))");
  });

  test("an access.yaml holding only comments is a draft with no roles", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { access: "missing" });
    writeFileSync(join(t.root, "access.yaml"), "# todo: roles\n");
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.access).toEqual({ state: "draft", roles: 0, open_questions: 0 });
    expect(s.next_step).toMatchObject({ phase: "access", command: "sl validate" });
    expect(s.next_step.message).toContain("no roles yet");
    expect(s.next_step.message).not.toContain("open question");
  });

  test("an access.yaml with no roles names its top-level open questions in the access step", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { access: "missing" });
    writeYaml(join(t.root, "access.yaml"), { status: "draft", open_questions: ["Is the default role the most limited?"], roles: [] });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.access).toEqual({ state: "draft", roles: 0, open_questions: 1 });
    expect(s.next_step).toMatchObject({ phase: "access", command: "sl validate" });
    expect(s.next_step.message).toContain("no roles yet");
    expect(s.next_step.message).toContain("Settle its 1 open question(s) with them.");
  });

  test("fewer than 5 approved goldens -> verify, otherwise done", async () => {
    const few = await status({ goldens: 4 });
    expect(few.next_step.phase).toBe("verify");
    expect(few.goldens).toEqual({ approved: 4, draft: 1 });
    const done = await status({});
    expect(done.next_step.phase).toBe("done");
    expect(done.goldens).toEqual({ approved: 5, draft: 1 });
  });
});

describe("status counts and batches", () => {
  test("counts approvals, open questions and the snapshot", async () => {
    const s = await status({});
    const w = s.sources[0]!;
    expect(w).toMatchObject({
      source: "wh",
      dialect: "duckdb",
      runnable: true,
      needs_focus: false,
      models: { total: 5, approved: 5, draft: 0 },
      dimensions: { approved: 5, draft: 0 },
      measures: { approved: 5, draft: 0 },
      joins: { approved: 1, draft: 0 },
      joins_without_evidence: 0,
      open_questions: 2,
      tables_without_model: 0,
    });
    expect(w.snapshot).toEqual({ method: "live", captured_at: FIXED_NOW, tables: 5, in_scope: 5, profiled: 5 });
    expect(s.metrics).toEqual({ approved: 1, draft: 1 });
    expect(s.access).toEqual({ state: "approved", roles: 2, open_questions: 0 });
    expect(s.open_questions).toBe(2);
    expect(s.settings).toEqual({ focus_threshold: 12, batch_size: 3 });
    expect(w.next_batch).toEqual([]);
    expect(s.next_batch).toBeNull();
  });

  test("next_batch follows rank, skips approved models and stops at batch_size", async () => {
    const s = await status({ models: "some" });
    const batch = s.sources[0]!.next_batch;
    expect(batch.map((b) => b.table)).toEqual(["main.dim_customers", "main.fct_orders", "main.web_events"]);
    expect(batch[0]).toMatchObject({ model: null, model_status: "missing" });
    expect(batch[0]!.reasons).toContain("referenced by 1 table");
    expect(batch[1]).toMatchObject({ model: "orders", model_status: "draft" });
    expect(batch[1]!.reasons).toContain("fact table naming");
    expect(s.next_batch).toEqual({ source: "wh", tables: batch });

    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { models: "some" });
    writeYaml(join(t.root, "models", "wh", "orders.yaml"), model("fct_orders", true));
    const r = await sl(t.root, ["status", "--json"]);
    const after = r.json<ProjectStatus>().sources[0]!.next_batch.map((b) => b.table);
    expect(after).toEqual(["main.dim_customers", "main.web_events", "main.stg_events"]);
  });

  test("scope excludes tables from the batch and counts", async () => {
    const s = await status({ models: "none", scope: { include: ["*_events", "fct_*"] } });
    const w = s.sources[0]!;
    expect(w.snapshot!.in_scope).toBe(3);
    expect(w.next_batch.map((b) => b.table)).toEqual(["main.fct_orders", "main.web_events", "main.stg_events"]);
  });

  test("--source limits the report and an unknown source fails", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    writeYaml(join(t.root, "sources", "lake.yaml"), { source: "lake", dialect: "duckdb" });
    const all = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(all.sources.map((s) => s.source)).toEqual(["lake", "wh"]);
    expect(all.next_step).toMatchObject({ phase: "introspect", source: "lake" });
    const one = (await sl(t.root, ["status", "--source", "wh", "--json"])).json<ProjectStatus>();
    expect(one.sources.map((s) => s.source)).toEqual(["wh"]);
    expect(one.next_step.phase).toBe("done");
    const bad = await sl(t.root, ["status", "--source", "nope"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('Unknown source "nope"');
  });

  test("human output summarizes each source and the next step", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { models: "some" });
    const r = await sl(t.root, ["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("wh (duckdb)");
    expect(r.out).toContain("5 tables, 5 in scope, 5 profiled");
    expect(r.out).toContain("Next batch (wh):");
    expect(r.out).toContain("Next step (draft)");
    expect(r.out).toContain("sl draft --source wh");
  });

  test("human output for the scope phase names the focus step", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { wide: true, models: "none" });
    const r = await sl(t.root, ["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("15 tables, 15 in scope, 5 profiled (needs focus)");
    expect(r.out).toContain("Next step (scope)");
    expect(r.out).toContain("which tables to focus on");
    expect(r.out).toContain("sl tables --source wh --groups");
  });

  test("no project fails with a plain message", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const r = await sl(t.root, ["status"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("sl init");
  });
});

describe("status owner gates and golden coverage", () => {
  test("after_owner_yes is true exactly when the command records an approval", () => {
    expect(needsOwnerYes('sl approve --target wh.customers --by "<owner>"')).toBe(true);
    expect(needsOwnerYes('sl approve --target access --by "<owner>"')).toBe(true);
    expect(needsOwnerYes('sl goldens confirm --name g --by "<owner>"')).toBe(true);
    expect(needsOwnerYes("sl goldens run --name <golden>")).toBe(false);
    expect(needsOwnerYes("sl check-join --source wh --model orders --join customer")).toBe(false);
    expect(needsOwnerYes("sl validate")).toBe(false);
    expect(needsOwnerYes("sl approver")).toBe(false);
  });

  test("approve steps wait for the owner's yes; other steps do not", async () => {
    const interview = await status({ models: "draft" });
    expect(interview.next_step).toMatchObject({ phase: "interview", after_owner_yes: true });
    const join = await status({ models: "draft", evidence: false });
    expect(join.next_step).toMatchObject({ phase: "interview", after_owner_yes: false });
    const metrics = await status({ metrics: "draft" });
    expect(metrics.next_step).toMatchObject({ phase: "metrics", after_owner_yes: true });
    const noMetrics = await status({ metrics: "none" });
    expect(noMetrics.next_step).toMatchObject({ phase: "metrics", command: "sl validate", after_owner_yes: false });
    const access = await status({ access: "draft" });
    expect(access.next_step).toMatchObject({ phase: "access", after_owner_yes: true });
    const verify = await status({ goldens: 2 });
    expect(verify.next_step).toMatchObject({ phase: "verify", after_owner_yes: false });
    const done = await status({});
    expect(done.next_step).toMatchObject({ phase: "done", after_owner_yes: false });
    const none = await status({ sources: false });
    expect(none.next_step).toMatchObject({ phase: "add-source", after_owner_yes: false });
  });

  test("human output says an approve command runs only after the owner's yes", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { models: "draft" });
    const r = await sl(t.root, ["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('  Only after the owner says yes to its readback: sl approve --target wh.customers --by "<owner>"');
    build(t.root, { models: "draft", evidence: false });
    const join = await sl(t.root, ["status"]);
    expect(join.out).toContain("\n  sl check-join --source wh --model orders --join customer");
    expect(join.out).not.toContain("Only after the owner says yes");
  });

  test("roles_without_goldens lists the roles no approved golden names", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    const before = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(before.roles_without_goldens).toEqual(["analyst", "viewer"]);
    const golden = (name: string, role: string, approved: boolean) =>
      writeYaml(join(t.root, "goldens", `${name}.yaml`), {
        name,
        question: "How much?",
        role,
        request: { source: "wh", measures: ["orders.total"] },
        sql: "select 1",
        status: approved ? "approved" : "draft",
      });
    golden("analyst_total", "analyst", true);
    golden("viewer_total", "viewer", false);
    const after = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(after.roles_without_goldens).toEqual(["viewer"]);
    const human = await sl(t.root, ["status"]);
    expect(human.out).toContain("roles without an approved golden: viewer");
    golden("viewer_total", "viewer", true);
    const covered = await sl(t.root, ["status"]);
    expect(covered.out).not.toContain("roles without an approved golden");
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().roles_without_goldens).toEqual([]);
  });

  test("an approved golden without a role covers access.yaml's default_role", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { access: "missing", goldens: 0 });
    const roles = [
      { name: "analyst", allow: { models: ["wh.*"] } },
      { name: "viewer", allow: { models: [] } },
    ];
    const golden = (status: string) =>
      writeYaml(join(t.root, "goldens", "total.yaml"), {
        name: "total",
        question: "How much?",
        request: { source: "wh", measures: ["orders.total"] },
        sql: "select 1",
        status,
      });
    writeYaml(join(t.root, "access.yaml"), { status: "draft", default_role: "analyst", roles });
    golden("draft");
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().roles_without_goldens).toEqual(["analyst", "viewer"]);
    golden("approved");
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().roles_without_goldens).toEqual(["viewer"]);
    writeYaml(join(t.root, "access.yaml"), { status: "draft", roles });
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().roles_without_goldens).toEqual(["analyst", "viewer"]);
  });

  test("roles_without_goldens is empty without access.yaml and skips malformed roles", async () => {
    const missing = await status({ access: "missing" });
    expect(missing.roles_without_goldens).toEqual([]);
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { access: "missing" });
    writeYaml(join(t.root, "access.yaml"), { status: "draft", roles: [{ name: "support", allow: { models: [] } }, "not a role", { allow: {} }] });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.roles_without_goldens).toEqual(["support"]);
  });
});

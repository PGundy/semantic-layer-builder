import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { needsOwnerYes, type ProjectStatus } from "../skills/semantic-layer/scripts/lib/status.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import type { Model, Snapshot, SnapshotTable, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readJson, readYaml, writeJson, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
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
  // Whether the approved goldens run as access.yaml's roles (g0 as viewer, the rest as analyst); default true.
  goldenRoles?: boolean;
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
  const roles = access !== "missing" && b.goldenRoles !== false;
  for (let i = 0; i < goldens + 1; i++) {
    writeYaml(join(root, "goldens", `g${i}.yaml`), {
      name: `g${i}`,
      question: "How much?",
      ...(roles && i < goldens ? { role: i === 0 ? "viewer" : "analyst" } : {}),
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
    expect(s.next_step.message).toContain("draft field(s) wh.orders.total.");

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
    expect(missing.access).toMatchObject({ state: "missing", roles: 0, open_questions: 0 });
    const draft = await status({ access: "draft" });
    expect(draft.next_step).toMatchObject({ phase: "access", command: 'sl approve --target access --by "<owner>"' });
    expect(draft.access).toMatchObject({ state: "draft", roles: 2, open_questions: 0 });
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
    expect(s.access).toMatchObject({ state: "draft", roles: 3, open_questions: 2 });
    expect(s.open_questions).toBe(4);
    // The step waits on the owner's answers: no approval is suggested, and the first question is named.
    expect(s.next_step).toMatchObject({ phase: "access", blocked_on: "open_questions", command: "sl access", after_owner_yes: false });
    expect(s.next_step.message).toContain("2 open question(s), so this step waits on the owner's answers");
    expect(s.next_step.message).toContain('the first: "Does a joined row filter blank the columns?"');
    expect(s.next_step.message).not.toContain("sl approve");
    expect(s.next_step.message).toContain("do not push the approval");
    expect(s.next_step.message).toContain("The owner may approve with remaining questions");
    expect(s.next_step.message).not.toContain("nothing to approve");
    const human = await sl(t.root, ["status"]);
    expect(human.out).toContain("access draft (3 role(s), 2 open question(s))");
    expect(human.out).toContain("  Waiting on the owner's answers to the open questions; meanwhile: sl access");
    expect(human.out).not.toContain("Only after the owner says yes");
  });

  test("an access.yaml holding only comments is a draft with no roles", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { access: "missing" });
    writeFileSync(join(t.root, "access.yaml"), "# todo: roles\n");
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.access).toMatchObject({ state: "draft", roles: 0, open_questions: 0 });
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
    expect(s.access).toMatchObject({ state: "draft", roles: 0, open_questions: 1 });
    expect(s.next_step).toMatchObject({ phase: "access", blocked_on: "open_questions", command: "sl access", after_owner_yes: false });
    expect(s.next_step.message).toContain('the first: "Is the default role the most limited?"');
  });

  test("a role's open question is named with its role when access.yaml has no top-level one", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { access: "missing" });
    writeYaml(join(t.root, "access.yaml"), {
      status: "draft",
      mode: "closed",
      roles: [{ name: "sales", allow: { models: ["wh.orders"] }, open_questions: ["Own orders only, or the team's?"] }],
    });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.next_step).toMatchObject({ phase: "access", blocked_on: "open_questions", command: "sl access" });
    expect(s.next_step.message).toContain(`the first: "role sales: Own orders only, or the team's?"`);
  });

  test("a closed access.yaml with no roles and an open question waits on the owner and says nobody sees anything", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { access: "missing" });
    writeYaml(join(t.root, "access.yaml"), { status: "draft", mode: "closed", open_questions: ["Who are the analysts?"] });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.next_step).toMatchObject({ phase: "access", blocked_on: "open_questions", command: "sl access", after_owner_yes: false });
    expect(s.next_step.message).toContain("closed and has no roles yet, so nobody sees anything");
  });

  test("a long first open question is cut at a word boundary in the step", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { access: "missing" });
    const long = `Should sales see order lines? ${"The rule limits only orders and not their lines, ".repeat(8)}End.`;
    writeYaml(join(t.root, "access.yaml"), { status: "draft", open_questions: [long], roles: [{ name: "sales", allow: { models: ["wh.*"] } }] });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    const quoted = s.next_step.message.match(/the first: "([^"]*)"/)![1]!;
    expect(quoted.startsWith("Should sales see order lines? The rule limits")).toBe(true);
    expect(quoted.endsWith("…")).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(201);
    expect(quoted).not.toContain("End.");
  });

  test("an access.yaml without open questions has no blocked_on", async () => {
    const s = await status({ access: "draft" });
    expect(s.next_step.blocked_on).toBeUndefined();
    expect(s.next_step.command).toBe('sl approve --target access --by "<owner>"');
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
    expect(s.access).toMatchObject({ state: "approved", roles: 2, open_questions: 0 });
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
    build(t.root, { goldenRoles: false });
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

  test("a role without an approved golden -> verify, even with enough goldens", async () => {
    const s = await status({ goldenRoles: false });
    expect(s.goldens.approved).toBe(5);
    expect(s.roles_without_goldens).toEqual(["analyst", "viewer"]);
    expect(s.next_step).toMatchObject({ phase: "verify", command: "sl goldens run --name <golden>", after_owner_yes: false });
    expect(s.next_step.message).toContain("write and confirm a golden that runs as role analyst");
    expect(s.next_step.message).toContain("Then do the same for role viewer.");

    const few = await status({ goldens: 2, goldenRoles: false });
    expect(few.next_step.phase).toBe("verify");
    expect(few.next_step.message).toContain("2 of 5 approved goldens");
    expect(few.next_step.message).toContain("Roles without an approved golden: analyst, viewer.");

    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    writeYaml(join(t.root, "goldens", "g0.yaml"), {
      name: "g0",
      question: "How much?",
      role: "viewer",
      request: { source: "wh", measures: ["orders.total"] },
      sql: "select 1",
      status: "draft",
    });
    const one = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(one.roles_without_goldens).toEqual(["viewer"]);
    expect(one.next_step.message).toBe(
      "4 of 5 approved goldens. Ask the owner for questions with known answers, run each golden and record it once they confirm the rows. " +
        "Roles without an approved golden: viewer.",
    );
  });

  test("done stays reachable with draft metrics, goldens and fields, and names each one", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    const m = model("fct_orders", true, { evidence: true });
    m.measures[0] = { ...m.measures[0]!, status: "draft", approved_by: undefined, approved_at: undefined };
    writeYaml(join(t.root, "models", "wh", "orders.yaml"), m);
    // A golden whose name is missing goes by its file name.
    writeYaml(join(t.root, "goldens", "unnamed.yaml"), { question: "How many?", status: "draft" });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.draft_metrics).toEqual(["draft_one"]);
    expect(s.draft_goldens).toEqual(["g5", "unnamed"]);
    expect(s.next_step.phase).toBe("done");
    expect(s.next_step.message).toBe(
      "Every phase the CLI can measure is complete. Rerun sl validate after any change. " +
        "Name in the handoff the draft metric(s) draft_one; draft golden(s) g5, unnamed; draft field(s) wh.orders.total. " +
        "Before the handoff, tick the coverage checklist in references/verification.md; every figure the owner gave needs a golden, draft or approved.",
    );
    const human = await sl(t.root, ["status"]);
    expect(human.out).toContain("draft metrics: draft_one");
    expect(human.out).toContain("draft goldens: g5, unnamed");
  });

  test("draft lists name exactly the drafts the counts count", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { goldens: 5 });
    writeYaml(join(t.root, "metrics.yaml"), {
      metrics: [
        { name: "avg_total", source: "wh", type: "ratio", numerator: "orders.total", denominator: "customers.total", description: "Avg.", ...approval(true) },
        { source: "wh", status: "draft" },
        null,
      ],
    });
    // An empty golden file parses to null: neither counted nor listed.
    writeFileSync(join(t.root, "goldens", "empty.yaml"), "# nothing yet\n");
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.metrics).toEqual({ approved: 1, draft: 1 });
    expect(s.draft_metrics).toEqual(["metrics[1]"]);
    expect(s.goldens.draft).toBe(s.draft_goldens.length);
    expect(s.draft_goldens).toEqual(["g5"]);
  });

  test("done with nothing left draft still ends with the coverage checklist", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { goldens: 5 });
    writeYaml(join(t.root, "metrics.yaml"), {
      metrics: [
        { name: "avg_total", source: "wh", type: "ratio", numerator: "orders.total", denominator: "customers.total", description: "Avg.", ...approval(true) },
        null,
      ],
    });
    rmSync(join(t.root, "goldens", "g5.yaml"));
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.draft_metrics).toEqual([]);
    expect(s.draft_goldens).toEqual([]);
    expect(s.next_step.message).toBe(
      "Every phase the CLI can measure is complete. Rerun sl validate after any change. " +
        "Before the handoff, tick the coverage checklist in references/verification.md; every figure the owner gave needs a golden, draft or approved.",
    );
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

// Rewrites the wh snapshot of a built project.
function editSnapshot(root: string, edit: (snap: Snapshot) => void): void {
  const path = join(root, "snapshots", "wh.json");
  const snap = readJson<Snapshot>(path);
  edit(snap);
  writeJson(path, snap);
}

function editModel(root: string, name: string, edit: (m: Model) => void): void {
  const path = join(root, "models", "wh", `${name}.yaml`);
  const m = readYaml<Model>(path);
  edit(m);
  writeYaml(path, m);
}

function tableOf(snap: Snapshot, name: string): SnapshotTable {
  return snap.tables.find((t) => t.name === name)!;
}

async function built(b: Build, after: (root: string) => void = () => {}): Promise<{ root: string; st: ProjectStatus }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  build(t.root, b);
  after(t.root);
  const r = await sl(t.root, ["status", "--json"]);
  if (r.code !== 0) throw new Error(r.err);
  return { root: t.root, st: r.json<ProjectStatus>() };
}

describe("status access mode and default audience", () => {
  test("an open access.yaml reports its mode and what the default audience sees", async () => {
    const { st } = await built({});
    expect(st.access).toEqual({
      state: "approved",
      roles: 2,
      restrictions: 0,
      open_questions: 0,
      mode: "open",
      // 5 approved models with a dimension and a measure each; avg_total is approved and its measures are visible.
      default_audience: { models: 5, fields: 10, metrics: 1, hidden_by_protected_tags: 0 },
    });
  });

  test("no access.yaml means open: the default audience sees every approved item", async () => {
    const { st } = await built({ access: "missing" });
    expect(st.access).toEqual({
      state: "missing",
      roles: 0,
      restrictions: 0,
      open_questions: 0,
      mode: "open",
      default_audience: { models: 5, fields: 10, metrics: 1, hidden_by_protected_tags: 0 },
    });
  });

  test("draft items are not counted in the default audience", async () => {
    const { st } = await built({ models: "draft", metrics: "draft" });
    expect(st.access.default_audience).toEqual({ models: 0, fields: 0, metrics: 0, hidden_by_protected_tags: 0 });
  });

  test("closed mode: the default audience, holding no role, sees nothing", async () => {
    const { st } = await built({}, (root) => {
      const path = join(root, "access.yaml");
      writeYaml(path, { ...readYaml<object>(path), mode: "closed" });
    });
    expect(st.access.mode).toBe("closed");
    expect(st.access.default_audience).toEqual({ models: 0, fields: 0, metrics: 0, hidden_by_protected_tags: 0 });
  });

  test("protected tags hide fields and models from the default audience and are counted", async () => {
    const { st } = await built({}, (root) => {
      editModel(root, "customers", (m) => {
        m.dimensions[0]!.tags = ["pii"];
      });
      editModel(root, "web_events", (m) => {
        m.tags = ["sensitive"];
      });
    });
    const a = st.access.default_audience;
    // web_events and its two fields are hidden, and customers.id_dim; avg_total still sees customers.total.
    expect(a.models).toBe(4);
    expect(a.fields).toBe(7);
    expect(a.metrics).toBe(1);
    // web_events, its two fields (they carry the model's tag) and customers.id_dim.
    expect(a.hidden_by_protected_tags).toBe(4);
  });

  test("a role granting a protected tag does not widen the default audience", async () => {
    const { st } = await built({}, (root) => {
      editModel(root, "customers", (m) => {
        m.measures[0]!.tags = ["pii"];
      });
      writeYaml(join(root, "access.yaml"), {
        ...approval(true),
        mode: "open",
        roles: [{ name: "hr", allow: { tags: ["pii"] } }],
      });
    });
    // customers.total is hidden, so avg_total, which divides by it, is hidden too.
    expect(st.access.default_audience).toEqual({ models: 5, fields: 9, metrics: 0, hidden_by_protected_tags: 1 });
  });

  test("--source counts the default audience of that source only", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    writeYaml(join(t.root, "sources", "lake.yaml"), { source: "lake", dialect: "duckdb" });
    writeJson(join(t.root, "snapshots", "lake.json"), {
      snapshot_version: 1,
      source: "lake",
      dialect: "duckdb",
      captured_at: FIXED_NOW,
      method: "live",
      tables: [table("events", 100, { profiled_at: FIXED_NOW })],
    });
    writeYaml(join(t.root, "models", "lake", "events.yaml"), { ...model("web_events", true), model: "events", source: "lake", table: "main.events" });
    const all = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(all.access.default_audience.models).toBe(6);
    const wh = (await sl(t.root, ["status", "--json", "--source", "wh"])).json<ProjectStatus>();
    expect(wh.access.default_audience).toEqual({ models: 5, fields: 10, metrics: 1, hidden_by_protected_tags: 0 });
  });

  test("no access.yaml -> access asks the exceptions question", async () => {
    const { st } = await built({ access: "missing" });
    expect(st.next_step).toMatchObject({ phase: "access", command: "sl validate", after_owner_yes: false });
    expect(st.next_step.message).toContain("access is open");
    expect(st.next_step.message).toContain("is there anything some people should not see?");
    expect(st.next_step.message).toContain("pii or sensitive");
  });

  test("a draft open access.yaml with no roles -> the exceptions question, then approve the open baseline", async () => {
    const { st } = await built({ access: "missing" }, (root) => writeYaml(join(root, "access.yaml"), { status: "draft", mode: "open" }));
    expect(st.access).toMatchObject({ state: "draft", roles: 0, mode: "open" });
    expect(st.next_step).toMatchObject({ phase: "access", command: 'sl approve --target access --by "<owner>"', after_owner_yes: true });
    expect(st.next_step.message).toContain("is there anything some people should not see?");
    expect(st.next_step.message).toContain("no roles yet");
  });

  test("an access.yaml with no mode is open", async () => {
    const { st } = await built({ access: "missing" }, (root) => writeYaml(join(root, "access.yaml"), { status: "draft" }));
    expect(st.access.mode).toBe("open");
    expect(st.next_step.message).toContain("is there anything some people should not see?");
  });

  test("an approved open access.yaml with no roles completes the access phase", async () => {
    const { st } = await built({ access: "missing" }, (root) =>
      writeYaml(join(root, "access.yaml"), { ...approval(true), mode: "open" }),
    );
    expect(st.access).toMatchObject({ state: "approved", roles: 0, mode: "open" });
    expect(st.roles_without_goldens).toEqual([]);
    expect(st.next_step.phase).toBe("done");
  });

  test("a draft closed access.yaml with no roles asks who may see what", async () => {
    const { st } = await built({ access: "missing" }, (root) => writeYaml(join(root, "access.yaml"), { status: "draft", mode: "closed" }));
    expect(st.access).toMatchObject({ state: "draft", roles: 0, mode: "closed" });
    expect(st.next_step).toMatchObject({ phase: "access", command: "sl validate" });
    expect(st.next_step.message).toContain("closed and has no roles yet, so nobody sees anything");
  });

  test("a draft access.yaml with roles names its mode in the readback step", async () => {
    const { st } = await built({ access: "draft" });
    expect(st.next_step.message).toContain("in open mode");
    expect(st.next_step.message).toContain("every restriction");
  });

  test("a draft open access.yaml with no roles but a restriction -> read the restriction back, not the bare baseline", async () => {
    const { st } = await built({ access: "missing" }, (root) =>
      writeYaml(join(root, "access.yaml"), {
        status: "draft",
        mode: "open",
        user_attributes: [{ name: "level", type: "number", description: "Seniority." }],
        restrictions: [{ name: "orders_seniors", description: "Orders for seniors.", targets: ["wh.orders"], allow: { when: "user.level >= 5" } }],
      }),
    );
    expect(st.access).toMatchObject({ state: "draft", roles: 0, restrictions: 1, mode: "open" });
    expect(st.next_step).toMatchObject({ phase: "access", command: 'sl approve --target access --by "<owner>"', after_owner_yes: true });
    expect(st.next_step.message).toContain("0 role(s) and 1 restriction(s)");
    expect(st.next_step.message).toContain("every restriction");
    expect(st.next_step.message).not.toContain("open baseline");
  });

  test("an unreadable mode is named as unreadable and treated as closed", async () => {
    const { st } = await built({ access: "missing" }, (root) =>
      writeYaml(join(root, "access.yaml"), { status: "draft", mode: "opne", roles: [{ name: "analyst", allow: { models: ["wh.*"] } }] }),
    );
    expect(st.access.mode).toBe("closed");
    expect(st.next_step).toMatchObject({ phase: "access", command: "sl validate", after_owner_yes: false });
    expect(st.next_step.message).toContain("its mode is unreadable");
    expect(st.next_step.message).toContain('"opne" is not open or closed');
    expect(st.next_step.message).not.toContain("closed and has no roles yet");
  });

  test("an unreadable mode with no roles is still named as unreadable", async () => {
    const { st } = await built({ access: "missing" }, (root) => writeYaml(join(root, "access.yaml"), { status: "draft", mode: "opne" }));
    expect(st.next_step.message).toContain("its mode is unreadable");
    expect(st.next_step.message).not.toContain("closed and has no roles yet");
  });

  test("an approved access.yaml with an unreadable mode keeps the access phase open", async () => {
    const { st } = await built({}, (root) => {
      const path = join(root, "access.yaml");
      writeYaml(path, { ...readYaml<object>(path), mode: "opne" });
    });
    expect(st.access.state).toBe("approved");
    expect(st.next_step).toMatchObject({ phase: "access", command: "sl validate" });
    expect(st.next_step.message).toContain("access.yaml is approved, but its mode is unreadable");
  });

  test("an access.yaml whose restrictions cannot be read says so and keeps the access phase open", async () => {
    const { st } = await built({}, (root) => {
      const path = join(root, "access.yaml");
      writeYaml(path, { ...readYaml<object>(path), restrictions: "everything" });
    });
    expect(st.access.mode).toBe("closed");
    expect(st.next_step).toMatchObject({ phase: "access", command: "sl validate" });
    expect(st.next_step.message).toContain("cannot be read as written");
    expect(st.next_step.message).toContain("nobody sees anything");
  });

  test("an approved closed access.yaml with no roles keeps the access phase open", async () => {
    const { st } = await built({ access: "missing" }, (root) =>
      writeYaml(join(root, "access.yaml"), { ...approval(true), mode: "closed" }),
    );
    expect(st.access).toMatchObject({ state: "approved", roles: 0, mode: "closed" });
    expect(st.access.default_audience).toEqual({ models: 0, fields: 0, metrics: 0, hidden_by_protected_tags: 0 });
    expect(st.next_step).toMatchObject({ phase: "access", command: "sl validate" });
    expect(st.next_step.message).toContain("access.yaml is approved, but it is closed and has no roles yet, so nobody sees anything");
  });

  test("human output names the mode and the default audience in one line", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    const open = await sl(t.root, ["status"]);
    expect(open.out).toContain("access mode open; the default audience sees 5 models, 10 fields, 1 metric\n");
    editModel(t.root, "customers", (m) => {
      m.dimensions[0]!.tags = ["pii"];
    });
    rmSync(join(t.root, "access.yaml"));
    const tagged = await sl(t.root, ["status"]);
    expect(tagged.out).toContain("access mode open (no access.yaml); the default audience sees 5 models, 9 fields, 1 metric; 1 hidden by protected tags");
  });
});

describe("status schema evolution", () => {
  test("a layer whose tables match its models reports no new or missing columns", async () => {
    const { st } = await built({});
    expect(st.sources[0]!.new_columns).toEqual([]);
    expect(st.sources[0]!.missing_columns).toEqual([]);
  });

  test("a column a modeled table gained -> new_columns and draft --new-columns", async () => {
    const { st } = await built({}, (root) =>
      editSnapshot(root, (snap) => {
        tableOf(snap, "fct_orders").columns.push({ name: "discount", type: "DECIMAL(10,2)" });
        tableOf(snap, "web_events").columns.push({ name: "referrer", type: "VARCHAR" });
      }),
    );
    expect(st.sources[0]!.new_columns).toEqual([
      { model: "orders", column: "discount", type: "DECIMAL(10,2)" },
      { model: "web_events", column: "referrer", type: "VARCHAR" },
    ]);
    expect(st.next_step).toMatchObject({ phase: "draft", source: "wh", command: "sl draft --source wh --new-columns", after_owner_yes: false });
    expect(st.next_step.message).toContain("orders.discount (DECIMAL(10,2)), web_events.referrer (VARCHAR)");
  });

  test("new columns on draft models are listed too", async () => {
    const { st } = await built({ models: "draft" }, (root) =>
      editSnapshot(root, (snap) => {
        tableOf(snap, "fct_orders").columns.push({ name: "discount", type: "integer" });
      }),
    );
    expect(st.sources[0]!.new_columns).toEqual([{ model: "orders", column: "discount", type: "integer" }]);
    // The draft phase precedes the interview, so the new column is drafted first.
    expect(st.next_step.command).toBe("sl draft --source wh --new-columns");
  });

  test("tables without a model are drafted before new columns", async () => {
    const { st } = await built({ models: "some" }, (root) =>
      editSnapshot(root, (snap) => {
        tableOf(snap, "fct_orders").columns.push({ name: "discount", type: "integer" });
      }),
    );
    expect(st.sources[0]!.new_columns).toEqual([{ model: "orders", column: "discount", type: "integer" }]);
    expect(st.next_step.command).toBe("sl draft --source wh");
  });

  test("ignored columns, join keys, incoming keys and referenced columns are not new", async () => {
    const { st } = await built({}, (root) => {
      editSnapshot(root, (snap) => {
        const orders = tableOf(snap, "fct_orders");
        orders.columns.push({ name: "customer_id", type: "integer" }, { name: "raw_payload", type: "json" }, { name: "Status", type: "varchar" });
        tableOf(snap, "dim_customers").columns.push({ name: "code", type: "varchar" });
      });
      editModel(root, "orders", (m) => {
        m.ignored_columns = ["RAW_PAYLOAD"];
        m.dimensions.push({ name: "status", expr: "lower(status)", type: "string", status: "draft" });
        m.joins![0]!.keys = [{ from: "customer_id", to: "code" }];
      });
    });
    expect(st.sources[0]!.new_columns).toEqual([]);
  });

  test("an out-of-scope model's new columns are not reported, but the columns it reads are checked", async () => {
    const { st } = await built({ scope: { exclude: ["orders_tmp"] } }, (root) =>
      editSnapshot(root, (snap) => {
        tableOf(snap, "orders_tmp").columns.push({ name: "extra", type: "integer" });
        tableOf(snap, "orders_tmp").columns = tableOf(snap, "orders_tmp").columns.filter((c) => c.name !== "amount");
      }),
    );
    expect(st.sources[0]!.out_of_scope_models).toEqual(["orders_tmp"]);
    expect(st.sources[0]!.new_columns).toEqual([]);
    // The model is still served, so the column its approved measure reads opens drift.
    expect(st.sources[0]!.missing_columns).toEqual([{ model: "orders_tmp", field: "total", column: "amount" }]);
    expect(st.next_step).toMatchObject({ phase: "drift", source: "wh", command: "sl validate" });
    expect(st.next_step.message).toContain("orders_tmp.total (reads amount)");
  });

  test("drafting the new column clears it", async () => {
    const { st } = await built({}, (root) => {
      editSnapshot(root, (snap) => {
        tableOf(snap, "fct_orders").columns.push({ name: "discount", type: "integer" });
      });
      editModel(root, "orders", (m) => {
        m.measures.push({ name: "discount_total", expr: "discount", agg: "sum", status: "draft" });
      });
    });
    expect(st.sources[0]!.new_columns).toEqual([]);
    expect(st.sources[0]!.draft_fields).toContain("orders.discount_total");
    expect(st.next_step.phase).toBe("done");
  });

  test("a helper model over a modeled table raises only columns no model over the table reads or ignores", async () => {
    const { st } = await built({}, (root) => {
      editSnapshot(root, (snap) => {
        const c = tableOf(snap, "dim_customers");
        c.columns.push({ name: "is_test", type: "boolean" }, { name: "email", type: "varchar" }, { name: "tier", type: "varchar" });
      });
      editModel(root, "customers", (m) => {
        m.dimensions.push({ name: "email", expr: "email", type: "string", status: "draft" });
        m.ignored_columns = ["tier"];
      });
      // A helper model over the same table reads only id and is_test.
      writeYaml(join(root, "models", "wh", "test_accounts.yaml"), {
        model: "test_accounts",
        source: "wh",
        table: "main.dim_customers",
        status: "draft",
        primary_key: ["id"],
        dimensions: [{ name: "is_test", expr: "is_test", type: "boolean", status: "draft" }],
        measures: [],
      });
    });
    // amount, email and tier are read or ignored by customers, is_test by test_accounts: nothing is new.
    expect(st.sources[0]!.new_columns).toEqual([]);
  });

  test("a column no model over its table reads is listed once, under the model that reads the most columns", async () => {
    const { st } = await built({}, (root) => {
      editSnapshot(root, (snap) => {
        tableOf(snap, "dim_customers").columns.push({ name: "segment", type: "varchar" });
      });
      writeYaml(join(root, "models", "wh", "a_helper.yaml"), {
        model: "a_helper",
        source: "wh",
        table: "main.dim_customers",
        status: "draft",
        dimensions: [],
        measures: [{ name: "n", agg: "count", status: "draft" }],
      });
    });
    expect(st.sources[0]!.new_columns).toEqual([{ model: "customers", column: "segment", type: "varchar" }]);
    expect(st.next_step.command).toBe("sl draft --source wh --new-columns");
  });

  test("a partly profiled table is not profiled: status names it as needing a profile for new or retyped columns", async () => {
    const { st, root } = await built({}, (r) =>
      editSnapshot(r, (snap) => {
        const orders = tableOf(snap, "fct_orders");
        orders.profiled_at = null;
        orders.columns[0]!.profile = { null_fraction: 0, distinct_count: 10000 };
        tableOf(snap, "web_events").profiled_at = null;
      }),
    );
    const w = st.sources[0]!;
    expect(w.snapshot!.profiled).toBe(3);
    expect(w.unprofiled_tables).toEqual(["main.fct_orders", "main.web_events"]);
    expect(w.partially_profiled_tables).toEqual(["main.fct_orders"]);
    expect(st.next_step).toMatchObject({ phase: "profile", command: "sl profile --source wh" });
    expect(st.next_step.message).toBe(
      '1 in-scope table(s) in "wh" have no profile: main.web_events. ' +
        '1 in-scope table(s) in "wh" need a profile for new or retyped columns: main.fct_orders.',
    );
    const human = await sl(root, ["status"]);
    expect(human.out).toContain("5 tables, 5 in scope, 3 profiled, 1 partly profiled");
  });

  test("an approved field reading a removed column -> drift, before scope and profile", async () => {
    const { st } = await built({ wide: true, profiled: false }, (root) =>
      editSnapshot(root, (snap) => {
        const orders = tableOf(snap, "fct_orders");
        orders.columns = orders.columns.filter((c) => c.name !== "amount");
      }),
    );
    const w = st.sources[0]!;
    expect(w.needs_focus).toBe(true);
    expect(w.missing_columns).toEqual([{ model: "orders", field: "total", column: "amount" }]);
    expect(st.next_step).toMatchObject({ phase: "drift", source: "wh", command: "sl validate", after_owner_yes: false });
    expect(st.next_step.message).toContain("The table changed");
    expect(st.next_step.message).toContain("orders.total (reads amount)");
    expect(st.next_step.message).toContain("Read the affected items back to the owner");
  });

  test("a source without a snapshot is introspected before drift", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    editSnapshot(t.root, (snap) => {
      tableOf(snap, "fct_orders").columns = tableOf(snap, "fct_orders").columns.filter((c) => c.name !== "amount");
    });
    writeYaml(join(t.root, "sources", "lake.yaml"), { source: "lake", dialect: "duckdb" });
    const st = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(st.next_step).toMatchObject({ phase: "introspect", source: "lake" });
    const wh = (await sl(t.root, ["status", "--json", "--source", "wh"])).json<ProjectStatus>();
    expect(wh.next_step.phase).toBe("drift");
  });

  test("a draft field reading a removed column is listed but does not open drift", async () => {
    const { st } = await built({}, (root) => {
      editSnapshot(root, (snap) => {
        const orders = tableOf(snap, "fct_orders");
        orders.columns = orders.columns.filter((c) => c.name !== "amount");
      });
      editModel(root, "orders", (m) => {
        m.measures[0]!.status = "draft";
        delete m.measures[0]!.approved_by;
        delete m.measures[0]!.approved_at;
      });
    });
    expect(st.sources[0]!.missing_columns).toEqual([{ model: "orders", field: "total", column: "amount" }]);
    expect(st.next_step.phase).not.toBe("drift");
  });

  test("a dimension on a SQL keyword such as current_date does not open drift, matching validate", async () => {
    const { root, st } = await built({}, (r) =>
      editModel(r, "orders", (m) => {
        m.dimensions.push({ name: "today", expr: "current_date", type: "time", description: "Today.", ...approval(true) });
        m.dimensions.push({ name: "now_ts", expr: " NOW ", type: "time", description: "Now.", ...approval(true) });
      }),
    );
    expect(st.sources[0]!.missing_columns).toEqual([]);
    expect(st.next_step.phase).toBe("done");
    expect(validateProject(root).filter((i) => i.level === "error" && i.file.includes("orders.yaml") && i.path.startsWith("dimensions"))).toEqual([]);
  });

  test("a table with no known columns is not checked for missing columns, matching validate", async () => {
    const { root, st } = await built({}, (r) =>
      editSnapshot(r, (snap) => {
        tableOf(snap, "web_events").columns = [];
      }),
    );
    expect(st.sources[0]!.missing_columns).toEqual([]);
    expect(st.sources[0]!.new_columns).toEqual([]);
    expect(st.next_step.phase).toBe("done");
    expect(validateProject(root).filter((i) => i.level === "error" && i.file.includes("web_events"))).toEqual([]);
  });

  test("only exprs validate reads as one column are checked: not $ names or another dialect's quotes", async () => {
    const { root, st } = await built({}, (r) =>
      editModel(r, "orders", (m) => {
        m.dimensions.push({ name: "dollar", expr: "amount$", type: "number", description: "D.", ...approval(true) });
        m.dimensions.push({ name: "ticked", expr: "`gone`", type: "number", description: "T.", ...approval(true) });
      }),
    );
    expect(st.sources[0]!.missing_columns).toEqual([]);
    expect(st.next_step.phase).toBe("done");
    expect(validateProject(root).filter((i) => i.level === "error" && i.file.includes("orders.yaml") && i.path.startsWith("dimensions"))).toEqual([]);
  });

  test("a quoted column the table lost opens drift, and validate errors on it too", async () => {
    const { root, st } = await built({}, (r) =>
      editModel(r, "orders", (m) => {
        m.dimensions.push({ name: "quoted", expr: '"Gone Col"', type: "string", description: "Q.", ...approval(true) });
      }),
    );
    expect(st.sources[0]!.missing_columns).toEqual([{ model: "orders", field: "quoted", column: "Gone Col" }]);
    expect(st.next_step.phase).toBe("drift");
    expect(validateProject(root).some((i) => i.level === "error" && i.message.includes("Gone Col"))).toBe(true);
  });

  test("an approved model whose table left the snapshot -> drift naming the model and its table", async () => {
    const { st } = await built({}, (root) =>
      editSnapshot(root, (snap) => {
        snap.tables = snap.tables.filter((t) => t.name !== "web_events");
      }),
    );
    const w = st.sources[0]!;
    expect(w.missing_tables).toEqual([{ model: "web_events", table: "main.web_events" }]);
    expect(w.out_of_scope_models).toEqual(["web_events"]);
    expect(st.next_step).toMatchObject({ phase: "drift", source: "wh", command: "sl validate" });
    expect(st.next_step.message).toContain("1 approved model(s) in \"wh\" are built on a table the snapshot no longer has: web_events (main.web_events)");
  });

  test("a draft model whose table left the snapshot is listed but does not open drift", async () => {
    const { st } = await built({}, (root) => {
      editSnapshot(root, (snap) => {
        snap.tables = snap.tables.filter((t) => t.name !== "web_events");
      });
      editModel(root, "web_events", (m) => {
        m.status = "draft";
        delete m.approved_by;
        delete m.approved_at;
      });
    });
    expect(st.sources[0]!.missing_tables).toEqual([{ model: "web_events", table: "main.web_events" }]);
    expect(st.next_step.phase).not.toBe("drift");
  });

  test("a retyped column is neither new nor missing", async () => {
    const { st } = await built({}, (root) =>
      editSnapshot(root, (snap) => {
        tableOf(snap, "fct_orders").columns[1]!.type = "bigint";
      }),
    );
    expect(st.sources[0]!.new_columns).toEqual([]);
    expect(st.sources[0]!.missing_columns).toEqual([]);
  });

  test("human output lists missing and new columns per source", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    editSnapshot(t.root, (snap) => {
      const orders = tableOf(snap, "fct_orders");
      orders.columns = orders.columns.filter((c) => c.name !== "amount");
      orders.columns.push({ name: "discount", type: "integer" });
    });
    const r = await sl(t.root, ["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("  missing columns: orders.total reads amount");
    expect(r.out).toContain("  columns without a field: orders.discount (integer)");
    expect(r.out).toContain("Next step (drift)");
    editSnapshot(t.root, (snap) => {
      snap.tables = snap.tables.filter((x) => x.name !== "web_events");
    });
    const gone = await sl(t.root, ["status"]);
    expect(gone.out).toContain("  models on tables the snapshot no longer has: web_events (main.web_events)");
  });
});

describe("status after access.yaml is revoked", () => {
  test("a draft with last_approved reports it and says which version keeps applying", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { access: "draft" });
    const plain = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(plain.access.last_approved).toBeUndefined();
    expect(plain.next_step.message).not.toContain("keeps applying");
    const access = readYaml<Record<string, unknown>>(join(t.root, "access.yaml"));
    writeYaml(join(t.root, "access.yaml"), { ...access, last_approved: { by: "Dana", at: "2026-01-15" } });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.access.state).toBe("draft");
    expect(s.access.last_approved).toEqual({ by: "Dana", at: "2026-01-15" });
    expect(s.next_step.phase).toBe("access");
    expect(s.next_step.message).toContain(
      "The version approved by Dana on 2026-01-15 keeps applying where it is deployed; tools that load this draft serve nothing.",
    );
    const human = await sl(t.root, ["status"]);
    expect(human.out).toContain("access draft (2 role(s), the version approved by Dana on 2026-01-15 keeps applying where it is deployed)");
  });

  test("an approved access.yaml with a stale last_approved reports none", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    const access = readYaml<Record<string, unknown>>(join(t.root, "access.yaml"));
    writeYaml(join(t.root, "access.yaml"), { ...access, last_approved: { by: "Dana", at: "2026-01-15" } });
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().access.last_approved).toBeUndefined();
  });
});

describe("status row_filter_joins_without_goldens", () => {
  // A rep role filtered on customers; orders reaches customers through its customer join, and
  // web_events through order.customer once it joins orders.
  function repProject(root: string, role: Record<string, unknown> = {}): void {
    build(root, {});
    writeYaml(join(root, "access.yaml"), {
      status: "approved",
      approved_by: "Dana",
      approved_at: "2026-01-15",
      user_attributes: [{ name: "customer_id", type: "number" }],
      roles: [
        { name: "analyst", allow: { models: ["wh.*"] } },
        { name: "viewer", allow: { models: ["wh.orders"] } },
        { name: "rep", allow: { models: ["wh.*"] }, row_filters: [{ model: "wh.customers", expr: "id = {{ user.customer_id }}" }], ...role },
      ],
    });
    const events = model("web_events", true);
    const evidence = model("fct_orders", true, { evidence: true }).joins![0]!.evidence!;
    events.joins = [
      { name: "order", to: "orders", keys: [{ from: "id", to: "id" }], relationship: "many_to_one", ...approval(true), evidence },
      { name: "visits", to: "stg_events", keys: [{ from: "id", to: "id" }], relationship: "one_to_many", ...approval(true), evidence },
    ];
    writeYaml(join(root, "models", "wh", "web_events.yaml"), events);
  }
  const golden = (root: string, name: string, extra: Record<string, unknown>) =>
    writeYaml(join(root, "goldens", `${name}.yaml`), {
      name,
      question: "How much?",
      sql: "select 1",
      status: "approved",
      confirmed_by: "Dana",
      confirmed_at: "2026-01-15",
      ...extra,
    });

  test("lists each visible model that reaches a row-filtered model through one or two to-one joins", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    repProject(t.root);
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.row_filter_joins_without_goldens).toEqual([
      { role: "rep", model: "wh.orders", filtered_model: "wh.customers", join: "customer" },
      { role: "rep", model: "wh.web_events", filtered_model: "wh.customers", join: "order.customer" },
    ]);
    const human = await sl(t.root, ["status"]);
    expect(human.out).toContain(
      "row-filtered joins without an approved golden as the role: wh.orders -> wh.customers through customer (role rep), " +
        "wh.web_events -> wh.customers through order.customer (role rep)",
    );
  });

  test("an approved golden as the role naming a field of the model covers it, a draft one or another role's does not", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    repProject(t.root);
    golden(t.root, "rep_orders_draft", { role: "rep", request: { source: "wh", dimensions: ["orders.id_dim"] }, status: "draft" });
    golden(t.root, "analyst_events", { role: "analyst", request: { source: "wh", measures: ["web_events.total"] } });
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().row_filter_joins_without_goldens.map((x) => x.model)).toEqual([
      "wh.orders",
      "wh.web_events",
    ]);
    // A golden with no measures starts from its first dimension and covers that model.
    golden(t.root, "rep_orders", { role: "rep", request: { source: "wh", dimensions: ["orders.id_dim"] } });
    golden(t.root, "rep_events", { role: "rep", request: { source: "wh", measures: ["customers.total"], filters: [{ field: "web_events.id_dim", op: "eq", value: 1 }] } });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.row_filter_joins_without_goldens).toEqual([]);
    expect((await sl(t.root, ["status"])).out).not.toContain("row-filtered joins without");
  });

  test("a metric a golden names covers the models of its measures", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    repProject(t.root);
    golden(t.root, "rep_avg", { role: "rep", request: { source: "wh", measures: ["avg_total"] } });
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().row_filter_joins_without_goldens.map((x) => x.model)).toEqual(["wh.web_events"]);
  });

  test("a golden with no role covers default_role", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    repProject(t.root);
    const access = readYaml<Record<string, unknown>>(join(t.root, "access.yaml"));
    writeYaml(join(t.root, "access.yaml"), { ...access, default_role: "rep" });
    golden(t.root, "default_orders", { request: { source: "wh", measures: ["orders.total", "web_events.total"] } });
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().row_filter_joins_without_goldens).toEqual([]);
  });

  test("a golden with no role runs as the roles its user meets, and default_role only when it meets none", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    repProject(t.root, { assign_when: "user.department == 'sales'" });
    const access = readYaml<Record<string, unknown>>(join(t.root, "access.yaml"));
    writeYaml(join(t.root, "access.yaml"), {
      ...access,
      default_role: "viewer",
      user_attributes: [...(access.user_attributes as unknown[]), { name: "department", type: "string" }],
    });
    // g0 is the only golden as viewer.
    rmSync(join(t.root, "goldens", "g0.yaml"));
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().roles_without_goldens).toEqual(["viewer", "rep"]);
    // Its user meets rep's assign_when, so it runs as rep and covers orders; it does not run as viewer.
    golden(t.root, "sales_orders", { user: { department: "sales", customer_id: 1 }, request: { source: "wh", dimensions: ["orders.id_dim"] } });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.row_filter_joins_without_goldens.map((x) => x.model)).toEqual(["wh.web_events"]);
    expect(s.roles_without_goldens).toEqual(["viewer"]);
    // A role named in another letter case is the same role.
    golden(t.root, "rep_events", { role: "Rep", request: { source: "wh", dimensions: ["web_events.id_dim"] } });
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().row_filter_joins_without_goldens).toEqual([]);
    // A user who meets no condition runs as default_role.
    golden(t.root, "other_orders", { user: { department: "ops" }, request: { source: "wh", dimensions: ["orders.id_dim"] } });
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().roles_without_goldens).toEqual([]);
  });

  test("a model the role does not see is not listed, and a one_to_many join is not followed", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    repProject(t.root, { deny: { models: ["wh.web_events"] } });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.row_filter_joins_without_goldens).toEqual([{ role: "rep", model: "wh.orders", filtered_model: "wh.customers", join: "customer" }]);
    // stg_events reaches nothing through to-one joins: web_events' visits join is one_to_many.
    const t2 = tempRoot();
    const c1 = cleanup;
    cleanup = () => {
      c1?.();
      t2.cleanup();
    };
    repProject(t2.root, { row_filters: [{ model: "wh.stg_events", expr: "id = {{ user.customer_id }}" }] });
    expect((await sl(t2.root, ["status", "--json"])).json<ProjectStatus>().row_filter_joins_without_goldens).toEqual([]);
  });

  test("no access.yaml or no row filters means none", async () => {
    expect((await status({ access: "missing" })).row_filter_joins_without_goldens).toEqual([]);
    expect((await status({})).row_filter_joins_without_goldens).toEqual([]);
  });

  test("the done step names them for the handoff", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    repProject(t.root);
    golden(t.root, "rep_customers", { role: "rep", request: { source: "wh", measures: ["customers.total"] } });
    golden(t.root, "rep_orders", { role: "rep", request: { source: "wh", measures: ["orders.total"] } });
    const s = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(s.next_step.phase).toBe("done");
    expect(s.next_step.message).toContain(
      "models that reach a row-filtered model through joins with no approved golden as the role: wh.web_events -> wh.customers through order.customer (role rep)",
    );
  });
});

describe("status reapprove phase", () => {
  test("a complete layer whose approved items predate hashes does not reapprove", async () => {
    const { st } = await built({});
    expect(st.changed_since_approval).toEqual([]);
    expect(st.next_step.phase).toBe("done");
  });

  test("an approved measure, metric and access file edited after approval open reapprove, ahead of the interview", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, { models: "draft" });
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().next_step.phase).toBe("interview");
    // Stamped first: once an item records a hash, --stamp-hashes refuses the approved items without one.
    expect((await sl(t.root, ["approve", "--stamp-hashes"])).code).toBe(0);
    expect((await sl(t.root, ["approve", "--target", "wh.orders.total", "--by", "Dana"])).code).toBe(0);
    // The analytics review's experiment: the approved measure now sums a thousand times the amount.
    editModel(t.root, "orders", (m) => (m.measures[0]!.expr = "amount * 1000"));
    const path = join(t.root, "access.yaml");
    writeYaml(path, { ...readYaml<Record<string, unknown>>(path), roles: [{ name: "analyst", allow: { models: ["wh.orders"] } }] });
    const st = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(st.changed_since_approval).toEqual(["wh.orders.total", "access"]);
    expect(st.next_step).toEqual({
      phase: "reapprove",
      message:
        "2 approved item(s) changed since they were approved: wh.orders.total, access. Read each back to the owner as it now stands and approve it again " +
        "only after they confirm, or restore the approved definition; sl validate names each one. Until then tools treat each one as a draft (sl access lists them).",
      command: 'sl approve --target wh.orders.total --by "<owner>"',
      after_owner_yes: true,
    });
    expect(st.hash_missing).toEqual([]);
    const human = await sl(t.root, ["status"]);
    expect(human.out).toContain("changed since approval: wh.orders.total, access");
    expect(human.out).toContain("Next step (reapprove)");
    // Approving the measure again after the readback clears it from the list.
    expect((await sl(t.root, ["approve", "--target", "wh.orders.total", "--by", "Dana"])).code).toBe(0);
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().changed_since_approval).toEqual(["access"]);
  });

  test("an approved item whose approved_hash was removed opens reapprove, listed apart from the changed ones", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    expect((await sl(t.root, ["approve", "--stamp-hashes"])).code).toBe(0);
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().next_step.phase).toBe("done");
    editModel(t.root, "orders", (m) => {
      m.measures[0]!.expr = "amount * 1000";
      delete m.measures[0]!.approved_hash;
    });
    const st = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(st.changed_since_approval).toEqual([]);
    expect(st.hash_missing).toEqual(["wh.orders.total"]);
    expect(st.next_step).toEqual({
      phase: "reapprove",
      message:
        "1 approved item(s) have no approved_hash while other approved items carry one, so it may have been removed: wh.orders.total. " +
        "Read each back to the owner as it now stands and approve it again only after they confirm, or restore the approved definition; sl validate names each one. " +
        "Until then tools treat each one as a draft (sl access lists them).",
      command: 'sl approve --target wh.orders.total --by "<owner>"',
      after_owner_yes: true,
    });
    expect((await sl(t.root, ["status"])).out).toContain("approved without approved_hash while others carry one: wh.orders.total");
    expect((await sl(t.root, ["approve", "--target", "wh.orders.total", "--by", "Dana"])).code).toBe(0);
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().hash_missing).toEqual([]);
  });

  test("a changed approved metric is listed, and drift still comes first", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    build(t.root, {});
    expect((await sl(t.root, ["approve", "--stamp-hashes"])).code).toBe(0);
    const path = join(t.root, "metrics.yaml");
    const file = readYaml<{ metrics: Record<string, unknown>[] }>(path);
    file.metrics[0]!.denominator = "orders.total";
    writeYaml(path, file);
    const st = (await sl(t.root, ["status", "--json"])).json<ProjectStatus>();
    expect(st.changed_since_approval).toEqual(["metric:avg_total"]);
    expect(st.next_step.phase).toBe("reapprove");
    editSnapshot(t.root, (snap) => {
      const orders = tableOf(snap, "fct_orders");
      orders.columns = orders.columns.filter((c) => c.name !== "amount");
    });
    expect((await sl(t.root, ["status", "--json"])).json<ProjectStatus>().next_step.phase).toBe("drift");
  });

  test("the new-columns step says a column left out on purpose goes in ignored_columns", async () => {
    const { st } = await built({}, (root) => editSnapshot(root, (snap) => tableOf(snap, "fct_orders").columns.push({ name: "discount", type: "integer" })));
    expect(st.next_step.phase).toBe("draft");
    expect(st.next_step.message).toContain("A column the owner left out on purpose goes in the model's ignored_columns instead.");
  });
});

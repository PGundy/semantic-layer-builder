import { describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { GLOBAL_OPTIONS } from "../skills/semantic-layer/scripts/lib/cli.ts";
import type { NextAction } from "../skills/semantic-layer/scripts/lib/next.ts";
import { actionText, type ProjectStatus, statusDetail, type StepAction } from "../skills/semantic-layer/scripts/lib/status.ts";
import type { Snapshot } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { loadScenario, loadScript, REPO_ROOT, SCENARIOS_DIR, scriptWritePath } from "../evals/runner/files.ts";
import { runScenario, slIn, steppingClock } from "../evals/runner/runner.ts";
import type { Driver } from "../evals/runner/types.ts";
import { initProject, sl, tempDir } from "./helpers.ts";

// HR-12: sl next never names a step that cannot run. Each bullet of HR-12 is a test below, and a
// walk drives the Acme states and checks the command named at each. All data is synthetic.

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const ORDERS = "warehouse.orders";
const URL_LINE = "WAREHOUSE_URL=postgres://reader:synthetic@localhost:5432/acme\n";
const SL = join(REPO_ROOT, "skills", "semantic-layer", "scripts", "sl.ts");

// A copy of the Acme example layer; with `env`, the .env beside it sets its connection variable.
function acme(env = true): string {
  const dir = tempDir();
  const root = join(dir, "semantic");
  cpSync(ACME, root, { recursive: true });
  if (env) writeFileSync(join(dir, ".env"), URL_LINE);
  return root;
}

async function ok(root: string, args: string[]): Promise<string> {
  const r = await sl(root, args);
  if (r.code !== 0) throw new Error(`sl ${args.join(" ")}: ${r.err}`);
  return r.out;
}

async function next(root: string): Promise<NextAction & { human: string }> {
  const a = await sl(root, ["next", "--json"]);
  expect(a.err).toBe("");
  expect(a.code).toBe(0);
  const action = a.json<NextAction>();
  const human = (await sl(root, ["next"])).out;
  await expectRunnable(root, action, human);
  return { ...action, human };
}

const status = async (root: string) => (await sl(root, ["status", "--json"])).json<ProjectStatus>();

// The flag's value in an action's arguments.
const flag = (a: StepAction, f: string) => (a.args.includes(f) ? a.args[a.args.indexOf(f) + 1] : undefined);

// The command sl next names parses with the CLI's own parser, names targets that exist, holds no
// <placeholder> unless the owner is asked first, and is what both outputs print.
async function expectRunnable(root: string, a: NextAction, human: string): Promise<void> {
  const act = a.action as StepAction;
  const load = COMMANDS[act.command];
  expect(load, `sl ${act.command} is a command`).toBeDefined();
  const spec = (await load!()).default;
  expect(() => parseArgs({ args: act.args, options: { ...GLOBAL_OPTIONS, ...spec.options }, allowPositionals: spec.positionals ?? false, strict: true })).not.toThrow();
  const text = actionText(act);
  if (a.kind === "run") expect(a.run!.command).toBe(text);
  if (a.kind === "run" || (a.kind === "ask_owner" && !a.ask_owner?.readback_id)) expect(human.split("\n").at(-1)).toEndWith(text);
  if (a.kind === "ask_owner" || a.kind === "dispatch") return;
  expect(act.args.filter((x) => /<[^>]+>/.test(x)), text).toEqual([]);
  const d = statusDetail(root);
  const source = flag(act, "--source");
  if (source) expect(existsSync(join(root, "sources", `${source}.yaml`)), text).toBe(true);
  const exists = (ref: string) => (ref.startsWith("golden:") ? existsSync(join(root, "goldens", `${ref.slice(7)}.yaml`)) : d.targets.has(ref));
  for (const ref of [flag(act, "--target"), ...(flag(act, "--targets")?.split(",") ?? [])].filter((r): r is string => !!r)) expect(exists(ref), `${text}: ${ref}`).toBe(true);
  if (act.command === "goldens" && flag(act, "--name") && act.args[0] !== "new") expect(existsSync(join(root, "goldens", `${flag(act, "--name")}.yaml`)), text).toBe(true);
  const model = flag(act, "--model");
  if (model) {
    const file = join(root, "models", source!, `${model}.yaml`);
    expect(existsSync(file), text).toBe(true);
    const joins = (readYaml<{ joins?: { name: string }[] }>(file).joins ?? []).map((j) => j.name);
    expect(joins, text).toContain(flag(act, "--join")!);
  }
  if (flag(act, "--readback")) expect(existsSync(join(root, ".sl", "pending", `${flag(act, "--readback")}.json`)), text).toBe(true);
  if (flag(act, "--plan")) expect(existsSync(join(root, ".sl", "plans", `${flag(act, "--plan")}.json`)), text).toBe(true);
}

describe("HR-12: sl next never names a step that cannot run", () => {
  test("Step carries a structured action; next prints it and parses no command text", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", ORDERS, "--revoke", "--recursive"]);
    const st = await status(root);
    expect(st.next_step.action.command).toBe("readback");
    expect(st.next_step.command).toBe(actionText(st.next_step.action));
    const a = await next(root);
    expect(a.action).toEqual(st.next_step.action);
    // next.ts reads the action, never the text: no pattern over a printed sl command remains.
    const source = readFileSync(join(REPO_ROOT, "skills", "semantic-layer", "scripts", "lib", "next.ts"), "utf8");
    expect(source).not.toMatch(/\.exec\((step|st\.next_step)\.command\)|step\.command\.(endsWith|startsWith|slice)/);
  });

  test("status, next and approve read the ledger the same way: a line approve rejects counts as a yes nowhere", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", ORDERS, "--revoke"]);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", ORDERS, "--json"])) as { readback_id: string };
    await ok(root, ["reply", "--readback", rb.readback_id, "--item", "1", "--text", "Yes.", "--verdict", "yes", "--by", "Dana"]);
    expect((await next(root)).run!.command).toBe(`sl approve --target ${ORDERS}`);
    // A later line approve refuses the whole ledger over: none of its yeses count in status or next.
    appendFileSync(join(root, ".sl", "ledger.jsonl"), '{"kind":"reply","target":"warehouse.orders"}\n');
    expect((await sl(root, ["approve", "--target", ORDERS])).code).toBe(1);
    const st = await status(root);
    expect(st.next_step.command).toBe(`sl readback --targets ${ORDERS}`);
    expect(st.approved_without_yes).toContain(`${ORDERS}.revenue`);
    const a = await next(root);
    expect(a).toMatchObject({ kind: "run", run: { command: "sl validate" } });
    expect(a.why).toContain("cannot be read");
  });

  test("a ledger behind a link: sl next names sl validate, and sl validate reports the link", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", ORDERS, "--revoke"]);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", ORDERS, "--json"])) as { readback_id: string };
    await ok(root, ["reply", "--readback", rb.readback_id, "--item", "1", "--text", "Yes.", "--verdict", "yes", "--by", "Dana"]);
    const ledger = join(root, ".sl", "ledger.jsonl");
    const outside = join(tempDir(), "ledger.jsonl");
    writeFileSync(outside, readFileSync(ledger, "utf8"));
    const { rmSync, symlinkSync } = await import("node:fs");
    rmSync(ledger);
    symlinkSync(outside, ledger);
    const a = await next(root);
    expect(a).toMatchObject({ kind: "run", run: { command: "sl validate" } });
    expect(a.why).toContain("not a plain file inside the semantic root");
    const v = await sl(root, ["validate", "--json"]);
    expect(v.code).toBe(1);
    expect(v.json<{ issues: { level: string; file: string; message: string }[] }>().issues).toContainEqual(expect.objectContaining({ level: "error", file: ".sl/ledger.jsonl", message: expect.stringContaining("not a plain file inside the semantic root") }));
  });

  test("a connection block sl cannot resolve names sl validate, not a failing command", async () => {
    const root = acme();
    const src = join(root, "sources", "warehouse.yaml");
    writeFileSync(src, readFileSync(src, "utf8").replace("  env: WAREHOUSE_URL\n", "  env: WAREHOUSE_URL\n  env_prefix: ACME_PG\n"));
    const file = join(root, "snapshots", "warehouse.json");
    const snap = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
    delete snap.tables.find((t) => t.name === "fct_orders")!.profiled_at;
    writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
    const a = await next(root);
    expect(a).toMatchObject({ kind: "run", phase: "profile", run: { command: "sl validate" } });
    expect(a.why).toContain('source "warehouse"');
  });

  test("an unset connection variable gives ask_owner, blocked_on naming the variable and the env file, never sl profile", async () => {
    const root = acme(false);
    const file = join(root, "snapshots", "warehouse.json");
    const snap = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
    for (const t of snap.tables) delete t.profiled_at;
    writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
    expect((await status(root)).next_step.command).toBe("sl profile --source warehouse");
    const envFile = join(dirname(root), ".env");
    const a = await next(root);
    expect(a).toMatchObject({
      kind: "ask_owner",
      phase: "profile",
      blocked_on: `connection: WAREHOUSE_URL in ${envFile}`,
      action: { command: "setup", args: ["--source", "warehouse", "--dialect", "postgres", "--env", "WAREHOUSE_URL"], kind: "ask_owner" },
      connection: { source: "warehouse", variables: ["WAREHOUSE_URL"], add_to: envFile, line_to_add: "WAREHOUSE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require" },
    });
    expect(a.human).not.toContain("\n  sl profile");
    expect(a.ask_owner!.text).toContain("WAREHOUSE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require");
    // One next step only: the resolver's "run the same command again" is not quoted beside it.
    expect(a.why).not.toContain("run the same command again");
    // With the line added, the step runs (Acme's models hold open questions, so blocked_on names them).
    writeFileSync(envFile, URL_LINE);
    expect(await next(root)).toMatchObject({ kind: "run", blocked_on: "open_questions", run: { command: "sl profile --source warehouse" } });
  });

  test("a connection in parts names only the missing parts and never prints a value it found (invariant: no secrets)", async () => {
    const root = acme(false);
    const src = join(root, "sources", "warehouse.yaml");
    writeFileSync(src, readFileSync(src, "utf8").replace("  env: WAREHOUSE_URL\n", "  env_prefix: ACME_PG\n"));
    const file = join(root, "snapshots", "warehouse.json");
    const snap = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
    delete snap.tables.find((t) => t.name === "fct_orders")!.profiled_at;
    writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
    writeFileSync(join(dirname(root), ".env"), "ACME_PGPASSWORD=synthetic-pw-4417\nACME_PGUSER=reader\n");
    const raw = await sl(root, ["next", "--json"]);
    const human = await sl(root, ["next"]);
    for (const out of [raw.out, raw.err, human.out, human.err]) expect(out).not.toContain("synthetic-pw-4417");
    const a = raw.json<NextAction>();
    expect(a.kind).toBe("ask_owner");
    expect(a.connection!.variables).toEqual(["ACME_PGHOST", "ACME_PGDATABASE"]);
    expect(a.blocked_on).toBe(`connection: ACME_PGHOST, ACME_PGDATABASE in ${join(dirname(root), ".env")}`);
    expect(a.action.args).toEqual(["--source", "warehouse", "--dialect", "postgres", "--env-prefix", "ACME_PG"]);
  });

  test("skipped tables give the retry, or the question to ask on a missing permission, never the same failing command", async () => {
    const root = acme();
    const file = join(root, "snapshots", "warehouse.json");
    const edit = (f: (s: Snapshot) => void) => {
      const snap = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
      f(snap);
      writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
    };
    const name = (t: Snapshot["tables"][number]) => `${t.schema}.${t.name}`;
    const snap = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
    const [a1, a2, a3] = snap.tables.filter((t) => t.name.startsWith("fct_orders") && !t.name.endsWith("_test")).concat(snap.tables.filter((t) => t.name.startsWith("dim_") && t.name !== "dim_currency" && !t.name.endsWith("_archive")));
    // One never tried, one denied: the plain run comes first, since it profiles the untried table.
    edit((s) => {
      for (const t of s.tables) {
        if (name(t) === name(a1!)) delete t.profiled_at;
        if (name(t) === name(a2!)) {
          delete t.profiled_at;
          t.profile_skipped = { at: "2026-01-15T12:00:00.000Z", reason: "no SELECT permission" };
        }
      }
    });
    expect((await next(root)).run!.command).toBe("sl profile --source warehouse");
    // Only the denied one left: the owner is asked for a grant or an exclusion with a reason.
    edit((s) => {
      for (const t of s.tables) if (name(t) === name(a1!)) t.profiled_at = "2026-01-15T12:00:00.000Z";
    });
    let a = await next(root);
    expect(a).toMatchObject({ kind: "ask_owner", phase: "profile", action: { command: "scope", args: ["--source", "warehouse", "--exclude", name(a2!), "--reason", "<owner's reason>", "--write"] } });
    expect(a.why).toContain("no SELECT permission");
    expect(a.why).toContain("sl setup --print-role-sql");
    // A timeout beside it: just the timed-out table is retried, with what to change named.
    edit((s) => {
      for (const t of s.tables)
        if (name(t) === name(a3!)) {
          delete t.profiled_at;
          t.profile_skipped = { at: "2026-01-15T12:00:00.000Z", reason: "timed out after 30 s (raise SL_STATEMENT_TIMEOUT_MS)" };
        }
    });
    a = await next(root);
    expect(a).toMatchObject({ kind: "run", run: { command: `sl profile --source warehouse --tables ${name(a3!)}` } });
    expect(a.why).toContain("raise SL_STATEMENT_TIMEOUT_MS");
    expect((await status(root)).sources[0]!.profile_skipped.map((g) => g.table).sort()).toEqual([name(a2!), name(a3!)].sort());
  });

  test("no goldens yet gives sl goldens new; the metrics phase gives the action for its kind", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", "access", "--revoke"]);
    for (const f of ["metrics.yaml"]) writeFileSync(join(root, f), "metrics: []\n");
    let a = await next(root);
    expect(a).toMatchObject({ kind: "ask_owner", phase: "metrics", action: { command: "add-metric", kind: "ask_owner" } });
    expect(a.human).toContain("Ask the owner, then: sl add-metric --name <metric> --type ratio|derived");

    const root2 = join(tempDir(), "semantic");
    cpSync(ACME, root2, { recursive: true });
    writeFileSync(join(dirname(root2), ".env"), URL_LINE);
    const { rmSync, readdirSync } = await import("node:fs");
    for (const g of readdirSync(join(root2, "goldens"))) rmSync(join(root2, "goldens", g));
    a = await next(root2);
    expect(a).toMatchObject({ kind: "ask_owner", phase: "verify", action: { command: "goldens", kind: "ask_owner" } });
    expect(a.action.args.slice(0, 3)).toEqual(["new", "--name", "<golden>"]);
    expect(a.human).not.toContain("sl goldens run --name <golden>");
  });

  test("open questions in any file, a model's included, set blocked_on", async () => {
    const root = acme();
    for (const m of ["products", "customers"]) {
      const f = join(root, "models", "warehouse", `${m}.yaml`);
      writeFileSync(f, readFileSync(f, "utf8").replace(/^open_questions:\n(?: .*\n)*/m, ""));
    }
    expect(await next(root)).toMatchObject({ phase: "done", blocked_on: null });
    await ok(root, ["question", "add", "warehouse.regions", "--text", "Does EMEA include Turkey?"]);
    expect((await status(root)).next_step).toMatchObject({ phase: "done", blocked_on: "open_questions" });
    expect(await next(root)).toMatchObject({ phase: "done", blocked_on: "open_questions" });
  });

  test("open questions in access.yaml set blocked_on, whatever the step", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", "access", "--revoke"]);
    await ok(root, ["question", "add", "access", "--text", "Should sales see refunds?"]);
    await ok(root, ["approve", "--target", ORDERS, "--revoke", "--recursive"]);
    const st = await status(root);
    expect(st.next_step.phase).toBe("interview");
    expect(st.next_step.blocked_on).toBe("open_questions");
    expect(await next(root)).toMatchObject({ kind: "run", phase: "interview", blocked_on: "open_questions" });
  });

  test("a pending change reply is surfaced in why with the owner's words", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", ORDERS, "--revoke", "--recursive"]);
    const refs = [`${ORDERS}.revenue`, `${ORDERS}.order_count`];
    const rb = JSON.parse(await ok(root, ["readback", "--targets", refs.join(","), "--json"])) as { readback_id: string };
    await ok(root, ["reply", "--readback", rb.readback_id, "--item", "1", "--text", "Revenue should leave out refunds.", "--verdict", "change", "--by", "Dana"]);
    const a = await next(root);
    expect(a.kind).toBe("ask_owner");
    expect(a.ask_owner!.items.map((i) => i.n)).toEqual([2]);
    expect(a.why).toContain(`item 1 (${ORDERS}.revenue, ans_0001, Dana said change): "Revenue should leave out refunds."`);
  });

  test("a golden on a source sl cannot run goes plan, readback from the plan, confirm with the plan, never a placeholder", async () => {
    const root = acme();
    const src = join(root, "sources", "warehouse.yaml");
    writeFileSync(src, readFileSync(src, "utf8").replace("connection:\n  env: WAREHOUSE_URL\n", ""));
    const { rmSync, readdirSync } = await import("node:fs");
    const keep = ["revenue_2025", "discount_2025", "order_count_by_region_2025", "revenue_by_region_2025", "new_customers_2025"].map((g) => `${g}.yaml`);
    for (const g of readdirSync(join(root, "goldens"))) if (!keep.includes(g)) rmSync(join(root, "goldens", g));
    const name = "new_customers_2025";
    let a = await next(root);
    expect(a.action).toEqual({ command: "goldens", args: ["run", "--name", name, "--emit-sql"], kind: "run" });
    const plan = JSON.parse(await ok(root, ["goldens", ...a.action.args, "--json"])) as { plan_id: string; queries: { id: string }[] };
    // While the plan waits on results, the connector runner is dispatched.
    expect((await next(root)).kind).toBe("dispatch");
    const rows = join(tempDir(), "rows.json");
    writeFileSync(rows, '[{"new_customers": 123}]\n');
    for (const q of plan.queries) await ok(root, ["results", "add", "--plan", plan.plan_id, "--query", q.id, "--file", rows]);
    // Every result stored: the readback from that plan, not the plan's finish again.
    a = await next(root);
    expect(a.action).toEqual({ command: "readback", args: ["--targets", `golden:${name}`, "--plan", plan.plan_id], kind: "run" });
    const rb = JSON.parse(await ok(root, ["readback", ...a.action.args, "--json"])) as { readback_id: string };
    await ok(root, ["reply", "--readback", rb.readback_id, "--item", "1", "--text", "Yes, 123.", "--verdict", "yes", "--by", "Dana"]);
    // The owner's yes: confirm with the plan's id (the source names no connection, so no live run).
    a = await next(root);
    expect(a.action).toEqual({ command: "goldens", args: ["confirm", "--name", name, "--plan", plan.plan_id], kind: "run" });
    await ok(root, ["goldens", ...a.action.args]);
    expect((await status(root)).goldens.approved).toBe(5);
  });

  test("golden counts agree between sl next and sl status", async () => {
    const root = acme();
    const { rmSync, readdirSync } = await import("node:fs");
    const keep = ["revenue_2025.yaml", "net_revenue_2025.yaml", "discount_2025.yaml"];
    for (const g of readdirSync(join(root, "goldens"))) if (!keep.includes(g)) rmSync(join(root, "goldens", g));
    const st = await status(root);
    expect(st.goldens).toEqual({ approved: 3, draft: 0 });
    const a = await next(root);
    expect(a.phase).toBe("verify");
    expect(a.why).toContain("3 of 3 golden(s) approved; the verify phase needs 5 approved");
    expect((await sl(root, ["status"])).out).toContain("goldens 3/3 approved (the verify phase needs 5)");
  });

  test("sl readback --discard removes a pending readback; sl next names it where it said to delete the file", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", ORDERS, "--revoke"]);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", ORDERS, "--json"])) as { readback_id: string };
    const a = await next(root);
    expect(a.why).toContain(`set aside with sl readback --discard ${rb.readback_id}`);
    expect(a.why).not.toContain("deleting .sl/pending");
    const out = await sl(root, ["readback", "--discard", rb.readback_id, "--json"]);
    expect(out.code).toBe(0);
    expect(out.json()).toEqual({ discarded: rb.readback_id, path: `.sl/pending/${rb.readback_id}.json`, next: "sl next" });
    expect(existsSync(join(root, ".sl", "pending", `${rb.readback_id}.json`))).toBe(false);
    expect((await next(root)).run!.command).toBe(`sl readback --targets ${ORDERS}`);
    // A discarded id is not handed out again while the ledger names it.
    const again = await sl(root, ["readback", "--discard", rb.readback_id]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("There is no pending readback");
    expect((await sl(root, ["readback", "--discard", "rb_0001", "--targets", ORDERS])).err).toContain("--discard takes no --targets");
  });

  test("the hook lets the interviewer run sl readback --discard, and the integrity check keeps the removal", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", ORDERS, "--revoke"]);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", ORDERS, "--json"])) as { readback_id: string };
    const command = `bun ${SL} readback --discard ${rb.readback_id} --root ${root}`;
    const call = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: dirname(root), agent_type: "semantic-layer-builder:sl-interviewer", agent_id: "a1" };
    expect(checkToolUse(JSON.stringify(call))).toEqual({ allow: true });
    const { runAfter, runBefore } = await import("../skills/semantic-layer/scripts/hooks/integrity.ts");
    const state = join(tempDir("h12-state"), "ledger-guard");
    const payload = { session_id: "s1", cwd: dirname(root), tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_1" };
    expect(runBefore(JSON.stringify({ hook_event_name: "PreToolUse", ...payload }), true, { stateDir: state, env: {} })).toEqual({ block: false });
    await ok(root, ["readback", "--discard", rb.readback_id]);
    expect(runAfter(JSON.stringify({ hook_event_name: "PostToolUse", ...payload }), { stateDir: state, env: {} })).toEqual({ block: false });
    expect(existsSync(join(root, ".sl", "pending", `${rb.readback_id}.json`))).toBe(false);
  });

  test("sl scope --exclude takes --reason, recorded with the entry and shown by sl scope --explain", async () => {
    const root = acme();
    expect((await sl(root, ["scope", "--source", "warehouse", "--reason", "Old copy."])).err).toContain("--reason records why --exclude leaves tables out");
    await ok(root, ["scope", "--source", "warehouse", "--exclude", "acme.fct_refunds", "--reason", "Refunds are reported by finance, not here.", "--write"]);
    const src = readYaml<{ scope: { exclude: string[]; exclude_reasons: Record<string, string> } }>(join(root, "sources", "warehouse.yaml"));
    expect(src.scope.exclude).toContain("acme.fct_refunds");
    expect(src.scope.exclude_reasons).toEqual({ "acme.fct_refunds": "Refunds are reported by finance, not here." });
    // The earlier comment-free file keeps its other entries; validate accepts the new key.
    expect((await sl(root, ["validate", "--json"])).json<{ issues: { level: string; path: string }[] }>().issues.filter((i) => i.path.startsWith("scope"))).toEqual([]);
    const explain = await sl(root, ["scope", "--source", "warehouse", "--explain", "fct_refunds"]);
    expect(explain.out).toContain("Reason recorded: Refunds are reported by finance, not here.");
    const json = (await sl(root, ["scope", "--source", "warehouse", "--explain", "fct_refunds", "--json"])).json<{ reason: string | null; in_scope: boolean }>();
    expect(json).toMatchObject({ in_scope: false, reason: "Refunds are reported by finance, not here." });
    // Removing the pattern removes its reason.
    await ok(root, ["scope", "--source", "warehouse", "--remove", "acme.fct_refunds", "--write"]);
    expect(readYaml<{ scope: Record<string, unknown> }>(join(root, "sources", "warehouse.yaml")).scope.exclude_reasons).toBeUndefined();
  });

  test("after a plain change reply, sl next asks the owner with their note and both ways out; a change only to who sees it reads the item back", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", ORDERS, "--revoke"]);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", ORDERS, "--json"])) as { readback_id: string };
    await ok(root, ["reply", "--readback", rb.readback_id, "--item", "1", "--text", "Sales reps should not see this table.", "--verdict", "change", "--by", "Dana"]);
    let a = await next(root);
    expect(a).toMatchObject({ kind: "ask_owner", phase: "interview", action: { command: "set", args: [ORDERS, "<key>", "<value>"], kind: "ask_owner" } });
    expect(a.why).toContain(`${ORDERS} (ans_0001, Dana said change): "Sales reps should not see this table."`);
    expect(a.why).toContain("a typed edit (sl set");
    expect(a.why).toContain(`sl reply --readback ${rb.readback_id} --item 1 --text "<owner's words>" --verdict change --about access`);
    expect(a.ask_owner!.text).toContain('"Sales reps should not see this table."');
    // Recorded as a change to who sees it, the item is read back again for the rest of it.
    await ok(root, ["reply", "--readback", rb.readback_id, "--item", "1", "--text", "Sales reps should not see this table.", "--verdict", "change", "--about", "access", "--by", "Dana"]);
    a = await next(root);
    expect(a).toMatchObject({ kind: "run", run: { command: `sl readback --targets ${ORDERS}` } });
  });
});

describe("HR-12 walk: the command sl next names at each state runs", () => {
  test("an empty directory names sl init, a root with no source asks the owner for one", async () => {
    const dir = tempDir();
    const root = join(dir, "semantic");
    const empty = await sl(root, ["next", "--json"]);
    expect(empty.code).toBe(1);
    const next0 = empty.json<{ next: string }>().next;
    const [, name, ...args] = next0.split(" ");
    expect(name).toBe("init");
    expect(() => parseArgs({ args, options: { ...GLOBAL_OPTIONS, name: { type: "string" } }, strict: true })).not.toThrow();
    await initProject(root);
    expect(await next(root)).toMatchObject({ kind: "ask_owner", phase: "add-source" });
  });

  test("the Acme scripted scenario, state by state", async () => {
    const file = join(SCENARIOS_DIR, "acme-structured.json");
    const scenario = loadScenario(file);
    const script = loadScript(scenario, file);
    const clock = steppingClock("2026-06-01T00:00:00Z");
    let at = 0;
    let ownerAt = 0;
    const seen: string[] = [];
    const driver: Driver = {
      async skillTurn(input) {
        // The state before this turn: what sl next names runs.
        const r = await slIn(input.root, ["next", "--json"], clock);
        expect(r.code).toBe(0);
        const action = JSON.parse(r.out) as NextAction;
        const human = (await slIn(input.root, ["next"], clock)).out;
        await expectRunnable(input.root, action, human);
        seen.push(`${action.kind}:${action.phase}:${actionText(action.action as StepAction)}`);
        const turn = script.skill[at++]!;
        for (const [rel, text] of Object.entries(turn.write ?? {})) {
          const path = scriptWritePath(input.root, rel, text);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text);
        }
        for (const args of turn.sl ?? []) await slIn(input.root, args.map((x) => x.replaceAll("{fixture}", relative(input.root, join(REPO_ROOT, "fixtures", scenario.fixture)).split(sep).join("/"))), clock);
        while (script.skill[at]?.agent) at++;
        return { text: turn.text, tokens: turn.tokens ?? 1, done: turn.done === true };
      },
      async ownerTurn() {
        const turn = script.owner[ownerAt++]!;
        return { text: turn.text, tokens: turn.tokens ?? 1 };
      },
    };
    const r = await runScenario({ scenario, driver, driverName: "scripted", clock: steppingClock("2026-01-01T00:00:00Z"), outDir: tempDir("h12-walk"), scenarioFile: file });
    expect(r.summary.stop_reason).toBe("done");
    expect(seen.length).toBeGreaterThan(3);
    // The states walked through reach the interview's readbacks and the goldens.
    expect(seen.some((s) => s.includes(":interview:") || s.includes(":verify:") || s.includes(":done:"))).toBe(true);
  }, 120_000);
});

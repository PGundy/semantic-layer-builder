import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../skills/semantic-layer/scripts/lib/cli.ts";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import type { NextAction } from "../skills/semantic-layer/scripts/lib/next.ts";
import { NO_METRICS_COMMAND } from "../skills/semantic-layer/scripts/lib/no-metrics.ts";
import { openReadbacks } from "../skills/semantic-layer/scripts/lib/readback-open.ts";
import { applyEntryRefusal, ROLES, semlayerRefusal } from "../skills/semantic-layer/scripts/lib/roles.ts";
import { type ProjectStatus, statusDetail } from "../skills/semantic-layer/scripts/lib/status.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { duckdbSource, FIXED_NOW, initProject, semlayer, tempDir } from "./helpers.ts";

// semlayer next's guided flow reaches its end: the owner's answer that they report no metrics, the help
// forms the hook allows, and readback items a newer readback settled. All data is synthetic.

const OWNER = "Dana";
const WORDS = "Revenue and invoice count are all I need.";

async function ok(root: string, args: string[]): Promise<string> {
  const r = await semlayer(root, args);
  if (r.code !== 0) throw new Error(`semlayer ${args.join(" ")}: ${r.err}`);
  return r.out;
}

// The CLI in-process with text on standard input, as semlayer apply --file - and reply --answers - read it.
async function okIn(root: string, args: string[], stdin: string): Promise<string> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args, "--root", root], { cwd: root, env: { SEMLAYER_NOW: FIXED_NOW }, out: (t) => out.push(t), err: (t) => err.push(t), stdin: async () => stdin });
  if (code !== 0) throw new Error(`semlayer ${args.join(" ")}: ${err.join("\n")}`);
  return out.join("\n");
}

const next = async (root: string) => (await semlayer(root, ["next", "--json"])).json<NextAction>();
const status = async (root: string) => (await semlayer(root, ["status", "--json"])).json<ProjectStatus>();

// A one-table invoice layer on DuckDB, introspected, profiled and drafted.
async function drafted(): Promise<string> {
  const dir = tempDir();
  const root = join(dir, "semantic");
  await initProject(root, "invoices");
  await duckdbSource(root, dir, "inv", [
    "create table invoices (invoice_id integer primary key, customer text, total decimal(10,2), invoice_date date)",
    "insert into invoices values (1, 'a', 10.50, '2025-01-03'), (2, 'b', 20.00, '2025-02-04'), (3, 'a', 5.25, '2025-02-10'), (4, 'c', 7.00, '2025-03-01')",
  ]);
  for (const args of [["introspect", "--source", "inv"], ["profile", "--source", "inv"], ["draft", "--source", "inv"]]) await ok(root, args);
  return root;
}

// One step of semlayer next, taken as the skill takes it: a run step runs; an ask_owner step runs with the
// owner's answer (yes to every readback item, no metrics, open access, a golden per month).
async function take(root: string, a: NextAction, goldens: { n: number }): Promise<void> {
  const act = a.action as { command: string; args: string[]; stdin?: string };
  let args = [act.command, ...act.args];
  let stdin = act.stdin;
  if (a.kind === "ask_owner") {
    if (a.ask_owner?.readback_id) {
      args = ["reply", "--readback", a.ask_owner.readback_id, "--answers", "-", "--approve"];
      stdin = JSON.stringify({ by: OWNER, answers: a.ask_owner.items.map((i) => ({ item: i.n, verdict: "yes", text: "Yes, that is right." })) });
    } else if (act.command === "add-metric") args = ["add-metric", "--none", "--by", OWNER, "--text", WORDS];
    else if (act.command === "set" && act.args[0] === "access") args = ["set", "access", "mode", "open"];
    else if (act.command === "goldens" && act.args[0] === "new") {
      const n = ++goldens.n;
      const request = { source: "inv", measures: ["invoices.total", "invoices.invoice_count"], filters: [{ field: "invoices.invoice_date", op: "lt", value: `2025-0${n + 1}-15` }] };
      args = ["goldens", "new", "--name", `total_${n}`, "--question", `Invoices before 2025-0${n + 1}-15?`, "--request", JSON.stringify(request)];
    } else if (stdin) stdin = stdin.replace(/<ISO[^>]*>/g, "USD").replace(/<[^>]+>/g, "One invoice as the shop records it.");
    else throw new Error(`no owner answer for ${JSON.stringify(a)}`);
  }
  if (stdin !== undefined) await okIn(root, args, stdin);
  else await ok(root, args);
}

// Follows semlayer next until `stop` holds of its action (or it is done), returning the steps taken.
async function drive(root: string, stop: (a: NextAction) => boolean, goldens = { n: 0 }): Promise<{ last: NextAction; seen: string[] }> {
  const seen: string[] = [];
  for (let i = 0; i < 60; i++) {
    const a = await next(root);
    seen.push(`${a.kind}:${a.phase}:${a.action.command}`);
    if (a.kind === "done" || stop(a)) return { last: a, seen };
    await take(root, a, goldens);
  }
  throw new Error(`semlayer next did not stop: ${seen.join(", ")}`);
}

// The invoice layer at the end of its interview: the model and its fields approved, no metrics yet.
async function interviewed(): Promise<string> {
  const root = await drafted();
  const { last } = await drive(root, (a) => a.phase === "metrics");
  expect(last.phase).toBe("metrics");
  return root;
}

describe("the owner reports no metrics", () => {
  test("the metrics step names add-metric and the way out; the recorded none moves next on to access and status shows it", async () => {
    const root = await interviewed();
    const a = await next(root);
    expect(a).toMatchObject({ kind: "ask_owner", phase: "metrics", action: { command: "add-metric" } });
    expect(a.why).toContain("add each as a draft with semlayer add-metric");
    expect(a.why).toContain(`or, if the owner reports none, record that in their words with ${NO_METRICS_COMMAND}`);
    expect((await status(root)).no_metrics).toBeNull();

    const r = await semlayer(root, ["add-metric", "--none", "--by", OWNER, "--text", WORDS, "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ changed: true, file: "metrics.yaml", no_metrics: { by: OWNER, text: WORDS, at: "2026-01-15" }, created: true, next: "semlayer next" });
    expect(readYaml(join(root, "metrics.yaml"))).toEqual({ metrics: [], no_metrics: { by: OWNER, text: WORDS, at: "2026-01-15" } });
    expect((await semlayer(root, ["validate"])).code).toBe(0);

    const st = await status(root);
    expect(st.no_metrics).toEqual({ by: OWNER, text: WORDS, at: "2026-01-15", applies: true });
    expect(st.next_step.phase).toBe("access");
    expect((await semlayer(root, ["status"])).out).toContain(`metrics: none for now, said by ${OWNER} on 2026-01-15`);
    expect((await next(root)).phase).toBe("access");
  });

  test("without --by or --text it is refused with the next step and a code; other flags, apply and a listed metric are refused too", async () => {
    const root = await interviewed();
    for (const args of [["--text", WORDS], ["--by", OWNER], ["--by", " ", "--text", WORDS]]) {
      const r = await semlayer(root, ["add-metric", "--none", ...args, "--json"]);
      expect(r.code).toBe(1);
      expect(r.json()).toMatchObject({ code: "owner_words_missing", next: NO_METRICS_COMMAND });
      expect(r.err).toContain("Nothing was written");
      expect(r.err).toContain(NO_METRICS_COMMAND);
    }
    expect((await semlayer(root, ["add-metric", "--none", "--by", OWNER, "--text", WORDS, "--name", "aov"])).err).toContain("takes no --name");
    expect((await semlayer(root, ["add-metric", "--name", "aov", "--type", "ratio", "--by", OWNER])).err).toContain("--by and --text go with --none only");
    expect(applyEntryRefusal(["add-metric", "--none", "--by", OWNER, "--text", WORDS])).toContain("records the owner's answer that they report no metrics");
    expect(applyEntryRefusal(["add-metric", "--name", "aov", "--type", "ratio"])).toBeUndefined();
    expect((await next(root)).phase).toBe("metrics");

    await ok(root, ["add-metric", "--name", "average_invoice", "--type", "ratio", "--numerator", "invoices.total", "--denominator", "invoices.invoice_count"]);
    const listed = await semlayer(root, ["add-metric", "--none", "--by", OWNER, "--text", WORDS]);
    expect(listed.code).toBe(1);
    expect(listed.err).toContain("already lists the metric average_invoice");
  });

  test("a metric added after the none is read back as today, and status says the none no longer applies", async () => {
    const root = await interviewed();
    await ok(root, ["add-metric", "--none", "--by", OWNER, "--text", WORDS]);
    expect((await next(root)).phase).toBe("access");
    await ok(root, ["add-metric", "--name", "average_invoice", "--type", "ratio", "--numerator", "invoices.total", "--denominator", "invoices.invoice_count", "--format", "currency", "--currency", "USD", "--description", "Total divided by the number of invoices."]);
    const a = await next(root);
    expect(a).toMatchObject({ kind: "run", phase: "metrics", action: { command: "readback", args: ["--targets", "metric:average_invoice"] } });
    const st = await status(root);
    expect(st.no_metrics).toMatchObject({ by: OWNER, applies: false });
    expect((await semlayer(root, ["status"])).out).toContain("no longer applies, since metrics.yaml lists metrics");
  });

  test("end to end: semlayer next from the end of the interview to done, for a layer with no metrics", async () => {
    const root = await interviewed();
    const { last, seen } = await drive(root, () => false);
    expect(last.kind).toBe("done");
    expect(last.phase).toBe("done");
    // Metrics is asked once, answered with the owner's none, and never asked again.
    expect(seen.filter((s) => s.includes(":metrics:"))).toEqual(["ask_owner:metrics:add-metric"]);
    expect(seen.some((s) => s.includes(":access:"))).toBe(true);
    expect(seen.some((s) => s.includes(":verify:"))).toBe(true);
    expect(last.why).toContain(`owner's answer of no metrics for now (said by ${OWNER} on 2026-01-15)`);
    expect((await status(root)).goldens.approved).toBeGreaterThanOrEqual(5);
  }, 60_000);
});

describe("the hook allows the help forms", () => {
  const SEMLAYER = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts", "semlayer.ts");
  const bash = (agent: string, command: string) =>
    checkToolUse(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: tempDir(), hook_event_name: "PreToolUse", agent_type: agent, agent_id: "a1" }));

  test("semlayer, semlayer --help and semlayer -h for every role that may run semlayer help, and nothing else new", () => {
    for (const role of Object.values(ROLES)) {
      const help = semlayerRefusal(role, ["help"]) === undefined;
      for (const args of [[], ["--help"], ["-h"]]) expect(semlayerRefusal(role, args) === undefined).toBe(help);
      for (const args of [["--json"], ["--root", "semantic"], ["--help", "--json"], ["-h", "status"], ["--show-protected"]]) expect(semlayerRefusal(role, args)).toContain("without a command first");
    }
    expect(semlayerRefusal(ROLES.interviewer, [])).toBeUndefined();
    expect(semlayerRefusal(ROLES.connector_runner, ["--help"])).toContain("without a command first");
    // Through the hook, as the interviewer runs them.
    for (const args of ["", " --help", " -h", " help"]) expect(bash("semlayer-interviewer", `bun ${SEMLAYER}${args}`)).toEqual({ allow: true });
    expect(bash("semlayer-interviewer", `bun ${SEMLAYER} --json`).allow).toBe(false);
    expect(bash("semlayer-connector-runner", `bun ${SEMLAYER} --help`).allow).toBe(false);
  });
});

describe("a readback item a newer readback settled is not asked again", () => {
  // The invoice layer with every phase done, then two draft goldens read back together.
  async function twoGoldens(): Promise<{ root: string; rb: string }> {
    const root = await interviewed();
    await drive(root, () => false);
    await ok(root, ["goldens", "new", "--name", "january", "--question", "Total in January 2025?", "--request", JSON.stringify({ source: "inv", measures: ["invoices.total"], filters: [{ field: "invoices.invoice_date", op: "lt", value: "2025-02-01" }] })]);
    await ok(root, ["goldens", "new", "--name", "all_count", "--question", "How many invoices?", "--request", JSON.stringify({ source: "inv", measures: ["invoices.invoice_count"] })]);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", "golden:january,golden:all_count", "--json"])) as { readback_id: string };
    return { root, rb: rb.readback_id };
  }

  test("after the newer readback's yes, next asks only the older readback's item for the other target", async () => {
    const { root, rb } = await twoGoldens();
    await ok(root, ["reply", "--readback", rb, "--item", "1", "--text", "Yes.", "--verdict", "yes", "--by", OWNER]);
    await ok(root, ["goldens", "confirm", "--name", "january"]);
    expect((await status(root)).pending_readback_items).toBe(1);

    // The confirmed golden changes (a new tolerance) and is read back again on its own.
    const newer = JSON.parse(await ok(root, ["readback", "--targets", "golden:january", "--tolerance", "0.5", "--json"])) as { readback_id: string };
    expect((await status(root)).pending_readback_items).toBe(2);
    await ok(root, ["reply", "--readback", newer.readback_id, "--item", "1", "--text", "Yes, half a dollar is fine.", "--verdict", "yes", "--by", OWNER]);
    await ok(root, ["goldens", "confirm", "--name", "january", "--tolerance", "0.5"]);

    const a = await next(root);
    expect(a.kind).toBe("ask_owner");
    expect(a.ask_owner).toMatchObject({ readback_id: rb, items: [{ n: 2, target: "golden:all_count" }] });
    expect(a.why).not.toContain("golden:january");
    expect((await status(root)).pending_readback_items).toBe(1);

    // Once the other item is answered, the older readback has nothing left to ask.
    await ok(root, ["reply", "--readback", rb, "--item", "2", "--text", "Yes.", "--verdict", "yes", "--by", OWNER]);
    await ok(root, ["goldens", "confirm", "--name", "all_count"]);
    expect((await status(root)).pending_readback_items).toBe(0);
    expect((await next(root)).ask_owner?.readback_id).toBeUndefined();
  }, 60_000);

  test("only a recorded reply to a newer readback of the target settles an item, and not once the target changed after it", async () => {
    const { root, rb } = await twoGoldens();
    await ok(root, ["reply", "--readback", rb, "--item", "1", "--text", "Yes.", "--verdict", "yes", "--by", OWNER]);
    await ok(root, ["goldens", "confirm", "--name", "january"]);
    const newer = JSON.parse(await ok(root, ["readback", "--targets", "golden:january", "--tolerance", "0.5", "--json"])) as { readback_id: string };
    // No reply to the newer readback yet: nothing is settled by its file alone.
    const d = statusDetail(root);
    const older = openReadbacks(root, d.targets, d.replies).find((r) => r.readback.readback_id === rb)!;
    expect(older.open.map((i) => i.target)).toEqual(["golden:all_count"]);
    await ok(root, ["reply", "--readback", newer.readback_id, "--item", "1", "--text", "Yes.", "--verdict", "yes", "--by", OWNER]);
    await ok(root, ["goldens", "confirm", "--name", "january", "--tolerance", "0.5"]);
    const after = statusDetail(root);
    expect(openReadbacks(root, after.targets, after.replies).find((r) => r.readback.readback_id === rb)!.open.map((i) => i.target)).toEqual(["golden:all_count"]);
    // The golden as it stands no longer has the hash the newer yes was to: the older item is asked again.
    const changed = new Map(after.targets);
    changed.set("golden:january", { ...changed.get("golden:january")!, hash: "sha256:0000" });
    expect(openReadbacks(root, changed, after.replies).find((r) => r.readback.readback_id === rb)!.open.map((i) => i.target)).toEqual(["golden:january", "golden:all_count"]);
  }, 60_000);
});

async function edgeProject(): Promise<string> {
  const root = join(tempDir(), "semantic");
  await initProject(root, "edges");
  return root;
}

describe("add-metric --none edges", () => {
  test("keeps comments of an existing metrics.yaml, replaces on a second record, and uses the injected clock", async () => {
    const root = await edgeProject();
    writeFileSync(join(root, "metrics.yaml"), "# the owner's metrics\nmetrics: [] # none yet\n");
    const a = await semlayer(root, ["add-metric", "--none", "--by", "Dana", "--text", "None for now."]);
    expect(a.code).toBe(0);
    const t1 = readFileSync(join(root, "metrics.yaml"), "utf8");
    expect(t1).toContain("# the owner's metrics");
    expect(t1).toContain("# none yet");
    expect(t1).toContain("at: 2026-01-15");
    const b = await semlayer(root, ["add-metric", "--none", "--by", "Lee", "--text", "Still none."], { SEMLAYER_NOW: "2026-03-02T09:00:00.000Z" });
    expect(b.code).toBe(0);
    const t2 = readFileSync(join(root, "metrics.yaml"), "utf8");
    expect(t2).toContain("by: Lee");
    expect(t2).toContain("at: 2026-03-02");
    expect(t2).not.toContain("Dana");
    expect((await semlayer(root, ["validate"])).code).toBe(0);
  });

  test("folds the owner's words to one line and redacts a credential", async () => {
    const root = await edgeProject();
    const r = await semlayer(root, ["add-metric", "--none", "--by", "Dana", "--text", "none\nuse postgres://u:hunter2secret@db.example/x", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ no_metrics: { text: string } }>();
    expect(out.no_metrics.text).not.toContain("\n");
    expect(out.no_metrics.text).not.toContain("hunter2secret");
    expect(readFileSync(join(root, "metrics.yaml"), "utf8")).not.toContain("hunter2secret");
  });

  test("other flags with --none are refused, --set included, and nothing is written", async () => {
    const root = await edgeProject();
    for (const extra of [["--set", "tags=[a]"], ["--source", "x"], ["--description", "d"]]) {
      const r = await semlayer(root, ["add-metric", "--none", "--by", "Dana", "--text", "None.", ...extra]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("Nothing was written");
    }
  });

  test("semlayer apply refuses an add-metric --none entry through the CLI and writes nothing", async () => {
    const root = await edgeProject();
    const file = join(tempDir(), "edits.json");
    writeFileSync(file, JSON.stringify({ edits: [["add-metric", "--none", "--by", "Dana", "--text", "None."]] }));
    const r = await semlayer(root, ["apply", "--file", file]);
    expect(r.code).toBe(1);
    expect(r.err + r.out).toContain("add-metric --none");
    const st = (await semlayer(root, ["status", "--json"])).json<{ no_metrics: unknown }>();
    expect(st.no_metrics).toBeNull();
  });

  test("an unreadable or partial no_metrics in the file does not crash status, and validate reports it", async () => {
    const root = await edgeProject();
    writeFileSync(join(root, "metrics.yaml"), "metrics: []\nno_metrics:\n  by: Dana\n");
    const st = await semlayer(root, ["status", "--json"]);
    expect(st.code).toBe(0);
    expect(st.json<{ no_metrics: unknown }>().no_metrics).toBeNull();
    expect((await semlayer(root, ["validate"])).code).not.toBe(0);
  });
});

describe("help forms stay bare", () => {
  test("only the bare forms are allowed; help with extra words is still refused for every role", () => {
    for (const role of Object.values(ROLES)) {
      for (const args of [["-h", "-h"], ["--help", "--help"], ["--help", "--root", "x"], ["-help"], ["--h"]]) expect(semlayerRefusal(role, args)).toContain("without a command first");
    }
  });

  test("bare semlayer forms print the command list", async () => {
    const root = await edgeProject();
    for (const args of [["--help"], ["-h"]]) {
      const r = await semlayer(root, args);
      expect(r.code).toBe(0);
      expect(r.out).toContain("add-metric");
    }
  });

  test("the hook refuses --help to a subagent role that may not run help", () => {
    const SEMLAYER = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts", "semlayer.ts");
    for (const agent of ["semlayer-golden-builder", "semlayer-readback-verifier", "semlayer-batch-analyst"]) {
      const r = checkToolUse(JSON.stringify({ tool_name: "Bash", tool_input: { command: `bun ${SEMLAYER} --help` }, cwd: tempDir(), hook_event_name: "PreToolUse", agent_type: agent, agent_id: "a1" }));
      expect(r.allow).toBe(false);
    }
  });
});

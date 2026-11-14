import { describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { envFileRefusal, runAfter, runBefore, type Outcome } from "../skills/semantic-layer/scripts/hooks/integrity.ts";
import { initProject, sl, tempDir } from "./helpers.ts";

// The answer ledger's before-and-after comparison and the env file refusals (docs/PRD-hardening.md
// HR-6; spec: Hand edits). A project is a temp directory holding semantic/, and each test gives the
// hook a state directory of its own.

const REPO = join(import.meta.dir, "..");
const SL = join(REPO, "skills", "semantic-layer", "scripts", "sl.ts");
const UNDONE = "A command changed the answer ledger outside sl, and the change was undone. An owner's answer is recorded only with sl reply, after the owner answers.";
const LEFT = "could not be attributed and was left as it is. Run sl validate";
const SECRET = "This file holds the connection secret. sl reads it itself, and you never need its contents. To check the connection, run sl setup --source <s>.";

const ORDERS = `model: orders
source: wh
table: main.fct_orders
status: draft
grain: One row per order.
primary_key: [order_id]
measures:
  - name: revenue
    expr: amount
    agg: sum
    description: Order value.
    status: draft
`;

interface Project {
  dir: string;
  root: string;
  state: string;
  ledger: string;
  pending: string;
}

async function project(): Promise<Project> {
  const dir = tempDir("integrity");
  const root = join(dir, "semantic");
  await initProject(root);
  mkdirSync(join(root, "models", "wh"), { recursive: true });
  writeFileSync(join(root, "models", "wh", "orders.yaml"), ORDERS);
  return { dir, root, state: join(tempDir("integrity-state"), "ledger-guard"), ledger: join(root, ".sl", "ledger.jsonl"), pending: join(root, ".sl", "pending") };
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const stateEntries = (p: Project) => (existsSync(p.state) ? readdirSync(p.state).map((n) => n.replace(/^.*\./, "")) : []);

// Reads revenue back and returns the readback id; with `reply`, records the owner's yes.
async function readback(p: Project, reply = false): Promise<string> {
  const rb = await sl(p.root, ["readback", "--targets", "wh.orders.revenue", "--json"]);
  expect(rb.code).toBe(0);
  const id = rb.json<{ readback_id: string }>().readback_id;
  if (reply) expect((await sl(p.root, replyArgs(id))).code).toBe(0);
  return id;
}
const replyArgs = (id: string) => ["reply", "--readback", id, "--item", "1", "--text", "Yes, that is revenue.", "--verdict", "yes", "--by", "Dana"];
const replyCommand = (p: Project, id: string) => `bun ${SL} ${replyArgs(id).map((a) => JSON.stringify(a)).join(" ")} --root ${p.root}`;

// The ledger line sl reply writes for the owner's yes to a readback, made in a copy of the project.
async function yesLine(p: Project, id: string): Promise<string> {
  const twin = tempDir("integrity-twin");
  cpSync(p.dir, twin, { recursive: true });
  expect((await sl(join(twin, "semantic"), replyArgs(id))).code).toBe(0);
  return readFileSync(join(twin, "semantic", ".sl", "ledger.jsonl"), "utf8");
}

let calls = 0;
interface CallOptions {
  tool?: string;
  session?: string;
  agent?: string;
  id?: string | null;
  now?: number;
  background?: boolean;
  input?: Record<string, unknown>;
}
// One tool call as Claude Code hands it to a hook. `id: null` leaves tool_use_id out.
function payload(p: Project, command: string, o: CallOptions = {}): Record<string, unknown> {
  const tool = o.tool ?? "Bash";
  return {
    session_id: o.session ?? "session-1",
    cwd: p.dir,
    tool_name: tool,
    tool_input: o.input ?? { command, ...(o.background ? { run_in_background: true } : {}) },
    ...(o.agent ? { agent_id: o.agent } : {}),
    ...(o.id === null ? {} : { tool_use_id: o.id ?? `toolu_${++calls}` }),
  };
}
const before = (p: Project, call: Record<string, unknown>, now?: number): Outcome => runBefore(JSON.stringify({ hook_event_name: "PreToolUse", ...call }), true, { stateDir: p.state, env: {}, now });
const after = (p: Project, call: Record<string, unknown>, now?: number): Outcome => runAfter(JSON.stringify({ hook_event_name: "PostToolUse", ...call }), { stateDir: p.state, env: {}, now });

// Runs `write` as the Bash call `command`, with the hook before and after it.
function around(p: Project, command: string, write: () => void, o: CallOptions = {}): Outcome {
  const call = payload(p, command, o);
  expect(before(p, call, o.now)).toEqual({ block: false });
  write();
  return after(p, call, o.now === undefined ? undefined : o.now + 1);
}

const PYTHON = "python3 -c \"open('semantic/.sl/ledger.jsonl','a').write(open('forged.jsonl').read())\"";
// The write the command above makes, by python3 when the machine has one.
function forge(p: Project, line: string): void {
  writeFileSync(join(p.dir, "forged.jsonl"), line);
  mkdirSync(join(p.root, ".sl"), { recursive: true });
  if (Bun.which("python3")) expect(Bun.spawnSync(["sh", "-c", PYTHON], { cwd: p.dir }).exitCode).toBe(0);
  else appendFileSync(p.ledger, line);
}

describe("a change to the ledger that sl did not make", () => {
  test("a yes forged with python3 -c passes the checks before the call, is undone after it, and sl approve then refuses", async () => {
    const p = await project();
    const id = await readback(p);
    const line = await yesLine(p, id);
    // The gap: the hook's checks on the command let it through, and sl approve accepts the line.
    expect(checkToolUse(JSON.stringify({ tool_name: "Bash", cwd: p.dir, tool_input: { command: PYTHON } }))).toEqual({ allow: true });
    const twin = tempDir("integrity-gap");
    cpSync(p.dir, twin, { recursive: true });
    forge({ ...p, dir: twin, root: join(twin, "semantic"), ledger: join(twin, "semantic", ".sl", "ledger.jsonl") }, line);
    expect((await sl(join(twin, "semantic"), ["approve", "--target", "wh.orders.revenue", "--by", "Dana"])).code).toBe(0);

    const out = around(p, PYTHON, () => {
      forge(p, line);
      expect(read(p.ledger)).toBe(line);
    });
    expect(out.block).toBe(true);
    expect(out.message).toContain(UNDONE);
    expect(out.message).toContain(`- in ${p.root}: .sl/ledger.jsonl (added, now removed)`);
    expect(existsSync(p.ledger)).toBe(false);
    const approve = await sl(p.root, ["approve", "--target", "wh.orders.revenue", "--by", "Dana"]);
    expect(approve.code).toBe(1);
    expect(approve.err).toContain("no owner reply to its readback is recorded; nothing was approved");
    expect(readFileSync(join(p.root, "models", "wh", "orders.yaml"), "utf8")).toBe(ORDERS);
    expect(stateEntries(p)).toEqual([]);
  });

  test("a forged pending file, a changed one and a deleted ledger line are undone", async () => {
    const p = await project();
    const id = await readback(p, true);
    const ledger = read(p.ledger)!;
    const rb = read(join(p.pending, `${id}.json`))!;
    const out = around(p, "node rewrite.js", () => {
      writeFileSync(p.ledger, "");
      writeFileSync(join(p.pending, `${id}.json`), rb.replace("revenue", "profit"));
      writeFileSync(join(p.pending, "rb_9999.json"), "{}\n");
    });
    expect(out.block).toBe(true);
    expect(out.message).toContain(UNDONE);
    expect(out.message).toContain(`.sl/ledger.jsonl (changed, now restored), .sl/pending/${id}.json (changed, now restored), .sl/pending/rb_9999.json (added, now removed)`);
    expect(read(p.ledger)).toBe(ledger);
    expect(read(join(p.pending, `${id}.json`))).toBe(rb);
    expect(readdirSync(p.pending)).toEqual([`${id}.json`]);

    // A deleted ledger, a deleted pending directory and a deleted .sl come back too.
    for (const gone of [p.ledger, p.pending, join(p.root, ".sl")]) {
      expect(around(p, "node rewrite.js", () => rmSync(gone, { recursive: true })).message).toContain("now restored");
      expect(read(p.ledger)).toBe(ledger);
      expect(read(join(p.pending, `${id}.json`))).toBe(rb);
    }
    expect(stateEntries(p)).toEqual([]);
  });

  test("the root is found from the command's paths, a cd and SEMANTIC_ROOT, not only from the working directory", async () => {
    const p = await project();
    await readback(p, true);
    const ledger = read(p.ledger)!;
    const elsewhere = tempDir("integrity-elsewhere");
    for (const [command, env] of [
      [`python3 -c "open('${p.ledger}','a').write('x')"`, {}],
      [`cd ${p.dir} && node forge.js`, {}],
      ["node forge.js", { SEMANTIC_ROOT: p.root }],
      ["node forge.js", { CLAUDE_PROJECT_DIR: p.dir }],
    ] as const) {
      const call = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_use_id: `e${++calls}`, tool_name: "Bash", cwd: elsewhere, tool_input: { command } });
      expect(runBefore(call, true, { stateDir: p.state, env })).toEqual({ block: false });
      appendFileSync(p.ledger, "forged\n");
      expect(runAfter(call.replace("PreToolUse", "PostToolUse"), { stateDir: p.state, env }).message).toContain(UNDONE);
      expect(read(p.ledger)).toBe(ledger);
    }
  });

  test("a second name for the ledger (a hard link) is cut off after the call that makes it, so a later write through it forges nothing", async () => {
    const p = await project();
    const id = await readback(p, true);
    const ledger = read(p.ledger)!;
    const hard = join(p.dir, "hard");
    // The checks on the command see no write to the ledger in either call.
    for (const command of ["ln semantic/.sl/ledger.jsonl hard", `bun ${SL} status --root ${p.root}; cat forged.jsonl >> hard`])
      expect(checkToolUse(JSON.stringify({ tool_name: "Bash", cwd: p.dir, tool_input: { command } }))).toEqual({ allow: true });
    const out = around(p, "ln semantic/.sl/ledger.jsonl hard", () => {
      linkSync(p.ledger, hard);
      linkSync(join(p.pending, `${id}.json`), join(p.dir, "hard-readback"));
    });
    expect(out.block).toBe(true);
    expect(out.message).toContain(UNDONE);
    expect(out.message).toContain(`.sl/ledger.jsonl (given a second name, now a file of its own again), .sl/pending/${id}.json (given a second name, now a file of its own again)`);
    expect(read(p.ledger)).toBe(ledger);
    expect(statSync(p.ledger).nlink).toBe(1);
    expect(statSync(join(p.pending, `${id}.json`)).nlink).toBe(1);
    // The next call is a plain sl command joined to a redirection, which gets no copy.
    const forged = '{"id":"ans_0009","kind":"reply","verdict":"yes"}\n';
    const call = payload(p, `bun ${SL} status --root ${p.root}; cat forged.jsonl >> hard`);
    expect(before(p, call)).toEqual({ block: false });
    expect(stateEntries(p)).toEqual(["sl"]);
    appendFileSync(hard, forged);
    appendFileSync(join(p.dir, "hard-readback"), "forged");
    expect(after(p, call)).toEqual({ block: false });
    expect(read(hard)).toBe(ledger + forged);
    expect(read(p.ledger)).toBe(ledger);
    expect(read(join(p.pending, `${id}.json`))).not.toContain("forged");
    // While sl runs at the same time the link is left with the rest, and reported.
    expect(before(p, payload(p, `bun ${SL} status`, { agent: "other" }), 1000)).toEqual({ block: false });
    const left = around(p, "ln semantic/.sl/ledger.jsonl again", () => linkSync(p.ledger, join(p.dir, "again")), { now: 1100 });
    expect(left.message).toContain(LEFT);
    expect(left.message).toContain(".sl/ledger.jsonl (linked)");
  });

  test("when the call also ran sl or git, the report says what sl left behind and how to record the answer again", async () => {
    const p = await project();
    const ask = ["question", "add", "wh.orders", "--text", "Is revenue net of refunds?"];
    const resolveArgs = ["question", "resolve", "wh.orders", "--index", "1", "--text", "Net of refunds.", "--by", "Dana"];
    expect((await sl(p.root, ask)).code).toBe(0);
    const asked = read(join(p.root, "models", "wh", "orders.yaml"))!;
    // sl question resolve piped to sed: sed is not on the list of commands that write no file, so the call is compared.
    const call = payload(p, `bun ${SL} ${resolveArgs.map((a) => JSON.stringify(a)).join(" ")} --root ${p.root} | sed -n '1,5p'`);
    expect(before(p, call)).toEqual({ block: false });
    expect(stateEntries(p)).toEqual(["snap"]);
    expect((await sl(p.root, resolveArgs)).code).toBe(0);
    const out = after(p, call);
    expect(out.block).toBe(true);
    expect(out.message).toContain(UNDONE);
    expect(out.message).toContain("- This call also ran sl");
    expect(out.message).toContain("a layer file it edited was not put back");
    expect(out.message).toContain("sl reply, sl question resolve and sl review apply record an owner's answer");
    expect(out.message).toContain("add it again first with sl question add");
    expect(out.message).not.toContain("also ran git");
    // The answer is gone and so is the question; the report's steps record it again.
    expect(existsSync(p.ledger)).toBe(false);
    expect(read(join(p.root, "models", "wh", "orders.yaml"))).toBe(ORDERS);
    expect((await sl(p.root, resolveArgs)).err).toContain("has no open questions; nothing to resolve");
    expect((await sl(p.root, ask)).code).toBe(0);
    expect(read(join(p.root, "models", "wh", "orders.yaml"))).toBe(asked);
    const again = payload(p, `bun ${SL} ${resolveArgs.map((a) => JSON.stringify(a)).join(" ")} --root ${p.root}`);
    expect(before(p, again)).toEqual({ block: false });
    expect(stateEntries(p)).toEqual(["sl"]);
    expect((await sl(p.root, resolveArgs)).code).toBe(0);
    expect(after(p, again)).toEqual({ block: false });
    expect(read(p.ledger)).toContain("Net of refunds.");
    const ledger = read(p.ledger)!;

    // A git pull joined to another program: the report names the way to get the pulled lines back.
    const pulled = around(p, "git pull && make install", () => appendFileSync(p.ledger, "a pulled line\n"));
    expect(pulled.message).toContain(UNDONE);
    expect(pulled.message).toContain("- This call also ran git.");
    expect(pulled.message).toContain("git checkout -- <file> for each file listed above");
    expect(pulled.message).not.toContain("also ran sl");
    // git with no commit-moving command, and a command that names neither: no such advice.
    for (const command of ["git status && python3 forge.py", "node rewrite.js"]) {
      const plain = around(p, command, () => appendFileSync(p.ledger, "forged\n"));
      expect(plain.message).toContain(UNDONE);
      expect(plain.message).not.toContain("This call also ran");
      expect(plain.message).toContain("- sl reply, sl question resolve and sl review apply record an owner's answer. If one of them made that change (run through a script or a variable), run it again on its own");
    }
    expect(read(p.ledger)).toBe(ledger);
    // The call that was never checked carries the same advice to the next before-call.
    expect(before(p, payload(p, `SL="bun ${SL}"; $SL reply --readback rb_0001 --item 1 --verdict yes; exit 1`))).toEqual({ block: false });
    appendFileSync(p.ledger, "forged\n");
    expect(before(p, payload(p, "ls")).message).toContain("- This call also ran sl");
    expect(read(p.ledger)).toBe(ledger);
  });

  test("a command that changes nothing leaves no state, and one that names no semantic root is not recorded", async () => {
    const p = await project();
    await readback(p, true);
    const ledger = read(p.ledger)!;
    expect(around(p, "ls -la semantic && python3 report.py", () => {})).toEqual({ block: false });
    expect(existsSync(p.state)).toBe(false);
    const elsewhere = tempDir("integrity-elsewhere");
    expect(before({ ...p, dir: elsewhere }, { ...payload(p, "python3 report.py"), cwd: elsewhere })).toEqual({ block: false });
    expect(existsSync(p.state)).toBe(false);
    expect(read(p.ledger)).toBe(ledger);
  });
});

describe("what sl and git write is kept", () => {
  test("sl reply followed by a read-only command keeps the reply", async () => {
    const p = await project();
    const id = await readback(p);
    let ran = 0;
    const reply = payload(p, replyCommand(p, id));
    expect(before(p, reply)).toEqual({ block: false });
    expect(stateEntries(p)).toEqual(["sl"]);
    expect((await sl(p.root, replyArgs(id))).code).toBe(0);
    expect(after(p, reply)).toEqual({ block: false });
    const ledger = read(p.ledger)!;
    expect(ledger).toContain('"verdict":"yes"');
    for (const command of ["cat semantic/.sl/ledger.jsonl | head -5", "ls -la semantic && git status", "python3 -c \"print(open('semantic/.sl/ledger.jsonl').read())\""]) {
      expect(around(p, command, () => ran++)).toEqual({ block: false });
    }
    expect(ran).toBe(3);
    expect(read(p.ledger)).toBe(ledger);
    expect(stateEntries(p)).toEqual([]);
    expect((await sl(p.root, ["approve", "--target", "wh.orders.revenue", "--by", "Dana"])).code).toBe(0);
  });

  test("sl with a cd, a pipe to head, tail or tee, an echo, a test and a redirection is still a plain sl command; anything else is copied", async () => {
    const p = await project();
    const kind = (command: string, o: CallOptions = {}) => {
      rmSync(p.state, { recursive: true, force: true });
      expect(before(p, payload(p, command, o))).toEqual({ block: false });
      return stateEntries(p).join();
    };
    for (const plain of [
      `bun ${SL} status --json`,
      `bun run ${SL} next`,
      `cd ${p.dir} && bun ${SL} readback --targets wh.orders.revenue 2>&1 | tail -20; echo "exit $?"`,
      `SL_NOW=2026-01-15T12:00:00.000Z bun ${SL} status --json > /dev/null && bun ${SL} next | grep -c step | wc -l`,
      `bun ${SL} apply --file - <<'EOF'\n[["set","wh.orders.revenue","description","Gross $(revenue)"]]\nEOF`,
      `git pull && bun ${SL} validate`,
      `test -f semantic/semantic.yaml && bun ${SL} status 2>&1 | tee status.txt | cut -c1-200 || exit 1`,
      `ls semantic; bun ${SL} next; sleep 1; printf done`,
    ])
      expect(`${plain}: ${kind(plain)}`).toBe(`${plain}: sl`);
    for (const other of [
      `bun ${SL} reply --readback rb_0001 --item 1 --text "$(cat answer.txt)" --verdict yes`,
      `SL="bun ${SL}"; $SL reply --readback rb_0001 --item 1 --verdict yes`,
      `bun ${SL} status && python3 forge.py`,
      `bun ${SL} status | tee "$OUT"`,
      `bun ${SL} status | sort -o out.txt`,
      `if bun ${SL} validate; then echo ok; fi`,
      `bun ${SL} status > "$OUT"`,
      "bun sl.ts reply --readback rb_0001 --item 1 --verdict yes",
      `cd semantic && bun ../skills/semantic-layer/scripts/sl.ts status`,
      `NODE_OPTIONS=--require=./x.js bun ${SL} status`,
      `env X=1 bun ${SL} status`,
      "git status",
      "git -c core.hooksPath=evil pull",
      "git apply forged.patch",
      "git pull && python3 forge.py",
      // git writes what it prints to the file --output names.
      `git log -1 --format='format:{"verdict":"yes"}%n' --output=semantic/.sl/ledger.jsonl; git stash list`,
      `bun ${SL} status; git show --output=semantic/.sl/ledger.jsonl HEAD`,
      "git log $SL_OPTS -1 && git pull",
    ])
      expect(`${other}: ${kind(other)}`).toBe(`${other}: snap`);
    // Other tools are never copied, and an MCP sl tool counts as sl.
    expect(kind("", { tool: "Read", input: { file_path: join(p.root, "semantic.yaml") } })).toBe("");
    expect(kind("", { tool: "mcp__plugin_semantic-layer-builder_semantic-layer__sl_reply", input: { readback: "rb_0001" } })).toBe("sl");
  });

  test("sl reply running at the same time as another agent's command is left and reported, in either order", async () => {
    for (const slFirst of [true, false]) {
      const p = await project();
      const id = await readback(p);
      const reply = payload(p, replyCommand(p, id), { agent: "interviewer" });
      const other = payload(p, "python3 long_report.py", { agent: "analyst" });
      expect(before(p, slFirst ? reply : other, 1000)).toEqual({ block: false });
      expect(before(p, slFirst ? other : reply, 1100)).toEqual({ block: false });
      expect(stateEntries(p).sort()).toEqual(["sl", "snap"]);
      expect((await sl(p.root, replyArgs(id))).code).toBe(0);
      const ledger = read(p.ledger)!;
      // In one order sl's own after-check has run by the time the other command ends; in the other it has not.
      if (!slFirst) expect(after(p, reply, 1200)).toEqual({ block: false });
      const out = after(p, other, 1300);
      expect(out.block).toBe(true);
      expect(out.message).toContain(LEFT);
      expect(out.message).toContain(".sl/ledger.jsonl (added)");
      expect(out.message).not.toContain("undone");
      expect(read(p.ledger)).toBe(ledger);
      if (slFirst) expect(after(p, reply, 1400)).toEqual({ block: false });
      expect(stateEntries(p)).toEqual([]);
    }
  });

  test("an sl command that ended without its after-check does not excuse the same agent's next command", async () => {
    const p = await project();
    const id = await readback(p);
    const line = await yesLine(p, id);
    // sl approve refuses and exits 1; no after-call follows it. The forged yes comes next.
    expect(before(p, payload(p, `bun ${SL} approve --target wh.orders.revenue --by Dana --root ${p.root}`), 1000)).toEqual({ block: false });
    expect((await sl(p.root, ["approve", "--target", "wh.orders.revenue", "--by", "Dana"])).code).toBe(1);
    const out = around(p, PYTHON, () => forge(p, line), { now: 2000 });
    expect(out.message).toContain(UNDONE);
    expect(existsSync(p.ledger)).toBe(false);
    expect(stateEntries(p)).toEqual([]);
  });

  test("a git pull that brings ledger lines keeps them", async () => {
    const p = await project();
    const id = await readback(p, true);
    const git = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], { cwd });
      expect(`git ${args.join(" ")}: ${r.exitCode} ${r.stderr.toString()}`).toStartWith(`git ${args.join(" ")}: 0`);
    };
    const origin = join(tempDir("integrity-origin"), "origin.git");
    git(p.dir, "init", "--bare", origin);
    git(p.dir, "init");
    git(p.dir, "add", "-A");
    git(p.dir, "commit", "-m", "layer");
    git(p.dir, "remote", "add", "origin", origin);
    git(p.dir, "push", "-u", "origin", "main");
    // A teammate records another answer and pushes it.
    const mate = tempDir("integrity-mate");
    git(mate, "clone", origin, "work");
    const theirs = `${read(p.ledger)!}${read(p.ledger)!.replace("ans_0001", "ans_0002")}`;
    writeFileSync(join(mate, "work", "semantic", ".sl", "ledger.jsonl"), theirs);
    writeFileSync(join(mate, "work", "semantic", ".sl", "pending", "rb_0002.json"), read(join(p.pending, `${id}.json`))!);
    git(join(mate, "work"), "add", "-A");
    git(join(mate, "work"), "commit", "-m", "another answer and its readback");
    git(join(mate, "work"), "push");

    const pull = payload(p, "git pull --ff-only 2>&1 | tail -5");
    expect(before(p, pull)).toEqual({ block: false });
    expect(stateEntries(p)).toEqual(["sl"]);
    git(p.dir, "pull", "--ff-only");
    expect(after(p, pull)).toEqual({ block: false });
    expect(read(p.ledger)).toBe(theirs);
    expect(readdirSync(p.pending).sort()).toEqual([`${id}.json`, "rb_0002.json"]);
    expect(stateEntries(p)).toEqual([]);
  });
});

describe("a call whose after-check never ran", () => {
  test("is compared at the next before-call, which is stopped with the report and passes when run again", async () => {
    const p = await project();
    const id = await readback(p);
    const line = await yesLine(p, id);
    for (const next of [
      payload(p, `bun ${SL} approve --target wh.orders.revenue --by Dana --root ${p.root}`),
      payload(p, "", { tool: "Read", input: { file_path: join(p.root, "semantic.yaml") } }),
      payload(p, "", { tool: "mcp__plugin_semantic-layer-builder_semantic-layer__sl_approve", input: { target: "wh.orders.revenue" } }),
    ]) {
      expect(before(p, payload(p, `${PYTHON}; exit 1`))).toEqual({ block: false });
      forge(p, line);
      const out = before(p, next);
      expect(out.block).toBe(true);
      expect(out.message).toContain(UNDONE);
      expect(out.message).toContain("This was found before the current call, which was not run. Run it again.");
      expect(existsSync(p.ledger)).toBe(false);
      expect(before(p, next)).toEqual({ block: false });
      expect(after(p, next)).toEqual({ block: false });
      expect(stateEntries(p)).toEqual([]);
    }
    // Before a call the other checks refuse, the report does not say to run that call again.
    expect(before(p, payload(p, `${PYTHON}; exit 1`))).toEqual({ block: false });
    forge(p, line);
    const refused = runBefore(JSON.stringify({ hook_event_name: "PreToolUse", ...payload(p, "rm -rf semantic") }), false, { stateDir: p.state, env: {} });
    expect(refused.block).toBe(true);
    expect(refused.message).toEndWith("This was found before the current call.");
    expect(existsSync(p.ledger)).toBe(false);
    expect(stateEntries(p)).toEqual([]);
    expect((await sl(p.root, ["approve", "--target", "wh.orders.revenue", "--by", "Dana"])).code).toBe(1);
  });

  test("without a tool_use_id the call is keyed by its session and command", async () => {
    const p = await project();
    await readback(p, true);
    const ledger = read(p.ledger)!;
    const out = around(p, "node rewrite.js", () => appendFileSync(p.ledger, "forged\n"), { id: null });
    expect(out.message).toContain(UNDONE);
    expect(read(p.ledger)).toBe(ledger);
    // The same command again, after a run of it that was never checked.
    expect(before(p, payload(p, "node rewrite.js", { id: null }))).toEqual({ block: false });
    appendFileSync(p.ledger, "forged\n");
    expect(before(p, payload(p, "node rewrite.js", { id: null })).message).toContain(UNDONE);
    expect(read(p.ledger)).toBe(ledger);
  });

  test("a command left running in the background is compared once more at the next call", async () => {
    const p = await project();
    await readback(p, true);
    const ledger = read(p.ledger)!;
    for (const call of [payload(p, "node slow-forge.js &"), payload(p, "node slow-forge.js", { background: true })]) {
      expect(before(p, call)).toEqual({ block: false });
      expect(after(p, call)).toEqual({ block: false });
      appendFileSync(p.ledger, "forged later\n");
      expect(before(p, payload(p, `bun ${SL} status`)).message).toContain(UNDONE);
      expect(read(p.ledger)).toBe(ledger);
    }
  });

  test("state older than 24 hours is dropped without a comparison", async () => {
    const p = await project();
    await readback(p, true);
    const day = 24 * 60 * 60_000;
    expect(before(p, payload(p, "node rewrite.js"), 1000)).toEqual({ block: false });
    expect(before(p, payload(p, `bun ${SL} status`, { agent: "other" }), 2000)).toEqual({ block: false });
    appendFileSync(p.ledger, "a later line\n");
    expect(before(p, payload(p, "ls", { tool: "Read", input: { file_path: join(p.dir, "notes.txt") } }), 1000 + day + 1)).toEqual({ block: false });
    expect(read(p.ledger)).toEndWith("a later line\n");
    expect(stateEntries(p)).toEqual([]);
  });
});

describe("the hook's own files and failures", () => {
  test("it writes only the ledger and pending readbacks it puts back, and its state directory; the command text is not stored", async () => {
    const p = await project();
    await readback(p, true);
    const tree = () => {
      const out: Record<string, string> = {};
      for (const f of readdirSync(p.dir, { recursive: true }) as string[]) if (statSync(join(p.dir, f)).isFile()) out[f] = readFileSync(join(p.dir, f), "utf8");
      return out;
    };
    const was = tree();
    const call = payload(p, "curl -H 'Authorization: Bearer synthetic-token-123' https://example.com | python3 forge.py");
    expect(before(p, call)).toEqual({ block: false });
    expect(tree()).toEqual(was);
    expect(statSync(p.state).mode & 0o077).toBe(0);
    const stored = (readdirSync(p.state, { recursive: true }) as string[]).filter((f) => statSync(join(p.state, f)).isFile());
    expect(stored.map((f) => f.replace(/^[^/]+\//, "")).sort()).toEqual(["0/ledger.jsonl", "0/pending/rb_0001.json", "meta.json"]);
    for (const f of stored) expect(readFileSync(join(p.state, f), "utf8")).not.toContain("synthetic-token-123");
    appendFileSync(p.ledger, "forged\n");
    writeFileSync(join(p.root, "models", "wh", "orders.yaml"), ORDERS.replace("amount", "amount * 2"));
    expect(after(p, call).message).toContain(UNDONE);
    // The ledger is put back; the model file, which the comparison does not cover, is left to the other checks.
    expect(tree()).toEqual({ ...was, "semantic/models/wh/orders.yaml": ORDERS.replace("amount", "amount * 2") });
    expect(existsSync(p.state)).toBe(false);
  });

  test("it does not write through a link that leads out of the semantic root", async () => {
    const p = await project();
    await readback(p, true);
    const outside = tempDir("integrity-outside");
    writeFileSync(join(outside, "theirs.json"), "kept\n");
    const out = around(p, "node rewrite.js", () => {
      rmSync(p.pending, { recursive: true });
      symlinkSync(outside, p.pending);
      writeFileSync(join(outside, "rb_9999.json"), "{}\n");
    });
    expect(out.block).toBe(true);
    expect(out.message).toContain("could not put back .sl/pending/rb_0001.json");
    expect(out.message).toContain(".sl/pending leads outside the semantic root");
    expect(out.message).toContain("git checkout -- .sl/pending/rb_0001.json");
    expect(readdirSync(outside).sort()).toEqual(["rb_9999.json", "theirs.json"]);
    expect(read(join(outside, "theirs.json"))).toBe("kept\n");
  });

  test("its own error never refuses a call: it warns and lets the call through", async () => {
    const p = await project();
    await readback(p, true);
    const file = join(tempDir("integrity-bad"), "not-a-directory");
    writeFileSync(file, "");
    const stdin = JSON.stringify({ hook_event_name: "PreToolUse", ...payload(p, "node rewrite.js") });
    for (const out of [runBefore(stdin, true, { stateDir: file, env: {} }), runBefore(stdin, true, { stateDir: join(file, "under"), env: {} })]) {
      expect(out.block).toBe(false);
      expect(out.message).toContain("could not compare the answer ledger");
      expect(out.message).toContain("not checked");
    }
    for (const raw of ["not json", "[]", "{}"]) {
      expect(runBefore(raw, true, { stateDir: p.state, env: {} })).toEqual({ block: false });
      expect(runAfter(raw, { stateDir: p.state, env: {} })).toEqual({ block: false });
    }
    // A copy that can no longer be read is dropped, not reported at every later call.
    expect(before(p, payload(p, "node rewrite.js", { agent: "a" }))).toEqual({ block: false });
    writeFileSync(join(p.state, readdirSync(p.state)[0]!, "meta.json"), "{");
    expect(before(p, payload(p, "node other.js", { agent: "b" }))).toEqual({ block: false });
    expect(stateEntries(p)).toEqual(["snap"]);
  });

  test("on the Acme example the comparison adds little time to a Bash call", () => {
    const dir = tempDir("integrity-acme");
    const root = join(dir, "semantic");
    cpSync(join(REPO, "examples", "acme", "semantic"), root, { recursive: true });
    mkdirSync(join(root, ".sl", "pending"), { recursive: true });
    writeFileSync(join(root, ".sl", "ledger.jsonl"), `${JSON.stringify({ id: "ans_0001", kind: "reply", text: "Yes, that is right.".repeat(8) })}\n`.repeat(400));
    for (let i = 1; i <= 40; i++) writeFileSync(join(root, ".sl", "pending", `rb_${String(i).padStart(4, "0")}.json`), JSON.stringify({ readback_id: i, items: "x".repeat(2000) }));
    const p: Project = { dir, root, state: join(tempDir("integrity-state"), "ledger-guard"), ledger: "", pending: "" };
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      expect(around(p, `python3 scripts/report.py --out report-${i}.txt`, () => {})).toEqual({ block: false });
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    // Typically about 2 ms for the copy and the comparison together; the bound leaves room for a loaded CI machine.
    expect(times[10]!).toBeLessThan(50);
  });
});

describe("the env file that holds the connection secret", () => {
  async function withEnv(): Promise<Project> {
    const p = await project();
    writeFileSync(join(p.dir, ".env"), "PG_URL=postgres://reader:synthetic@localhost:5432/acme\n");
    writeFileSync(join(p.dir, ".env.local"), "PG_URL=postgres://reader:synthetic@localhost:5432/acme\n");
    writeFileSync(join(p.dir, ".env.example"), "PG_URL=postgres://<user>:<password>@<host>:5432/<database>\n");
    writeFileSync(join(p.dir, ".gitignore"), ".env\n.env.*\n!.env.example\n");
    writeFileSync(join(p.dir, "notes.txt"), "the .env file holds PG_URL\n");
    return p;
  }
  const check = (p: Project, tool: string, input: Record<string, unknown>, cwd = p.dir) => checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd }));

  test("the Read tool is refused on .env and .env.<name>, with the message that names sl setup", async () => {
    const p = await withEnv();
    for (const f of [".env", ".env.local"]) {
      const v = check(p, "Read", { file_path: join(p.dir, f) });
      expect(v.allow).toBe(false);
      expect(v.message).toBe(`semantic-layer: refused Read:\n- it reads ${join(p.dir, f)}. ${SECRET}`);
    }
    // A link to it, and one kept inside the semantic root, are the same file to sl.
    symlinkSync(join(p.dir, ".env"), join(p.dir, "settings.txt"));
    expect(check(p, "Read", { file_path: join(p.dir, "settings.txt") }).allow).toBe(false);
    writeFileSync(join(p.root, ".env"), "PG_URL=x\n");
    expect(check(p, "Read", { file_path: join(p.root, ".env") }).allow).toBe(false);
  });

  test("cat, head, tail, less, more, grep, sed, awk, source and . are refused on it in Bash, however the command reaches it", async () => {
    const p = await withEnv();
    for (const command of [
      "cat .env",
      "head -n 5 .env",
      "tail -1 ./.env",
      "less .env",
      "more .env.local",
      "grep PG_URL .env",
      "grep -c -e PG_URL .env",
      "sed -n '1p' .env",
      "awk -F= '{print $2}' .env",
      "source .env && echo $PG_URL",
      ". ./.env",
      `cat ${join(p.dir, ".env")}`,
      "cd semantic && cat ../.env",
      "sudo -u postgres cat .env",
      "bash -c 'set -a; . .env; env'",
      "echo \"$(cat .env)\"",
      "while read line; do echo \"$line\"; done < .env",
      "cat .env*",
      "cat notes.txt .env | wc -l",
      "grep -rn PG_URL .",
      "grep -R PG_URL",
      "grep -rn --exclude='*.md' PG_URL .",
      "grep -rn --include='.env*' PG_URL .",
      "grep -A 2 -e PG_URL .env",
      // Behind a shell keyword, in a group or a function, and after a prefix.
      "if [ -f .env ]; then cat .env; else echo none; fi",
      "if ! cat .env; then echo none; fi",
      "while true; do cat .env; break; done",
      "until head -1 .env; do sleep 1; done",
      "{ cat .env; }",
      "[ -f .env ] && { cat .env; }",
      "! cat .env",
      "( cat .env )",
      "time cat .env",
      "show() { cat .env; }; show",
      "function show { tail .env; }; show",
      "if true; then cd semantic; cat ../.env; fi",
      "bash <<'EOF'\nif true; then cat .env; fi\nEOF",
    ]) {
      const v = check(p, "Bash", { command });
      expect(`${command}: ${v.allow}`).toBe(`${command}: false`);
      expect(v.message).toStartWith("semantic-layer: refused this shell command:\n- it reads ");
      expect(v.message).toContain(SECRET);
    }
    // A recursive search that reaches the file without naming it is told how to search the rest.
    const hint = " To search the other files, name a subdirectory or add --exclude='.env*'.";
    expect(check(p, "Bash", { command: "grep -rn TODO ." }).message).toBe(
      ["semantic-layer: refused this shell command:", ...[".env", ".env.local"].map((f) => `- it reads ${join(p.dir, f)}. ${SECRET}${hint}`)].join("\n"),
    );
    expect(check(p, "Bash", { command: "grep PG_URL .env" }).message).not.toContain(hint);
  });

  test("the file SL_ENV_FILE names is refused too", async () => {
    const p = await withEnv();
    const named = join(tempDir("integrity-secrets"), "warehouse.env");
    writeFileSync(named, "PG_URL=postgres://reader:synthetic@localhost:5432/acme\n");
    const env = { SL_ENV_FILE: named };
    expect(envFileRefusal("Read", { file_path: named }, p.dir, env)).toContain(SECRET);
    expect(envFileRefusal("Bash", { command: `cat ${named}` }, p.dir, env)).toContain(SECRET);
    expect(envFileRefusal("Read", { file_path: named }, p.dir, {})).toBeUndefined();
    expect(envFileRefusal("Bash", { command: `cat ${named}` }, p.dir, {})).toBeUndefined();
  });

  test(".env.example, unrelated files and commands that do not read the file are allowed", async () => {
    const p = await withEnv();
    const elsewhere = tempDir("integrity-elsewhere");
    writeFileSync(join(elsewhere, ".env"), "OTHER=1\n");
    for (const file of [join(p.dir, ".env.example"), join(p.dir, "notes.txt"), join(p.dir, ".gitignore"), join(p.root, "semantic.yaml"), join(elsewhere, ".env"), join(p.dir, ".env.missing")])
      expect(check(p, "Read", { file_path: file })).toEqual({ allow: true });
    for (const command of [
      "cat .env.example",
      "cat notes.txt && grep -n .env .gitignore",
      "grep -rn PG_URL semantic",
      // What a grep searches for is not a file it reads, and --exclude keeps a recursive one off the file.
      "grep -qe .env .gitignore",
      "grep -q -e '.env' .gitignore",
      "grep -c --regexp=.env .gitignore",
      "grep -A 2 .env .gitignore",
      "grep -rn --exclude='.env*' TODO .",
      "grep -rn --exclude .env --exclude '.env.*' TODO .",
      "grep -rn --include='*.ts' TODO .",
      "grep -rn --include '*.yaml' TODO",
      "rg TODO",
      "if [ -f .env ]; then echo present; fi",
      "for f in notes.txt; do cat $f; done",
      "ls -la .env",
      "test -f .env && echo present",
      `cat ${join(elsewhere, ".env")}`,
      `bun ${SL} setup --source wh --dialect postgres --env PG_URL --root ${p.root}`,
      "cat \"$FILE\"",
      "cat *",
    ])
      expect(`${command}: ${JSON.stringify(check(p, "Bash", { command }))}`).toBe(`${command}: {"allow":true}`);
    expect(check(p, "Bash", { command: "cat .env" }, elsewhere)).toEqual({ allow: true });
  });
});

describe("the plugin registers the comparison", () => {
  interface Group {
    matcher?: string;
    hooks: { type: string; command: string; timeout: number }[];
  }
  const hooks = (JSON.parse(readFileSync(join(REPO, ".claude-plugin", "plugin.json"), "utf8")) as { hooks: Record<string, Group[]> }).hooks;
  const INTEGRITY = 'bun "${CLAUDE_PLUGIN_ROOT}/skills/semantic-layer/scripts/hooks/integrity.ts"';
  const MCP = "mcp__.*semantic-layer.*__sl_.*";

  test("before Bash and Read, after Bash whether it succeeds or fails, and around the MCP server's sl tools", () => {
    expect(hooks.PreToolUse![0]!.matcher!.split("|")).toEqual(expect.arrayContaining(["Bash", "Read"]));
    expect(hooks.PreToolUse![0]!.hooks.map((h) => h.command)).toEqual(['bun "${CLAUDE_PLUGIN_ROOT}/skills/semantic-layer/scripts/hooks/guard-edits.ts"']);
    expect(hooks.PreToolUse![1]!.matcher).toBe(MCP);
    expect(hooks.PreToolUse![1]!.hooks.map((h) => h.command)).toContain(INTEGRITY);
    for (const event of ["PostToolUse", "PostToolUseFailure"]) {
      expect(hooks[event]!.length).toBe(1);
      expect(hooks[event]![0]!.matcher).toBe(`Bash|${MCP}`);
      expect(hooks[event]![0]!.hooks).toEqual([{ type: "command", command: INTEGRITY, timeout: 10 }]);
    }
  });

  // Runs a registered hook command as Claude Code does, in a project, and returns its exit code and stderr.
  function run(command: string, p: Project, event: string, call: Record<string, unknown>, env: Record<string, string | undefined>): { code: number; err: string } {
    const r = Bun.spawnSync(["sh", "-c", command], {
      cwd: p.dir,
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: event, ...call })),
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO, CLAUDE_PROJECT_DIR: p.dir, SL_ENV_FILE: undefined, SEMANTIC_ROOT: undefined, ...env },
    });
    return { code: r.exitCode, err: r.stderr.toString() };
  }
  const pre = hooks.PreToolUse![0]!.hooks[0]!.command;

  test.each(["PostToolUse", "PostToolUseFailure"])("the registered commands undo a forged yes and exit 2 with the reason on stderr (%s)", async (event) => {
    const p = await project();
    const id = await readback(p);
    const line = await yesLine(p, id);
    const env = { CLAUDE_PLUGIN_DATA: tempDir("integrity-data") };
    const call = payload(p, PYTHON);
    expect(run(pre, p, "PreToolUse", call, env)).toEqual({ code: 0, err: "" });
    expect(readdirSync(join(env.CLAUDE_PLUGIN_DATA, "ledger-guard")).length).toBe(1);
    forge(p, line);
    const post = run(hooks[event]![0]!.hooks[0]!.command, p, event, { ...call, ...(event === "PostToolUse" ? { tool_response: { stdout: "" } } : { error: "exit 1" }) }, env);
    expect(post.code).toBe(2);
    expect(post.err).toContain(UNDONE);
    expect(existsSync(p.ledger)).toBe(false);
    expect(readdirSync(env.CLAUDE_PLUGIN_DATA)).toEqual([]);
  }, 30_000);

  test("with CLAUDE_PLUGIN_DATA unset the state is kept in a directory of this user's under the temp directory", async () => {
    const p = await project();
    await readback(p, true);
    const ledger = read(p.ledger)!;
    const tmp = tempDir("integrity-tmp");
    const env = { CLAUDE_PLUGIN_DATA: undefined, TMPDIR: tmp };
    const call = payload(p, "node rewrite.js");
    expect(run(pre, p, "PreToolUse", call, env)).toEqual({ code: 0, err: "" });
    const state = join(tmp, `semantic-layer-guard-${userInfo().uid}`);
    expect(readdirSync(tmp)).toEqual([`semantic-layer-guard-${userInfo().uid}`]);
    expect(statSync(state).mode & 0o077).toBe(0);
    appendFileSync(p.ledger, "forged\n");
    const post = run(hooks.PostToolUse![0]!.hooks[0]!.command, p, "PostToolUse", call, env);
    expect(post.code).toBe(2);
    expect(post.err).toContain(UNDONE);
    expect(read(p.ledger)).toBe(ledger);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);

  test("the registered commands refuse the env file, and the MCP sl tools are marked as sl and stopped by an earlier forged change", async () => {
    const p = await project();
    await readback(p, true);
    const ledger = read(p.ledger)!;
    writeFileSync(join(p.dir, ".env"), "PG_URL=postgres://reader:synthetic@localhost:5432/acme\n");
    const env = { CLAUDE_PLUGIN_DATA: tempDir("integrity-data") };
    const refused = run(pre, p, "PreToolUse", payload(p, "", { tool: "Read", input: { file_path: join(p.dir, ".env") } }), env);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain(SECRET);
    expect(refused.err).not.toContain("synthetic");
    const mcp = hooks.PreToolUse![1]!.hooks.find((h) => h.command === INTEGRITY)!.command;
    const tool = payload(p, "", { tool: "mcp__plugin_semantic-layer-builder_semantic-layer__sl_approve", input: { target: "wh.orders.revenue" } });
    expect(run(pre, p, "PreToolUse", payload(p, "node rewrite.js; exit 1"), env)).toEqual({ code: 0, err: "" });
    appendFileSync(p.ledger, "forged\n");
    const stopped = run(mcp, p, "PreToolUse", tool, env);
    expect(stopped.code).toBe(2);
    expect(stopped.err).toContain(UNDONE);
    expect(read(p.ledger)).toBe(ledger);
    expect(run(mcp, p, "PreToolUse", tool, env)).toEqual({ code: 0, err: "" });
    expect(readdirSync(join(env.CLAUDE_PLUGIN_DATA, "ledger-guard")).map((n) => n.replace(/^.*\./, ""))).toEqual(["sl"]);
    expect(run(hooks.PostToolUse![0]!.hooks[0]!.command, p, "PostToolUse", tool, env)).toEqual({ code: 0, err: "" });
    expect(readdirSync(env.CLAUDE_PLUGIN_DATA)).toEqual([]);
  }, 30_000);
});

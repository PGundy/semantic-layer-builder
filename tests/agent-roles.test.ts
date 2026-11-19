import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import { checkToolUse, type Verdict } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { openQueryAdapter } from "../skills/semantic-layer/scripts/lib/plan.ts";
import { loadSource } from "../skills/semantic-layer/scripts/lib/project.ts";
import { commandList, DENIED_FLAGS, OWNER_COMMANDS, ROLE_NAMES, ROLES, roleOf, semlayerRefusal, type Role } from "../skills/semantic-layer/scripts/lib/roles.ts";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { duckdbSource, initProject, semlayer, tempDir, tempRoot } from "./helpers.ts";

// The roles of a multi-agent run (spec: Agent roles): lib/roles.ts, the plugin's agents/*.md, the
// spec's table, and the hook's role check on payloads that carry each role's agent_type. All data is synthetic.

const REPO = join(import.meta.dir, "..");
const SEMLAYER = join(REPO, "skills", "semantic-layer", "scripts", "semlayer.ts");
const AGENTS = join(REPO, "agents");
const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

let dir: string;
let root: string;
beforeAll(() => {
  dir = tempDir("roles");
  root = join(dir, "semantic");
  mkdirSync(join(root, "models", "wh"), { recursive: true });
  writeFileSync(join(root, "semantic.yaml"), "name: rolestest\n");
  writeFileSync(join(root, "models", "wh", "orders.yaml"), "model: orders\ntable: main.orders\nstatus: draft\n");
});

function call(agent: string | undefined, tool: string, input: Record<string, unknown>, cwd = dir): Verdict {
  const payload: Record<string, unknown> = { tool_name: tool, tool_input: input, cwd, hook_event_name: "PreToolUse" };
  if (agent !== undefined) Object.assign(payload, { agent_type: agent, agent_id: "a1b2c3" });
  return checkToolUse(JSON.stringify(payload));
}
const bash = (agent: string | undefined, command: string, cwd = dir) => call(agent, "Bash", { command }, cwd);
const run = (args: string) => `bun ${SEMLAYER} ${args}`;

function allowed(v: Verdict): void {
  expect(v.message ?? "").toBe("");
  expect(v.allow).toBe(true);
}
function refused(v: Verdict, ...phrases: string[]): void {
  expect(v.allow).toBe(false);
  for (const p of phrases) expect(v.message).toContain(p);
}

describe("the hook holds each role agent to its role", () => {
  test("batch analyst: semlayer brief is allowed, semlayer approve refused", () => {
    allowed(bash("semlayer-batch-analyst", run("brief --source wh --batch 1 --root semantic")));
    refused(bash("semlayer-batch-analyst", run("approve --target wh.orders")), "semlayer approve acts on the owner's recorded answers", "only the interviewer", "semlayer brief");
    refused(bash("semlayer-batch-analyst", run("readback --targets wh.orders")), "may not run semlayer readback", "it may run semlayer brief");
  });

  test("connector runner: semlayer results add and status are allowed; approve, reply and Edit refused", () => {
    const store = `${run("results add --plan 3f9a1c2b7d4e --query tables --file /dev/stdin")} <<'ROWS'\n[{"note": "$(rm -rf /) is only text"}]\nROWS`;
    allowed(bash("semlayer-connector-runner", store));
    allowed(bash("semlayer-connector-runner", run("results add --plan 3f9a1c2b7d4e --query tables --file rows.json --json")));
    allowed(bash("semlayer-connector-runner", `${run("results status --plan 3f9a1c2b7d4e --json")} 2>&1`));
    allowed(bash("semlayer-connector-runner", `${run("results add --plan p --query q --file /dev/stdin")} <<< '[{"n": 1}]'`));
    refused(bash("semlayer-connector-runner", run("approve --target wh.orders")), "only the interviewer");
    refused(bash("semlayer-connector-runner", run('reply --readback rb_0001 --item 1 --text "yes" --verdict yes --by "Owner"')), "semlayer reply acts on the owner's recorded answers");
    refused(bash("semlayer-connector-runner", run("results --plan p status")), "subcommand right after the command name");
    refused(call("semlayer-connector-runner", "Edit", { file_path: join(dir, "rows.json"), old_string: "a", new_string: "b" }), "refused Edit for the connector runner", "edits no files");
    refused(call("semlayer-connector-runner", "Write", { file_path: join(dir, "rows.json"), content: "[]" }), "edits no files");
  });

  test("golden builder: semlayer goldens run is allowed, semlayer goldens confirm refused", () => {
    allowed(bash("semlayer-golden-builder", run("goldens run --name revenue_2025 --json")));
    allowed(bash("semlayer-golden-builder", run(`goldens new --name g --question "Revenue in 2025?" --request '{"metrics":["revenue"]}' --source wh`)));
    allowed(bash("semlayer-golden-builder", run("sql --source wh --request goldens/g.yaml")));
    refused(bash("semlayer-golden-builder", run("goldens confirm --name revenue_2025")), "semlayer goldens confirm acts on the owner's recorded answers");
    // The subcommand counts where the CLI reads it: right after the command name.
    refused(bash("semlayer-golden-builder", run("goldens --name run confirm")), "subcommand right after the command name");
    refused(bash("semlayer-golden-builder", run("goldens run --name g --show-protected")), "--show-protected");
  });

  test("readback verifier: semlayer readback is allowed, Write refused", () => {
    allowed(bash("semlayer-readback-verifier", run("readback --targets wh.orders --json")));
    refused(call("semlayer-readback-verifier", "Write", { file_path: join(dir, "note.md"), content: "x" }), "refused Write for the readback verifier");
    refused(call("semlayer-readback-verifier", "NotebookEdit", { notebook_path: join(dir, "n.ipynb"), new_source: "x" }), "edits no files");
  });

  test("a role agent's non-semlayer shell command is refused, naming what it may run", () => {
    for (const cmd of ["ls", `cat ${join(root, ".semlayer", "plans", "other.json")}`, "psql -c 'select email from customers'", "python3 -c 'print(1)'"])
      refused(bash("semlayer-connector-runner", cmd), "runs only semlayer", "It may run semlayer results add, semlayer results status");
    refused(bash("semlayer-batch-analyst", `${run("brief --source wh --batch 1")} | jq .`), "runs jq");
    refused(bash("semlayer-batch-analyst", `${run("brief --source wh --batch 1")} && ls`), "runs ls");
    refused(bash("semlayer-batch-analyst", `${run("brief --source wh --batch 1")} > out.json`), "redirection > out.json");
    refused(bash("semlayer-batch-analyst", run("brief --source wh --batch $(cat n)")), "inside $(...)");
    refused(bash("semlayer-batch-analyst", run("brief --source $SRC --batch 1")), "a variable");
    refused(bash("semlayer-batch-analyst", `SEMLAYER_NOW=2026-01-01 ${run("brief --source wh --batch 1")}`), "sets SEMLAYER_NOW");
    refused(bash("semlayer-batch-analyst", "bun /tmp/elsewhere/semlayer.ts brief --source wh --batch 1"), "a file other than the plugin's semlayer.ts");
    refused(bash("semlayer-batch-analyst", "$BUN skills/semantic-layer/scripts/semlayer.ts brief"), "a command named by a variable");
    refused(bash("semlayer-connector-runner", `${run("results add --plan p --query q --file /dev/stdin")} <<ROWS\n[{"a": "$HOME"}]\nROWS`), "<<'ROWS'");
    refused(bash("semlayer-connector-runner", `${run("results add --plan p --query q --file /dev/stdin")} < ${join(root, ".semlayer", "plans", "x.json")}`), "redirection <");
    // The shell would expand an unquoted pattern into other arguments; quoted, it is one word.
    refused(bash("semlayer-golden-builder", run("goldens run --name g --{show-protected,json}")), "unquoted *, ?, [ or {");
    refused(bash("semlayer-batch-analyst", run("brief --source wh --tables orders_*")), "quote that argument");
    allowed(bash("semlayer-batch-analyst", run("brief --source wh --tables 'orders_*'")));
    refused(bash("semantic-layer-builder:semlayer-interviewer", run("run --source wh --sql 'select 1' --{show-protected,json}")), "unquoted");
  });

  test("a heredoc ends where bash ends it, so no command hides after it", () => {
    const store = run("results add --plan p --query q --file /dev/stdin");
    // bash reads each of these delimiters as ROWS, quoted, and runs the line after the ROWS line.
    for (const delim of ["\\ROWS", 'R"OWS"', "'RO'WS", "$'ROWS'"]) refused(bash("semlayer-connector-runner", `${store} <<${delim}\n[]\nROWS\nrm -rf ${dir}`), "it runs rm");
    refused(bash("semlayer-connector-runner", `${store} <<ROWS\n[]\nROWS`), "<<'ROWS'");
    // Without a role the hand-edit check reads the same delimiters, and bash's joining of a line ending in \.
    const ledger = join(root, ".semlayer", "ledger.jsonl");
    for (const delim of ["\\EOF", 'E"O"F', "'E'OF"]) refused(bash(undefined, `cat <<${delim}\nx\nEOF\necho x > ${ledger}`), "is written only by the CLI");
    refused(bash(undefined, `cat <<EOF\nE\\\nOF\necho x > ${ledger}\nEOF`), "is written only by the CLI");
    allowed(bash(undefined, `cat <<'EOF'\nE\\\nOF\necho x > ${ledger}\nEOF`));
  });

  test("$'...' and $\"...\" cannot spell --show-protected past the hook", () => {
    for (const agent of ["semlayer-golden-builder", "semlayer-interviewer"])
      for (const w of ["$'--show-protected'", '$"--show-protected"', "$'\\x2d\\x2dshow-protected'", "$'\\055-show-protected'"])
        refused(bash(agent, run(`goldens run --name g ${w}`)), "--show-protected");
    allowed(bash("semlayer-batch-analyst", run("brief --source $'wh' --batch 1")));
  });

  test("bun is the bun on the PATH or the one running the hook", () => {
    refused(bash("semlayer-batch-analyst", `/tmp/elsewhere/bun ${SEMLAYER} brief --source wh --batch 1`), "runs bun");
    allowed(bash("semlayer-batch-analyst", `${process.execPath} ${SEMLAYER} brief --source wh --batch 1`));
  });

  test("the semlayer entry may be written relative to the call's directory, or with bun run", () => {
    allowed(bash("semlayer-batch-analyst", "bun skills/semantic-layer/scripts/semlayer.ts brief --source wh --batch 1", REPO));
    allowed(bash("semlayer-batch-analyst", `bun run ${SEMLAYER} brief --source wh --batch 1`));
    allowed(bash("semlayer-batch-analyst", `cd ${dir} && ${run("brief --source wh --batch 1 --root semantic")}`));
    // After a cd the relative path must name the entry from every directory the shell may be in.
    refused(bash("semlayer-batch-analyst", `cd ${dir} && bun skills/semantic-layer/scripts/semlayer.ts brief --source wh --batch 1`, REPO), "a file other than the plugin's semlayer.ts");
  });

  test("--help runs nothing and is allowed for any command; --show-protected is refused for every role", () => {
    allowed(bash("semlayer-batch-analyst", run("approve --help")));
    refused(bash("semlayer-batch-analyst", run("approve --target x -- --help")), "only the interviewer");
    for (const role of Object.values(ROLES)) refused(bash(role.agent, run("run --source wh --sql 'select 1' --show-protected")), "--show-protected");
  });

  test("a plugin-scoped agent_type matches on the part after the last colon", () => {
    refused(bash("semantic-layer-builder:semlayer-batch-analyst", run("approve --target wh.orders")), "only the interviewer");
    allowed(bash("semantic-layer-builder:semlayer-batch-analyst", run("brief --source wh --batch 1")));
    expect(roleOf("semantic-layer-builder:semlayer-golden-builder")?.name).toBe("golden_builder");
    expect(roleOf("other-plugin:reviewer")).toBeUndefined();
    expect(roleOf("semlayer-batch-analyst-2")).toBeUndefined();
  });

  test("the interviewer runs every semlayer command and other shell commands, but no hand edit inside a semantic root", () => {
    const who = "semantic-layer-builder:semlayer-interviewer";
    allowed(bash(who, run("approve --target wh.orders")));
    allowed(bash(who, run("goldens confirm --name revenue_2025")));
    allowed(bash(who, "ls && git status"));
    refused(bash(who, run("run --source wh --sql 'select email from customers' --show-protected")), "--show-protected");
    refused(call(who, "Edit", { file_path: join(root, "models", "wh", "orders.yaml"), old_string: "status: draft", new_string: "status: draft # x" }), "never edits by hand", "typed edit");
    refused(call(who, "Write", { file_path: join(root, "sources", "wh.yaml"), content: "source: wh\n" }), "sources/wh.yaml is in the semantic layer");
    allowed(call(who, "Write", { file_path: join(dir, "rows.json"), content: "[]" }));
    refused(call(who, "Write", { file_path: join(root, "sources", "wh.yaml"), content: "source: wh\n" }), "semlayer setup --view");
    // Its shell writes inside the root are held to the same rule; removing an abandoned plan is not an edit.
    refused(bash(who, `sed -i 's/draft/x/' ${join(root, "models", "wh", "orders.yaml")}`), "never edits the semantic layer by hand", "semlayer draft");
    allowed(bash(who, `rm -f ${join(root, ".semlayer", "plans", "3f9a1c2b7d4e.json")}`));
    // --show-protected is read through a cd, a prefix, the package script and a variable.
    for (const cmd of [
      `cd ${REPO} && bun skills/semantic-layer/scripts/semlayer.ts run --source wh --sql 'select 1' --show-protected`,
      `env SEMLAYER_NOW=2026-01-01 ${run("run --source wh --sql 'select 1' --show-protected")}`,
      `cd ${REPO} && bun run semlayer run --source wh --sql 'select 1' --show-protected`,
      `echo "$(bun run semlayer run --source wh --sql 'select 1' --show-protected)"`,
    ])
      refused(bash(who, cmd), "--show-protected");
    refused(bash(who, `F=--show-protected; ${run("run --source wh --sql 'select 1' $F")}`), "a variable or a command's output");
    refused(bash(who, `cd ${REPO} && env bun skills/semantic-layer/scripts/semlayer.ts run --source "$S" --sql 'select 1'`), "a variable or a command's output");
    // The hand-edit checks still apply after the role check.
    refused(bash(who, `echo x > ${join(root, "models", "wh", "orders.yaml")}`), "refused this shell command");
  });

  // docs/PRD-hardening.md HR-15: an owner turn's batched forms are allowed exactly as the single
  // forms are: the interviewer runs them, and no other role does.
  test("the interviewer runs the batched owner-turn forms, which every other role is refused as the single forms are", () => {
    const who = "semantic-layer-builder:semlayer-interviewer";
    const forms = [
      "reply --readback rb_0001 --answers answers.json",
      "approve --readback rb_0001",
      "approve --target wh.orders --target wh.orders.revenue",
      "question resolve --answers answers.json",
      "goldens confirm --readback rb_0001",
    ];
    const heredoc = (c: string) => `${run(c.replace("answers.json", "-"))} <<'JSON'\n{"by": "Owner", "answers": []}\nJSON`;
    for (const c of forms) {
      allowed(bash(who, run(c)));
      if (c.includes("answers.json")) allowed(bash(who, heredoc(c)));
      allowed(bash(undefined, run(c)));
      for (const agent of ["semlayer-golden-builder", "semlayer-batch-analyst", "semlayer-connector-runner", "semlayer-readback-verifier"]) {
        const single = bash(agent, run(c.startsWith("question") ? 'question resolve wh.orders --index 1 --text "No." --by "Owner"' : c.startsWith("reply") ? 'reply --readback rb_0001 --item 1 --text "Yes." --verdict yes --by "Owner"' : c.startsWith("goldens") ? "goldens confirm --name revenue_2025" : "approve --target wh.orders"));
        const batched = bash(agent, run(c));
        expect(single.allow).toBe(false);
        expect({ c, agent, allow: batched.allow, message: batched.message }).toEqual({ c, agent, allow: false, message: single.message });
      }
    }
  });

  test("the interviewer creates access.yaml and sets a golden's and a source's keys with semlayer set, which it may not write by hand", () => {
    const who = "semantic-layer-builder:semlayer-interviewer";
    allowed(bash(who, run("set access mode open")));
    allowed(bash(who, run(`set golden:revenue_2025 user '{"department": "finance"}'`)));
    allowed(bash(who, run("set golden:revenue_2025 tolerance 0")));
    allowed(bash(who, run('set golden:revenue_2025 reference "Finance close, 2025."')));
    allowed(bash(who, run('set source:wh description "Read replica of the order system."')));
    refused(call(who, "Write", { file_path: join(root, "access.yaml"), content: "mode: open\nstatus: draft\n" }), "never edits by hand");
    refused(call(who, "Write", { file_path: join(root, "goldens", "revenue_2025.yaml"), content: "name: revenue_2025\n" }), "never edits by hand");
    // Every other role is held to its own commands.
    refused(bash("semlayer-golden-builder", run("set golden:revenue_2025 role finance")), "may not run semlayer set");
  });

  // docs/PRD-hardening.md HR-9: every access rule has a typed command, so the interviewer, whose
  // hand edit of access.yaml is refused, has one to run for each.
  test("the interviewer runs every access command, and may still not write access.yaml by hand", async () => {
    const who = "semantic-layer-builder:semlayer-interviewer";
    const commands = [
      "add-attribute --name department --type string",
      "remove-attribute department",
      `add-role --name finance --assign-when "user.department == 'finance'" --allow-tags pii`,
      "remove-role finance",
      `set access role:finance assign_when "user.department in ['finance', 'audit']"`,
      "set access role:finance allow.tags --unset",
      "set access restriction:refunds targets warehouse.refunds,metric:net_revenue",
      "set access attribute:department description 'The department in the login system.'",
      "add-restriction --name refunds --targets warehouse.refunds --roles finance",
      "remove-restriction refunds",
      `add-row-filter --role sales --model wh.orders --expr "region = {{ user.region }}"`,
      "add-row-filter --role sales --model wh.orders --column rep_id --via wh.team_closure --manager manager_id --member member_id --user employee_id",
      "remove-row-filter --role sales --model wh.orders --index 1",
      'question add access.roles.sales --text "Do reps see refunds?"',
      'reply --readback rb_0001 --item 1 --text "Hide it from marketing." --verdict change --about access --by "Owner"',
    ];
    for (const c of commands) {
      allowed(bash(who, run(c)));
      // Each is a command the CLI has; only the interviewer, who makes the layer's changes, runs it.
      expect(Object.keys(COMMANDS)).toContain(c.split(" ")[0]!);
      refused(bash("semlayer-golden-builder", run(c)), c.startsWith("reply") ? "only the interviewer" : `may not run semlayer ${c.split(" ")[0]}`);
    }
    for (const tool of ["Write", "Edit"])
      refused(call(who, tool, { file_path: join(root, "access.yaml"), content: "mode: open\nstatus: draft\n", old_string: "a", new_string: "b" }), "never edits by hand");
    refused(bash(who, `printf 'roles: []\n' >> ${join(root, "access.yaml")}`), "never edits the semantic layer by hand");
    // And they do what the hand edit would have: the access file is built with them, in a root the hook guards.
    const t = tempRoot();
    await initProject(t.root);
    for (const c of ["set access mode open", "add-attribute --name department --type string", "add-role --name finance", "set access role:finance assign_when user.department=='finance'", "remove-role finance", "remove-attribute department"]) {
      allowed(bash(who, run(`${c} --root ${t.root}`)));
      expect({ c, code: (await semlayer(t.root, c.split(" "))).code }).toEqual({ c, code: 0 });
    }
    expect(readFileSync(join(t.root, "access.yaml"), "utf8")).toBe("mode: open\nstatus: draft\n");
  });

  // docs/PRD-hardening.md HR-15: the walkthrough's owner answers that had no typed command now have one.
  test("the interviewer runs add-join, remove-join, ignore-column --remove and goldens new in semlayer apply; other roles may not", () => {
    const who = "semantic-layer-builder:semlayer-interviewer";
    const commands = [
      "add-join --source wh --model orders --name ship_to_region --to regions --keys ship_region=region_code",
      "remove-join --source wh --model orders --name ship_to_region",
      "ignore-column --source wh --model customers --column email --remove",
    ];
    for (const c of commands) {
      allowed(bash(who, run(c)));
      expect(Object.keys(COMMANDS)).toContain(c.split(" ")[0]!);
      refused(bash("semlayer-golden-builder", run(c)), `may not run semlayer ${c.split(" ")[0]}`);
    }
    const file = join(dir, "walkthrough-edits.json");
    writeFileSync(file, JSON.stringify({ edits: [commands[0]!.split(" "), ["goldens", "new", "--name", "g", "--question", "Q?", "--request", "{}"]] }));
    allowed(bash(who, run(`apply --file ${file}`)));
    refused(bash("semlayer-golden-builder", run(`apply --file ${file}`)), "may not run semlayer apply");
  });

  test("the main agent (no agent_type) and other agents are checked as before", () => {
    for (const agent of [undefined, "Explore", "general-purpose", "other-plugin:semlayer-helper"]) {
      allowed(bash(agent, "ls"));
      allowed(bash(agent, run("approve --target wh.orders")));
      allowed(call(agent, "Edit", { file_path: join(root, "models", "wh", "orders.yaml"), old_string: "status: draft", new_string: "status: draft # note" }));
      allowed(call(agent, "Write", { file_path: join(dir, "note.md"), content: "x" }));
      refused(bash(agent, `echo x > ${join(root, ".semlayer", "ledger.jsonl")}`), "is written only by the CLI");
    }
  });

  test("the plugin's hook command refuses a role agent's call with exit 2", async () => {
    const plugin = JSON.parse(readFileSync(join(REPO, ".claude-plugin", "plugin.json"), "utf8")) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    const p = Bun.spawn(["sh", "-c", plugin.hooks.PreToolUse[0]!.hooks[0]!.command], { env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO }, stdin: "pipe", stderr: "pipe" });
    p.stdin.write(JSON.stringify({ tool_name: "Bash", cwd: dir, agent_type: "semantic-layer-builder:semlayer-batch-analyst", agent_id: "x", tool_input: { command: "ls" } }));
    await p.stdin.end();
    expect(await p.exited).toBe(2);
    expect(await new Response(p.stderr).text()).toContain("for the batch analyst (semlayer-batch-analyst)");
  });
});

describe("the connector runner's documented store command works end to end", () => {
  test("the hook allows it and the shell stores the rows", async () => {
    const t = tempRoot();
    try {
      await initProject(t.root);
      await duckdbSource(t.root, t.dir, "wh", ["create table orders (order_id integer primary key, note varchar)", "insert into orders values (1, 'it''s $5 `now`')"]);
      const emitted = await semlayer(t.root, ["introspect", "--source", "wh", "--emit-sql"]);
      expect(emitted.code).toBe(0);
      const plan = emitted.json<{ plan_id: string; queries: { id: string; sql: string }[] }>();
      const q = plan.queries[0]!;
      const adapter = await openQueryAdapter(t.root, loadSource(t.root, "wh"), {});
      const { rows } = await adapter.query(q.sql);
      await adapter.close();
      const command = `bun ${SEMLAYER} results add --plan ${plan.plan_id} --query ${q.id} --file /dev/stdin --root ${t.root} --json <<'ROWS'\n${JSON.stringify(rows)}\nROWS`;
      allowed(bash("semantic-layer-builder:semlayer-connector-runner", command, t.dir));
      const p = Bun.spawn(["bash", "-c", command], { cwd: t.dir, stdout: "pipe", stderr: "pipe" });
      expect(await p.exited).toBe(0);
      expect(JSON.parse(await new Response(p.stdout).text())).toMatchObject({ plan_id: plan.plan_id, query: q.id, rows: rows.length, state: "added" });
    } finally {
      t.cleanup();
    }
  });
});

describe("lib/roles.ts", () => {
  test("names the five roles of FR-4.1, each with its own agent", () => {
    expect(Object.keys(ROLES).sort()).toEqual([...ROLE_NAMES].sort());
    expect(new Set(Object.values(ROLES).map((r) => r.agent)).size).toBe(5);
    for (const r of Object.values(ROLES)) expect(r.agent).toMatch(/^semlayer-[a-z-]+$/);
  });

  test("every command a role runs exists, with a real subcommand", async () => {
    const subs: Record<string, string[]> = { goldens: ["run", "confirm", "check", "new"], results: ["add", "status"] };
    for (const r of Object.values(ROLES)) {
      if (r.commands === "every") continue;
      for (const c of r.commands) {
        const [name, sub] = c.split(" ");
        expect(COMMANDS[name!]).toBeDefined();
        if (sub) expect(subs[name!]).toContain(sub);
      }
    }
  });

  test("only the role that talks to the owner runs the owner's commands", () => {
    for (const r of Object.values(ROLES)) {
      for (const c of OWNER_COMMANDS) {
        if (r.commands !== "every") expect(r.commands).not.toContain(c);
        expect(semlayerRefusal(r, c.split(" ")) === undefined).toBe(r.owner);
      }
    }
    expect(Object.values(ROLES).filter((r) => r.owner).map((r) => r.name)).toEqual(["interviewer"]);
    for (const r of Object.values(ROLES)) for (const f of DENIED_FLAGS) expect(semlayerRefusal(r, ["goldens", "run", "--name", "g", f])).toContain(f);
  });

  test("only the interviewer edits, and only outside a semantic root", () => {
    for (const r of Object.values(ROLES)) expect(r.edits).toBe(r.name === "interviewer" ? "outside_layer" : "none");
    for (const r of Object.values(ROLES)) expect(r.shell).toBe(r.name === "interviewer" ? "any" : "semlayer_only");
  });
});

interface AgentFile {
  file: string;
  front: Record<string, unknown>;
  body: string;
}

function agentFiles(): AgentFile[] {
  return readdirSync(AGENTS)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const text = readFileSync(join(AGENTS, file), "utf8");
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
      if (!m) throw new Error(`${file} has no frontmatter`);
      return { file, front: parseYamlText(m[1]!, file) as Record<string, unknown>, body: m[2]! };
    });
}

const toolList = (v: unknown): string[] => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(v) ? v.map(String) : []);
const KNOWN_TOOLS = ["Read", "Grep", "Glob", "Bash", "Edit", "MultiEdit", "Write", "NotebookEdit", "Agent", "AskUserQuestion", "WebFetch", "WebSearch", "TodoWrite"];

// The tools an agent ends up with: its `tools` (or every tool when it names none) less `disallowedTools`.
function available(front: Record<string, unknown>): string[] {
  const base = front.tools === undefined ? KNOWN_TOOLS : toolList(front.tools);
  const deny = new Set(toolList(front.disallowedTools));
  return base.filter((t) => !deny.has(t));
}

// The bullets of a "## <heading>" section of an agent's body.
function bullets(body: string, heading: string): string[] {
  const at = body.indexOf(`\n## ${heading}\n`);
  if (at < 0) return [];
  const rest = body.slice(at + heading.length + 5);
  const end = rest.search(/\n## |\n[^-\s]/);
  return (end < 0 ? rest : rest.slice(0, end))
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
}

describe("the plugin's agents/*.md", () => {
  const files = agentFiles();
  const roleOfFile = (f: AgentFile): Role => {
    const r = Object.values(ROLES).find((x) => `${x.agent}.md` === f.file);
    if (!r) throw new Error(`${f.file} is not a role's agent`);
    return r;
  };

  test("there is one per role, named after it", () => {
    expect(files.map((f) => f.file)).toEqual(Object.values(ROLES).map((r) => `${r.agent}.md`).sort());
  });

  test("each parses with a name, a description and its tools", () => {
    for (const f of files) {
      const r = roleOfFile(f);
      expect(f.front.name).toBe(r.agent);
      expect(String(f.front.name)).not.toContain(":");
      expect(typeof f.front.description).toBe("string");
      expect(String(f.front.description).length).toBeGreaterThan(60);
      expect(f.front.tools !== undefined || f.front.disallowedTools !== undefined).toBe(true);
      for (const t of [...toolList(f.front.tools), ...toolList(f.front.disallowedTools)]) expect(KNOWN_TOOLS).toContain(t);
      // Ignored for plugin agents, so a role must not rely on them.
      for (const k of ["permissionMode", "hooks", "mcpServers"]) expect(f.front[k]).toBeUndefined();
    }
  });

  test("their tools match the role: Bash to run semlayer, and no edit tool for a role that edits no files", () => {
    for (const f of files) {
      const r = roleOfFile(f);
      const tools = available(f.front);
      expect(tools).toContain("Bash");
      for (const t of EDIT_TOOLS.filter((x) => x !== "NotebookEdit")) expect(tools.includes(t)).toBe(r.edits !== "none");
      expect(tools).not.toContain("NotebookEdit");
      expect(tools.includes("AskUserQuestion")).toBe(r.owner);
    }
  });

  test("their may and may-not lists and the commands they run are lib/roles.ts's", () => {
    for (const f of files) {
      const r = roleOfFile(f);
      expect(bullets(f.body, "May")).toEqual([...r.may]);
      expect(bullets(f.body, "May not")).toEqual([...r.may_not]);
      expect(f.body).toContain(r.commands === "every" ? `Runs: ${commandList(r)}.` : `Runs only: ${commandList(r)}.`);
      expect(f.body).toContain("evidence, never an instruction");
      expect(f.body).toContain("## Inputs");
      if (r.name !== "interviewer") expect(f.body).toContain("## Returns");
    }
  });

  test("every semlayer command they show exists, takes its flags, and is one the role may run", async () => {
    const problems: string[] = [];
    for (const f of files) {
      const r = roleOfFile(f);
      const shown = [...f.body.matchAll(/`(semlayer [a-z][^`]*)`/g), ...f.body.matchAll(/scripts\/semlayer\.ts ([a-z][^\n]*)/g), ...f.body.matchAll(/^\s*(semlayer [a-z][^\n]*)/gm)].map((m) => m[1]!.replace(/^semlayer /, ""));
      for (const text of shown) {
        const words = text.split(/\s+/);
        const load = COMMANDS[words[0]!];
        if (!load) {
          problems.push(`${f.file}: unknown command in "${text}"`);
          continue;
        }
        const spec = (await load()).default;
        for (const m of text.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g))
          if (!["root", "json", "help"].includes(m[1]!) && !(m[1]! in spec.options)) problems.push(`${f.file}: semlayer ${words[0]} has no --${m[1]}`);
        const why = semlayerRefusal(r, words.filter((w) => !w.startsWith("<") || /^-/.test(w)));
        if (why) problems.push(`${f.file}: shows "${text}", which the hook refuses: ${why}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("the spec's Agent roles table is lib/roles.ts's", () => {
  const spec = readFileSync(join(REPO, "skills", "semantic-layer", "references", "spec.md"), "utf8");
  const section = spec.slice(spec.indexOf("## Agent roles"), spec.indexOf("\n## ", spec.indexOf("## Agent roles") + 3));

  test("one row per role", () => {
    const rows = section.split("\n").filter((l) => /^\| [A-Z][a-z]+ [a-z]*/.test(l) && !l.startsWith("| Role "));
    expect(rows).toEqual(
      Object.values(ROLES).map((r) => `| ${r.title} | \`${r.agent}\` | ${commandList(r)} | ${r.may.join("; ")} | ${r.may_not.join("; ")} |`),
    );
  });

  test("it says how agent names match and what the hook cannot check", () => {
    for (const phrase of ["after the last `:` counts", "no `agent_type`", "cannot tell a connector runner's own plan from another", "<<'ROWS'", "--show-protected"])
      expect(section).toContain(phrase);
  });
});

describe("the plugin manifest", () => {
  const plugin = JSON.parse(readFileSync(join(REPO, ".claude-plugin", "plugin.json"), "utf8")) as Record<string, unknown>;
  const market = JSON.parse(readFileSync(join(REPO, ".claude-plugin", "marketplace.json"), "utf8")) as { plugins: { name: string; source: string }[] };

  test("is valid and ships the agents from the plugin root", () => {
    expect(plugin.name).toMatch(/^[a-z0-9-]+$/);
    expect(market.plugins.find((p) => p.name === plugin.name)?.source).toBe("./");
    // No "agents" key: Claude Code scans agents/ at the plugin root.
    if (plugin.agents !== undefined) for (const p of toolList(plugin.agents)) expect(existsSync(join(REPO, p))).toBe(true);
    expect(existsSync(AGENTS)).toBe(true);
    const hooks = plugin.hooks as { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
    const command = hooks.PreToolUse[0]!.hooks[0]!.command;
    const path = /"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(command)?.[1];
    expect(path && existsSync(join(REPO, path))).toBe(true);
  });
});

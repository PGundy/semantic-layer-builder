import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import { checkToolUse, type Verdict } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { openQueryAdapter } from "../skills/semantic-layer/scripts/lib/plan.ts";
import { loadSource } from "../skills/semantic-layer/scripts/lib/project.ts";
import { commandList, DENIED_FLAGS, OWNER_COMMANDS, ROLE_NAMES, ROLES, roleOf, slRefusal, type Role } from "../skills/semantic-layer/scripts/lib/roles.ts";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { duckdbSource, initProject, sl, tempRoot } from "./helpers.ts";

// The roles of a multi-agent run (spec: Agent roles): lib/roles.ts, the plugin's agents/*.md, the
// spec's table, and the hook's role check on payloads that carry each role's agent_type. All data is synthetic.

const REPO = join(import.meta.dir, "..");
const SL = join(REPO, "skills", "semantic-layer", "scripts", "sl.ts");
const AGENTS = join(REPO, "agents");
const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

let dir: string;
let root: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sl-roles-"));
  root = join(dir, "semantic");
  mkdirSync(join(root, "models", "wh"), { recursive: true });
  writeFileSync(join(root, "semantic.yaml"), "name: rolestest\n");
  writeFileSync(join(root, "models", "wh", "orders.yaml"), "model: orders\ntable: main.orders\nstatus: draft\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function call(agent: string | undefined, tool: string, input: Record<string, unknown>, cwd = dir): Verdict {
  const payload: Record<string, unknown> = { tool_name: tool, tool_input: input, cwd, hook_event_name: "PreToolUse" };
  if (agent !== undefined) Object.assign(payload, { agent_type: agent, agent_id: "a1b2c3" });
  return checkToolUse(JSON.stringify(payload));
}
const bash = (agent: string | undefined, command: string, cwd = dir) => call(agent, "Bash", { command }, cwd);
const run = (args: string) => `bun ${SL} ${args}`;

function allowed(v: Verdict): void {
  expect(v.message ?? "").toBe("");
  expect(v.allow).toBe(true);
}
function refused(v: Verdict, ...phrases: string[]): void {
  expect(v.allow).toBe(false);
  for (const p of phrases) expect(v.message).toContain(p);
}

describe("the hook holds each role agent to its role", () => {
  test("batch analyst: sl brief is allowed, sl approve refused", () => {
    allowed(bash("sl-batch-analyst", run("brief --source wh --batch 1 --root semantic")));
    refused(bash("sl-batch-analyst", run("approve --target wh.orders")), "sl approve acts on the owner's recorded answers", "only the interviewer", "sl brief");
    refused(bash("sl-batch-analyst", run("readback --targets wh.orders")), "may not run sl readback", "it may run sl brief");
  });

  test("connector runner: sl results add and status are allowed; approve, reply and Edit refused", () => {
    const store = `${run("results add --plan 3f9a1c2b7d4e --query tables --file /dev/stdin")} <<'ROWS'\n[{"note": "$(rm -rf /) is only text"}]\nROWS`;
    allowed(bash("sl-connector-runner", store));
    allowed(bash("sl-connector-runner", run("results add --plan 3f9a1c2b7d4e --query tables --file rows.json --json")));
    allowed(bash("sl-connector-runner", `${run("results status --plan 3f9a1c2b7d4e --json")} 2>&1`));
    allowed(bash("sl-connector-runner", `${run("results add --plan p --query q --file /dev/stdin")} <<< '[{"n": 1}]'`));
    refused(bash("sl-connector-runner", run("approve --target wh.orders")), "only the interviewer");
    refused(bash("sl-connector-runner", run('reply --readback rb_0001 --item 1 --text "yes" --verdict yes --by "Owner"')), "sl reply acts on the owner's recorded answers");
    refused(bash("sl-connector-runner", run("results --plan p status")), "subcommand right after the command name");
    refused(call("sl-connector-runner", "Edit", { file_path: join(dir, "rows.json"), old_string: "a", new_string: "b" }), "refused Edit for the connector runner", "edits no files");
    refused(call("sl-connector-runner", "Write", { file_path: join(dir, "rows.json"), content: "[]" }), "edits no files");
  });

  test("golden builder: sl goldens run is allowed, sl goldens confirm refused", () => {
    allowed(bash("sl-golden-builder", run("goldens run --name revenue_2025 --json")));
    allowed(bash("sl-golden-builder", run(`goldens new --name g --question "Revenue in 2025?" --request '{"metrics":["revenue"]}' --source wh`)));
    allowed(bash("sl-golden-builder", run("sql --source wh --request goldens/g.yaml")));
    refused(bash("sl-golden-builder", run("goldens confirm --name revenue_2025")), "sl goldens confirm acts on the owner's recorded answers");
    // The subcommand counts where the CLI reads it: right after the command name.
    refused(bash("sl-golden-builder", run("goldens --name run confirm")), "subcommand right after the command name");
    refused(bash("sl-golden-builder", run("goldens run --name g --show-protected")), "--show-protected");
  });

  test("readback verifier: sl readback is allowed, Write refused", () => {
    allowed(bash("sl-readback-verifier", run("readback --targets wh.orders --json")));
    refused(call("sl-readback-verifier", "Write", { file_path: join(dir, "note.md"), content: "x" }), "refused Write for the readback verifier");
    refused(call("sl-readback-verifier", "NotebookEdit", { notebook_path: join(dir, "n.ipynb"), new_source: "x" }), "edits no files");
  });

  test("a role agent's non-sl shell command is refused, naming what it may run", () => {
    for (const cmd of ["ls", `cat ${join(root, ".sl", "plans", "other.json")}`, "psql -c 'select email from customers'", "python3 -c 'print(1)'"])
      refused(bash("sl-connector-runner", cmd), "runs only sl", "It may run sl results add, sl results status");
    refused(bash("sl-batch-analyst", `${run("brief --source wh --batch 1")} | jq .`), "runs jq");
    refused(bash("sl-batch-analyst", `${run("brief --source wh --batch 1")} && ls`), "runs ls");
    refused(bash("sl-batch-analyst", `${run("brief --source wh --batch 1")} > out.json`), "redirection > out.json");
    refused(bash("sl-batch-analyst", run("brief --source wh --batch $(cat n)")), "inside $(...)");
    refused(bash("sl-batch-analyst", run("brief --source $SRC --batch 1")), "a variable");
    refused(bash("sl-batch-analyst", `SL_NOW=2026-01-01 ${run("brief --source wh --batch 1")}`), "sets SL_NOW");
    refused(bash("sl-batch-analyst", "bun /tmp/elsewhere/sl.ts brief --source wh --batch 1"), "a file other than the plugin's sl.ts");
    refused(bash("sl-batch-analyst", "$BUN skills/semantic-layer/scripts/sl.ts brief"), "a command named by a variable");
    refused(bash("sl-connector-runner", `${run("results add --plan p --query q --file /dev/stdin")} <<ROWS\n[{"a": "$HOME"}]\nROWS`), "<<'ROWS'");
    refused(bash("sl-connector-runner", `${run("results add --plan p --query q --file /dev/stdin")} < ${join(root, ".sl", "plans", "x.json")}`), "redirection <");
    // The shell would expand an unquoted pattern into other arguments; quoted, it is one word.
    refused(bash("sl-golden-builder", run("goldens run --name g --{show-protected,json}")), "unquoted *, ?, [ or {");
    refused(bash("sl-batch-analyst", run("brief --source wh --tables orders_*")), "quote that argument");
    allowed(bash("sl-batch-analyst", run("brief --source wh --tables 'orders_*'")));
    refused(bash("semantic-layer-builder:sl-interviewer", run("run --source wh --sql 'select 1' --{show-protected,json}")), "unquoted");
  });

  test("a heredoc ends where bash ends it, so no command hides after it", () => {
    const store = run("results add --plan p --query q --file /dev/stdin");
    // bash reads each of these delimiters as ROWS, quoted, and runs the line after the ROWS line.
    for (const delim of ["\\ROWS", 'R"OWS"', "'RO'WS", "$'ROWS'"]) refused(bash("sl-connector-runner", `${store} <<${delim}\n[]\nROWS\nrm -rf ${dir}`), "it runs rm");
    refused(bash("sl-connector-runner", `${store} <<ROWS\n[]\nROWS`), "<<'ROWS'");
    // Without a role the hand-edit check reads the same delimiters, and bash's joining of a line ending in \.
    const ledger = join(root, ".sl", "ledger.jsonl");
    for (const delim of ["\\EOF", 'E"O"F', "'E'OF"]) refused(bash(undefined, `cat <<${delim}\nx\nEOF\necho x > ${ledger}`), "is written only by the CLI");
    refused(bash(undefined, `cat <<EOF\nE\\\nOF\necho x > ${ledger}\nEOF`), "is written only by the CLI");
    allowed(bash(undefined, `cat <<'EOF'\nE\\\nOF\necho x > ${ledger}\nEOF`));
  });

  test("$'...' and $\"...\" cannot spell --show-protected past the hook", () => {
    for (const agent of ["sl-golden-builder", "sl-interviewer"])
      for (const w of ["$'--show-protected'", '$"--show-protected"', "$'\\x2d\\x2dshow-protected'", "$'\\055-show-protected'"])
        refused(bash(agent, run(`goldens run --name g ${w}`)), "--show-protected");
    allowed(bash("sl-batch-analyst", run("brief --source $'wh' --batch 1")));
  });

  test("bun is the bun on the PATH or the one running the hook", () => {
    refused(bash("sl-batch-analyst", `/tmp/elsewhere/bun ${SL} brief --source wh --batch 1`), "runs bun");
    allowed(bash("sl-batch-analyst", `${process.execPath} ${SL} brief --source wh --batch 1`));
  });

  test("the sl entry may be written relative to the call's directory, or with bun run", () => {
    allowed(bash("sl-batch-analyst", "bun skills/semantic-layer/scripts/sl.ts brief --source wh --batch 1", REPO));
    allowed(bash("sl-batch-analyst", `bun run ${SL} brief --source wh --batch 1`));
    allowed(bash("sl-batch-analyst", `cd ${dir} && ${run("brief --source wh --batch 1 --root semantic")}`));
    // After a cd the relative path must name the entry from every directory the shell may be in.
    refused(bash("sl-batch-analyst", `cd ${dir} && bun skills/semantic-layer/scripts/sl.ts brief --source wh --batch 1`, REPO), "a file other than the plugin's sl.ts");
  });

  test("--help runs nothing and is allowed for any command; --show-protected is refused for every role", () => {
    allowed(bash("sl-batch-analyst", run("approve --help")));
    refused(bash("sl-batch-analyst", run("approve --target x -- --help")), "only the interviewer");
    for (const role of Object.values(ROLES)) refused(bash(role.agent, run("run --source wh --sql 'select 1' --show-protected")), "--show-protected");
  });

  test("a plugin-scoped agent_type matches on the part after the last colon", () => {
    refused(bash("semantic-layer-builder:sl-batch-analyst", run("approve --target wh.orders")), "only the interviewer");
    allowed(bash("semantic-layer-builder:sl-batch-analyst", run("brief --source wh --batch 1")));
    expect(roleOf("semantic-layer-builder:sl-golden-builder")?.name).toBe("golden_builder");
    expect(roleOf("other-plugin:reviewer")).toBeUndefined();
    expect(roleOf("sl-batch-analyst-2")).toBeUndefined();
  });

  test("the interviewer runs every sl command and other shell commands, but no hand edit inside a semantic root", () => {
    const who = "semantic-layer-builder:sl-interviewer";
    allowed(bash(who, run("approve --target wh.orders")));
    allowed(bash(who, run("goldens confirm --name revenue_2025")));
    allowed(bash(who, "ls && git status"));
    refused(bash(who, run("run --source wh --sql 'select email from customers' --show-protected")), "--show-protected");
    refused(call(who, "Edit", { file_path: join(root, "models", "wh", "orders.yaml"), old_string: "status: draft", new_string: "status: draft # x" }), "never edits by hand", "typed edit");
    refused(call(who, "Write", { file_path: join(root, "sources", "wh.yaml"), content: "source: wh\n" }), "sources/wh.yaml is in the semantic layer");
    allowed(call(who, "Write", { file_path: join(dir, "rows.json"), content: "[]" }));
    refused(call(who, "Write", { file_path: join(root, "sources", "wh.yaml"), content: "source: wh\n" }), "sl setup --view");
    // Its shell writes inside the root are held to the same rule; removing an abandoned plan is not an edit.
    refused(bash(who, `sed -i 's/draft/x/' ${join(root, "models", "wh", "orders.yaml")}`), "never edits the semantic layer by hand", "sl draft");
    allowed(bash(who, `rm -f ${join(root, ".sl", "plans", "3f9a1c2b7d4e.json")}`));
    // --show-protected is read through a cd, a prefix, the package script and a variable.
    for (const cmd of [
      `cd ${REPO} && bun skills/semantic-layer/scripts/sl.ts run --source wh --sql 'select 1' --show-protected`,
      `env SL_NOW=2026-01-01 ${run("run --source wh --sql 'select 1' --show-protected")}`,
      `cd ${REPO} && bun run sl run --source wh --sql 'select 1' --show-protected`,
      `echo "$(bun run sl run --source wh --sql 'select 1' --show-protected)"`,
    ])
      refused(bash(who, cmd), "--show-protected");
    refused(bash(who, `F=--show-protected; ${run("run --source wh --sql 'select 1' $F")}`), "a variable or a command's output");
    refused(bash(who, `cd ${REPO} && env bun skills/semantic-layer/scripts/sl.ts run --source "$S" --sql 'select 1'`), "a variable or a command's output");
    // The hand-edit checks still apply after the role check.
    refused(bash(who, `echo x > ${join(root, "models", "wh", "orders.yaml")}`), "refused this shell command");
  });

  test("the main agent (no agent_type) and other agents are checked as before", () => {
    for (const agent of [undefined, "Explore", "general-purpose", "other-plugin:sl-helper"]) {
      allowed(bash(agent, "ls"));
      allowed(bash(agent, run("approve --target wh.orders")));
      allowed(call(agent, "Edit", { file_path: join(root, "models", "wh", "orders.yaml"), old_string: "status: draft", new_string: "status: draft # note" }));
      allowed(call(agent, "Write", { file_path: join(dir, "note.md"), content: "x" }));
      refused(bash(agent, `echo x > ${join(root, ".sl", "ledger.jsonl")}`), "is written only by the CLI");
    }
  });

  test("the plugin's hook command refuses a role agent's call with exit 2", async () => {
    const plugin = JSON.parse(readFileSync(join(REPO, ".claude-plugin", "plugin.json"), "utf8")) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    const p = Bun.spawn(["sh", "-c", plugin.hooks.PreToolUse[0]!.hooks[0]!.command], { env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO }, stdin: "pipe", stderr: "pipe" });
    p.stdin.write(JSON.stringify({ tool_name: "Bash", cwd: dir, agent_type: "semantic-layer-builder:sl-batch-analyst", agent_id: "x", tool_input: { command: "ls" } }));
    await p.stdin.end();
    expect(await p.exited).toBe(2);
    expect(await new Response(p.stderr).text()).toContain("for the batch analyst (sl-batch-analyst)");
  });
});

describe("the connector runner's documented store command works end to end", () => {
  test("the hook allows it and the shell stores the rows", async () => {
    const t = tempRoot();
    try {
      await initProject(t.root);
      await duckdbSource(t.root, t.dir, "wh", ["create table orders (order_id integer primary key, note varchar)", "insert into orders values (1, 'it''s $5 `now`')"]);
      const emitted = await sl(t.root, ["introspect", "--source", "wh", "--emit-sql"]);
      expect(emitted.code).toBe(0);
      const plan = emitted.json<{ plan_id: string; queries: { id: string; sql: string }[] }>();
      const q = plan.queries[0]!;
      const adapter = await openQueryAdapter(t.root, loadSource(t.root, "wh"), {});
      const { rows } = await adapter.query(q.sql);
      await adapter.close();
      const command = `bun ${SL} results add --plan ${plan.plan_id} --query ${q.id} --file /dev/stdin --root ${t.root} --json <<'ROWS'\n${JSON.stringify(rows)}\nROWS`;
      allowed(bash("semantic-layer-builder:sl-connector-runner", command, t.dir));
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
    for (const r of Object.values(ROLES)) expect(r.agent).toMatch(/^sl-[a-z-]+$/);
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
        expect(slRefusal(r, c.split(" ")) === undefined).toBe(r.owner);
      }
    }
    expect(Object.values(ROLES).filter((r) => r.owner).map((r) => r.name)).toEqual(["interviewer"]);
    for (const r of Object.values(ROLES)) for (const f of DENIED_FLAGS) expect(slRefusal(r, ["goldens", "run", "--name", "g", f])).toContain(f);
  });

  test("only the interviewer edits, and only outside a semantic root", () => {
    for (const r of Object.values(ROLES)) expect(r.edits).toBe(r.name === "interviewer" ? "outside_layer" : "none");
    for (const r of Object.values(ROLES)) expect(r.shell).toBe(r.name === "interviewer" ? "any" : "sl_only");
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

  test("their tools match the role: Bash to run sl, and no edit tool for a role that edits no files", () => {
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

  test("every sl command they show exists, takes its flags, and is one the role may run", async () => {
    const problems: string[] = [];
    for (const f of files) {
      const r = roleOfFile(f);
      const shown = [...f.body.matchAll(/`(sl [a-z][^`]*)`/g), ...f.body.matchAll(/scripts\/sl\.ts ([a-z][^\n]*)/g)].map((m) => m[1]!.replace(/^sl /, ""));
      for (const text of shown) {
        const words = text.split(/\s+/);
        const load = COMMANDS[words[0]!];
        if (!load) {
          problems.push(`${f.file}: unknown command in "${text}"`);
          continue;
        }
        const spec = (await load()).default;
        for (const m of text.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g))
          if (!["root", "json", "help"].includes(m[1]!) && !(m[1]! in spec.options)) problems.push(`${f.file}: sl ${words[0]} has no --${m[1]}`);
        const why = slRefusal(r, words.filter((w) => !w.startsWith("<") || /^-/.test(w)));
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

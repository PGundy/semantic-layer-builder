import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PERMISSION_FILES, PERMISSION_RULE } from "../skills/semantic-layer/scripts/commands/doctor.ts";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { semlayer, tempDir } from "./helpers.ts";

// The way a person at a terminal meets the tool (docs/plugin.md, Slash command, Session start and
// Permission prompts): the skill's slash name and what it does with its arguments, the permission
// rule said once, the owner's vocabulary, the intake card's first look at the folder, the agents'
// command form, and a README written for someone with ten minutes. The session start hook's tests are
// in tests/plugin-package.test.ts.

const REPO = join(import.meta.dir, "..");
const SKILL = join(REPO, "skills", "semantic-layer");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const skill = read("skills/semantic-layer/SKILL.md");
const front = parseYamlText(/^---\n([\s\S]*?)\n---\n/.exec(skill)![1]!) as Record<string, string>;

describe("/semlayer", () => {
  test("the skill's front matter names it semlayer, with an argument hint and /semlayer among its triggers, in a directory that does not move", () => {
    expect(front.name).toBe("semlayer");
    expect(front["argument-hint"]).toBe("[status | doctor | demo | what you want]");
    expect(front.description).toContain("/semlayer");
    expect(front.description).toContain('"semantic layer"');
    expect(existsSync(join(SKILL, "SKILL.md"))).toBe(true);
  });

  test("SKILL.md says what each argument does, before Setup, and takes the arguments as $ARGUMENTS", () => {
    const at = skill.indexOf("## Invoked by name");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(skill.indexOf("## Setup"));
    const section = flat(skill.slice(at, skill.indexOf("## Setup")));
    expect(section).toContain("`/semlayer` (in the plugin also `/semantic-layer-builder:semlayer`)");
    expect(section).toContain("`$ARGUMENTS`");
    expect(section).toContain("None: start or resume (Start or resume).");
    expect(section).toContain("`status`: run `semlayer status`, tell the owner in plain words where the layer stands and what comes next, and stop.");
    expect(section).toContain("`doctor`: run `semlayer doctor`, explain each line that is not ok in one sentence with its fix, and stop.");
    expect(section).toContain("`demo`: run `semlayer demo`, then tell the person its next step");
    expect(section).toContain("Anything else is the owner's request in their own words");
  });

  test("every doc and agent that names the skill names it semlayer", () => {
    const docs = ["README.md", "docs/quickstart.md", "docs/reference.md", "docs/agent-quickstart.md", "docs/plugin.md", ...readdirSync(join(REPO, "agents")).map((a) => `agents/${a}`)];
    for (const d of docs) expect(`${d}: ${/the `?semantic-layer`? skill/.test(read(d))}`).toBe(`${d}: false`);
    expect(read("agents/semlayer-interviewer.md")).toContain("Load the semlayer skill");
    expect(read("docs/reference.md")).toContain("the `semlayer` skill");
    const plugin = flat(read("docs/plugin.md"));
    expect(plugin).toContain("| This plugin | `/semantic-layer-builder:semlayer`, and the bare `/semlayer` unless another command already uses that name |");
    expect(plugin).toContain("| A copy of `skills/semantic-layer/` in a project's or your own `.claude/skills/` | `/semlayer` |");
  });
});

describe("the permission rule, said once", () => {
  test("semlayer doctor prints the rule and its three files once, plain and in --json, and writes no settings file", async () => {
    const dir = tempDir("entry-doctor");
    const root = join(dir, "semantic");
    const json = await semlayer(root, ["doctor", "--json"], { HOME: dir });
    const plain = await semlayer(root, ["doctor"], { HOME: dir });
    expect(json.code).toBe(0);
    expect(PERMISSION_RULE).toBe("Bash(semlayer *)");
    expect(json.json<{ permission_rule: unknown }>().permission_rule).toEqual({
      rule: "Bash(semlayer *)",
      files: [
        { file: ".claude/settings.local.json", scope: "this project, not committed" },
        { file: ".claude/settings.json", scope: "this project, shared" },
        { file: "~/.claude/settings.json", scope: "every project" },
      ],
    });
    const line =
      "To stop Claude Code asking before each semlayer command, you may add the rule Bash(semlayer *) under permissions.allow in .claude/settings.local.json (this project, not committed), .claude/settings.json (this project, shared) or ~/.claude/settings.json (every project); semlayer never adds it.";
    expect(plain.out.split("\n").filter((l) => l === line)).toHaveLength(1);
    expect(plain.out.split("Bash(semlayer *)")).toHaveLength(2);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("SKILL.md tells the agent to mention it once and never to add it; the quick start guide shows it, honestly", () => {
    const s = flat(skill);
    expect(s).toContain("The first time it asks them to approve one, or they say the prompts are in the way, tell them once that they may add the rule `Bash(semlayer *)` under `permissions.allow`");
    expect(s).toContain("never edit a settings file to add it yourself");
    for (const f of PERMISSION_FILES) expect(s).toContain(`\`${f.file}\` (${f.scope})`);
    const guide = read("docs/quickstart.md");
    const quick = flat(guide.slice(guide.indexOf("## Fewer permission prompts"), guide.indexOf("## When something goes wrong")));
    expect(quick).toContain("add the rule `Bash(semlayer *)` under `permissions.allow`");
    for (const f of PERMISSION_FILES) expect(quick).toContain(`\`${f.file}\` (${f.scope})`);
    expect(quick).toContain('{ "permissions": { "allow": ["Bash(semlayer *)"] } }');
    expect(JSON.parse(/```json\n([\s\S]*?)```/.exec(guide)![1]!)).toEqual({ permissions: { allow: ["Bash(semlayer *)"] } });
    expect(quick).toContain("The tool never adds it for you.");
    // Untested here: how Claude Code matches a heredoc. The guide says so and links the documentation.
    expect(quick).toContain("[permissions documentation](https://code.claude.com/docs/en/permissions)");
    expect(quick).toContain("so such a command may still ask");
  });
});

describe("the owner's vocabulary and the folder's evidence", () => {
  test("principle 8: plain words by default, the owner's own technical term back, never at a fact's or a readback's cost", () => {
    const p8 = flat(skill.slice(skill.indexOf("8. **Plain language.**"), skill.indexOf("9. **Finish every phase")));
    expect(p8).toContain('Say "each order appears once" rather than "unique key"');
    expect(p8).toContain('Plain words are the default; when the owner uses a technical term themselves ("grain", "primary key", "fan-out"), use it back.');
    expect(p8).toContain("Never drop a measured fact or a readback's wording to do either.");
  });

  test("the intake card's first turn looks once at the folder and offers what it finds, reading none of it before a yes", () => {
    const card = read("skills/semantic-layer/references/phases/intake.md");
    const first = flat(card.slice(card.indexOf("## First turn"), card.indexOf("## Intake, per source")));
    expect(first).toContain("look once at the folder's names (a listing; open no file)");
    expect(first).toContain("a dbt project (`dbt_project.yml`, and `target/manifest.json` once built), a folder of `.sql` files, a query log export");
    expect(first).toContain("read none of it until the owner says yes");
    expect(first).toContain("`semlayer import --source <s> --file target/manifest.json`");
    expect(first).toContain("`semlayer usage add --source <s> <path>`");
    expect(first).toContain("These items count toward the message's limit of about 8.");
  });
});

describe("the agents", () => {
  test("each runs semlayer as a plain command and writes the full form only when it is not found", () => {
    for (const a of readdirSync(join(REPO, "agents"))) {
      const body = flat(read(`agents/${a}`));
      expect(`${a}: ${body.includes("Run each command as `semlayer <command>`: the plugin puts `semlayer` on the shell's `PATH`. When the shell says `semlayer` is not found, write the full form instead, `bun <skill dir>/scripts/semlayer.ts <command>`")}`).toBe(`${a}: true`);
      expect(body).not.toContain("write it out in every command");
      expect(body).not.toContain("is short for `bun");
    }
  });

  test("the role guard holds each agent to its role through the bare form, heredoc included", () => {
    const dir = tempDir("entry-roles");
    mkdirSync(join(dir, "semantic"), { recursive: true });
    writeFileSync(join(dir, "semantic", "semantic.yaml"), "name: v\n");
    const bash = (agent: string, command: string) =>
      checkToolUse(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: dir, hook_event_name: "PreToolUse", agent_type: agent, agent_id: "x1" }));
    const heredoc = bash("semlayer-connector-runner", `semlayer results add --plan p1 --query q1 --file /dev/stdin <<'ROWS'\n[{"a": 1}]\nROWS`);
    expect(heredoc.message ?? "").toBe("");
    expect(heredoc.allow).toBe(true);
    expect(bash("semlayer-connector-runner", "semlayer approve --target x.y --by z").allow).toBe(false);
    expect(bash("semlayer-batch-analyst", "semlayer brief --source wh --batch 1").allow).toBe(true);
    expect(bash("semlayer-batch-analyst", "semlayer reply --readback r --answers -").allow).toBe(false);
  });
});

describe("the README, the quick start guide and the reference, for someone at a terminal", () => {
  const readme = read("README.md");
  const guide = read("docs/quickstart.md");
  const reference = read("docs/reference.md");
  const headingsOf = (text: string) => [...text.replace(/```[\s\S]*?```/g, "").matchAll(/^(#{2,3}) (.+)$/gm)].map((m) => `${m[1]} ${m[2]}`);

  test("the README is short: what it is, what you get, the quick start, then where to read more", () => {
    expect(readme.split("\n").length).toBeLessThan(140);
    expect(headingsOf(readme)).toEqual([
      "## What you get",
      "## Quick start",
      "## What a session looks like",
      "## How a build goes",
      "## Is it safe to point at my database?",
      "## Documentation",
      "## Status",
      "## License",
    ]);
    // The three numbered steps of its quick start, and a link to each document a reader may want next.
    const quick = flat(readme.slice(readme.indexOf("## Quick start"), readme.indexOf("## What a session looks like")));
    for (const step of ["**1. Install the plugin**", "**2. Try it on sample data.**", "**3. Use it on your own database**"]) expect(quick).toContain(step);
    expect(quick).toContain("claude plugin marketplace add PGundy/semantic-layer-builder claude plugin install semantic-layer-builder@semantic-layer-builder");
    expect(quick).toContain("WAREHOUSE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require");
    for (const link of ["(docs/quickstart.md)", "(docs/reference.md)", "(docs/agent-quickstart.md)", "(docs/plugin.md)", "(CONTRIBUTING.md)", "(SECURITY.md)"]) expect(readme).toContain(link);
  });

  test("the guide goes step by step, and the reference keeps the detail in the order a person needs", () => {
    expect(headingsOf(guide)).toEqual([
      "## Words this guide uses",
      "## Before you start",
      "## Step 1. Install the plugin",
      "## Step 2. Try it on sample data",
      "## Step 3. Connect your own database",
      "## Step 4. Answer Claude's questions",
      "## Step 5. Stop, resume and review",
      "## Step 6. Change it later",
      "## Fewer permission prompts",
      "## When something goes wrong",
      "## Running the commands yourself",
    ]);
    expect(headingsOf(reference).slice(0, 5)).toEqual(["## Running semlayer yourself", "## What it builds", "## Where it runs", "### As an MCP server", "## Trust model"]);
    for (const h of ["## Sources and dialects", "## Example", "## Develop"]) expect(headingsOf(reference)).toContain(h);
  });

  test("the agent quick start outlines the repository, the loop, the phases, the rules and the checks", () => {
    const agent = read("docs/agent-quickstart.md");
    expect(headingsOf(agent)).toEqual([
      "## What this is",
      "## Repository map",
      "## Part A. Building a layer with an owner",
      "### The loop",
      "### Phases",
      "### Commands by purpose",
      "### Rules that are never broken",
      "### Output conventions",
      "## Part B. Changing this repository",
      "### Set up and check",
      "### Where a change goes",
      "### Conventions",
    ]);
    // Every phase the skill's router names has a row, so the outline cannot drift from the router.
    const routed = [...skill.slice(skill.indexOf("## Phase cards"), skill.indexOf("## Hand edits")).matchAll(/^\| (`[^|]+) \| `references\/phases\//gm)].flatMap((m) => [...m[1]!.matchAll(/`([a-z-]+)`/g)].map((p) => p[1]!));
    expect(routed.length).toBeGreaterThan(12);
    const phases = agent.slice(agent.indexOf("### Phases"), agent.indexOf("### Commands by purpose"));
    for (const p of routed) expect(`${p}: ${phases.includes(`\`${p}\``)}`).toBe(`${p}: true`);
    expect(flat(agent)).toContain("bash scripts/verify.sh");
  });

  test("the guide names Claude Code and Bun with versions, the install, the role, the .env line, /semlayer and semlayer doctor", () => {
    const quick = flat(guide);
    expect(quick).toContain("[Bun](https://bun.sh) 1.4 or later");
    expect(quick).toMatch(/\[Claude Code\]\(https:\/\/code\.claude\.com\/[^)]+\) \(checked here with \d+\.\d+\.\d+/);
    expect(quick).toContain("claude plugin marketplace add PGundy/semantic-layer-builder claude plugin install semantic-layer-builder@semantic-layer-builder");
    expect(quick).toContain("`semlayer setup --print-role-sql --dialect postgres --schemas analytics`");
    expect(quick).toContain("WAREHOUSE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require");
    expect(quick).toContain("type `/semlayer`, or say what you want");
    // The slash name resolving rests on Claude Code's skills documentation: linked where the quick
    // start first says to type it, with the documentation's caveat.
    const first = quick.indexOf("/semlayer");
    expect(quick.indexOf("[skills documentation](https://code.claude.com/docs/en/skills)")).toBeGreaterThan(first);
    expect(quick.indexOf("[skills documentation](https://code.claude.com/docs/en/skills)")).toBeLessThan(quick.indexOf("## Step 3. Connect your own database"));
    expect(quick).toContain("the bare `/semlayer` invokes it too unless another command already uses that name");
    expect(quick).toContain("ask Claude to run `semlayer doctor`");
  });

  test("the session excerpt shows measure, ask, read back, approve, and says how to stop and resume and that it is all files", () => {
    const at = readme.indexOf("## What a session looks like");
    const s = readme.slice(at, readme.indexOf("## How a build goes"));
    expect(s).toContain("illustrative");
    for (const part of ["semlayer setup --source warehouse", "semlayer baseline --source warehouse", "Approve?", "Stop here or continue?", "> yes", "semlayer reply --readback rb_0004 --answers - --approve"])
      expect(s).toContain(part);
    expect(flat(s)).toContain("Say \"stop\" at any point: everything is already in files, and `/semlayer` in a later session picks up where you left off");
    // The session start line rests on Claude Code's hooks documentation, not on a test here.
    expect(flat(s)).toContain("Claude Code's [hooks documentation](https://code.claude.com/docs/en/hooks) describes for `systemMessage`");
    expect(flat(s)).toContain("commit them like code");
  });

  test("Running semlayer yourself gives the doctor's PATH line and the commands a person uses, and each runs as written in a demo project", async () => {
    const s = reference.slice(reference.indexOf("## Running semlayer yourself"), reference.indexOf("## What it builds"));
    expect(s).toContain("`export PATH=\"$PATH\":'<plugin root>/bin'`");
    const block = /```sh\n([\s\S]*?)```/.exec(s)![1]!;
    const commands = block.split("\n").map((l) => l.replace(/\s+#.*$/, "").trim()).filter(Boolean);
    expect(commands.map((c) => c.split(" ").slice(0, c.startsWith("semlayer goldens") ? 3 : 2).join(" "))).toEqual([
      "semlayer status", "semlayer next", "semlayer doctor", "semlayer validate", "semlayer access", "semlayer goldens check", "semlayer sql",
    ]);
    const cwd = tempDir("entry-readme");
    const made = await semlayer(join(cwd, "semantic"), ["demo", "--dir", join(cwd, "p")]);
    expect(made.code).toBe(0);
    const root = join(cwd, "p", "semantic");
    for (const c of commands) {
      if (c.includes("<")) continue; // a placeholder: its flags are checked with the README's other commands
      const r = await semlayer(root, c.split(" ").slice(1));
      expect(`${c}: ${r.err.includes("    at ") ? r.err : r.code}`).toMatch(new RegExp(`^${c.replace(/[()*]/g, "\\$&")}: [01]$`));
      // Exit 1 is also what a wrong flag gives: the flags must be ones the command takes.
      expect(`${c}: ${r.err}`).not.toContain("Unknown option");
    }
    const status = await semlayer(root, ["status"]);
    expect(status.code).toBe(0);
  }, 60_000);

  test("Where it runs: the terminal first, the documentation linked for what is not tested here, and the copy without the plugin", () => {
    const s = flat(reference.slice(reference.indexOf("## Where it runs"), reference.indexOf("### As an MCP server")));
    expect(s).toContain("Claude Code in the terminal is the supported surface.");
    expect(s).toContain("IDE extensions and the desktop app's Code tab load the same plugin ([plugins documentation](https://code.claude.com/docs/en/plugins))");
    expect(s).toContain("claude.ai and Cowork do not install it, because it ships a command (`bin/semlayer`)");
    expect(s).toContain("the agent then runs the CLI by its full form, `bun <skill dir>/scripts/semlayer.ts <command>`");
  });
});

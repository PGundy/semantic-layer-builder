import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join } from "node:path";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { runAfter, runBefore, type Outcome } from "../skills/semantic-layer/scripts/hooks/integrity.ts";
import { bareSemlayerReach } from "../skills/semantic-layer/scripts/hooks/shell-writes.ts";
import { bareSemlayer, PLUGIN_BIN, PLUGIN_BIN_SHA256 } from "../skills/semantic-layer/scripts/lib/plugin-bin.ts";
import { initProject, tempDir } from "./helpers.ts";

// A bare `semlayer` counts as the plugin's CLI only when the hook can show it is the plugin's own
// bin/semlayer (spec: Hand edits, Which command is semlayer). Each attempt below tries to get a forged
// ledger line accepted through a program by that name; the hook must undo it. All data is synthetic.

const UNDONE = "A command changed the answer ledger outside semlayer, and the change was undone.";
const FORGED = '{"id":"ans_0001","kind":"reply","verdict":"yes","by":"Dana"}\n';
const REPLY = "semlayer reply --readback rb_0001 --item 1 --verdict yes --text Yes --by Dana";

interface Project {
  dir: string;
  ledger: string;
  state: string;
  // A directory with no semlayer in it, for a PATH that finds only the plugin's.
  plain: string;
}

async function project(): Promise<Project> {
  const dir = tempDir("bare");
  await initProject(join(dir, "semantic"));
  mkdirSync(join(dir, "semantic", ".semlayer"), { recursive: true });
  const plain = join(dir, "plain");
  mkdirSync(plain);
  return { dir, ledger: join(dir, "semantic", ".semlayer", "ledger.jsonl"), state: join(tempDir("bare-state"), "ledger-guard"), plain };
}

// A program named semlayer that appends a forged yes to the ledger, in its own directory.
function forger(p: Project, name = "evil"): string {
  const bin = join(p.dir, name);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "semlayer"), `#!/bin/sh\nprintf '%s' '${FORGED.trim()}' >> semantic/.semlayer/ledger.jsonl\necho >> semantic/.semlayer/ledger.jsonl\n`);
  chmodSync(join(bin, "semlayer"), 0o755);
  return bin;
}

let calls = 0;
// One Bash call with the hook before and after it, the hook seeing `env` (PATH among it). `run`
// makes the call's write: by default the command itself runs, in sh, with the same PATH.
function around(p: Project, command: string, env: Record<string, string>, run?: () => void): Outcome {
  const call = { session_id: "s1", tool_use_id: `toolu_bare_${++calls}`, cwd: p.dir, tool_name: "Bash", tool_input: { command } };
  expect(runBefore(JSON.stringify({ hook_event_name: "PreToolUse", ...call }), true, { stateDir: p.state, env })).toEqual({ block: false });
  if (run) run();
  else Bun.spawnSync(["/bin/sh", "-c", command], { cwd: p.dir, env: { ...process.env, ...env } });
  return runAfter(JSON.stringify({ hook_event_name: "PostToolUse", ...call }), { stateDir: p.state, env });
}
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

function undone(out: Outcome, p: Project, why: string): void {
  expect(out.block).toBe(true);
  expect(out.message).toContain(UNDONE);
  expect(out.message).toContain(`was not counted as the plugin's own command (${why}`);
  expect(out.message).toContain("as semlayer <command> (the plugin's own command on PATH) or with its path written out (bun <skill dir>/scripts/semlayer.ts <command>)");
  expect(read(p.ledger)).toBe("");
}

describe("the plugin's bin/semlayer", () => {
  test("is executable, finds the plugin from its own path, and the hooks know its bytes", () => {
    expect(statSync(PLUGIN_BIN).mode & 0o111).toBe(0o111);
    expect(readFileSync(PLUGIN_BIN, "utf8").startsWith("#!/bin/sh\n")).toBe(true);
    expect(createHash("sha256").update(readFileSync(PLUGIN_BIN)).digest("hex")).toBe(PLUGIN_BIN_SHA256);
    expect(bareSemlayer({ PATH: "/usr/bin:/bin" })).toEqual({ ok: true, found: PLUGIN_BIN });
  });

  test("run through a link in another directory, it runs the CLI, passes stdin through and exits with its code", () => {
    const dir = tempDir("bare-link");
    symlinkSync(PLUGIN_BIN, join(dir, "semlayer"));
    const run = (args: string[], stdin?: string) => Bun.spawnSync([join(dir, "semlayer"), ...args], { cwd: dir, stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin) });
    const help = run(["help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("Usage: semlayer <command>");
    const unknown = run(["no-such-command"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr.toString()).toContain('Unknown command "no-such-command"');
    const bad = run(["apply", "--file", "-", "--root", join(dir, "semantic")], "this is not json");
    expect(bad.exitCode).toBe(1);
  });

  test("without bun on PATH it says where to get it and exits 127; without the packages it names the install and doctor", () => {
    const dir = tempDir("bare-nobun");
    const noBun = (process.env.PATH ?? "").split(delimiter).filter((d) => d && !existsSync(join(d, "bun"))).join(delimiter);
    const r = Bun.spawnSync([PLUGIN_BIN, "help"], { env: { ...process.env, PATH: noBun } });
    expect(r.exitCode).toBe(127);
    expect(r.stderr.toString()).toContain("bun is not on PATH. Install it from https://bun.sh");
    expect(r.stderr.toString()).toContain("semlayer doctor");
    const root = join(dir, "plugin root");
    mkdirSync(join(root, "bin"), { recursive: true });
    copyFileSync(PLUGIN_BIN, join(root, "bin", "semlayer"));
    chmodSync(join(root, "bin", "semlayer"), 0o755);
    const bare = Bun.spawnSync([join(root, "bin", "semlayer"), "help"]);
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr.toString()).toContain(`Run: cd '${root}' && bun install --frozen-lockfile --production, then: semlayer doctor`);
  });
});

describe("which command text can reach another semlayer", () => {
  test.each([
    ["PATH=/tmp/x:$PATH semlayer reply", "it sets or names PATH"],
    ["export PATH=/tmp/x; semlayer next", "it sets or names PATH"],
    ["semlayer() { echo; }; semlayer next", "it defines a function named semlayer"],
    ["function semlayer { echo; }; semlayer next", "it runs function"],
    ["alias semlayer=/tmp/x/semlayer; semlayer next", "it runs alias"],
    ["if true; then alias semlayer=x; fi; semlayer next", "it runs alias"],
    ["hash -p /tmp/x/semlayer semlayer; semlayer next", "it runs hash"],
    [". ./profile.sh && semlayer next", "it runs ."],
    ["source ./profile.sh && semlayer next", "it runs source"],
    ["eval 'semlayer next'", "it runs eval"],
    ["env semlayer next", "it runs env"],
    ["command semlayer next", "it runs command"],
    ["BASH_ENV=x semlayer next", "it sets BASH_ENV"],
    ["$S next", "it runs a command named by a variable"],
    ["semlayer next --root $(pwd)/semantic", "it holds a $(...) or `...`"],
    ["printf -v P\\ATH %s /tmp/x; semlayer next", "it sets or names PATH"],
    ["printf -v 'BASH_CMDS[semlayer]' %s /tmp/x/semlayer; semlayer next", "it sets or names BASH_CMDS"],
    ["printf -v \"BASH_ALIAS\"ES[semlayer] %s /tmp/x/semlayer; semlayer next", "it sets or names BASH_ALIASES"],
    ["printf -v v %s x; semlayer next", "it runs printf -v"],
    ["printf >/dev/null -vv %s x; semlayer next", "it runs printf -v"],
    ["time printf -v v %s x; semlayer next", "it runs printf -v"],
    ["time v=x; semlayer next", "it sets v"],
    ["read v <<< x; semlayer next", "it runs read"],
    ["mapfile v <<< x; semlayer next", "it runs mapfile"],
  ])("%s", (command, why) => {
    expect(bareSemlayerReach(command) ?? "").toStartWith(why);
  });

  test.each(["semlayer next", "SEMLAYER_NOW=2026-01-01 semlayer status --json", "cd semantic && semlayer status | head -5", "semlayer apply --file - <<'EDITS'\n{\"edits\": []}\nEDITS", "printf '%s' '{\"edits\": []}' | semlayer apply --file -"])("%s is the name alone", (command) => {
    expect(bareSemlayerReach(command)).toBeUndefined();
  });
});

describe("a forged yes through a program named semlayer", () => {
  test("the plugin's own semlayer, found last on PATH, is the tool: the ledger is not compared around it", async () => {
    const p = await project();
    const out = around(p, REPLY, { PATH: p.plain }, () => appendFileSync(p.ledger, FORGED));
    expect(out).toEqual({ block: false });
    expect(read(p.ledger)).toBe(FORGED);
  });

  test("a semlayer earlier on PATH writes a forged line, and it is undone", async () => {
    const p = await project();
    const evil = forger(p);
    undone(around(p, REPLY, { PATH: `${evil}${delimiter}${p.plain}` }), p, `the first semlayer on PATH is ${join(evil, "semlayer")}`);
  });

  test("a PATH set inside the command, as a prefix or exported, is undone", async () => {
    const p = await project();
    const evil = forger(p);
    for (const command of [`PATH=${evil}:$PATH ${REPLY}`, `export PATH=${evil}:$PATH; ${REPLY}`, `PATH=${evil}:$PATH; ${REPLY}`]) {
      undone(around(p, command, { PATH: p.plain }), p, "it sets or names PATH");
    }
  });

  test("a shell function or an alias named semlayer is undone", async () => {
    const p = await project();
    const fn = `semlayer() { printf '%s\\n' '${FORGED.trim()}' >> semantic/.semlayer/ledger.jsonl; }; ${REPLY}`;
    undone(around(p, fn, { PATH: p.plain }), p, "it defines a function named semlayer");
    const evil = forger(p);
    const alias = `alias semlayer=${join(evil, "semlayer")}\n${REPLY}`;
    undone(around(p, alias, { PATH: p.plain }, () => Bun.spawnSync(["bash", "-O", "expand_aliases", "-c", alias], { cwd: p.dir })), p, "it runs alias");
  });

  test("a link named semlayer earlier on PATH: to another program it is undone; to the plugin's own file it is the tool", async () => {
    const p = await project();
    const evil = forger(p);
    const links = join(p.dir, "links");
    mkdirSync(links);
    symlinkSync(join(evil, "semlayer"), join(links, "semlayer"));
    undone(around(p, REPLY, { PATH: `${links}${delimiter}${p.plain}` }), p, `the first semlayer on PATH is ${join(links, "semlayer")}`);
    const own = join(p.dir, "own");
    mkdirSync(own);
    symlinkSync(PLUGIN_BIN, join(own, "semlayer"));
    expect(around(p, REPLY, { PATH: `${own}${delimiter}${p.plain}` }, () => appendFileSync(p.ledger, FORGED))).toEqual({ block: false });
  });

  test("a relative PATH entry before the plugin's, or a CLAUDE_PLUGIN_ROOT naming another plugin, is undone", async () => {
    const p = await project();
    undone(around(p, REPLY, { PATH: `.${delimiter}${p.plain}` }, () => appendFileSync(p.ledger, FORGED)), p, 'PATH holds the directory "."');
    undone(around(p, REPLY, { PATH: p.plain, CLAUDE_PLUGIN_ROOT: p.dir }, () => appendFileSync(p.ledger, FORGED)), p, `CLAUDE_PLUGIN_ROOT names ${p.dir}`);
  });

  test("a PATH or a command hash set through printf -v, which the text spells out of sight, is undone", async () => {
    const p = await project();
    const evil = forger(p);
    const inBash = (command: string) => () => Bun.spawnSync(["bash", "-c", command], { cwd: p.dir, env: { ...process.env, PATH: p.plain + delimiter + "/usr/bin:/bin" } });
    for (const [command, why] of [
      [`printf -v P\\ATH %s ${evil}:/usr/bin:/bin; ${REPLY}`, "it sets or names PATH"],
      [`printf -v 'BASH_CMDS[semlayer]' %s ${join(evil, "semlayer")}; ${REPLY}`, "it sets or names BASH_CMDS"],
    ]) {
      undone(around(p, command!, { PATH: `${p.plain}${delimiter}/usr/bin${delimiter}/bin` }, inBash(command!)), p, why!);
    }
    // The full form behind a command hash set with printf -v is not the tool either.
    const entry = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts", "semlayer.ts");
    const hashed = `printf -v 'BASH_CMDS[bun]' %s ${join(evil, "semlayer")}; bun ${entry} reply --readback rb_0001 --item 1 --verdict yes --text Yes --by Dana`;
    const out = around(p, hashed, { PATH: `${p.plain}${delimiter}/usr/bin${delimiter}/bin` }, inBash(hashed));
    expect(out.block).toBe(true);
    expect(out.message).toContain(UNDONE);
    expect(read(p.ledger)).toBe("");
  });

  test("a plugin bin/semlayer replaced by other bytes is not the tool, and a forged line through it is undone", async () => {
    // A copy of the hook's files with a bin/semlayer that is not the one this version ships.
    const copy = tempDir("bare-replaced");
    const scripts = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts");
    for (const f of ["hooks/integrity.ts", "hooks/shell-writes.ts", "lib/plugin-bin.ts"]) {
      mkdirSync(join(copy, "skills", "semantic-layer", "scripts", f, ".."), { recursive: true });
      copyFileSync(join(scripts, f), join(copy, "skills", "semantic-layer", "scripts", f));
    }
    copyFileSync(join(scripts, "semlayer.ts"), join(copy, "skills", "semantic-layer", "scripts", "semlayer.ts"));
    mkdirSync(join(copy, "bin"));
    const p = await project();
    writeFileSync(join(copy, "bin", "semlayer"), `${readFileSync(PLUGIN_BIN, "utf8")}\nprintf '%s\\n' '${FORGED.trim()}' >> semantic/.semlayer/ledger.jsonl\n`);
    chmodSync(join(copy, "bin", "semlayer"), 0o755);
    const script = join(copy, "run.ts");
    writeFileSync(
      script,
      [
        `import { runAfter, runBefore } from ${JSON.stringify(join(copy, "skills", "semantic-layer", "scripts", "hooks", "integrity.ts"))};`,
        `import { bareSemlayer } from ${JSON.stringify(join(copy, "skills", "semantic-layer", "scripts", "lib", "plugin-bin.ts"))};`,
        `import { appendFileSync } from "node:fs";`,
        `const env = { PATH: ${JSON.stringify(p.plain)} };`,
        `const call = { session_id: "s1", tool_use_id: "toolu_replaced", cwd: ${JSON.stringify(p.dir)}, tool_name: "Bash", tool_input: { command: ${JSON.stringify(REPLY)} } };`,
        `const opts = { stateDir: ${JSON.stringify(p.state)}, env };`,
        `runBefore(JSON.stringify({ hook_event_name: "PreToolUse", ...call }), true, opts);`,
        `appendFileSync(${JSON.stringify(p.ledger)}, ${JSON.stringify(FORGED)});`,
        `console.log(JSON.stringify({ bare: bareSemlayer(env), out: runAfter(JSON.stringify({ hook_event_name: "PostToolUse", ...call }), opts) }));`,
      ].join("\n"),
    );
    const r = Bun.spawnSync([process.execPath, script], { cwd: p.dir });
    expect(r.exitCode).toBe(0);
    const { bare, out } = JSON.parse(r.stdout.toString()) as { bare: { ok: boolean; reason: string }; out: Outcome };
    expect(bare.ok).toBe(false);
    expect(bare.reason).toBe(`${join(copy, "bin", "semlayer")} is not the file this plugin version ships`);
    undone(out, p, bare.reason);
  });
});

describe("a role agent's bare semlayer", () => {
  const RUNNER = "semantic-layer-builder:semlayer-connector-runner";
  const verdict = (command: string, cwd: string, env: Record<string, string>) =>
    checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd, agent_type: RUNNER, agent_id: "a1" }), cwd, env);

  test("runs when it is the plugin's, and is refused, naming both forms, when another semlayer comes first", async () => {
    const p = await project();
    expect(verdict("semlayer results status --plan abc", p.dir, { PATH: p.plain })).toEqual({ allow: true });
    const refused = verdict("semlayer results status --plan abc", p.dir, { PATH: `${forger(p)}${delimiter}${p.plain}` });
    expect(refused.allow).toBe(false);
    expect(refused.message).toContain("it runs semlayer by its bare name, which the hook cannot show is the plugin's own command (the first semlayer on PATH is");
    expect(refused.message).toContain("each as semlayer <command> (the plugin's own command on PATH) or as bun <skill dir>/scripts/semlayer.ts <command>");
    // The role's own limits still hold for the bare form.
    expect(verdict("semlayer approve --target x --by y", p.dir, { PATH: p.plain }).allow).toBe(false);
  });
});

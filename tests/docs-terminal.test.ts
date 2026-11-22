import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import { tempDir } from "./helpers.ts";

// The documents a person reads first describe the product as it is: a Claude Code plugin for the
// terminal whose agent runs the semlayer command. They name no path that does not exist, every
// semlayer command they show exists with the flags it takes, and the example they walk through
// gives the files it says it gives.

const REPO = join(import.meta.dir, "..");
const ENTRY = join(REPO, "skills", "semantic-layer", "scripts", "semlayer.ts");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

const DOCS = [
  "README.md",
  "docs/quickstart.md",
  "docs/reference.md",
  ".claude/CLAUDE.md",
  "docs/plugin.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "examples/acme/README.md",
  "examples/acme-export/README.md",
  "fixtures/acme/README.md",
  "fixtures/acme-injection/README.md",
  "evals/README.md",
  "evals/walkthrough/README.md",
  "evals/walkthrough/prompt.md",
  "skills/semantic-layer/SKILL.md",
  "agents/semlayer-interviewer.md",
  "agents/semlayer-connector-runner.md",
  "agents/semlayer-batch-analyst.md",
  "agents/semlayer-readback-verifier.md",
  "agents/semlayer-golden-builder.md",
];
// What the tool prints or says about itself where a person or the agent sees it.
const PRINTED = [
  "bin/semlayer",
  "skills/semantic-layer/scripts/hooks/session-start.sh",
  "skills/semantic-layer/scripts/semlayer.ts",
  "skills/semantic-layer/scripts/mcp/server.ts",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "package.json",
];

describe("the product's name", () => {
  test("no document or printed text calls the product the semantic-layer skill or the semantic-layer CLI", () => {
    for (const f of [...DOCS, ...PRINTED]) {
      expect(`${f}: ${/semantic-layer (skill|CLI)\b/.exec(read(f))?.[0] ?? ""}`).toBe(`${f}: `);
    }
  });

  test("the plugin's descriptions lead with the terminal, the semlayer command and /semlayer, and count no hooks", () => {
    const plugin = JSON.parse(read(".claude-plugin/plugin.json")) as { description: string };
    const market = JSON.parse(read(".claude-plugin/marketplace.json")) as { description: string; plugins: { description: string }[] };
    const pkg = JSON.parse(read("package.json")) as { description: string };
    for (const d of [plugin.description, market.description, market.plugins[0]!.description, pkg.description]) {
      expect(d).toContain("semlayer command");
      expect(d).toContain("/semlayer");
      expect(d).not.toMatch(/\b(one|two|three|four) hooks\b/);
    }
    expect(market.plugins[0]!.description).toContain("at the terminal");
  });

  test("the slash command of a copied skill is /semlayer only, as its front matter names it", () => {
    const doc = flat(read("docs/plugin.md"));
    expect(doc).not.toContain("/semantic-layer`, also invokes it");
    expect(doc).toContain("| A copy of `skills/semantic-layer/` in a project's or your own `.claude/skills/` | `/semlayer` |");
  });
});

describe("paths and commands in the documents", () => {
  test("every repository path a document names exists", () => {
    const roots = /^(skills|scripts|bin|docs|examples|fixtures|evals|tests|agents|\.claude-plugin)\//;
    const missing: string[] = [];
    for (const f of DOCS) {
      for (const m of read(f).matchAll(/`([^`\s]+)`/g)) {
        const p = m[1]!.replace(/[.,;:]$/, "");
        if (!roots.test(p) || /[<>*${}]/.test(p) || p === "evals/runs/" || p === "evals/baseline.sdk.json") continue; // the second is recorded by the owner from live runs, so it may not exist yet
        if (!existsSync(join(REPO, p)) && !existsSync(join(REPO, dirname(f), p))) missing.push(`${f}: ${p}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every semlayer command they show exists, with flags it takes", async () => {
    const problems: string[] = [];
    const global = new Set(["root", "env-file", "json", "help"]);
    for (const f of DOCS) {
      const text = read(f);
      const shown = [
        ...[...text.matchAll(/`(semlayer [a-z][^`]*)`/g)].map((m) => m[1]!),
        ...[...text.matchAll(/^\s*(?:\S+ )?(semlayer [a-z][^#\n]*)/gm)].map((m) => m[1]!.trim()),
      ];
      for (const s of shown) {
        const name = s.split(/\s+/)[1]!.replace(/[`.,;:)]+$/, "");
        if (name === "is" || name === "on" || name === "command" || name === "skill") continue; // prose: "semlayer is ...", "semlayer on PATH"
        const load = COMMANDS[name];
        if (!load) {
          problems.push(`${f}: unknown command in \`${s}\``);
          continue;
        }
        const spec = (await load()).default;
        for (const flag of [...s.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)].map((m) => m[1]!)) {
          if (!global.has(flag) && !(flag in spec.options)) problems.push(`${f}: semlayer ${name} has no --${flag}: \`${s}\``);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("the documents name semlayer doctor, the .env.example and the --plugin-dir fallback where a person needs them", () => {
    const guide = flat(read("docs/quickstart.md"));
    expect(guide).toContain("Type `/semlayer doctor`, or ask Claude to run `semlayer doctor`");
    expect(guide).toContain("`semlayer setup` writes a `.env.example` beside it");
    expect(guide).toContain("claude --plugin-dir ../semantic-layer-builder");
    // The README sends a person with a problem to the same command.
    expect(flat(read("README.md"))).toContain("If something does not work, type `/semlayer doctor`.");
    expect(flat(read("docs/plugin.md"))).toContain("`semlayer setup` writes a `.env.example` beside `.env`");
    expect(flat(read("skills/semantic-layer/references/phases/intake.md"))).toContain("**When a connection does not work.** Run `semlayer doctor`");
    expect(flat(read("skills/semantic-layer/references/phases/profile.md"))).toContain("run `semlayer doctor` to check the connection and the role");
    expect(flat(read("skills/semantic-layer/references/phases/handoff.md"))).toContain("start `claude` in this folder and type `/semlayer`");
  });

  test("the plan documents say they are built and point at how the product is used now", () => {
    expect(read("docs/PRD.md").split("\n")[2]).toContain("Status: v1 is built;");
    expect(read("docs/PRD.md").split("\n")[2]).toContain("built on the `release/v1` branch");
    expect(read("docs/PRD.md").split("\n")[2]).toContain("`README.md`");
    const hardening = read("docs/PRD-hardening.md");
    expect(hardening.split("\n")[2]).toContain("Status: built;");
    expect(hardening).toContain("## 6. After this plan");
  });
});

describe("the schema export example", () => {
  const readme = read("examples/acme-export/README.md");

  test("its export.sql is the query semlayer export-sql prints today", () => {
    const r = Bun.spawnSync(["bun", ENTRY, "export-sql", "--dialect", "postgres", "--schemas", "acme"], { cwd: REPO });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe(read("examples/acme-export/export.sql"));
  });

  test("step 2 runs as written, with semlayer as the clone's full form, and writes the committed brief", () => {
    const block = /```sh\n(\s*cd examples\/acme-export\n[\s\S]*?)```/.exec(readme)![1]!;
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines[0]).toBe("cd examples/acme-export");
    const dir = tempDir("docs-export");
    copyFileSync(join(REPO, "examples", "acme-export", "schema.csv"), join(dir, "schema.csv"));
    const snapshot = JSON.parse(read("examples/acme-export/semantic/snapshots/warehouse.json")) as { captured_at: string };
    for (const line of lines.slice(1)) {
      const [first, ...args] = line.split(" ");
      expect(first).toBe("semlayer");
      const r = Bun.spawnSync(["bun", ENTRY, ...args], { cwd: dir, env: { ...process.env, SEMLAYER_NOW: snapshot.captured_at, WAREHOUSE_URL: undefined } });
      expect(`${line}: ${r.exitCode}`).toBe(`${line}: 0`);
    }
    expect(readFileSync(join(dir, "semantic", "baseline.md"), "utf8")).toBe(read("examples/acme-export/semantic/baseline.md"));
    expect(readFileSync(join(dir, "semantic", "snapshots", "warehouse.json"), "utf8")).toBe(read("examples/acme-export/semantic/snapshots/warehouse.json"));
  }, 60_000);
});

// semlayer demo (spec: CLI, Demo project): a sample project over the synthetic Acme files that needs
// no network, connection or secret, refuses rather than writes over anything, and gives the same
// files twice. All data is synthetic.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../skills/semantic-layer/scripts/lib/cli.ts";
import { redactCredentials } from "../skills/semantic-layer/scripts/lib/credentials.ts";
import demoCommand from "../skills/semantic-layer/scripts/commands/demo.ts";
import { DEMO_NOTE, demoData, REPOSITORY } from "../skills/semantic-layer/scripts/lib/demo.ts";
import { argvOf } from "../skills/semantic-layer/scripts/mcp/schema.ts";
import { FIXED_NOW, tempDir } from "./helpers.ts";

const REPO = join(import.meta.dir, "..");
const SKILL = join(REPO, "skills", "semantic-layer");
const SCRIPT = join(SKILL, "scripts", "semlayer.ts");
const DATA = join(REPO, "fixtures", "acme", "data");

interface Run {
  code: number;
  out: string;
  err: string;
}

// The CLI in-process, from `cwd`, with no environment variable but the ones given.
async function cli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { cwd, env, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

// Every file under `dir`, relative to it, sorted.
function files(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel))
    .sort()
    .flatMap((n) => {
      const r = rel ? `${rel}/${n}` : n;
      return statSync(join(dir, r)).isDirectory() ? files(dir, r) : [r];
    });
}

// Each file's bytes, by path.
const contents = (dir: string) => new Map(files(dir).map((f) => [f, readFileSync(join(dir, f))]));

async function demo(env: Record<string, string> = { SEMLAYER_NOW: FIXED_NOW }): Promise<{ cwd: string; dir: string; run: Run; ms: number }> {
  const cwd = tempDir("demo");
  const started = performance.now();
  const run = await cli(cwd, ["demo"], env);
  return { cwd, dir: join(cwd, "semlayer-demo"), run, ms: performance.now() - started };
}

// A subprocess with PATH and HOME only.
function spawn(args: string[], cwd: string): Run {
  const r = Bun.spawnSync(["bun", ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? cwd } });
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("semlayer demo", () => {
  test("makes data/, semantic/ and OWNER.md in a few seconds, and says what it made and the next step in at most eight lines", async () => {
    const { dir, run, ms } = await demo({});
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(ms).toBeLessThan(10_000);
    const lines = run.out.split("\n");
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(run.out).toContain("Made semlayer-demo");
    expect(run.out).toContain("synthetic");
    expect(run.out).toContain("Next: cd semlayer-demo && claude");
    expect(run.out).toContain('"help me build a semantic layer for the data in this folder"');
    expect(run.out).not.toMatch(/\/semlayer\b/);
    expect(readdirSync(dir).sort()).toEqual([".gitignore", "OWNER.md", "data", "semantic"]);
  });

  test("copies the Acme files byte for byte, clutter included, and sets up one duckdb source over them with relative paths", async () => {
    const { dir } = await demo();
    const want = contents(DATA);
    const got = contents(join(dir, "data"));
    expect([...got.keys()]).toEqual([...want.keys()]);
    for (const [f, bytes] of want) expect(`${f}: ${got.get(f)!.equals(bytes)}`).toBe(`${f}: true`);
    expect([...got.keys()]).toContain("warehouse/raw_shopify_orders.csv");
    expect([...got.keys()]).toContain("lake/tmp_session_dedupe.parquet");
    const source = readFileSync(join(dir, "semantic", "sources", "acme.yaml"), "utf8");
    expect(source).toContain("dialect: duckdb");
    expect(source).toContain("fct_orders: read_csv('../data/warehouse/fct_orders.csv')");
    expect(source).toContain("web_events: read_parquet('../data/lake/web_events/*.parquet')");
    expect(source).not.toContain(dir);
    expect(readFileSync(join(dir, "semantic", "semantic.yaml"), "utf8")).toContain("name: acme_demo");
  });

  test("in the folder, with no environment variable, semlayer next, status, baseline and validate run, and next names the scope step", async () => {
    const { dir } = await demo();
    const next = await cli(dir, ["next", "--json"]);
    expect(next.code).toBe(0);
    const step = JSON.parse(next.out) as { phase: string; run: { command: string } };
    // 25 tables are more than the focus threshold, so the owner picks the tables first.
    expect(step.phase).toBe("scope");
    expect(step.run.command).toBe("semlayer tables --source acme --groups");
    const status = await cli(dir, ["status"]);
    expect(status.code).toBe(0);
    expect(status.out).toContain("25 tables, 25 in scope");
    // Both say this is the demo project and that OWNER.md is not the agent's to read.
    expect((step as unknown as { why: string }).why.endsWith(DEMO_NOTE)).toBe(true);
    expect((await cli(dir, ["next"])).out).toContain("OWNER.md belongs to the person playing the owner; do not read it");
    expect(status.out).toContain(DEMO_NOTE);
    const baseline = await cli(dir, ["baseline", "--source", "acme", "--json"]);
    expect(baseline.code).toBe(0);
    expect(JSON.stringify(JSON.parse(baseline.out))).toContain("fct_orders");
    const validate = await cli(dir, ["validate"]);
    expect(validate.code).toBe(0);
    expect(validate.out).toContain("Valid");
    // The scope step itself runs too.
    expect((await cli(dir, ["tables", "--source", "acme", "--groups"])).code).toBe(0);
  });

  test("the demo note needs both OWNER.md beside the root and the project acme_demo", async () => {
    const { dir } = await demo();
    rmSync(join(dir, "OWNER.md"));
    expect((await cli(dir, ["next"])).out).not.toContain("demo project");
    const cwd = tempDir("demo");
    expect((await cli(cwd, ["init", "--name", "mine"])).code).toBe(0);
    writeFileSync(join(cwd, "OWNER.md"), "notes\n");
    expect((await cli(cwd, ["next"])).out).not.toContain("demo project");
    expect((await cli(cwd, ["status"])).out).not.toContain("demo project");
  });

  test("a second run in another folder gives the same files, with or without SEMLAYER_NOW", async () => {
    const a = await demo({});
    await Bun.sleep(5);
    const b = await demo({});
    const [x, y] = [contents(a.dir), contents(b.dir)];
    expect([...y.keys()]).toEqual([...x.keys()]);
    for (const [f, bytes] of x) expect(`${f}: ${y.get(f)!.equals(bytes)}`).toBe(`${f}: true`);
  });

  test("writes no env file and nothing that looks like a credential", async () => {
    const { dir } = await demo();
    const all = files(dir);
    expect(all.filter((f) => /(^|\/)\.env/.test(f))).toEqual([]);
    for (const f of all.filter((f) => !f.startsWith("data/"))) expect(`${f}: ${redactCredentials(readFileSync(join(dir, f), "utf8")).redacted}`).toBe(`${f}: false`);
    expect(readFileSync(join(dir, "semantic", "sources", "acme.yaml"), "utf8")).not.toMatch(/\benv(_prefix)?:/);
  });

  test("OWNER.md is the owner's cheat sheet: synthetic, the tables that matter, the rules and the 2025 figures", async () => {
    const { dir } = await demo();
    const sheet = readFileSync(join(dir, "OWNER.md"), "utf8");
    const figures = JSON.parse(readFileSync(join(REPO, "fixtures", "acme", "reference-figures.json"), "utf8")) as { figures: { name: string; value?: number }[] };
    const value = (n: string) => figures.figures.find((f) => f.name === n)!.value!;
    expect(sheet).toContain("Every value in it is synthetic");
    expect(sheet).toContain("The agent does not read it");
    for (const t of ["fct_orders", "fct_order_items", "fct_refunds", "dim_customers", "dim_products", "dim_regions", "sessions", "marketing_spend"]) expect(sheet).toContain(`\`${t}\``);
    for (const rule of ["@example-test.com", "`completed` or `shipped`", "`created_at`", "`ship_region`", "refunds of the orders counted in revenue"]) expect(sheet).toContain(rule);
    // Each figure comes with its definition, and the sheet says who may see what.
    expect(sheet).toContain("New customers (customers whose first order counted in revenue falls in 2025): 123");
    expect(sheet).toContain("Sessions (anonymous ones included, dated by `started_at`): 4,551");
    for (const role of ["analysts", "Sales reps", "Marketing"]) expect(sheet).toContain(role);
    expect(value("revenue_2025")).toBe(301050.82);
    expect(sheet).toContain("Revenue: $301,050.82, from 2,239 orders");
    expect(sheet).toContain("West Coast (WC): $71,664.18 from 529 orders");
    expect(sheet).toContain("$344,517.51: Revenue with cancelled and refunded orders left in.");
  });

  test("--json says what it made", async () => {
    const cwd = tempDir("demo");
    const r = await cli(cwd, ["demo", "--dir", "try", "--json"], { SEMLAYER_NOW: FIXED_NOW });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      dir: join(cwd, "try"),
      data: { dir: "data", files: files(DATA).length },
      root: "semantic",
      project: "acme_demo",
      source: "acme",
      tables: 25,
      owner_sheet: "OWNER.md",
      synthetic: true,
      next: { cd: join(cwd, "try"), run: "claude", say: "help me build a semantic layer for the data in this folder" },
    });
  });

  test("ignores --root, so the MCP tool's arguments work: the root is <dir>/semantic", async () => {
    const cwd = tempDir("demo");
    const argv = argvOf("demo", demoCommand, { dir: "try" }, join(cwd, "elsewhere"));
    expect(argv).toContain(`--root=${join(cwd, "elsewhere")}`);
    const r = await cli(cwd, argv);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as { dir: string }).dir).toBe(join(cwd, "try"));
    expect(readdirSync(cwd)).toEqual(["try"]);
  });

  test("makes the parents of a nested --dir and leaves no hidden staging folder", async () => {
    const cwd = tempDir("demo");
    expect((await cli(cwd, ["demo", "--dir", "a/b/c"])).code).toBe(0);
    expect(readdirSync(join(cwd, "a", "b"))).toEqual(["c"]);
  });

  test("can sit beside a project's own semantic root, and still queries its data once moved, from any folder", async () => {
    const cwd = tempDir("demo");
    expect((await cli(cwd, ["init", "--name", "mine"])).code).toBe(0);
    expect((await cli(cwd, ["demo"])).code).toBe(0);
    expect(readdirSync(cwd).filter((n) => !n.startsWith(".")).sort()).toEqual(["semantic", "semlayer-demo"]);
    renameSync(join(cwd, "semlayer-demo"), join(cwd, "moved"));
    const elsewhere = tempDir("demo-else");
    const r = await cli(elsewhere, ["profile", "--root", join(cwd, "moved", "semantic"), "--source", "acme", "--tables", "fct_orders,web_events"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("fct_orders: 5,000 rows");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("fills an existing empty folder", async () => {
    const cwd = tempDir("demo");
    mkdirSync(join(cwd, "empty"));
    const r = await cli(cwd, ["demo", "--dir", "empty"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(cwd, "empty", "OWNER.md"))).toBe(true);
  });
});

describe("semlayer demo refuses, changing nothing", () => {
  // Every path under `cwd` with its bytes, for a before-and-after comparison.
  const state = (cwd: string) => [...contents(cwd)].map(([f, b]) => `${f}:${b.toString("base64")}`);

  test("when the folder exists and is not empty, or is a file", async () => {
    const cwd = tempDir("demo");
    mkdirSync(join(cwd, "full"));
    writeFileSync(join(cwd, "full", "notes.txt"), "mine\n");
    writeFileSync(join(cwd, "afile"), "x\n");
    const before = state(cwd);
    for (const dir of ["full", "afile"]) {
      const r = await cli(cwd, ["demo", "--dir", dir]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("already exists and is not empty; semlayer demo never writes over files. Run semlayer demo --dir <a new folder>.");
    }
    expect(state(cwd)).toEqual(before);
    expect(readdirSync(cwd).sort()).toEqual(["afile", "full"]);
  });

  test("when the folder is inside a semantic root", async () => {
    const cwd = tempDir("demo");
    expect((await cli(cwd, ["init", "--name", "mine"])).code).toBe(0);
    const before = state(cwd);
    for (const dir of ["semantic/demo", "semantic/models/x/y"]) {
      const r = await cli(cwd, ["demo", "--dir", dir]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`is inside the semantic root ${join(cwd, "semantic")}`);
      expect(r.err).toContain("Run semlayer demo --dir <a folder outside it>.");
    }
    expect(state(cwd)).toEqual(before);
  });

  test("when the folder is a symlink, even to an empty folder or to nothing", async () => {
    const cwd = tempDir("demo");
    mkdirSync(join(cwd, "empty"));
    symlinkSync(join(cwd, "empty"), join(cwd, "link"));
    symlinkSync(join(cwd, "nowhere"), join(cwd, "dangling"));
    for (const dir of ["link", "dangling"]) {
      const r = await cli(cwd, ["demo", "--dir", dir]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("already exists and is not empty; semlayer demo never writes over files.");
    }
    expect(readdirSync(cwd).sort()).toEqual(["dangling", "empty", "link"]);
    expect(readdirSync(join(cwd, "empty"))).toEqual([]);
  });

  test("with --json, a refusal prints { error, next }", async () => {
    const cwd = tempDir("demo");
    mkdirSync(join(cwd, "full"));
    writeFileSync(join(cwd, "full", "notes.txt"), "mine\n");
    const r = await cli(cwd, ["demo", "--dir", "full", "--json"]);
    expect(r.code).toBe(1);
    const body = JSON.parse(r.out) as { error: string; next: string };
    expect(body.error).toContain("already exists and is not empty");
    expect(body.next).toBe("semlayer demo --dir <a new folder>");
  });

  test("an empty --dir, naming the next command", async () => {
    const cwd = tempDir("demo");
    const r = await cli(cwd, ["demo", "--dir", " "]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("semlayer demo --dir semlayer-demo");
    expect(r.err).not.toContain("semlayer demo: semlayer demo");
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("when the plugin's data files are not there, naming the repository to clone", () => {
    const plugin = tempDir("demo-plugin");
    expect(() => demoData(plugin)).toThrow(`A copy of the skill directory alone does not include it. Clone ${REPOSITORY}`);
    mkdirSync(join(plugin, "fixtures", "acme", "data", "warehouse"), { recursive: true });
    writeFileSync(join(plugin, "fixtures", "acme", "data", "warehouse", "t.csv"), "a\n1\n");
    expect(() => demoData(plugin)).toThrow("has no sample data");
  });

  test("a copy of the skill directory alone refuses, from any working directory, and makes nothing", () => {
    const base = tempDir("demo-skill");
    const skill = join(base, "skills", "semantic-layer");
    for (const d of ["scripts", "schemas"]) cpSync(join(SKILL, d), join(skill, d), { recursive: true });
    // The copy's packages, as `bun add` in it leaves them (docs/plugin.md, Without the plugin).
    symlinkSync(join(SKILL, "..", "..", "node_modules"), join(skill, "node_modules"));
    const cwd = tempDir("demo");
    const r = spawn([join(skill, "scripts", "semlayer.ts"), "demo"], cwd);
    expect(r.code).toBe(1);
    expect(r.err).toContain("This copy of semlayer has no sample data");
    expect(r.err).toContain(`Clone ${REPOSITORY}`);
    expect(readdirSync(cwd)).toEqual([]);
  });
});

describe("semlayer demo finds the data from its own real path", () => {
  test("run through a symlink to the CLI from another folder", () => {
    const links = tempDir("demo-link");
    symlinkSync(SCRIPT, join(links, "semlayer.ts"));
    const cwd = tempDir("demo");
    const r = spawn([join(links, "semlayer.ts"), "demo", "--dir", "here"], cwd);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(join(cwd, "here", "data", "warehouse", "fct_orders.csv"))).toBe(true);
    expect(readdirSync(links)).toEqual(["semlayer.ts"]);
  });
});

describe("the README's Try it without a warehouse section", () => {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Try it without a warehouse"), readme.indexOf("## Run the CLI"));

  test("comes right after Install and its commands run as written", () => {
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings.indexOf("Try it without a warehouse")).toBe(headings.indexOf("Install") + 1);
    const block = /```sh\n([\s\S]*?)```/.exec(section)![1]!;
    const lines = block.split("\n").map((l) => l.replace(/\s+#.*$/, "").trim()).filter(Boolean);
    expect(lines).toEqual([
      `git clone ${REPOSITORY}`,
      "(cd semantic-layer-builder && bun install)",
      "bun semantic-layer-builder/skills/semantic-layer/scripts/semlayer.ts demo",
      "cd semlayer-demo",
      "claude",
    ]);
    // The clone and its install stand as this checkout; the rest runs as written.
    const cwd = tempDir("demo-readme");
    symlinkSync(REPO, join(cwd, "semantic-layer-builder"));
    const [, ...args] = lines[2]!.split(" ");
    const r = spawn(args, cwd);
    expect(r.code).toBe(0);
    expect(existsSync(join(cwd, "semlayer-demo", "OWNER.md"))).toBe(true);
    expect(spawn([SCRIPT, "next"], join(cwd, "semlayer-demo")).code).toBe(0);
    expect(section).toContain('"help me build a semantic layer for the data in this folder"');
  });
});

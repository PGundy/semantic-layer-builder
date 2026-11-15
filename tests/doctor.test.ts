import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { missingPackages, olderThan } from "../skills/semantic-layer/scripts/commands/doctor.ts";
import { envFileRefusal } from "../skills/semantic-layer/scripts/hooks/integrity.ts";
import { ENV_EXAMPLE_HEADER, URL_PLACEHOLDER } from "../skills/semantic-layer/scripts/lib/env-file.ts";
import { PLUGIN_BIN_DIR } from "../skills/semantic-layer/scripts/lib/plugin-bin.ts";
import { initProject, PG_URL, semlayer, tempDir } from "./helpers.ts";

// semlayer doctor (spec: CLI, semlayer doctor) and the .env.example semlayer setup leaves when a
// connection is set nowhere (spec: Connection variables and env files). Credentials are synthetic.

const REPO = join(import.meta.dir, "..");
const ACME = join(REPO, "examples", "acme", "semantic");
const SECRET = "s3cret-doctor-pw";

interface Doctor {
  ok: boolean;
  checks: { check: string; status: "ok" | "warn" | "fail" | "skip"; text: string; fix?: string }[];
  shell_line: string;
  next: { command: string; why: string } | null;
}
async function doctor(root: string, env: Record<string, string | undefined> = {}) {
  const json = await semlayer(root, ["doctor", "--json"], env);
  const plain = await semlayer(root, ["doctor"], env);
  expect(json.code).toBe(0);
  expect(plain.code).toBe(0);
  return { d: json.json<Doctor>(), plain: plain.out, all: json.out + json.err + plain.out + plain.err };
}
const find = (d: Doctor, check: string) => d.checks.filter((c) => c.check === check);
// Every file under a directory, to show a run wrote nothing.
const files = (dir: string) => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : []);
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
const hasGit = Bun.which("git") !== null;

describe("semlayer doctor", () => {
  test("in an empty folder: Bun and the packages are fine, there is no layer yet, and the next step is init; it writes nothing", async () => {
    const dir = tempDir("doctor-empty");
    const { d, plain } = await doctor(join(dir, "semantic"));
    expect(d.ok).toBe(true);
    expect(find(d, "bun")[0]).toMatchObject({ status: "ok" });
    expect(find(d, "packages")[0]).toMatchObject({ status: "ok" });
    expect(find(d, "project")[0]).toMatchObject({ status: "skip", text: `No semantic layer at ${join(dir, "semantic")} yet.` });
    expect(find(d, "command")[0]).toMatchObject({ status: "skip", fix: "the line below, to run it yourself" });
    expect(d.shell_line).toBe(`export PATH="$PATH":'${PLUGIN_BIN_DIR}'`);
    expect(d.next?.command).toBe("semlayer init --name <name>");
    expect(plain).toContain("[ok]   Bun ");
    expect(plain).toContain("[--]   No semantic layer");
    expect(plain.split("\n").filter((l) => l.includes(d.shell_line))).toHaveLength(1);
    expect(plain).toContain("Next: semlayer init --name <name>");
    expect(files(dir)).toEqual([]);
  });

  test("on the Acme example: the DuckDB source answers, the Postgres one names the line to add, and nothing changes", async () => {
    const before = files(join(REPO, "examples", "acme"));
    const { d, plain } = await doctor(ACME);
    expect(find(d, "project")[0]).toMatchObject({ status: "ok", text: `Semantic layer acme at ${ACME}.` });
    expect(find(d, "connection lake")[0]?.status).toBe("ok");
    expect(find(d, "query lake")[0]).toMatchObject({ status: "ok", text: 'Source "lake" answered a read-only query.' });
    expect(find(d, "connection warehouse")[0]).toMatchObject({
      status: "fail",
      text: 'Source "warehouse": WAREHOUSE_URL is set nowhere.',
      fix: `the owner adds to ${join(REPO, "examples", "acme", ".env")}, with the real values: WAREHOUSE_URL=${URL_PLACEHOLDER}`,
    });
    expect(plain).toContain(`[fail] Source "warehouse": WAREHOUSE_URL is set nowhere.\n       Fix: the owner adds to`);
    expect(d.ok).toBe(true);
    expect(files(join(REPO, "examples", "acme"))).toEqual(before);
  });

  test.skipIf(!PG_URL)("with a role that can write: the connection is named by variable, the role warning names the read-only role's statements, and no secret is printed", async () => {
    const { d, all } = await doctor(ACME, { WAREHOUSE_URL: PG_URL });
    expect(find(d, "connection warehouse")[0]).toMatchObject({ status: "ok", text: 'Source "warehouse" reads WAREHOUSE_URL from the environment.' });
    expect(find(d, "query warehouse")[0]?.status).toBe("ok");
    const role = find(d, "role warehouse")[0]!;
    expect(role.status).toBe("warn");
    expect(role.fix).toContain("semlayer setup --print-role-sql --dialect postgres --schemas");
    const url = new URL(PG_URL!);
    expect(all).not.toContain(PG_URL!);
    // The password never appears beside the user as in a URL; nor on its own, unless it is the same
    // word as the role name doctor prints (a test database's postgres:postgres).
    if (url.password) {
      expect(all).not.toContain(`:${url.password}@`);
      if (decodeURIComponent(url.password) !== decodeURIComponent(url.username)) expect(all).not.toContain(decodeURIComponent(url.password));
    }
  });

  test.skipIf(!hasGit)("with a tracked .env: it names git rm --cached, the failed connection names its fix, and the secret never shows", async () => {
    const dir = tempDir("doctor-git");
    const root = join(dir, "semantic");
    await initProject(root);
    writeFileSync(join(root, "sources", "lake.yaml"), "source: lake\ndialect: postgres\nconnection:\n  env: LAKE_URL\n");
    // Port 1 on this machine refuses at once.
    writeFileSync(join(dir, ".env"), `LAKE_URL=postgres://reader:${SECRET}@127.0.0.1:1/acme\n`);
    expect(git(dir, "init", "-q").exitCode).toBe(0);
    expect(git(dir, "add", "-f", ".env").exitCode).toBe(0);
    const { d, all } = await doctor(root);
    expect(find(d, "connection lake")[0]).toMatchObject({ status: "ok", text: `Source "lake" reads LAKE_URL from ${join(dir, ".env")}.` });
    expect(find(d, "query lake")[0]).toMatchObject({ status: "fail", fix: "fix what the message names, then semlayer doctor" });
    expect(find(d, "query lake")[0]!.text).toContain("cannot reach the database at 127.0.0.1 port 1");
    expect(find(d, "env file")[0]).toMatchObject({ status: "fail", text: `${join(dir, ".env")} is tracked by git, so its secret goes out with every push.` });
    expect(find(d, "env file")[0]!.fix).toContain(`git -C '${dir}' rm --cached '.env'`);
    expect(all).not.toContain(SECRET);
    expect(d.ok).toBe(true);

    // Untracked and ignored by the .gitignore semlayer init wrote: fine. Not ignored: a warning naming the lines.
    expect(git(dir, "rm", "-q", "--cached", ".env").exitCode).toBe(0);
    expect(find((await doctor(root)).d, "env file")[0]).toMatchObject({ status: "ok", text: `${join(dir, ".env")} is kept out of git.` });
    writeFileSync(join(dir, ".gitignore"), "");
    expect(find((await doctor(root)).d, "env file")[0]).toMatchObject({ status: "warn", fix: `add the lines .env, .env.* and !.env.example to ${join(dir, ".gitignore")}` });
  });

  test("compares Bun versions by their numbers", () => {
    expect(olderThan("1.3.99", "1.4.0")).toBe(true);
    expect(olderThan("1.4.0", "1.4.0")).toBe(false);
    expect(olderThan("1.10.0", "1.4.0")).toBe(false);
    expect(olderThan("1.4.0-canary.1+abc", "1.4.0")).toBe(false);
    expect(olderThan("0.9.9", "1.4.0")).toBe(true);
  });

  test("the packages are looked for in node_modules on disk, not through Bun's auto-install", () => {
    expect(missingPackages()).toEqual([]);
    const dir = tempDir("doctor-nomods");
    expect(missingPackages([dir])).toEqual(["yaml", "ajv", "@duckdb/node-api"]);
    mkdirSync(join(dir, "node_modules", "yaml"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "yaml", "package.json"), "{}");
    expect(missingPackages([dir])).toEqual(["ajv", "@duckdb/node-api"]);
  });
});

describe(".env.example", () => {
  const LINE = `LAKE_URL=${URL_PLACEHOLDER}`;

  test("semlayer setup with the variable set nowhere writes it once, with placeholders only, and says the owner copies it to .env", async () => {
    const dir = tempDir("example");
    const root = join(dir, "semantic");
    const example = join(dir, ".env.example");
    const r = await semlayer(root, ["setup", "--source", "lake", "--dialect", "postgres", "--env", "LAKE_URL"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Wrote ${example} with placeholders in place of the values: the owner copies it to ${join(dir, ".env")} and fills in the real values themselves.`);
    expect(r.err).toContain("so nothing was written under the semantic root.");
    expect(readFileSync(example, "utf8")).toBe(`${ENV_EXAMPLE_HEADER}${LINE}\n`);
    expect(existsSync(root)).toBe(false);

    // Never overwritten: the owner's own copy stays as it is.
    writeFileSync(example, "# ours\nLAKE_URL=<ask Dana>\n");
    const again = await semlayer(root, ["setup", "--source", "lake", "--dialect", "postgres", "--env", "LAKE_URL"]);
    expect(again.err).toContain(`${example} already holds the placeholder lines: the owner copies them to ${join(dir, ".env")}`);
    expect(readFileSync(example, "utf8")).toBe("# ours\nLAKE_URL=<ask Dana>\n");
  });

  test("a second source's lines are appended to the existing file, which keeps what it held; doctor checks the file holds the variable", async () => {
    const dir = tempDir("example-second");
    const root = join(dir, "semantic");
    const example = join(dir, ".env.example");
    await initProject(root);
    expect((await semlayer(root, ["setup", "--source", "lake", "--dialect", "postgres", "--env", "LAKE_URL"])).code).toBe(1);
    appendFileSync(example, "# the owner's note\n");
    const before = readFileSync(example, "utf8");
    writeFileSync(join(root, "sources", "shop.yaml"), "source: shop\ndialect: postgres\nconnection:\n  env: SHOP_URL\n");
    // Before the second setup the file lacks SHOP_URL, and doctor does not say it holds it.
    const lacking = find((await doctor(root)).d, "connection shop")[0]!;
    expect(lacking.text).not.toContain(".env.example");
    expect(lacking.fix).toContain("SHOP_URL=");
    const r = await semlayer(root, ["setup", "--source", "shop", "--dialect", "postgres", "--env", "SHOP_URL"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Added the placeholder lines to ${example}: the owner copies those lines to ${join(dir, ".env")}`);
    expect(readFileSync(example, "utf8")).toBe(`${before}SHOP_URL=${URL_PLACEHOLDER}\n`);
    expect(find((await doctor(root)).d, "connection shop")[0]!.text).toContain(`${example} holds this line: copy it to ${join(dir, ".env")}`);
  });

  test("with a named env file elsewhere, no .env.example is written", async () => {
    const dir = tempDir("example-named");
    const root = join(dir, "semantic");
    const other = join(tempDir("example-named-env"), "secrets.env");
    writeFileSync(other, "# none yet\n");
    const r = await semlayer(root, ["setup", "--source", "lake", "--dialect", "postgres", "--env", "LAKE_URL", "--env-file", other]);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain(".env.example");
    expect(existsSync(join(dir, ".env.example"))).toBe(false);
  });

  test("with --env-prefix it holds every part, each a placeholder, and semlayer doctor points to it", async () => {
    const dir = tempDir("example-prefix");
    const root = join(dir, "semantic");
    await initProject(root);
    const r = await semlayer(root, ["setup", "--source", "lake", "--dialect", "postgres", "--env-prefix", "LAKE_"]);
    expect(r.code).toBe(1);
    const text = readFileSync(join(dir, ".env.example"), "utf8");
    expect(text).toBe(`${ENV_EXAMPLE_HEADER}LAKE_HOST=<host>\nLAKE_PORT=5432\nLAKE_USER=<user>\nLAKE_PASSWORD=<password>\nLAKE_DATABASE=<database>\nLAKE_SSLMODE=require\n`);
    for (const line of text.split("\n").filter((l) => l && !l.startsWith("#"))) expect(line).toMatch(/^LAKE_[A-Z]+=(<[a-z]+>|5432|require)$/);
    writeFileSync(join(root, "sources", "lake.yaml"), "source: lake\ndialect: postgres\nconnection:\n  env_prefix: LAKE_\n");
    const { d } = await doctor(root);
    expect(find(d, "connection lake")[0]!.text).toContain(`${join(dir, ".env.example")} holds these lines: copy it to ${join(dir, ".env")} and fill in the values.`);
  });

  test("the hook refuses a read of .env and allows .env.example; git ignores .env and keeps .env.example", async () => {
    const dir = tempDir("example-hook");
    const root = join(dir, "semantic");
    await initProject(root);
    expect((await semlayer(root, ["setup", "--source", "lake", "--dialect", "postgres", "--env", "LAKE_URL"])).code).toBe(1);
    writeFileSync(join(dir, ".env"), `LAKE_URL=postgres://reader:${SECRET}@db.example/acme\n`);
    expect(envFileRefusal("Read", { file_path: join(dir, ".env.example") }, dir, {})).toBeUndefined();
    expect(envFileRefusal("Bash", { command: "cat .env.example" }, dir, {})).toBeUndefined();
    expect(envFileRefusal("Read", { file_path: join(dir, ".env") }, dir, {})).toContain("This file holds the connection secret.");
    if (hasGit) {
      expect(git(dir, "init", "-q").exitCode).toBe(0);
      expect(git(dir, "check-ignore", "-q", ".env").exitCode).toBe(0);
      expect(git(dir, "check-ignore", "-q", ".env.example").exitCode).toBe(1);
    }
  });
});

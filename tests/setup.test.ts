// sl setup (docs/PRD.md FR-1.5, FR-1.0): one step from nothing to a previewed scope, connection
// first, idempotent, updating a source in place with its comments, never storing a credential.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SQL } from "bun";
import { loadPostgres } from "../fixtures/acme/load-postgres.ts";
import { projectName } from "../skills/semantic-layer/scripts/lib/setup.ts";
import type { Snapshot, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, PG_URL, sl, tempRoot, uniqueSchema } from "./helpers.ts";

const ACME = join(import.meta.dir, "..", "fixtures", "acme");
const LAKE = join(ACME, "data", "lake");
const EXPORT_CSV = join(import.meta.dir, "..", "examples", "acme-export", "schema.csv");

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function fresh(): { root: string; dir: string } {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  return t;
}

const view = (name: string, file: string) => `${name}=read_parquet('${join(LAKE, file)}')`;
const LAKE_ARGS = [
  "setup", "--source", "lake", "--dialect", "duckdb",
  "--view", view("web_events", "web_events/*.parquet"),
  "--view", view("sessions", "sessions.parquet"),
  "--view", view("marketing_spend", "marketing_spend.parquet"),
  "--view", view("tmp_session_dedupe", "tmp_session_dedupe.parquet"),
  "--schemas", "main",
];

interface SetupJson {
  project_created: boolean;
  project: string;
  source: {
    name: string;
    path: string;
    created: boolean;
    updated: boolean;
    changes: {
      connection: string[];
      intake_mode: boolean;
      reason: boolean;
      schemas: { added: string[]; removed: string[] };
      include: { added: string[]; removed: string[] };
      exclude: { added: string[]; removed: string[] };
      tables_file: string | null;
      export_file: string | null;
    };
  };
  intake: { mode: string; schemas: string[]; reason?: string; export_file?: string };
  snapshot: { read: boolean; current: boolean; tables?: number; columns?: number };
  scope: { in_scope: number; total: number; tables: { table: string }[]; by_schema: unknown[]; added: string[]; removed: string[]; needs_focus: boolean; unmatched_patterns: string[] } | null;
  changed: boolean;
  warnings: string[];
  next: string;
}

// Every file under `dir` with a hash of its bytes.
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const snapshotNames = (root: string, source: string) =>
  (JSON.parse(readFileSync(join(root, "snapshots", `${source}.json`), "utf8")) as Snapshot).tables.map((t) => `${t.schema}.${t.name}`);

describe("connection first", () => {
  test("with neither --env nor --export it refuses, explains why a connection is better and writes nothing", async () => {
    const { root } = fresh();
    const r = await sl(root, ["setup", "--source", "wh", "--dialect", "postgres", "--schemas", "acme"]);
    expect(r.code).toBe(1);
    for (const words of ["profiles, join evidence, goldens", "--env <VAR>", "--export <file> with --reason"]) expect(r.err).toContain(words);
    expect(existsSync(root)).toBe(false);
  });

  test("a URL or a credential in --env is refused without echoing it, as sl add-source refuses it", async () => {
    const { root } = fresh();
    const other = fresh().root;
    expect((await sl(other, ["init", "--name", "other"])).code).toBe(0);
    for (const env of ["postgres://reader:s3cret@db.example.com/wh", "reader@db", "PASSWORD=s3cret"]) {
      const r = await sl(root, ["setup", "--source", "wh", "--dialect", "postgres", "--env", env]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("--env takes the NAME of an environment variable");
      expect(r.err).not.toContain("s3cret");
      const a = await sl(other, ["add-source", "--name", "wh", "--dialect", "postgres", "--env", env]);
      expect(a.err.replace("sl add-source: ", "")).toBe(r.err.replace("sl setup: ", ""));
    }
    const db = await sl(root, ["setup", "--source", "lake", "--dialect", "duckdb", "--database", "md:wh?motherduck_token=abc123"]);
    expect(db.code).toBe(1);
    expect(db.err).toContain("--database contains a credential");
    expect(db.err).not.toContain("abc123");
    expect(existsSync(root)).toBe(false);
  });

  test("the flags of the two paths do not mix", async () => {
    const { root } = fresh();
    const both = await sl(root, ["setup", "--source", "wh", "--dialect", "postgres", "--env", "WAREHOUSE_URL", "--export", EXPORT_CSV]);
    expect(both.err).toContain("--export is the fallback for when no connection is possible, so it takes no --env");
    const reason = await sl(root, ["setup", "--source", "wh", "--dialect", "postgres", "--env", "WAREHOUSE_URL", "--reason", "x"]);
    expect(reason.err).toContain("--reason records why a connection is not possible, so it goes with --export");
    const pgEnv = await sl(root, ["setup", "--source", "wh", "--dialect", "postgres", "--env", "WAREHOUSE_URL"], { WAREHOUSE_URL: undefined });
    expect(pgEnv.err).toContain('Source "wh": WAREHOUSE_URL is not set. Looked in the environment, then in');
    expect(pgEnv.err).toContain("sl setup reads the catalog through that connection, so nothing was written under the semantic root.");
    expect(existsSync(root)).toBe(false);
  });
});

describe("the Acme DuckDB lake from nothing", () => {
  test("creates the project, the source, the snapshot and the preview, with one next action", async () => {
    const { root, dir } = fresh();
    const r = await sl(root, [...LAKE_ARGS, "--exclude", "tmp_*", "--json"]);
    expect(r.code).toBe(0);
    const j = r.json<SetupJson>();
    expect(j.project_created).toBe(true);
    expect(j.project).toBe(projectName(join(dir, "semantic")));
    expect([projectName("/work/Acme-Shop/semantic"), projectName("/work/layers/acme_lake")]).toEqual(["acme_shop", "acme_lake"]);
    expect(j.source).toMatchObject({ name: "lake", path: "sources/lake.yaml", created: true, updated: false });
    expect(j.intake).toEqual({ mode: "connection", schemas: ["main"] });
    expect(j.snapshot).toMatchObject({ read: true, current: true, tables: 4 });
    expect(j.scope!.tables.map((t) => t.table)).toEqual(["main.marketing_spend", "main.sessions", "main.web_events"]);
    expect(j.scope!.by_schema).toEqual([{ schema: "main", in_scope: 3, total: 4 }]);
    expect(j.next).toBe("sl profile --source lake");
    const source = readYaml<SourceConfig>(join(root, "sources", "lake.yaml"));
    expect(source.intake).toEqual({ mode: "connection", schemas: ["main"] });
    expect(source.scope).toEqual({ exclude: ["tmp_*"] });
    expect(Object.keys(source)).toEqual(["source", "dialect", "connection", "intake", "scope"]);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".sl/plans/");
    expect((await sl(root, ["validate"])).code).toBe(0);
  });

  test("the same arguments again change no file, even with another clock, and say so", async () => {
    const { root } = fresh();
    const args = [...LAKE_ARGS, "--include", "web_*,sessions", "--exclude", "tmp_*"];
    expect((await sl(root, args)).code).toBe(0);
    const before = tree(root);
    const again = await sl(root, args, { SL_NOW: "2027-06-01T00:00:00.000Z" });
    expect(again.code).toBe(0);
    expect(again.out).toContain("Nothing changed: sources/lake.yaml, its scope and the snapshot are as they were.");
    expect(again.out.trimEnd().split("\n").filter((l) => l.startsWith("Next:"))).toEqual(["Next: sl profile --source lake"]);
    expect(tree(root)).toEqual(before);
    const j = (await sl(root, [...args, "--json"])).json<SetupJson>();
    expect(j.changed).toBe(false);
    expect(j.snapshot).toEqual({ read: false, current: true, changes: null } as never);
    expect(tree(root)).toEqual(before);
  });

  test("new arguments update the source in place and report the difference", async () => {
    const { root } = fresh();
    expect((await sl(root, [...LAKE_ARGS, "--include", "web_*,sessions", "--exclude", "tmp_*"])).code).toBe(0);
    const r = await sl(root, [...LAKE_ARGS, "--include", "web_*,marketing_*", "--json"]);
    const j = r.json<SetupJson>();
    expect(j.source).toMatchObject({ created: false, updated: true });
    expect(j.source.changes.include).toEqual({ added: ["marketing_*"], removed: ["sessions"] });
    expect(j.source.changes.exclude).toEqual({ added: [], removed: ["tmp_*"] });
    expect(j.source.changes.connection).toEqual([]);
    expect(j.snapshot.read).toBe(false);
    expect(j.scope!.added).toEqual(["main.marketing_spend"]);
    expect(j.scope!.removed).toEqual(["main.sessions"]);
    // A dropped view changes the connection, so the catalog is read again.
    const fewer = LAKE_ARGS.filter((a, i) => !(a.startsWith("tmp_session_dedupe=") || LAKE_ARGS[i + 1]?.startsWith("tmp_session_dedupe=")));
    const text = await sl(root, [...fewer, "--include", "web_*,marketing_*"]);
    expect(text.out).toContain("Updated sources/lake.yaml in place:\n  connection: views changed");
    expect(text.out).toContain("Introspected lake: 3 tables");
    expect(snapshotNames(root, "lake")).toEqual(["main.marketing_spend", "main.sessions", "main.web_events"]);
    const schemas = (await sl(root, [...fewer.slice(0, -2), "--schemas", "main,other", "--json"])).json<SetupJson>();
    expect(schemas.source.changes.schemas).toEqual({ added: ["other"], removed: [] });
  });

  test("an update keeps the owner's comments and the keys setup does not manage", async () => {
    const { root } = fresh();
    expect((await sl(root, ["init", "--name", "acme"])).code).toBe(0);
    const original = [
      "# Acme's event lake. Owner: Dana.",
      "source: lake",
      "dialect: duckdb",
      "description: Parquet files of web events.   # in the owner's words",
      "connection:",
      '  database: ":memory:"',
      "  setup:",
      "    - LOAD parquet   # needed for the views",
      "  views:",
      `    web_events: read_parquet('${join(LAKE, "web_events/*.parquet")}')   # one file per year`,
      "scope:",
      "  exclude:",
      "    - tmp_*   # Dana: scratch tables",
      "draft:",
      "  strip_prefixes: [fct_]",
      "",
    ].join("\n");
    writeFileSync(join(root, "sources", "lake.yaml"), original);
    const r = await sl(root, ["setup", "--source", "lake", "--dialect", "duckdb", "--view", view("web_events", "web_events/*.parquet"), "--view", view("sessions", "sessions.parquet"), "--schemas", "main", "--exclude", "tmp_*,*_archive"]);
    expect(r.code).toBe(0);
    const text = readFileSync(join(root, "sources", "lake.yaml"), "utf8");
    for (const kept of ["# Acme's event lake. Owner: Dana.", "# in the owner's words", "- LOAD parquet   # needed for the views", "# one file per year", "- tmp_*   # Dana: scratch tables", "strip_prefixes: [fct_]"]) {
      expect(text).toContain(kept);
    }
    expect(readYaml<SourceConfig>(join(root, "sources", "lake.yaml"))).toMatchObject({
      intake: { mode: "connection", schemas: ["main"] },
      scope: { exclude: ["tmp_*", "*_archive"] },
      connection: { setup: ["LOAD parquet"] },
    });
    expect(text.indexOf("intake:")).toBeLessThan(text.indexOf("scope:"));
    expect(r.out).toContain("Updated sources/lake.yaml in place:");
    expect(r.out).toContain("  exclude: added *_archive");
  });

  test("reading the catalog fails: the source file and the snapshot are put back", async () => {
    const { root } = fresh();
    expect((await sl(root, [...LAKE_ARGS])).code).toBe(0);
    const before = tree(root);
    const r = await sl(root, [...LAKE_ARGS, "--view", "missing=read_parquet('/nonexistent/sl-setup-test/x.parquet')"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("sl setup put sources/lake.yaml, the copies and the snapshot back as they were; fix the problem");
    expect(tree(root)).toEqual(before);
    const first = await sl(fresh().root, ["setup", "--source", "lake", "--dialect", "duckdb", "--view", "missing=read_parquet('/nonexistent/sl-setup-test/x.parquet')"]);
    expect(first.err).toContain("back as they were (the project it created stays); fix the problem");
  });

  test("a rerun without connection flags names them and sl scope; a case-only glob change is no change", async () => {
    const { root } = fresh();
    expect((await sl(root, [...LAKE_ARGS, "--include", "web_*", "--json"])).code).toBe(0);
    const bare = await sl(root, ["setup", "--source", "lake", "--dialect", "duckdb", "--include", "sessions"]);
    expect(bare.code).toBe(1);
    expect(bare.err).toContain('Source "lake" exists, and sl setup needs its connection flags again');
    expect(bare.err).toContain("sl scope --source lake --include <pattern> --write");
    const before = tree(root);
    const upper = (await sl(root, [...LAKE_ARGS, "--include", "WEB_*", "--json"])).json<SetupJson>();
    expect(upper.changed).toBe(false);
    expect(upper.source.changes.include).toEqual({ added: [], removed: [] });
    expect(tree(root)).toEqual(before);
  });

  test("the source file is never written through a link at sources/ that leads outside the root", async () => {
    const { root, dir } = fresh();
    expect((await sl(root, ["init", "--name", "acme"])).code).toBe(0);
    mkdirSync(join(dir, "elsewhere"));
    rmSync(join(root, "sources"), { recursive: true });
    symlinkSync(join(dir, "elsewhere"), join(root, "sources"));
    const r = await sl(root, LAKE_ARGS);
    expect(r.code).toBe(1);
    expect(r.err).toContain("sources/lake.yaml leads outside the semantic root");
    expect(readdirSync(join(dir, "elsewhere"))).toEqual([]);
  });

  test("above the focus threshold the warning is in --json warnings too", async () => {
    const { root } = fresh();
    expect((await sl(root, ["init", "--name", "acme"])).code).toBe(0);
    const yaml = join(root, "semantic.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace(/focus_threshold: \d+/, "focus_threshold: 2"));
    const j = (await sl(root, [...LAKE_ARGS, "--json"])).json<SetupJson>();
    expect(j.scope!.needs_focus).toBe(true);
    expect(j.warnings.join("\n")).toContain("more than the focus threshold of 2");
    expect(j.next).toBe("sl tables --source lake --groups");
  });
});

describe("--tables-file", () => {
  test("is copied under scope/ as sl scope --from-file --write copies it, and a changed file replaces the copy", async () => {
    const { root, dir } = fresh();
    const list = join(dir, "lake-tables.txt");
    writeFileSync(list, "# Agreed with Dana.\nweb_events\nsessions   # anonymous ones too\n!tmp_*\n");
    const r = await sl(root, [...LAKE_ARGS, "--tables-file", list, "--json"]);
    expect(r.code).toBe(0);
    const j = r.json<SetupJson>();
    expect(j.source.changes.tables_file).toBe("added");
    expect(j.scope!.tables.map((t) => t.table)).toEqual(["main.sessions", "main.web_events"]);
    expect(readFileSync(join(root, "scope", "lake.txt"), "utf8")).toBe(readFileSync(list, "utf8"));
    expect(readYaml<SourceConfig>(join(root, "sources", "lake.yaml")).scope).toEqual({ tables_file: "scope/lake.txt" });
    const before = tree(root);
    expect((await sl(root, [...LAKE_ARGS, "--tables-file", list, "--json"])).json<SetupJson>().changed).toBe(false);
    expect(tree(root)).toEqual(before);
    writeFileSync(list, "web_events\nmarketing_spend\n");
    const again = await sl(root, [...LAKE_ARGS, "--tables-file", list]);
    expect(again.out).toContain(`Replaced scope/lake.txt with ${list}.`);
    expect(again.out).toContain("Added to scope (1): main.marketing_spend");
    expect(again.out).toContain("Removed from scope (1): main.sessions");
    expect((await sl(root, ["validate"])).code).toBe(0);
  });

  test("a file with a bad entry is refused with its line, before anything is written", async () => {
    const { root, dir } = fresh();
    const list = join(dir, "bad.txt");
    writeFileSync(list, "web_events\nre:(a+)+\n");
    const r = await sl(root, [...LAKE_ARGS, "--tables-file", list]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("bad.txt line 2");
    expect(existsSync(root)).toBe(false);
  });
});

describe("export path", () => {
  test("with --reason: export mode, the export copied under the root, only intake.schemas imported", async () => {
    const { root } = fresh();
    const args = ["setup", "--source", "warehouse", "--dialect", "postgres", "--export", EXPORT_CSV, "--reason", "The warehouse accepts no outside connections.", "--schemas", "acme", "--include", "fct_*,dim_*", "--exclude", "*_test,*_archive", "--name", "acme"];
    const r = await sl(root, [...args, "--json"]);
    expect(r.code).toBe(0);
    const j = r.json<SetupJson>();
    expect(j.project).toBe("acme");
    expect(j.intake).toEqual({ mode: "export", schemas: ["acme"], reason: "The warehouse accepts no outside connections.", export_file: "exports/warehouse.csv" });
    expect(j.warnings).toEqual([]);
    expect(j.next).toBe("sl baseline --source warehouse");
    expect(j.scope!.tables.map((t) => t.table)).toEqual([
      "acme.dim_currency", "acme.dim_customers", "acme.dim_products", "acme.dim_regions", "acme.dim_sales_reps", "acme.fct_order_items", "acme.fct_orders", "acme.fct_refunds",
    ]);
    expect(readFileSync(join(root, "exports", "warehouse.csv")).equals(readFileSync(EXPORT_CSV))).toBe(true);
    const source = readYaml<SourceConfig>(join(root, "sources", "warehouse.yaml"));
    expect(source.connection).toBeUndefined();
    expect(source.intake).toEqual({ mode: "export", reason: "The warehouse accepts no outside connections.", schemas: ["acme"], export: { file: "exports/warehouse.csv" } });
    expect((await sl(root, ["validate"])).code).toBe(0);
    const before = tree(root);
    expect((await sl(root, args, { SL_NOW: "2027-01-01T00:00:00.000Z" })).out).toContain("Nothing changed");
    expect(tree(root)).toEqual(before);
  });

  test("without --reason it warns that the reason is recorded as empty; a credential in --reason is redacted", async () => {
    const { root } = fresh();
    const r = await sl(root, ["setup", "--source", "warehouse", "--dialect", "postgres", "--export", EXPORT_CSV, "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<SetupJson>().warnings.join("\n")).toContain("intake.reason is recorded as empty. The skill asks the owner for a connection first");
    expect(readYaml<SourceConfig>(join(root, "sources", "warehouse.yaml")).intake?.reason).toBe("");
    const pasted = await sl(root, ["setup", "--source", "warehouse", "--dialect", "postgres", "--export", EXPORT_CSV, "--reason", "VPN only; password=hunter2xyz", "--json"]);
    expect(pasted.json<SetupJson>().source.changes.reason).toBe(true);
    const text = readFileSync(join(root, "sources", "warehouse.yaml"), "utf8");
    expect(text).not.toContain("hunter2xyz");
    expect(text).toContain("password=[redacted]");
  });

  test("a rerun without --reason keeps the recorded reason; a new --reason keeps the comment on its line", async () => {
    const { root } = fresh();
    const base = ["setup", "--source", "wh", "--dialect", "postgres", "--export", EXPORT_CSV, "--schemas", "acme"];
    expect((await sl(root, [...base, "--reason", "No outside connections."])).code).toBe(0);
    const rerun = (await sl(root, [...base, "--include", "fct_*", "--json"])).json<SetupJson>();
    expect(rerun.source.changes.reason).toBe(false);
    expect(rerun.warnings).toEqual([]);
    const file = join(root, "sources", "wh.yaml");
    expect(readYaml<SourceConfig>(file).intake?.reason).toBe("No outside connections.");
    writeFileSync(file, readFileSync(file, "utf8").replace("reason: No outside connections.", "reason: No outside connections.   # Dana said so"));
    expect((await sl(root, [...base, "--include", "fct_*", "--reason", "VPN only."])).code).toBe(0);
    expect(readFileSync(file, "utf8")).toMatch(/reason: VPN only\. +# Dana said so/);
  });

  test("an export source whose connection fails stays an export source; a connection source is not turned into an export", async () => {
    const { root } = fresh();
    expect((await sl(root, ["setup", "--source", "warehouse", "--dialect", "postgres", "--export", EXPORT_CSV, "--reason", "No access yet."])).code).toBe(0);
    const before = tree(root);
    // The upgrade to a connection (tests/upgrade.test.ts) reads the catalog first; a refused connection puts everything back.
    const up = await sl(root, ["setup", "--source", "warehouse", "--dialect", "postgres", "--env", "WAREHOUSE_URL"], { WAREHOUSE_URL: "postgres://sl@127.0.0.1:1/x" });
    expect(up.code).toBe(1);
    expect(up.err).toContain("sl setup put sources/warehouse.yaml, the copies, the snapshot and the model files back as they were");
    expect(tree(root)).toEqual(before);
    const dialect = await sl(root, ["setup", "--source", "warehouse", "--dialect", "snowflake", "--export", EXPORT_CSV]);
    expect(dialect.err).toContain('Source "warehouse" is a postgres source, and sl setup does not change a dialect.');
    expect(tree(root)).toEqual(before);
    expect((await sl(root, LAKE_ARGS)).code).toBe(0);
    const down = await sl(root, ["setup", "--source", "lake", "--dialect", "duckdb", "--export", EXPORT_CSV]);
    expect(down.err).toContain('Source "lake" reads the catalog through a connection; sl setup does not turn it into an export source.');
  });

  test("an export copy is never written through a link that leads outside the root", async () => {
    const { root, dir } = fresh();
    expect((await sl(root, ["init", "--name", "acme"])).code).toBe(0);
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(root, "exports"));
    const r = await sl(root, ["setup", "--source", "warehouse", "--dialect", "postgres", "--export", EXPORT_CSV, "--reason", "No access."]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("leads outside the semantic root");
    expect(readdirSync(join(dir, "elsewhere"))).toEqual([]);
    expect(existsSync(join(root, "sources", "warehouse.yaml"))).toBe(false);
  });
});

describe("dialects the CLI does not connect to", () => {
  test("snowflake: the source is written and the next action is the query-plan step", async () => {
    const { root } = fresh();
    const args = ["setup", "--source", "wh", "--dialect", "snowflake", "--env", "SNOWFLAKE_CONN", "--schemas", "ANALYTICS", "--include", "fct_*"];
    const r = await sl(root, [...args, "--json"]);
    expect(r.code).toBe(0);
    const j = r.json<SetupJson>();
    expect(j.snapshot).toMatchObject({ read: false, current: false });
    expect(j.scope).toBeNull();
    expect(j.next).toBe("sl introspect --source wh --emit-sql");
    const text = await sl(root, args);
    expect(text.out).toContain("Nothing changed");
    expect(text.out).toContain("Next: sl introspect --source wh --emit-sql, run the queries it prints with your own SQL tool, save the results as a JSON file, then run sl introspect --source wh --results <file>.");
  });
});

describe("determinism", () => {
  test("the same arguments in two fresh roots give the same output and the same files", async () => {
    const a = fresh();
    const b = fresh();
    const args = [...LAKE_ARGS, "--exclude", "tmp_*", "--name", "acme", "--json"];
    const ra = await sl(a.root, args);
    const rb = await sl(b.root, args);
    expect(ra.out).toBe(rb.out);
    expect(tree(a.root)).toEqual(tree(b.root));
  });
});

describe("the Acme Postgres warehouse, live", () => {
  const live = Boolean(PG_URL);
  let schema = "";
  let other = "";
  let pg: SQL | undefined;

  beforeAll(async () => {
    if (!live) return;
    assertLocalPg(PG_URL);
    schema = uniqueSchema("t_setup");
    other = uniqueSchema("t_setup_other");
    await loadPostgres(PG_URL!, join(ACME, "data"), schema);
    pg = new SQL({ url: PG_URL!, max: 1 });
    await pg.unsafe(`create schema ${other}`);
    await pg.unsafe(`create table ${other}.fct_elsewhere (id int)`);
  });

  afterAll(async () => {
    if (!pg) return;
    await pg.unsafe(`drop schema if exists ${schema} cascade`);
    await pg.unsafe(`drop schema if exists ${other} cascade`);
    await pg.close();
  });

  test.skipIf(!live)(
    "from nothing with --schemas and patterns; a rerun is a no-op; new patterns and schemas update in place",
    async () => {
      const { root } = fresh();
      const env = { WAREHOUSE_URL: PG_URL! };
      const args = ["setup", "--source", "warehouse", "--dialect", "postgres", "--env", "WAREHOUSE_URL", "--schemas", schema, "--include", "fct_*,dim_*", "--exclude", "*_test,*_archive"];
      const r = await sl(root, [...args, "--json"], env);
      expect(r.code).toBe(0);
      const j = r.json<SetupJson>();
      expect(j.snapshot).toMatchObject({ read: true, tables: 20 });
      expect(j.scope!.tables.map((t) => t.table)).toEqual(
        ["dim_currency", "dim_customers", "dim_products", "dim_regions", "fct_order_items", "fct_orders", "fct_refunds"].map((t) => `${schema}.${t}`),
      );
      expect(j.next).toBe("sl profile --source warehouse");
      const text = readFileSync(join(root, "sources", "warehouse.yaml"), "utf8");
      expect(text).not.toContain(PG_URL!);
      expect(readYaml<SourceConfig>(join(root, "sources", "warehouse.yaml")).connection).toEqual({ env: "WAREHOUSE_URL" });
      expect(snapshotNames(root, "warehouse").every((n) => n.startsWith(`${schema}.`))).toBe(true);

      const before = tree(root);
      const again = await sl(root, args, { ...env, SL_NOW: "2027-01-01T00:00:00.000Z" });
      expect(again.out).toContain("Nothing changed");
      expect(tree(root)).toEqual(before);

      const wider = await sl(root, ["setup", "--source", "warehouse", "--dialect", "postgres", "--env", "WAREHOUSE_URL", "--schemas", `${schema},${other}`, "--include", "fct_*", "--json"], env);
      const w = wider.json<SetupJson>();
      expect(w.source.changes.schemas).toEqual({ added: [other], removed: [] });
      expect(w.source.changes.include).toEqual({ added: [], removed: ["dim_*"] });
      expect(w.source.changes.exclude).toEqual({ added: [], removed: ["*_test", "*_archive"] });
      expect(w.snapshot.read).toBe(true);
      expect(w.scope!.added).toEqual([`${other}.fct_elsewhere`, `${schema}.fct_orders_v2_test`].sort());
      expect(w.scope!.removed).toEqual(["dim_currency", "dim_customers", "dim_products", "dim_regions"].map((t) => `${schema}.${t}`));
    },
    60_000,
  );
});

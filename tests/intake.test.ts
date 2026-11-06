// The intake block of sources/<source>.yaml (docs/PRD.md FR-1.1, FR-1.0): its schema, the checks
// sl validate makes and sl add-source --schemas.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intakeMode, isSchemaName } from "../skills/semantic-layer/scripts/lib/intake.ts";
import { type Issue, schemaIssues, validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { parseYamlText, readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, sl, tempRoot } from "./helpers.ts";

const REPO = join(import.meta.dir, "..");
const FIXTURE = join(import.meta.dir, "fixtures", "valid");
const SPEC = join(REPO, "skills", "semantic-layer", "references", "spec.md");
const SCHEMA = join(REPO, "skills", "semantic-layer", "schemas", "source.schema.json");
const FILE = "sources/warehouse.yaml";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function copyFixture(): { root: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sl-intake-"));
  temps.push(dir);
  const root = join(dir, "semantic");
  cpSync(FIXTURE, root, { recursive: true });
  return { root, dir };
}

// The fixture's warehouse source with `intake` appended as YAML text.
const BASE = readFileSync(join(FIXTURE, FILE), "utf8");
function withIntake(intake: string): { root: string; dir: string } {
  const t = copyFixture();
  writeFileSync(join(t.root, FILE), `${BASE}${intake}`);
  return t;
}

function intakeOf(issues: Issue[]): [Issue["level"], string, string][] {
  return issues.filter((i) => i.file === FILE && i.path.startsWith("intake")).map((i) => [i.level, i.path, i.message]);
}

function validateIntake(intake: string): [Issue["level"], string, string][] {
  return intakeOf(validateProject(withIntake(intake).root));
}

const source = (intake: unknown) => ({ source: "warehouse", dialect: "postgres", intake });

describe("intake schema", () => {
  test("a full export block and a connection block pass", () => {
    expect(schemaIssues("source", source({ mode: "export", reason: "no route", schemas: ["acme"], export: { file: "exports/w.csv" } }), FILE)).toEqual([]);
    expect(schemaIssues("source", source({ mode: "connection", schemas: ["a", "b"] }), FILE)).toEqual([]);
    expect(schemaIssues("source", source({}), FILE)).toEqual([]);
  });

  test("mode is connection or export", () => {
    const issues = schemaIssues("source", source({ mode: "live" }), FILE);
    expect(issues.map((i) => [i.path, i.message])).toEqual([["intake.mode", "must be one of: connection, export"]]);
  });

  test("an unknown key is refused, in intake and in export", () => {
    expect(schemaIssues("source", source({ schema: ["a"] }), FILE).map((i) => [i.path, i.message])).toEqual([["intake.schema", "is not a known property"]]);
    expect(schemaIssues("source", source({ mode: "export", export: { file: "x.csv", url: "y" } }), FILE).map((i) => i.path)).toEqual(["intake.export.url"]);
  });

  test("export needs a file, and schemas holds non-empty strings", () => {
    expect(schemaIssues("source", source({ mode: "export", export: {} }), FILE).map((i) => [i.path, i.message])).toEqual([["intake.export.file", "is required"]]);
    expect(schemaIssues("source", source({ schemas: [""] }), FILE).map((i) => i.path)).toEqual(["intake.schemas[0]"]);
    expect(schemaIssues("source", source({ schemas: "acme" }), FILE).map((i) => i.path)).toEqual(["intake.schemas"]);
    expect(schemaIssues("source", source({ reason: 3 }), FILE).map((i) => i.path)).toEqual(["intake.reason"]);
    expect(schemaIssues("source", source({ mode: "export", reason: null }), FILE)).toEqual([]);
  });

  test("every intake key is documented in the spec's Intake table", () => {
    const spec = readFileSync(SPEC, "utf8");
    const section = spec.slice(spec.indexOf("### Intake"), spec.indexOf("### Scope patterns"));
    const props = JSON.parse(readFileSync(SCHEMA, "utf8")).properties.intake.properties as Record<string, { properties?: Record<string, unknown> }>;
    const keys = Object.entries(props).flatMap(([k, v]) => (v.properties ? Object.keys(v.properties).map((c) => `${k}.${c}`) : [k]));
    expect(keys.sort()).toEqual(["export.file", "mode", "reason", "schemas"]);
    for (const k of keys) expect(section).toContain(`| \`${k}\` |`);
  });

  test("the spec's export example passes the schema", () => {
    const spec = readFileSync(SPEC, "utf8");
    const section = spec.slice(spec.indexOf("### Intake"));
    const block = section.slice(section.indexOf("```text\n") + 8, section.indexOf("\n```", section.indexOf("```text\n")));
    const doc = parseYamlText(block) as { intake: Record<string, unknown> };
    expect(doc.intake.mode).toBe("export");
    expect(schemaIssues("source", source(doc.intake), FILE)).toEqual([]);
  });
});

describe("intake checks in sl validate", () => {
  test("a source without intake is valid and means mode connection", () => {
    const { root } = copyFixture();
    expect(validateProject(root).filter((i) => i.file === FILE)).toEqual([]);
    expect(intakeMode(readYaml(join(root, FILE)))).toBe("connection");
    expect(intakeMode({ intake: { mode: "export" } })).toBe("export");
  });

  test("export mode without a reason warns that the skill asks for a connection first", () => {
    for (const block of ["intake:\n  mode: export\n", 'intake:\n  mode: export\n  reason: "  "\n', "intake:\n  mode: export\n  reason:\n"]) {
      const issues = validateIntake(block);
      expect(issues).toHaveLength(1);
      const [level, path, message] = issues[0]!;
      expect([level, path]).toEqual(["warning", "intake.reason"]);
      expect(message).toContain("asks for a connection first");
      expect(message).toContain("sl validate");
    }
    expect(validateIntake("intake:\n  mode: export\n  reason: The warehouse is on a private network.\n")).toEqual([]);
    expect(validateIntake("intake:\n  mode: connection\n")).toEqual([]);
  });

  test("schema names must be plain identifiers", () => {
    const issues = validateIntake('intake:\n  schemas: [public, Sales$1, "1st", a.b.c, "my schema", my-project.acme, "a.", ".a", café]\n');
    expect(issues.map(([l, p]) => [l, p])).toEqual([2, 3, 4, 5, 6, 7, 8].map((i) => ["error", `intake.schemas[${i}]`]));
    for (const [, , message] of issues) {
      expect(message).toContain("is not a schema name; write a plain identifier");
      expect(message).toContain("then run sl validate");
    }
  });

  test("a dotted name is refused where the tools read only the connected database's schemas", () => {
    const issues = validateIntake("intake:\n  schemas: [public, marts.core]\n");
    expect(issues.map(([l, p]) => [l, p])).toEqual([["error", "intake.schemas[1]"]]);
    expect(issues[0]![2]).toContain("read only the schemas of the database the connection opens; write the schema alone");
    for (const d of ["postgres", "snowflake", "databricks"] as const) expect(isSchemaName("marts.core", d)).toBe(false);
    expect(isSchemaName("marts.core", "duckdb")).toBe(true);
  });

  test("a DuckDB database.schema of the database the source opens warns that it matches no table", () => {
    const duck = (database: string | undefined, schemas: string) => {
      const { root } = copyFixture();
      const conn = database === undefined ? "" : `connection:\n  database: ${database}\n`;
      writeFileSync(join(root, FILE), `source: warehouse\ndialect: duckdb\n${conn}intake:\n  schemas: [${schemas}]\n`);
      return intakeOf(validateProject(root));
    };
    const memory = duck(undefined, "memory.main, other.main, main");
    expect(memory.map(([l, p]) => [l, p])).toEqual([["warning", "intake.schemas[0]"]]);
    expect(memory[0]![2]).toContain("which introspect reports as main alone, so it matches no table; write main");
    expect(duck('":memory:"', "temp.main").map(([l, p]) => [l, p])).toEqual([["warning", "intake.schemas[0]"]]);
    expect(duck("data/Wh.v1.duckdb", "wh.main, memory.main").map(([l, p]) => [l, p])).toEqual([["warning", "intake.schemas[0]"]]);
    expect(duck("md:lake", "memory.main")).toEqual([]);
  });

  test("an empty schemas list warns that it reads every schema", () => {
    expect(validateIntake("intake:\n  schemas: []\n")).toEqual([
      ["warning", "intake.schemas", "is empty, which reads every schema; list the schemas to read or remove intake.schemas, then run sl validate."],
    ]);
  });

  test("a source that fails its schema (schemas is a string) reports only that", () => {
    const issues = validateProject(withIntake("intake:\n  schemas: acme\n").root).filter((i) => i.file === FILE);
    expect(issues.map((i) => i.path)).toEqual(["intake.schemas"]);
  });

  test("a BigQuery project.dataset may have hyphens in the project id, and a dataset holds no $", () => {
    const { root } = withIntake("intake:\n  schemas: [my-project.acme, acme, my-project, Sales$1]\n");
    writeFileSync(join(root, FILE), readFileSync(join(root, FILE), "utf8").replace("dialect: postgres", "dialect: bigquery").replace(/connection:\n  env: \w+\n/, ""));
    expect(intakeOf(validateProject(root)).map(([l, p]) => [l, p])).toEqual([["error", "intake.schemas[2]"], ["error", "intake.schemas[3]"]]);
    expect(isSchemaName("my-project.acme", "bigquery")).toBe(true);
    expect(isSchemaName("my-project.acme", "postgres")).toBe(false);
    expect(isSchemaName("-x.acme", "bigquery")).toBe(false);
    expect(isSchemaName("a.my-dataset", "bigquery")).toBe(false);
  });

  test("a repeated schema is an error, one differing only in case a warning", () => {
    const issues = validateIntake("intake:\n  schemas: [acme, marts, acme, ACME]\n");
    expect(issues).toEqual([
      ["error", "intake.schemas[2]", 'repeats intake.schemas[0] ("acme"); remove one of them, then run sl validate.'],
      ["warning", "intake.schemas[3]", expect.stringContaining('differs from intake.schemas[0] ("acme") only in case')],
    ]);
  });

  test("a refused schema name is not echoed", () => {
    const issues = validateIntake('intake:\n  schemas: ["postgres://u:secret@host/db"]\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]![2]).not.toContain("secret");
  });

  test("export.file in connection mode is an error, the mode given or not", () => {
    for (const mode of ["", "  mode: connection\n"]) {
      const { root } = withIntake(`intake:\n${mode}  export:\n    file: exports/w.csv\n`);
      mkdirSync(join(root, "exports"));
      writeFileSync(join(root, "exports", "w.csv"), "table_schema,table_name\n");
      const issues = intakeOf(validateProject(root));
      expect(issues.map(([l, p]) => [l, p])).toEqual([["error", "intake.export"]]);
      expect(issues[0]![2]).toContain("applies only to intake.mode export");
    }
  });

  const EXPORT = (file: string) => `intake:\n  mode: export\n  reason: No route to the warehouse.\n  export:\n    file: ${file}\n`;

  test("an export file that exists inside the root passes", () => {
    const { root } = withIntake(EXPORT("exports/w.csv"));
    mkdirSync(join(root, "exports"));
    writeFileSync(join(root, "exports", "w.csv"), "table_schema,table_name\n");
    expect(intakeOf(validateProject(root))).toEqual([]);
  });

  test("an export file that names the root or a directory is a warning", () => {
    const { root } = withIntake(EXPORT("."));
    mkdirSync(join(root, "exports"));
    for (const file of [".", "sources", "exports/"]) {
      writeFileSync(join(root, FILE), `${BASE}${EXPORT(file)}`);
      const issues = intakeOf(validateProject(root));
      expect(issues.map(([l, p]) => [l, p])).toEqual([["warning", "intake.export.file"]]);
      expect(issues[0]![2]).toContain("names a directory, not a file");
    }
  });

  test("an export file that does not exist is a warning", () => {
    const issues = validateIntake(EXPORT("exports/missing.csv"));
    expect(issues.map(([l, p]) => [l, p])).toEqual([["warning", "intake.export.file"]]);
    expect(issues[0]![2]).toContain("does not exist under the semantic root");
  });

  test("an export file outside the root is an error, through .., an absolute path or a symlink", () => {
    const { root, dir } = withIntake(EXPORT("../schema.csv"));
    writeFileSync(join(dir, "schema.csv"), "table_schema,table_name\n");
    const check = (file: string) => {
      writeFileSync(join(root, FILE), `${BASE}${EXPORT(file)}`);
      return intakeOf(validateProject(root)).map(([l, p]) => [l, p]);
    };
    const outside = [["error", "intake.export.file"]];
    expect(check("../schema.csv")).toEqual(outside);
    expect(check("exports/../../schema.csv")).toEqual(outside);
    expect(check("../missing.csv")).toEqual(outside);
    expect(check(join(dir, "schema.csv"))).toEqual(outside);
    expect(check(join(root, "sources", "warehouse.yaml"))).toEqual(outside);
    symlinkSync(dir, join(root, "linked"));
    expect(check("linked/schema.csv")).toEqual(outside);
    expect(check("linked/missing.csv")).toEqual(outside);
    symlinkSync(join(dir, "gone"), join(root, "dangling"));
    expect(check("dangling/missing.csv")).toEqual(outside);
    expect(check("dangling")).toEqual(outside);
    expect(check("sources/warehouse.yaml")).toEqual([]);
    check("../schema.csv");
    expect(intakeOf(validateProject(root))[0]![2]).toContain("must be a path inside the semantic root");
  });

  test("the example layers validate unchanged, with no intake issues", () => {
    for (const ex of ["acme", "acme-export"]) {
      const issues = validateProject(join(REPO, "examples", ex, "semantic"));
      expect(issues.filter((i) => i.path.startsWith("intake"))).toEqual([]);
      expect(issues.filter((i) => i.file.startsWith("sources/"))).toEqual([]);
    }
    expect(validateProject(join(REPO, "examples", "acme", "semantic")).filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("sl add-source --schemas", () => {
  test("writes intake.schemas with mode connection, and the file validates", async () => {
    const t = tempRoot();
    try {
      await initProject(t.root);
      const r = await sl(t.root, ["add-source", "--name", "wh", "--dialect", "postgres", "--env", "WAREHOUSE_URL", "--schemas", "acme, marts", "--schemas", "core"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("schemas acme, marts, core");
      expect(r.out).toContain("Next: sl introspect --source wh --schemas acme,marts,core");
      const text = readFileSync(join(t.root, "sources", "wh.yaml"), "utf8");
      expect(text).toBe(
        "source: wh\ndialect: postgres\nconnection:\n  env: WAREHOUSE_URL\nintake:\n  mode: connection\n  schemas:\n    - acme\n    - marts\n    - core\n",
      );
      expect(validateProject(t.root).filter((i) => i.file === "sources/wh.yaml")).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("--json lists the schemas; without --schemas there is no intake block", async () => {
    const t = tempRoot();
    try {
      await initProject(t.root);
      const r = await sl(t.root, ["add-source", "--name", "bq", "--dialect", "bigquery", "--schemas", "my-project.acme", "--json"]);
      expect(r.code).toBe(0);
      const out = r.json<{ schemas: string[]; next: string }>();
      expect(out.schemas).toEqual(["my-project.acme"]);
      expect(out.next).toStartWith("sl introspect --source bq --schemas my-project.acme --emit-sql");
      const plain = await sl(t.root, ["add-source", "--name", "lake", "--dialect", "duckdb", "--json"]);
      expect(plain.json<{ schemas: string[] }>().schemas).toEqual([]);
      expect(readYaml<Record<string, unknown>>(join(t.root, "sources", "lake.yaml")).intake).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });

  test("refuses a name that is not a schema name, a repeat and an empty list, writing nothing", async () => {
    const t = tempRoot();
    try {
      await initProject(t.root);
      const base = ["add-source", "--name", "wh", "--dialect", "postgres", "--env", "WAREHOUSE_URL"];
      const bad = await sl(t.root, [...base, "--schemas", "acme,a.b.c"]);
      expect(bad.code).not.toBe(0);
      expect(bad.err).toContain("--schemas: name 2 is not a schema name");
      expect(bad.err).toContain("run sl add-source again");
      const dup = await sl(t.root, [...base, "--schemas", "acme,acme"]);
      expect(dup.err).toContain('--schemas: name 2 repeats name 1 ("acme")');
      const empty = await sl(t.root, [...base, "--schemas", " , "]);
      expect(empty.err).toContain("--schemas needs at least one schema name");
      const hyphen = await sl(t.root, [...base, "--schemas", "my-project.acme"]);
      expect(hyphen.err).toContain("is not a schema name");
      expect(validateProject(t.root).some((i) => i.file === "sources/wh.yaml")).toBe(false);
      expect(() => readFileSync(join(t.root, "sources", "wh.yaml"))).toThrow();
      const caseOnly = await sl(t.root, [...base, "--schemas", "acme,ACME"]);
      expect(caseOnly.code).toBe(0);
      expect(caseOnly.out).toContain("--schemas: name 2 differs from name 1");
    } finally {
      t.cleanup();
    }
  });

  test("refuses a dotted postgres name, and notes a DuckDB name of the opened database", async () => {
    const t = tempRoot();
    try {
      await initProject(t.root);
      const pg = await sl(t.root, ["add-source", "--name", "wh", "--dialect", "postgres", "--env", "WAREHOUSE_URL", "--schemas", "memory.main"]);
      expect(pg.code).not.toBe(0);
      expect(pg.err).toContain("--schemas: name 1 names another database's schema");
      const dd = await sl(t.root, ["add-source", "--name", "dd", "--dialect", "duckdb", "--schemas", "memory.main"]);
      expect(dd.code).toBe(0);
      expect(dd.out).toContain("--schemas: name 1 names a schema of the database this source opens (memory)");
      expect(dd.out).toContain("write main");
    } finally {
      t.cleanup();
    }
  });

  test("the next hint single-quotes a schema list holding $, and a refused value is never echoed", async () => {
    const t = tempRoot();
    try {
      await initProject(t.root);
      const r = await sl(t.root, ["add-source", "--name", "wh", "--dialect", "postgres", "--env", "WAREHOUSE_URL", "--schemas", "Sales$1,core"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Next: sl introspect --source wh --schemas 'Sales$1,core'");
      const secret = await sl(t.root, ["add-source", "--name", "wh2", "--dialect", "postgres", "--env", "WAREHOUSE_URL", "--schemas", "acme,postgres://u:hunter2@h/db"]);
      expect(secret.code).not.toBe(0);
      expect(secret.err + secret.out).not.toContain("hunter2");
    } finally {
      t.cleanup();
    }
  });

  test("a later edit of the source keeps the owner's comments in the intake block", async () => {
    const { root } = withIntake("intake:  # how the catalog reaches us\n  mode: connection   # the owner can connect\n  schemas: [public]  # only public\n");
    const r = await sl(root, ["scope", "--source", "warehouse", "--exclude", "*_old", "--write"]);
    expect(r.code).toBe(0);
    const text = readFileSync(join(root, FILE), "utf8");
    expect(text).toContain("intake:  # how the catalog reaches us\n  mode: connection   # the owner can connect\n  schemas: [public]  # only public\n");
    expect(text).toContain("*_old");
    expect(intakeOf(validateProject(root))).toEqual([]);
  });
});

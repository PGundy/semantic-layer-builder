// Issue codes (lib/issue-codes/): every issue semlayer validate reports carries a code registered in
// one family file, codes are well formed and unique, each check of lib/validate.ts and each rule file
// under lib/validate-rules/ passes a code on every report, and the code of a typed edit's warning
// decides whether the edit is refused.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODE_PATTERN, isRegistered, issueCodes, loadCodes } from "../skills/semantic-layer/scripts/lib/issue-codes/index.ts";
import { neverRight } from "../skills/semantic-layer/scripts/lib/edit.ts";
import { schemaIssues } from "../skills/semantic-layer/scripts/lib/schema.ts";
import { type Issue, trackedEnvFileIssues, Validator, validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { loadRules } from "../skills/semantic-layer/scripts/lib/validate-rules/index.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { semlayer, tempDir } from "./helpers.ts";

const REPO = join(import.meta.dir, "..");
const LIB = join(REPO, "skills", "semantic-layer", "scripts", "lib");
const CODES_DIR = join(LIB, "issue-codes");
const RULES_DIR = join(LIB, "validate-rules");
const VALID = join(import.meta.dir, "fixtures", "valid");

// Every semantic root under tests/fixtures and examples/.
function fixtureRoots(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (existsSync(join(dir, "semantic.yaml"))) out.push(dir);
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && e.name !== "node_modules") walk(join(dir, e.name));
  };
  walk(join(REPO, "tests", "fixtures"));
  walk(join(REPO, "examples"));
  return out.sort();
}

function copyValid(): string {
  const root = join(tempDir("codes"), "semantic");
  cpSync(VALID, root, { recursive: true });
  return root;
}

function unregistered(issues: Issue[]): Issue[] {
  return issues.filter((i) => typeof i.code !== "string" || !isRegistered(i.code));
}

const codesOf = (issues: Issue[]) => [...new Set(issues.map((i) => i.code))].sort();

// The placeholder code checks reported before each had a code of its own; it is retired.
const RETIRED = "issue.unclassified";

// Every issue's code is registered, is not the retired placeholder, and gives the issue's level.
function expectCoded(issues: Issue[]): void {
  expect(unregistered(issues)).toEqual([]);
  for (const i of issues) {
    expect(i.code).not.toBe(RETIRED);
    expect([i.code, i.level]).toEqual([i.code, issueCodes().get(i.code)!.level]);
  }
}

describe("the registry", () => {
  test("every code is well formed, has a level and a one-line meaning, and is registered once across the family files", () => {
    const codes = issueCodes();
    expect(codes.size).toBeGreaterThan(0);
    expect(codes.has(RETIRED)).toBe(false);
    for (const [code, info] of codes) {
      expect(code).toMatch(CODE_PATTERN);
      expect(code).toMatch(/^[a-z_]+\.[a-z0-9_]+$/);
      expect(["error", "warning"]).toContain(info.level);
      expect(info.meaning.trim().length).toBeGreaterThan(0);
      expect(info.meaning).not.toContain("\n");
    }
    // Read straight from the files, so a code two files share is counted twice here.
    let total = 0;
    for (const file of readdirSync(CODES_DIR).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
      const text = readFileSync(join(CODES_DIR, file), "utf8");
      total += [...text.matchAll(/^\s*"([^"]+)":\s*\{\s*level:/gm)].length;
    }
    expect(total).toBe(codes.size);
  });

  test("the families are found by file name, and a malformed or repeated code, or a file with no map, is refused naming the file", () => {
    const dir = tempDir("codes-dir");
    writeFileSync(join(dir, "index.ts"), "");
    writeFileSync(join(dir, "a.ts"), `export default { "a.one": { level: "error", meaning: "One." } };\n`);
    writeFileSync(join(dir, "b.ts"), `export default { "b.two": { level: "warning", meaning: "Two.", next: "semlayer validate" } };\n`);
    expect([...loadCodes(dir).entries()]).toEqual([
      ["a.one", { level: "error", meaning: "One.", file: "a.ts" }],
      ["b.two", { level: "warning", meaning: "Two.", next: "semlayer validate", file: "b.ts" }],
    ]);
    const refused = (name: string, body: string, words: string) => {
      const bad = tempDir("codes-bad");
      writeFileSync(join(bad, "index.ts"), "");
      writeFileSync(join(bad, "a.ts"), `export default { "a.one": { level: "error", meaning: "One." } };\n`);
      writeFileSync(join(bad, name), body);
      expect(() => loadCodes(bad)).toThrow(words);
    };
    refused("b.ts", `export default { "a.one": { level: "error", meaning: "Again." } };\n`, "a.one is already registered in a.ts");
    refused("b.ts", `export default { "B.Two": { level: "error", meaning: "Two." } };\n`, "B.Two is not a code");
    refused("b.ts", `export default { "two": { level: "error", meaning: "Two." } };\n`, "two is not a code");
    refused("b.ts", `export default { "b.two": { level: "fatal", meaning: "Two." } };\n`, "b.two needs level error or warning");
    refused("b.ts", `export default { "b.two": { level: "error", meaning: "Two\\nlines." } };\n`, "b.two needs a meaning of one line");
    refused("b.ts", `export default { "b.two": { level: "error", meaning: "" } };\n`, "b.two needs a meaning of one line");
    refused("b.ts", `export const x = 1;\n`, "b.ts has no default export map of codes");
  });
});

describe("codes on issues", () => {
  test("over every fixture and example layer, every issue has a registered code", () => {
    const roots = fixtureRoots();
    expect(roots.length).toBeGreaterThanOrEqual(3);
    for (const root of roots) {
      const issues = [...validateProject(root), ...trackedEnvFileIssues(root, {})];
      expect({ root, missing: unregistered(issues) }).toEqual({ root, missing: [] });
      expectCoded(issues);
    }
  });

  test("a missing version in semantic.yaml is schema.required at version, and each schema keyword has its code", () => {
    const root = copyValid();
    const project = readYaml<Record<string, unknown>>(join(root, "semantic.yaml"));
    delete project.version;
    writeYaml(join(root, "semantic.yaml"), project);
    const issues = validateProject(root);
    expect(unregistered(issues)).toEqual([]);
    expect(issues.find((i) => i.file === "semantic.yaml" && i.path === "version")).toMatchObject({ level: "error", message: "is required", code: "schema.required" });

    const at = (data: unknown) => schemaIssues("project", data, "semantic.yaml").map((i) => [i.path, i.code]);
    const base = { version: 1, name: "acme" };
    expect(at({ ...base, colour: "red" })).toEqual([["colour", "schema.unknown_property"]]);
    expect(at({ ...base, version: 2 })).toEqual([["version", "schema.enum"]]);
    expect(at({ ...base, name: "Acme" })).toEqual([["name", "schema.pattern"]]);
    expect(at({ ...base, settings: { focus_threshold: "twelve" } })).toEqual([["settings.focus_threshold", "schema.type"]]);
    expect(at({ ...base, settings: { focus_threshold: 0 } })).toEqual([["settings.focus_threshold", "schema.other"]]);
    expect(schemaIssues("source", { source: "lake", dialect: "duckdb", intake: { mode: "later" } }, "sources/lake.yaml").map((i) => [i.path, i.code])).toEqual([
      ["intake.mode", "schema.enum"],
    ]);
  });

  test("every source, intake and env code is reported where its check finds the problem", () => {
    const root = copyValid();
    mkdirSync(join(root, "exports", "folder"), { recursive: true });
    // An export with no reason, an empty schema list and a path outside the root.
    writeYaml(join(root, "sources", "a.yaml"), {
      source: "a",
      dialect: "postgres",
      connection: { env: "A_URL" },
      intake: { mode: "export", schemas: [], export: { file: "../outside.csv" } },
    });
    // An export block in connection mode naming a missing file, and bad, repeated and case-folded schemas.
    writeYaml(join(root, "sources", "b.yaml"), {
      source: "b",
      dialect: "postgres",
      connection: { env: "B_URL" },
      intake: { mode: "connection", export: { file: "exports/none.csv" }, schemas: ["not a name!", "sales", "sales", "Sales"] },
    });
    // A DuckDB setup statement and view the adapter refuses, an export path that is a directory and
    // a schema of the database the source opens.
    writeYaml(join(root, "sources", "c.yaml"), {
      source: "c",
      dialect: "duckdb",
      connection: { database: "shop.duckdb", setup: ["DROP TABLE x"], views: { v: "select 1; drop table y" } },
      intake: { mode: "export", reason: "no network from the laptop", export: { file: "exports/folder" }, schemas: ["shop.main"] },
    });
    const issues = validateProject(root);
    expect(unregistered(issues)).toEqual([]);
    const pick = (file: string) => issues.filter((i) => i.file === file && /^(intake|source)\./.test(i.code)).map((i) => [i.level, i.path, i.code]);
    expect(pick("sources/a.yaml")).toEqual([
      ["warning", "intake.reason", "intake.reason_missing"],
      ["warning", "intake.schemas", "intake.schemas_empty"],
      ["error", "intake.export.file", "intake.export_outside_root"],
    ]);
    expect(pick("sources/b.yaml")).toEqual([
      ["error", "intake.schemas[0]", "intake.schema_name_invalid"],
      ["error", "intake.schemas[2]", "intake.schema_repeated"],
      ["warning", "intake.schemas[3]", "intake.schema_case_differs"],
      ["error", "intake.export", "intake.export_in_connection_mode"],
      ["warning", "intake.export.file", "intake.export_file_missing"],
    ]);
    expect(pick("sources/c.yaml")).toEqual([
      ["error", "connection.setup[0]", "source.setup_not_allowed"],
      ["error", "connection.views.v", "source.view_not_one_table"],
      ["warning", "intake.schemas[0]", "intake.schema_in_own_database"],
      ["warning", "intake.export.file", "intake.export_not_a_file"],
    ]);
    // Each issue's level is its code's registered level.
    expectCoded(issues);
  });

  test("semlayer validate --json gives each issue its code, and the human lines stay as they were", async () => {
    const root = copyValid();
    const project = readYaml<Record<string, unknown>>(join(root, "semantic.yaml"));
    delete project.version;
    writeYaml(join(root, "semantic.yaml"), project);
    const json = await semlayer(root, ["validate", "--json"]);
    expect(json.code).toBe(1);
    const out = JSON.parse(json.out) as { issues: Record<string, unknown>[] };
    expect(out.issues.length).toBeGreaterThan(0);
    for (const i of out.issues) {
      expect(Object.keys(i)).toEqual(["level", "file", "path", "message", "code"]);
      expect(isRegistered(i.code as string)).toBe(true);
    }
    expect(out.issues).toContainEqual({ level: "error", file: "semantic.yaml", path: "version", message: "is required", code: "schema.required" });
    const human = await semlayer(root, ["validate"]);
    expect(human.out).toContain("semantic.yaml\n  error   version: is required\n");
    expect(human.out).not.toContain("schema.required");
  });
});

describe("codes on the checks of a layer's own files", () => {
  type Doc = Record<string, any>;
  const ORDERS = "models/warehouse/orders.yaml";
  const edit = (root: string, file: string, change: (doc: Doc) => void) => {
    const doc = readYaml<Doc>(join(root, file));
    change(doc);
    writeYaml(join(root, file), doc);
  };
  // The issue at file and path whose message holds words, with its code; fails listing every issue.
  const expectIssue = (issues: Issue[], level: Issue["level"], file: string, path: string, words: string, code: string) => {
    const hit = issues.find((i) => i.level === level && i.file === file && i.path === path && i.message.includes(words));
    if (!hit) throw new Error(`expected ${level} ${file} ${path} "${words}", got:\n${JSON.stringify(issues, null, 2)}`);
    expect({ path, code: hit.code }).toEqual({ path, code });
  };

  // Each mutation of the valid fixture, the issue it adds and that issue's code.
  const cases: [string, (root: string) => void, Issue["level"], string, string, string, string][] = [
    ["an unknown default source", (r) => edit(r, "semantic.yaml", (d) => void (d.default_source = "nowhere")), "error", "semantic.yaml", "default_source", 'names unknown source "nowhere"', "ref.unknown_source"],
    ["a model named unlike its file", (r) => edit(r, ORDERS, (d) => void (d.model = "ordrs")), "error", ORDERS, "model", "but the file is named orders.yaml", "file.name_mismatch"],
    ["a time zone that is not IANA", (r) => edit(r, ORDERS, (d) => void (d.dimensions[0].time_zone = "Mars/Base")), "error", ORDERS, "dimensions[0].time_zone", "is not an IANA time zone", "time.zone_unknown"],
    ["time grains on a string dimension", (r) => edit(r, ORDERS, (d) => void (d.dimensions[1].time_grains = ["day"])), "error", ORDERS, "dimensions[1].time_grains", "is only allowed on time dimensions", "time.not_time_dimension"],
    ["a join to no model", (r) => edit(r, ORDERS, (d) => void (d.joins[0].to = "nobody")), "error", ORDERS, "joins[0].to", '"nobody" is not a model of source warehouse', "ref.unknown_model"],
    ["a one_to_many join", (r) => edit(r, ORDERS, (d) => void (d.joins[0].relationship = "one_to_many")), "warning", ORDERS, "joins[0].relationship", "one_to_many fans out", "model.join_one_to_many"],
    ["an expr that is not one expression", (r) => edit(r, ORDERS, (d) => void (d.dimensions[1].expr = "(status")), "error", ORDERS, "dimensions[1].expr", "", "expr.not_one_expression"],
    ["a filter naming neither a column nor a join", (r) => edit(r, ORDERS, (d) => void (d.measures[0].filter = "other.thing = 1")), "error", ORDERS, "measures[0].filter", 'other.thing: "other" is neither a column nor a join', "expr.unknown_name"],
    ["an ignored column the table lacks", (r) => edit(r, ORDERS, (d) => void (d.ignored_columns = ["nope"])), "warning", ORDERS, "ignored_columns[0]", '"nope" is not a column', "ignore.column_unknown"],
    ["a metric of an unknown source", (r) => edit(r, "metrics.yaml", (d) => void (d.metrics[0].source = "nowhere")), "error", "metrics.yaml", "metrics[0].source", 'names unknown source "nowhere"', "ref.unknown_source"],
    ["an allow.tags entry that is not protected", (r) => edit(r, "access.yaml", (d) => void (d.roles[0].allow.tags = ["finance"])), "warning", "access.yaml", "roles[0].allow.tags[0]", '"finance" is not a protected tag', "access.tag_not_protected"],
    ["a golden named unlike its file", (r) => edit(r, "goldens/aov_by_region.yaml", (d) => void (d.name = "aov")), "error", "goldens/aov_by_region.yaml", "name", "but the file is named aov_by_region.yaml", "file.name_mismatch"],
    ["a ledger line that is not JSON", (r) => writeFileSync(join(r, ".semlayer", "ledger.jsonl"), `${readFileSync(join(r, ".semlayer", "ledger.jsonl"), "utf8")}not json\n`), "error", ".semlayer/ledger.jsonl", `line ${readFileSync(join(VALID, ".semlayer", "ledger.jsonl"), "utf8").split("\n").length}`, "is not valid JSON", "ledger.invalid_json"],
  ];
  for (const [name, mutation, level, file, path, words, code] of cases)
    test(`${name} is ${code}`, () => {
      const root = copyValid();
      mutation(root);
      const issues = validateProject(root);
      expectIssue(issues, level, file, path, words, code);
      expectCoded(issues);
    });

  test("a changed approved item is approval.hash_changed, whose next is the readback of the item, in --json and not in the human lines", async () => {
    const root = copyValid();
    edit(root, ORDERS, (d) => void (d.measures[0].expr = "amount_cents * 0.01"));
    const json = await semlayer(root, ["validate", "--json"]);
    expect(json.code).toBe(1);
    const issues = (JSON.parse(json.out) as { issues: Issue[] }).issues;
    expect(issues.find((i) => i.code === "approval.hash_changed")).toMatchObject({
      level: "error",
      file: ORDERS,
      code: "approval.hash_changed",
      next: "semlayer readback --targets warehouse.orders.revenue",
    });
    expect(issueCodes().get("approval.hash_changed")!.next).toBe("semlayer readback --targets <ref>");
    const human = await semlayer(root, ["validate"]);
    expect(human.out).toContain("warehouse.orders.revenue changed since it was approved");
    expect(human.out).not.toContain("approval.hash_changed");
  });

  test("items approved before content hashes are approval.stamp_hashes, whose next stamps them", () => {
    const root = copyValid();
    const strip = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) strip(p);
        else if (e.name.endsWith(".yaml")) writeFileSync(p, readFileSync(p, "utf8").replace(/^\s*approved_hash: .*\n/gm, ""));
      }
    };
    strip(root);
    const issues = validateProject(root).filter((i) => i.code === "approval.stamp_hashes");
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) expect(i).toMatchObject({ level: "warning", path: "", next: "semlayer approve --stamp-hashes" });
    expect(issues.map((i) => i.message).every((m) => m.includes("approved before content hashes"))).toBe(true);
  });

  test("a typed edit refused for a warning that can never be right keeps its words, decided by the warning's code", async () => {
    const root = join(tempDir("codes-acme"), "semantic");
    cpSync(join(REPO, "examples", "acme", "semantic"), root, { recursive: true });
    const tz = await semlayer(root, ["set", "warehouse.orders.order_date", "time_zone", "UTC"]);
    expect(tz.code).toBe(1);
    expect(tz.err).toBe(
      "semlayer set: Cannot set time_zone on warehouse.orders.order_date: semlayer validate would warn about the value, and it can never be right here, so nothing was written:\n" +
        "  - models/warehouse/orders.yaml dimensions[0].time_zone: names the zone timestamps without a time zone are stored in, but column created_at is timestamp with time zone, which carries its own; remove time_zone, and to count days in UTC write the expr as created_at at time zone 'UTC' (without it, days are counted in UTC when semlayer runs the query)\n" +
        "Leave the key out or give a value the warning allows, then run it again; semlayer validate lists the project's issues.",
    );
    const div = await semlayer(root, ["set", "lake.marketing_spend.spend", "expr", "spend_cents / 100.0"]);
    expect(div.code).toBe(1);
    expect(div.err).toBe(
      "semlayer set: Cannot set expr on lake.marketing_spend.spend: semlayer validate would warn about the value, and it can never be right here, so nothing was written:\n" +
        '  - models/lake/marketing_spend.yaml measures[0].expr: divides by a numeric literal; on duckdb "/ 100.0" gives a DOUBLE, so write <col> * 0.01 for an exact amount; this warning never stands\n' +
        "Leave the key out or give a value the warning allows, then run it again; semlayer validate lists the project's issues.",
    );
    const warning = (code: string, message = "words of any kind"): Issue => ({ level: "warning", file: "f.yaml", path: "dimensions[0].description", message, code });
    for (const code of ["time.zone_carries_own", "expr.divides_by_literal", "ignore.column_read"]) {
      expect(neverRight(warning(code))).toBe(true);
      expect(neverRight({ ...warning(code), level: "error" })).toBe(false);
    }
    // The words alone no longer decide: a warning with other words and another code stands.
    expect(neverRight(warning("model.join_one_to_many", "this warning never stands, which carries its own, so it is not left out"))).toBe(false);
  });

  test("a typed edit's --json and semlayer apply --json carry warning_issues beside the unchanged warnings", async () => {
    const acme = join(REPO, "examples", "acme", "semantic");
    const line =
      "models/warehouse/orders.yaml joins[0].relationship: one_to_many fans out and multiplies the measures of orders; aggregate customers before joining and confirm with the owner";
    const issue = {
      code: "model.join_one_to_many",
      file: "models/warehouse/orders.yaml",
      path: "joins[0].relationship",
      message: "one_to_many fans out and multiplies the measures of orders; aggregate customers before joining and confirm with the owner",
    };
    const one = join(tempDir("codes-set"), "semantic");
    cpSync(acme, one, { recursive: true });
    const set = await semlayer(one, ["set", "warehouse.orders.customer", "relationship", "one_to_many", "--json"]);
    expect(set.code).toBe(0);
    const out = JSON.parse(set.out) as { warnings: string[]; warning_issues: Pick<Issue, "code" | "file" | "path" | "message">[] };
    expect(out.warnings).toContain(line);
    expect(out.warning_issues).toContainEqual(issue);
    // One object per line, in the same order.
    expect(out.warning_issues.map((i) => `${i.file} ${i.path}: ${i.message}`)).toEqual(out.warnings);
    expectCoded(out.warning_issues.map((i) => ({ ...i, level: "warning" as const })));

    const two = join(tempDir("codes-apply"), "semantic");
    cpSync(acme, two, { recursive: true });
    const file = join(tempDir("codes-edits"), "edits.json");
    writeFileSync(file, JSON.stringify({ edits: [["set", "warehouse.orders.customer", "relationship", "one_to_many"], ["set", "warehouse.orders", "grain", "One row per order placed."]] }));
    const apply = await semlayer(two, ["apply", "--file", file, "--json"]);
    expect(apply.code).toBe(0);
    const batch = JSON.parse(apply.out) as { applied: { warnings?: string[] }[]; warnings: string[]; warning_issues: Pick<Issue, "code" | "file" | "path" | "message">[] };
    expect(batch.warnings).toContain(line);
    expect(batch.applied[0]!.warnings).toContain(line);
    expect(batch.warning_issues).toContainEqual(issue);
    expect(batch.warning_issues.map((i) => `${i.file} ${i.path}: ${i.message}`)).toEqual(batch.warnings);
    // Without --json the lines are as before.
    const plain = join(tempDir("codes-plain"), "semantic");
    cpSync(acme, plain, { recursive: true });
    const human = await semlayer(plain, ["set", "warehouse.orders.customer", "relationship", "one_to_many"]);
    expect(human.out.split("\n")).toContain(`Warning: ${line}`);
    expect(human.out).not.toContain("model.join_one_to_many");
  });
});

describe("rule files pass a code", () => {
  test("a rule file's code reaches the issue through the view's bound error and warn", () => {
    const dir = tempDir("codes-rule");
    writeFileSync(join(dir, "index.ts"), "");
    writeFileSync(
      join(dir, "probe.ts"),
      `export default (ctx) => {
  ctx.error("semantic.yaml", "probe", "probe refuses; fix it, then run semlayer validate", "schema.other");
  ctx.warn("semantic.yaml", "probe", "probe warns; run semlayer validate", "intake.schemas_empty");
  const { error } = ctx;
  error("semantic.yaml", "probe", "probe refuses through a destructured call", "source.setup_not_allowed");
};
`,
    );
    const v = new Validator(VALID);
    v.run();
    const before = v.issues.length;
    for (const { rule } of loadRules(dir)) rule(v.view());
    expect(v.issues.slice(before).map((i) => [i.level, i.code])).toEqual([
      ["error", "schema.other"],
      ["warning", "intake.schemas_empty"],
      ["error", "source.setup_not_allowed"],
    ]);
  });

  test("the static scan finds a report without a code, and a quoted code that is not registered", () => {
    const sample = `export default (ctx: RuleContext) => {
  // ctx.error("not", "a call") in a comment
  const s = "ctx.warn('in', 'a string')";
  ctx.error(file, \`models[\${i}].x\`, \`has \${f(a, b)}, so fix it\`, "schema.other");
  ctx.warn(file, path, "no code, here");
  ctx.error(file, path, "unknown code", "nobody.registered_this");
  console.error("printed");
  const { error, warn } = ctx;
  warn(file, path, "destructured, no code");
  error(file, path, message, "schema.other");
  onerror(file);
  function warn(f) {}
  ctx.warn(
    file,
    path,
    message,
    CODE,
  );
};
`;
    expect(uncodedReports(sample)).toEqual([
      { line: 5, problem: "no code" },
      { line: 6, problem: "code nobody.registered_this is not registered" },
      { line: 9, problem: "no code" },
    ]);
  });

  test("no file under lib/validate-rules/ calls error or warn without a registered code", () => {
    const found: string[] = [];
    for (const file of readdirSync(RULES_DIR).sort()) {
      if (!file.endsWith(".ts") || file === "index.ts") continue;
      for (const p of uncodedReports(readFileSync(join(RULES_DIR, file), "utf8"))) found.push(`lib/validate-rules/${file}:${p.line}: ${p.problem}`);
    }
    expect(found).toEqual([]);
  });

  test("no check of lib/validate.ts calls error or warn without a registered code, and none names the retired placeholder", () => {
    const src = readFileSync(join(LIB, "validate.ts"), "utf8");
    // The scan reads this.error( and this.warn( as method calls; the file has well over a hundred.
    expect([...src.matchAll(/this\.(error|warn)\(/g)].length).toBeGreaterThan(100);
    expect(uncodedReports(src)).toEqual([]);
    for (const file of [...readdirSync(LIB, { recursive: true })].map(String).filter((f) => f.endsWith(".ts")))
      expect({ file, retired: readFileSync(join(LIB, file), "utf8").includes(RETIRED) }).toEqual({ file, retired: false });
  });
});

// The error and warn calls of a source file, as methods (ctx.error) or bare (error taken out of the
// context), that pass fewer than four arguments, or whose fourth is a quoted code the registry
// lacks. Strings, template literals and comments are skipped; console.error, console.warn, other
// names ending in error or warn and a function named error or warn are not reports.
function uncodedReports(src: string): { line: number; problem: string }[] {
  const out: { line: number; problem: string }[] = [];
  for (let i = 0; i < src.length; ) {
    const past = pastLiteral(src, i);
    if (past !== i) {
      i = past;
      continue;
    }
    // A method call (ctx.error) or a bare call of error or warn taken out of the context.
    const m = /^\.?(error|warn)\s*\(/.exec(src.slice(i, i + 12));
    const before = src.slice(Math.max(0, i - 12), i);
    const bare = m !== null && !m[0].startsWith(".");
    if (m && !/console\s*$/.test(before) && !(bare && /([\w$.]|function\s+)$/.test(before))) {
      const open = i + m[0].length - 1;
      const args = callArgs(src, open);
      const line = src.slice(0, i).split("\n").length;
      const code = args[3];
      if (args.length < 4) out.push({ line, problem: "no code" });
      else if (code && /^["'][^"']*["']$/.test(code) && !isRegistered(code.slice(1, -1))) out.push({ line, problem: `code ${code.slice(1, -1)} is not registered` });
      i = open + 1;
      continue;
    }
    i++;
  }
  return out;
}

// The index just past the string, template literal or comment that starts at i, or i itself.
function pastLiteral(s: string, i: number): number {
  const c = s[i];
  const n = s[i + 1];
  if (c === "/" && n === "/") {
    const e = s.indexOf("\n", i);
    return e < 0 ? s.length : e;
  }
  if (c === "/" && n === "*") {
    const e = s.indexOf("*/", i + 2);
    return e < 0 ? s.length : e + 2;
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (c === "`") {
    let j = i + 1;
    while (j < s.length && s[j] !== "`") {
      if (s[j] === "\\") j += 2;
      else if (s[j] === "$" && s[j + 1] === "{") j = pastBracket(s, j + 1);
      else j++;
    }
    return j + 1;
  }
  return i;
}

// The index just past the bracket that closes the one at i.
function pastBracket(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; ) {
    const past = pastLiteral(s, j);
    if (past !== j) {
      j = past;
      continue;
    }
    if ("([{".includes(s[j]!)) depth++;
    else if (")]}".includes(s[j]!) && --depth === 0) return j + 1;
    j++;
  }
  return s.length;
}

// The argument texts of the call whose "(" is at open.
function callArgs(s: string, open: number): string[] {
  const close = pastBracket(s, open) - 1;
  const args: string[] = [];
  let start = open + 1;
  let depth = 0;
  for (let j = open + 1; j < close; ) {
    const past = pastLiteral(s, j);
    if (past !== j) {
      j = past;
      continue;
    }
    if ("([{".includes(s[j]!)) depth++;
    else if (")]}".includes(s[j]!)) depth--;
    else if (s[j] === "," && depth === 0) {
      args.push(s.slice(start, j).trim());
      start = j + 1;
    }
    j++;
  }
  const last = s.slice(start, close).trim();
  if (last) args.push(last);
  return args;
}

describe("check call sites", () => {
  test("every this.error / this.warn in lib/validate.ts passes a code registered at that level", () => {
    const text = readFileSync(join(LIB, "validate.ts"), "utf8");
    const sites = [...text.matchAll(/this\.(error|warn)\((?:[^;]|;(?!\s*\n))*?,\s*"([a-z_]+\.[a-z0-9_]+)"\s*\);/g)];
    expect(sites.length).toBeGreaterThan(100);
    for (const [, kind, code = ""] of sites) {
      const info = issueCodes().get(code);
      expect(info ? [code, info.level] : [code, "unregistered"]).toEqual([code, kind === "error" ? "error" : "warning"]);
    }
  });
});

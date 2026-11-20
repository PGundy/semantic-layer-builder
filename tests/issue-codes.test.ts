// Issue codes (lib/issue-codes/): every issue semlayer validate reports carries a code registered in
// one family file, codes are well formed and unique, and a rule file under lib/validate-rules/
// passes a code on every report.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODE_PATTERN, isRegistered, issueCodes, loadCodes, UNCLASSIFIED } from "../skills/semantic-layer/scripts/lib/issue-codes/index.ts";
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

describe("the registry", () => {
  test("every code is well formed, has a level and a one-line meaning, and is registered once across the family files", () => {
    const codes = issueCodes();
    expect(codes.size).toBeGreaterThan(0);
    expect(codes.has(UNCLASSIFIED)).toBe(true);
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
    const pick = (file: string) => issues.filter((i) => i.file === file && i.code !== UNCLASSIFIED).map((i) => [i.level, i.path, i.code]);
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
    for (const i of issues) if (i.code !== UNCLASSIFIED) expect([i.code, i.level]).toEqual([i.code, issueCodes().get(i.code)!.level]);
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

describe("rule files pass a code", () => {
  test("a rule file's code reaches the issue through the view's bound error and warn", () => {
    const dir = tempDir("codes-rule");
    writeFileSync(join(dir, "index.ts"), "");
    writeFileSync(
      join(dir, "probe.ts"),
      `export default (ctx) => {
  ctx.error("semantic.yaml", "probe", "probe refuses; fix it, then run semlayer validate", "schema.other");
  ctx.warn("semantic.yaml", "probe", "probe warns; run semlayer validate", "intake.schemas_empty");
  ctx.warn("semantic.yaml", "probe", "probe warns without a code");
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
      ["warning", UNCLASSIFIED],
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

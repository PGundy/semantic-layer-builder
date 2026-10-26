// Structural (JSON Schema) and semantic (cross-reference) validation of a semantic root.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import { quoteIdent } from "./dialect.ts";
import { findTable } from "./naming.ts";
import { matchesDotted, validatePattern } from "./patterns.ts";
import { parseRequestField } from "./refs.ts";
import type {
  AccessFile,
  Dialect,
  Dimension,
  Golden,
  Join,
  Measure,
  Metric,
  MetricsFile,
  Model,
  Project,
  Snapshot,
  SnapshotTable,
  SourceConfig,
} from "./types.ts";
import { DIALECTS, TIME_GRAINS, TO_ONE_RELATIONSHIPS } from "./types.ts";

export interface Issue {
  level: "error" | "warning";
  file: string;
  path: string;
  message: string;
}

export const SCHEMA_KINDS = ["project", "source", "snapshot", "model", "metrics", "access", "golden"] as const;
export type SchemaKind = (typeof SCHEMA_KINDS)[number];

export const SCHEMAS_DIR = join(import.meta.dir, "..", "..", "schemas");

let validators: Map<SchemaKind, ValidateFunction> | undefined;

function getValidator(kind: SchemaKind): ValidateFunction {
  if (!validators) {
    const ajv = new Ajv2020({ allErrors: true, strictTypes: false, strictTuples: false });
    ajv.addFormat("date", { type: "string", validate: isCalendarDate });
    validators = new Map();
    for (const k of SCHEMA_KINDS) {
      const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${k}.schema.json`), "utf8")) as object;
      validators.set(k, ajv.compile(schema));
    }
  }
  return validators.get(kind)!;
}

// True unless the string has the YYYY-MM-DD shape and names no real day; the shape itself is the schema pattern's job.
function isCalendarDate(value: string): boolean {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return true;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

// Turns a JSON pointer such as /measures/2/agg into measures[2].agg.
export function dottedPath(pointer: string, child?: string): string {
  const parts = pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (child !== undefined) parts.push(child);
  let out = "";
  for (const p of parts) out += /^\d+$/.test(p) ? `[${p}]` : out ? `.${p}` : p;
  return out;
}

function schemaMessage(e: ErrorObject): { path: string; message: string } | null {
  const params = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case "if":
      return null;
    case "required":
      return { path: dottedPath(e.instancePath, String(params.missingProperty)), message: "is required" };
    case "additionalProperties":
      return { path: dottedPath(e.instancePath, String(params.additionalProperty)), message: "is not a known property" };
    case "enum":
      return { path: dottedPath(e.instancePath), message: `must be one of: ${(params.allowedValues as unknown[]).map(String).join(", ")}` };
    case "const":
      return { path: dottedPath(e.instancePath), message: `must be ${JSON.stringify(params.allowedValue)}` };
    case "false schema":
      return { path: dottedPath(e.instancePath), message: "is not allowed here" };
    case "pattern":
      return { path: dottedPath(e.instancePath), message: `must match ${String(params.pattern)}` };
    case "format":
      return { path: dottedPath(e.instancePath), message: "must be a real calendar date (YYYY-MM-DD)" };
    case "not":
      return { path: dottedPath(e.instancePath), message: "must be a single value, not a list or object" };
    default:
      return { path: dottedPath(e.instancePath), message: e.message ?? e.keyword };
  }
}

// Checks one parsed document against the schema for its kind.
export function schemaIssues(kind: SchemaKind, data: unknown, file: string): Issue[] {
  const validate = getValidator(kind);
  if (validate(data)) return [];
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const e of validate.errors ?? []) {
    const m = schemaMessage(e);
    if (!m) continue;
    const key = `${m.path}\0${m.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ level: "error", file, ...m });
  }
  return out;
}


// ---------------------------------------------------------------------------
// Names an SQL expression refers to, read outside string literals, comments and {{ }} placeholders.

type SqlToken =
  | { t: "id"; v: string; quoted: boolean }
  | { t: "." }
  | { t: "(" }
  | { t: ")" }
  | { t: "," }
  | { t: ":" }
  | { t: "->" }
  | { t: "x" };

// Where a string literal starting at sql[i] (its opening quote) ends, just past the closing quote.
// A doubled quote stays inside it; with backslash escapes, so does a backslash-escaped character.
function stringEnd(sql: string, i: number, backslash: boolean): number {
  const q = sql[i]!;
  for (i++; i < sql.length; i++) {
    if (backslash && sql[i] === "\\") {
      i++;
      continue;
    }
    if (sql[i] !== q) continue;
    if (sql[i + 1] === q) i++;
    else break;
  }
  return i + 1;
}

function tokenizeSql(sql: string, dialect?: Dialect): SqlToken[] {
  // Snowflake, BigQuery and Databricks read backslash escapes in every string literal; BigQuery and
  // Databricks also read "..." as a string, and quote identifiers with backticks.
  const backslash = dialect === "snowflake" || dialect === "bigquery" || dialect === "databricks";
  const doubleIsString = dialect === "bigquery" || dialect === "databricks";
  const out: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1] ?? "";
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'" || (c === '"' && doubleIsString)) {
      i = stringEnd(sql, i, backslash);
      out.push({ t: "x" });
    } else if ((c === "E" || c === "e") && next === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "")) {
      // An escape string, E'it\'s': a backslash escapes the next character.
      i = stringEnd(sql, i + 1, true);
      out.push({ t: "x" });
    } else if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (c === "-" && next === ">") {
      i += 2;
      out.push({ t: "->" });
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "{" && next === "{") {
      const end = sql.indexOf("}}", i + 2);
      i = end < 0 ? sql.length : end + 2;
      out.push({ t: "x" });
    } else if (c === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
      out.push({ t: "x" });
    } else if (c === '"' || c === "`") {
      let v = "";
      for (i++; i < sql.length; i++) {
        if (sql[i] === c) {
          if (sql[i + 1] !== c) break;
          i++;
        }
        v += sql[i];
      }
      i++;
      // A backtick name may hold a whole dotted path, such as `project.dataset.table`.
      const parts = c === "`" ? v.split(".") : [v];
      parts.forEach((part, pi) => {
        if (pi) out.push({ t: "." });
        out.push({ t: "id", v: part, quoted: true });
      });
    } else if (/\d/.test(c) || (c === "." && /\d/.test(next))) {
      i += sql.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i)![0].length;
      out.push({ t: "x" });
    } else if (/[A-Za-z_]/.test(c)) {
      const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_$]*/)![0];
      i += word.length;
      out.push({ t: "id", v: word, quoted: false });
    } else if (c === ":" && next === ":") {
      // A cast: the type name that follows is not a column.
      i += 2;
      out.push({ t: ":" });
    } else if (c === "." || c === "(" || c === ")" || c === "," || c === ":") {
      i++;
      out.push({ t: c });
    } else {
      i++;
      out.push({ t: "x" });
    }
  }
  return out;
}

interface SqlNames {
  subquery: boolean;
  // Dotted names that read as column references: not function calls, cast types, semi-structured
  // paths or fields of a lambda parameter. quoted[k] says whether parts[k] was a quoted identifier.
  chains: { parts: string[]; quoted: boolean[]; text: string }[];
}

// Names a lambda binds: x in `x -> ...`, a and b in `(a, b) -> ...` and x in DuckDB's `lambda x: ...`.
// A lambda is a function argument, so a lone x binds only after ( or a comma; Postgres's JSON
// operator, as in `customer.payload -> 'k'`, binds nothing.
function lambdaParams(tokens: SqlToken[]): Set<string> {
  const bound = new Set<string>();
  const add = (tok: SqlToken | undefined) => {
    if (tok?.t === "id") bound.add(tok.v.toLowerCase());
  };
  tokens.forEach((tok, i) => {
    if (tok.t === "->") {
      const prev = tokens[i - 1];
      const before = tokens[i - 2]?.t;
      if (prev?.t === "id" && (before === "(" || before === ",")) add(prev);
      else if (prev?.t === ")") {
        for (let j = i - 2; j >= 0 && tokens[j]!.t !== "("; j--) add(tokens[j]);
      }
    } else if (tok.t === "id" && !tok.quoted && tok.v.toLowerCase() === "lambda") {
      for (let j = i + 1; j < tokens.length && tokens[j]!.t !== ":"; j++) {
        const t = tokens[j]!;
        if (t.t === "id") add(t);
        else if (t.t !== ",") break;
      }
    }
  });
  return bound;
}

export function sqlNames(sql: string, dialect?: Dialect): SqlNames {
  const tokens = tokenizeSql(sql, dialect);
  const bound = lambdaParams(tokens);
  const names: SqlNames = { subquery: false, chains: [] };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.t !== "id") continue;
    const prev = tokens[i - 1];
    const parts = [tok.v];
    const quoted = [tok.quoted];
    let j = i;
    while (tokens[j + 1]?.t === "." && tokens[j + 2]?.t === "id") {
      const part = tokens[j + 2] as { v: string; quoted: boolean };
      parts.push(part.v);
      quoted.push(part.quoted);
      j += 2;
    }
    const call = tokens[j + 1]?.t === "(";
    i = j;
    if (parts.length === 1) {
      if (tok.quoted) continue;
      const word = tok.v.toLowerCase();
      // select, or a FROM-first (DuckDB) or TABLE (Postgres) query opening a parenthesis. trim(from x) is a call.
      const opensQuery = prev?.t === "(" && !(word === "from" && (tokens[i - 2] as { v?: string } | undefined)?.v?.toLowerCase() === "trim");
      if (word === "select" || (opensQuery && (word === "from" || word === "table"))) names.subquery = true;
      continue;
    }
    if (call || prev?.t === ":" || prev?.t === ".") continue;
    if (!quoted[0] && bound.has(parts[0]!.toLowerCase())) continue;
    names.chains.push({ parts, quoted, text: parts.join(".") });
  }
  return names;
}

type SqlRole = "dimension expr" | "measure expr" | "measure filter" | "row filter";

// What a role may name and where a rule that needs more goes.
const OUTSIDE_HINT: Record<SqlRole, string> = {
  "dimension expr":
    "name only this model's columns and <join>.<column> join references through its many_to_one or one_to_one joins; " +
    "for a rule that needs anything else, add a join to the model or ask the owner for a view that holds it",
  "measure filter":
    "name only this model's columns and <join>.<column> join references through its many_to_one or one_to_one joins; " +
    "for a rule that needs anything else, add a join to the model or ask the owner for a view that holds it",
  "measure expr": "name only this model's columns; put a joined column in the measure's filter or in a dimension, or ask the owner for a view",
  "row filter": "name only its model's columns; write a row filter on the joined model, or ask the owner for a view",
};

// ---------------------------------------------------------------------------

interface Loaded<T> {
  file: string; // relative to root
  stem: string;
  data: T;
  valid: boolean;
}

const BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOUBLE_QUOTED_IDENT = /^"((?:[^"]|"")+)"$/;
const BACKTICK_IDENT = /^`((?:[^`]|``)+)`$/;
const SQL_LITERALS = new Set(["true", "false", "null", "current_date", "current_timestamp", "current_time", "now"]);
const USER_PLACEHOLDER = /\{\{\s*user\.([A-Za-z0-9_]+)\s*\}\}/g;
const ANY_PLACEHOLDER = /\{\{[^{}]*\}\}/g;
const METRIC_PLACEHOLDER = /\{([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\}/g;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arr<T>(v: T[] | undefined | unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

// The objects of a list that carry a string name. Files that failed their schema are still read
// for references, so their lists may hold nulls or scalars.
function named<T extends { name: string }>(v: unknown): T[] {
  return arr<unknown>(v).filter((x): x is T => isObject(x) && typeof x.name === "string");
}

function strings(v: unknown): string[] {
  return arr<unknown>(v).filter((x): x is string => typeof x === "string");
}

function isDialect(v: unknown): v is Dialect {
  return typeof v === "string" && (DIALECTS as readonly string[]).includes(v);
}

// A snapshot table reduced to the shape lookups rely on, or undefined when it lacks that shape.
function usableTable(t: unknown): SnapshotTable | undefined {
  if (!isObject(t) || typeof t.name !== "string") return undefined;
  if (t.schema !== undefined && t.schema !== null && typeof t.schema !== "string") return undefined;
  return { ...(t as unknown as SnapshotTable), columns: named<SnapshotTable["columns"][number]>(t.columns) };
}

// How a source's SQL resolves an identifier against the column names in its snapshot. Folding is
// enforced only when the snapshot was read from the live catalog, whose names carry the true case.
interface IdentRules {
  dialect: Dialect | undefined;
  fold: "lower" | "upper" | "none";
  quotedExact: boolean;
}

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
}

class Validator {
  readonly issues: Issue[] = [];
  project?: Loaded<Project>;
  sources = new Map<string, Loaded<SourceConfig>>();
  snapshots = new Map<string, Loaded<Snapshot>>();
  models = new Map<string, Map<string, Loaded<Model>>>(); // source -> model name -> model
  modelList: Loaded<Model>[] = [];
  metrics?: Loaded<MetricsFile>;
  access?: Loaded<AccessFile>;
  accessPresent = false;
  goldens: Loaded<Golden>[] = [];

  constructor(readonly root: string) {}

  error(file: string, path: string, message: string): void {
    this.issues.push({ level: "error", file, path, message });
  }

  warn(file: string, path: string, message: string): void {
    this.issues.push({ level: "warning", file, path, message });
  }

  rel(abs: string): string {
    return relative(this.root, abs).split("\\").join("/");
  }

  // The YAML files of a directory paired with their stems. A stem defined by both a .yaml and a
  // .yml file is an error and only the .yaml file is read; a lone .yml file gets a warning because
  // other sl commands open <stem>.yaml.
  yamlEntries(dir: string): { file: string; stem: string }[] {
    const files = yamlFiles(dir);
    const out: { file: string; stem: string }[] = [];
    for (const f of files) {
      const stem = f.replace(/\.ya?ml$/, "");
      if (f.endsWith(".yml")) {
        if (files.includes(`${stem}.yaml`)) {
          this.error(this.rel(join(dir, f)), "", `${stem} is defined twice (${stem}.yaml and ${f}); delete one`);
          continue;
        }
        this.warn(this.rel(join(dir, f)), "", `other sl commands read ${stem}.yaml; rename this file`);
      }
      out.push({ file: f, stem });
    }
    return out;
  }

  // Reads and schema-checks one file; returns undefined when it cannot be parsed into an object.
  load<T>(abs: string, kind: SchemaKind, stem: string): Loaded<T> | undefined {
    const file = this.rel(abs);
    const text = readFileSync(abs, "utf8");
    let data: unknown;
    if (abs.endsWith(".json")) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        this.error(file, "", `invalid JSON: ${(e as Error).message.split("\n")[0]!.replace(/:$/, "")}`);
        return undefined;
      }
    } else {
      const doc = parseDocument(text);
      if (doc.errors.length) {
        this.error(file, "", `invalid YAML: ${doc.errors[0]!.message.split("\n")[0]!.replace(/:$/, "")}`);
        return undefined;
      }
      data = doc.toJS();
    }
    const structural = schemaIssues(kind, data, file);
    this.issues.push(...structural);
    if (!isObject(data)) return undefined;
    return { file, stem, data: data as T, valid: structural.length === 0 };
  }

  loadAll(): void {
    const projectPath = join(this.root, "semantic.yaml");
    if (!existsSync(projectPath)) this.error("semantic.yaml", "", "missing: run `sl init --name <name>` to create it");
    else this.project = this.load<Project>(projectPath, "project", "semantic");

    const sourcesDir = join(this.root, "sources");
    for (const { file: f, stem } of this.yamlEntries(sourcesDir)) {
      const l = this.load<SourceConfig>(join(sourcesDir, f), "source", stem);
      if (l) this.sources.set(stem, l);
    }

    const snapshotsDir = join(this.root, "snapshots");
    if (existsSync(snapshotsDir)) {
      for (const f of readdirSync(snapshotsDir).filter((x) => x.endsWith(".json")).sort()) {
        const stem = f.replace(/\.json$/, "");
        const l = this.load<Snapshot>(join(snapshotsDir, f), "snapshot", stem);
        if (l) this.snapshots.set(stem, l);
      }
    }

    const modelsDir = join(this.root, "models");
    if (existsSync(modelsDir)) {
      for (const entry of readdirSync(modelsDir).sort()) {
        const dir = join(modelsDir, entry);
        if (!statSync(dir).isDirectory()) {
          if (/\.ya?ml$/.test(entry)) this.error(this.rel(dir), "", "models live in models/<source>/<model>.yaml, not directly under models/");
          continue;
        }
        const byName = new Map<string, Loaded<Model>>();
        this.models.set(entry, byName);
        for (const { file: f, stem } of this.yamlEntries(dir)) {
          const l = this.load<Model>(join(dir, f), "model", stem);
          if (!l) continue;
          this.modelList.push(l);
          byName.set(stem, l);
        }
      }
    }

    const metricsPath = join(this.root, "metrics.yaml");
    if (existsSync(metricsPath)) this.metrics = this.load<MetricsFile>(metricsPath, "metrics", "metrics");
    const accessPath = join(this.root, "access.yaml");
    this.accessPresent = existsSync(accessPath);
    if (this.accessPresent) this.access = this.load<AccessFile>(accessPath, "access", "access");

    const goldensDir = join(this.root, "goldens");
    for (const { file: f, stem } of this.yamlEntries(goldensDir)) {
      const l = this.load<Golden>(join(goldensDir, f), "golden", stem);
      if (l) this.goldens.push(l);
    }
  }

  // Lookups ------------------------------------------------------------------

  model(source: string, name: string): Model | undefined {
    return this.models.get(source)?.get(name)?.data;
  }

  tablesCache = new Map<string, SnapshotTable[]>();

  // The usable tables of a source's snapshot, or undefined when it has no snapshot.
  snapshotTables(source: string): SnapshotTable[] | undefined {
    const snap = this.snapshots.get(source)?.data;
    if (!snap || !Array.isArray(snap.tables)) return undefined;
    let tables = this.tablesCache.get(source);
    if (!tables) {
      tables = snap.tables.map(usableTable).filter((t): t is SnapshotTable => t !== undefined);
      this.tablesCache.set(source, tables);
    }
    return tables;
  }

  snapshotTable(source: string, table: string): { snapshot: boolean; table?: SnapshotTable } {
    const tables = this.snapshotTables(source);
    if (!tables) return { snapshot: false };
    return { snapshot: true, table: findTable(tables, table) };
  }

  identRules(source: string): IdentRules {
    const fromSource = this.sources.get(source)?.data.dialect;
    const snap = this.snapshots.get(source)?.data;
    const dialect = isDialect(fromSource) ? fromSource : isDialect(snap?.dialect) ? snap.dialect : undefined;
    const catalog = snap?.method === "live" || snap?.method === "information_schema";
    if (!catalog) return { dialect, fold: "none", quotedExact: false };
    if (dialect === "postgres") return { dialect, fold: "lower", quotedExact: true };
    if (dialect === "snowflake") return { dialect, fold: "upper", quotedExact: true };
    return { dialect, fold: "none", quotedExact: false };
  }

  measure(source: string, model: string, name: string): Measure | undefined {
    return named<Measure>(this.model(source, model)?.measures).find((m) => m.name === name);
  }

  dimension(source: string, model: string, name: string): Dimension | undefined {
    return named<Dimension>(this.model(source, model)?.dimensions).find((d) => d.name === name);
  }

  metric(name: string): Metric | undefined {
    return named<Metric>(this.metrics?.data.metrics).find((m) => m.name === name);
  }

  // source.model for every model file, from its path (models/<source>/<model>.yaml), which is how
  // every lookup and every other sl command finds a model.
  allModelRefs(): string[] {
    const refs: string[] = [];
    for (const [source, byName] of this.models) for (const name of byName.keys()) refs.push(`${source}.${name}`);
    return refs;
  }

  // Checks ------------------------------------------------------------------

  checkProject(): void {
    const p = this.project;
    if (!p?.valid) return;
    if (p.data.default_source && !this.sources.has(p.data.default_source))
      this.error(p.file, "default_source", `names unknown source "${p.data.default_source}"`);
  }

  checkSources(): void {
    for (const [stem, l] of this.sources) {
      if (!l.valid) continue;
      const s = l.data;
      if (s.source !== stem) this.error(l.file, "source", `is "${s.source}" but the file is named ${stem}.yaml`);
      for (const key of ["include", "exclude"] as const) {
        arr<string>(s.scope?.[key]).forEach((p, i) => {
          const problem = validatePattern(p);
          if (problem) this.error(l.file, `scope.${key}[${i}]`, problem);
        });
      }
      if (s.dialect !== "duckdb") {
        for (const key of ["database", "setup", "views"] as const)
          if (s.connection?.[key] !== undefined) this.warn(l.file, `connection.${key}`, `is used only by duckdb sources, not ${s.dialect}`);
      }
    }
    for (const [stem, l] of this.snapshots) {
      if (!l.valid) continue;
      const snap = l.data;
      if (snap.source !== stem) this.error(l.file, "source", `is "${snap.source}" but the file is named ${stem}.json`);
      const src = this.sources.get(stem);
      if (!src) this.warn(l.file, "", `no source file sources/${stem}.yaml for this snapshot`);
      else if (src.valid && src.data.dialect !== snap.dialect)
        this.warn(l.file, "dialect", `is ${snap.dialect} but the source's dialect is ${src.data.dialect}`);
    }
  }

  // Errors when an expr that is a bare or quoted identifier does not resolve to a column of the
  // table the way the source's dialect resolves it. Other expressions are SQL and are not checked.
  checkColumnRef(file: string, path: string, expr: string | undefined, table: SnapshotTable | undefined, rules: IdentRules): void {
    if (!table || !table.columns.length || typeof expr !== "string") return;
    const trimmed = expr.trim();
    const backticks = rules.dialect === "bigquery" || rules.dialect === "databricks";
    const quoted = trimmed.match(backticks ? BACKTICK_IDENT : DOUBLE_QUOTED_IDENT);
    if (quoted) {
      const name = backticks ? quoted[1]!.replace(/``/g, "`") : quoted[1]!.replace(/""/g, '"');
      if (table.columns.some((c) => c.name === name)) return;
      const loose = table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (loose && !rules.quotedExact) return;
      const hint = loose ? `; quoted names are case-sensitive, write ${quoteIdent(rules.dialect ?? "postgres", loose.name)}` : "";
      this.error(file, path, `expr "${name}" is not a column of ${qualified(table)}${hint}`);
      return;
    }
    if (!BARE_IDENT.test(trimmed) || SQL_LITERALS.has(trimmed.toLowerCase())) return;
    const loose = table.columns.find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
    if (rules.fold === "none") {
      if (!loose) this.error(file, path, `expr "${trimmed}" is not a column of ${qualified(table)}`);
      return;
    }
    const folded = rules.fold === "lower" ? trimmed.toLowerCase() : trimmed.toUpperCase();
    if (table.columns.some((c) => c.name === folded)) return;
    if (loose)
      this.error(
        file,
        path,
        `expr ${trimmed} resolves to ${folded} in ${rules.dialect}, but the column is "${loose.name}"; write ${quoteIdent(rules.dialect ?? "postgres", loose.name)}`,
      );
    else this.error(file, path, `expr "${trimmed}" is not a column of ${qualified(table)}`);
  }

  // Errors when a physical column name (a join key or primary key entry) is not a column of the
  // table: an exact match first, then a case-insensitive one, as sl check-join resolves keys.
  checkColumnName(file: string, path: string, name: string | undefined, table: SnapshotTable | undefined): void {
    if (!table || !table.columns.length || typeof name !== "string") return;
    if (table.columns.some((c) => c.name === name)) return;
    if (table.columns.some((c) => c.name.toLowerCase() === name.toLowerCase())) return;
    const hint = /^(".*"|`.*`)$/.test(name.trim()) ? "; write the column name without quotes" : "";
    this.error(file, path, `"${name}" is not a column of ${qualified(table)}${hint}`);
  }

  // Checks the tables and join references an expr, filter or row filter names. A dimension expr
  // and a measure filter may use <join>.<column> through one of the model's own to-one joins; a
  // measure expr and a row filter use the model's own columns only. A subquery or another table
  // is an error everywhere.
  checkSqlRefs(file: string, path: string, sql: unknown, model: Model, role: SqlRole): void {
    if (typeof sql !== "string") return;
    const rules = this.identRules(model.source);
    const names = sqlNames(sql, rules.dialect);
    if (names.subquery) {
      this.error(file, path, `has a subquery; a ${role} may ${OUTSIDE_HINT[role]}`);
      return;
    }
    const table = typeof model.table === "string" ? this.snapshotTable(model.source, model.table).table : undefined;
    const own = table?.columns.length ? table.columns : undefined;
    const isOwn = (name: string) => !!own?.some((c) => c.name.toLowerCase() === name.toLowerCase());
    const joins = named<Join>(model.joins);
    const otherTables = new Set<string>();
    for (const t of this.snapshotTables(model.source) ?? []) {
      otherTables.add(t.name.toLowerCase());
      if (t.schema) otherTables.add(t.schema.toLowerCase());
    }
    for (const name of this.models.get(model.source)?.keys() ?? []) otherTables.add(name);
    const seen = new Set<string>();
    const report = (message: string) => {
      if (seen.has(message)) return;
      seen.add(message);
      this.error(file, path, message);
    };
    for (const { parts, quoted, text } of names.chains) {
      const [first, second] = parts as [string, string];
      // An unquoted join name matches in any case, as SQL resolves an unquoted alias; a quoted one exactly.
      const join = joins.find((j) => (quoted[0] ? j.name === first : j.name === first.toLowerCase()));
      // A dotted name on one of the model's own columns reads a struct field.
      if (!join && isOwn(first)) continue;
      if (join) {
        if (role === "measure expr") {
          report(`${text} is a join reference; a measure expr is over the model's own columns, so put the condition in the measure's filter or the field in a dimension`);
          continue;
        }
        if (role === "row filter") {
          report(`${text} is a join reference; a row filter is over its model's own columns, so write a row filter on the joined model instead`);
          continue;
        }
        if (!TO_ONE_RELATIONSHIPS.includes(join.relationship)) {
          report(`${text} goes through join ${join.name}, which is ${join.relationship}; a join reference needs a many_to_one or one_to_one join, because ${join.relationship} repeats ${model.model}'s rows`);
          continue;
        }
        const target = this.model(model.source, join.to);
        const targetTable = target && typeof target.table === "string" ? this.snapshotTable(model.source, target.table).table : undefined;
        const targetCols = targetTable?.columns.length ? targetTable.columns : undefined;
        const resolved = targetCols ? resolveColumn(second, quoted[1]!, targetCols, rules) : undefined;
        const isTarget = resolved === true;
        if (resolved !== undefined && resolved !== true) {
          const hint = resolved === false ? "" : `; ${resolved}`;
          report(`${text}: "${second}" is not a column of ${qualified(targetTable!)}, the table of model ${join.to} that join ${join.name} reaches${hint}`);
          continue;
        }
        if (parts.length > 2 && !isTarget)
          report(`${text} goes more than one hop; a join reference is <join>.<column> through one of ${model.model}'s own joins, so add a join from ${model.model} to the model you need`);
        continue;
      }
      if (parts.length > 2 || otherTables.has(first.toLowerCase())) {
        report(`${text} names a table or schema directly; a ${role} may ${OUTSIDE_HINT[role]}`);
        continue;
      }
      if (own) {
        const list = joins.length ? `its joins are ${joins.map((j) => j.name).join(", ")}` : "it has no joins";
        report(`${text}: "${first}" is neither a column nor a join of model ${model.model} (${list})`);
      }
    }
  }

  checkModels(): void {
    for (const l of this.modelList) {
      const dirSource = l.file.split("/")[1]!;
      if (!l.valid) continue;
      const m = l.data;
      const f = l.file;
      if (m.model !== l.stem) this.error(f, "model", `is "${m.model}" but the file is named ${l.stem}.yaml`);
      if (m.source !== dirSource) this.error(f, "source", `is "${m.source}" but the model lives in models/${dirSource}/`);
      if (!this.sources.has(m.source)) this.error(f, "source", `names unknown source "${m.source}" (no sources/${m.source}.yaml)`);

      const { snapshot, table } = this.snapshotTable(m.source, m.table);
      if (snapshot && !table) this.warn(f, "table", `"${m.table}" is not in snapshots/${m.source}.json`);

      if (m.status === "approved") {
        if (!m.grain) this.error(f, "grain", "is required on an approved model");
        if (!m.primary_key?.length) this.error(f, "primary_key", "is required on an approved model");
      }
      const rules = this.identRules(m.source);
      arr<string>(m.primary_key).forEach((c, i) => this.checkColumnName(f, `primary_key[${i}]`, c, table));

      const names = new Map<string, string>();
      const claim = (name: string, path: string) => {
        const prior = names.get(name);
        if (prior) this.error(f, `${path}.name`, `"${name}" is already used by ${prior}; dimensions, measures and joins share one namespace`);
        else names.set(name, path);
      };

      m.dimensions.forEach((d, i) => {
        const p = `dimensions[${i}]`;
        claim(d.name, p);
        this.checkColumnRef(f, `${p}.expr`, d.expr, table, rules);
        this.checkSqlRefs(f, `${p}.expr`, d.expr, m, "dimension expr");
        if (d.time_grains && d.type !== "time") this.error(f, `${p}.time_grains`, `is only allowed on time dimensions, not ${d.type}`);
      });

      m.measures.forEach((x, i) => {
        const p = `measures[${i}]`;
        claim(x.name, p);
        this.checkColumnRef(f, `${p}.expr`, x.expr, table, rules);
        this.checkSqlRefs(f, `${p}.expr`, x.expr, m, "measure expr");
        this.checkSqlRefs(f, `${p}.filter`, x.filter, m, "measure filter");
        if (x.status === "approved" && !x.description) this.error(f, `${p}.description`, "is required on an approved measure");
        this.checkCurrency(f, p, x.format, x.currency, x.status);
      });

      arr<NonNullable<Model["joins"]>[number]>(m.joins).forEach((j, i) => {
        const p = `joins[${i}]`;
        claim(j.name, p);
        const target = this.model(m.source, j.to);
        if (!target) this.error(f, `${p}.to`, `"${j.to}" is not a model of source ${m.source}`);
        const targetTable = target && typeof target.table === "string" ? this.snapshotTable(m.source, target.table).table : undefined;
        j.keys.forEach((k, ki) => {
          this.checkColumnName(f, `${p}.keys[${ki}].from`, k.from, table);
          this.checkColumnName(f, `${p}.keys[${ki}].to`, k.to, targetTable);
        });
        if (j.relationship === "one_to_many")
          this.warn(f, `${p}.relationship`, `one_to_many fans out and multiplies ${m.model}'s measures; aggregate ${j.to} before joining and confirm with the owner`);
        const ev = j.evidence;
        if (ev?.suggested_relationship === "many_to_many") {
          const msg = "evidence shows many_to_many: neither key is unique, so the join needs a bridge table or a pre-aggregated model";
          if (j.status === "approved") this.error(f, `${p}.evidence.suggested_relationship`, msg);
          else this.warn(f, `${p}.evidence.suggested_relationship`, msg);
        } else if (ev && ev.suggested_relationship !== j.relationship) {
          this.warn(f, `${p}.relationship`, `is ${j.relationship} but the evidence suggests ${ev.suggested_relationship}`);
        }
        if (j.status === "approved" && !ev) this.warn(f, p, "is approved without evidence; run `sl check-join`");
      });
    }
  }

  checkCurrency(file: string, path: string, format: string | undefined, currency: string | undefined, status: string | undefined): void {
    if (currency !== undefined && format !== "currency") this.error(file, `${path}.currency`, "is only allowed with format currency");
    if (format === "currency" && currency === undefined && status === "approved")
      this.warn(file, `${path}.currency`, "is missing on an approved item with format currency; add the ISO 4217 code, such as USD");
  }

  checkMetrics(): void {
    const l = this.metrics;
    if (!l?.valid) return;
    const f = l.file;
    const seen = new Map<string, number>();
    l.data.metrics.forEach((m, i) => {
      const p = `metrics[${i}]`;
      const prior = seen.get(m.name);
      if (prior !== undefined) this.error(f, `${p}.name`, `"${m.name}" is already defined at metrics[${prior}]`);
      else seen.set(m.name, i);
      if (!this.sources.has(m.source)) {
        this.error(f, `${p}.source`, `names unknown source "${m.source}"`);
        return;
      }
      if (m.status === "approved" && !m.description) this.error(f, `${p}.description`, "is required on an approved metric");
      this.checkCurrency(f, p, m.format, m.currency, m.status);

      const refs: { path: string; model: string; measure: string }[] = [];
      if (m.type === "ratio") {
        for (const side of ["numerator", "denominator"] as const) {
          const [model, measure] = m[side].split(".") as [string, string];
          refs.push({ path: `${p}.${side}`, model, measure });
        }
      } else {
        for (const match of m.expr.matchAll(METRIC_PLACEHOLDER)) refs.push({ path: `${p}.expr`, model: match[1]!, measure: match[2]! });
        if (!refs.length) this.error(f, `${p}.expr`, "has no {model.measure} placeholder");
        const rest = m.expr.replace(METRIC_PLACEHOLDER, "");
        if (!/^[\s\d.+\-*/()]*$/.test(rest)) this.error(f, `${p}.expr`, "may combine {model.measure} placeholders with numbers and + - * / ( ) only");
      }
      for (const r of refs) {
        const measure = this.measure(m.source, r.model, r.measure);
        if (!measure) {
          const why = this.model(m.source, r.model) ? `model ${r.model} has no measure "${r.measure}"` : `"${r.model}" is not a model of source ${m.source}`;
          this.error(f, r.path, `${r.model}.${r.measure} does not resolve: ${why}`);
        } else if (m.status === "approved" && measure.status !== "approved") {
          this.error(f, r.path, `an approved metric may use only approved measures; ${r.model}.${r.measure} is ${measure.status}`);
        }
      }
    });
  }

  // Resolves source.model.field to a dimension or measure.
  hasField(ref: string): boolean {
    const [source, model, field] = ref.split(".") as [string, string, string];
    return !!(this.dimension(source, model, field) ?? this.measure(source, model, field));
  }

  hasModel(ref: string): boolean {
    const [source, model] = ref.split(".") as [string, string];
    return !!this.model(source, model);
  }

  checkAccess(): void {
    const l = this.access;
    if (!l?.valid) return;
    const a = l.data;
    const f = l.file;
    const roleNames = new Map<string, number>();
    a.roles.forEach((r, i) => {
      const prior = roleNames.get(r.name);
      if (prior !== undefined) this.error(f, `roles[${i}].name`, `"${r.name}" is already defined at roles[${prior}]`);
      else roleNames.set(r.name, i);
    });
    if (a.default_role && !roleNames.has(a.default_role)) this.error(f, "default_role", `names unknown role "${a.default_role}"`);

    const attrs = new Set<string>();
    arr<NonNullable<AccessFile["user_attributes"]>[number]>(a.user_attributes).forEach((u, i) => {
      if (attrs.has(u.name)) this.error(f, `user_attributes[${i}].name`, `"${u.name}" is already defined`);
      attrs.add(u.name);
    });

    const usedTags = this.usedTags();
    const modelRefs = this.allModelRefs();
    a.roles.forEach((r, i) => {
      const p = `roles[${i}]`;
      r.allow.models.forEach((pat, pi) => {
        const problem = validatePattern(pat);
        if (problem) this.error(f, `${p}.allow.models[${pi}]`, problem);
        else if (!modelRefs.some((ref) => matchesDotted(pat, ref))) this.warn(f, `${p}.allow.models[${pi}]`, `"${pat}" matches no model`);
      });
      arr<string>(r.deny?.models).forEach((pat, pi) => {
        const problem = validatePattern(pat);
        if (problem) this.error(f, `${p}.deny.models[${pi}]`, problem);
      });
      arr<string>(r.deny?.fields).forEach((ref, fi) => {
        if (this.hasField(ref)) return;
        const [source, model, field] = ref.split(".") as [string, string, string];
        const join = named<Join>(this.model(source, model)?.joins).find((j) => j.name === field);
        const rule = "deny.fields names dimensions and measures only; a join is hidden from a role when its target model is not allowed or is denied for that role";
        if (join) this.error(f, `${p}.deny.fields[${fi}]`, `"${ref}" is a join; ${rule}, so deny ${source}.${join.to} to hide it`);
        else this.error(f, `${p}.deny.fields[${fi}]`, `"${ref}" is not a dimension or measure of any model; ${rule}`);
      });
      arr<string>(r.deny?.tags).forEach((tag, ti) => {
        if (!usedTags.has(tag)) this.warn(f, `${p}.deny.tags[${ti}]`, `tag "${tag}" is not used by any model, dimension, measure or metric`);
      });
      arr<NonNullable<typeof r.row_filters>[number]>(r.row_filters).forEach((rf, ri) => {
        const rp = `${p}.row_filters[${ri}]`;
        if (!this.hasModel(rf.model)) this.error(f, `${rp}.model`, `"${rf.model}" is not a model`);
        else {
          const [source, name] = rf.model.split(".") as [string, string];
          this.checkSqlRefs(f, `${rp}.expr`, rf.expr, this.model(source, name)!, "row filter");
        }
        for (const match of rf.expr.matchAll(USER_PLACEHOLDER))
          if (!attrs.has(match[1]!)) this.error(f, `${rp}.expr`, `{{ user.${match[1]} }} names an undeclared user attribute`);
        const rest = rf.expr.replace(USER_PLACEHOLDER, "");
        for (const match of rest.matchAll(ANY_PLACEHOLDER))
          this.error(f, `${rp}.expr`, `${match[0]} is not a placeholder; write {{ user.<attribute> }}`);
        if (/\{\{|\}\}/.test(rest.replace(ANY_PLACEHOLDER, "")))
          this.error(f, `${rp}.expr`, "has an unclosed {{ or a stray }}; write {{ user.<attribute> }}");
      });
    });
  }

  usedTags(): Set<string> {
    const tags = new Set<string>();
    for (const { data: m } of this.modelList) {
      for (const t of strings(m.tags)) tags.add(t);
      for (const d of named<Dimension>(m.dimensions)) for (const t of strings(d.tags)) tags.add(t);
      for (const x of named<Measure>(m.measures)) for (const t of strings(x.tags)) tags.add(t);
    }
    for (const x of named<Metric>(this.metrics?.data.metrics)) for (const t of strings(x.tags)) tags.add(t);
    return tags;
  }

  // Resolves a request field relative to a source; returns an error message or null.
  requestFieldProblem(source: string, ref: string, allow: { metric: boolean; measure: boolean; dimension: boolean }): string | null {
    if (/^[a-z][a-z0-9_]*$/.test(ref)) {
      if (!allow.metric) return `"${ref}" must be model.field`;
      const metric = this.metric(ref);
      if (!metric) return `"${ref}" is not a metric`;
      if (metric.source !== source) return `metric "${ref}" belongs to source ${metric.source}, not ${source}`;
      return null;
    }
    const parsed = parseRequestField(ref);
    if (!parsed) return `"${ref}" is not model.field, model.field:grain or a metric name`;
    const model = this.model(source, parsed.model);
    if (!model) return `"${parsed.model}" is not a model of source ${source}`;
    const dim = this.dimension(source, parsed.model, parsed.field);
    const measure = this.measure(source, parsed.model, parsed.field);
    if (dim && allow.dimension) {
      if (parsed.grain === undefined) return null;
      if (dim.type !== "time") return `"${ref}": a grain applies only to time dimensions`;
      const grains: readonly string[] = Array.isArray(dim.time_grains) ? strings(dim.time_grains) : TIME_GRAINS;
      if (!grains.includes(parsed.grain)) return `"${ref}": grain ${parsed.grain} is not in the dimension's time_grains (${grains.join(", ")})`;
      return null;
    }
    if (measure && allow.measure) return parsed.grain === undefined ? null : `"${ref}": a grain applies only to time dimensions`;
    const kinds = [allow.dimension && "dimension", allow.measure && "measure"].filter(Boolean).join(" or ");
    return `model ${parsed.model} has no ${kinds} "${parsed.field}"`;
  }

  // The models a metric's measures come from, in the order the metric names them.
  metricModels(metric: Metric): string[] {
    const refs =
      metric.type === "ratio"
        ? [metric.numerator, metric.denominator].filter((x): x is string => typeof x === "string").map((x) => x.split(".")[0]!)
        : typeof metric.expr === "string"
          ? [...metric.expr.matchAll(METRIC_PLACEHOLDER)].map((x) => x[1]!)
          : [];
    return [...new Set(refs)];
  }

  // The model a request starts from: that of its first measure (for a metric, of the metric's first
  // measure), or with no measures, that of its first dimension.
  // Returns the model and why it is the base, as the unreachable-path message words it.
  requestBaseModel(source: string, req: Golden["request"]): { model: string; why: string } | undefined {
    const first = strings(req.measures)[0];
    if (first !== undefined) {
      if (/^[a-z][a-z0-9_]*$/.test(first)) {
        const metric = this.metric(first);
        const model = metric && metric.source === source ? this.metricModels(metric)[0] : undefined;
        return model === undefined ? undefined : { model, why: `the model of the first measure of metric ${first}, the request's first measure` };
      }
      const model = parseRequestField(first)?.model;
      return model === undefined ? undefined : { model, why: "the model of the request's first measure" };
    }
    const dim = strings(req.dimensions)[0];
    const model = dim === undefined ? undefined : parseRequestField(dim)?.model;
    return model === undefined ? undefined : { model, why: "the model of the request's first dimension, as it has no measures" };
  }

  // Every path of at most maxHops many_to_one or one_to_one joins from one model to another, each
  // written as model.join steps.
  joinPaths(source: string, from: string, to: string, maxHops = 2): string[][] {
    const out: string[][] = [];
    const walk = (at: string, path: string[], visited: Set<string>) => {
      if (path.length >= maxHops) return;
      for (const j of named<Join>(this.model(source, at)?.joins)) {
        if (!TO_ONE_RELATIONSHIPS.includes(j.relationship) || visited.has(j.to) || !this.model(source, j.to)) continue;
        const step = [...path, `${at}.${j.name}`];
        if (j.to === to) out.push(step);
        else walk(j.to, step, new Set([...visited, j.to]));
      }
    };
    walk(from, [], new Set([from]));
    return out;
  }

  // An error message when a field of another model cannot be reached from the base model; why says
  // what makes base the base.
  pathProblem(source: string, base: string, why: string, model: string): string | null {
    if (model === base) return null;
    const all = this.joinPaths(source, base, model);
    if (!all.length)
      return `model ${model} is not reachable from ${base}, ${why}, through at most two many_to_one or one_to_one joins`;
    // The shortest path wins, so a direct join beats a route through another model.
    const shortest = Math.min(...all.map((p) => p.length));
    const paths = all.filter((p) => p.length === shortest);
    if (paths.length === 1) return null;
    return `model ${model} is reachable from ${base} by more than one shortest join path (${paths.map((x) => x.join(" -> ")).join("; ")}); a request field needs one shortest path`;
  }

  // Draft items an approved golden's request uses, as [path, description] pairs, once per item.
  draftFieldsUsed(source: string, req: Golden["request"]): [string, string][] {
    const out: [string, string][] = [];
    const seen = new Set<string>();
    // A field resolves as requestFieldProblem resolves it: a measure slot never reads a dimension.
    const visit = (path: string, ref: string, slot: "measure" | "dimension" | "any") => {
      let key: string;
      let label: string | undefined;
      if (/^[a-z][a-z0-9_]*$/.test(ref)) {
        key = `metric:${ref}`;
        const metric = this.metric(ref);
        if (metric?.status === "draft") label = `metric ${ref}`;
      } else {
        const parsed = parseRequestField(ref);
        if (!parsed) return;
        key = `${parsed.model}.${parsed.field}`;
        const dim = slot === "measure" ? undefined : this.dimension(source, parsed.model, parsed.field);
        const measure = slot === "dimension" || dim ? undefined : this.measure(source, parsed.model, parsed.field);
        if (dim?.status === "draft") label = `dimension ${key}`;
        else if (measure?.status === "draft") label = `measure ${key}`;
        if (!dim && !measure) return;
      }
      if (seen.has(key)) return;
      seen.add(key);
      if (label) out.push([path, label]);
    };
    arr<string>(req.measures).forEach((r, i) => typeof r === "string" && visit(`request.measures[${i}]`, r, "measure"));
    arr<string>(req.dimensions).forEach((r, i) => typeof r === "string" && visit(`request.dimensions[${i}]`, r, "dimension"));
    arr<{ field: string }>(req.filters).forEach((x, i) => typeof x?.field === "string" && visit(`request.filters[${i}].field`, x.field, "any"));
    arr<{ field: string }>(req.order_by).forEach((x, i) => typeof x?.field === "string" && visit(`request.order_by[${i}].field`, x.field, "any"));
    return out;
  }

  checkGoldens(): void {
    const roles = new Set(named<{ name: string }>(this.access?.data.roles).map((r) => r.name));
    const attrs = new Set(named<{ name: string }>(this.access?.data.user_attributes).map((u) => u.name));
    for (const l of this.goldens) {
      if (!l.valid) continue;
      const g = l.data;
      const f = l.file;
      if (g.name !== l.stem) this.error(f, "name", `is "${g.name}" but the file is named ${l.stem}.yaml`);
      if (!this.accessPresent) {
        // Goldens may be written before access.yaml; role and user wait for it.
        if (g.role !== undefined) this.warn(f, "role", `names role "${g.role}" but there is no access.yaml yet; leave role and user out until access.yaml exists`);
        for (const key of Object.keys(g.user ?? {}))
          this.warn(f, `user.${key}`, `"${key}" cannot be checked: there is no access.yaml yet; leave role and user out until it exists`);
      } else if (this.access) {
        // An access.yaml that exists but cannot be read is reported on its own; its roles are unknown here.
        if (g.role !== undefined && !roles.has(g.role)) this.error(f, "role", `names unknown role "${g.role}"`);
        for (const key of Object.keys(g.user ?? {}))
          if (!attrs.has(key)) this.error(f, `user.${key}`, `"${key}" is not a declared user attribute`);
      }
      if (g.status === "approved" && !g.expected?.rows.length) this.error(f, "expected.rows", "an approved golden needs at least one expected row");

      const req = g.request;
      if (!this.sources.has(req.source)) {
        this.error(f, "request.source", `names unknown source "${req.source}"`);
        continue;
      }
      const base = this.requestBaseModel(req.source, req);
      const spanning = arr<string>(req.measures)
        .map((r) => this.metric(r))
        .filter((m): m is Metric => !!m && m.source === req.source)
        .map((m) => ({ metric: m, models: this.metricModels(m).filter((x) => this.model(req.source, x)) }))
        .filter((x) => x.models.length > 1);
      const check = (path: string, ref: string, allow: { metric: boolean; measure: boolean; dimension: boolean }, kind: "measure" | "dimension" | "filter" | "order_by") => {
        const problem = this.requestFieldProblem(req.source, ref, allow);
        if (problem) {
          this.error(f, path, problem);
          return;
        }
        if (kind !== "dimension" && kind !== "filter") return;
        const parsed = parseRequestField(ref);
        if (!parsed) return;
        // A dimension, grouped by or filtered on, and a filtered measure must be reachable from the base.
        const isDim = !!this.dimension(req.source, parsed.model, parsed.field);
        if (!isDim && !(kind === "filter" && this.measure(req.source, parsed.model, parsed.field))) return;
        const pathIssue = base && this.model(req.source, base.model) ? this.pathProblem(req.source, base.model, base.why, parsed.model) : null;
        if (pathIssue) this.error(f, path, pathIssue);
        if (kind !== "dimension") return;
        for (const { metric, models } of spanning) {
          const missing = models.filter((m) => !this.dimension(req.source, m, parsed.field));
          if (missing.length)
            this.error(
              f,
              path,
              `metric ${metric.name} combines measures of ${models.join(", ")}, so it groups by dimensions that exist with the same name in each; ` +
                `${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no dimension "${parsed.field}"`,
            );
        }
      };
      arr<string>(req.measures).forEach((r, i) => check(`request.measures[${i}]`, r, { metric: true, measure: true, dimension: false }, "measure"));
      arr<string>(req.dimensions).forEach((r, i) => check(`request.dimensions[${i}]`, r, { metric: false, measure: false, dimension: true }, "dimension"));
      const all = { metric: true, measure: true, dimension: true };
      arr<{ field: string }>(req.filters).forEach((x, i) => check(`request.filters[${i}].field`, x.field, all, "filter"));
      arr<{ field: string }>(req.order_by).forEach((x, i) => check(`request.order_by[${i}].field`, x.field, all, "order_by"));
      if (g.status === "approved")
        for (const [path, label] of this.draftFieldsUsed(req.source, req))
          this.warn(f, path, `an approved golden uses draft ${label}; approve it, then confirm the golden again`);
    }
  }

  run(): Issue[] {
    this.loadAll();
    this.checkProject();
    this.checkSources();
    this.checkModels();
    this.checkMetrics();
    this.checkAccess();
    this.checkGoldens();
    return this.issues;
  }
}

// Whether a column name, as written, resolves to one of the columns the way the source's dialect
// resolves it: true, false, or a hint naming the column it misses only by case.
function resolveColumn(name: string, quoted: boolean, columns: SnapshotTable["columns"], rules: IdentRules): true | false | string {
  const loose = columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const write = (col: string) => quoteIdent(rules.dialect ?? "postgres", col);
  if (quoted) {
    if (columns.some((c) => c.name === name)) return true;
    if (!loose) return false;
    return rules.quotedExact ? `quoted names are case-sensitive, write ${write(loose.name)}` : true;
  }
  if (rules.fold === "none") return !!loose;
  const folded = rules.fold === "lower" ? name.toLowerCase() : name.toUpperCase();
  if (columns.some((c) => c.name === folded)) return true;
  return loose ? `${name} resolves to ${folded} in ${rules.dialect}, but the column is "${loose.name}"; write ${write(loose.name)}` : false;
}

function qualified(t: SnapshotTable): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

// Validates every file under a semantic root: structure against the JSON Schemas, then references.
// A file with structural errors gets no semantic checks of its own, but other files still resolve
// references into the parts of it that have the expected shape.
export function validateProject(root: string): Issue[] {
  return new Validator(root).run();
}

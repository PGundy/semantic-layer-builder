// Structural (JSON Schema) and semantic (cross-reference) validation of a semantic root.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import { type AccessLayer, type AccessVisibility, checkRequest, evaluateLayer, metricMeasureRefs } from "./access.ts";
import {
  type ApprovalEntry,
  accessEntry,
  changedMessage,
  holdsHashes,
  integrity,
  metricEntries,
  missingMessage,
  modelEntries,
  pathText,
  UNHASHED_MESSAGE,
} from "./approval-hash.ts";
import { classifyType, isNumeric, isTemporal } from "./column-types.ts";
import { type Condition, conditionAttributes, type Literal, parseCondition } from "./conditions.ts";
import { type CredentialSlot, credentialHint, hasCredential } from "./credentials.ts";
import { quoteIdent } from "./dialect.ts";
import { findTable } from "./naming.ts";
import { matchesDotted, validatePattern } from "./patterns.ts";
import { isHashedValue, protectedColumns } from "./profile.ts";
import { parseRequestField } from "./refs.ts";
import { type Sensitivity, sensitivityOf } from "./sensitivity.ts";
import { incomingKeyColumns, referencedColumns } from "./snapshot-diff.ts";
import { sourceSafetyIssues } from "./source-safety.ts";
import { bareNames, callsRound, dividesByLiteral, type SqlNames, sqlNames, tokenizeSql } from "./sql-names.ts";
import type {
  AccessFile,
  AccessMode,
  ColumnProfile,
  Dialect,
  Dimension,
  ExprRowFilter,
  Golden,
  GoldenRunAs,
  HierarchyRowFilter,
  Join,
  JoinEvidence,
  JoinKey,
  Measure,
  Metric,
  MetricsFile,
  Model,
  Project,
  Restriction,
  Role,
  RowFilter,
  Snapshot,
  SnapshotTable,
  SourceConfig,
  UserAttribute,
} from "./types.ts";
import { DIALECTS, PROTECTED_TAGS, PUBLIC_TAG, TIME_GRAINS, TO_ONE_RELATIONSHIPS } from "./types.ts";

export interface Issue {
  level: "error" | "warning";
  file: string;
  path: string;
  message: string;
}

export const SCHEMA_KINDS = ["project", "source", "snapshot", "model", "metrics", "access", "golden", "pending", "plan", "review"] as const;
export type SchemaKind = (typeof SCHEMA_KINDS)[number];

export const SCHEMAS_DIR = join(import.meta.dir, "..", "..", "schemas");

let validators: Map<SchemaKind, ValidateFunction> | undefined;

function getValidator(kind: SchemaKind): ValidateFunction {
  if (!validators) {
    const ajv = new Ajv2020({ allErrors: true, strictTypes: false, strictTuples: false, verbose: true });
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
  // A oneOf branch only requires a key; the oneOf error itself says which keys are alternatives.
  if (/\/oneOf\/\d+\//.test(e.schemaPath)) return null;
  switch (e.keyword) {
    case "if":
      return null;
    case "oneOf": {
      const keys = (Array.isArray(e.schema) ? e.schema : []).flatMap((b: { required?: string[] }) => b.required ?? []);
      if (!keys.length) return { path: dottedPath(e.instancePath), message: e.message ?? e.keyword };
      const message = params.passingSchemas === null ? `needs one of ${keys.join(", ")}` : `has more than one of ${keys.join(", ")}; give exactly one`;
      return { path: dottedPath(e.instancePath), message };
    }
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

// Hints added to a schema message, by file kind and property path.
const SCHEMA_HINTS: Partial<Record<SchemaKind, Record<string, string>>> = {
  model: {
    dimensions: "write dimensions: [] when the model has none",
    measures: "write measures: [] when the model has none",
  },
  golden: {
    "request.metrics":
      "there is no metrics key: request.measures lists measures as model.measure and metrics by bare name, as in measures: [orders.revenue, average_order_value]",
  },
};

// Checks one parsed document against the schema for its kind.
export function schemaIssues(kind: SchemaKind, data: unknown, file: string): Issue[] {
  const validate = getValidator(kind);
  if (validate(data)) return [];
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const e of validate.errors ?? []) {
    const m = schemaMessage(e);
    if (!m) continue;
    const hint = SCHEMA_HINTS[kind]?.[m.path];
    if (hint) m.message = `${m.message}; ${hint}`;
    const key = `${m.path}\0${m.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ level: "error", file, ...m });
  }
  return out;
}

export { callsRound, dividesByLiteral, sqlNames } from "./sql-names.ts";

type SqlRole = "dimension expr" | "measure expr" | "measure filter" | "row filter";

interface FieldProblem {
  message: string;
  unknown: boolean;
}

// A resolved join reference: the join names it goes through, from the model's own join on, the
// model each of those joins reaches, and the model it reads from.
interface JoinRef {
  text: string;
  joins: string[];
  models: string[];
  to: string;
}

// What a role may name and where a rule that needs more goes.
const OUTSIDE_HINT: Record<SqlRole, string> = {
  "dimension expr":
    "name only this model's columns and <join>.<column> or <join>.<join>.<column> join references through many_to_one or one_to_one joins; " +
    "for a rule that needs anything else, add a join to the model or ask the owner for a view that holds it",
  "measure filter":
    "name only this model's columns and <join>.<column> or <join>.<join>.<column> join references through many_to_one or one_to_one joins; " +
    "for a rule that needs anything else, add a join to the model or ask the owner for a view that holds it",
  "measure expr": "name only this model's columns; put a joined column in the measure's filter or in a dimension, or ask the owner for a view",
  "row filter":
    "name only its model's columns and <join>.<column> or <join>.<join>.<column> join references through many_to_one or one_to_one joins; " +
    "for a rule that needs anything else, add a join to the model or ask the owner for a view that holds it",
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
// A join reference written alone, as a hierarchy filter's column: <join>.<column> or <join>.<join>.<column>.
const JOIN_REF_TEXT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){1,2}$/;

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
  // The join references of each dimension expr, by source.model.dimension, as checkModels resolved them.
  dimensionRefs = new Map<string, JoinRef[]>();

  // overrides maps an absolute file path to text read in place of the file's, so an edit can be
  // validated before it is written.
  constructor(
    readonly root: string,
    readonly overrides?: ReadonlyMap<string, string>,
  ) {}

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
    const text = this.overrides?.get(abs) ?? readFileSync(abs, "utf8");
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

    // Readbacks sl readback stored, waiting for the owner: their structure, and an id equal to the file name.
    const pendingDir = join(this.root, ".sl", "pending");
    if (existsSync(pendingDir)) {
      for (const f of readdirSync(pendingDir).filter((x) => x.endsWith(".json")).sort()) {
        const l = this.load<{ readback_id?: unknown }>(join(pendingDir, f), "pending", f.replace(/\.json$/, ""));
        if (l?.valid && l.data.readback_id !== l.stem)
          this.error(l.file, "readback_id", `is "${String(l.data.readback_id)}" but the file is ${f}; the id equals the file name, so run sl readback again instead of renaming`);
      }
    }

    // JSON review forms sl review export wrote: their structure.
    const reviewsDir = join(this.root, ".sl", "reviews");
    if (existsSync(reviewsDir)) {
      for (const f of readdirSync(reviewsDir).filter((x) => x.endsWith(".json")).sort()) this.load(join(reviewsDir, f), "review", f.replace(/\.json$/, ""));
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

  // Errors on a credential in a source's DuckDB connection values, naming the key, never the value.
  // Runs on files that fail their schema too, since what they hold is in the repository either way.
  checkSourceCredentials(l: Loaded<SourceConfig>): void {
    const c: unknown = l.data.connection;
    if (!isObject(c)) return;
    const flag = (path: string, slot: CredentialSlot) =>
      this.error(l.file, path, `contains a credential; credentials never go in source files, so ${credentialHint(slot)}`);
    if (typeof c.database === "string" && hasCredential("database", c.database)) flag("connection.database", "database");
    // A setup written as one string instead of a list is read as one statement.
    if (typeof c.setup === "string") {
      if (hasCredential("setup", c.setup)) flag("connection.setup", "setup");
    } else
      arr<unknown>(c.setup).forEach((stmt, i) => {
        if (typeof stmt === "string" && hasCredential("setup", stmt)) flag(`connection.setup[${i}]`, "setup");
      });
    if (isObject(c.views))
      for (const [name, relation] of Object.entries(c.views))
        if (typeof relation === "string" && hasCredential("view", relation)) flag(`connection.views.${name}`, "view");
  }

  checkSources(): void {
    for (const [stem, l] of this.sources) {
      this.checkSourceCredentials(l);
      // A DuckDB source's setup and views run on every connection, so each must be one the adapter
      // accepts (lib/source-safety.ts). Like credentials, this holds for a file that fails its schema.
      for (const problem of sourceSafetyIssues(l.data)) this.error(l.file, problem.path, problem.message);
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

  // Checks the tables and join references an expr, filter or row filter names, and returns the join
  // references it resolved. A dimension expr, a measure filter and a row filter may use
  // <join>.<column> through one of the model's own to-one joins, or <join>.<join>.<column> through a
  // to-one join of the joined model; a measure expr uses the model's own columns only. A subquery or
  // another table is an error everywhere.
  checkSqlRefs(file: string, path: string, sql: unknown, model: Model, role: SqlRole): JoinRef[] {
    const refs: JoinRef[] = [];
    if (typeof sql !== "string") return refs;
    const rules = this.identRules(model.source);
    const names = sqlNames(sql, rules.dialect);
    if (names.subquery) {
      this.error(file, path, `has a subquery; a ${role} may ${OUTSIDE_HINT[role]}`);
      return refs;
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
    const report = (level: Issue["level"], message: string) => {
      if (seen.has(message)) return;
      seen.add(message);
      if (level === "error") this.error(file, path, message);
      else this.warn(file, path, message);
    };
    for (const chain of names.chains) {
      const { parts, quoted, text } = chain;
      const first = parts[0]!;
      const join = findJoin(joins, first, quoted[0]!);
      // A dotted name on one of the model's own columns reads a struct field.
      if (!join && isOwn(first)) continue;
      if (join) {
        if (role === "measure expr") {
          report("error", `${text} is a join reference; a measure expr is over the model's own columns, so put the condition in the measure's filter or the field in a dimension`);
          continue;
        }
        const ref = this.resolveJoinRef(model, join, chain, rules, report, names.chains);
        if (ref) refs.push(ref);
        continue;
      }
      if (parts.length > 2 || otherTables.has(first.toLowerCase())) {
        report("error", `${text} names a table or schema directly; a ${role} may ${OUTSIDE_HINT[role]}`);
        continue;
      }
      if (own) {
        const list = joins.length ? `its joins are ${joins.map((j) => j.name).join(", ")}` : "it has no joins";
        report("error", `${text}: "${first}" is neither a column nor a join of model ${model.model} (${list})`);
      }
    }
    return refs;
  }

  // Follows a join reference that starts with one of the model's joins: <join>.<column>, or
  // <join>.<join>.<column> when the second name is a join of the joined model. Every hop must be
  // many_to_one or one_to_one, and the final column, when the snapshot has its table, a column of
  // it; names after the column read struct fields. Returns the reference, or undefined after
  // reporting why it does not resolve. fieldChains are every dotted name of the SQL the reference
  // sits in.
  resolveJoinRef(
    model: Model,
    first: Join,
    chain: SqlNames["chains"][number],
    rules: IdentRules,
    report: (level: Issue["level"], message: string) => void,
    fieldChains: SqlNames["chains"],
  ): JoinRef | undefined {
    const { parts, quoted, text } = chain;
    const hops: Join[] = [];
    let from = model;
    let join = first;
    for (let k = 1; k < parts.length; k++) {
      const via = hops.length ? `join ${join.name} of model ${from.model}` : `join ${join.name}`;
      if (!TO_ONE_RELATIONSHIPS.includes(join.relationship)) {
        report(
          "error",
          `${text} goes through ${via}, which is ${join.relationship}; a join reference needs many_to_one or one_to_one joins, because ${join.relationship} repeats ${from.model}'s rows`,
        );
        return undefined;
      }
      hops.push(join);
      const target = this.model(model.source, join.to);
      // An unknown target is reported on the join itself.
      if (!target) return undefined;
      const name = parts[k]!;
      const isLast = k === parts.length - 1;
      const next = isLast ? undefined : findJoin(named<Join>(target.joins), name, quoted[k]!);
      if (next) {
        if (hops.length >= 2) {
          report(
            "error",
            `${text} goes more than two hops; a join reference is <join>.<column> or <join>.<join>.<column>, so add a join from ${model.model} that comes closer to the model you need`,
          );
          return undefined;
        }
        from = target;
        join = next;
        continue;
      }
      const targetTable = typeof target.table === "string" ? this.snapshotTable(model.source, target.table).table : undefined;
      const targetCols = targetTable?.columns.length ? targetTable.columns : undefined;
      const ref: JoinRef = { text, joins: hops.map((h) => h.name), models: hops.map((h) => h.to), to: join.to };
      if (!targetCols) {
        if (isLast) return ref;
        report(
          "error",
          `${text}: "${name}" is not a join of model ${join.to}, and the table of ${join.to} is not in the snapshot; a join reference is <join>.<column> or <join>.<join>.<column>`,
        );
        return undefined;
      }
      const resolved = resolveColumn(name, quoted[k]!, targetCols, rules);
      if (resolved !== true) {
        const nor = isLast ? "" : `, nor a join of model ${join.to}`;
        const hint = resolved === false ? "" : `; ${resolved}`;
        report("error", `${text}: "${name}" is not a column of ${qualified(targetTable!)}, the table of model ${join.to} that ${via} reaches${nor}${hint}`);
        return undefined;
      }
      // The reference reads the physical column, which a same-named dimension of the target may
      // redefine; a field that writes the dimension's whole rule out through the same joins is fine.
      const dim = named<Dimension>(target.dimensions).find((d) => d.name.toLowerCase() === name.toLowerCase());
      if (
        dim &&
        typeof dim.expr === "string" &&
        !isBareColumn(dim.expr, name) &&
        !this.writesOut(target, targetCols, dim.expr, name, parts.slice(0, k), fieldChains, rules)
      ) {
        report(
          "warning",
          `${text} reads the column ${name} of ${qualified(targetTable!)}, not dimension ${dim.name} of model ${join.to} (expr: ${dim.expr}); ` +
            `write that dimension's rule out here over join references if it is the one meant`,
        );
      }
      return ref;
    }
    return undefined;
  }

  // Whether a field's SQL that reads column `column` through the join chain prefix also names,
  // through the same prefix, every other column a target dimension's expr uses: each bare column as
  // <prefix>.<column>, and each dotted name on one of the target's columns or joins as
  // <prefix>.<that name>. An expr that uses no column besides `column`, as upper(region), is never
  // written out this way, since the reference alone reads only the column.
  writesOut(
    target: Model,
    targetCols: SnapshotTable["columns"],
    expr: string,
    column: string,
    prefix: string[],
    fieldChains: SqlNames["chains"],
    rules: IdentRules,
  ): boolean {
    const isCol = (name: string, quoted: boolean) => resolveColumn(name, quoted, targetCols, rules) !== false;
    const targetJoins = named<Join>(target.joins);
    const used: string[][] = [];
    for (const b of bareNames(expr, rules.dialect)) if (isCol(b.v, b.quoted)) used.push([b.v]);
    for (const c of sqlNames(expr, rules.dialect).chains) {
      if (findJoin(targetJoins, c.parts[0]!, c.quoted[0]!) || isCol(c.parts[0]!, c.quoted[0]!)) used.push(c.parts);
    }
    const others = used.filter((path) => !(path.length === 1 && path[0]!.toLowerCase() === column.toLowerCase()));
    if (!others.length) return false;
    const written = new Set(fieldChains.map((c) => c.parts.join(".").toLowerCase()));
    return others.every((path) => written.has([...prefix, ...path].join(".").toLowerCase()));
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
      this.checkIgnoredColumns(f, m, table, rules);

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
        const refs = this.checkSqlRefs(f, `${p}.expr`, d.expr, m, "dimension expr");
        if (refs.length) this.dimensionRefs.set(`${m.source}.${m.model}.${d.name}`, refs);
        if (d.time_grains && d.type !== "time") this.error(f, `${p}.time_grains`, `is only allowed on time dimensions, not ${d.type}`);
        if (d.time_zone !== undefined) this.checkTimeZone(f, `${p}.time_zone`, d, table, rules);
      });

      m.measures.forEach((x, i) => {
        const p = `measures[${i}]`;
        claim(x.name, p);
        this.checkColumnRef(f, `${p}.expr`, x.expr, table, rules);
        this.checkSqlRefs(f, `${p}.expr`, x.expr, m, "measure expr");
        if (rules.dialect === "duckdb" && typeof x.expr === "string" && dividesByLiteral(x.expr, rules.dialect))
          this.warn(f, `${p}.expr`, 'divides by a numeric literal; on duckdb "/ 100.0" gives a DOUBLE, so write <col> * 0.01 for an exact amount; this warning never stands');
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
          this.warn(f, `${p}.relationship`, `one_to_many fans out and multiplies the measures of ${m.model}; aggregate ${j.to} before joining and confirm with the owner`);
        const ev = j.evidence;
        if (ev?.suggested_relationship === "many_to_many") {
          const msg = "evidence shows many_to_many: neither key is unique, so the join needs a bridge table or a pre-aggregated model";
          if (j.status === "approved") this.error(f, `${p}.evidence.suggested_relationship`, msg);
          else this.warn(f, `${p}.evidence.suggested_relationship`, msg);
        } else if (ev && ev.suggested_relationship !== j.relationship) {
          this.warn(f, `${p}.relationship`, `is ${j.relationship} but the evidence suggests ${ev.suggested_relationship}`);
        }
        if (j.status === "approved" && !ev) this.warn(f, p, "is approved without evidence; run `sl check-join`");
        // Evidence measured for another target or other keys no longer describes the join; evidence
        // without them predates their recording and is taken as current.
        const staleTo = ev?.to !== undefined && ev.to !== j.to;
        const staleKeys = Array.isArray(ev?.keys) && keySignature(ev.keys) !== keySignature(j.keys);
        if (staleTo)
          this.warn(f, `${p}.evidence.to`, `the evidence was measured for a join to ${ev!.to}, but the join now goes to ${j.to}; run \`sl check-join\` again`);
        if (staleKeys)
          this.warn(
            f,
            `${p}.evidence.keys`,
            `the evidence was measured on keys ${describeKeys(ev!.keys!)}, but the join's keys are now ${describeKeys(j.keys)}; run \`sl check-join\` again`,
          );
        // An approved to-one join whose current evidence shows fan-out multiplies every measure a
        // request reaches through it, unless the owner recorded why the data may be trusted.
        const override = typeof j.fanout_override === "string" && j.fanout_override.trim() !== "";
        if (
          j.status === "approved" &&
          ev &&
          !staleTo &&
          !staleKeys &&
          !override &&
          TO_ONE_RELATIONSHIPS.includes(j.relationship) &&
          ev.suggested_relationship !== "many_to_many" &&
          evidenceFansOut(ev)
        ) {
          const why = [
            ev.right_key_unique === false ? `the key of ${j.to} is not unique` : "",
            typeof ev.max_fanout === "number" && ev.max_fanout > 1 ? `a row of ${m.model} matches up to ${ev.max_fanout} rows of ${j.to}` : "",
          ].filter(Boolean);
          this.error(
            f,
            `${p}.evidence`,
            `is approved as ${j.relationship}, but its evidence contradicts that: ${why.join(", and ")}, so the join fans out and multiplies ` +
              `the measures of ${m.model}; fix the keys or the relationship and run sl check-join again, or record why the owner accepts the data ` +
              'in fanout_override: "<reason>"',
          );
        }
      });
      const source = m.source;
      this.checkApprovals(f, modelEntries(source, m, (name) => this.model(source, name), this.sourceDialect(source)));
    }
  }

  // The dialect a source file names, as sl approve reads it when it records an approval's hash.
  sourceDialect(source: string): Dialect | undefined {
    const d = this.sources.get(source)?.data.dialect;
    return isDialect(d) ? d : undefined;
  }

  // Whether any model, field, join, metric or access file of the project records an approved_hash.
  projectHashedCache?: boolean;
  projectHashed(): boolean {
    if (this.projectHashedCache !== undefined) return this.projectHashedCache;
    const entries: ApprovalEntry[] = [];
    for (const l of this.modelList) if (isObject(l.data)) entries.push(...modelEntries(String(l.data.source), l.data, () => undefined));
    if (isObject(this.metrics?.data)) entries.push(...metricEntries(this.metrics.data.metrics));
    const access = accessEntry(this.access?.data);
    if (access) entries.push(access);
    this.projectHashedCache = holdsHashes(entries);
    return this.projectHashedCache;
  }

  // Errors on an approved item whose content no longer matches its approved_hash. Warns once per file
  // when approved items carry no hash and no item of the project records one (approved before
  // content hashes), and on each approved item without a hash once other items record one, since
  // its hash may have been removed.
  checkApprovals(file: string, entries: ApprovalEntry[]): void {
    let unhashed = 0;
    const hashed = this.projectHashed();
    for (const e of entries) {
      const state = integrity(e, hashed);
      if (state === "changed") this.error(file, pathText(e.path), changedMessage(e));
      else if (state === "missing") this.warn(file, pathText(e.path), missingMessage(e));
      else if (state === "unhashed") unhashed++;
    }
    if (unhashed)
      this.warn(file, "", `${unhashed} approved item${unhashed === 1 ? " was" : "s were"} ${UNHASHED_MESSAGE}`);
  }

  // A time dimension's time_zone: an IANA zone, and only for values stored without a zone. When the
  // expr is one column whose snapshot type carries a zone, the key has nothing to say.
  checkTimeZone(f: string, path: string, d: Dimension, table: SnapshotTable | undefined, rules: IdentRules): void {
    const zone = d.time_zone;
    if (d.type !== "time") {
      this.error(f, path, `is only allowed on time dimensions, not ${d.type}`);
      return;
    }
    if (typeof zone !== "string" || !knownTimeZone(zone)) {
      this.error(f, path, `${JSON.stringify(zone)} is not an IANA time zone, such as UTC or America/New_York`);
      return;
    }
    const col = typeof d.expr === "string" ? table?.columns.find((c) => isBareColumn(d.expr, c.name)) : undefined;
    if (col && carriesZone(col.type, rules.dialect) === true)
      this.warn(
        f,
        path,
        `names the zone timestamps without a time zone are stored in, but column ${col.name} is ${col.type}, which carries its own; ` +
          "remove time_zone, and convert in expr to bucket days in another zone",
      );
  }

  // Warns when ignored_columns names a column the table lacks (when the snapshot has the table), or
  // a column a field, a join key, the primary key or another model's join to this one reads.
  checkIgnoredColumns(f: string, m: Model, table: SnapshotTable | undefined, rules: IdentRules): void {
    const ignored = strings(m.ignored_columns);
    if (!ignored.length) return;
    if (table?.columns.length)
      ignored.forEach((c, i) => {
        if (!table.columns.some((x) => x.name.toLowerCase() === c.toLowerCase()))
          this.warn(f, `ignored_columns[${i}]`, `"${c}" is not a column of ${qualified(table)}; remove it from ignored_columns`);
      });
    const listed: SnapshotTable = { schema: null, name: m.model, kind: "table", columns: ignored.map((name) => ({ name, type: "" })) };
    const incoming = incomingKeyColumns(m, [...(this.models.get(m.source)?.values() ?? [])].map((x) => x.data));
    const used = new Set(referencedColumns(m, listed, rules.dialect, incoming));
    ignored.forEach((c, i) => {
      if (used.has(c))
        this.warn(
          f,
          `ignored_columns[${i}]`,
          `"${c}" is read by a field, a join key, the primary key of model ${m.model} or a join from another model, so it is not left out; remove it from ignored_columns`,
        );
    });
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
    this.checkApprovals(f, metricEntries(l.data.metrics));
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
    const mode: AccessMode = a.mode ?? "open";
    const roles = arr<Role>(a.roles);
    const roleNames = new Map<string, number>();
    roles.forEach((r, i) => {
      const prior = roleNames.get(r.name);
      if (prior !== undefined) this.error(f, `roles[${i}].name`, `"${r.name}" is already defined at roles[${prior}]`);
      else roleNames.set(r.name, i);
    });
    if (a.default_role && !roleNames.has(a.default_role)) this.error(f, "default_role", `names unknown role "${a.default_role}"`);
    if (mode === "closed" && !roles.length)
      this.warn(f, "mode", "is closed but there are no roles, so no one sees anything; add roles with allow.models, or use mode open");

    const attrs = new Map<string, UserAttribute>();
    arr<UserAttribute>(a.user_attributes).forEach((u, i) => {
      if (attrs.has(u.name)) this.error(f, `user_attributes[${i}].name`, `"${u.name}" is already defined`);
      else attrs.set(u.name, u);
    });

    const usedTags = this.usedTags();
    const modelRefs = this.allModelRefs();
    roles.forEach((r, i) => {
      const p = `roles[${i}]`;
      const allowModels = r.allow?.models;
      if (mode === "closed" && allowModels === undefined)
        this.error(f, `${p}.allow.models`, "is required in closed mode, where a role sees only the models its allow.models matches");
      if (mode === "open" && allowModels !== undefined)
        this.warn(
          f,
          `${p}.allow.models`,
          "has no effect in open mode, where everyone sees every approved model the roles they hold do not deny; remove it, or set mode: closed to make it an allowlist",
        );
      arr<string>(allowModels).forEach((pat, pi) => {
        const problem = validatePattern(pat);
        if (problem) this.error(f, `${p}.allow.models[${pi}]`, problem);
        else if (mode === "closed" && !modelRefs.some((ref) => matchesDotted(pat, ref))) this.warn(f, `${p}.allow.models[${pi}]`, `"${pat}" matches no model`);
      });
      arr<string>(r.allow?.tags).forEach((tag, ti) => {
        if (!(PROTECTED_TAGS as readonly string[]).includes(tag))
          this.warn(f, `${p}.allow.tags[${ti}]`, `"${tag}" is not a protected tag; allow.tags grants ${PROTECTED_TAGS.join(" or ")}, and no other tag hides anything`);
      });
      if (r.assign_when !== undefined) this.checkCondition(f, `${p}.assign_when`, r.assign_when, attrs);
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
      arr<RowFilter>(r.row_filters).forEach((rf, ri) => {
        const rp = `${p}.row_filters[${ri}]`;
        const known = this.hasModel(rf.model);
        if (!known) this.error(f, `${rp}.model`, `"${rf.model}" is not a model`);
        if ("hierarchy" in rf && rf.hierarchy) {
          this.checkHierarchy(f, rp, rf, attrs);
          return;
        }
        const expr = (rf as ExprRowFilter).expr;
        if (typeof expr !== "string") return;
        if (known) {
          const [source, name] = rf.model.split(".") as [string, string];
          this.checkSqlRefs(f, `${rp}.expr`, expr, this.model(source, name)!, "row filter");
        }
        for (const match of expr.matchAll(USER_PLACEHOLDER))
          if (!attrs.has(match[1]!)) this.error(f, `${rp}.expr`, `{{ user.${match[1]} }} names an undeclared user attribute`);
        const rest = expr.replace(USER_PLACEHOLDER, "");
        for (const match of rest.matchAll(ANY_PLACEHOLDER))
          this.error(f, `${rp}.expr`, `${match[0]} is not a placeholder; write {{ user.<attribute> }}`);
        if (/\{\{|\}\}/.test(rest.replace(ANY_PLACEHOLDER, "")))
          this.error(f, `${rp}.expr`, "has an unclosed {{ or a stray }}; write {{ user.<attribute> }}");
      });
      this.checkDefinitionJoinVisibility(r, p, mode);
      this.checkChildTables(r, p, mode);
    });
    this.checkRestrictions(f, arr<Restriction>(a.restrictions), roleNames, attrs);
    const entry = accessEntry(a);
    if (entry) this.checkApprovals(f, [entry]);
  }

  // Errors when a condition does not parse or reads an undeclared attribute; warns on a test whose
  // outcome the attribute's declared type fixes: false for every user, or (a not in list holding no
  // value of that type) true for every user who has the attribute.
  checkCondition(f: string, path: string, src: string, attrs: Map<string, UserAttribute>): void {
    let cond: Condition;
    try {
      cond = parseCondition(src);
    } catch (e) {
      this.error(f, path, (e as Error).message);
      return;
    }
    for (const name of conditionAttributes(cond))
      if (!attrs.has(name)) this.error(f, path, `reads user.${name}, which is not a declared user attribute; declare it in user_attributes`);
    const seen = new Set<string>();
    const say = (message: string) => {
      if (seen.has(message)) return;
      seen.add(message);
      this.warn(f, path, message);
    };
    // A test inside an odd number of nots has the opposite outcome.
    let negated = false;
    // The test is false for every user.
    const never = (attr: string, why: string) =>
      say(`user.${attr} ${why}, so that test is false for every user${negated ? ", and the not around it makes it true for every user" : ""}`);
    // The test is true exactly for the users who have the attribute.
    const onlySet = (attr: string, why: string) =>
      say(
        negated
          ? `user.${attr} ${why}, so that test is true for every user who has user.${attr}, and the not around it makes it true exactly for users who lack user.${attr}`
          : `user.${attr} ${why}, so that test is true for every user who has user.${attr}; write user.${attr} is set if that is meant`,
      );
    const walk = (c: Condition, neg: boolean): void => {
      negated = neg;
      if ("parts" in c) c.parts.forEach((x) => walk(x, neg));
      else if (c.kind === "not") walk(c.part, !neg);
      else if (c.kind !== "set") {
        const type = attrs.get(c.attr)?.type;
        if (!type) return;
        const list = type.endsWith("_list");
        const scalar = type.startsWith("number") ? "number" : "string";
        const lit = (v: Literal) => typeof v === scalar;
        if (c.kind === "contains") {
          if (!list) never(c.attr, `is a ${type}, and contains needs a list attribute; write == or in`);
          else if (!lit(c.value)) never(c.attr, `holds ${scalar}s, and ${JSON.stringify(c.value)} is not a ${scalar}`);
        } else if (c.kind === "cmp") {
          if (list) never(c.attr, `is a ${type}, and ${c.op} compares one value; write contains or in`);
          else if (!lit(c.value)) never(c.attr, `is a ${type}, and ${JSON.stringify(c.value)} is not a ${scalar}`);
        } else if (c.kind === "in" && !c.values.some(lit)) {
          if (c.negate) onlySet(c.attr, `holds ${scalar}s, and the list holds none`);
          else never(c.attr, `holds ${scalar}s, and the list holds none`);
        }
      }
    };
    walk(cond, false);
  }

  // A span-of-control filter: the closure model is a model of the filtered model's source, its
  // manager and member columns and the filtered model's column exist when the snapshot has them,
  // and the user attribute is declared and holds one value.
  checkHierarchy(f: string, rp: string, rf: HierarchyRowFilter, attrs: Map<string, UserAttribute>): void {
    const h = rf.hierarchy;
    const hp = `${rp}.hierarchy`;
    const [source, name] = rf.model.split(".") as [string, string];
    const model = this.model(source, name);
    if (model && typeof h.column === "string" && h.column.includes(".")) {
      // A join reference to the column that holds the person's id, through the model's to-one joins.
      if (!JOIN_REF_TEXT.test(h.column.trim()))
        this.error(f, `${hp}.column`, `"${h.column}" is neither a column nor a join reference; write a column of ${rf.model}, or <join>.<column> or <join>.<join>.<column>`);
      else this.checkSqlRefs(f, `${hp}.column`, h.column, model, "row filter");
    } else if (model && typeof model.table === "string") this.checkColumnName(f, `${hp}.column`, h.column, this.snapshotTable(source, model.table).table);
    const [viaSource, viaName] = h.via.split(".") as [string, string];
    if (viaSource !== source) {
      this.error(f, `${hp}.via`, `"${h.via}" is in source ${viaSource}, but ${rf.model} is in ${source}; the closure model must be a model of the same source`);
    } else {
      const via = this.model(viaSource, viaName);
      if (!via) {
        this.error(
          f,
          `${hp}.via`,
          `"${h.via}" is not a model; model the closure table (one row per manager and member pair at any depth), or ask the owner for a view that holds it`,
        );
      } else if (typeof via.table === "string") {
        const viaTable = this.snapshotTable(viaSource, via.table).table;
        this.checkColumnName(f, `${hp}.manager`, h.manager, viaTable);
        this.checkColumnName(f, `${hp}.member`, h.member, viaTable);
      }
    }
    const attr = h.user.replace(/^user\./, "");
    const declared = attrs.get(attr);
    if (!declared) this.error(f, `${hp}.user`, `user.${attr} is not a declared user attribute; declare it in user_attributes`);
    else if (declared.type.endsWith("_list"))
      this.error(f, `${hp}.user`, `user.${attr} is a ${declared.type}; a hierarchy filter needs the user's own id, a string or a number`);
  }

  checkRestrictions(f: string, restrictions: Restriction[], roleNames: Map<string, number>, attrs: Map<string, UserAttribute>): void {
    const modelRefs = this.allModelRefs();
    const fieldRefs: string[] = [];
    for (const ref of modelRefs) {
      const [source, name] = ref.split(".") as [string, string];
      const m = this.model(source, name);
      for (const x of [...named<Dimension>(m?.dimensions), ...named<Measure>(m?.measures)]) fieldRefs.push(`${ref}.${x.name}`);
    }
    const metricNames = named<Metric>(this.metrics?.data.metrics).map((m) => m.name);
    const names = new Map<string, number>();
    restrictions.forEach((x, i) => {
      const p = `restrictions[${i}]`;
      const prior = names.get(x.name);
      if (prior !== undefined) this.error(f, `${p}.name`, `"${x.name}" is already defined at restrictions[${prior}]`);
      else names.set(x.name, i);
      x.targets.forEach((t, ti) => {
        const tp = `${p}.targets[${ti}]`;
        const metric = t.startsWith("metric:");
        const pattern = metric ? t.slice("metric:".length) : t;
        const problem = pattern.trim() ? validatePattern(pattern) : "names no metric after metric:";
        if (problem) {
          this.error(f, tp, problem);
          return;
        }
        if (metric) {
          if (!metricNames.some((n) => matchesDotted(pattern, n))) this.warn(f, tp, `"${t}" matches no metric, so it hides nothing`);
          return;
        }
        if (modelRefs.some((ref) => matchesDotted(pattern, ref)) || fieldRefs.some((ref) => matchesDotted(pattern, ref))) return;
        const hint = metricNames.some((n) => matchesDotted(pattern, n)) ? `; write metric:${pattern} to name a metric` : "; write source.model, source.model.field or metric:<name>";
        this.warn(f, tp, `"${t}" matches no model or field, so it hides nothing${hint}`);
      });
      const allowRoles = arr<string>(x.allow?.roles);
      if (!allowRoles.length && x.allow?.when === undefined)
        this.error(f, `${p}.allow`, "names neither roles nor when, so its targets are hidden from everyone; give the roles, or the condition, whose users may see them");
      allowRoles.forEach((name, ri) => {
        if (!roleNames.has(name)) this.error(f, `${p}.allow.roles[${ri}]`, `names unknown role "${name}"`);
      });
      if (x.allow?.when !== undefined) this.checkCondition(f, `${p}.allow.when`, x.allow.when, attrs);
    });
  }

  // Warns when a role may see a dimension whose expr reads through a join to a model the role does
  // not see (in closed mode, not allowed; in either mode, denied, or carrying a protected tag the role
  // does not grant), for each such model along the reference's joins: the joins are part of the
  // dimension's definition, so the dimension shows the values of every model they reach. A measure
  // filter only narrows what is counted, so it is not checked.
  checkDefinitionJoinVisibility(r: Role, p: string, mode: AccessMode): void {
    const f = this.access!.file;
    const { hidden, tagged, protectedTag } = this.roleSight(r, mode);
    const denyFields = new Set(strings(r.deny?.fields));
    for (const [key, refs] of this.dimensionRefs) {
      const [source, model, field] = key.split(".") as [string, string, string];
      if (hidden(source, model) || denyFields.has(key)) continue;
      const dimTags = this.dimension(source, model, field)?.tags;
      if (tagged(dimTags) || protectedTag(dimTags)) continue;
      const seen = new Set<string>();
      for (const ref of refs) {
        ref.models.forEach((to, i) => {
          const why = hidden(source, to);
          if (!why || seen.has(to)) return;
          seen.add(to);
          const via = ref.joins.slice(0, i + 1);
          const target = `${source}.${to}`;
          const tag = why.startsWith("does not see") ? protectedTag(this.model(source, to)?.tags) : undefined;
          const grant = tag ? `grant ${tag} in the role's allow.tags` : `allow ${target}`;
          this.warn(
            f,
            p,
            `may see dimension ${key}, whose expr reads ${ref.text} through ${via.length > 1 ? "joins" : "join"} ${via.join(".")} ` +
              `to model ${target}, which the role ${why}; the dimension would show the values of ${target} to this role, so ${grant}, ` +
              `deny ${key} in deny.fields, or confirm with the owner that the role may see them`,
          );
        });
      }
    }
  }

  // What one role sees of models, by its own rules alone: hidden(source, model) says why the role
  // cannot see a model (in closed mode, not allowed; in either mode, denied, denied by tag, or
  // carrying a protected tag the role does not grant), or null when it can.
  roleSight(r: Role, mode: AccessMode) {
    const patterns = (v: unknown) => strings(v).filter((pat) => !validatePattern(pat));
    const allow = patterns(r.allow?.models);
    const denyModels = patterns(r.deny?.models);
    const denyTags = new Set(strings(r.deny?.tags));
    const granted = new Set(strings(r.allow?.tags).map((t) => t.toLowerCase()));
    const tagged = (tags: unknown) => strings(tags).some((t) => denyTags.has(t));
    const protectedTag = (tags: unknown) =>
      strings(tags)
        .map((t) => t.toLowerCase())
        .find((t) => (PROTECTED_TAGS as readonly string[]).includes(t) && !granted.has(t));
    const hidden = (source: string, model: string): string | null => {
      const ref = `${source}.${model}`;
      if (mode === "closed" && !allow.some((pat) => matchesDotted(pat, ref))) return "is not allowed";
      if (denyModels.some((pat) => matchesDotted(pat, ref))) return "denies";
      const tags = this.model(source, model)?.tags;
      if (tagged(tags)) return "denies by tag";
      const tag = protectedTag(tags);
      if (tag) return `does not see, since it carries the protected tag ${tag}`;
      return null;
    };
    return { hidden, tagged, protectedTag };
  }

  // Warns when a role has a row filter on model M and may see a model N of the same source that
  // reaches M through one or two to-one joins but has no row filter of its own for that role: N's
  // rows that belong to M are not limited by M's filter. The role may not see N when its own rules
  // hide N, or a restriction targets N whose allow.roles leaves the role out and that has no
  // allow.when. A role open_questions entry naming N records why and silences the warning.
  checkChildTables(r: Role, p: string, mode: AccessMode): void {
    const f = this.access!.file;
    const sight = this.roleSight(r, mode);
    const restrictions = arr<Restriction>(this.access!.data.restrictions).filter((x) => isObject(x));
    const restricted = (ref: string) =>
      restrictions.some(
        (x) =>
          x.allow?.when === undefined &&
          !strings(x.allow?.roles).includes(r.name) &&
          strings(x.targets).some((t) => !t.startsWith("metric:") && !validatePattern(t) && matchesDotted(t, ref)),
      );
    const hidden = (source: string, model: string) => sight.hidden(source, model) ?? (restricted(`${source}.${model}`) ? "restricted" : null);
    const filters = arr<RowFilter>(r.row_filters).filter((rf): rf is RowFilter => isObject(rf) && typeof rf.model === "string");
    const filtered = new Set(filters.map((rf) => rf.model));
    const questions = strings(r.open_questions);
    const names = (model: string) => {
      const word = new RegExp(`(^|[^A-Za-z0-9_])${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`, "i");
      return questions.some((q) => word.test(q));
    };
    const seen = new Set<string>();
    filters.forEach((rf, ri) => {
      const [source, target] = rf.model.split(".") as [string, string];
      const filteredModel = this.model(source, target);
      if (!filteredModel) return;
      for (const [name] of this.models.get(source) ?? []) {
        const child = `${source}.${name}`;
        if (name === target || filtered.has(child) || seen.has(`${child}>${rf.model}`) || hidden(source, name) || names(name)) continue;
        const paths = this.joinPaths(source, name, target);
        if (!paths.length) continue;
        seen.add(`${child}>${rf.model}`);
        const shortest = paths.reduce((a, b) => (b.length < a.length ? b : a));
        const chain = shortest.map((step) => step.slice(step.indexOf(".") + 1)).join(".");
        // The hint names the reference N may read only when it stays within two hops.
        const ref = this.rowFilterReference(rf, filteredModel);
        const read = ref && shortest.length + ref.split(".").length - 1 <= 2 ? ` (it may read ${chain}.${ref})` : "";
        this.warn(
          f,
          `${p}.row_filters[${ri}]`,
          `rows of ${child} that belong to ${rf.model} are not limited by ${rf.model}'s row filter for role ${r.name}; ` +
            `add a row filter on ${child}${read}, deny ${child} to ${r.name}, or record why in the role's open_questions`,
        );
      }
    });
  }

  // The reference a row filter limits its model by: a hierarchy filter's column, or for an expr the
  // first of the model's own columns, else the first join reference through one of its joins, in
  // the first and/or-separated clause that binds a user attribute (the whole expr when none does).
  // A join reference comes back as written, as sales_rep.rep_id.
  rowFilterReference(rf: RowFilter, model: Model): string | undefined {
    if ("hierarchy" in rf && isObject(rf.hierarchy)) return typeof rf.hierarchy.column === "string" ? rf.hierarchy.column.trim() : undefined;
    const expr = (rf as ExprRowFilter).expr;
    if (typeof expr !== "string") return undefined;
    const rules = this.identRules(model.source);
    const table = typeof model.table === "string" ? this.snapshotTable(model.source, model.table).table : undefined;
    const joins = new Set(named<Join>(model.joins).map((j) => j.name.toLowerCase()));
    const clauses = expr.split(/\b(?:and|or)\b/i);
    const clause = clauses.find((c) => /\{\{\s*user\./.test(c)) ?? expr;
    const bare = bareNames(clause, rules.dialect).filter((b) => !SQL_LITERALS.has(b.v.toLowerCase()));
    const own = table?.columns.length ? bare.find((b) => resolveColumn(b.v, b.quoted, table.columns, rules) !== false)?.v : bare[0]?.v;
    if (own) return own;
    const chain = sqlNames(clause, rules.dialect).chains.find((c) => c.parts.length <= 3 && joins.has(c.parts[0]!.toLowerCase()));
    return chain?.text;
  }

  // Warns on every approved dimension or measure the default audience (a user with no attributes and
  // no assigned roles) sees whose columns or name look personal or sensitive and that carries no
  // pii, sensitive or public tag, itself or through its model. A count or count_distinct measure
  // shows no values, so only a measure that aggregates values is checked.
  // The layer as the access evaluator reads it, with every model under the source and name its path
  // gives, and the loaded model file by source.model.
  accessLayer(): { layer: AccessLayer; loaded: Map<string, Loaded<Model>> } {
    const loaded = new Map<string, Loaded<Model>>();
    const models: Model[] = [];
    for (const l of this.modelList) {
      if (!Array.isArray(l.data.dimensions) && !Array.isArray(l.data.measures)) continue;
      const source = l.file.split("/")[1]!;
      loaded.set(`${source}.${l.stem}`, l);
      models.push({ ...l.data, source, model: l.stem });
    }
    const layer: AccessLayer = {
      models,
      metrics: named<Metric>(this.metrics?.data.metrics),
      access: this.accessPresent ? this.access?.data : null,
      access_present: this.accessPresent,
    };
    return { layer, loaded };
  }

  checkSensitivity(): void {
    const { layer, loaded } = this.accessLayer();
    const vis = evaluateLayer(layer, {});
    this.checkDefaultAudienceJoins(vis, loaded);
    const marked = new Set<string>([...PROTECTED_TAGS, PUBLIC_TAG]);
    for (const s of vis.sources) {
      for (const mv of s.models) {
        const l = loaded.get(mv.ref);
        if (!l) continue;
        const m = l.data;
        if (strings(m.tags).some((t) => marked.has(t.toLowerCase()))) continue;
        const rules = this.identRules(s.source);
        const table = typeof m.table === "string" ? this.snapshotTable(s.source, m.table).table : undefined;
        const keys = new Set(
          [
            ...strings(m.primary_key),
            ...named<Join>(m.joins).flatMap((j) => arr<JoinKey>(j.keys).map((k) => k.from)),
            ...incomingKeyColumns({ model: mv.model }, [...(this.models.get(s.source)?.values() ?? [])].map((x) => x.data)),
          ]
            .filter((k): k is string => typeof k === "string")
            .map((k) => k.toLowerCase()),
        );
        const joinsOnly = named<Join>(m.joins).map((j) => ({ ...j, keys: [] }));
        for (const fv of mv.fields) {
          if (!fv.visible) continue;
          const list = fv.kind === "dimension" ? named<Dimension>(m.dimensions) : named<Measure>(m.measures);
          const index = list.findIndex((x) => x.name === fv.name);
          const item = list[index];
          if (!item || strings(item.tags).some((t) => marked.has(t.toLowerCase()))) continue;
          const found = this.fieldSensitivity(s.source, m, fv.kind, item, table, keys, joinsOnly, rules);
          if (!found) continue;
          this.warn(
            l.file,
            `${fv.kind === "dimension" ? "dimensions" : "measures"}[${index}]`,
            `${fv.ref} is visible to everyone and looks sensitive (${found.reason}); tag it pii or sensitive, or tag it public if everyone may see it`,
          );
        }
      }
    }
  }

  // Warns on every dimension the default audience sees whose expr reads through a join to a model
  // that audience does not see because of a protected tag or a restriction: the dimension would
  // show that model's values to it. When the default audience holds roles, the per-role check
  // already reports protected tags, denials and closed-mode allowlists, so only restrictions are
  // reported here.
  checkDefaultAudienceJoins(vis: AccessVisibility, loaded: Map<string, Loaded<Model>>): void {
    const reported = (reason: string) => reason.startsWith("restricted:") || (!vis.roles.length && reason.startsWith("protected_tag:"));
    for (const s of vis.sources) {
      const bySource = new Map(s.models.map((m) => [m.model, m]));
      for (const mv of s.models) {
        const l = loaded.get(mv.ref);
        if (!l || !mv.visible) continue;
        for (const fv of mv.fields) {
          if (!fv.visible || fv.kind !== "dimension") continue;
          const index = named<Dimension>(l.data.dimensions).findIndex((x) => x.name === fv.name);
          const seen = new Set<string>();
          for (const ref of this.dimensionRefs.get(fv.ref) ?? []) {
            ref.models.forEach((to, i) => {
              const target = bySource.get(to);
              if (!target || target.visible || seen.has(to)) return;
              const reasons = target.reasons.filter(reported);
              if (!reasons.length) return;
              seen.add(to);
              const via = ref.joins.slice(0, i + 1);
              const why = reasons.map((r) => (r.startsWith("restricted:") ? `restriction ${r.slice("restricted:".length)} hides it` : `it carries the protected tag ${r.slice("protected_tag:".length)}`));
              const fixes = reasons.map((r) =>
                r.startsWith("restricted:") ? `add ${fv.ref} to the targets of restriction ${r.slice("restricted:".length)}` : `tag ${fv.ref} ${r.slice("protected_tag:".length)}`,
              );
              this.warn(
                l.file,
                `dimensions[${index}]`,
                `${fv.ref} is visible to the default audience (a user with no attributes and no assigned roles), and its expr reads ${ref.text} ` +
                  `through ${via.length > 1 ? "joins" : "join"} ${via.join(".")} to model ${target.ref}, which that audience does not see (${why.join("; ")}); ` +
                  `the dimension would show the values of ${target.ref} to that audience, so ${fixes.join(" and ")}, or confirm with the owner that everyone may see them`,
              );
            });
          }
        }
      }
    }
  }

  // The first sensitivity match among the columns a field reads (its own table's, and for a
  // dimension the columns its join references read), then its name.
  fieldSensitivity(
    source: string,
    m: Model,
    kind: "dimension" | "measure",
    item: Dimension | Measure,
    table: SnapshotTable | undefined,
    keys: Set<string>,
    joinsOnly: Join[],
    rules: IdentRules,
  ): Sensitivity | null {
    const measure = kind === "measure" ? (item as Measure) : undefined;
    if (measure && (measure.agg === "count" || measure.agg === "count_distinct")) return null;
    if (table && typeof item.expr === "string") {
      const one: Model = { ...m, primary_key: undefined, joins: joinsOnly, dimensions: [], measures: [] };
      if (measure) one.measures = [{ ...measure, filter: undefined }];
      else one.dimensions = [item as Dimension];
      for (const name of referencedColumns(one, table, rules.dialect)) {
        const col = table.columns.find((c) => c.name === name);
        const hit = sensitivityOf(name, col, table.row_count, { key: keys.has(name.toLowerCase()) });
        if (hit) return readsColumn(hit, name, item.name);
      }
    }
    if (!measure) {
      for (const ref of this.dimensionRefs.get(`${source}.${m.model}.${item.name}`) ?? []) {
        const column = ref.text.split(".")[ref.joins.length];
        const target = this.model(source, ref.to);
        if (!column || !target || typeof target.table !== "string") continue;
        const t = this.snapshotTable(source, target.table).table;
        const col = t?.columns.find((c) => c.name.toLowerCase() === column.toLowerCase());
        const hit = sensitivityOf(column, col, t?.row_count, { key: strings(target.primary_key).some((k) => k.toLowerCase() === column.toLowerCase()) });
        if (hit) return readsColumn(hit, ref.text, item.name);
      }
    }
    return sensitivityOf(item.name);
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

  // Resolves a request field relative to a source; returns the problem or null. unknown marks a
  // field that names nothing that exists, as opposed to one that is malformed or misused.
  requestFieldProblem(source: string, ref: string, allow: { metric: boolean; measure: boolean; dimension: boolean }): FieldProblem | null {
    const malformed = (message: string): FieldProblem => ({ message, unknown: false });
    const unknown = (message: string): FieldProblem => ({ message, unknown: true });
    if (/^[a-z][a-z0-9_]*$/.test(ref)) {
      if (!allow.metric) return malformed(`"${ref}" must be model.field`);
      const metric = this.metric(ref);
      if (!metric) return unknown(`"${ref}" is not a metric`);
      if (metric.source !== source) return malformed(`metric "${ref}" belongs to source ${metric.source}, not ${source}`);
      return null;
    }
    const parsed = parseRequestField(ref);
    if (!parsed) return malformed(`"${ref}" is not model.field, model.field:grain or a metric name`);
    const model = this.model(source, parsed.model);
    if (!model) return unknown(`"${parsed.model}" is not a model of source ${source}`);
    const dim = this.dimension(source, parsed.model, parsed.field);
    const measure = this.measure(source, parsed.model, parsed.field);
    if (dim && allow.dimension) {
      if (parsed.grain === undefined) return null;
      if (dim.type !== "time") return malformed(`"${ref}": a grain applies only to time dimensions`);
      const grains: readonly string[] = Array.isArray(dim.time_grains) ? strings(dim.time_grains) : TIME_GRAINS;
      if (!grains.includes(parsed.grain)) return malformed(`"${ref}": grain ${parsed.grain} is not in the dimension's time_grains (${grains.join(", ")})`);
      return null;
    }
    if (measure && allow.measure) return parsed.grain === undefined ? null : malformed(`"${ref}": a grain applies only to time dimensions`);
    const kinds = [allow.dimension && "dimension", allow.measure && "measure"].filter(Boolean).join(" or ");
    // A dimension in a measure slot, or a measure in a dimension slot, is misused, not unknown.
    const misused = (dim && !allow.dimension) || (measure && !allow.measure);
    const message = `model ${parsed.model} has no ${kinds} "${parsed.field}"`;
    return misused ? malformed(message) : unknown(message);
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
      if (typeof g.sql === "string" && callsRound(g.sql, this.identRules(g.request.source).dialect))
        this.warn(
          f,
          "sql",
          "calls round(); a golden's SQL applies the measure exactly as written; round() hides float noise, so remove it. " +
            "This warning never stands, whatever the golden's reference says; once round() is removed, " +
            `sl goldens check --name ${g.name} fails on rows recorded rounded until the owner says yes to the unrounded figure and it is confirmed again`,
        );

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
          // A draft golden may record the owner's figure before its field exists.
          if (problem.unknown && g.status !== "approved")
            this.warn(f, path, `${problem.message}; a draft golden may name a field before it exists; add the field before confirming the golden, because sl validate errors on it once the golden is approved`);
          else this.error(f, path, problem.message);
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
      this.checkMeasureModels(f, req);
      this.checkGoldenSqlRules(l);
      if (g.status === "approved")
        for (const [path, label] of this.draftFieldsUsed(req.source, req))
          this.warn(
            f,
            path,
            `an approved golden uses draft ${label}; approve it after its readback, then run sl goldens check --name ${g.name}; ` +
              "if it passes the recorded rows stand, and only changed rows need a new confirm",
          );
      this.checkGoldenAccess(l, roles);
      this.checkConfirmedAs(l);
    }
  }

  // Errors when a request's measures come from more than one model and are not one metric: each
  // measure aggregates at its own model's grain, and nothing defines how such results combine.
  checkMeasureModels(f: string, req: Golden["request"]): void {
    const measures = strings(req.measures);
    if (measures.length < 2) return;
    const seen = new Set<string>();
    let first: { ref: string; models: string[] } | undefined;
    for (const [i, ref] of measures.entries()) {
      const models = this.measureModels(req.source, ref);
      if (!models.length) continue;
      for (const x of models) seen.add(x);
      if (!first) {
        first = { ref, models };
        continue;
      }
      if (seen.size < 2) continue;
      this.error(
        f,
        `request.measures[${i}]`,
        `${ref} aggregates over ${models.join(", ")}, and ${first.ref} over ${first.models.join(", ")}; ` +
          "a request's measures must share one model, or be one metric: write a metric that combines them in metrics.yaml, or split the golden",
      );
      return;
    }
  }

  // The models a request's measure entry aggregates over: a model.measure's model, or the models of
  // a metric's measures. Empty when the entry names nothing that exists.
  measureModels(source: string, ref: string): string[] {
    if (/^[a-z][a-z0-9_]*$/.test(ref)) {
      const metric = this.metric(ref);
      return metric && metric.source === source ? this.metricModels(metric).filter((x) => this.model(source, x)) : [];
    }
    const parsed = parseRequestField(ref);
    return parsed && this.measure(source, parsed.model, parsed.field) ? [parsed.model] : [];
  }

  // Warns when a golden's SQL never names a column that a requested measure's expr or filter reads
  // (for a metric, each of its measures'): goldens pin hand-written SQL, and nothing yet compiles the
  // request, so SQL that leaves out a measure's rule records a figure the layer would not give.
  checkGoldenSqlRules(l: Loaded<Golden>): void {
    const g = l.data;
    const req = g.request;
    if (typeof g.sql !== "string") return;
    const dialect = this.identRules(req.source).dialect;
    const named = new Set<string>();
    for (const tok of tokenizeSql(g.sql, dialect)) if (tok.t === "id") named.add(tok.v.toLowerCase());
    const measures: [string, string][] = [];
    for (const ref of strings(req.measures)) {
      if (/^[a-z][a-z0-9_]*$/.test(ref)) {
        const metric = this.metric(ref);
        if (metric && metric.source === req.source)
          for (const r of metricMeasureRefs(metric)) measures.push(r.split(".") as [string, string]);
        continue;
      }
      const parsed = parseRequestField(ref);
      if (parsed) measures.push([parsed.model, parsed.field]);
    }
    const done = new Set<string>();
    for (const [modelName, measureName] of measures) {
      const key = `${modelName}.${measureName}`;
      if (done.has(key)) continue;
      done.add(key);
      const measure = this.measure(req.source, modelName, measureName);
      const model = this.model(req.source, modelName);
      if (!measure || !model) continue;
      const missing = this.ruleColumns(model, measure).filter((c) => !named.has(c.toLowerCase()));
      if (!missing.length) continue;
      this.warn(
        l.file,
        "sql",
        `goldens pin hand-written SQL; this SQL may not apply ${key}'s rule: it never names ${missing.join(", ")}, which the measure's ` +
          `${measure.filter ? "expr or filter" : "expr"} reads. Write the measure's expr and filter into the SQL as the model defines them, ` +
          `then run sl goldens check --name ${g.name} and read any change back to the owner`,
      );
    }
  }

  // The columns a measure's expr and filter read: its own table's (the snapshot's columns when it
  // has the table, else every name that is not a SQL word), and the column each join reference reads.
  ruleColumns(model: Model, measure: Measure): string[] {
    const rules = this.identRules(model.source);
    const table = typeof model.table === "string" ? this.snapshotTable(model.source, model.table).table : undefined;
    const cols = table?.columns.length ? table.columns : undefined;
    const joins = named<Join>(model.joins);
    const out = new Map<string, string>();
    const add = (name: string) => {
      if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), name);
    };
    for (const sql of [measure.expr, measure.filter]) {
      if (typeof sql !== "string") continue;
      for (const b of bareNames(sql, rules.dialect)) {
        if (cols ? resolveColumn(b.v, b.quoted, cols, rules) !== false : b.quoted || !SQL_WORDS.has(b.v.toLowerCase())) add(b.v);
      }
      for (const chain of sqlNames(sql, rules.dialect).chains) {
        const join = findJoin(joins, chain.parts[0]!, chain.quoted[0]!);
        if (!join) {
          if (!cols || resolveColumn(chain.parts[0]!, chain.quoted[0]!, cols, rules) !== false) add(chain.parts[0]!);
          continue;
        }
        const target = this.model(model.source, join.to);
        const second = chain.parts.length >= 3 && target ? findJoin(named<Join>(target.joins), chain.parts[1]!, chain.quoted[1]!) : undefined;
        const column = chain.parts[second ? 2 : 1];
        if (column) add(column);
      }
    }
    return [...out.values()];
  }

  // The layer the golden access check reads: every model, field and metric taken as approved, so
  // the check reports what access.yaml hides and the draft-field checks report draft items.
  goldenLayerCache?: AccessLayer;
  goldenLayer(): AccessLayer {
    if (this.goldenLayerCache) return this.goldenLayerCache;
    const { layer } = this.accessLayer();
    const approve = <T>(items: unknown): T[] => arr<unknown>(items).map((x) => (isObject(x) ? ({ ...x, status: "approved" } as T) : (x as T)));
    this.goldenLayerCache = {
      ...layer,
      models: layer.models.map((m) => ({
        ...m,
        status: "approved",
        dimensions: approve<Dimension>(m.dimensions),
        measures: approve<Measure>(m.measures),
      })),
      metrics: approve<Metric>(layer.metrics),
      access: isObject(layer.access) ? { ...layer.access, status: "approved" } : layer.access,
    };
    return this.goldenLayerCache;
  }

  // Checks a golden's request against access as the user it runs as: its role and user, or with no
  // role, whoever the evaluator makes of its user (the roles its attributes meet a condition of, else
  // the default role, else the default audience). Each place the request names a field or metric that
  // user may not see is an error in an approved golden and a warning in a draft one. A golden whose role cannot be resolved is reported elsewhere and not checked here,
  // and no golden is checked against an access.yaml that has errors until they are fixed.
  checkGoldenAccess(l: Loaded<Golden>, roles: Set<string>): void {
    const g = l.data;
    if (this.accessPresent && (!this.access?.valid || this.issues.some((i) => i.level === "error" && i.file === this.access!.file))) return;
    if (g.role !== undefined && (!this.accessPresent || !roles.has(g.role))) return;
    const attributes = isObject(g.user) ? g.user : {};
    const vis = evaluateLayer(this.goldenLayer(), { roles: g.role !== undefined ? [g.role] : [], attributes });
    if (vis.broken_roles.length || vis.access_file === "invalid") return;
    const check = checkRequest(vis, g.request);
    const who = runsAs(g, vis);
    for (const problem of check.problems) {
      const reasons = problem.reasons.filter((r) => r !== "unknown" && r !== "unreadable" && r !== "draft" && !r.startsWith("unknown_measure:"));
      if (!reasons.length) continue;
      const path = `request.${problem.position}[${problem.index}]${problem.position === "filters" || problem.position === "order_by" ? ".field" : ""}`;
      const message =
        `names ${problem.ref}, which ${who.who} may not see (${reasons.join(", ")})${who.why}; ` +
        "give the golden a role and user who may see every field it names, or change access.yaml after the owner's yes";
      if (g.status === "approved") this.error(l.file, path, message);
      else this.warn(l.file, path, message);
    }
  }

  // Warns when the role or user an approved or draft golden runs as differ from the ones recorded in
  // confirmed_as when it was confirmed: what the golden pins has changed.
  checkConfirmedAs(l: Loaded<Golden>): void {
    const g = l.data;
    if (!isObject(g.confirmed_as)) return;
    const was = runAsKey(g.confirmed_as);
    const now = runAsKey({ role: g.role, user: g.user });
    if (was === now) return;
    this.warn(
      l.file,
      "confirmed_as",
      `the golden was confirmed as ${describeRunAs(g.confirmed_as)} but now runs as ${describeRunAs({ role: g.role, user: g.user })}; ` +
        `run sl goldens check --name ${g.name}, read the change back and confirm again on the owner's yes`,
    );
  }

  // Warns when a snapshot holds sample values of a protected column (see protectedColumns in
  // lib/profile.ts): raw top values or a min or max of a column that is not a number or a date, or
  // top values hashed by an earlier sl profile, which a list of likely values reverses.
  checkProtectedProfiles(): void {
    for (const [source, l] of this.snapshots) {
      const raw = arr<unknown>(l.data.tables);
      const tables = this.snapshotTables(source) ?? [];
      const models = [...(this.models.get(source)?.values() ?? [])].map((m) => m.data as unknown);
      const prot = protectedColumns(tables, models, this.identRules(source).dialect);
      if (!prot.size) continue;
      raw.forEach((rt, i) => {
        const t = usableTable(rt);
        if (!t || !isObject(rt)) return;
        const cols = prot.get(qualified(t));
        if (!cols) return;
        arr<unknown>(rt.columns).forEach((c, j) => {
          if (!isObject(c) || typeof c.name !== "string" || typeof c.type !== "string" || !cols.has(c.name)) return;
          const held = heldValues(c.profile, c.type);
          if (!held) return;
          this.warn(
            l.file,
            `tables[${i}].columns[${j}].profile`,
            held === "raw"
              ? `${qualified(t)}.${c.name} is protected but the snapshot holds raw sample values; run sl profile --source ${source} --redact`
              : `${qualified(t)}.${c.name} is protected but the snapshot holds hashed top values, which a list of likely values reverses; ` +
                  `run sl profile --source ${source} --redact to remove them`,
          );
        });
      });
    }
  }

  // Warns when a description, a synonym, a golden question or a golden reference quotes a value of a
  // column that a pii- or sensitive-tagged field reads: one of the raw top values a snapshot profile
  // still holds for the column, of at least 3 characters, matched as a whole word in any case. A
  // protected column's profile keeps no top values, and hashed ones an older snapshot holds are not
  // matched (checkProtectedProfiles asks for them to be removed). Boolean columns are skipped. A
  // field tagged only through its model counts only the columns it reads that look personal or
  // sensitive themselves, so a status or region column of a pii-tagged model is not one.
  checkPersonalValues(): void {
    interface Hit {
      value: string;
      column: string;
      table: string;
      field: string;
      tag: string;
    }
    const values = new Map<string, Hit>();
    const add = (source: string, tableName: string, column: string, field: string, tag: string, inherited: boolean, keys: unknown) => {
      const table = this.snapshotTable(source, tableName).table;
      const col = table?.columns.find((c) => c.name.toLowerCase() === column.toLowerCase());
      if (inherited && !sensitivityOf(column, col, table?.row_count, { key: strings(keys).some((k) => k.toLowerCase() === column.toLowerCase()) })) return;
      // A boolean's values are the words true and false, which quote nobody.
      if (col && classifyType(col.type) === "boolean") return;
      for (const tv of arr<{ value: unknown }>(col?.profile?.top_values)) {
        const v = isObject(tv) ? tv.value : undefined;
        if (isHashedValue(v) || (typeof v !== "string" && typeof v !== "number")) continue;
        const text = String(v).trim();
        if (text.length < 3 || values.has(text.toLowerCase())) continue;
        values.set(text.toLowerCase(), { value: text, column: col!.name, table: qualified(table!), field, tag });
      }
    };
    const protectedTag = (tags: unknown) => strings(tags).map((t) => t.toLowerCase()).find((t) => (PROTECTED_TAGS as readonly string[]).includes(t));
    for (const l of this.modelList) {
      const m = l.data;
      const source = l.file.split("/")[1]!;
      if (typeof m.table !== "string") continue;
      const table = this.snapshotTable(source, m.table).table;
      const rules = this.identRules(source);
      const modelTag = protectedTag(m.tags);
      const joinsOnly = named<Join>(m.joins).map((j) => ({ ...j, keys: [] }));
      const fields: [Dimension | Measure, "dimension" | "measure"][] = [
        ...named<Dimension>(m.dimensions).map((d) => [d, "dimension"] as [Dimension, "dimension"]),
        ...named<Measure>(m.measures).map((x) => [x, "measure"] as [Measure, "measure"]),
      ];
      for (const [item, kind] of fields) {
        const own = protectedTag(item.tags);
        const tag = own ?? modelTag;
        const inherited = !own;
        if (!tag || typeof item.expr !== "string") continue;
        const ref = `${source}.${l.stem}.${item.name}`;
        if (table?.columns.length) {
          const one: Model = { ...m, primary_key: undefined, joins: joinsOnly, dimensions: [], measures: [] };
          if (kind === "measure") one.measures = [{ ...(item as Measure), filter: undefined }];
          else one.dimensions = [item as Dimension];
          for (const column of referencedColumns(one, table, rules.dialect)) add(source, m.table, column, ref, tag, inherited, m.primary_key);
        }
        if (kind === "dimension")
          for (const jr of this.dimensionRefs.get(ref) ?? []) {
            const column = jr.text.split(".")[jr.joins.length];
            const target = this.model(source, jr.to);
            if (column && target && typeof target.table === "string") add(source, target.table, column, ref, tag, inherited, target.primary_key);
          }
      }
    }
    if (!values.size) return;
    const patterns = [...values.values()].map((hit) => ({
      hit,
      re: new RegExp(`(^|[^A-Za-z0-9_])${hit.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_])`, "i"),
    }));
    const quotes = (file: string, path: string, quoted: string, hit: Hit) =>
      this.warn(
        file,
        path,
        `quotes "${quoted}", a value of column ${hit.column} of ${hit.table}, which ${hit.field} reads and tags ${hit.tag}; ` +
          "this text is shown to people the tag hides that column from, so write an id or a count instead",
      );
    const scan = (file: string, path: string, text: unknown) => {
      if (typeof text !== "string") return;
      for (const { hit, re } of patterns) if (re.test(text)) quotes(file, path, hit.value, hit);
    };
    const scanItem = (file: string, path: string, item: unknown) => {
      if (!isObject(item)) return;
      scan(file, `${path}${path ? "." : ""}description`, item.description);
      strings(item.synonyms).forEach((syn, k) => scan(file, `${path}${path ? "." : ""}synonyms[${k}]`, syn));
    };
    for (const l of this.modelList) {
      scanItem(l.file, "", l.data);
      for (const key of ["dimensions", "measures", "joins"] as const) arr<unknown>(l.data[key]).forEach((x, i) => scanItem(l.file, `${key}[${i}]`, x));
    }
    if (this.metrics) arr<unknown>(this.metrics.data.metrics).forEach((x, i) => scanItem(this.metrics!.file, `metrics[${i}]`, x));
    if (this.access)
      for (const key of ["user_attributes", "roles", "restrictions"] as const)
        arr<unknown>(this.access.data[key]).forEach((x, i) => scanItem(this.access!.file, `${key}[${i}]`, x));
    for (const l of this.goldens) {
      scan(l.file, "question", l.data.question);
      scan(l.file, "reference", l.data.reference);
    }
  }

  run(): Issue[] {
    this.loadAll();
    this.checkProject();
    this.checkSources();
    this.checkModels();
    this.checkMetrics();
    this.checkAccess();
    this.checkSensitivity();
    this.checkPersonalValues();
    this.checkProtectedProfiles();
    this.checkGoldens();
    return this.issues;
  }
}

// Words an expr or filter may hold that are SQL, not columns, for when the snapshot lacks the table.
const SQL_WORDS = new Set(
  [
    "and", "or", "not", "in", "is", "null", "true", "false", "like", "ilike", "similar", "between", "case", "when", "then",
    "else", "end", "distinct", "as", "interval", "date", "timestamp", "time", "with", "without", "zone", "at", "any", "all",
    "some", "exists", "escape", "collate", "current_date", "current_timestamp", "current_time", "now", "localtimestamp",
    "localtime", "unknown", "asc", "desc", "nulls", "first", "last", "over", "partition", "by", "order", "filter", "where",
    "from", "lambda", "struct", "array", "map", "int", "integer", "bigint", "numeric", "decimal", "double", "precision",
    "real", "float", "varchar", "text", "boolean", "char", "character", "varying", "to", "extract", "epoch", "year",
    "quarter", "month", "week", "day", "hour", "minute", "second", "dow", "doy", "isodow", "cast", "try_cast",
  ],
);

// Whether a zone is an IANA name the runtime knows, such as UTC or America/New_York. An offset such
// as +02:00 is not one: it would not follow daylight saving time.
function knownTimeZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Whether a column type carries its zone (an instant), is stored without one (a wall-clock time), or
// neither (undefined, as for a date). TIMESTAMP is an instant on BigQuery and Databricks and a
// wall-clock time on Postgres, DuckDB and, by default, Snowflake.
export function carriesZone(type: string, dialect?: Dialect): boolean | undefined {
  const t = type.trim().toLowerCase();
  if (/with time zone|^timestamptz|^timestamp_tz|^timestamp_ltz/.test(t)) return true;
  if (/without time zone|^timestamp_ntz|^datetime/.test(t)) return false;
  if (/^timestamp\b/.test(t)) return dialect === "bigquery" || dialect === "databricks";
  return undefined;
}

// Whether a join's evidence contradicts a to-one relationship: the target key is not unique, or a
// row matches more than one target row.
function evidenceFansOut(ev: JoinEvidence): boolean {
  return ev.right_key_unique === false || (typeof ev.max_fanout === "number" && ev.max_fanout > 1);
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

// The join a name refers to: an unquoted name matches in any case, as SQL resolves an unquoted
// alias; a quoted one exactly.
function findJoin(joins: Join[], name: string, quoted: boolean): Join | undefined {
  return joins.find((j) => (quoted ? j.name === name : j.name === name.toLowerCase()));
}

// Whether an expr is just the named column, bare or quoted, in any case.
function isBareColumn(expr: string, column: string): boolean {
  const m = expr.trim().match(/^(?:"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|([A-Za-z_][A-Za-z0-9_$]*))$/);
  const name = m?.[1] ?? m?.[2] ?? m?.[3];
  return name !== undefined && name.toLowerCase() === column.toLowerCase();
}

// What sample values a protected column's profile still holds: raw (a top value that is not hashed,
// or a min or max of a column that is not a number or a date), hashed (only values an earlier sl
// profile stored hashed), or nothing (null). A profile keeps counts only, with min and max for
// numbers and dates.
export function heldValues(profile: unknown, type: string): "raw" | "hashed" | null {
  if (!isObject(profile)) return null;
  const held = (v: unknown) => v !== null && v !== undefined;
  const c = classifyType(type);
  const values = arr<unknown>((profile as ColumnProfile).top_values)
    .map((tv) => (isObject(tv) ? tv.value : undefined))
    .filter(held);
  if (!(isNumeric(c) || isTemporal(c))) values.push(...[profile.min, profile.max].filter(held));
  if (values.some((v) => !isHashedValue(v))) return "raw";
  return values.length ? "hashed" : null;
}

// A sensitivity found on a column the field reads, worded so it names the column, not the field.
function readsColumn(hit: Sensitivity, column: string, field: string): Sensitivity {
  return column.toLowerCase() === field.toLowerCase() ? hit : { ...hit, reason: `it reads column ${column}; ${hit.reason}` };
}

// Who a golden runs as, for messages: its role (and user), the default role it falls to, or the
// default audience, with why when it has no role.
function runsAs(g: Golden, vis: AccessVisibility): { who: string; why: string } {
  const user = isObject(g.user) && Object.keys(g.user).length ? ` with user ${JSON.stringify(g.user)}` : "";
  if (g.role !== undefined) return { who: `role ${g.role}${user}`, why: "" };
  const held = vis.roles.filter((r) => r.how === "condition").map((r) => r.name);
  if (held.length) return { who: `a user${user}, who holds ${held.length > 1 ? "roles" : "role"} ${held.join(", ")} by condition`, why: "; a golden with no role runs as the roles its user holds" };
  const fallback = vis.roles.find((r) => r.how === "default");
  if (fallback) return { who: `the default role ${fallback.name}${user}`, why: "; a golden with no role runs as the default role" };
  if (user) return { who: `a user${user} holding no assigned role`, why: "" };
  return { who: "the default audience (a user with no attributes and no assigned roles)", why: "; a golden with no role and no default role runs as the default audience" };
}

// A golden's role and user as one comparable string; no user and an empty user are the same.
function runAsKey(a: GoldenRunAs): string {
  const user = isObject(a.user) && Object.keys(a.user).length ? a.user : {};
  return canonical({ role: typeof a.role === "string" ? a.role : null, user });
}

function describeRunAs(a: GoldenRunAs): string {
  const role = typeof a.role === "string" ? `role ${a.role}` : "no role";
  const user = isObject(a.user) && Object.keys(a.user).length ? ` with user ${JSON.stringify(a.user)}` : "";
  return `${role}${user}`;
}

// A value as canonical JSON, with object keys sorted, for comparing a golden's role and user.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

// Key pairs as an order-free, case-free string, for comparing a join's keys with its evidence's.
function keySignature(keys: JoinKey[]): string {
  return keys
    .map((k) => `${String(k.from).toLowerCase()}=${String(k.to).toLowerCase()}`)
    .sort()
    .join(",");
}

function describeKeys(keys: JoinKey[]): string {
  return keys.map((k) => `${k.from} = ${k.to}`).join(", ");
}

function qualified(t: SnapshotTable): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

// Validates every file under a semantic root: structure against the JSON Schemas, then references.
// A file with structural errors gets no semantic checks of its own, but other files still resolve
// references into the parts of it that have the expected shape. `overrides` holds the text of files
// as an edit would write them, by absolute path; each must be an existing file.
export function validateProject(root: string, overrides?: ReadonlyMap<string, string>): Issue[] {
  return new Validator(root, overrides).run();
}

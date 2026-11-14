// The JSON Schemas under schemas/ and the checks made with them: schemaIssues, the full list
// sl validate reports, and shapeIssue, the first wrong kind or missing part a loader refuses a
// file on. Imports no other module of the CLI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";

export interface Issue {
  level: "error" | "warning";
  file: string;
  path: string;
  message: string;
}

export const SCHEMA_KINDS = ["project", "source", "snapshot", "model", "metrics", "access", "golden", "pending", "plan", "ledger", "review"] as const;
export type SchemaKind = (typeof SCHEMA_KINDS)[number];

export const SCHEMAS_DIR = join(import.meta.dir, "..", "..", "schemas");

interface SchemaNode {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  $ref?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: boolean | SchemaNode;
}

const schemas = new Map<SchemaKind, SchemaNode>();

// The schema file of one kind, read when first asked for.
function readSchema(kind: SchemaKind): SchemaNode {
  let s = schemas.get(kind);
  if (!s) {
    s = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${kind}.schema.json`), "utf8")) as SchemaNode;
    schemas.set(kind, s);
  }
  return s;
}

let ajv: Ajv2020 | undefined;
const validators = new Map<SchemaKind, ValidateFunction>();

// The compiled schema of one kind. Each is compiled when first asked for, so a command pays only
// for the kinds of file it checks in full.
function getValidator(kind: SchemaKind): ValidateFunction {
  let v = validators.get(kind);
  if (!v) {
    if (!ajv) {
      ajv = new Ajv2020({ allErrors: true, strictTypes: false, strictTuples: false, verbose: true });
      ajv.addFormat("date", { type: "string", validate: isCalendarDate });
    }
    v = ajv.compile(readSchema(kind));
    validators.set(kind, v);
  }
  return v;
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

// A parser's message as one plain line: its first line, since the later ones quote the file,
// with no control character a file's bytes could put on the terminal.
export function parserLine(e: unknown): string {
  return String((e as Error).message).split("\n")[0]!.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/:$/, "");
}

// A part of a file that is of the wrong kind, or missing: where it is ("" for the file as a
// whole), what the schema expects there and what the file holds.
export interface ShapeIssue {
  path: string;
  expected: string;
  found: string;
}

const KIND_WORDS: Record<string, string> = {
  object: "a map",
  array: "a list",
  string: "text",
  integer: "a whole number",
  number: "a number",
  boolean: "true or false",
  null: "nothing",
};

function foundWord(value: unknown): string {
  if (value === null || value === undefined) return "nothing";
  if (Array.isArray(value)) return "a list";
  return KIND_WORDS[typeof value] ?? "something else";
}

// The three shapes a value takes, and no value at all. Which single value one is (text or a
// number) is not a matter of shape, and is sl validate's to check.
const MAP = 1;
const LIST = 2;
const SINGLE = 4;
const NOTHING = 8;

function shapeOf(value: unknown): number {
  if (value === null || value === undefined) return NOTHING;
  return Array.isArray(value) ? LIST : typeof value === "object" ? MAP : SINGLE;
}

// What the shape check reads of one schema node, worked out once per node.
interface Check {
  // The shapes allowed, 0 for any: those of the node's type, else of the values its enum or const lists.
  shapes: number;
  // What the node expects, in plain words.
  expected: string;
  items?: Check;
  // Whether an item with no value is passed over.
  gaps?: boolean;
  properties: Record<string, Check>;
  additional?: Check;
  required: string[];
}

const checks = new Map<SchemaNode, Check>();

// Keys the check does not look under, because the commands read whatever they hold in words of
// their own: a status that is not "approved" is a draft, and sl scope reports and clears a
// tables_file that is not a path.
const READ_AROUND: ReadonlySet<string> = new Set(["status", "tables_file"]);

// The check for a schema node. It follows properties, items, additionalProperties and $ref (into
// the file's own $defs) and reads only type, enum, const and required.
function checkFor(node: SchemaNode, root: SchemaNode): Check {
  let n = node;
  while (n.$ref?.startsWith("#/")) {
    let target: unknown = root;
    for (const part of n.$ref.slice(2).split("/")) target = (target as Record<string, unknown> | undefined)?.[part];
    n = (target ?? {}) as SchemaNode;
  }
  let c = checks.get(n);
  if (c) return c;
  const values = n.enum ?? (n.const === undefined ? [] : [n.const]);
  const types = n.type === undefined ? undefined : [n.type].flat();
  c = {
    shapes: types ? types.reduce((m, t) => m | (t === "object" ? MAP : t === "array" ? LIST : t === "null" ? NOTHING : SINGLE), 0) : values.reduce((m: number, v) => m | shapeOf(v), 0),
    expected: types ? types.map((t) => KIND_WORDS[t] ?? t).join(" or ") : n.enum ? `one of ${n.enum.map(String).join(", ")}` : n.const !== undefined ? JSON.stringify(n.const) : "a value",
    properties: Object.create(null) as Record<string, Check>,
    required: n.required ?? [],
  };
  // Kept before its parts are worked out, so a schema that refers to itself ends.
  checks.set(n, c);
  if (typeof n.items === "object") c.items = checkFor(n.items, root);
  if (typeof n.additionalProperties === "object") c.additional = checkFor(n.additionalProperties, root);
  for (const [key, child] of Object.entries(n.properties ?? {})) if (typeof child === "object" && !READ_AROUND.has(key)) c.properties[key] = checkFor(child, root);
  return c;
}

interface Found {
  // The keys and indexes down to the part, innermost first.
  at: (string | number)[];
  expected: string;
  found: string;
}

// A key with no value is a key that is not there, unless its schema allows nothing as a value.
function absent(value: unknown, c: Check | undefined): boolean {
  return value === undefined || (value === null && !!c && c.shapes !== 0 && !(c.shapes & NOTHING));
}

// The first part of a value whose shape is not the one its schema names: a map, a list or a
// single value where another of the three belongs, at any depth. With `complete`, also the first
// key the schema requires that is not there.
function firstWrong(c: Check, value: unknown, complete: boolean): Found | null {
  if (c.shapes && !(c.shapes & shapeOf(value))) return { at: [], expected: c.expected, found: foundWord(value) };
  if (Array.isArray(value)) {
    if (!c.items) return null;
    for (let i = 0; i < value.length; i++) {
      if (c.gaps && value[i] === null) continue;
      const found = firstWrong(c.items, value[i], complete);
      if (found) return found.at.push(i), found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const map = value as Record<string, unknown>;
  for (const key in map) {
    const child = c.properties[key] ?? c.additional;
    if (!child || absent(map[key], child)) continue;
    const found = firstWrong(child, map[key], complete);
    if (found) return found.at.push(key), found;
  }
  if (complete) for (const key of c.required) if (absent(map[key], c.properties[key])) return missing(c, key);
  return null;
}

function missing(c: Check, key: string): Found {
  return { at: [key], expected: c.properties[key]?.expected ?? "a value", found: "nothing" };
}

// The first shape problem in a parsed layer file, or null: what a loader refuses the file for.
// A snapshot, which only sl writes, also has every key its schema requires. Of the files people
// edit, commands read around a missing key (sl validate lists it), except a model's table, which
// every command that reads the model looks up. access.yaml is checked no further than being a
// map, because lib/access.ts reads each of its parts closed (a part it cannot read hides
// everything) and sl status names that part.
export function shapeIssue(kind: SchemaKind, data: unknown): ShapeIssue | null {
  if (data === null || data === undefined) return { path: "", expected: "a map", found: "an empty file" };
  const schema = readSchema(kind);
  const check = checkFor(schema, schema);
  // An item of the metrics list with no value is one the commands skip.
  if (kind === "metrics" && check.properties.metrics) check.properties.metrics.gaps = true;
  let found: Found | null;
  if (kind === "access") found = shapeOf(data) === MAP ? null : { at: [], expected: "a map", found: foundWord(data) };
  else found = firstWrong(check, data, kind === "snapshot");
  if (!found && kind === "model" && absent((data as { table?: unknown }).table, check.properties.table)) found = missing(check, "table");
  if (!found) return null;
  let path = "";
  for (const p of found.at.reverse()) path += typeof p === "number" ? `[${p}]` : path ? `.${p}` : p;
  return { path, expected: found.expected, found: found.found };
}

// The line a loader refuses a file with: the file (relative to the semantic root), the place,
// what was expected and what was found, and what to do.
export const SHAPE_FIX = "Fix the file, or run sl validate for the full list.";

export function shapeMessage(file: string, issue: ShapeIssue): string {
  return `${file}: ${issue.path || "the file"} should be ${issue.expected} (found ${issue.found}). ${SHAPE_FIX}`;
}

// The eval harness's files (evals/runner), each with a schema under schemas/ (spec.md, Eval runs).
export const EVAL_SCHEMA_KINDS = ["eval-scenario", "eval-script", "eval-transcript-turn", "eval-summary", "eval-figures", "eval-grades", "eval-baseline"] as const;
export type EvalSchemaKind = (typeof EVAL_SCHEMA_KINDS)[number];

let evalValidators: Map<EvalSchemaKind, ValidateFunction> | undefined;

// Checks one eval harness file against its schema, worded as schemaIssues words a layer file.
export function evalSchemaIssues(kind: EvalSchemaKind, data: unknown, file: string): Issue[] {
  if (!evalValidators) {
    const evalAjv = new Ajv2020({ allErrors: true, strictTypes: false, verbose: true });
    evalValidators = new Map();
    for (const k of EVAL_SCHEMA_KINDS) {
      evalValidators.set(k, evalAjv.compile(JSON.parse(readFileSync(join(SCHEMAS_DIR, `${k}.schema.json`), "utf8")) as object));
    }
  }
  const validate = evalValidators.get(kind)!;
  if (validate(data)) return [];
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const e of validate.errors ?? []) {
    const m = schemaMessage(e);
    if (!m || seen.has(`${m.path}\0${m.message}`)) continue;
    seen.add(`${m.path}\0${m.message}`);
    out.push({ level: "error", file, ...m });
  }
  return out;
}

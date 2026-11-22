import { UserError } from "./errors.ts";
import { IDENT } from "./intake.ts";
import type { Dimension, Join, Measure, Model } from "./types.ts";

export type Target =
  | { kind: "model"; source: string; model: string }
  | { kind: "field"; source: string; model: string; field: string }
  | { kind: "metric"; name: string }
  | { kind: "golden"; name: string }
  | { kind: "access" }
  | { kind: "schema-pair"; source: string; from: string; to: string };

const SCHEMA_PAIR = new RegExp(`^schema-pair:(${IDENT}):(${IDENT}):(${IDENT})$`);

// Parses an approve target: source.model, source.model.field, metric:<name>, golden:<name>, access or
// schema-pair:<source>:<from>:<to> (each part an identifier, its case kept).
export function parseTarget(ref: string): Target {
  if (ref === "access") return { kind: "access" };
  const pair = SCHEMA_PAIR.exec(ref);
  if (pair) return { kind: "schema-pair", source: pair[1]!, from: pair[2]!, to: pair[3]! };
  const parts = ref.startsWith("schema-pair:") ? [] : ref.split(".");
  const prefixed = ref.match(/^(metric|golden):([a-z][a-z0-9_]*)$/);
  if (prefixed) return { kind: prefixed[1] as "metric" | "golden", name: prefixed[2]! };
  if (parts.length === 2) return { kind: "model", source: parts[0]!, model: parts[1]! };
  if (parts.length === 3) return { kind: "field", source: parts[0]!, model: parts[1]!, field: parts[2]! };
  throw new UserError(`Cannot read target "${ref}". Use source.model, source.model.field, metric:<name>, golden:<name>, access or schema-pair:<source>:<from>:<to>.`, undefined, "bad_target");
}

export type FieldMatch =
  | { kind: "dimension"; index: number; item: Dimension }
  | { kind: "measure"; index: number; item: Measure }
  | { kind: "join"; index: number; item: Join };

export function findField(model: Model, name: string): FieldMatch | undefined {
  const d = model.dimensions?.findIndex((x) => x.name === name) ?? -1;
  if (d >= 0) return { kind: "dimension", index: d, item: model.dimensions[d]! };
  const m = model.measures?.findIndex((x) => x.name === name) ?? -1;
  if (m >= 0) return { kind: "measure", index: m, item: model.measures[m]! };
  const j = model.joins?.findIndex((x) => x.name === name) ?? -1;
  if (j >= 0) return { kind: "join", index: j, item: model.joins![j]! };
  return undefined;
}

// Splits a request field "model.field" or "model.field:grain".
export function parseRequestField(ref: string): { model: string; field: string; grain?: string } | undefined {
  const m = ref.match(/^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)(?::([a-z]+))?$/);
  return m ? { model: m[1]!, field: m[2]!, grain: m[3] } : undefined;
}

// The grain of a bare ":grain" request field, the shorthand for the request's default time
// dimension at that grain (spec: Metric semantics, Calendar and default time dimension), or
// undefined for any other text.
export function grainShorthand(ref: string): string | undefined {
  return /^:([a-z]+)$/.exec(ref)?.[1];
}

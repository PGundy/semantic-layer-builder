// Orders tables by how much an interview about them is worth: size, how many
// other tables point at them, fact and dimension naming, minus likely noise and staging.
// classifyTable is the one noise and staging judgement that sl tables --groups, its suggested
// scope, sl baseline and this ranking share.
import { qualifiedName } from "./naming.ts";
import type { SnapshotTable } from "./types.ts";

export const NOISE_WORDS = ["tmp", "temp", "backup", "bak", "old", "archive", "archived", "copy", "test", "scratch", "deprecated", "dedupe"];
// Words naming pipeline tools: a table named with one is the tool's bookkeeping. Stitch's own tables
// start with _sdc_, which the leading-underscore rule catches, so stitch_counts is not noise.
export const PIPELINE_WORDS = ["etl", "airflow", "fivetran", "airbyte", "dbt"];
// The migration bookkeeping tables of common frameworks.
export const MIGRATION_TABLES = [
  "schema_migrations",
  "_prisma_migrations",
  "flyway_schema_history",
  "ar_internal_metadata",
  "django_migrations",
  "knex_migrations",
];

// Prefixes that name raw or staging tables plainly; int_ (dbt's intermediate models) also names
// ordinary tables (int_shipments), so it marks staging for the ranking only. landing_ is not one:
// landing_pages is a marketing table.
const STAGING_NAME = /^(raw|src|stg|staging)_/i;
const INTERMEDIATE_NAME = /^int_/i;
const STAGING_SCHEMA = /^(raw|src|stg|staging|landing|ingest|import)$/i;
// Phrases that say a table holds raw or staging data. A bare "raw" or "landing" is not one: raw
// materials, raw sums and landing pages are ordinary business words.
const STAGING_TEXT = /\b(raw (data|export|exports|copy|copies|load|loads|feed|feeds|table|tables|dump|extract)|staging (table|area|layer|copy|schema)|landing (table|zone|area|layer)|not (yet )?cleaned|uncleaned)\b/i;

// Why a table name looks like noise, or null: a noise or pipeline word as a token, a date at the
// end, a migration bookkeeping table, or a leading underscore.
export function noiseReason(name: string): string | null {
  const tokens = name.toLowerCase().split(/[_\-.]+/);
  const word = tokens.find((t) => NOISE_WORDS.includes(t));
  if (word) return `name contains "${word}"`;
  if (/_(19|20)\d{2}(_?\d{2}){0,2}$/.test(name) || /_\d{8}$/.test(name)) return "name ends in a date";
  if (MIGRATION_TABLES.includes(name.toLowerCase())) return "migration bookkeeping table";
  const pipeline = tokens.find((t) => PIPELINE_WORDS.includes(t));
  if (pipeline) return `name contains "${pipeline}": pipeline bookkeeping`;
  if (name.startsWith("_")) return "name starts with an underscore: tool bookkeeping";
  return null;
}

// Why a table looks like raw or staging data, by its name, its schema and its comment; empty when it does not.
export function stagingReasons(table: Pick<SnapshotTable, "schema" | "name" | "description">): string[] {
  return stagingEvidence(table).reasons;
}

function stagingEvidence(table: Pick<SnapshotTable, "schema" | "name" | "description">): { reasons: string[]; plain: boolean } {
  const reasons: string[] = [];
  let plain = false;
  if (STAGING_NAME.test(table.name)) {
    reasons.push("raw or staging naming");
    plain = true;
  } else if (INTERMEDIATE_NAME.test(table.name)) reasons.push("intermediate (int_) naming");
  if (table.schema && STAGING_SCHEMA.test(table.schema)) {
    reasons.push(`in the ${table.schema} schema`);
    plain = true;
  }
  if (table.description && STAGING_TEXT.test(table.description)) {
    reasons.push("the table comment says it is raw or uncleaned");
    plain = true;
  }
  return { reasons, plain };
}

export interface TableClass {
  role: "noise" | "staging";
  reasons: string[];
  // True when a suggested scope leaves the table out: noise, or staging by a raw or staging name
  // prefix (raw_, src_, stg_, staging_), schema or comment phrase. Staging by an int_ prefix alone
  // only labels the table and lowers its rank.
  excludable: boolean;
}

// noise or staging by the table's own name, schema and comment, or null. Noise wins.
export function classifyTable(table: Pick<SnapshotTable, "schema" | "name" | "description">): TableClass | null {
  const noise = noiseReason(table.name);
  if (noise) return { role: "noise", reasons: [noise], excludable: true };
  const staging = stagingEvidence(table);
  return staging.reasons.length ? { role: "staging", reasons: staging.reasons, excludable: staging.plain } : null;
}

export interface RankedTable {
  table: SnapshotTable;
  qualified: string;
  score: number;
  reasons: string[];
}

export function rankTables(tables: SnapshotTable[]): RankedTable[] {
  const inbound = new Map<string, number>();
  for (const t of tables) {
    for (const fk of t.foreign_keys ?? []) {
      const key = qualifiedName({ schema: fk.references.schema ?? t.schema, name: fk.references.table }).toLowerCase();
      inbound.set(key, (inbound.get(key) ?? 0) + 1);
    }
  }
  const ranked = tables.map((t) => {
    const reasons: string[] = [];
    let score = 0;
    const rows = t.row_count ?? 0;
    if (rows > 0) {
      score += Math.log10(rows + 1);
      reasons.push(`${rows.toLocaleString("en-US")} rows`);
    }
    const q = qualifiedName(t);
    const refs = inbound.get(q.toLowerCase()) ?? 0;
    if (refs) {
      score += 2 * refs;
      reasons.push(`referenced by ${refs} table${refs === 1 ? "" : "s"}`);
    }
    const lower = t.name.toLowerCase();
    const cls = classifyTable(t);
    if (/^(fct|fact)_/.test(lower)) {
      score += 2;
      reasons.push("fact table naming");
    } else if (/^dim_/.test(lower)) {
      score += 1;
      reasons.push("dimension table naming");
    } else if (cls?.role === "staging") {
      score -= 1.5;
      reasons.push(cls.reasons.join("; "));
    }
    if (cls?.role === "noise") {
      score -= 4;
      reasons.push(`likely noise: ${cls.reasons[0]}`);
    }
    return { table: t, qualified: q, score: Math.round(score * 100) / 100, reasons };
  });
  return ranked.sort((a, b) => b.score - a.score || a.qualified.localeCompare(b.qualified));
}

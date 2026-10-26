// Orders tables by how much an interview about them is worth: size, how many
// other tables point at them, fact and dimension naming, minus likely noise.
import { qualifiedName } from "./naming.ts";
import type { SnapshotTable } from "./types.ts";

export const NOISE_WORDS = ["tmp", "temp", "backup", "bak", "old", "archive", "archived", "copy", "test", "scratch", "deprecated", "dedupe"];

// Why a table name looks like noise, or null.
export function noiseReason(name: string): string | null {
  const tokens = name.toLowerCase().split(/[_\-.]+/);
  const word = tokens.find((t) => NOISE_WORDS.includes(t));
  if (word) return `name contains "${word}"`;
  if (/_(19|20)\d{2}(_?\d{2}){0,2}$/.test(name) || /_\d{8}$/.test(name)) return "name ends in a date";
  if (/^(schema_migrations|_prisma_migrations|flyway_schema_history|ar_internal_metadata|django_migrations|knex_migrations)$/i.test(name))
    return "migration bookkeeping table";
  return null;
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
    if (/^(fct|fact)_/.test(lower)) {
      score += 2;
      reasons.push("fact table naming");
    } else if (/^dim_/.test(lower)) {
      score += 1;
      reasons.push("dimension table naming");
    } else if (/^(raw|src|stg|staging|int)_/.test(lower)) {
      score -= 1.5;
      reasons.push("raw or staging naming");
    }
    const noise = noiseReason(t.name);
    if (noise) {
      score -= 4;
      reasons.push(`likely noise: ${noise}`);
    }
    return { table: t, qualified: q, score: Math.round(score * 100) / 100, reasons };
  });
  return ranked.sort((a, b) => b.score - a.score || a.qualified.localeCompare(b.qualified));
}

// Generates the decoy tables of the 200-table scenario: 197 empty tables with names and columns
// near those of three real Acme tables (fct_orders, dim_customers, dim_regions), as CREATE TABLE
// statements without a schema name. The runner runs them with the run's schema as the search path.
//
//   bun fixtures/noisy/generate.ts [outFile]     (default fixtures/noisy/decoys.sql)
//
// Every choice comes from one seeded PRNG; nothing reads the clock, so two runs write the same bytes.
// Every name and column is synthetic: no table here describes a real company or person.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { POSTGRES_TYPES, WAREHOUSE_TABLES, type ColumnDef } from "../acme/schema.ts";

export const SEED = 20260101;
export const DECOY_COUNT = 197;
// The Acme tables the scenario loads with their data; a decoy is never named like one.
export const REAL_TABLES = ["fct_orders", "dim_customers", "dim_regions"] as const;

// The names a decoy is built from: a real table's name, or the name without its fct_ or dim_ prefix.
const STEMS = [...REAL_TABLES, "orders", "customers", "regions"];
const PREFIXES = ["", "stg_", "tmp_", "raw_", "old_", "bak_", "copy_of_", "test_"];
const SUFFIXES = [
  "", "_bak", "_old", "_copy", "_tmp", "_test", "_v2", "_v3", "_new", "_backup", "_archive", "_staging",
  "_2018", "_2019", "_2020", "_2021", "_2022", "_2023", "_2024", "_20240101", "_20250101", "_snapshot",
];

export interface DecoyTable {
  name: string;
  columns: ColumnDef[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The Acme table a stem copies its columns from.
const sourceTable = (stem: string) => WAREHOUSE_TABLES.find((t) => (REAL_TABLES as readonly string[]).includes(t.name) && (t.name === stem || t.name.endsWith(`_${stem}`)))!;

export function decoyTables(seed = SEED, count = DECOY_COUNT): DecoyTable[] {
  const real = new Set<string>(REAL_TABLES);
  const names = new Map<string, string>();
  for (const stem of STEMS) {
    for (const p of PREFIXES) {
      for (const s of SUFFIXES) {
        const name = `${p}${stem}${s}`;
        if ((p || s) && !real.has(name) && !names.has(name)) names.set(name, stem);
      }
    }
  }
  // A seeded shuffle of the candidates in name order, then the first `count` of them.
  const rand = mulberry32(seed);
  const all = [...names.keys()].sort();
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  if (all.length < count) throw new Error(`only ${all.length} candidate names for ${count} decoys`);
  return all
    .slice(0, count)
    .sort()
    .map((name) => {
      const columns = sourceTable(names.get(name)!).columns.map((c) => ({ ...c }));
      // Some copies lost their last column, some gained a load time.
      const r = rand();
      if (r < 0.25 && columns.length > 2) columns.pop();
      else if (r < 0.5) columns.push({ name: "_loaded_at", type: "tstz", nullable: true });
      return { name, columns };
    });
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function decoyDdl(tables = decoyTables()): string {
  const header = `-- ${tables.length} decoy tables near fct_orders, dim_customers and dim_regions, from fixtures/noisy/generate.ts.\n-- Run with the target schema as the search path; the tables are empty.\n`;
  const body = tables.map((t) => `CREATE TABLE ${ident(t.name)} (${t.columns.map((c) => `${ident(c.name)} ${POSTGRES_TYPES[c.type]}${c.nullable ? "" : " NOT NULL"}`).join(", ")});`);
  return `${header}${body.join("\n")}\n`;
}

if (import.meta.main) {
  const out = resolve(process.argv[2] ?? join(import.meta.dir, "decoys.sql"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, decoyDdl());
  console.log(`Wrote ${out}.`);
}

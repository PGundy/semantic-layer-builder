// A deterministic synthetic catalog for the performance suite: `tables` tables across ten
// schemas, 20 columns a table on average (so 50,000 tables hold 1,000,000 columns), with names
// built from a fixed word list and a seeded generator. It writes the catalog as an
// information_schema CSV export, as a DuckDB database of empty tables, and as empty tables in
// Postgres schemas. Every name is synthetic.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { SQL } from "bun";

// Bumped whenever the generator's output changes, so a cached catalog is rebuilt.
export const GENERATOR_VERSION = 1;
export const DEFAULT_SEED = 1729;

export const SCHEMAS = ["sales", "finance", "ops", "marketing", "product", "support", "people", "logistics", "staging", "archive"] as const;
const PREFIXES = ["fct_", "dim_", "stg_", "int_", "rpt_", "tmp_"] as const;
const ENTITIES = [
  "orders", "order_items", "customers", "accounts", "invoices", "payments", "refunds", "shipments", "carriers", "products",
  "variants", "prices", "campaigns", "clicks", "sessions", "tickets", "agents", "employees", "teams", "warehouses",
  "stock_moves", "suppliers", "contracts", "plans", "subscriptions", "events", "devices", "regions", "stores", "budgets",
] as const;
const TYPES = ["integer", "bigint", "text", "numeric(18,2)", "boolean", "date", "timestamp"] as const;
const ATTRS = ["status", "channel", "code", "label", "amount_cents", "quantity", "score", "kind", "note", "flag", "opened_on", "closed_at"] as const;

export interface CatalogColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface CatalogTable {
  schema: string;
  name: string;
  kind: "table" | "view";
  columns: CatalogColumn[];
}

// mulberry32: a small seeded generator, the same sequence on every machine.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The catalog's tables in a fixed order. Column counts run from 5 to 35 in pairs that sum to 40,
// so an even number of tables holds exactly 20 columns per table. About one table in eight
// carries a year suffix (orders_2019) for regex excludes to match.
export function* catalogTables(tables: number, seed = DEFAULT_SEED): Generator<CatalogTable> {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  let previous = 20;
  for (let i = 0; i < tables; i++) {
    const count = i % 2 === 0 ? 5 + Math.floor(rand() * 31) : 40 - previous;
    previous = count;
    const entity = pick(ENTITIES);
    const prefix = pick(PREFIXES);
    const year = rand() < 0.125 ? `_${2015 + Math.floor(rand() * 10)}` : "";
    const name = `${prefix}${entity}_${String(i).padStart(5, "0")}${year}`;
    const columns: CatalogColumn[] = [
      { name: "id", type: "bigint", nullable: false },
      { name: `${entity.replace(/s$/, "")}_ref`, type: "bigint", nullable: true },
      { name: "created_at", type: "timestamp", nullable: false },
    ];
    for (let j = columns.length; j < count; j++) {
      const attr = pick(ATTRS);
      columns.push({ name: `${attr}_${String(j).padStart(2, "0")}`, type: pick(TYPES), nullable: rand() < 0.7 });
    }
    yield { schema: SCHEMAS[i % SCHEMAS.length]!, name, kind: i % 25 === 24 ? "view" : "table", columns: columns.slice(0, count) };
  }
}

// Where cached catalogs live: SL_PERF_CACHE, else a directory under the system temp directory
// named for the generator version.
export function cacheDir(): string {
  return process.env.SL_PERF_CACHE ?? join(tmpdir(), `sl-perf-g${GENERATOR_VERSION}`);
}

// Writes `path` through a temporary file renamed into place, so an interrupted run leaves no
// half-written cache entry.
async function writeOnce(path: string, write: (tmp: string) => Promise<void>): Promise<string> {
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  await write(tmp);
  renameSync(tmp, path);
  return path;
}

// The catalog as an information_schema.columns CSV export, one row per column.
export async function writeInformationSchemaCsv(path: string, tables: number, seed = DEFAULT_SEED): Promise<void> {
  const out = createWriteStream(path);
  const lines: string[] = ["table_schema,table_name,column_name,data_type,is_nullable,ordinal_position,table_type"];
  const flush = async () => {
    const chunk = `${lines.join("\n")}\n`;
    lines.length = 0;
    if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
  };
  for (const t of catalogTables(tables, seed)) {
    const type = t.kind === "view" ? "VIEW" : "BASE TABLE";
    t.columns.forEach((c, i) => lines.push(`${t.schema},${t.name},${c.name},"${c.type}",${c.nullable ? "YES" : "NO"},${i + 1},${type}`));
    if (lines.length >= 20000) await flush();
  }
  await flush();
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
}

// The cached CSV export for `tables` tables, written on first use.
export function cachedCsv(tables: number): Promise<string> {
  return writeOnce(join(cacheDir(), `catalog-${tables}.csv`), (tmp) => writeInformationSchemaCsv(tmp, tables));
}

function createStatement(t: CatalogTable, schemaPrefix: string): string {
  const q = `"${schemaPrefix}${t.schema}"."${t.name}"`;
  if (t.kind === "view") return `create view ${q} as select ${t.columns.map((c) => `cast(null as ${c.type}) as "${c.name}"`).join(", ")}`;
  return `create table ${q} (${t.columns.map((c) => `"${c.name}" ${c.type}${c.nullable ? "" : " not null"}`).join(", ")})`;
}

// The catalog as a DuckDB database of empty tables and views, in one transaction.
export async function writeDuckDb(path: string, tables: number, seed = DEFAULT_SEED): Promise<void> {
  const instance = await DuckDBInstance.create(path);
  const c = await instance.connect();
  try {
    await c.run("begin");
    for (const s of SCHEMAS) await c.run(`create schema "${s}"`);
    let batch: string[] = [];
    for (const t of catalogTables(tables, seed)) {
      batch.push(`${createStatement(t, "")};`);
      if (batch.length >= 500) {
        await c.run(batch.join("\n"));
        batch = [];
      }
    }
    if (batch.length) await c.run(batch.join("\n"));
    await c.run("commit");
  } finally {
    c.closeSync();
    instance.closeSync();
  }
}

// The cached DuckDB database for `tables` tables, written on first use.
export function cachedDuckDb(tables: number): Promise<string> {
  return writeOnce(join(cacheDir(), `catalog-${tables}.duckdb`), (tmp) => writeDuckDb(tmp, tables));
}

// The Postgres schemas the catalog of `tables` tables lives in: one per catalog schema, named for
// the generator version and size, so a cached catalog is reused only when it is the same one.
export function pgSchemas(tables: number): string[] {
  return SCHEMAS.map((s) => `${pgPrefix(tables)}${s}`);
}

function pgPrefix(tables: number): string {
  return `slperf_g${GENERATOR_VERSION}_${tables}_`;
}

// Creates the catalog in Postgres unless a complete copy is already there, marked by a comment on
// its first schema that is written last. Tables are created in batches of 500 per transaction to
// stay inside the server's lock table. Returns the schema names and whether they were reused.
export async function ensurePgCatalog(url: string, tables: number, seed = DEFAULT_SEED): Promise<{ schemas: string[]; reused: boolean }> {
  const schemas = pgSchemas(tables);
  const marker = `sl perf catalog g${GENERATOR_VERSION} seed ${seed} tables ${tables}`;
  const sql = new SQL({ url, max: 1 });
  try {
    const found = await sql`select obj_description(n.oid, 'pg_namespace') as note from pg_namespace n where n.nspname = ${schemas[0]!}`;
    if (found[0]?.note === marker) return { schemas, reused: true };
    for (const s of schemas) await dropSchema(sql, s);
    for (const s of schemas) await sql.unsafe(`create schema "${s}"`);
    let batch: string[] = [];
    const flush = async () => {
      await sql.unsafe(`begin;\n${batch.join(";\n")};\ncommit;`);
      batch = [];
    };
    for (const t of catalogTables(tables, seed)) {
      batch.push(createStatement(t, pgPrefix(tables)));
      if (batch.length >= 500) await flush();
    }
    if (batch.length) await flush();
    await sql.unsafe(`comment on schema "${schemas[0]}" is '${marker}'`);
    return { schemas, reused: false };
  } finally {
    await sql.close();
  }
}

// Drops a schema's relations in batches (one DROP SCHEMA ... CASCADE over thousands of tables
// runs out of lock slots), then the schema.
async function dropSchema(sql: SQL, schema: string): Promise<void> {
  for (;;) {
    const rels = await sql`select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${schema} and c.relkind in ('r', 'v') limit 500`;
    if (!rels.length) break;
    const views = rels.filter((r: { relkind: string }) => r.relkind === "v").map((r: { relname: string }) => `"${schema}"."${r.relname}"`);
    const tbls = rels.filter((r: { relkind: string }) => r.relkind === "r").map((r: { relname: string }) => `"${schema}"."${r.relname}"`);
    await sql.unsafe(`begin;${views.length ? `drop view ${views.join(", ")} cascade;` : ""}${tbls.length ? `drop table ${tbls.join(", ")} cascade;` : ""}commit;`);
  }
  await sql.unsafe(`drop schema if exists "${schema}" cascade`);
}

// Drops every cached catalog's schemas, those named slperf_*, from the database at `url`.
async function dropPgCatalogs(url: string): Promise<string[]> {
  const sql = new SQL({ url, max: 1 });
  try {
    const rows = await sql`select nspname from pg_namespace where nspname like 'slperf\_%' order by nspname`;
    const names = rows.map((r: { nspname: string }) => r.nspname);
    for (const s of names) await dropSchema(sql, s);
    return names;
  } finally {
    await sql.close();
  }
}

// `bun tests/perf/catalog.ts --drop-pg` drops the cached Postgres catalogs from PG_URL's database.
if (import.meta.main && process.argv.includes("--drop-pg")) {
  const url = process.env.PG_URL;
  if (!url) throw new Error("Set PG_URL to the database the performance suite used, then run this again.");
  const dropped = await dropPgCatalogs(url);
  console.log(dropped.length ? `Dropped ${dropped.length} schemas: ${dropped.join(", ")}.` : "No slperf_* schemas to drop.");
}

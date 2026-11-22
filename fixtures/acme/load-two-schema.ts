// Leaves two schemas in one database: the Acme warehouse and a small billing schema whose invoices
// have a foreign key into acme.dim_customers. For the walkthrough of the schema question.
//
//   PG_URL=postgres://... bun fixtures/acme/load-two-schema.ts [acmeSchema] [billingSchema]
//
// The defaults are acme and billing. Both are dropped and recreated; no other schema is touched.
// billing.sql is read as text, its two schema names are replaced by the validated names given, and
// the statements go to Postgres; nothing here runs it in a shell.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { loadPostgres, type LoadResult } from "./load-postgres.ts";

export const BILLING_SCRIPT = join(import.meta.dir, "billing.sql");
const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

export interface TwoSchemaResult {
  acme: LoadResult;
  billing: { schema: string; rows: { invoices: number } };
}

/** Replaces both default names in one pass, so names that swap the defaults cannot chain. */
export function placeSchemas(script: string, acmeSchema: string, billingSchema: string): string {
  return script.replace(/\b(billing|acme)\b/g, (m) => (m === "billing" ? billingSchema : acmeSchema));
}

export async function loadTwoSchema(url: string, acmeSchema = "acme", billingSchema = "billing"): Promise<TwoSchemaResult> {
  for (const s of [acmeSchema, billingSchema]) if (!SCHEMA_NAME.test(s)) throw new Error(`invalid schema name ${s}`);
  if (acmeSchema === billingSchema) throw new Error("the two schemas need different names");
  const script = placeSchemas(readFileSync(BILLING_SCRIPT, "utf8"), acmeSchema, billingSchema);
  const acme = await loadPostgres(url, join(import.meta.dir, "data"), acmeSchema);
  const sql = new SQL({ url, max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(script);
    });
    const [row] = (await sql.unsafe(`select count(*)::int as n from "${billingSchema}".invoices`)) as { n: number }[];
    return { acme, billing: { schema: billingSchema, rows: { invoices: row!.n } } };
  } finally {
    await sql.close();
  }
}

if (import.meta.main) {
  const url = process.env.PG_URL;
  if (!url) {
    console.error("Set PG_URL to the Postgres connection URL.");
    process.exit(1);
  }
  const acmeSchema = process.argv[2] ?? "acme";
  const billingSchema = process.argv[3] ?? "billing";
  for (const s of [acmeSchema, billingSchema]) {
    if (!SCHEMA_NAME.test(s)) {
      console.error("Schema must match [a-z_][a-z0-9_]*");
      process.exit(1);
    }
  }
  const r = await loadTwoSchema(url, acmeSchema, billingSchema);
  const total = Object.values(r.acme.rows).reduce((s, n) => s + n, 0);
  console.log(`Loaded ${Object.keys(r.acme.rows).length} tables, ${total} rows, into schema ${r.acme.schema}, and ${r.billing.rows.invoices} invoices into schema ${r.billing.schema}.`);
}

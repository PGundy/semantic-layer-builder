// The Chinook layer the time-view tests share (tests/compat/running-total.test.ts, and the
// comparison and trailing-window tests after it). chinookLayer(url) loads the public Chinook sample
// database (fixtures/chinook) into a unique schema of the server url names and builds, with typed
// commands and the owner's recorded yeses, a project whose source `chinook` holds one approved model:
// - invoice, one row per invoice: dimensions invoice_date (type time, time_zone UTC),
//   invoice_date_ny (the same moment as a New York wall-clock time) and billing_country; measures
//   revenue (sum of total, USD) and invoice_count (count);
// - metric avg_invoice_value, revenue over invoice_count.
// It returns the project root, the schema, the env its commands need (SEMLAYER_TEST_PG) and a
// cleanup that removes the project and drops the schema. Every figure in it is Chinook's.
import { loadChinook } from "../../fixtures/chinook/load-postgres.ts";
import { SQL } from "bun";
import { approveWithYes, assertLocalPg, type CliRun, initProject, semlayer, tempRoot, uniqueSchema } from "../helpers.ts";

export interface ChinookLayer {
  root: string;
  dir: string;
  schema: string;
  env: Record<string, string>;
  // semlayer in the project with env, which throws with the output when the command fails.
  run: (args: string[]) => Promise<CliRun>;
  cleanup: () => Promise<void>;
}

export async function chinookLayer(url: string): Promise<ChinookLayer> {
  assertLocalPg(url);
  const schema = uniqueSchema("t_chinook");
  await loadChinook(url, schema);
  const t = tempRoot();
  const env = { SEMLAYER_TEST_PG: url };
  const run = async (args: string[]) => {
    const r = await semlayer(t.root, args, env);
    if (r.code !== 0) throw new Error(`semlayer ${args.join(" ")}:\n${r.out}\n${r.err}`);
    return r;
  };
  const cleanup = async () => {
    t.cleanup();
    const pg = new SQL({ url, max: 1 });
    try {
      await pg.unsafe(`drop schema if exists "${schema}" cascade`);
    } finally {
      await pg.close();
    }
  };
  try {
    await initProject(t.root);
    await run(["setup", "--source", "chinook", "--dialect", "postgres", "--env", "SEMLAYER_TEST_PG", "--schemas", schema, "--primary", schema]);
    await run(["draft", "--source", "chinook", "--tables", `${schema}.invoice`]);
    // The layer holds the invoice table alone: the customer join, the address fields and the
    // distinct customer count leave it.
    await run(["remove-join", "--source", "chinook", "--model", "invoice", "--name", "customer"]);
    for (const f of ["billing_address", "billing_city", "billing_state", "billing_postal_code", "customer_count"]) await run(["remove-field", `chinook.invoice.${f}`]);
    await run(["rename", "chinook.invoice.total", "revenue"]);
    await run(["set", "chinook.invoice", "grain", "One row per invoice."]);
    await run(["set", "chinook.invoice.invoice_date", "time_zone", "UTC"]);
    await run(["set", "chinook.invoice.invoice_date", "description", "When the invoice was issued, a UTC wall-clock time."]);
    await run(["set", "chinook.invoice.billing_country", "description", "The country of the billing address."]);
    await run(["set", "chinook.invoice.revenue", "description", "The invoice total in US dollars, every invoice."]);
    await run(["set", "chinook.invoice.revenue", "currency", "USD"]);
    await run([
      "add-field",
      "chinook.invoice",
      "--kind",
      "dimension",
      "--name",
      "invoice_date_ny",
      "--expr",
      "(invoice_date at time zone 'UTC') at time zone 'America/New_York'",
      "--type",
      "time",
      "--description",
      "When the invoice was issued, as a New York wall-clock time.",
    ]);
    await run([
      "add-metric",
      "--name",
      "avg_invoice_value",
      "--type",
      "ratio",
      "--source",
      "chinook",
      "--numerator",
      "invoice.revenue",
      "--denominator",
      "invoice.invoice_count",
      "--format",
      "currency",
      "--currency",
      "USD",
      "--description",
      "Revenue per invoice.",
    ]);
    for (const args of [["--target", "chinook.invoice", "--recursive"], ["--target", "metric:avg_invoice_value"]]) {
      const r = await approveWithYes(t.root, [...args, "--by", "Test Owner"]);
      if (r.code !== 0) throw new Error(`approve ${args.join(" ")}:\n${r.out}\n${r.err}`);
    }
  } catch (e) {
    await cleanup();
    throw e;
  }
  return { root: t.root, dir: t.dir, schema, env, run, cleanup };
}

// The sample project `semlayer demo` makes (spec: CLI, Demo project): the synthetic Acme files the
// plugin ships under fixtures/acme, the DuckDB views a source reads them through, and OWNER.md, the
// cheat sheet for the person who plays the data owner.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UserError } from "./errors.ts";
import { loadProject } from "./project.ts";

export const DEMO_DIR = "semlayer-demo";
export const DEMO_PROJECT = "acme_demo";
export const DEMO_SOURCE = "acme";
export const DEMO_SHEET = "OWNER.md";
export const DEMO_PROMPT = "help me build a semantic layer for the data in this folder";
export const REPOSITORY = "https://github.com/PGundy/semantic-layer-builder";
// The snapshot's captured_at when SEMLAYER_NOW is not set: the day after the data ends, so two
// runs give the same bytes.
export const DEMO_NOW = "2026-01-01T00:00:00.000Z";
export const DEMO_NOTE = `This is the demo project: ${DEMO_SHEET} belongs to the person playing the owner; do not read it, and take every answer from the owner.`;

// True for a root semlayer demo made: project acme_demo with OWNER.md beside the root.
export function isDemo(root: string): boolean {
  if (!existsSync(join(dirname(root), DEMO_SHEET))) return false;
  try {
    return loadProject(root).name === DEMO_PROJECT;
  } catch {
    return false;
  }
}

// The plugin root, found from this file's real path (lib, scripts, semantic-layer, skills), so the
// working directory and a symlink to the CLI change nothing.
export function pluginRoot(): string {
  return resolve(dirname(realpathSync(import.meta.path)), "..", "..", "..", "..");
}

export interface DemoData {
  // fixtures/acme under the plugin root.
  acme: string;
  // Every file under fixtures/acme/data, relative to it, sorted.
  files: string[];
  // View name to relation, as the source file holds them; paths resolve from the semantic root.
  views: [string, string][];
  figures: Figures;
}

interface Figure {
  name: string;
  value?: number;
  rows?: Record<string, unknown>[];
  definition: string;
}
interface Figures {
  figures: Figure[];
  common_mistakes: Figure[];
}

function walk(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel))
    .sort()
    .flatMap((name) => {
      const r = rel ? `${rel}/${name}` : name;
      return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r];
    });
}

// The plugin's sample files, or a refusal naming what is missing and where to get it.
export function demoData(plugin: string): DemoData {
  const acme = join(plugin, "fixtures", "acme");
  const data = join(acme, "data");
  const figuresFile = join(acme, "reference-figures.json");
  const warehouse = join(data, "warehouse");
  const lake = join(data, "lake");
  const csv = existsSync(warehouse) ? readdirSync(warehouse).filter((f) => f.endsWith(".csv")).sort() : [];
  const parquet = existsSync(lake) ? readdirSync(lake).sort() : [];
  if (!csv.length || !parquet.length || !existsSync(figuresFile)) {
    throw new UserError(
      `This copy of semlayer has no sample data: semlayer demo copies it from ${data}, which is not there. ` +
        `A copy of the skill directory alone does not include it. Install the plugin (claude plugin marketplace add ${REPOSITORY.replace("https://github.com/", "")}, ` +
        `then claude plugin install semantic-layer-builder@semantic-layer-builder) and run semlayer demo, ` +
        `or clone ${REPOSITORY}, run bun install in the clone and run bun skills/semantic-layer/scripts/semlayer.ts demo there.`,
      `git clone ${REPOSITORY}`,
    );
  }
  const views: [string, string][] = csv.map((f) => [f.slice(0, -4), `read_csv('../data/warehouse/${f}')`]);
  for (const f of parquet) {
    // A folder of Parquet files (one per year) is one dataset; a single file is another.
    if (statSync(join(lake, f)).isDirectory()) views.push([f, `read_parquet('../data/lake/${f}/*.parquet')`]);
    else if (f.endsWith(".parquet")) views.push([f.slice(0, -8), `read_parquet('../data/lake/${f}')`]);
  }
  return { acme, files: walk(data), views, figures: JSON.parse(readFileSync(figuresFile, "utf8")) as Figures };
}

// 301050.82 as $301,050.82; whole numbers of a count as 2,239.
function usd(n: number): string {
  const [whole, cents] = n.toFixed(2).split(".");
  return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}
function count(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// OWNER.md: what the person playing the owner knows, in the owner's words, from
// fixtures/acme/owner-brief.md, with the 2025 figures of reference-figures.json.
export function ownerSheet(figures: Figures): string {
  const by = new Map(figures.figures.map((f) => [f.name, f]));
  const value = (name: string, fmt: (n: number) => string) => {
    const v = by.get(name)?.value;
    return v === undefined ? "not recorded" : fmt(v);
  };
  const regions = (by.get("revenue_by_region_2025")?.rows ?? []).map(
    (r) => `  - ${String(r.region_name)} (${String(r.region_code)}): ${usd(Number(r.revenue))} from ${count(Number(r.orders))} orders`,
  );
  const mistakes = figures.common_mistakes.filter((m) => m.value !== undefined).map((m) => `- ${usd(m.value!)}: ${m.definition}`);
  return `# You are the data owner

This folder is a practice run of semlayer. Every value in it is synthetic: Acme is a made-up online store and no row describes a real person or company. You play its data owner, Dana Ruiz, Head of Analytics. The agent asks you what the data means; answer from this sheet, in your own words. When something is not covered here, say you don't know; don't invent a rule. Approve as yourself or as "Dana Ruiz".

This sheet is for you. The agent does not read it: it learns the rules only from your answers.

## What the store has

- \`data/warehouse/\`: the store's warehouse, 20 tables as CSV. Six matter: \`fct_orders\`, \`fct_order_items\`, \`fct_refunds\`, \`dim_customers\`, \`dim_products\` and \`dim_regions\`. The other \`fct_\` and \`dim_\` tables are an old snapshot (\`dim_customers_archive\`), an abandoned test (\`fct_orders_v2_test\`) and an unused currency table (\`dim_currency\`); everything else is raw ingestion, staging, backups, a saved report and logs. Ignore them.
- \`data/lake/\`: web events as Parquet. \`web_events\`, \`sessions\` and \`marketing_spend\` matter; ignore \`web_events_2024_archive\` (a partial copy) and \`tmp_session_dedupe\` (scratch).
- Plain names for the models: \`orders\`, \`order_items\`, \`refunds\`, \`customers\`, \`products\`, \`regions\`.

## Rules you know

- **Money** is in integer cents: divide by 100 for US dollars. \`amount_cents\` is after discounts and excludes shipping; shipping is not revenue.
- **Which orders count**: status \`completed\` or \`shipped\`. \`cancelled\` and \`refunded\` orders are not revenue.
- **Test accounts**: \`is_test_account\` is true, or the email ends in \`@example-test.com\` (QA forgets the flag). Both are left out of every figure.
- **Deleted customers**: about 1% of orders point at customers who are no longer in \`dim_customers\`. Those orders are real and still count; never drop them by joining to customers.
- **Which date is the date**: an order is dated by \`created_at\`, a session by \`started_at\`, all in UTC. A refund counts on its order's date, not on \`refunded_at\`.
- **Refunds**: most are partial, and an order can have several, so they are summed per order before they meet order figures. Net revenue is revenue minus refunds of the orders counted in revenue.
- **Regions**: six, \`NE\`, \`SE\`, \`MW\`, \`SW\`, \`WC\` and \`INT\` (International). Regional reports use the order's \`ship_region\`, not the customer's home \`region_code\`; they differ for a few percent of orders.
- **Sessions**: about 60% are anonymous (no \`customer_id\`) and still count. The \`purchase\` web event is front-end tracking, not the record of orders.
- **Who may see what**: analysts see everything in scope except personal data: \`email\`, \`phone\`, \`first_name\` and \`last_name\` of customers (customer ids are fine). Sales reps see only orders and customers of their own region (\`ship_region\` for orders, \`region_code\` for customers), with names and phones but not emails. Marketing sees the three lake tables and order totals by date, status and region, with no personal data and no refunds.

## 2025 figures you trust from your reports

- Revenue: ${value("revenue_2025", usd)}, from ${value("order_count_2025", count)} orders (average order value ${value("average_order_value_2025", usd)}).
- Revenue by region:
${regions.join("\n")}
- Refunds on 2025 orders: ${value("refunds_on_2025_orders", usd)}; net revenue ${value("net_revenue_2025", usd)}.
- Sessions (anonymous ones included, dated by \`started_at\`): ${value("sessions_2025", count)}. Marketing spend (\`spend_cents\` / 100): ${value("marketing_spend_2025", usd)}.
- New customers (customers whose first order counted in revenue falls in 2025): ${value("new_customers_2025", count)}.

## If a figure looks off

These are what a missed rule gives for 2025 revenue or refunds. Tell the agent which rule looks missed, in plain words.

${mistakes.join("\n")}
`;
}

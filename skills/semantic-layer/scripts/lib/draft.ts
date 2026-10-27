// Drafts skeleton models from a snapshot by fixed rules: names, keys, joins,
// dimensions, measures, pii and sensitive tags, the columns left out and the open questions the
// owner must answer. Every item is written as draft; nothing here guesses meaning beyond the rules.
import { classifyType, isNumeric } from "./column-types.ts";
import { quoteIdent } from "./dialect.ts";
import { findTable, qualifiedName, toSpecName } from "./naming.ts";
import { summarizeTable } from "./profile.ts";
import { nearUnique, PII_NAME, sensitivityOf } from "./sensitivity.ts";
import { incomingKeyColumns, referencedColumns, sqlIdentifiers, unreferencedColumns } from "./snapshot-diff.ts";
import type {
  Dialect,
  Dimension,
  Format,
  Join,
  JoinKey,
  Measure,
  Model,
  Relationship,
  Snapshot,
  SnapshotColumn,
  SnapshotTable,
  TimeGrain,
} from "./types.ts";

export interface DraftOptions {
  source: string;
  stripPrefixes: string[];
  // Tables a join may target: in scope or already modeled.
  knownTables: SnapshotTable[];
}

export interface DraftResult {
  models: Model[];
  notes: string[];
}

// Warehouse prefixes ignored when matching a table name to a key column name.
const CONVENTIONAL_PREFIXES = ["fct_", "fact_", "dim_", "stg_", "staging_", "raw_", "src_", "int_"];

const DATE_GRAINS: TimeGrain[] = ["day", "week", "month", "quarter", "year"];
const TIMESTAMP_GRAINS: TimeGrain[] = ["hour", ...DATE_GRAINS];

// Name rules match whole snake_case tokens, so country_code is not a count and duration is not a ratio.
const SUM_NAME =
  /(^|_)(sub)?(amount|price|cost|revenue|total|value|spend|fee|tax|discount|balance|shipping|freight|gross|net|profit|margin|payment|charge|refund|refunded|cents|pennies|salary|wage|income|budget|qty|quantity|units?|count|duration|minutes|seconds)(s|es)?(_|$)/;
const RATE_NAME = /(^|_)(rate|pct|percent|percentage|ratio)s?(_|$)/;
const COUNT_NAME = /(^|_)(qty|quantity|units?|count)s?(_|$)/;
const DURATION_NAME = /(^|_)(duration|minutes|seconds)s?(_|$)/;
const MONEY_NAME = /(^|_)(sub)?(amount|price|cost|revenue|total|value|spend|fee|tax|discount|balance|shipping|freight|gross|net|profit|margin|payment|charge|refund|refunded|cents|pennies|salary|wage|income|budget)(s|es)?(_|$)/;
const CENTS_NAME = /_(cents|pennies)$/;
const CENTS_TEXT = /\b(cents|pennies)\b/i;
const NOT_CENTS_TEXT = /\bnot (in )?(cents|pennies)\b/i;
// A description naming whole currency units says the column is not in cents.
const WHOLE_UNITS_TEXT = /\b(dollars|euros|pounds|yen|whole (currency )?units|major units)\b/i;
// A name that ends or starts with a count word counts things even when it also names money:
// payment_count, total_qty, units_refunded, count_of_refunds. A singular unit is not a count word: price_per_unit.
const COUNT_SUFFIX = /(^|_)(qty|quantity|quantities|units|count)s?$/;
const COUNT_PREFIX = /^(qty|quantity|quantities|units|count)_/;
// Plural nouns of things counted per row, which add up across rows: page_views, clicks, email_opens.
// A name counts them when it ends with one, or starts with one and names no money or duration
// (impressions_served, clicks_total, not conversions_value_cents or sessions_duration_seconds), and names no
// ratio or statistic (clicks_per_session, avg_clicks, max_views, impressions_share).
const ADDITIVE_COUNT_SUFFIX = /(^|_)(impressions|clicks|views|visits|sessions|signups|conversions|installs|opens|events|pageviews|sends)$/;
const ADDITIVE_COUNT_PREFIX = /^(impressions|clicks|views|visits|sessions|signups|conversions|installs|opens|events|pageviews|sends)_/;
// Money names other than total: clicks_total totals clicks, conversions_value_cents is money.
const MONEY_UNIT_NAME = /(^|_)(sub)?(amount|price|cost|revenue|value|spend|fee|tax|discount|balance|shipping|freight|gross|net|profit|margin|payment|charge|refund|refunded|cents|pennies|salary|wage|income|budget)(s|es)?(_|$)/;
const NOT_ADDITIVE = /(^|_)(per|avg|average|mean|median|min|max|p\d+|share)(_|$)/;
// Per-unit prices: averaged, never summed. A total, subtotal, line or extended price is not per unit.
const PER_UNIT_PRICE = /(^|_)(prices?|unit_costs?)(_|$)/;
// A money name ending _per_unit is a per-unit price: cost_per_unit, revenue_per_unit_cents.
const PER_UNIT_SUFFIX = /_per_units?(_cents|_pennies)?$/;
const NOT_PER_UNIT = /(^|_)(total|subtotal|line|extended)s?(_|$)/;
const PER_UNIT_RATE = /_rates?(_cents|_pennies)?$/;
// The column a line total multiplies a per-unit price by.
const QUANTITY_NAME = /(^|_)(qty|quantity|quantities|units)(_|$)/;
const EXACT_QUANTITY_NAME = /^(qty|quantity|quantities|units)$/;
// "Orders from the storefront, one row per order." -> order. The capture stops at a line break or bracket.
const GRAIN_TEXT = /one row per ([^.,;:()[\]\r\n]+)/i;
// A foreign key whose target has at most this many rows gets no count measure.
const SMALL_TARGET_ROWS = 20;
const NUMBER_DIMENSION_MAX_DISTINCT = 20;

// Words that name a keyword, built-in value or function in at least one supported dialect
// (Postgres and DuckDB reserved and type/function-name keywords, plus the Snowflake, BigQuery and
// Databricks reserved words). A column with one of these names is always quoted.
const RESERVED = new Set(
  (
    "account all alter analyse analyze and anti any array as asc asof assert_rows_modified asymmetric at authorization " +
    "between binary both by case cast check collate collation column columns commit concurrently connect connection " +
    "constraint contains create cross cube current current_catalog current_date current_role current_schema current_time " +
    "current_timestamp current_user database default deferrable define delete desc describe distinct do drop else end enum " +
    "escape except exclude exists external extract false fetch filter following for foreign from full function generated " +
    "glob global grant group grouping groups gscluster hash having if ignore ilike in increment initially inner insert " +
    "intersect interval into is isnull issue join lambda lateral leading left like limit local localtime localtimestamp " +
    "lookup map merge minus natural new no not notnull null nulls of offset on only or order organization out outer over " +
    "overlaps partition pivot pivot_longer pivot_wider placing position positional preceding primary proto qualify range " +
    "recursive references regexp respect returning revoke right rlike rollback rollup row rows sample schema select semi " +
    "session_user set show similar some start struct summarize symmetric system_user table tablesample then time to " +
    "trailing treat trigger true truncate try_cast tuple unbounded union unique unknown unnest unpack unpivot update user " +
    "using values variadic verbose view when whenever where window with within"
  ).split(" "),
);

const IRREGULAR_PLURALS: Record<string, string> = {
  series: "series",
  species: "species",
  aliases: "alias",
  analyses: "analysis",
  buses: "bus",
  bonuses: "bonus",
  campuses: "campus",
  censuses: "census",
  statuses: "status",
  viruses: "virus",
};

// Singular form of the last word of a snake_case name: order_items -> order_item.
export function singular(name: string): string {
  const last = name.match(/[a-z0-9]+$/i)?.[0] ?? name;
  const irregular = IRREGULAR_PLURALS[last.toLowerCase()];
  if (irregular !== undefined) return name.slice(0, name.length - last.length) + irregular;
  if (/ies$/.test(name) && name.length > 4) return name.replace(/ies$/, "y");
  if (/(ss|us|is)$/.test(name)) return name;
  if (/(sses|xes|ches|shes)$/.test(name)) return name.replace(/es$/, "");
  if (/s$/.test(name) && name.length > 1) return name.replace(/s$/, "");
  return name;
}

// The table name minus the first strip prefix it starts with (case-insensitive), or unchanged.
export function stripTablePrefix(name: string, prefixes: string[]): string {
  const lower = name.toLowerCase();
  for (const p of prefixes) {
    if (p && lower.startsWith(p.toLowerCase()) && name.length > p.length) return name.slice(p.length);
  }
  return name;
}

function tableKey(t: { schema?: string | null; name: string }): string {
  return qualifiedName(t).toLowerCase();
}

// A money expression stored in hundredths, in whole currency units and exact numeric arithmetic:
// DuckDB multiplies by the DECIMAL 0.01 (dividing by 100.0 gives a DOUBLE there), BigQuery
// divides a NUMERIC, and the other dialects divide by the numeric literal 100.0.
export function centsExpr(dialect: Dialect, expr: string): string {
  if (dialect === "duckdb") return `${expr} * 0.01`;
  if (dialect === "bigquery") return `cast(${expr} as numeric) / 100`;
  return `${expr} / 100.0`;
}

// A physical column name as an expression. It is bare only when the dialect resolves the bare
// name to exactly that column: plain uppercase on Snowflake, which folds unquoted names to
// uppercase; plain lowercase elsewhere. Keywords are always quoted.
export function columnExpr(dialect: Dialect, name: string): string {
  const plain = dialect === "snowflake" ? /^[A-Z_][A-Z0-9_$]*$/ : /^[a-z_][a-z0-9_]*$/;
  return plain.test(name) && !RESERVED.has(name.toLowerCase()) ? name : quoteIdent(dialect, name);
}

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface InferredKey {
  columns: string[];
  how: "declared" | "unique" | "naming";
}

// Name forms a key column may take for a table: id-style names built from the
// raw name, the stripped name and the name without a conventional prefix.
function tableNameForms(name: string, stripPrefixes: string[]): string[] {
  const raw = toSpecName(name);
  const stripped = toSpecName(stripTablePrefix(name, stripPrefixes));
  const bare = toSpecName(stripTablePrefix(stripped, CONVENTIONAL_PREFIXES));
  return [...new Set([stripped, bare, raw])];
}

// The table's primary key: declared, else its single unique key, else an id-named column
// that the profile reports as a candidate key (never null, one distinct value per row, within
// the profile's tolerance when the counts are sampled or the dialect counts approximately).
export function inferPrimaryKey(table: SnapshotTable, stripPrefixes: string[], dialect?: Dialect): InferredKey | null {
  if (table.primary_key?.length) return { columns: [...table.primary_key], how: "declared" };
  if (table.unique_keys?.length === 1 && table.unique_keys[0]!.length) return { columns: [...table.unique_keys[0]!], how: "unique" };
  const keys = new Set(summarizeTable(table, dialect).candidate_keys);
  if (!keys.size) return null;
  const candidates = ["id"];
  for (const form of tableNameForms(table.name, stripPrefixes)) candidates.push(`${singular(form)}_id`, `${form}_id`);
  for (const candidate of [...new Set(candidates)]) {
    const col = table.columns.find((c) => toSpecName(c.name) === candidate);
    if (col && keys.has(col.name)) return { columns: [col.name], how: "naming" };
  }
  return null;
}

// Hands out names within one model's shared namespace of dimensions, measures and joins.
class Namespace {
  private taken: Set<string>;
  constructor(reserved: Iterable<string> = []) {
    this.taken = new Set(reserved);
  }
  claim(...options: string[]): string {
    for (const o of options) {
      if (o && !this.taken.has(o)) {
        this.taken.add(o);
        return o;
      }
    }
    const base = options[0] ?? "field";
    let i = 2;
    while (this.taken.has(`${base}_${i}`)) i++;
    const name = `${base}_${i}`;
    this.taken.add(name);
    return name;
  }
}

interface Context {
  snapshot: Snapshot;
  opts: DraftOptions;
  known: Set<string>;
  // Qualified table (lowercase) -> model name, existing or as it will be drafted.
  names: Map<string, string>;
  // Qualified table (lowercase) -> primary key of an existing model.
  modeledKeys: Map<string, string[]>;
  // Qualified tables (lowercase) that already have a model.
  modeled: Set<string>;
  // Qualified tables (lowercase) drafted in this run.
  drafting: Set<string>;
}

function primaryKeyOf(ctx: Context, table: SnapshotTable): string[] {
  const modeled = ctx.modeledKeys.get(tableKey(table));
  if (modeled?.length) return modeled;
  return inferPrimaryKey(table, ctx.opts.stripPrefixes, ctx.snapshot.dialect)?.columns ?? [];
}

// A join in an existing model whose target model does not exist yet.
interface ExpectedTarget {
  // The model name the join expects.
  name: string;
  // The target-side key columns of the join.
  keyColumns: string[];
  // model.join, for notes.
  ref: string;
}

// Joins in existing models that name a model which does not exist.
function expectedTargets(existing: Model[]): ExpectedTarget[] {
  const modelNames = new Set(existing.map((m) => m.model));
  const out: ExpectedTarget[] = [];
  for (const m of existing) {
    for (const j of Array.isArray(m.joins) ? m.joins : []) {
      if (typeof j?.to !== "string" || modelNames.has(j.to)) continue;
      const keyColumns = (Array.isArray(j.keys) ? j.keys : []).map((k) => k?.to).filter((c): c is string => typeof c === "string");
      out.push({ name: j.to, keyColumns, ref: `${m.model}.${j.name}` });
    }
  }
  return out;
}

// Names a table could have been drafted under: its spec name with any leading words removed,
// with and without its schema in front. dim_customers in analytics -> dim_customers, customers,
// analytics_dim_customers, analytics_customers.
function draftedNameForms(t: SnapshotTable): Set<string> {
  const words = toSpecName(t.name).split("_");
  const forms = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const tail = words.slice(i).join("_");
    if (!/^[a-z]/.test(tail)) continue;
    forms.add(tail);
    if (t.schema) forms.add(toSpecName(`${t.schema}_${tail}`));
  }
  return forms;
}

// Model names for every table that has none yet, so drafted names and join targets agree.
// A table takes the name an existing model's join already expects when it is the only
// candidate whose name forms include that name and whose columns hold the join's keys.
function planNames(
  candidates: SnapshotTable[],
  existing: Model[],
  stripPrefixes: string[],
  notes: string[],
  drafting: Set<string>,
): Map<string, string> {
  const taken = new Set(existing.map((m) => m.model));
  const sorted = [...candidates].sort((a, b) => qualifiedName(a).localeCompare(qualifiedName(b)));
  const out = new Map<string, string>();
  const byName = new Map<string, ExpectedTarget[]>();
  for (const e of expectedTargets(existing)) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  for (const [name, joins] of byName) {
    if (taken.has(name)) continue;
    const keyColumns = [...new Set(joins.flatMap((j) => j.keyColumns.map((c) => c.toLowerCase())))];
    const matches = sorted.filter(
      (t) =>
        !out.has(tableKey(t)) &&
        draftedNameForms(t).has(name) &&
        keyColumns.every((k) => t.columns.some((c) => c.name.toLowerCase() === k)),
    );
    if (matches.length !== 1) continue;
    const t = matches[0]!;
    taken.add(name);
    out.set(tableKey(t), name);
    if (drafting.has(tableKey(t))) notes.push(`${qualifiedName(t)} is named ${name}, the model ${listPhrase(joins.map((j) => j.ref))} already ${joins.length === 1 ? "joins" : "join"} to.`);
  }
  const rest = sorted.filter((t) => !out.has(tableKey(t)));
  const base = new Map(rest.map((t) => [tableKey(t), toSpecName(stripTablePrefix(t.name, stripPrefixes))]));
  const counts = new Map<string, number>();
  for (const b of base.values()) counts.set(b, (counts.get(b) ?? 0) + 1);
  for (const t of rest) {
    const b = base.get(tableKey(t))!;
    const stripped = stripTablePrefix(t.name, stripPrefixes);
    const options: string[] = [];
    if (counts.get(b) === 1) options.push(b);
    if (t.schema) options.push(toSpecName(`${t.schema}_${stripped}`), toSpecName(`${t.schema}_${t.name}`));
    else options.push(toSpecName(t.name));
    let name = options.find((o) => !taken.has(o));
    if (!name) {
      let i = 2;
      while (taken.has(`${b}_${i}`)) i++;
      name = `${b}_${i}`;
    }
    taken.add(name);
    out.set(tableKey(t), name);
  }
  return out;
}

function referencedTable(ctx: Context, table: SnapshotTable, ref: { schema?: string | null; table: string }): SnapshotTable | undefined {
  const schema = ref.schema ?? table.schema;
  return findTable(ctx.snapshot.tables, qualifiedName({ schema, name: ref.table }));
}

// Forms a table name takes when it holds the rows an <x>_id column points at.
function targetForms(x: string): string[] {
  const forms = [x, `${x}s`, `${x}es`];
  if (/[^aeiou]y$/.test(x)) forms.push(x.replace(/y$/, "ies"));
  return [...forms, ...forms.filter((f) => f !== `${x}es`).map((f) => `dim_${f}`)];
}

interface Candidate {
  table: SnapshotTable;
  keyColumn: string;
  known: boolean;
  nameMatch: boolean;
}

// Tables a column named <x>_id may point at: those keyed by <x>_id, or keyed by id and named for x.
function joinCandidates(ctx: Context, self: SnapshotTable, x: string): Candidate[] {
  const forms = new Set(targetForms(x));
  const out: Candidate[] = [];
  // A column named for the table it sits in is that table's own key, not a reference.
  if (tableNameForms(self.name, ctx.opts.stripPrefixes).some((f) => forms.has(f))) return out;
  for (const t of ctx.snapshot.tables) {
    if (tableKey(t) === tableKey(self)) continue;
    const pk = primaryKeyOf(ctx, t);
    if (pk.length !== 1) continue;
    const pkNorm = toSpecName(pk[0]!);
    const nameMatch = tableNameForms(t.name, ctx.opts.stripPrefixes).some((f) => forms.has(f));
    if (pkNorm === `${x}_id` || (pkNorm === "id" && nameMatch)) {
      out.push({ table: t, keyColumn: pk[0]!, known: ctx.known.has(tableKey(t)), nameMatch });
    }
  }
  return out.sort(
    (a, b) =>
      Number(b.known) - Number(a.known) ||
      Number(b.nameMatch) - Number(a.nameMatch) ||
      Number(b.table.schema === self.schema) - Number(a.table.schema === self.schema) ||
      qualifiedName(a.table).localeCompare(qualifiedName(b.table)),
  );
}

// How a numeric column that is neither a key nor personal data drafts as a measure.
interface NumericRule {
  agg: "sum" | "avg";
  format: Format;
  // A per-unit price or a name ending _rate: averaged, and offered as a line total.
  perUnit: boolean;
}

// The measure rule a numeric column's name selects, or null when its name selects none.
// Per-unit prices and names ending _rate are averaged; other rates select no rule. Money names are
// tested before count names, except that a name ending or starting with a count word is a count.
// A name ending with an additive count noun (impressions, clicks, sessions, ...), or starting with
// one and naming no money or duration, is a count summed as an integer unless it names a ratio or
// statistic.
export function numericRule(norm: string): NumericRule | null {
  if (RATE_NAME.test(norm)) {
    const perUnit = PER_UNIT_RATE.test(norm);
    if (!perUnit) return null;
    return { agg: "avg", format: CENTS_NAME.test(norm) ? "currency" : "number", perUnit };
  }
  const isAdditiveCount =
    !NOT_ADDITIVE.test(norm) &&
    (ADDITIVE_COUNT_SUFFIX.test(norm) || (ADDITIVE_COUNT_PREFIX.test(norm) && !MONEY_UNIT_NAME.test(norm) && !DURATION_NAME.test(norm)));
  const isCount = COUNT_SUFFIX.test(norm) || COUNT_PREFIX.test(norm) || isAdditiveCount;
  const perUnitPrice = (PER_UNIT_PRICE.test(norm) && !NOT_PER_UNIT.test(norm)) || (PER_UNIT_SUFFIX.test(norm) && MONEY_NAME.test(norm));
  if (perUnitPrice && !isCount) {
    return { agg: "avg", format: "currency", perUnit: true };
  }
  if (!SUM_NAME.test(norm) && !isAdditiveCount) return null;
  const format: Format = isCount
    ? "integer"
    : DURATION_NAME.test(norm)
      ? "number"
      : MONEY_NAME.test(norm)
        ? "currency"
        : COUNT_NAME.test(norm)
          ? "integer"
          : "number";
  return { agg: "sum", format, perUnit: false };
}

// The single value of a string column named currency, when its profile holds exactly one.
function singleCurrency(table: SnapshotTable): string | undefined {
  for (const c of table.columns) {
    if (toSpecName(c.name) !== "currency" || classifyType(c.type) !== "string") continue;
    const top = c.profile?.top_values;
    const distinct = c.profile?.distinct_count;
    // A redacted profile holds hashes, never a currency code.
    const first = top?.[0]?.value;
    if (c.profile?.redacted === true || (typeof first === "string" && /^sha256:[0-9a-f]{16}$/.test(first))) continue;
    if (distinct !== undefined && distinct !== 1) continue;
    const value = top?.length === 1 && typeof top[0]!.value === "string" ? top[0]!.value.trim() : "";
    if (value) return value;
  }
  return undefined;
}

// What a description says about cents: true when it says cents, false when it says not cents or
// names whole currency units, undefined when it says nothing about units.
function centsText(text: string | null | undefined): boolean | undefined {
  if (!text) return undefined;
  if (NOT_CENTS_TEXT.test(text)) return false;
  if (CENTS_TEXT.test(text)) return true;
  if (WHOLE_UNITS_TEXT.test(text)) return false;
  return undefined;
}

// A measure name for a column reported in whole currency units: amount_cents -> amount.
function unitName(norm: string, divided: boolean): string {
  if (!divided) return norm;
  const stripped = norm.replace(CENTS_NAME, "");
  return stripped && stripped !== norm ? stripped : norm;
}

interface PendingJoin {
  target: SnapshotTable;
  keys: JoinKey[];
  origin: "declared" | "inferred";
  columns: string[];
  relationship: Relationship;
}

// Settings for drafting a table that already has a model, so only its new columns are kept.
interface DraftOneOptions {
  // Names the model already uses; drafted fields take other names.
  reserved?: Iterable<string>;
  // The model's primary key, used in place of an inferred one.
  primaryKey?: string[];
}

interface DraftedTable {
  model: Model;
  // Column -> why the draft gives it no dimension or measure.
  leftOut: Map<string, string>;
  // Column -> the sensitivity tag and reason of the fields drafted from it.
  sensitivity: Map<string, { tag: string; reason: string }>;
  // Column -> the table its inferred or declared join reaches.
  joinTargets: Map<string, string>;
  // Open question -> the columns it is about.
  questionColumns: Map<string, string[]>;
  // Money columns drafted as measures, the table's single currency and the question about them.
  money: string[];
  currency?: string;
  currencyQuestion?: string;
}

// The question asking which currency money columns are in, or confirming the table's single currency.
function currencyQuestion(q: string, money: string[], currency: string | undefined): string {
  const one = money.length === 1;
  return currency
    ? `The currency column of ${q} holds only ${currency}, so ${listPhrase(money)} ${one ? "is" : "are"} drafted with currency ${currency}. Is every row in ${currency}?`
    : `Which currency ${one ? "is" : "are"} ${listPhrase(money)} in?`;
}

// True when every column of the table is an id column and there are two or three of them: a link
// or closure table, whose key is the combination of its columns.
function idColumnsOnly(table: SnapshotTable): boolean {
  return table.columns.length >= 2 && table.columns.length <= 3 && table.columns.every((c) => /_id$/.test(toSpecName(c.name)));
}

function draftOne(ctx: Context, table: SnapshotTable, modelName: string, notes: string[], one: DraftOneOptions = {}): DraftedTable {
  const { dialect } = ctx.snapshot;
  const q = qualifiedName(table);
  // A grain stated in the table comment is drafted, and the first question confirms it.
  const grain = table.description?.match(GRAIN_TEXT)?.[1]?.trim();
  const questions: string[] = [grain ? `Is one row of ${q} one ${grain}?` : `What does one row of ${q} represent?`];
  const questionColumns = new Map<string, string[]>();
  // Adds an open question about the given columns.
  const ask = (question: string, columns: readonly string[]) => {
    questions.push(question);
    questionColumns.set(question, [...new Set([...(questionColumns.get(question) ?? []), ...columns])]);
  };
  const ns = new Namespace(one.reserved);
  const leftOut = new Map<string, string>();
  const sensitivity = new Map<string, { tag: string; reason: string }>();
  const joinTargets = new Map<string, string>();

  // A new model of two or three id columns drafts each as a dimension, keyed by all of them, with
  // no count measures and a question asking the owner to confirm each combination appears once.
  const idTable = !one.primaryKey?.length && idColumnsOnly(table);
  const inferred: InferredKey | null = one.primaryKey?.length
    ? { columns: [...one.primaryKey], how: "declared" }
    : inferPrimaryKey(table, ctx.opts.stripPrefixes, dialect);
  const pk: InferredKey | null = idTable ? { columns: table.columns.map((c) => c.name), how: "unique" } : inferred;
  const pkCols = pk?.columns ?? [];
  const pkSet = new Set(pkCols.map((c) => c.toLowerCase()));
  if (idTable) {
    // A declared or unique key of the table is named in the question; the draft keys the model by every column.
    const tableKeyNote =
      inferred && inferred.how !== "naming"
        ? ` The table ${inferred.how === "declared" ? "declares the primary key" : "has the unique key"} [${inferred.columns.join(", ")}].`
        : "";
    ask(
      `primary_key [${pkCols.join(", ")}] is every column of ${q}, which holds only id columns. Does each ${
        pkCols.length === 2 ? "pair" : "combination"
      } of ${listPhrase(pkCols)} appear only once?${tableKeyNote}`,
      pkCols,
    );
  } else if (!pk) {
    ask(`Which column or columns identify one row of ${q}? No primary key is declared and none could be inferred.`, []);
  } else if (pk.how === "unique") {
    ask(`primary_key [${pkCols.join(", ")}] is the table's only unique key, not a declared primary key. Is it the key of one row?`, pkCols);
  } else if (pk.how === "naming") {
    ask(
      `primary_key [${pkCols.join(", ")}] was inferred from the column name and the profile (no nulls, one distinct value per row). Is it the key of one row?`,
      pkCols,
    );
  }
  const isSolePk = (cols: string[]) => pkCols.length === cols.length && cols.every((c) => pkSet.has(c.toLowerCase()));

  // Joins: declared foreign keys first, then <x>_id naming.
  const pending: PendingJoin[] = [];
  const fkColumns = new Set<string>();
  for (const fk of table.foreign_keys ?? []) {
    for (const c of fk.columns) fkColumns.add(c.toLowerCase());
    const target = referencedTable(ctx, table, fk.references);
    const targetName = qualifiedName({ schema: fk.references.schema ?? table.schema, name: fk.references.table });
    if (!target) {
      ask(`${fk.columns.join(", ")} references ${targetName}, which is not in the snapshot. Should it join to another table?`, fk.columns);
      continue;
    }
    if (!ctx.known.has(tableKey(target))) {
      ask(
        `${fk.columns.join(", ")} references ${qualifiedName(target)}, which is out of scope and has no model. Bring it into scope to draft this join?`,
        fk.columns,
      );
      continue;
    }
    for (const c of fk.columns) joinTargets.set(c, qualifiedName(target));
    pending.push({
      target,
      keys: fk.columns.map((c, i) => ({ from: c, to: fk.references.columns[i] ?? c })),
      origin: "declared",
      columns: fk.columns,
      relationship: isSolePk(fk.columns) ? "one_to_one" : "many_to_one",
    });
  }
  for (const col of table.columns) {
    const norm = toSpecName(col.name);
    const m = norm.match(/^(.+)_id$/);
    if (!m || fkColumns.has(col.name.toLowerCase())) continue;
    // A table's own single-column key joins only to a table named for it, never to a sibling keyed the same way.
    const solePk = isSolePk([col.name]);
    const found = joinCandidates(ctx, table, m[1]!).filter((c) => !solePk || c.nameMatch);
    const best = found[0];
    if (!best) continue;
    if (!best.known) {
      ask(
        `${col.name} looks like a key to ${qualifiedName(best.table)}, which is out of scope and has no model. Bring it into scope to draft this join?`,
        [col.name],
      );
      continue;
    }
    joinTargets.set(col.name, qualifiedName(best.table));
    const others = found.filter((c) => c.known && c !== best).map((c) => qualifiedName(c.table));
    if (others.length) {
      ask(`${col.name} is joined to ${qualifiedName(best.table)} by its name; it could also mean ${listPhrase(others)}. Which is it?`, [col.name]);
    }
    pending.push({
      target: best.table,
      keys: [{ from: col.name, to: best.keyColumn }],
      origin: "inferred",
      columns: [col.name],
      relationship: solePk ? "one_to_one" : "many_to_one",
    });
  }
  const joinColumns = new Set(pending.flatMap((j) => j.columns.map((c) => c.toLowerCase())));

  // Dimensions and column measures, in column order.
  const dimensions: Dimension[] = [];
  // Measure names are chosen after the joins are named, so a key's count can take its join's name.
  const columnMeasures: { names: () => string[]; build: (name: string) => Measure }[] = [];
  const nearUniqueColumns: string[] = [];
  // Near-unique columns left out whose names look like personal data.
  const nearUniquePii: string[] = [];
  // Columns emitted with the pii tag.
  const pii: string[] = [];
  // Columns emitted with the sensitive tag, with the reason.
  const sensitive: { column: string; reason: string }[] = [];
  // Money columns drafted divided by 100.
  const cents: string[] = [];
  // Columns averaged because no name rule says how they add up, with their measure names once claimed.
  const fallbackAvg: { column: string; name?: string }[] = [];
  const money: string[] = [];
  const rows = table.row_count ?? null;
  const currency = singleCurrency(table);
  const currencyField = (format: Format) => (format === "currency" && currency ? { currency } : {});
  // Join -> its name, filled in once the joins are named.
  const joinNames = new Map<PendingJoin, string>();

  // Optional fields in file order, present only when they hold something.
  const extras = (col: SnapshotColumn, tags?: string[]) => ({
    ...(col.description ? { description: col.description } : {}),
    ...(tags ? { tags } : {}),
  });

  const isKeyColumn = (col: SnapshotColumn) => {
    const lower = col.name.toLowerCase();
    const norm = toSpecName(col.name);
    return pkSet.has(lower) || joinColumns.has(lower) || fkColumns.has(lower) || /_id$/.test(norm) || norm === "id";
  };
  // The numeric rule of a column that drafts as a measure by its name, or null.
  const ruleOf = (col: SnapshotColumn): NumericRule | null => {
    const norm = toSpecName(col.name);
    if (!isNumeric(classifyType(col.type)) || isKeyColumn(col) || PII_NAME.test(norm)) return null;
    return numericRule(norm);
  };
  // A money column stored in hundredths: by its name, or by its own description, or, when that
  // says nothing about units, by its table's description.
  const isDivided = (col: SnapshotColumn, rule: NumericRule) =>
    rule.format === "currency" &&
    (CENTS_NAME.test(toSpecName(col.name)) || (centsText(col.description) ?? centsText(table.description) ?? false));
  const valueExprOf = (col: SnapshotColumn, rule: NumericRule) => {
    const expr = columnExpr(dialect, col.name);
    return isDivided(col, rule) ? centsExpr(dialect, expr) : expr;
  };

  // The quantity a line total multiplies by: an integer count column, an exact quantity name first.
  const quantities = table.columns.filter((c) => {
    const rule = ruleOf(c);
    return QUANTITY_NAME.test(toSpecName(c.name)) && rule?.agg === "sum" && rule.format === "integer";
  });
  const quantity = quantities.find((c) => EXACT_QUANTITY_NAME.test(toSpecName(c.name))) ?? quantities[0];
  // The per-unit column a line total multiplies: the first per-unit money column.
  const perUnitColumns = table.columns.filter((c) => ruleOf(c)?.perUnit);
  const lineTotalColumn = quantity ? perUnitColumns.find((c) => ruleOf(c)!.format === "currency") : undefined;
  let lineTotal: { name: string; expr: string } | undefined;

  for (const col of table.columns) {
    const lower = col.name.toLowerCase();
    const norm = toSpecName(col.name);
    const sens = sensitivityOf(col.name, col, rows, { key: isKeyColumn(col) });
    const isPii = sens?.tag === "pii";
    const tags = sens ? [sens.tag] : undefined;
    // Records the tag of a column that is emitted as a dimension or measure.
    const emitted = () => {
      if (!sens) return;
      sensitivity.set(col.name, sens);
      if (isPii) pii.push(col.name);
      else sensitive.push({ column: col.name, reason: sens.reason });
    };
    const expr = columnExpr(dialect, col.name);
    if (idTable) {
      emitted();
      dimensions.push({ name: ns.claim(norm), expr, type: isNumeric(classifyType(col.type)) ? "number" : "string", ...extras(col, tags), status: "draft" });
      continue;
    }
    if (isKeyColumn(col)) {
      const single = !isSolePk([col.name]) && (joinColumns.has(lower) || fkColumns.has(lower) || /_id$/.test(norm));
      const composite = (table.foreign_keys ?? []).some((fk) => fk.columns.length > 1 && fk.columns.some((c) => c.toLowerCase() === lower));
      if (single && !composite) {
        const join = pending.find((j) => j.columns.length === 1 && j.columns[0]!.toLowerCase() === lower);
        const targetRows = join?.target.row_count;
        if (join && typeof targetRows === "number" && targetRows <= SMALL_TARGET_ROWS) {
          const why = `its join reaches ${qualifiedName(join.target)}, which has ${targetRows} row${targetRows === 1 ? "" : "s"}`;
          notes.push(`${q}: no count of ${col.name} drafted; ${why}.`);
          leftOut.set(col.name, `no count drafted; ${why}`);
          continue;
        }
        emitted();
        const x = norm.replace(/_id$/, "");
        columnMeasures.push({
          names: () => [...(join ? [`${joinNames.get(join)!}_count`] : []), `${x}_count`, `distinct_${norm}_count`],
          build: (name) => ({ name, expr, agg: "count_distinct", format: "integer", ...extras(col, tags), status: "draft" }),
        });
      } else if (!pkSet.has(lower)) {
        notes.push(`${q}: left out ${col.name}, an id column that is not the primary key.`);
        leftOut.set(col.name, "an id column that is not the primary key");
      } else {
        leftOut.set(col.name, "part of the primary key");
      }
      continue;
    }
    const category = classifyType(col.type);
    if (category === "date" || category === "timestamp") {
      emitted();
      dimensions.push({
        name: ns.claim(norm),
        expr,
        type: "time",
        time_grains: category === "date" ? [...DATE_GRAINS] : [...TIMESTAMP_GRAINS],
        ...extras(col, tags),
        status: "draft",
      });
      continue;
    }
    if (category === "boolean") {
      emitted();
      dimensions.push({ name: ns.claim(norm), expr, type: "boolean", ...extras(col, tags), status: "draft" });
      continue;
    }
    if (category === "string") {
      if (nearUnique(col.profile, rows)) {
        nearUniqueColumns.push(col.name);
        if (isPii) nearUniquePii.push(col.name);
        leftOut.set(col.name, "a different value on nearly every row");
        continue;
      }
      emitted();
      dimensions.push({ name: ns.claim(norm), expr, type: "string", ...extras(col, tags), status: "draft" });
      continue;
    }
    if (isNumeric(category)) {
      const distinct = col.profile?.distinct_count;
      if (isPii) {
        emitted();
        dimensions.push({ name: ns.claim(norm), expr, type: "number", ...extras(col, ["pii"]), status: "draft" });
        continue;
      }
      const rule = numericRule(norm);
      if (rule) {
        emitted();
        const { agg, format } = rule;
        const divided = isDivided(col, rule);
        const valueExpr = valueExprOf(col, rule);
        const unit = unitName(norm, divided);
        if (divided) cents.push(col.name);
        if (format === "currency") money.push(col.name);
        columnMeasures.push({
          names: () => (agg === "avg" ? [`avg_${unit}`, `average_${unit}`] : [unit, norm, `total_${unit}`]),
          build: (name) => ({ name, expr: valueExpr, agg, format, ...currencyField(format), ...extras(col, tags), status: "draft" }),
        });
        if (col === lineTotalColumn && quantity) {
          // A divided price is parenthesized so the product is taken in numeric, not integer, arithmetic.
          const totalExpr = `${columnExpr(dialect, quantity.name)} * ${divided ? `(${valueExpr})` : valueExpr}`;
          columnMeasures.push({
            names: () => ["line_total", `line_total_${unit}`],
            build: (name) => {
              lineTotal = { name, expr: totalExpr };
              return { name, expr: totalExpr, agg: "sum", format: "currency", ...currencyField("currency"), status: "draft" };
            },
          });
        }
        continue;
      }
      if (typeof distinct === "number" && distinct <= NUMBER_DIMENSION_MAX_DISTINCT) {
        emitted();
        dimensions.push({ name: ns.claim(norm), expr, type: "number", ...extras(col, tags), status: "draft" });
        continue;
      }
      emitted();
      const fallback: { column: string; name?: string } = { column: col.name };
      fallbackAvg.push(fallback);
      columnMeasures.push({
        names: () => [`avg_${norm}`, `average_${norm}`],
        build: (name) => {
          fallback.name = name;
          return { name, expr, agg: "avg", format: "number", ...extras(col, tags), status: "draft" };
        },
      });
      continue;
    }
    notes.push(`${q}: left out ${col.name} (type ${col.type}), which drafts as neither a dimension nor a measure.`);
    leftOut.set(col.name, `type ${col.type} drafts as neither a dimension nor a measure`);
  }

  const joins: Join[] = pending.map((p) => {
    const to = tableKey(p.target) === tableKey(table) ? modelName : ctx.names.get(tableKey(p.target))!;
    const fromName = p.columns.map((c) => toSpecName(c).replace(/_id$/, "")).join("_");
    const name = tableKey(p.target) === tableKey(table) ? ns.claim(fromName, `parent_${singular(to)}`) : ns.claim(singular(to), fromName);
    joinNames.set(p, name);
    const targetKey = tableKey(p.target);
    if (targetKey !== tableKey(table) && !ctx.modeled.has(targetKey) && !ctx.drafting.has(targetKey)) {
      const prefixes = ctx.opts.stripPrefixes.filter(Boolean);
      notes.push(
        `${q}: join ${name} assumes ${qualifiedName(p.target)} will be drafted as ${to}; draft it ${
          prefixes.length ? `with the same --strip-prefix ${prefixes.join(",")}` : "without --strip-prefix"
        }.`,
      );
    }
    return { name, to, keys: p.keys, relationship: p.relationship, type: "left", origin: p.origin, status: "draft" };
  });

  // The row count leads; column measures keep column order.
  const measures: Measure[] = [
    { name: ns.claim(`${singular(modelName)}_count`, "row_count"), agg: "count", format: "integer", status: "draft" },
    ...columnMeasures.map((m) => m.build(ns.claim(...m.names()))),
  ];

  if (nearUniqueColumns.length) {
    const nu = nearUniqueColumns;
    ask(
      `${listPhrase(nu)} ${nu.length === 1 ? "has" : "have"} a different value on nearly every row and ${
        nu.length === 1 ? "was" : "were"
      } left out as ${nu.length === 1 ? "a dimension. Should it be one" : "dimensions. Should any be one"}?${
        nearUniquePii.length
          ? ` ${listPhrase(nearUniquePii)} ${nearUniquePii.length === 1 ? "looks" : "look"} like personal data; tag ${
              nearUniquePii.length === 1 ? "it" : "each"
            } pii if it is added.`
          : ""
      }`,
      nu,
    );
  }
  for (const c of cents) {
    ask(
      `Is ${c} stored in cents? The draft divides it by 100 (expr: ${centsExpr(dialect, columnExpr(dialect, c))}) to report whole currency units; confirm the division.`,
      [c],
    );
  }
  for (const f of fallbackAvg) {
    ask(
      `The name ${f.column} does not say how it adds up, so the draft averages it (${f.name}). Do people total ${f.column} or average it?`,
      [f.column],
    );
  }
  if (lineTotalColumn && quantity && lineTotal) {
    ask(
      `${lineTotalColumn.name} is a per-unit figure, so the draft averages it rather than summing it. Is a line's total ${quantity.name} times ${lineTotalColumn.name}? The draft adds the measure ${lineTotal.name}, the sum of ${lineTotal.expr}.`,
      [lineTotalColumn.name, quantity.name],
    );
  }
  const otherPerUnit = perUnitColumns.filter((c) => c !== lineTotalColumn);
  // Another per-unit money column is offered as a line total too; a non-money per-unit figure is not.
  const offerTotal = quantity ? otherPerUnit.filter((c) => ruleOf(c)!.format === "currency").map((c) => c.name) : [];
  const averageOnly = otherPerUnit.map((c) => c.name).filter((c) => !offerTotal.includes(c));
  for (const [group, withTotal] of [
    [offerTotal, true],
    [averageOnly, false],
  ] as const) {
    if (!group.length) continue;
    const one = group.length === 1;
    ask(
      `${listPhrase(group)} ${one ? "is a per-unit figure" : "are per-unit figures"}, so the draft averages ${one ? "it" : "them"} rather than summing. ${
        withTotal && quantity ? `Should ${quantity.name} times ${one ? "it" : "each"} be a line-total measure too?` : "Is an average what people report?"
      }`,
      withTotal && quantity ? [...group, quantity.name] : group,
    );
  }
  const moneyQuestion = money.length ? currencyQuestion(q, money, currency) : undefined;
  if (moneyQuestion) ask(moneyQuestion, money);
  if (pii.length) {
    ask(`${listPhrase(pii)} look${pii.length === 1 ? "s" : ""} like personal data and ${pii.length === 1 ? "is" : "are"} tagged pii. Who may see ${pii.length === 1 ? "it" : "them"}?`, pii);
  }
  if (sensitive.length) {
    const one = sensitive.length === 1;
    ask(
      `${listPhrase(sensitive.map((s) => s.column))} look${one ? "s" : ""} sensitive (${sensitive.map((s) => s.reason).join("; ")}) and ${
        one ? "is" : "are"
      } tagged sensitive. Who may see ${one ? "it" : "them"}? If everyone may, replace the tag with public.`,
      sensitive.map((s) => s.column),
    );
  }

  const model: Model = {
    model: modelName,
    source: ctx.opts.source,
    table: q,
    status: "draft",
    ...(table.description ? { description: table.description } : {}),
    ...(grain ? { grain: `One row per ${grain}.` } : {}),
    ...(pkCols.length ? { primary_key: pkCols } : {}),
    open_questions: questions,
    dimensions,
    measures,
    ...(joins.length ? { joins } : {}),
  };
  return {
    model,
    leftOut,
    sensitivity,
    joinTargets,
    questionColumns,
    money,
    ...(currency ? { currency } : {}),
    ...(moneyQuestion ? { currencyQuestion: moneyQuestion } : {}),
  };
}

// The model with ignored_columns placed after open_questions, or without the key when empty.
function withIgnored(model: Model, ignored: string[]): Model {
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [k, v] of Object.entries(model)) {
    if (k === "ignored_columns") continue;
    if (!placed && (k === "dimensions" || k === "measures" || k === "joins")) {
      if (ignored.length) out.ignored_columns = ignored;
      placed = true;
    }
    out[k] = v;
  }
  if (!placed && ignored.length) out.ignored_columns = ignored;
  return out as unknown as Model;
}

function buildContext(snapshot: Snapshot, tables: SnapshotTable[], existing: Model[], opts: DraftOptions, notes: string[]) {
  const modeledKeys = new Map<string, string[]>();
  const existingNames = new Map<string, string>();
  for (const m of existing) {
    if (typeof m.table !== "string") continue;
    const t = findTable(snapshot.tables, m.table);
    const key = t ? tableKey(t) : m.table.toLowerCase();
    if (!existingNames.has(key)) {
      existingNames.set(key, m.model);
      if (m.primary_key?.length) modeledKeys.set(key, m.primary_key);
    }
  }
  const known = new Set([...opts.knownTables, ...tables].map(tableKey));
  const byKey = new Map<string, SnapshotTable>();
  for (const t of [...opts.knownTables, ...tables]) if (!existingNames.has(tableKey(t))) byKey.set(tableKey(t), t);
  const drafting = new Set(tables.map(tableKey).filter((k) => byKey.has(k)));
  const names = new Map([...existingNames, ...planNames([...byKey.values()], existing, opts.stripPrefixes, notes, drafting)]);
  const ctx: Context = { snapshot, opts, known, names, modeledKeys, modeled: new Set(existingNames.keys()), drafting };
  return { ctx, byKey, existingNames };
}

// Drafts one model per table. Names avoid existing models and each other; joins
// reach only known tables, and anything the rules cannot settle is an open question.
// Every column of the table that no drafted field, join key or primary key reads is listed in
// the model's ignored_columns, so a later sl draft --new-columns finds only columns added since.
export function draftModels(snapshot: Snapshot, tables: SnapshotTable[], existing: Model[], opts: DraftOptions): DraftResult {
  const notes: string[] = [];
  const { ctx, byKey, existingNames } = buildContext(snapshot, tables, existing, opts, notes);
  const drafted: { model: Model; table: SnapshotTable }[] = [];
  const seen = new Set<string>();
  for (const t of tables) {
    const key = tableKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    const planned = byKey.has(key) ? ctx.names.get(key)! : undefined;
    if (!planned) {
      notes.push(`${qualifiedName(t)} already has the model ${existingNames.get(key)}; not drafted.`);
      continue;
    }
    drafted.push({ model: draftOne(ctx, t, planned, notes).model, table: t });
  }
  const all = [...existing, ...drafted.map((d) => d.model)];
  const models = drafted.map(({ model, table }) => {
    const ignored = unreferencedColumns(model, table, snapshot.dialect, incomingKeyColumns(model, all)).map((c) => c.name);
    return withIgnored(model, ignored);
  });
  return { models, notes };
}

export interface NewColumnsResult {
  // The columns newColumns finds for the model.
  columns: SnapshotColumn[];
  dimensions: Dimension[];
  measures: Measure[];
  // Joins drafted for new key columns whose target is in scope or modeled.
  joins: Join[];
  // The drafted joins whose target has no model yet: the join, the model name it expects and its table.
  unmodeled: { join: string; to: string; table: string }[];
  // New columns the rules give no dimension, measure or join; they are added to ignored_columns.
  skipped: { column: string; reason: string }[];
  open_questions: string[];
}

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// The columns of `table` that are new for `model`: no model over the same table reads them (in a
// field, a join key, its primary key or another model's join to it) or lists them in
// ignored_columns, in the table's column order. When several models are built on the table, its
// new columns belong to the one that reads the most of its columns (then the first by name), and
// the others have none.
export function newColumns(snapshot: Snapshot, table: SnapshotTable, model: Model, models: Model[]): SnapshotColumn[] {
  const { dialect } = snapshot;
  const key = tableKey(table);
  const onTable = (m: Model) => {
    if (!m || typeof m !== "object" || typeof m.table !== "string" || typeof m.model !== "string") return false;
    const t = findTable(snapshot.tables, m.table);
    return (t ? tableKey(t) : m.table.toLowerCase()) === key;
  };
  const siblings = models.filter((m) => m !== model && onTable(m) && m.model !== model.model);
  const read = (m: Model) => referencedColumns(m, table, dialect, incomingKeyColumns(m, models));
  const own = read(model).length;
  for (const s of siblings) {
    const n = read(s).length;
    if (n > own || (n === own && s.model < model.model)) return [];
  }
  const claimed = new Set(
    siblings.flatMap((s) => [...read(s), ...stringList(s.ignored_columns)]).map((c) => c.toLowerCase()),
  );
  return unreferencedColumns(model, table, dialect, incomingKeyColumns(model, models)).filter((c) => !claimed.has(c.name.toLowerCase()));
}

// Drafts dimensions, measures and joins for the new columns of `table` (newColumns) by the rules a
// new model is drafted with, under names the model does not use. A new key column whose target is
// in scope or modeled gets a draft join. New money measures take the currency of the model's
// measures when they all share one, and the currency question is asked only when none has a currency.
// The draft's other questions are kept when they are about a new column that a drafted item reads.
export function draftNewColumns(
  snapshot: Snapshot,
  table: SnapshotTable,
  model: Model,
  existing: Model[],
  opts: DraftOptions,
): NewColumnsResult {
  const { dialect } = snapshot;
  const incoming = incomingKeyColumns(model, existing);
  const fresh = newColumns(snapshot, table, model, existing);
  const result: NewColumnsResult = { columns: fresh, dimensions: [], measures: [], joins: [], unmodeled: [], skipped: [], open_questions: [] };
  if (!fresh.length) return result;
  const isFresh = new Set(fresh.map((c) => c.name));
  const used = new Set(referencedColumns(model, table, dialect, incoming));
  const reserved = [
    ...(Array.isArray(model.dimensions) ? model.dimensions : []),
    ...(Array.isArray(model.measures) ? model.measures : []),
    ...(Array.isArray(model.joins) ? model.joins : []),
  ]
    .map((f) => f?.name)
    .filter((n): n is string => typeof n === "string");
  const { ctx } = buildContext(snapshot, [], existing, opts, []);
  const primaryKey = Array.isArray(model.primary_key) ? model.primary_key.filter((c): c is string => typeof c === "string") : undefined;
  const drafted = draftOne(ctx, table, model.model, [], { reserved, primaryKey });
  const q = qualifiedName(table);
  const modelCurrencies = [
    ...new Set((Array.isArray(model.measures) ? model.measures : []).map((m) => m?.currency).filter((c): c is string => typeof c === "string" && c !== "")),
  ];
  const inherited = modelCurrencies.length === 1 ? modelCurrencies[0] : undefined;
  const covered = new Set<string>();
  const describe = new Map<string, string[]>();
  const tableColumns = (names: string[]) =>
    table.columns.filter((c) => names.some((n) => n.toLowerCase() === c.name.toLowerCase())).map((c) => c.name);
  const columnsOf = (sql: string[]) => {
    const ids = sql.flatMap((x) => sqlIdentifiers(x, dialect));
    return table.columns
      .filter((c) => ids.some((id) => (id.quoted ? id.v === c.name : id.v.toLowerCase() === c.name.toLowerCase())))
      .map((c) => c.name);
  };
  // True when the item reads at least one new column and otherwise only columns the model reads.
  const take = (cols: string[], label: string) => {
    if (!cols.length || !cols.some((c) => isFresh.has(c)) || !cols.every((c) => isFresh.has(c) || used.has(c))) return false;
    for (const c of cols.filter((c) => isFresh.has(c))) {
      covered.add(c);
      describe.set(c, [...(describe.get(c) ?? []), label]);
    }
    return true;
  };
  for (const d of drafted.model.dimensions) {
    if (take(columnsOf([d.expr]), `the dimension ${d.name}`)) result.dimensions.push(d);
  }
  for (const drawn of drafted.model.measures) {
    const m: Measure =
      inherited && drawn.format === "currency" && drawn.currency === undefined
        ? (Object.fromEntries(
            Object.entries(drawn).flatMap(([k, v]) => (k === "format" ? [[k, v], ["currency", inherited]] : [[k, v]])),
          ) as unknown as Measure)
        : drawn;
    const label = `the measure ${m.name}${
      m !== drawn
        ? ` in ${inherited}, the currency of the model's other measures`
        : drawn.format === "currency" && drawn.currency === undefined && modelCurrencies.length > 1
          ? ` with no currency, since the model's other measures are in ${listPhrase(modelCurrencies)}`
          : ""
    }`;
    if (take(columnsOf([m.expr, m.filter].filter((x): x is string => typeof x === "string")), label)) result.measures.push(m);
  }
  // Join -> the command that measures it, for the question about its key column.
  const checkJoin = new Map<string, string>();
  for (const j of drafted.model.joins ?? []) {
    const cols = tableColumns(j.keys.map((k) => k.from));
    const target = cols.map((c) => drafted.joinTargets.get(c)).find((t): t is string => !!t);
    const how = j.origin === "declared" ? "from the declared foreign key" : "inferred from the column name";
    const unmodeled = !existing.some((m) => m?.model === j.to) && target ? `; ${target} has no model yet, so draft it as ${j.to}` : "";
    if (!take(cols, `the join ${j.name} to ${j.to} (${how}${unmodeled})`)) continue;
    result.joins.push(j);
    if (unmodeled && target) result.unmodeled.push({ join: j.name, to: j.to, table: target });
    for (const c of cols) if (isFresh.has(c)) checkJoin.set(c, `sl check-join --source ${opts.source} --model ${model.model} --join ${j.name}`);
  }

  for (const c of fresh) {
    const head = `New column ${c.name} (${c.type}) appeared in ${q};`;
    const fields = describe.get(c.name);
    if (fields) {
      const sens = drafted.sensitivity.get(c.name);
      const target = drafted.joinTargets.get(c.name);
      const check = checkJoin.get(c.name);
      result.open_questions.push(
        `${head} the draft adds ${listPhrase(fields)}${sens ? `, tagged ${sens.tag} (${sens.reason})` : ""}. ` +
          `What does it hold, and should it stay?${
            check ? ` Run \`${check}\` before the join is approved.` : target ? ` It looks like a key to ${target}; should ${model.model} join to it?` : ""
          }`,
      );
      continue;
    }
    const reason = drafted.leftOut.get(c.name) ?? (drafted.joinTargets.has(c.name) ? `a key to ${drafted.joinTargets.get(c.name)}` : "the rules draft no field for it");
    result.skipped.push({ column: c.name, reason });
    const sens = sensitivityOf(c.name, c, table.row_count, { key: drafted.joinTargets.has(c.name) || (primaryKey ?? []).includes(c.name) });
    result.open_questions.push(
      `${head} the draft leaves it out (${reason}) and lists it in ignored_columns. Should it be a field?${
        sens ? ` If it is added, tag it ${sens.tag} (${sens.reason}).` : ""
      }`,
    );
  }
  // The draft's own questions about a new column that a drafted item reads (cents, per-unit figures,
  // other join targets), matched by the columns each question is about. The currency question names
  // only the new money columns.
  const existingQuestions = new Set(Array.isArray(model.open_questions) ? model.open_questions : []);
  const coveredLower = new Set([...covered].map((c) => c.toLowerCase()));
  for (const question of drafted.model.open_questions?.slice(1) ?? []) {
    if (existingQuestions.has(question) || /tagged (pii|sensitive)\./.test(question)) continue;
    if (/^primary_key \[|^Which column or columns identify/.test(question)) continue;
    if (question === drafted.currencyQuestion) {
      const newMoney = drafted.money.filter((c) => covered.has(c));
      const asked = newMoney.length && !modelCurrencies.length ? currencyQuestion(q, newMoney, drafted.currency) : undefined;
      if (asked && !existingQuestions.has(asked)) result.open_questions.push(asked);
      continue;
    }
    const about = drafted.questionColumns.get(question) ?? [];
    if (about.some((c) => coveredLower.has(c.toLowerCase()))) result.open_questions.push(question);
  }
  return result;
}

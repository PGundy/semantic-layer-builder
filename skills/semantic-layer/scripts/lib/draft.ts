// Drafts skeleton models from a snapshot by fixed rules: names, keys, joins,
// dimensions, measures, PII tags and the open questions the owner must answer.
// Every item is written as draft; nothing here guesses meaning beyond the rules.
import { classifyType, isNumeric } from "./column-types.ts";
import { quoteIdent } from "./dialect.ts";
import { findTable, qualifiedName, toSpecName } from "./naming.ts";
import { summarizeTable } from "./profile.ts";
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
const PII_NAME =
  /(^|_)(email|phone|mobile|ssn|social_security|address|street|postal|zip|first_name|last_name|full_name|birth|dob|ip_address|passport|tax_id)/;

const NEAR_UNIQUE_RATIO = 0.9;
const NEAR_UNIQUE_MIN_ROWS = 50;
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
  private taken = new Set<string>();
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

interface PendingJoin {
  target: SnapshotTable;
  keys: JoinKey[];
  origin: "declared" | "inferred";
  columns: string[];
  relationship: Relationship;
}

function draftOne(ctx: Context, table: SnapshotTable, modelName: string, notes: string[]): Model {
  const { dialect } = ctx.snapshot;
  const q = qualifiedName(table);
  const questions: string[] = [`What does one row of ${q} represent?`];
  const ns = new Namespace();

  const pk = inferPrimaryKey(table, ctx.opts.stripPrefixes, dialect);
  const pkCols = pk?.columns ?? [];
  const pkSet = new Set(pkCols.map((c) => c.toLowerCase()));
  if (!pk) {
    questions.push(`Which column or columns identify one row of ${q}? No primary key is declared and none could be inferred.`);
  } else if (pk.how === "unique") {
    questions.push(`primary_key [${pkCols.join(", ")}] is the table's only unique key, not a declared primary key. Is it the key of one row?`);
  } else if (pk.how === "naming") {
    questions.push(
      `primary_key [${pkCols.join(", ")}] was inferred from the column name and the profile (no nulls, one distinct value per row). Is it the key of one row?`,
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
      questions.push(`${fk.columns.join(", ")} references ${targetName}, which is not in the snapshot. Should it join to another table?`);
      continue;
    }
    if (!ctx.known.has(tableKey(target))) {
      questions.push(
        `${fk.columns.join(", ")} references ${qualifiedName(target)}, which is out of scope and has no model. Bring it into scope to draft this join?`,
      );
      continue;
    }
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
      questions.push(
        `${col.name} looks like a key to ${qualifiedName(best.table)}, which is out of scope and has no model. Bring it into scope to draft this join?`,
      );
      continue;
    }
    const others = found.filter((c) => c.known && c !== best).map((c) => qualifiedName(c.table));
    if (others.length) {
      questions.push(`${col.name} is joined to ${qualifiedName(best.table)} by its name; it could also mean ${listPhrase(others)}. Which is it?`);
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
  const columnMeasures: { col: SnapshotColumn; build: (name: string) => Measure; names: string[] }[] = [];
  const nearUnique: string[] = [];
  // Near-unique columns left out whose names look like personal data.
  const nearUniquePii: string[] = [];
  // Columns emitted with the pii tag.
  const pii: string[] = [];
  const cents: string[] = [];
  const money: string[] = [];
  const rows = table.row_count ?? null;

  // Optional fields in file order, present only when they hold something.
  const extras = (col: SnapshotColumn, tags?: string[]) => ({
    ...(col.description ? { description: col.description } : {}),
    ...(tags ? { tags } : {}),
  });

  for (const col of table.columns) {
    const lower = col.name.toLowerCase();
    const norm = toSpecName(col.name);
    const isPii = PII_NAME.test(norm);
    const tags = isPii ? ["pii"] : undefined;
    // Records the pii tag for a column that is emitted as a dimension or measure.
    const emitted = () => {
      if (isPii) pii.push(col.name);
    };
    const expr = columnExpr(dialect, col.name);
    const isKey = pkSet.has(lower) || joinColumns.has(lower) || fkColumns.has(lower) || /_id$/.test(norm) || norm === "id";
    if (isKey) {
      const single = !isSolePk([col.name]) && (joinColumns.has(lower) || fkColumns.has(lower) || /_id$/.test(norm));
      const composite = (table.foreign_keys ?? []).some((fk) => fk.columns.length > 1 && fk.columns.some((c) => c.toLowerCase() === lower));
      if (single && !composite) {
        emitted();
        const x = norm.replace(/_id$/, "");
        columnMeasures.push({
          col,
          names: [`${x}_count`, `distinct_${norm}_count`],
          build: (name) => ({ name, expr, agg: "count_distinct", format: "integer", ...extras(col, tags), status: "draft" }),
        });
      } else if (!pkSet.has(lower)) {
        notes.push(`${q}: left out ${col.name}, an id column that is not the primary key.`);
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
      const distinct = col.profile?.distinct_count;
      if (typeof distinct === "number" && typeof rows === "number" && rows >= NEAR_UNIQUE_MIN_ROWS && distinct / rows > NEAR_UNIQUE_RATIO) {
        nearUnique.push(col.name);
        if (isPii) nearUniquePii.push(col.name);
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
      if (SUM_NAME.test(norm) && !RATE_NAME.test(norm)) {
        const format: Format = COUNT_NAME.test(norm)
          ? "integer"
          : DURATION_NAME.test(norm)
            ? "number"
            : MONEY_NAME.test(norm)
              ? "currency"
              : "number";
        if (CENTS_NAME.test(norm)) cents.push(col.name);
        if (format === "currency") money.push(col.name);
        columnMeasures.push({
          col,
          names: [norm, `total_${norm}`],
          build: (name) => ({ name, expr, agg: "sum", format, ...extras(col), status: "draft" }),
        });
        continue;
      }
      if (typeof distinct === "number" && distinct <= NUMBER_DIMENSION_MAX_DISTINCT) {
        dimensions.push({ name: ns.claim(norm), expr, type: "number", ...extras(col), status: "draft" });
        continue;
      }
      columnMeasures.push({
        col,
        names: [`avg_${norm}`, `average_${norm}`],
        build: (name) => ({ name, expr, agg: "avg", format: "number", ...extras(col), status: "draft" }),
      });
      continue;
    }
    notes.push(`${q}: left out ${col.name} (type ${col.type}), which drafts as neither a dimension nor a measure.`);
  }

  const joins: Join[] = pending.map((p) => {
    const to = tableKey(p.target) === tableKey(table) ? modelName : ctx.names.get(tableKey(p.target))!;
    const fromName = p.columns.map((c) => toSpecName(c).replace(/_id$/, "")).join("_");
    const name = tableKey(p.target) === tableKey(table) ? ns.claim(fromName, `parent_${singular(to)}`) : ns.claim(singular(to), fromName);
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
    ...columnMeasures.map((m) => m.build(ns.claim(...m.names))),
  ];

  if (nearUnique.length) {
    questions.push(
      `${listPhrase(nearUnique)} ${nearUnique.length === 1 ? "has" : "have"} a different value on nearly every row and ${
        nearUnique.length === 1 ? "was" : "were"
      } left out as ${nearUnique.length === 1 ? "a dimension. Should it be one" : "dimensions. Should any be one"}?${
        nearUniquePii.length
          ? ` ${listPhrase(nearUniquePii)} ${nearUniquePii.length === 1 ? "looks" : "look"} like personal data; tag ${
              nearUniquePii.length === 1 ? "it" : "each"
            } pii if it is added.`
          : ""
      }`,
    );
  }
  for (const c of cents) {
    questions.push(`Is ${c} stored in cents? The draft sums it as stored; divide by 100 (expr: ${columnExpr(dialect, c)} / 100.0) to report whole currency units?`);
  }
  if (money.length) questions.push(`Which currency ${money.length === 1 ? "is" : "are"} ${listPhrase(money)} in?`);
  if (pii.length) {
    questions.push(`${listPhrase(pii)} look${pii.length === 1 ? "s" : ""} like personal data and ${pii.length === 1 ? "is" : "are"} tagged pii. Who may see ${pii.length === 1 ? "it" : "them"}?`);
  }

  return {
    model: modelName,
    source: ctx.opts.source,
    table: q,
    status: "draft",
    ...(table.description ? { description: table.description } : {}),
    ...(pkCols.length ? { primary_key: pkCols } : {}),
    open_questions: questions,
    dimensions,
    measures,
    ...(joins.length ? { joins } : {}),
  };
}

// Drafts one model per table. Names avoid existing models and each other; joins
// reach only known tables, and anything the rules cannot settle is an open question.
export function draftModels(snapshot: Snapshot, tables: SnapshotTable[], existing: Model[], opts: DraftOptions): DraftResult {
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
  const notes: string[] = [];
  const drafting = new Set(tables.map(tableKey).filter((k) => byKey.has(k)));
  const names = new Map([...existingNames, ...planNames([...byKey.values()], existing, opts.stripPrefixes, notes, drafting)]);
  const ctx: Context = { snapshot, opts, known, names, modeledKeys, modeled: new Set(existingNames.keys()), drafting };
  const models: Model[] = [];
  const seen = new Set<string>();
  for (const t of tables) {
    const key = tableKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    const planned = byKey.has(key) ? names.get(key)! : undefined;
    if (!planned) {
      notes.push(`${qualifiedName(t)} already has the model ${existingNames.get(key)}; not drafted.`);
      continue;
    }
    models.push(draftOne(ctx, t, planned, notes));
  }
  return { models, notes };
}

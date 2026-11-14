// Builds the baseline brief: a first reading of a snapshot for the data owner. Per table it guesses
// the role, the grain, the keys, the relationships, candidate measures and splits, the columns that
// should not be splits and the questions to ask, and for the source a star-schema sketch. It reads the
// snapshot alone; profiles and existing models sharpen it when present. Column classification (money,
// counts, time, currency, time zones, sensitivity, keys) comes from lib/draft.ts and lib/sensitivity.ts,
// so the brief and sl draft read a column the same way, and noise and staging from classifyTable in
// lib/rank.ts, as sl tables --groups reads a table. Every statement is a guess for the owner to confirm.
import { classifyType, isNumeric } from "./column-types.ts";
import {
  centsExpr,
  columnCurrency,
  columnExpr,
  draftModels,
  inferPrimaryKey,
  nameMatchKeyEligible,
  numericRule,
  singular,
  stripTablePrefix,
  timestampHasZone,
  twoDecimalType,
  type ColumnCurrency,
} from "./draft.ts";
import { UserError } from "./errors.ts";
import { findTable, qualifiedName, toSpecName } from "./naming.ts";
import { inScope, matchesPattern, validatePattern } from "./patterns.ts";
import { LOW_CARDINALITY_MAX, isHashedValue, summarizeTable } from "./profile.ts";
import { classifyTable, rankTables } from "./rank.ts";
import { nearUnique, sensitivityOf } from "./sensitivity.ts";
import { profileState, type ProfileState } from "./status.ts";
import type {
  Aggregation,
  Dialect,
  Format,
  Measure,
  Model,
  Relationship,
  Scalar,
  Scope,
  Snapshot,
  SnapshotColumn,
  SnapshotMethod,
  SnapshotTable,
  SourceConnection,
  Status,
  TableKind,
  TimeGrain,
} from "./types.ts";

export const TABLE_ROLES = ["fact", "event", "snapshot", "bridge", "dimension", "staging", "noise"] as const;
export type TableRole = (typeof TABLE_ROLES)[number];

// Questions for the owner, in the order the brief asks them.
export const QUESTION_TOPICS = ["grain", "status_values", "date", "units", "exclusions", "history", "sensitive"] as const;
export type QuestionTopic = (typeof QUESTION_TOPICS)[number];

export interface BaselineOptions {
  source: string;
  scope?: Scope;
  focusThreshold: number;
  // --tables: names or globs; when given, exactly these tables are reported, in or out of scope.
  tables?: string[];
  // The source's draft.strip_prefixes; when empty, suggested names drop fct_, fact_ and dim_.
  stripPrefixes?: string[];
  // Existing models of the source; their grain, keys and joins take precedence over guesses.
  models?: Model[];
  // The source's connection, when sources/<source>.yaml has one: an imported snapshot's note says
  // whether sl profile still needs one.
  connection?: SourceConnection;
}

export interface BaselineKey {
  columns: string[];
  // How the key was found: declared, unique, profile, name, ids (every column of an id-only table) or model.
  how: "declared" | "unique" | "profile" | "name" | "ids" | "model";
  basis: string;
  // True when the key is declared or comes from an approved model.
  confirmed: boolean;
}

export interface BaselineRelationship {
  // outgoing: this table's columns point at the other table; incoming: the other table points here.
  direction: "outgoing" | "incoming";
  columns: string[];
  table: string;
  table_columns: string[];
  // The join name a model of this table would use (outgoing joins only).
  join?: string;
  // Seen from this table: many_to_one for an order's customer, one_to_many for an order's lines.
  relationship: Relationship | "many_to_many";
  origin: "declared" | "inferred" | "model";
  basis: string;
  // Set when the join repeats rows of a likely fact or event table.
  fan_out?: string;
  // Set when the other table is outside the brief's reach (out of scope or not in the snapshot).
  note?: string;
}

export type MeasureKind = "row_count" | "sum" | "average" | "distinct_count" | "share" | "ratio";

export interface CandidateMeasure {
  name: string;
  kind: MeasureKind;
  agg?: Aggregation;
  expr?: string;
  columns: string[];
  format?: Format;
  currency?: string;
  // ratio only: the measure names divided.
  numerator?: string;
  denominator?: string;
  unit_note?: string;
  // Where the currency comes from: the column's comment or name, the table comment, or its currency column.
  currency_basis?: ColumnCurrency["basis"];
  // True when the column's type (numeric(12,2)) or comment says it is in whole currency units.
  whole_units?: boolean;
  description: string;
}

export type SplitKind = "time" | "category" | "flag" | "number";

export interface CandidateSplit {
  // The column, or a join path through to-one joins such as customer.acquisition_channel.
  field: string;
  column: string;
  // The table holding the column.
  table: string;
  // The join path, for a column of a joined table.
  via?: string;
  kind: SplitKind;
  time_grains?: TimeGrain[];
  basis: string;
  distinct_count?: number | null;
  values?: Scalar[];
}

export type NotSplitReason = "id" | "sensitive" | "near_unique" | "free_text" | "measure" | "high_cardinality" | "type";

export interface NotSplit {
  column: string;
  reason: NotSplitReason;
  detail: string;
}

export interface OwnerQuestion {
  topic: QuestionTopic;
  question: string;
  columns: string[];
}

export interface TableBaseline {
  table: string;
  kind: TableKind;
  rows: number | null;
  description: string | null;
  in_scope: boolean;
  model: { name: string; status: Status } | null;
  profile_state: ProfileState;
  role: TableRole;
  role_reasons: string[];
  grain: { guess: string; basis: string };
  primary_key: BaselineKey | null;
  relationships: BaselineRelationship[];
  // Tables that carry this table's key column by name beyond the INCOMING_READ_MAX the brief reads:
  // counted, not read, so their relationships are not listed. Null when every one was read.
  references_not_read: { count: number; columns: string[] } | null;
  measures: CandidateMeasure[];
  splits: CandidateSplit[];
  not_splits: NotSplit[];
  // Columns whose fitness as a split the snapshot cannot tell without a profile.
  unclear: { column: string; reason: string }[];
  questions: OwnerQuestion[];
  // What sl profile would measure on this table; empty once it is profiled.
  profile_would_measure: string[];
}

export interface StarFact {
  table: string;
  role: "fact" | "event";
  grain: string;
  dimensions: { table: string; via: string; columns: string[]; in_brief: boolean }[];
  // Facts this one is the many side of.
  parents: { table: string; columns: string[] }[];
}

export interface BaselineReport {
  source: string;
  dialect: Dialect;
  method: SnapshotMethod;
  captured_at: string;
  snapshot_tables: number;
  in_scope: number;
  focus_threshold: number;
  // all: every in-scope table; focus: the top focus_threshold of them; tables: the --tables names.
  selection: "all" | "focus" | "tables";
  // In-scope tables the brief does not cover, noise included.
  left_out: string[];
  // The left-out tables skipped because they look like noise (classifyTable).
  left_out_noise: string[];
  profiled: boolean;
  // True when sources/<source>.yaml names a connection (env, database or views).
  connection_configured: boolean;
  notes: string[];
  tables: TableBaseline[];
  star: {
    facts: StarFact[];
    dimensions: string[];
    // Dimensions in the brief that no fact in it joins to.
    unattached_dimensions: string[];
    other: { table: string; role: TableRole }[];
  };
  // The command that profiles the brief's unprofiled tables, or null when all are profiled.
  profile_command: string | null;
  next: string;
}

// Prefixes dropped from suggested names when the source sets no strip_prefixes.
const DEFAULT_NAME_PREFIXES = ["fct_", "fact_", "dim_"];
// Prefixes dropped when reading an entity out of a table name.
const ENTITY_PREFIXES = ["fct_", "fact_", "dim_", "stg_", "staging_", "raw_", "src_", "int_"];

const EVENT_TOKENS = ["event", "events", "log", "logs", "clicks", "pageviews", "sessions", "activity", "activities", "audit", "tracks", "impressions", "visits", "telemetry"];
const EVENT_COLUMN = /^(event|event_name|event_type|action|activity|verb)$/;
const BRIDGE_SUFFIX = /_(map|mapping|link|links|xref|bridge|closure|assignments?)$/;
const SNAPSHOT_SUFFIX = /_(history|snapshots?|scd|versions)$/;
const HISTORY_COLUMN = /^(valid_from|valid_to|valid_until|effective_from|effective_to|effective_start|effective_end|dbt_valid_from|dbt_valid_to|is_current|is_latest|current_flag|expired_at|superseded_at)$/;
const SNAPSHOT_DATE_COLUMN = /^(snapshot_date|snapshot_at|snapshot_day|as_of_date|as_of)$/;
const TEST_COLUMN = /(^|_)(test|tests|testing|test_account|sandbox|dummy|fake|internal)(_|$)/;
const DELETED_COLUMN = /^(is_)?(deleted|removed|archived)(_(at|on|date|flag|ts))?$/;
const STATUS_COLUMN = /(^|_)(status|state)(_|$)/;
// Names of columns that usually split well: a handful of values people group by.
const CATEGORY_NAME =
  /(^|_)(status|state|type|kind|category|categories|channel|region|country|segment|tier|plan|source|device|platform|method|currency|level|stage|language|locale|class|grade|band|brand|department|team)(s|es)?(_|$)/;
// Names of free-text or near-unique columns that rarely make a useful split.
const FREE_TEXT_NAME = /(^|_)(description|desc|details|summary|title|url|uri|link|path|user_agent|payload|html|json|subject|text)(_|$)/;
// Time columns that most often are "the" date of a row.
const PRIMARY_DATE = /^(order(ed)?|placed|created|occurred|event|transaction|txn|booked|purchased|sold|signup|signed_up|logged|issued|invoiced|paid)_?(at|on|date|ts|time|timestamp)?$/;
const PRIMARY_MONEY = /(^|_)(amount|total|revenue|gross|net|value|subtotal|sales|price|spend)(_|$)/;
const SECONDARY_MONEY = /(^|_)(discount|tax|shipping|freight|fee|refund|refunded|cost)(_|$)/;
const DURATION_UNIT = /(^|_)(minutes|seconds|hours|days|ms|millis|milliseconds)(_|$)/;
const DURATION_NAME = /(^|_)duration(_|$)/;
// A number named like a moment in time (an epoch timestamp such as created): probably not a measure.
const TIME_LIKE_NUMBER = /(^|_)(created|updated|modified|timestamp|epoch|unix)(_|$)|_(at|ts)$/;

const TO_ONE = new Set<string>(["many_to_one", "one_to_one"]);

function keyOf(t: { schema?: string | null; name: string }): string {
  return qualifiedName(t).toLowerCase();
}

function listPhrase(items: string[], conj = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${conj} ${items[items.length - 1]}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function words(norm: string): string {
  return norm.replace(/_/g, " ");
}

// An English plural for an entity noun, for "several order items per order".
function pluralNoun(noun: string): string {
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

// The table name without warehouse prefixes, singular: fct_order_items -> order_item.
function entityName(table: SnapshotTable, stripPrefixes: string[]): string {
  const stripped = stripTablePrefix(stripTablePrefix(table.name, stripPrefixes), ENTITY_PREFIXES);
  return singular(toSpecName(stripped));
}

function isIdName(name: string): boolean {
  const norm = toSpecName(name);
  return norm === "id" || /_id$/.test(norm);
}

function formatValue(v: Scalar): string {
  return typeof v === "string" ? `"${v}"` : String(v);
}

// The raw top values of a column's profile, or none when the profile is redacted or hashed.
function plainTopValues(col: SnapshotColumn): { value: Scalar; count: number }[] {
  const p = col.profile;
  if (!p?.top_values?.length || p.redacted === true) return [];
  if (p.top_values.some((t) => isHashedValue(t.value))) return [];
  return p.top_values;
}

// --tables -----------------------------------------------------------------------

// The snapshot tables a list of names or globs selects, in snapshot order. An unknown or
// ambiguous name is an error.
export function resolveTables(snapshot: Snapshot, refs: string[]): SnapshotTable[] {
  const picked = new Set<string>();
  const unknown: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith("re:") || /[*?]/.test(ref)) {
      const problem = validatePattern(ref);
      if (problem) throw new UserError(problem);
      const hits = snapshot.tables.filter((t) => matchesPattern(ref, t));
      if (!hits.length) unknown.push(ref);
      for (const t of hits) picked.add(keyOf(t));
      continue;
    }
    const t = findTable(snapshot.tables, ref);
    if (t) {
      picked.add(keyOf(t));
      continue;
    }
    const same = ref.includes(".") ? [] : snapshot.tables.filter((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (same.length > 1) {
      throw new UserError(`"${ref}" is in several schemas (${same.map(qualifiedName).sort().join(", ")}); pass the qualified name.`);
    }
    unknown.push(ref);
  }
  if (unknown.length) {
    throw new UserError(
      `No table matches ${unknown.map((n) => `"${n}"`).join(", ")} in the ${snapshot.source} snapshot. ` +
        `Run \`sl tables --source ${snapshot.source} --all\` for the names.`,
    );
  }
  return snapshot.tables.filter((t) => picked.has(keyOf(t)));
}

// Neighbourhood -----------------------------------------------------------------

// The most tables that reference one table by a key-column name which the brief reads; the
// rest are counted, not read.
export const INCOMING_READ_MAX = 10;

interface Neighbourhood {
  tables: SnapshotTable[];
  // Per table key: tables that carry its key column by name but were not read, beyond INCOMING_READ_MAX.
  unread: Map<string, { count: number; columns: string[] }>;
}

// The tables a set of tables may join to or be joined from, within `eligible`. Out: declared
// foreign keys, and for each <x>_id column the tables sl draft would join it to (keyed by <x>_id,
// or named for x), two hops. In: declared foreign keys and tables carrying the table's key column
// by name, one hop, at most INCOMING_READ_MAX of them by rank. Each step looks up an index, so
// the reach stays small on a snapshot of thousands of tables.
function neighbourhood(focus: SnapshotTable[], eligible: SnapshotTable[], stripPrefixes: string[], dialect: Dialect, rankIndex: Map<string, number>): Neighbourhood {
  const byColumn = new Map<string, SnapshotTable[]>();
  const byKeyColumn = new Map<string, SnapshotTable[]>();
  const byEntity = new Map<string, SnapshotTable[]>();
  const fkInbound = new Map<string, SnapshotTable[]>();
  const add = (m: Map<string, SnapshotTable[]>, k: string, t: SnapshotTable) => {
    const list = m.get(k);
    if (list) {
      if (!list.includes(t)) list.push(t);
    } else m.set(k, [t]);
  };
  for (const t of eligible) {
    for (const c of t.columns) add(byColumn, toSpecName(c.name), t);
    const pk = inferPrimaryKey(t, stripPrefixes, dialect)?.columns ?? [];
    if (pk.length === 1) add(byKeyColumn, toSpecName(pk[0]!), t);
    add(byEntity, entityName(t, stripPrefixes), t);
    add(byEntity, toSpecName(t.name), t);
    add(byEntity, toSpecName(stripTablePrefix(t.name, stripPrefixes)), t);
    for (const fk of t.foreign_keys ?? []) add(fkInbound, qualifiedName({ schema: fk.references.schema ?? t.schema, name: fk.references.table }).toLowerCase(), t);
  }
  const eligibleKeys = new Map(eligible.map((t) => [keyOf(t), t]));
  const outgoing = (t: SnapshotTable): SnapshotTable[] => {
    const out: SnapshotTable[] = [];
    for (const fk of t.foreign_keys ?? []) {
      const target = eligibleKeys.get(qualifiedName({ schema: fk.references.schema ?? t.schema, name: fk.references.table }).toLowerCase());
      if (target) out.push(target);
    }
    for (const c of t.columns) {
      const norm = toSpecName(c.name);
      // A column named like another table's single-column key (sku -> products keyed by sku), by the
      // rule sl draft joins by name: no generic or personal-data name, no noise table as the target.
      if (nameMatchKeyEligible(c.name)) out.push(...(byKeyColumn.get(norm) ?? []).filter((n) => intrinsicRole(n)?.role !== "noise"));
      const m = norm.match(/^(.+)_id$/);
      if (!m) continue;
      const x = m[1]!;
      const forms = new Set([x, singular(x), `${x}s`, `${x}es`, x.replace(/([^aeiou])y$/, "$1ies")]);
      out.push(...(byKeyColumn.get(`${x}_id`) ?? []));
      for (const f of forms) out.push(...(byEntity.get(f) ?? []));
    }
    return out.filter((n) => n !== t);
  };
  const rankOf = (t: SnapshotTable) => rankIndex.get(keyOf(t)) ?? Number.MAX_SAFE_INTEGER;
  const set = new Map(focus.map((t) => [keyOf(t), t]));
  const unread = new Map<string, { count: number; columns: string[] }>();
  const incoming = (t: SnapshotTable): SnapshotTable[] => {
    const forms = new Set([entityName(t, stripPrefixes), singular(toSpecName(t.name))]);
    for (const pk of t.primary_key ?? []) forms.add(toSpecName(pk).replace(/_id$/, ""));
    const keyNames = [...forms].map((f) => `${f}_id`);
    // A single-column key that is not id-named (sku) is carried under its own name.
    const pk = t.primary_key?.length === 1 ? toSpecName(t.primary_key[0]!) : undefined;
    if (pk && nameMatchKeyEligible(pk)) keyNames.push(pk);
    const columns = [...new Set(keyNames)].filter((c) => byColumn.has(c));
    const candidates = new Set<SnapshotTable>(fkInbound.get(keyOf(t)) ?? []);
    for (const c of columns) for (const n of byColumn.get(c)!) candidates.add(n);
    candidates.delete(t);
    // Copies, backups and raw loads that reuse a key are not references.
    const ordered = [...candidates].filter((n) => !intrinsicRole(n)).sort((a, b) => rankOf(a) - rankOf(b));
    const out: SnapshotTable[] = [];
    let skipped = 0;
    for (const n of ordered) {
      if (set.has(keyOf(n))) continue;
      if (out.length < INCOMING_READ_MAX) out.push(n);
      else skipped++;
    }
    if (skipped) unread.set(keyOf(t), { count: skipped, columns });
    return out;
  };
  const grow = (tables: SnapshotTable[], step: (t: SnapshotTable) => SnapshotTable[]) => {
    const added: SnapshotTable[] = [];
    for (const t of tables) {
      for (const n of step(t)) {
        if (!set.has(keyOf(n))) {
          set.set(keyOf(n), n);
          added.push(n);
        }
      }
    }
    return added;
  };
  // Two hops out (an order's customer's region), one hop in (an order's lines).
  const firstOut = grow(focus, outgoing);
  grow(firstOut, outgoing);
  grow(focus, incoming);
  return { tables: eligible.filter((t) => set.has(keyOf(t))), unread };
}

// Per-table reading -----------------------------------------------------------------

interface Reading {
  table: SnapshotTable;
  q: string;
  draft: Model;
  existing?: Model;
  entity: string;
  // The entity named by the table alone: audit_log for audit_log keyed by audit_id.
  tableEntity: string;
  keyColumns: Set<string>;
  timeColumns: string[];
  pk: BaselineKey | null;
  outgoing: BaselineRelationship[];
  incoming: BaselineRelationship[];
  measures: CandidateMeasure[];
  own: CandidateSplit[];
  // Columns of measures that add up (sums), for the not-split list.
  measureColumns: Map<string, string>;
  role: TableRole;
  roleReasons: string[];
}

// Which columns of a table a drafted measure reads, and whether it divides one by 100.
function measureColumns(dialect: Dialect, table: SnapshotTable, m: Measure): { columns: string[]; divided: boolean } {
  if (!m.expr) return { columns: [], divided: false };
  for (const c of table.columns) {
    const e = columnExpr(dialect, c.name);
    if (m.expr === e) return { columns: [c.name], divided: false };
    if (m.expr === centsExpr(dialect, e)) return { columns: [c.name], divided: true };
  }
  const columns: string[] = [];
  let divided = false;
  for (const c of table.columns) {
    const e = columnExpr(dialect, c.name);
    const escaped = e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^A-Za-z0-9_"])${escaped}($|[^A-Za-z0-9_"])`).test(m.expr)) columns.push(c.name);
    if (m.expr.includes(centsExpr(dialect, e))) divided = true;
  }
  return { columns, divided };
}

function primaryKeyOf(table: SnapshotTable, draft: Model, existing: Model | undefined, stripPrefixes: string[], dialect: Dialect): BaselineKey | null {
  if (existing?.primary_key?.length) {
    return {
      columns: [...existing.primary_key],
      how: "model",
      basis: `the ${existing.status === "approved" ? "approved" : "draft"} model ${existing.model}`,
      confirmed: existing.status === "approved",
    };
  }
  const inferred = inferPrimaryKey(table, stripPrefixes, dialect);
  const drafted = draft.primary_key ?? [];
  if (inferred && drafted.length === inferred.columns.length) {
    const basis =
      inferred.how === "declared"
        ? "the declared primary key"
        : inferred.how === "unique"
          ? "the table's only unique key"
          : "its name and its profile: no nulls, one distinct value per row";
    const how = inferred.how === "naming" ? "profile" : inferred.how;
    return { columns: inferred.columns, how, basis, confirmed: inferred.how === "declared" };
  }
  if (drafted.length) return { columns: [...drafted], how: "ids", basis: "every column of a table that holds only ids", confirmed: false };
  // No declared key and no profile to confirm one: a column named for the table, or id.
  // The entity's leading and trailing words count too: audit_log is keyed by audit_id, web_events by event_id.
  const entity = entityName(table, stripPrefixes).split("_");
  const forms = [
    ...entity.map((_, i) => `${entity.slice(0, entity.length - i).join("_")}_id`),
    ...entity.map((_, i) => `${entity.slice(i).join("_")}_id`),
    `${toSpecName(table.name)}_id`,
    "id",
  ];
  const candidates = new Set(summarizeTable(table, dialect).candidate_keys);
  for (const f of forms) {
    const col = table.columns.find((c) => toSpecName(c.name) === f);
    if (col && candidates.has(col.name)) return { columns: [col.name], how: "profile", basis: "its name and its profile: no nulls, one distinct value per row", confirmed: false };
    if (col && !col.profile) return { columns: [col.name], how: "name", basis: "the column name only; a profile would check it is unique", confirmed: false };
  }
  return null;
}

// A column that marks deleted, archived or superseded rows: a filter rather than a split or a date.
function isFilterColumn(name: string): boolean {
  const norm = toSpecName(name);
  return HISTORY_COLUMN.test(norm) || DELETED_COLUMN.test(norm);
}

// The key as a phrase: "the declared primary key order_id".
function keyPhrase(pk: BaselineKey): string {
  const cols = pk.columns.join(", ");
  switch (pk.how) {
    case "declared":
      return `the declared primary key ${cols}`;
    case "unique":
      return `the unique key ${cols}`;
    case "profile":
      return `the key ${cols} (by its name; the profile shows no nulls and one value per row)`;
    case "name":
      return `the column name ${cols} (a guess until a profile checks it is unique)`;
    case "ids":
      return `the key ${cols} (every column)`;
    case "model":
      return `the key ${cols} of ${pk.basis}`;
  }
}

// What a money measure's columns say about its unit and currency: whole units by a two-decimal
// type (numeric(12,2)) or a comment, and where its currency comes from (columnCurrency in lib/draft.ts).
function moneyFacts(
  table: SnapshotTable,
  columns: string[],
  m: Measure,
  divided: boolean,
): Pick<CandidateMeasure, "currency_basis" | "whole_units" | "unit_note"> & { currency_note?: string } {
  const cols = columns.map((c) => table.columns.find((x) => x.name === c)).filter((c): c is SnapshotColumn => !!c);
  // A line total reads a quantity and a per-unit price: the price's currency is the total's.
  const priced = cols.find((c) => numericRule(toSpecName(c.name))?.perUnit) ?? cols[0];
  const cur = priced && m.currency ? columnCurrency(table, priced) : undefined;
  const currencyNote = cur
    ? cur.basis === "currency_column"
      ? `the currency column holds only ${cur.currency}`
      : `in ${cur.currency}, by its ${cur.basis === "name" ? "name" : cur.basis === "column_comment" ? "comment" : "table's comment"}`
    : undefined;
  const typed = !divided && !!priced && twoDecimalType(priced.type);
  const stated = !divided && !!priced?.description && /\b(whole (currency )?units|major units|dollars|euros|pounds|yen)\b/i.test(priced.description);
  const whole = typed || stated;
  const by = cols.length > 1 && priced ? `${priced.name}'s` : "its";
  const unitText = whole
    ? `money, probably in whole currency units by ${by} ${typed ? `type, ${priced!.type}` : "comment"}`
    : "money; the snapshot does not say the unit (whole units or cents)";
  const unit_note = `${unitText}${currencyNote ? `; ${currencyNote}` : whole ? "; the currency is not stated" : " or the currency"}`;
  return {
    ...(cur ? { currency_basis: cur.basis } : {}),
    ...(whole ? { whole_units: true } : {}),
    unit_note,
    ...(currencyNote ? { currency_note: currencyNote } : {}),
  };
}

function measuresOf(r: Omit<Reading, "measures" | "measureColumns" | "own" | "role" | "roleReasons">, dialect: Dialect): {
  measures: CandidateMeasure[];
  measureColumns: Map<string, string>;
} {
  const out: CandidateMeasure[] = [];
  const measureCols = new Map<string, string>();
  const nouns = pluralNoun(words(r.entity));
  const description = (r.table.description ?? "").toLowerCase();
  let rowCount: CandidateMeasure | undefined;
  const moneySums: CandidateMeasure[] = [];
  for (const m of r.draft.measures) {
    const { columns, divided } = measureColumns(dialect, r.table, m);
    const base = { name: m.name, agg: m.agg, ...(m.expr ? { expr: m.expr } : {}), columns, ...(m.format ? { format: m.format } : {}) };
    if (m.agg === "count") {
      rowCount = { ...base, kind: "row_count", description: `the number of rows: how many ${nouns}, probably` };
      out.push(rowCount);
      continue;
    }
    if (m.agg === "count_distinct") {
      const col = columns[0] ?? m.name;
      // A distinct count of the table's own key repeats the row count.
      if (r.pk?.columns.length === 1 && columns.length === 1 && r.pk.columns[0]!.toLowerCase() === col.toLowerCase()) continue;
      out.push({ ...base, kind: "distinct_count", description: `distinct ${col}: how many different ${pluralNoun(words(toSpecName(col).replace(/_id$/, "")))}` });
      continue;
    }
    if (m.agg === "avg") {
      const col = columns[0];
      const perUnit = col ? numericRule(toSpecName(col))?.perUnit === true : false;
      for (const c of columns) measureCols.set(c, "a number to average, not a split");
      const facts = m.format === "currency" ? moneyFacts(r.table, columns, m, divided) : undefined;
      // An average's unit is noted when it is stored in cents, or when its type, comment or name settles the unit or currency.
      const known = !!facts && (facts.whole_units === true || facts.currency_basis !== undefined);
      out.push({
        ...base,
        kind: "average",
        ...(m.currency ? { currency: m.currency } : {}),
        ...(facts?.currency_basis ? { currency_basis: facts.currency_basis } : {}),
        ...(facts?.whole_units ? { whole_units: true } : {}),
        ...(divided
          ? { unit_note: `probably stored in cents; divided by 100 to report whole currency units${facts?.currency_note ? `; ${facts.currency_note}` : ""}` }
          : known && facts?.unit_note
            ? { unit_note: facts.unit_note }
            : {}),
        description: perUnit
          ? `the average of ${col}, a per-unit figure: averaged rather than summed`
          : col && TIME_LIKE_NUMBER.test(toSpecName(col))
            ? `the average of ${col}; its name suggests a timestamp stored as a number, which is probably not a measure at all: confirm`
            : `the average of ${col ?? m.name}; its name does not say whether it adds up, so this is a guess`,
      });
      continue;
    }
    // Sums: money, counts of units, durations and other additive numbers.
    for (const c of columns) if (!measureCols.has(c)) measureCols.set(c, "a number to add up, not a split");
    let unit: string | undefined;
    let money: Pick<CandidateMeasure, "currency_basis" | "whole_units"> = {};
    if (m.format === "currency") {
      const fromName = columns.some((c) => /(cents|pennies)/.test(toSpecName(c)));
      const facts = moneyFacts(r.table, columns, m, divided);
      money = { ...(facts.currency_basis ? { currency_basis: facts.currency_basis } : {}), ...(facts.whole_units ? { whole_units: true } : {}) };
      unit = divided
        ? `probably stored in cents, by its ${fromName ? "name" : /cents|pennies/.test(description) ? "table's comment" : "comment"}; divided by 100 to report whole currency units`
        : (facts.unit_note ?? "money; the snapshot does not say the unit (whole units or cents) or the currency");
      if (divided && facts.currency_note) unit += `; ${facts.currency_note}`;
    } else if (m.format === "integer") {
      unit = "a count of units or things";
    } else {
      const name = toSpecName(columns[0] ?? m.name);
      const u = name.match(DURATION_UNIT)?.[2];
      if (u) unit = `in ${u}, by its name`;
      else if (DURATION_NAME.test(name)) unit = "a duration; the unit is not stated";
    }
    const what = columns.length > 1 ? listPhrase(columns, "times") : (columns[0] ?? m.name);
    const measure: CandidateMeasure = {
      ...base,
      kind: "sum",
      ...(m.currency ? { currency: m.currency } : {}),
      ...money,
      ...(unit ? { unit_note: unit } : {}),
      description: columns.length > 1 ? `the total of ${what}, a line total` : `the total of ${what}`,
    };
    out.push(measure);
    if (m.format === "currency") moneySums.push(measure);
  }
  // Shares of boolean flags, except flags that mark test or deleted rows: those are filters.
  for (const d of r.draft.dimensions) {
    if (d.type !== "boolean") continue;
    const col = r.table.columns.find((c) => columnExpr(dialect, c.name) === d.expr);
    if (!col) continue;
    const norm = toSpecName(col.name);
    if (TEST_COLUMN.test(norm) || DELETED_COLUMN.test(norm) || HISTORY_COLUMN.test(norm)) continue;
    if (sensitivityOf(col.name, col, r.table.row_count, { key: false })) continue;
    const flag = norm.replace(/^(is|has|was)_/, "");
    out.push({
      name: toSpecName(`${flag}_share`),
      kind: "share",
      agg: "avg",
      expr: `case when ${columnExpr(dialect, col.name)} then 1 else 0 end`,
      columns: [col.name],
      format: "percent",
      description: `the share of ${nouns} where ${col.name} is true`,
    });
  }
  // A ratio when a money sum and the row count sit on one table: an average order value.
  if (rowCount && moneySums.length) {
    const money =
      moneySums.find((m) => PRIMARY_MONEY.test(m.name) && !SECONDARY_MONEY.test(m.name)) ??
      moneySums.find((m) => !SECONDARY_MONEY.test(m.name)) ??
      moneySums[0]!;
    const entity = words(r.entity);
    out.push({
      name: toSpecName(`avg_${money.name}_per_${r.entity}`),
      kind: "ratio",
      columns: [...money.columns],
      format: "currency",
      ...(money.currency ? { currency: money.currency } : {}),
      numerator: money.name,
      denominator: rowCount.name,
      description: `${money.name} divided by ${rowCount.name}: the average ${words(money.name)} per ${entity}${
        /(^| )order$/.test(entity) ? ", the average order value" : ""
      }`,
    });
  }
  return { measures: out, measureColumns: measureCols };
}

function ownSplits(r: Pick<Reading, "table" | "q" | "draft" | "keyColumns">, dialect: Dialect): CandidateSplit[] {
  const out: CandidateSplit[] = [];
  const { table } = r;
  for (const d of r.draft.dimensions) {
    const col = table.columns.find((c) => columnExpr(dialect, c.name) === d.expr);
    // A key column splits only by time: the date inside a composite key (store_id, month).
    if (!col || (r.keyColumns.has(col.name) && d.type !== "time")) continue;
    const norm = toSpecName(col.name);
    if (sensitivityOf(col.name, col, table.row_count, { key: false })) continue;
    const distinct = col.profile?.distinct_count;
    const values = plainTopValues(col)
      .slice(0, 6)
      .map((t) => t.value);
    const common = { field: col.name, column: col.name, table: r.q };
    if (isFilterColumn(col.name)) continue;
    if (d.type === "time") {
      out.push({ ...common, kind: "time", time_grains: d.time_grains ?? [], basis: `its type, ${col.type}` });
      continue;
    }
    if (d.type === "boolean") {
      if (TEST_COLUMN.test(norm)) continue;
      out.push({ ...common, kind: "flag", basis: "a true/false flag", ...(typeof distinct === "number" ? { distinct_count: distinct } : {}) });
      continue;
    }
    // A label unique on every row of a small table still splits well: region_name on six regions.
    if (typeof distinct === "number") {
      if (distinct < 1 || distinct > LOW_CARDINALITY_MAX) continue;
      out.push({
        ...common,
        kind: d.type === "number" ? "number" : "category",
        basis: `${plural(distinct, "distinct value")} in the profile`,
        distinct_count: distinct,
        ...(values.length ? { values } : {}),
      });
      continue;
    }
    if (d.type === "string" && CATEGORY_NAME.test(norm) && !FREE_TEXT_NAME.test(norm)) {
      out.push({ ...common, kind: "category", basis: "by its name; a profile would count its values" });
    }
  }
  return out;
}

// noise or staging by the table's own name, schema and comment (classifyTable, the judgement
// sl tables --groups suggests a scope by), or null.
function intrinsicRole(table: SnapshotTable): { role: "noise" | "staging"; reasons: string[] } | null {
  return classifyTable(table);
}

// The reason a table counts as referenced: the tables read here, and those that carry its key
// column by name but were not read.
function referencedBy(inbound: number, unread: { count: number; columns: string[] } | undefined): string {
  const read = `referenced by ${plural(inbound, "table")}`;
  if (!unread) return read;
  const more = `${unread.count} more ${unread.count === 1 ? "table carries" : "tables carry"} ${listPhrase(unread.columns, "or")} and ${unread.count === 1 ? "was" : "were"} not read`;
  return inbound ? `${read}; ${more}` : `${unread.count} ${unread.count === 1 ? "table carries" : "tables carry"} ${listPhrase(unread.columns, "or")}, not read here`;
}

function roleOf(r: Reading, inbound: number, unread?: { count: number; columns: string[] }): { role: TableRole; reasons: string[] } {
  const { table } = r;
  const lower = table.name.toLowerCase();
  const tokens = lower.split(/[_\-.]+/);
  const norms = table.columns.map((c) => toSpecName(c.name));
  const intrinsic = intrinsicRole(table);
  if (intrinsic) return intrinsic;

  const toOne = r.outgoing.filter((x) => TO_ONE.has(x.relationship) && x.table.toLowerCase() !== r.q.toLowerCase());
  const sums = r.measures.filter((m) => m.kind === "sum");
  const idOnly = table.columns.length >= 2 && table.columns.length <= 3 && norms.every((n) => /_id$/.test(n));
  if (idOnly) return { role: "bridge", reasons: [`only ${plural(table.columns.length, "id column")}: a link between tables`] };
  if (BRIDGE_SUFFIX.test(lower) && toOne.length >= 2 && !sums.length) {
    return { role: "bridge", reasons: ["link-table naming", `joins to ${plural(toOne.length, "table")} and has nothing to add up`] };
  }
  if (BRIDGE_SUFFIX.test(lower) && norms.filter((n) => /_id$/.test(n)).length >= 2 && !sums.length) {
    return { role: "bridge", reasons: ["link-table naming", "two or more id columns and nothing to add up"] };
  }

  const history = table.columns.filter((c) => HISTORY_COLUMN.test(toSpecName(c.name))).map((c) => c.name);
  const snapDate = table.columns.find((c) => SNAPSHOT_DATE_COLUMN.test(toSpecName(c.name)));
  if (history.length || snapDate || SNAPSHOT_SUFFIX.test(lower)) {
    const reasons: string[] = [];
    if (history.length) reasons.push(`history columns ${listPhrase(history)}`);
    if (snapDate) reasons.push(`a snapshot date column, ${snapDate.name}`);
    if (SNAPSHOT_SUFFIX.test(lower)) reasons.push("history or snapshot naming");
    return { role: "snapshot", reasons };
  }

  const eventToken = tokens.find((t) => EVENT_TOKENS.includes(t));
  const eventCol = table.columns.find((c) => EVENT_COLUMN.test(toSpecName(c.name)));
  if (eventToken || (eventCol && r.timeColumns.length && !sums.some((m) => m.format === "currency"))) {
    const reasons: string[] = [];
    if (eventToken) reasons.push(`name contains "${eventToken}"`);
    if (eventCol) reasons.push(`an ${eventCol.name} column`);
    if (r.timeColumns.length) reasons.push(`a timestamp, ${r.timeColumns[0]}`);
    return { role: "event", reasons };
  }

  const money = sums.filter((m) => m.format === "currency");
  const shape: string[] = [];
  if (money.length) shape.push(`money to add up (${listPhrase(money.map((m) => m.name))})`);
  else if (sums.length) shape.push(`numbers to add up (${listPhrase(sums.map((m) => m.name))})`);
  if (toOne.length) shape.push(`points at ${plural(toOne.length, "other table")}`);
  if (r.timeColumns.length) shape.push(`a date or time column (${r.timeColumns[0]})`);
  if (/^(fct|fact)_/.test(lower)) return { role: "fact", reasons: ["fact table naming", ...shape] };
  if (/^dim_/.test(lower)) {
    return { role: "dimension", reasons: ["dimension table naming", ...(inbound || unread ? [referencedBy(inbound, unread)] : [])] };
  }
  if (sums.length && (toOne.length || r.timeColumns.length)) return { role: "fact", reasons: shape };
  if (inbound || unread) return { role: "dimension", reasons: [referencedBy(inbound, unread), ...(sums.length ? [] : ["nothing to add up"])] };
  return { role: "dimension", reasons: ["nothing to add up and no event or history columns: it probably describes things"] };
}

// The report -----------------------------------------------------------------------

export function buildBaseline(snapshot: Snapshot, opts: BaselineOptions): BaselineReport {
  const { dialect } = snapshot;
  const notes: string[] = [];
  const sourcePrefixes = (opts.stripPrefixes ?? []).filter(Boolean);
  const usedDefaults = !sourcePrefixes.length;
  const stripPrefixes = usedDefaults ? DEFAULT_NAME_PREFIXES : sourcePrefixes;
  const models = (opts.models ?? []).filter((m): m is Model => !!m && typeof m === "object" && typeof m.table === "string" && typeof m.model === "string");
  const modelByTable = new Map<string, Model>();
  for (const m of models) {
    const t = findTable(snapshot.tables, m.table);
    const k = t ? keyOf(t) : m.table.toLowerCase();
    if (!modelByTable.has(k)) modelByTable.set(k, m);
  }

  const scoped = snapshot.tables.filter((t) => inScope(opts.scope, t));
  const ranked = rankTables(snapshot.tables);
  let selected: SnapshotTable[];
  let selection: BaselineReport["selection"];
  let leftOut: string[] = [];
  let leftOutNoise: string[] = [];
  if (opts.tables?.length) {
    const picked = new Set(resolveTables(snapshot, opts.tables).map(keyOf));
    selected = ranked.map((r) => r.table).filter((t) => picked.has(keyOf(t)));
    selection = "tables";
    const out = selected.filter((t) => !inScope(opts.scope, t)).map(qualifiedName);
    if (out.length) notes.push(`${listPhrase(out)} ${out.length === 1 ? "is" : "are"} out of scope; included because --tables names ${out.length === 1 ? "it" : "them"}.`);
  } else {
    const inScopeRanked = ranked.map((r) => r.table).filter((t) => inScope(opts.scope, t));
    if (inScopeRanked.length > opts.focusThreshold) {
      // The top tables by rank, skipping those that look like noise, with raw and staging tables
      // only where room is left: the judgement sl tables --groups suggests a scope by.
      const role = (t: SnapshotTable) => intrinsicRole(t)?.role;
      const noise = inScopeRanked.filter((t) => role(t) === "noise");
      const candidates = [...inScopeRanked.filter((t) => !role(t)), ...inScopeRanked.filter((t) => role(t) === "staging")];
      const picked = new Set(candidates.slice(0, opts.focusThreshold));
      selected = inScopeRanked.filter((t) => picked.has(t));
      leftOut = inScopeRanked.filter((t) => !picked.has(t)).map(qualifiedName);
      leftOutNoise = noise.map(qualifiedName);
      selection = "focus";
      const others = leftOut.length - leftOutNoise.length;
      const skipped = [
        ...(leftOutNoise.length ? [`${plural(leftOutNoise.length, "table")} that look${leftOutNoise.length === 1 ? "s" : ""} like noise`] : []),
        ...(others ? [`${others} more by rank`] : []),
      ];
      notes.push(
        `${inScopeRanked.length} tables are in scope, more than the focus threshold of ${opts.focusThreshold}: this brief covers ${selected.length} of the ${inScopeRanked.length} in-scope tables, ` +
          `the top by size, references and naming, and leaves out ${plural(leftOut.length, "table")} (${listPhrase(skipped)}). ` +
          `Narrow the scope with \`sl scope --source ${opts.source} --include <pattern> --write\` (\`sl tables --source ${opts.source} --groups\` suggests patterns), ` +
          `or name tables with --tables.`,
      );
    } else {
      selected = inScopeRanked;
      selection = "all";
    }
  }
  const present = usedDefaults ? DEFAULT_NAME_PREFIXES.filter((p) => selected.some((t) => t.name.toLowerCase().startsWith(p))) : [];
  if (present.length) {
    notes.push(`Suggested names drop the prefix${present.length === 1 ? "" : "es"} ${present.join(", ")}, as \`sl draft --strip-prefix ${present.join(",")}\` would.`);
  }

  // Tables a join may reach: in scope, modeled, or named by --tables.
  const eligible = snapshot.tables.filter((t) => inScope(opts.scope, t) || modelByTable.has(keyOf(t)) || selected.includes(t));
  const rankIndex = new Map(ranked.map((x, i) => [keyOf(x.table), i]));
  const { tables: reach, unread } = neighbourhood(selected, eligible, stripPrefixes, dialect, rankIndex);
  const { models: drafts } = draftModels(snapshot, reach, [], { source: opts.source, stripPrefixes, knownTables: reach });
  const draftByTable = new Map<string, Model>();
  const tableByDraftName = new Map<string, SnapshotTable>();
  for (const d of drafts) {
    const t = findTable(snapshot.tables, d.table);
    if (!t) continue;
    draftByTable.set(keyOf(t), d);
    tableByDraftName.set(d.model, t);
  }
  const tableByModelName = new Map<string, SnapshotTable>();
  for (const m of models) {
    const t = findTable(snapshot.tables, m.table);
    if (t) tableByModelName.set(m.model, t);
  }

  // First pass: keys, relationships out, measures and own splits for every table in reach.
  const readings = new Map<string, Reading>();
  for (const table of reach) {
    const k = keyOf(table);
    const draft = draftByTable.get(k);
    if (!draft) continue;
    const existing = modelByTable.get(k);
    const q = qualifiedName(table);
    const pk = primaryKeyOf(table, draft, existing, stripPrefixes, dialect);
    const keyColumns = new Set<string>();
    for (const c of pk?.columns ?? []) keyColumns.add(c);
    for (const fk of table.foreign_keys ?? []) for (const c of fk.columns) keyColumns.add(c);
    // A column joined by its name alone (sku, status) keeps its dimension and split; id-named and
    // declared join columns are keys.
    for (const j of draft.joins ?? []) for (const key of j.keys) if (j.origin === "declared" || isIdName(key.from)) keyColumns.add(key.from);
    for (const c of table.columns) if (isIdName(c.name)) keyColumns.add(c.name);
    // Time columns that date a row; deletion and history columns are filters, not dates.
    const timeColumns = draft.dimensions
      .filter((d) => d.type === "time")
      .map((d) => table.columns.find((c) => columnExpr(dialect, c.name) === d.expr)?.name)
      .filter((c): c is string => !!c && !isFilterColumn(c));

    const outgoing: BaselineRelationship[] = [];
    const covered = new Set<string>();
    const colsKey = (cols: string[]) => cols.map((c) => c.toLowerCase()).join(",");
    for (const j of existing?.joins ?? []) {
      const target = tableByModelName.get(j.to) ?? (j.to === existing?.model ? table : undefined);
      if (!target || !Array.isArray(j.keys)) continue;
      const ev = j.evidence;
      outgoing.push({
        direction: "outgoing",
        columns: j.keys.map((x) => x.from),
        table: qualifiedName(target),
        table_columns: j.keys.map((x) => x.to),
        join: j.name,
        relationship: j.relationship,
        origin: "model",
        basis: `the ${j.status === "approved" ? "approved" : "draft"} join ${existing!.model}.${j.name}${
          ev ? `; sl check-join measured a ${Math.round(ev.match_rate * 1000) / 10}% match and a largest fan-out of ${ev.max_fanout}` : ""
        }`,
      });
      covered.add(colsKey(j.keys.map((x) => x.from)));
    }
    for (const j of draft.joins ?? []) {
      const cols = j.keys.map((x) => x.from);
      if (covered.has(colsKey(cols))) continue;
      const target = tableByDraftName.get(j.to);
      if (!target) continue;
      covered.add(colsKey(cols));
      outgoing.push({
        direction: "outgoing",
        columns: cols,
        table: qualifiedName(target),
        table_columns: j.keys.map((x) => x.to),
        join: j.name,
        relationship: j.relationship,
        origin: j.origin === "declared" ? "declared" : "inferred",
        basis: j.origin === "declared" ? "a declared foreign key" : `the column name ${listPhrase(cols)} and the key of ${qualifiedName(target)}`,
      });
    }
    for (const fk of table.foreign_keys ?? []) {
      if (covered.has(colsKey(fk.columns))) continue;
      covered.add(colsKey(fk.columns));
      const name = qualifiedName({ schema: fk.references.schema ?? table.schema, name: fk.references.table });
      const target = findTable(snapshot.tables, name);
      outgoing.push({
        direction: "outgoing",
        columns: [...fk.columns],
        table: target ? qualifiedName(target) : name,
        table_columns: [...fk.references.columns],
        relationship: "many_to_one",
        origin: "declared",
        basis: "a declared foreign key",
        note: target ? "the target is out of scope, so its columns are not read here" : "the target is not in the snapshot",
      });
    }

    const partial = { table, q, draft, ...(existing ? { existing } : {}), entity: pk?.columns.length === 1 && /_id$/.test(toSpecName(pk.columns[0]!)) ? toSpecName(pk.columns[0]!).replace(/_id$/, "") : entityName(table, stripPrefixes), tableEntity: entityName(table, stripPrefixes), keyColumns, timeColumns, pk, outgoing, incoming: [] as BaselineRelationship[] };
    const { measures, measureColumns: mcols } = measuresOf(partial, dialect);
    const reading: Reading = { ...partial, measures, measureColumns: mcols, own: ownSplits(partial, dialect), role: "dimension", roleReasons: [] };
    readings.set(k, reading);
  }

  // Incoming relationships, from every reading's to-one joins.
  // Copies, backups and raw loads that reuse a key are left out: they are not real references.
  for (const r of readings.values()) {
    if (intrinsicRole(r.table)) continue;
    for (const rel of r.outgoing) {
      if (!TO_ONE.has(rel.relationship) || rel.table.toLowerCase() === r.q.toLowerCase()) continue;
      const target = readings.get(rel.table.toLowerCase());
      if (!target) continue;
      target.incoming.push({
        direction: "incoming",
        columns: rel.table_columns,
        table: r.q,
        table_columns: rel.columns,
        relationship: rel.relationship === "one_to_one" ? "one_to_one" : "one_to_many",
        origin: rel.origin,
        basis: rel.basis,
      });
    }
  }
  // Declared foreign keys from tables outside the reach still count as references.
  const declaredInbound = new Map<string, Set<string>>();
  for (const t of snapshot.tables) {
    if (intrinsicRole(t)) continue;
    for (const fk of t.foreign_keys ?? []) {
      const k = qualifiedName({ schema: fk.references.schema ?? t.schema, name: fk.references.table }).toLowerCase();
      if (k === keyOf(t)) continue;
      declaredInbound.set(k, (declaredInbound.get(k) ?? new Set()).add(keyOf(t)));
    }
  }
  for (const [k, r] of readings) {
    const from = new Set([...(declaredInbound.get(k) ?? []), ...r.incoming.map((x) => x.table.toLowerCase())]);
    const { role, reasons } = roleOf(r, from.size, unread.get(k));
    r.role = role;
    r.roleReasons = reasons;
  }

  // Fan-out: a table that is the many side of a likely fact or event.
  const isFactLike = (role: TableRole | undefined) => role === "fact" || role === "event";
  for (const r of readings.values()) {
    // Copies and backups are left out of measures, so their rows fan nothing out.
    if (r.role === "noise") continue;
    for (const rel of r.outgoing) {
      if (rel.relationship !== "many_to_one" || rel.table.toLowerCase() === r.q.toLowerCase()) continue;
      const parent = readings.get(rel.table.toLowerCase());
      if (!parent || !isFactLike(parent.role)) continue;
      const parentNoun = words(parent.entity);
      const parentMeasures = parent.measures.filter((m) => m.kind === "sum").map((m) => m.name);
      rel.fan_out =
        `${r.q} is probably the many side of ${parent.q}, a likely ${parent.role}: several ${pluralNoun(words(r.entity))} per ${parentNoun}. ` +
        `Joining ${parent.q} to these rows repeats each ${parentNoun} once per row, so ${
          parentMeasures.length ? `its measures (${listPhrase(parentMeasures)})` : `its row count`
        } would be overstated; keep ${parentNoun} measures on ${parent.q}, or add these rows up to the ${parentNoun} first.`;
      const back = parent.incoming.find((x) => x.table.toLowerCase() === r.q.toLowerCase() && x.relationship === "one_to_many");
      if (back) {
        back.fan_out = `one ${parentNoun} has several rows in ${r.q}: joining it repeats this table's rows, so its measures must not be summed across ${pluralNoun(words(r.entity))}.`;
      }
    }
  }

  // Joined splits: attributes of to-one joined dimensions (and parent facts), one or two hops.
  const joinedSplits = (r: Reading): CandidateSplit[] => {
    const out: CandidateSplit[] = [];
    const seen = new Set<string>();
    const hop = (from: Reading, path: string[], depth: number) => {
      for (const rel of from.outgoing) {
        if (!TO_ONE.has(rel.relationship) || !rel.join || rel.note) continue;
        const target = readings.get(rel.table.toLowerCase());
        if (!target || target.q.toLowerCase() === from.q.toLowerCase() || target.q.toLowerCase() === r.q.toLowerCase()) continue;
        if (!(target.role === "dimension" || target.role === "snapshot" || (depth === 0 && target.role === "fact"))) continue;
        const via = [...path, rel.join];
        for (const s of target.own) {
          if (s.kind === "time") continue;
          const field = `${via.join(".")}.${s.column}`;
          if (seen.has(field)) continue;
          seen.add(field);
          out.push({
            ...s,
            field,
            via: via.join("."),
            basis: `through ${depth === 0 ? "the join" : "the joins"} ${via.join(" then ")} to ${target.q}; ${s.basis}`,
          });
        }
        if (depth === 0) hop(target, via, 1);
      }
    };
    hop(r, [], 0);
    return out;
  };

  const tables: TableBaseline[] = [];
  for (const t of selected) {
    const r = readings.get(keyOf(t));
    if (!r) continue;
    tables.push(tableBaseline(r, joinedSplits(r), readings, opts, unread.get(keyOf(t)), dialect));
  }
  const roleRank = (role: TableRole) => TABLE_ROLES.indexOf(role);
  tables.sort((a, b) => roleRank(a.role) - roleRank(b.role) || (rankIndex.get(a.table.toLowerCase()) ?? 0) - (rankIndex.get(b.table.toLowerCase()) ?? 0));

  const inBrief = new Set(tables.map((x) => x.table.toLowerCase()));
  const facts: StarFact[] = tables
    .filter((x): x is TableBaseline & { role: "fact" | "event" } => x.role === "fact" || x.role === "event")
    .map((x) => ({
      table: x.table,
      role: x.role,
      grain: x.grain.guess,
      dimensions: x.relationships
        .filter((rel) => rel.direction === "outgoing" && TO_ONE.has(rel.relationship) && rel.table.toLowerCase() !== x.table.toLowerCase() && !isFactLike(readings.get(rel.table.toLowerCase())?.role))
        .map((rel) => ({ table: rel.table, via: rel.join ?? rel.columns.join("_"), columns: rel.columns, in_brief: inBrief.has(rel.table.toLowerCase()) })),
      parents: x.relationships
        .filter((rel) => rel.direction === "outgoing" && rel.fan_out)
        .map((rel) => ({ table: rel.table, columns: rel.columns })),
    }));
  const dims = tables.filter((x) => x.role === "dimension").map((x) => x.table);
  const joinedDims = new Set(facts.flatMap((f) => f.dimensions.map((d) => d.table.toLowerCase())));
  // A dimension reached from a fact's dimension (customers -> regions) is attached too.
  for (const d of [...joinedDims]) {
    for (const rel of readings.get(d)?.outgoing ?? []) if (TO_ONE.has(rel.relationship)) joinedDims.add(rel.table.toLowerCase());
  }
  const profiledAny = tables.some((x) => x.profile_state !== "no");
  const unprofiled = tables.filter((x) => x.profile_state !== "yes" && x.role !== "noise").map((x) => x.table);
  if (!profiledAny && tables.length) {
    notes.push("No table in this brief has a profile, so key uniqueness, value counts and which columns are near-unique are guesses from names.");
  }
  const profileCommand = unprofiled.length ? `sl profile --source ${opts.source} --tables ${unprofiled.join(",")}` : null;
  // An imported snapshot (DDL, dbt manifest, catalog export) was read without a connection, and sl
  // profile needs one: one to configure when the source has none, or one that reaches the database.
  const imported = snapshot.method !== "live";
  const conn = opts.connection;
  const connected = !!(conn?.env || conn?.env_prefix !== undefined || conn?.database || (conn?.views && Object.keys(conn.views).length));
  const how = article(snapshot.method.replace(/_/g, " "));
  if (imported && profileCommand) {
    notes.push(
      connected
        ? `This snapshot came from ${how} import, so nothing has read the data yet: \`sl profile\` reads it through the connection in sources/${opts.source}.yaml; run it where the database is reachable.`
        : `This snapshot came from ${how} import, so \`sl profile\` needs a connection to the database first: ` +
            `set connection.env, or connection.database for DuckDB, in sources/${opts.source}.yaml.`,
    );
  }
  // With more tables than the focus threshold, the owner picks a focus before anything is profiled or drafted.
  const next = selection === "focus"
    ? `Read this brief to the owner and agree which tables to focus on first (\`sl tables --source ${opts.source} --groups\`, then \`sl scope --source ${opts.source} --include <pattern> --write\`); profile and draft only the scoped tables.`
    : profileCommand
    ? `Read this brief to the owner and note their answers; ${
        imported
          ? connected
            ? "where the database is reachable (this snapshot came from an import, read without a connection), "
            : `once sources/${opts.source}.yaml has a connection (this snapshot came from an import, read without one), `
          : ""
      }\`${profileCommand}\` measures what it guesses, then \`sl draft --source ${opts.source}\` writes the draft models.`
    : `Read this brief to the owner and note their answers, then \`sl draft --source ${opts.source}\` writes the draft models.`;

  return {
    source: opts.source,
    dialect,
    method: snapshot.method,
    captured_at: snapshot.captured_at,
    snapshot_tables: snapshot.tables.length,
    in_scope: scoped.length,
    focus_threshold: opts.focusThreshold,
    selection,
    left_out: leftOut,
    left_out_noise: leftOutNoise,
    profiled: profiledAny,
    connection_configured: connected,
    notes,
    tables,
    star: {
      facts,
      dimensions: dims,
      unattached_dimensions: dims.filter((d) => !joinedDims.has(d.toLowerCase())),
      other: tables.filter((x) => !["fact", "event", "dimension"].includes(x.role)).map((x) => ({ table: x.table, role: x.role })),
    },
    profile_command: profileCommand,
    next,
  };
}

function grainOf(r: Reading, readings: Map<string, Reading>): { guess: string; basis: string } {
  const { table } = r;
  const parents = r.outgoing
    .filter((rel) => rel.relationship === "many_to_one" && rel.table.toLowerCase() !== r.q.toLowerCase())
    .map((rel) => readings.get(rel.table.toLowerCase()))
    .filter((p): p is Reading => !!p && r.role !== "noise" && (p.role === "fact" || p.role === "event"));
  const several = parents.length ? ` (several per ${listPhrase(parents.map((p) => words(p.entity)))})` : "";
  if (r.existing?.grain) {
    return { guess: r.existing.grain.replace(/\.$/, "").replace(/^One/, "one"), basis: `the ${r.existing.status === "approved" ? "approved" : "draft"} model ${r.existing.model}` };
  }
  const bases: string[] = [];
  let guess: string;
  if (r.draft.grain) {
    guess = r.draft.grain.replace(/\.$/, "").replace(/^One/, "one");
    bases.push("the table comment");
    if (r.pk) bases.push(keyPhrase(r.pk));
    return { guess: guess + several, basis: bases.join(" and ") };
  }
  const historyCols = table.columns.filter((c) => HISTORY_COLUMN.test(toSpecName(c.name))).map((c) => c.name);
  const snapDate = table.columns.find((c) => SNAPSHOT_DATE_COLUMN.test(toSpecName(c.name)));
  const pkCols = r.pk?.columns ?? [];
  const entityCols = pkCols.filter((c) => !HISTORY_COLUMN.test(toSpecName(c)) && !SNAPSHOT_DATE_COLUMN.test(toSpecName(c)));
  const noun = (cols: string[]) => listPhrase(cols.map((c) => words(toSpecName(c).replace(/_id$/, ""))));
  if (r.role === "snapshot" && (historyCols.length || snapDate)) {
    const ent = entityCols.length ? noun(entityCols) : words(r.entity);
    if (snapDate) return { guess: `one row per ${ent} per ${snapDate.name}`, basis: `the snapshot date column ${snapDate.name}${r.pk ? ` and ${keyPhrase(r.pk)}` : ""}` };
    return { guess: `one row per version of ${article(ent)} (from ${listPhrase(historyCols)})`, basis: `the history columns ${listPhrase(historyCols)}` };
  }
  if (r.role === "bridge" && pkCols.length >= 2) {
    return { guess: `one row per ${pkCols.length === 2 ? "pair" : "combination"} of ${noun(pkCols)}`, basis: keyPhrase(r.pk!) };
  }
  if (r.pk) {
    const single = pkCols.length === 1 ? toSpecName(pkCols[0]!) : null;
    // A key that names part of the table's entity reads as the table: audit_id on audit_log is one audit log entry.
    const x = single?.replace(/_id$/, "");
    const fuller = !!x && x !== r.tableEntity && (r.tableEntity.startsWith(`${x}_`) || r.tableEntity.endsWith(`_${x}`));
    guess =
      single === "id" || fuller
        ? `one row per ${words(fuller ? r.tableEntity : r.entity)}`
        : `one row per ${noun(pkCols)}`;
    return { guess: guess + several, basis: keyPhrase(r.pk) };
  }
  if (r.role === "event") return { guess: `one row per event${several}`, basis: "its event-log shape, with no key declared" };
  return { guess: `one row per ${words(r.entity)}${several}`, basis: "the table name only; no key is declared or could be inferred" };
}

// On a table that probably describes things, a sum or a ratio is worded as doubtful.
function dimensionMeasure(m: CandidateMeasure): CandidateMeasure {
  if (m.kind !== "sum" && m.kind !== "ratio") return m;
  return { ...m, description: `${m.description}; this table probably describes things, so this is probably not something to add up: confirm` };
}

function tableBaseline(
  r: Reading,
  joined: CandidateSplit[],
  readings: Map<string, Reading>,
  opts: BaselineOptions,
  unread: { count: number; columns: string[] } | undefined,
  dialect: Dialect,
): TableBaseline {
  const { table, q } = r;
  const grain = grainOf(r, readings);
  const splitCols = new Set(r.own.map((s) => s.column));
  const notSplits: NotSplit[] = [];
  const unclear: { column: string; reason: string }[] = [];
  const outByCol = new Map<string, BaselineRelationship>();
  for (const rel of r.outgoing) if (rel.columns.length === 1) outByCol.set(rel.columns[0]!.toLowerCase(), rel);
  const sensitiveCols: { column: string; reason: string; tag: string }[] = [];
  for (const col of r.role === "noise" ? [] : table.columns) {
    const norm = toSpecName(col.name);
    const isKey = r.keyColumns.has(col.name);
    const sens = sensitivityOf(col.name, col, table.row_count, { key: isKey });
    if (sens) sensitiveCols.push({ column: col.name, reason: sens.reason, tag: sens.tag });
    if (splitCols.has(col.name)) continue;
    const category = classifyType(col.type);
    if (sens) {
      const near = category === "string" && nearUnique(col.profile, table.row_count) && !isKey;
      notSplits.push({
        column: col.name,
        reason: near && sens.reason.includes("nearly every row") ? "near_unique" : "sensitive",
        detail: `${sens.reason}${sens.tag === "pii" ? " (pii)" : ""}`,
      });
      continue;
    }
    if (isKey) {
      const rel = outByCol.get(col.name.toLowerCase());
      const target = rel ? readings.get(rel.table.toLowerCase()) : undefined;
      const attrs = target && rel?.join ? target.own.filter((s) => s.kind !== "time").slice(0, 2).map((s) => `${rel.join}.${s.column}`) : [];
      const isPk = r.pk?.columns.includes(col.name);
      notSplits.push({
        column: col.name,
        reason: "id",
        detail: rel
          ? `${rel.origin === "inferred" ? "probably a key" : "a key"} to ${rel.table}${attrs.length ? `; split by its attributes instead (${listPhrase(attrs, "or")})` : ""}`
          : isPk
            ? r.pk?.confirmed
              ? "the table's key: one value per row"
              : "probably the table's key: one value per row"
            : "an id",
      });
      continue;
    }
    if (category === "string" && nearUnique(col.profile, table.row_count)) {
      notSplits.push({ column: col.name, reason: "near_unique", detail: "a different value on nearly every row" });
      continue;
    }
    if (category === "string" && FREE_TEXT_NAME.test(norm)) {
      notSplits.push({ column: col.name, reason: "free_text", detail: "probably free text, by its name" });
      continue;
    }
    const measureNote = r.measureColumns.get(col.name);
    if (measureNote) {
      notSplits.push({ column: col.name, reason: "measure", detail: measureNote });
      continue;
    }
    if (HISTORY_COLUMN.test(norm) || DELETED_COLUMN.test(norm) || (TEST_COLUMN.test(norm) && category === "boolean")) {
      // Filters rather than splits; the questions ask about them.
      continue;
    }
    const distinct = col.profile?.distinct_count;
    if (typeof distinct === "number" && distinct > LOW_CARDINALITY_MAX && (category === "string" || isNumeric(category))) {
      notSplits.push({ column: col.name, reason: "high_cardinality", detail: `${plural(distinct, "distinct value")}: better as a filter than a split` });
      continue;
    }
    if (category === "other") {
      notSplits.push({ column: col.name, reason: "type", detail: `its type, ${col.type}, does not group` });
      continue;
    }
    if (category === "string" && distinct === undefined) {
      unclear.push({ column: col.name, reason: "its number of distinct values is unknown; a profile would count them" });
    }
  }

  const questions = questionsOf(r, grain, sensitiveCols, dialect);
  const state = profileState(table);
  const wouldMeasure: string[] = [];
  if (state !== "yes" && r.role !== "noise") {
    if (r.pk?.how === "name") wouldMeasure.push(`whether ${r.pk.columns.join(", ")} is unique and never null, as a key must be`);
    if (!r.pk) wouldMeasure.push("which column, if any, is unique and never null: a candidate key");
    const counted = [...r.own.filter((s) => s.kind === "category").map((s) => s.column), ...unclear.map((u) => u.column)];
    if (counted.length) wouldMeasure.push(`how many distinct values ${listPhrase(counted)} hold, to confirm which are splits and which are near-unique`);
    const status = table.columns.filter((c) => STATUS_COLUMN.test(toSpecName(c.name)) && classifyType(c.type) === "string").map((c) => c.name);
    if (status.length) wouldMeasure.push(`the values of ${listPhrase(status)} and how often each occurs`);
    if (r.timeColumns.length) wouldMeasure.push(`the range and null share of ${listPhrase(r.timeColumns)}`);
    if (table.row_count === null || table.row_count === undefined) wouldMeasure.push("the row count");
  }

  return {
    table: q,
    kind: table.kind,
    rows: table.row_count ?? null,
    description: table.description ?? null,
    in_scope: inScope(opts.scope, table),
    model: r.existing ? { name: r.existing.model, status: r.existing.status ?? "draft" } : null,
    profile_state: state,
    role: r.role,
    role_reasons: r.roleReasons,
    grain,
    primary_key: r.pk,
    relationships: [...r.outgoing, ...r.incoming],
    references_not_read: unread ?? null,
    measures: r.role === "noise" ? [] : r.role === "dimension" ? r.measures.map(dimensionMeasure) : r.measures,
    splits: r.role === "noise" ? [] : [...r.own, ...joined],
    not_splits: notSplits,
    unclear,
    questions,
    profile_would_measure: wouldMeasure,
  };
}

function questionsOf(
  r: Reading,
  grain: { guess: string; basis: string },
  sensitiveCols: { column: string; reason: string; tag: string }[],
  dialect: Dialect,
): OwnerQuestion[] {
  const { table, q } = r;
  const out: OwnerQuestion[] = [];
  const noun = words(r.entity);
  if (r.role === "noise") {
    out.push({ topic: "grain", question: `${q} looks like noise (${r.roleReasons.join("; ")}). Can it be left out of the semantic layer?`, columns: [] });
    return out;
  }
  // 1. What a row is.
  const keyNote = r.pk
    ? r.pk.confirmed
      ? ""
      : r.pk.how === "name"
        ? ` The key ${r.pk.columns.join(", ")} is a guess from its name.`
        : ""
    : " No key is declared or could be inferred: which columns identify a row?";
  const staging = r.role === "staging" ? " It looks like raw or staging data: should reports read a cleaned table instead?" : "";
  out.push({ topic: "grain", question: `What is one row of ${q}? Our guess: ${grain.guess}, from ${grain.basis}.${keyNote}${staging}`, columns: r.pk?.columns ?? [] });

  // 2. Which status values count.
  for (const col of table.columns) {
    const norm = toSpecName(col.name);
    if (!STATUS_COLUMN.test(norm) || classifyType(col.type) !== "string" || r.keyColumns.has(col.name)) continue;
    const top = plainTopValues(col);
    const seen = top.length ? ` Values in the profile: ${top.slice(0, 8).map((t) => `${formatValue(t.value)} (${t.count.toLocaleString("en-US")})`).join(", ")}.` : "";
    out.push({
      topic: "status_values",
      question: `Which values of ${col.name} count as a real ${noun} in reports, and which should be left out (cancelled, refunded, pending, test)?${seen}`,
      columns: [col.name],
    });
  }

  // 3. Which date is "the" date, and its time zone: for a timestamp without one, also the zone its
  // values are recorded in (the time dimension's time_zone); a date has no time zone to ask about.
  const zoneOf = (c: string) => timestampHasZone(dialect, table.columns.find((x) => x.name === c)?.type ?? "");
  const naive = r.timeColumns.filter((c) => zoneOf(c) === false);
  const aware = r.timeColumns.some((c) => zoneOf(c) === true);
  const naiveNote = naive.length
    ? ` ${listPhrase(naive)} ${naive.length === 1 ? "has" : "have"} no time zone: in which zone ${naive.length === 1 ? "is it" : "are they"} recorded (the time dimension's time_zone), and in which time zone should days be counted?`
    : "";
  if (r.timeColumns.length >= 2) {
    const guess = r.timeColumns.find((c) => PRIMARY_DATE.test(toSpecName(c))) ?? r.timeColumns[0]!;
    out.push({
      topic: "date",
      question: `Which date is "the" date of ${article(noun)}: ${listPhrase(r.timeColumns, "or")}? Our guess is ${guess}.${
        naiveNote || (aware ? " In which time zone should days be counted?" : "")
      }`,
      columns: [...r.timeColumns],
    });
  } else if (r.timeColumns.length === 1 && (r.role === "fact" || r.role === "event" || r.role === "snapshot")) {
    const only = r.timeColumns[0]!;
    const report = `${only} the date to report ${pluralNoun(noun)} by`;
    out.push({
      topic: "date",
      question: naive.length
        ? `Is ${report}?${naiveNote.replace(`${only} has`, "It has")}`
        : aware
          ? `Is ${report}, and in which time zone should days be counted?`
          : `Is ${report}?`,
      columns: [only],
    });
  }
  // Timestamps without a time zone that the date question above does not name (a dimension table's
  // one timestamp, a deletion time): the zone their values are stored in, as sl draft asks. With a
  // date question, it asks this too; without one, this is the date question.
  const dateQuestion = out.find((x) => x.topic === "date");
  const unasked = r.draft.dimensions
    .filter((d) => d.type === "time")
    .map((d) => table.columns.find((c) => columnExpr(dialect, c.name) === d.expr)?.name)
    .filter((c): c is string => !!c && zoneOf(c) === false && !dateQuestion?.columns.includes(c));
  if (unasked.length) {
    const one = unasked.length === 1;
    if (dateQuestion) {
      dateQuestion.question += ` ${listPhrase(unasked)} ${one ? "has" : "have"} no time zone either: in which zone ${one ? "is it" : "are they"} recorded?`;
      dateQuestion.columns.push(...unasked);
    } else {
      out.push({
        topic: "date",
        question: `${listPhrase(unasked)} ${one ? "is a timestamp" : "are timestamps"} without a time zone: in which zone ${
          one ? "is its value" : "are their values"
        } recorded (the time dimension's time_zone, an IANA zone such as UTC or America/New_York)?`,
        columns: unasked,
      });
    }
  }

  // 4. Units and currency. A unit its type or comment states is not asked; a currency its comment,
  // its name or the table's currency column names is asked as a confirmation.
  const money = r.measures.filter((m) => (m.kind === "sum" || m.kind === "average") && m.format === "currency" && m.columns.length === 1);
  if (money.length) {
    const cents = money.filter((m) => m.unit_note?.startsWith("probably stored in cents")).flatMap((m) => m.columns);
    const other = money.filter((m) => !m.unit_note?.startsWith("probably stored in cents") && !m.whole_units).flatMap((m) => m.columns);
    const currencyCols = table.columns.filter((c) => /(^|_)currency(_code)?$/.test(toSpecName(c.name))).map((c) => c.name);
    const parts: string[] = [];
    if (cents.length) parts.push(`${listPhrase(cents)} look${cents.length === 1 ? "s" : ""} like money stored in cents, so the brief divides ${cents.length === 1 ? "it" : "them"} by 100: is that right?`);
    if (other.length) parts.push(`${other.length === 1 ? "Is" : "Are"} ${listPhrase(other)} in whole currency units or in cents?`);
    const fromColumn = [...new Set(money.filter((m) => m.currency && m.currency_basis === "currency_column").map((m) => m.currency!))];
    if (fromColumn.length) parts.push(`The currency column holds only ${listPhrase(fromColumn)}: is every row in ${fromColumn.length === 1 ? fromColumn[0] : "one of these"}?`);
    // Currencies named by a column's comment or name, or by the table comment: confirmations.
    const named = new Map<string, string[]>();
    for (const m of money) {
      if (!m.currency || !m.currency_basis || m.currency_basis === "currency_column") continue;
      const how = m.currency_basis === "name" ? "name" : m.currency_basis === "column_comment" ? "comment" : "table comment";
      const key = `${m.currency}\u0000${how}`;
      named.set(key, [...(named.get(key) ?? []), ...m.columns]);
    }
    for (const [key, cols] of named) {
      const [code, how] = key.split("\u0000") as [string, string];
      const one = cols.length === 1;
      const by = how === "table comment" ? "the table comment" : `${one ? "its" : "their"} ${how}${one ? "" : "s"}`;
      parts.push(`${listPhrase(cols)} ${one ? "is" : "are"} in ${code} by ${by}: is that right?`);
    }
    const unknown = money.filter((m) => !m.currency).flatMap((m) => m.columns);
    if (unknown.length) {
      // A pronoun when the sentence before names exactly these columns.
      const pronoun = parts.length === 1 && other.length === unknown.length && unknown.every((c) => other.includes(c));
      const they = pronoun ? (unknown.length === 1 ? "is it" : "are they") : `${unknown.length === 1 ? "is" : "are"} ${listPhrase(unknown)}`;
      if (currencyCols.length) parts.push(`Which currency ${they} in? The table has ${listPhrase(currencyCols)}: do rows mix currencies, and should amounts be converted?`);
      else parts.push(`Which currency ${they} in?`);
    }
    if (parts.length) out.push({ topic: "units", question: parts.join(" "), columns: [...new Set([...cents, ...other, ...money.flatMap((m) => m.columns), ...currencyCols])] });
  }
  for (const m of r.measures) {
    if (m.kind === "sum" && m.unit_note === "a duration; the unit is not stated") {
      out.push({ topic: "units", question: `Is ${m.columns[0]} in seconds, minutes or hours?`, columns: [...m.columns] });
    }
  }

  // 5. Test or deleted rows.
  const testCols = table.columns.filter((c) => TEST_COLUMN.test(toSpecName(c.name)) && ["boolean", "string"].includes(classifyType(c.type))).map((c) => c.name);
  const deletedCols = table.columns.filter((c) => DELETED_COLUMN.test(toSpecName(c.name))).map((c) => c.name);
  const testValues: string[] = [];
  for (const col of table.columns) {
    if (!STATUS_COLUMN.test(toSpecName(col.name)) && !CATEGORY_NAME.test(toSpecName(col.name))) continue;
    for (const t of plainTopValues(col)) if (typeof t.value === "string" && /\b(test|dummy|sandbox|internal)\b/i.test(t.value)) testValues.push(`${col.name} = ${formatValue(t.value)}`);
  }
  const commentTest = !!table.description && /\b(test|dummy|internal|sandbox)\b/i.test(table.description);
  if (testCols.length || deletedCols.length || testValues.length || commentTest) {
    const parts: string[] = [];
    if (testCols.length) parts.push(`Should rows where ${listPhrase(testCols, "or")} marks a test be left out of every metric?`);
    if (testValues.length) parts.push(`Should rows with ${listPhrase(testValues, "or")} be left out?`);
    if (deletedCols.length) parts.push(`Should rows with ${listPhrase(deletedCols, "or")} set (deleted or archived) be left out?`);
    if (commentTest && !testCols.length && !testValues.length) parts.push(`The table comment mentions test or internal rows: how can they be recognised, and should they be left out?`);
    else if (commentTest) parts.push("The table comment mentions test or internal rows too.");
    out.push({ topic: "exclusions", question: parts.join(" "), columns: [...testCols, ...deletedCols] });
  }

  // 6. History columns.
  const historyCols = table.columns.filter((c) => HISTORY_COLUMN.test(toSpecName(c.name))).map((c) => c.name);
  const snapDate = table.columns.filter((c) => SNAPSHOT_DATE_COLUMN.test(toSpecName(c.name))).map((c) => c.name);
  if (historyCols.length) {
    out.push({
      topic: "history",
      question: `${listPhrase(historyCols)} look like history columns: ${article(noun)} may have several versions. Should reports read only the current version, or the version in effect at the time of each event?`,
      columns: historyCols,
    });
  } else if (snapDate.length) {
    out.push({
      topic: "history",
      question: `${listPhrase(snapDate)} looks like a snapshot date: the table may hold one copy per day. Should reports read only the latest snapshot, and must its numbers never be summed across snapshot dates?`,
      columns: snapDate,
    });
  }

  // 7. Sensitive columns.
  if (sensitiveCols.length) {
    const pii = sensitiveCols.filter((s) => s.tag === "pii").map((s) => s.column);
    const near = sensitiveCols.filter((s) => s.tag !== "pii" && s.reason.endsWith("nearly every row")).map((s) => s.column);
    const other = sensitiveCols.filter((s) => s.tag !== "pii" && !near.includes(s.column));
    const parts: string[] = [];
    if (pii.length) parts.push(`${listPhrase(pii)} look${pii.length === 1 ? "s" : ""} like personal data`);
    if (other.length) parts.push(`${listPhrase(other.map((s) => s.column))} look${other.length === 1 ? "s" : ""} sensitive (${other.map((s) => s.reason).join("; ")})`);
    if (near.length)
      parts.push(`${listPhrase(near)} ${near.length === 1 ? "has" : "have"} a different value on nearly every row, so ${near.length === 1 ? "it is" : "they are"} treated as protected (free text or identifiers) until you say otherwise`);
    out.push({
      topic: "sensitive",
      question: `${parts.join(", and ")}. Who may see ${sensitiveCols.length === 1 ? "it" : "them"}? The brief keeps ${sensitiveCols.length === 1 ? "it" : "them"} out of splits.`,
      columns: sensitiveCols.map((s) => s.column),
    });
  }
  return out;
}

// Markdown ------------------------------------------------------------------------

const ROLE_LABEL: Record<TableRole, string> = {
  fact: "a fact (things that happened, with numbers to add up)",
  event: "an event log",
  snapshot: "a snapshot or history table",
  bridge: "a bridge (it links other tables)",
  dimension: "a dimension (it describes things)",
  staging: "raw or staging data",
  noise: "noise (a copy, backup, test or bookkeeping table)",
};

function relLine(rel: BaselineRelationship): string {
  const rels: Record<string, string> = {
    many_to_one: "many-to-one",
    one_to_one: "one-to-one",
    one_to_many: "one-to-many",
    many_to_many: "many-to-many",
  };
  const arrow =
    rel.direction === "outgoing"
      ? `${rel.columns.join(", ")} → ${rel.table} (${rel.table_columns.join(", ")})`
      : `${rel.table} (${rel.table_columns.join(", ")}) → ${rel.columns.join(", ")}`;
  const via = rel.join ? `, join \`${rel.join}\`` : "";
  return `${arrow}: probably ${rels[rel.relationship] ?? rel.relationship}${via}; from ${rel.basis}${rel.note ? ` (${rel.note})` : ""}`;
}

function measureLine(m: CandidateMeasure): string {
  const how =
    m.kind === "ratio"
      ? `${m.numerator} ÷ ${m.denominator}`
      : m.kind === "row_count"
        ? "count(*)"
        : `${m.agg}(${m.expr ?? "*"})`;
  return `\`${m.name}\` = ${how}: ${m.description}${m.unit_note ? ` (${m.unit_note})` : ""}`;
}

function splitLine(s: CandidateSplit): string {
  if (s.kind === "time") return `\`${s.field}\` by ${(s.time_grains ?? []).join(", ")}`;
  const values = s.values?.length ? `; values such as ${s.values.map(formatValue).join(", ")}` : "";
  return `\`${s.field}\` (${s.kind}; ${s.basis}${values})`;
}

export function renderBaseline(report: BaselineReport): string {
  const L: string[] = [];
  const date = report.captured_at.slice(0, 10);
  L.push(`# Baseline brief: ${report.source}`, "");
  const covered = report.tables.length;
  let counts: string;
  if (report.selection === "tables") counts = `it covers the ${plural(covered, "table")} --tables names (${report.in_scope} in scope, ${report.snapshot_tables} in the snapshot)`;
  else if (report.in_scope === 0) counts = "no table is in scope";
  else if (covered === report.in_scope) counts = covered === 1 ? "it covers the 1 in-scope table" : `it covers all ${covered} in-scope tables`;
  else counts = `it covers ${covered} of the ${report.in_scope} in-scope tables`;
  if (report.selection !== "tables" && report.snapshot_tables !== report.in_scope) counts += ` (${report.snapshot_tables} in the snapshot)`;
  L.push(
    `A first reading of the ${report.source} schema (${report.dialect}, from ${
      report.method === "live" ? "a live introspection" : `${article(report.method.replace(/_/g, " "))} import`
    } captured ${date}): ${counts}. Everything below is a guess from names${
      report.profiled ? ", keys and profiles" : " and keys"
    }, for the owner to confirm or correct; nothing here is settled.`,
  );
  for (const n of report.notes) L.push("", `> ${n}`);

  L.push("", "## Star-schema sketch (a guess)", "");
  const facts = report.star.facts;
  if (!facts.length) L.push("- No table looks like a fact or an event log.");
  const childrenOf = new Map<string, StarFact[]>();
  const factKeys = new Set(facts.map((f) => f.table.toLowerCase()));
  for (const f of facts) for (const p of f.parents) if (factKeys.has(p.table.toLowerCase())) childrenOf.set(p.table.toLowerCase(), [...(childrenOf.get(p.table.toLowerCase()) ?? []), f]);
  const factLine = (f: StarFact, depth: number) => {
    const dims = f.dimensions.map((d) => `${d.table} via ${d.via}${d.in_brief ? "" : " (not in this brief)"}`);
    L.push(`${"  ".repeat(depth)}- **${f.table}** (${f.role}, ${f.grain}) joins ${dims.length ? listPhrase(dims) : "no dimension"}`);
    for (const c of childrenOf.get(f.table.toLowerCase()) ?? []) factLine(c, depth + 1);
  };
  for (const f of facts) if (!f.parents.some((p) => factKeys.has(p.table.toLowerCase()))) factLine(f, 0);
  if (report.star.dimensions.length) L.push(`- Dimensions: ${report.star.dimensions.join(", ")}`);
  if (report.star.unattached_dimensions.length) L.push(`- Dimensions no fact here joins to: ${report.star.unattached_dimensions.join(", ")}`);
  for (const role of ["snapshot", "bridge", "staging", "noise"] as const) {
    const t = report.star.other.filter((o) => o.role === role).map((o) => o.table);
    if (t.length) L.push(`- ${role[0]!.toUpperCase()}${role.slice(1)}: ${t.join(", ")}`);
  }
  if (facts.length) L.push("", "Does this match how the business thinks about the data? Which of these facts matter most?");

  L.push("", "## Tables");
  for (const t of report.tables) {
    L.push("", `### ${t.table}: probably ${ROLE_LABEL[t.role]}`, "");
    const meta: string[] = [];
    if (t.rows !== null) meta.push(`${t.rows.toLocaleString("en-US")} rows${t.profile_state === "yes" ? "" : " (the catalog's estimate)"}`);
    if (t.kind !== "table") meta.push(`a ${t.kind}`);
    if (!t.in_scope) meta.push("out of scope");
    if (t.model) meta.push(`modeled as ${t.model.name} (${t.model.status})`);
    meta.push(t.profile_state === "yes" ? "profiled" : t.profile_state === "partial" ? "partly profiled" : "not profiled");
    L.push(`- ${meta.join("; ")}`);
    if (t.description) L.push(`- Comment: ${t.description}`);
    L.push(`- Why ${t.role}: ${t.role_reasons.join("; ")}`);
    L.push(`- Grain (guess): ${t.grain.guess}, from ${t.grain.basis}`);
    L.push(`- Key: ${t.primary_key ? `${t.primary_key.columns.join(", ")} (${t.primary_key.basis})` : "none declared or inferred"}`);
    if (t.relationships.length) {
      L.push("- Relationships:");
      for (const rel of t.relationships) {
        L.push(`  - ${relLine(rel)}`);
        if (rel.fan_out) L.push(`    - Fan-out warning: ${rel.fan_out}`);
      }
    }
    if (t.references_not_read) {
      const n = t.references_not_read;
      L.push(
        `- ${plural(n.count, "more table")} ${n.count === 1 ? "carries" : "carry"} ${listPhrase(n.columns, "or")} and ${n.count === 1 ? "was" : "were"} not read; ` +
          `the brief reads the top ${INCOMING_READ_MAX} by rank. Name ${n.count === 1 ? "it" : "them"} with --tables to read ${n.count === 1 ? "it" : "them"}.`,
      );
    }
    if (t.role === "noise") {
      L.push("- Left out of measures and splits as likely noise.");
    } else {
      if (t.measures.length) {
        L.push("- Candidate measures:");
        for (const m of t.measures) L.push(`  - ${measureLine(m)}`);
      }
      if (t.splits.length) {
        L.push("- Candidate splits:");
        for (const s of t.splits) L.push(`  - ${splitLine(s)}`);
      }
    }
    if (t.not_splits.length) L.push(`- Not splits: ${t.not_splits.map((n) => `${n.column} (${n.detail})`).join("; ")}`);
    if (t.unclear.length) L.push(`- Unclear until profiled: ${t.unclear.map((u) => u.column).join(", ")}`);
    if (t.questions.length) {
      L.push("- Questions for the owner:");
      t.questions.forEach((qn, i) => L.push(`  ${i + 1}. ${qn.question}`));
    }
  }

  const unprofiled = report.tables.filter((t) => t.profile_would_measure.length);
  if (unprofiled.length) {
    L.push("", "## What a profile would measure", "");
    L.push(
      report.profile_command
        ? `\`${report.profile_command}\` reads the data (counts, distinct values, top values; protected columns keep counts only) and would replace these guesses with measurements${
            report.method === "live"
              ? ""
              : report.connection_configured
                ? `. It reads the data through the source's connection, so run it where the database is reachable; this snapshot came from ${article(report.method.replace(/_/g, " "))} import`
                : `. It needs a connection to the database, since this snapshot came from ${article(report.method.replace(/_/g, " "))} import`
          }:`
        : "A profile would replace these guesses with measurements:",
    );
    for (const t of unprofiled) L.push(`- ${t.table}: ${t.profile_would_measure.join("; ")}`);
  }
  if (report.left_out.length) {
    const noise = new Set(report.left_out_noise);
    const ranked = report.left_out.filter((t) => !noise.has(t));
    const line = (list: string[]) => {
      const shown = list.slice(0, 20);
      return `${shown.join(", ")}${list.length > shown.length ? `, and ${list.length - shown.length} more` : ""}`;
    };
    L.push("", `## Left out (${report.left_out.length})`, "");
    if (ranked.length) L.push(`${noise.size ? "Below the top by rank: " : ""}${line(ranked)}`);
    if (noise.size) L.push(`${ranked.length ? "\n" : ""}Look like noise: ${line(report.left_out_noise)}`);
  }
  return `${L.join("\n")}\n`;
}

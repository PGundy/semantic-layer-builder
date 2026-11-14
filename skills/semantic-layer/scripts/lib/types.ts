// Types mirroring references/spec.md. The spec is authoritative; these follow it.

export const DIALECTS = ["duckdb", "postgres", "snowflake", "bigquery", "databricks"] as const;
export type Dialect = (typeof DIALECTS)[number];
export const RUNNABLE_DIALECTS: readonly Dialect[] = ["duckdb", "postgres"];

export const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export type Status = "draft" | "approved";

export interface Approval {
  status: Status;
  approved_by?: string;
  approved_at?: string;
  // "sha256:" and 64 hex characters: the hash of the item's semantic content when it was approved
  // (lib/approval-hash.ts). sl validate errors when the item no longer matches it.
  approved_hash?: string;
}

export interface ProjectSettings {
  focus_threshold?: number;
  batch_size?: number;
}

export interface Project {
  version: 1;
  name: string;
  description?: string;
  default_source?: string;
  settings?: ProjectSettings;
}

export const DEFAULT_FOCUS_THRESHOLD = 12;
export const DEFAULT_BATCH_SIZE = 5;

export interface Scope {
  include?: string[];
  exclude?: string[];
  // A table-list file relative to the semantic root; lib/table-list.ts joins its entries to the lists.
  tables_file?: string;
}

export interface SourceConnection {
  // The variable that holds the connection URL.
  env?: string;
  // Postgres: the start of the variables that hold the connection's parts (<prefix>HOST, PORT,
  // USER, PASSWORD, DATABASE, SSLMODE). A source has env or env_prefix, not both.
  env_prefix?: string;
  database?: string;
  setup?: string[];
  views?: Record<string, string>;
}

// How the catalog reaches the layer (spec: sources/<source>.yaml, Intake). Absent means connection.
export const INTAKE_MODES = ["connection", "export"] as const;
export type IntakeMode = (typeof INTAKE_MODES)[number];

export interface SourceIntake {
  mode?: IntakeMode;
  reason?: string | null;
  schemas?: string[];
  export?: { file: string };
}

export interface SourceProfileSettings {
  sample_rows?: number;
  top_values?: number;
}

export interface SourceConfig {
  source: string;
  dialect: Dialect;
  description?: string;
  connection?: SourceConnection;
  intake?: SourceIntake;
  scope?: Scope;
  profile?: SourceProfileSettings;
  draft?: { strip_prefixes?: string[] };
}

// Snapshot

export type SnapshotMethod = "live" | "information_schema" | "dbt_manifest" | "ddl" | "manual";
export type TableKind = "table" | "view" | "external";
export type Scalar = string | number | boolean | null;

export interface TopValue {
  value: Scalar;
  count: number;
}

export interface ColumnProfile {
  null_fraction?: number | null;
  distinct_count?: number | null;
  min?: Scalar;
  max?: Scalar;
  // Absent for a protected column: its values are not stored, raw or hashed.
  top_values?: TopValue[];
  sampled?: boolean;
  // True on a protected column's profile: counts only, with min and max only for a number or date.
  redacted?: boolean;
}

export interface SnapshotColumn {
  name: string;
  type: string;
  nullable?: boolean | null;
  description?: string | null;
  profile?: ColumnProfile;
}

export interface ForeignKey {
  columns: string[];
  references: { schema?: string | null; table: string; columns: string[] };
}

export interface SnapshotTable {
  schema: string | null;
  name: string;
  kind: TableKind;
  row_count?: number | null;
  description?: string | null;
  primary_key?: string[];
  unique_keys?: string[][];
  foreign_keys?: ForeignKey[];
  profiled_at?: string | null;
  // Why the last sl profile run skipped the table and when (spec: Skipped tables). Removed when a
  // run profiles it; an earlier profile, if any, stays beside it.
  profile_skipped?: ProfileSkip;
  columns: SnapshotColumn[];
}

export interface ProfileSkip {
  at: string;
  reason: string;
}

// The selection sl introspect or sl import recorded when it wrote the snapshot (spec: snapshots,
// Scope changes): qualified names of the tables in it, those that entered it with no model yet,
// and those that left it with an approved model.
export interface SnapshotScopeState {
  in_scope: string[];
  new_in_scope: string[];
  left_scope: string[];
}

export interface Snapshot {
  snapshot_version: 1;
  source: string;
  dialect: Dialect;
  captured_at: string;
  method: SnapshotMethod;
  tables: SnapshotTable[];
  scope_state?: SnapshotScopeState;
}

// Models

export type DimensionType = "time" | "string" | "number" | "boolean";
export const TIME_GRAINS = ["hour", "day", "week", "month", "quarter", "year"] as const;
export type TimeGrain = (typeof TIME_GRAINS)[number];
export const AGGREGATIONS = ["sum", "count", "count_distinct", "avg", "min", "max"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];
export type Format = "number" | "integer" | "currency" | "percent";
export type Relationship = "many_to_one" | "one_to_one" | "one_to_many";
// Relationships whose join adds at most one target row per row: join references (one or two hops)
// and request fields on other models travel only through these.
export const TO_ONE_RELATIONSHIPS: readonly Relationship[] = ["many_to_one", "one_to_one"];
export type JoinOrigin = "declared" | "inferred" | "owner";

export interface Dimension extends Approval {
  name: string;
  // SQL over the model's own columns and join references, <join>.<column> or <join>.<join>.<column>,
  // through to-one joins. The joins it reads through are part of its definition.
  expr: string;
  type: DimensionType;
  time_grains?: TimeGrain[];
  // The IANA zone a time dimension's naive timestamps are stored in, such as America/New_York.
  time_zone?: string;
  description?: string;
  synonyms?: string[];
  tags?: string[];
}

export interface Measure extends Approval {
  name: string;
  expr?: string;
  agg: Aggregation;
  // SQL predicate over the model's own columns and join references, <join>.<column> or
  // <join>.<join>.<column>, through to-one joins. The joins it reads through are part of its definition.
  filter?: string;
  format?: Format;
  currency?: string;
  description?: string;
  synonyms?: string[];
  tags?: string[];
}

export interface JoinKey {
  from: string;
  to: string;
}

export interface JoinEvidence {
  checked_at: string;
  // The target model and keys the check measured; absent in evidence written before they were recorded.
  to?: string;
  keys?: JoinKey[];
  left_rows: number;
  left_null_keys: number;
  matched_rows: number;
  match_rate: number;
  right_rows: number;
  right_key_unique: boolean;
  left_key_unique: boolean;
  max_fanout: number;
  suggested_relationship: Relationship | "many_to_many";
}

export interface Join extends Approval {
  name: string;
  to: string;
  keys: JoinKey[];
  relationship: Relationship;
  type?: "left" | "inner";
  origin?: JoinOrigin;
  description?: string;
  evidence?: JoinEvidence;
  // Why an approved to-one join stands although its evidence shows fan-out (a known-dirty key).
  fanout_override?: string;
}

export interface Model extends Approval {
  model: string;
  source: string;
  table: string;
  description?: string;
  grain?: string;
  primary_key?: string[];
  tags?: string[];
  open_questions?: string[];
  // Columns of the table the owner or sl draft left out on purpose; sl draft --new-columns skips them.
  ignored_columns?: string[];
  dimensions: Dimension[];
  measures: Measure[];
  joins?: Join[];
}

// Metrics

interface MetricBase extends Approval {
  name: string;
  source: string;
  format?: Format;
  currency?: string;
  description?: string;
  synonyms?: string[];
  tags?: string[];
}

export interface RatioMetric extends MetricBase {
  type: "ratio";
  numerator: string;
  denominator: string;
}

export interface DerivedMetric extends MetricBase {
  type: "derived";
  expr: string;
}

export type Metric = RatioMetric | DerivedMetric;

export interface MetricsFile {
  metrics: Metric[];
}

// Access

export type UserAttributeType = "string" | "number" | "string_list" | "number_list";

export interface UserAttribute {
  name: string;
  type: UserAttributeType;
  description?: string;
}

// Tags that hide a field or model from every user unless one of the user's roles grants the tag
// in allow.tags, in either access mode.
export const PROTECTED_TAGS = ["pii", "sensitive"] as const;
// The tag an owner puts on a field to record that everyone may see it although it looks sensitive.
export const PUBLIC_TAG = "public";

export type AccessMode = "open" | "closed";

// A row filter is either a SQL predicate over the model's own columns, or a span-of-control rule
// over a hierarchy (closure) model: rows whose column is the user's id or the id of anyone below them.
// An expr and a hierarchy column may also read join references, <join>.<column> or
// <join>.<join>.<column>, through the filtered model's to-one joins; those joins are definition
// joins, added without their targets' row filters.
export interface ExprRowFilter {
  model: string;
  expr: string;
}

export interface HierarchyRowFilter {
  model: string;
  hierarchy: {
    column: string; // column of the filtered model holding a person's id, or a join reference to one
    via: string; // source.model of the closure table: one row per (manager, member) pair at any depth
    manager: string; // closure column holding the manager's id
    member: string; // closure column holding the id of someone at any depth below that manager
    user: string; // the user attribute holding the user's own id, e.g. user.employee_id
    include_self?: boolean; // default true: the user's own rows are included
  };
}

export type RowFilter = ExprRowFilter | HierarchyRowFilter;

export interface Role {
  name: string;
  description?: string;
  // A condition over user attributes (lib/conditions.ts); the role is held when it is true.
  assign_when?: string;
  // models is required in closed mode and has no effect in open mode; tags grants protected tags.
  allow?: { models?: string[]; tags?: string[] };
  // fields names dimensions and measures as source.model.field; a join is hidden with its target model.
  deny?: { models?: string[]; fields?: string[]; tags?: string[] };
  row_filters?: RowFilter[];
  // An entry naming a model silences sl validate's warning that the model's rows are not limited by
  // this role's row filter on a model it joins to.
  open_questions?: string[];
}

// Limits targets to users who hold one of roles or satisfy when.
export interface Restriction {
  name: string;
  description?: string;
  // metric:<name>, source.model or source.model.field, with scope-pattern globs.
  targets: string[];
  allow: { roles?: string[]; when?: string };
}

// Tools that serve users apply only an approved access file; a draft one is served by nothing.
export interface AccessFile extends Approval {
  // The approval a revoke replaced: the approved version that keeps applying where it is deployed.
  last_approved?: { by: string; at: string };
  mode?: AccessMode; // default open
  default_role?: string;
  user_attributes?: UserAttribute[];
  roles?: Role[];
  restrictions?: Restriction[];
  open_questions?: string[];
}

// Goldens

export const FILTER_OPS = ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface RequestFilter {
  field: string;
  op: FilterOp;
  value?: unknown;
}

export interface QueryRequest {
  source: string;
  measures?: string[];
  dimensions?: string[];
  filters?: RequestFilter[];
  order_by?: { field: string; direction?: "asc" | "desc" }[];
  limit?: number;
}

export interface Golden {
  name: string;
  question: string;
  role?: string;
  user?: Record<string, unknown>;
  request: QueryRequest;
  // Hand-written SQL the compiled request is checked against; `sql` is its older name, read as it.
  cross_check_sql?: string;
  sql?: string;
  expected?: { tolerance?: number; rows: Record<string, unknown>[] };
  reference?: string;
  status: Status;
  confirmed_by?: string;
  confirmed_at?: string;
  // The role and user the golden ran as when sl goldens confirm recorded its rows.
  confirmed_as?: GoldenRunAs;
}

export interface GoldenRunAs {
  role?: string;
  user?: Record<string, unknown>;
}

// Query plans (spec: Query-plan protocol)

export interface PlannedQuery {
  id: string;
  purpose: string;
  sql: string;
  // The most rows a connector fetches for this query; a stored result of exactly this many rows
  // is refused as possibly cut off (spec: Query-plan protocol).
  max_rows?: number;
}

export interface QueryPlan {
  command: string;
  source: string;
  dialect: Dialect;
  queries: PlannedQuery[];
}

export type ResultRows = Record<string, unknown>[];
export type PlanResults = Record<string, ResultRows>;

// Pending readbacks (.sl/pending/<readback_id>.json), written by sl readback.

export interface ReadbackItem {
  n: number;
  // An approve target: source.model, source.model.field, metric:<name> or access, or golden:<name>.
  target: string;
  kind: "approve";
  text: string;
  // The target's content hash when it was read back: what sl approve records as approved_hash.
  content_hash: string;
  // A golden:<name> item only: the tolerance it was read back with, which sl goldens confirm records.
  tolerance?: number;
  // A measure or metric item: its figure on today's data and the rows behind it, or why it is not
  // shown. Evidence only: it is outside content_hash.
  evidence?: FigureEvidence;
}

// A measure's or metric's figure in a readback: its total on today's data and the rows behind it,
// or why it is not shown. A metric also lists each measure it combines.
export interface FigurePart {
  ref: string; // model.measure
  figure: number | string | null;
  row_count: number | string | null;
}

export interface FigureEvidence {
  figure?: number | string | null;
  row_count?: number | string | null;
  parts?: FigurePart[];
  not_shown?: string;
}

export interface PendingReadback {
  readback_id: string; // rb_0001, rb_0002, ...
  created_at: string;
  items: ReadbackItem[];
}

// .sl/plans/<plan_id>.json: a plan written by --emit-sql, finished with --plan <plan_id>.
export interface StoredPlan extends QueryPlan {
  version: 1;
  plan_id: string;
  // The command that finishes the plan from its stored results.
  finish: string;
  queries: (PlannedQuery & { max_rows: number })[];
}

// The answer ledger (.sl/ledger.jsonl), appended to by sl reply and sl question resolve: one JSON
// object per line, holding the owner's words, never data values.

export type ReplyVerdict = "yes" | "no" | "change";

export interface LedgerReply {
  id: string; // ans_0001, ans_0002, ...
  kind: "reply";
  readback_id: string;
  item: number;
  // The approve target the item read back (golden:<name> for a golden sl goldens confirm records).
  target: string;
  // The target's content hash when it was read back, copied from the pending readback.
  content_hash: string;
  text: string;
  verdict: ReplyVerdict | null;
  by: string;
  at: string;
}

export interface LedgerQuestion {
  id: string;
  kind: "question";
  // The ref the question was resolved on: source.model, source.model.field or access, and from
  // sl review apply also access.roles.<role>.
  target: string;
  question: string;
  text: string;
  by: string;
  at: string;
}

export type LedgerEntry = LedgerReply | LedgerQuestion;

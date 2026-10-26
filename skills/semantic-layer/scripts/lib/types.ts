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
}

export interface SourceConnection {
  env?: string;
  database?: string;
  setup?: string[];
  views?: Record<string, string>;
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
  top_values?: TopValue[];
  sampled?: boolean;
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
  columns: SnapshotColumn[];
}

export interface Snapshot {
  snapshot_version: 1;
  source: string;
  dialect: Dialect;
  captured_at: string;
  method: SnapshotMethod;
  tables: SnapshotTable[];
}

// Models

export type DimensionType = "time" | "string" | "number" | "boolean";
export const TIME_GRAINS = ["hour", "day", "week", "month", "quarter", "year"] as const;
export type TimeGrain = (typeof TIME_GRAINS)[number];
export const AGGREGATIONS = ["sum", "count", "count_distinct", "avg", "min", "max"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];
export type Format = "number" | "integer" | "currency" | "percent";
export type Relationship = "many_to_one" | "one_to_one" | "one_to_many";
// Relationships whose join adds at most one target row per row: join references and request
// fields on other models travel only through these.
export const TO_ONE_RELATIONSHIPS: readonly Relationship[] = ["many_to_one", "one_to_one"];
export type JoinOrigin = "declared" | "inferred" | "owner";

export interface Dimension extends Approval {
  name: string;
  // SQL over the model's own columns and <join>.<column> join references through its to-one joins.
  expr: string;
  type: DimensionType;
  time_grains?: TimeGrain[];
  description?: string;
  synonyms?: string[];
  tags?: string[];
}

export interface Measure extends Approval {
  name: string;
  expr?: string;
  agg: Aggregation;
  // SQL predicate over the model's own columns and <join>.<column> join references.
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

export interface RowFilter {
  model: string;
  expr: string;
}

export interface Role {
  name: string;
  description?: string;
  allow: { models: string[] };
  // fields names dimensions and measures as source.model.field; a join is hidden with its target model.
  deny?: { models?: string[]; fields?: string[]; tags?: string[] };
  row_filters?: RowFilter[];
  open_questions?: string[];
}

export interface AccessFile extends Approval {
  default_role?: string;
  user_attributes?: UserAttribute[];
  roles: Role[];
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
  sql: string;
  expected?: { tolerance?: number; rows: Record<string, unknown>[] };
  reference?: string;
  status: Status;
  confirmed_by?: string;
  confirmed_at?: string;
}

// Query plans (spec: Query-plan protocol)

export interface PlannedQuery {
  id: string;
  purpose: string;
  sql: string;
}

export interface QueryPlan {
  command: string;
  source: string;
  dialect: Dialect;
  queries: PlannedQuery[];
}

export type ResultRows = Record<string, unknown>[];
export type PlanResults = Record<string, ResultRows>;

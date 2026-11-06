// Checking a rule (references/spec.md, Reference compiler, Checking a rule): whether a row-level
// filter or a dimension expr can be written on a model as the compiler and sl validate read one,
// and the one read-only count query that measures how many rows it matches. It reads the rule the
// way the compiler qualifies it (qualify.ts) and adds its joins through the compiler's join planner.
import { createHash } from "node:crypto";
import { quoteIdent } from "../dialect.ts";
import { findTable, qualifiedName, toSpecName } from "../naming.ts";
import { globInsideViews } from "../source-safety.ts";
import { assertReadOnly, type Token, tokenize } from "../sql-guard.ts";
import { type SqlToken, sqlNames, tokenizeSql } from "../sql-names.ts";
import type { Join, Model, QueryPlan, ResultRows, Snapshot, SourceConfig } from "../types.ts";
import { TO_ONE_RELATIONSHIPS } from "../types.ts";
import { JoinPlan, type PlannedJoin, readsJoin } from "./joins.ts";
import { columnRefs } from "./qualify.ts";
import { COMPILER_DIALECTS, embed } from "./sql.ts";

export type RuleKind = "filter" | "dimension_expr";

export type RuleCode =
  | "invalid_rule"
  | "subquery"
  | "aggregate"
  | "other_table"
  | "to_many_join"
  | "too_many_hops"
  | "unknown_column"
  | "join_fans_out"
  | "invalid_layer"
  | "not_read_only";

export interface RuleInput {
  source: SourceConfig;
  snapshot: Snapshot | null;
  models: Model[];
  model: Model;
  kind: RuleKind;
  text: string;
  // The semantic root, which a duckdb source's view files resolve from for the read-only check.
  root?: string;
}

interface RuleBase {
  source: string;
  model: string;
  kind: RuleKind;
  rule: string;
}

export interface Expressible extends RuleBase {
  expressible: true;
  // The join chains the rule reads through, in reading order: test_account, order.test_account.
  joins_used: string[];
  joins: PlannedJoin[];
  sql: string;
  plan: QueryPlan;
}

export interface NotExpressible extends RuleBase {
  expressible: false;
  code: RuleCode;
  reason: string;
  suggestion: string;
}

export type RuleCheck = Expressible | NotExpressible;

export const RULE_QUERY_PREFIX = "rule:";

// Aggregate and window functions: a row-level rule never holds one.
const AGGREGATES = new Set(
  (
    "count sum avg min max first last any_value arbitrary array_agg string_agg list group_concat listagg json_agg jsonb_agg " +
    "json_object_agg jsonb_object_agg bool_and bool_or every bit_and bit_or median mode stddev stddev_pop stddev_samp variance " +
    "var_pop var_samp corr covar_pop covar_samp percentile_cont percentile_disc quantile quantile_cont quantile_disc " +
    "approx_count_distinct count_if countif arg_max arg_min max_by min_by product histogram fsum favg " +
    "row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value"
  ).split(" "),
);

// Words a bare name may be that are SQL, not columns, beyond the ones qualify.ts reads as keywords.
const NOT_COLUMNS = new Set(["now", "epoch", "dow", "doy", "isodow", "struct", "map", "int", "integer", "bigint", "numeric", "decimal", "double", "real", "float", "varchar", "text", "boolean", "char", "character"]);

const toOne = (j: Join) => (TO_ONE_RELATIONSHIPS as readonly string[]).includes(j.relationship);
const findJoin = (joins: Join[] | undefined, name: string, quoted: boolean) =>
  (joins ?? []).find((j) => (quoted ? j.name === name : j.name.toLowerCase() === name.toLowerCase()));

// What one row of a model is, from its grain ("One row per customer." gives customer).
export function grainOf(model: Model): string {
  const m = typeof model.grain === "string" ? /^\s*one row per (.+?)\.?\s*$/i.exec(model.grain) : null;
  return m ? m[1]!.toLowerCase() : `${model.model} row`;
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

// Up to three names close to `name`: within a third of its length in edits (at least 2), or
// holding it or held by it; nearest first, then by name.
export function closestNames(name: string, names: readonly string[]): string[] {
  const n = name.toLowerCase();
  const scored = [...new Set(names)].map((c) => ({ c, d: distance(n, c.toLowerCase()) }));
  const near = scored.filter(({ c, d }) => d <= Math.max(2, Math.floor(n.length / 3)) || (n.length > 2 && (c.toLowerCase().includes(n) || n.includes(c.toLowerCase()))));
  return near.sort((x, y) => x.d - y.d || (x.c < y.c ? -1 : x.c > y.c ? 1 : 0)).slice(0, 3).map((x) => x.c);
}

// The reason's note on the names close to an unknown one.
const closeNote = (names: string[]) => (names.length ? `the closest names are ${names.join(", ")}` : "no name of it is close");

// Whether a block comment holds another /*. Postgres and DuckDB nest block comments and other
// databases do not, so such a rule reads differently from how the checks here read it. Comments
// sit only between the tokens of tokenize, which reads them nested.
function nestsComments(text: string, tokens: Token[]): boolean {
  const gaps: string[] = [];
  let at = 0;
  for (const t of tokens) {
    gaps.push(text.slice(at, t.pos));
    at = t.end;
  }
  gaps.push(text.slice(at));
  return gaps.some((g) => {
    for (let i = 0; i < g.length; i++) {
      if (g.startsWith("--", i)) {
        const nl = g.indexOf("\n", i);
        if (nl < 0) return false;
        i = nl;
      } else if (g.startsWith("/*", i)) {
        const end = g.indexOf("*/", i + 2);
        if (end < 0 || g.slice(i + 2, end).includes("/*")) return true;
        i = end + 1;
      }
    }
    return false;
  });
}

// Whether every parenthesis closes, read with both tokenizers.
function balanced(text: string, guard: Token[], dialect: SourceConfig["dialect"]): boolean {
  const depthOk = (opens: boolean[]) => {
    let depth = 0;
    for (const open of opens) if ((depth += open ? 1 : -1) < 0) return false;
    return depth === 0;
  };
  const own = tokenizeSql(text, dialect).flatMap((t) => (t.t === "(" ? [true] : t.t === ")" ? [false] : []));
  return depthOk(own) && depthOk(guard.flatMap((t) => (t.kind === "op" && t.text === "(" ? [true] : t.kind === "op" && t.text === ")" ? [false] : [])));
}

class Checker {
  problem?: { code: RuleCode; reason: string; suggestion: string };
  readonly chains: string[] = [];

  constructor(private readonly input: RuleInput) {}

  private get what(): string {
    return this.input.kind === "filter" ? "filter" : "dimension expr";
  }
  private get model(): Model {
    return this.input.model;
  }

  fail(code: RuleCode, reason: string, suggestion: string): void {
    this.problem ??= { code, reason, suggestion };
  }

  private modelOf(name: string): Model | undefined {
    return this.input.models.find((m) => m.model === name);
  }

  // The snapshot's columns of a model's table, or undefined when the snapshot lacks them.
  columnsOf(model: Model): string[] | undefined {
    const t = this.input.snapshot && typeof model.table === "string" ? findTable(this.input.snapshot.tables, model.table) : undefined;
    return t?.columns.length ? t.columns.map((c) => c.name) : undefined;
  }

  private hasColumn(columns: string[], name: string, quoted: boolean): boolean {
    if (columns.includes(name)) return true;
    return (!quoted || this.input.source.dialect === "duckdb") && columns.some((c) => c.toLowerCase() === name.toLowerCase());
  }

  private viewHint(model: Model): string {
    return `ask the owner for a view with one row per ${grainOf(model)} that holds what the rule needs, model it, and run sl check-rule on it`;
  }

  // The text as one SQL expression: balanced parentheses, no statement break, parameter or placeholder.
  shape(text: string): void {
    if (!text.trim()) return this.fail("invalid_rule", `the ${this.what} is empty`, "Pass the rule as one SQL expression over the model's columns.");
    let guard: Token[];
    try {
      guard = tokenize(text);
    } catch (e) {
      const open = /unterminated ([a-z -]+)/.exec((e as Error).message)?.[1] ?? "string or comment";
      return this.fail("invalid_rule", `the ${this.what} has an unterminated ${open}, so it is not one SQL expression`, `Close the ${open} and run sl check-rule again.`);
    }
    if (nestsComments(text, guard))
      return this.fail(
        "invalid_rule",
        `the ${this.what} has a block comment inside a block comment, which databases read differently`,
        "Write each comment on its own, or as a -- comment, and run sl check-rule again.",
      );
    if (!balanced(text, guard, this.input.source.dialect))
      return this.fail("invalid_rule", `the ${this.what} has unbalanced parentheses, so it is not one SQL expression`, "Balance its parentheses and run sl check-rule again.");
    if (guard.some((t) => t.kind === "semicolon"))
      return this.fail("invalid_rule", `the ${this.what} holds a semicolon; a rule is one SQL expression, never a statement`, "Pass one expression without a semicolon.");
    if (guard.some((t) => t.kind === "param") || text.includes("{{"))
      return this.fail(
        "invalid_rule",
        `the ${this.what} holds a parameter or a {{ }} placeholder; a field's filter or expr takes no values from outside`,
        "Write the values into the rule as literals, or, for a rule that depends on the user, use a row filter in access.yaml (references/spec.md, Row filters).",
      );
  }

  subquery(text: string): void {
    if (sqlNames(text, this.input.source.dialect).subquery)
      this.fail(
        "subquery",
        `the ${this.what} has a subquery; a rule reads only the columns of model ${this.model.model} and join references through many_to_one or one_to_one joins`,
        `Add a many_to_one or one_to_one join from ${this.model.model} that reaches the column, or ${this.viewHint(this.model)}.`,
      );
  }

  // An aggregate or window function, with the model it aggregates over and the view that would hold it.
  aggregate(text: string): void {
    const toks = tokenizeSql(text, this.input.source.dialect);
    // Quoted or after a dot (main.count, a struct's .count()) it is still the aggregate.
    const at = toks.findIndex((t, i) => t.t === "id" && toks[i + 1]?.t === "(" && AGGREGATES.has(t.v.toLowerCase()));
    const over = toks.findIndex((t, i) => t.t === "id" && !t.quoted && t.v.toLowerCase() === "over" && (toks[i + 1]?.t === "(" || toks[i + 1]?.t === "id"));
    if (at < 0 && over < 0) return;
    const fn = at >= 0 ? (toks[at] as Extract<SqlToken, { t: "id" }>).v.toLowerCase() : "window";
    // The first column the call reads, and the model it is on (the model, or a join's target).
    const call = new RegExp(`\\b${fn}"?\\s*\\(`, "i").exec(text);
    const refs = columnRefs(text);
    const arg = call ? refs.find((r) => r.start > call.index) : undefined;
    let onModel = this.model;
    let column = arg?.parts[arg.parts.length - 1];
    if (arg && arg.parts.length > 1) {
      const j = findJoin(this.model.joins, arg.parts[0]!, arg.quoted[0]!);
      const target = j && this.modelOf(j.to);
      if (target) onModel = target;
    }
    // A window's partition gives the grain; a partition key that is a join's key gives its target's grain.
    let grain = grainOf(this.model);
    const part = /\bpartition\s+by\b/i.exec(text);
    const key = part ? refs.find((r) => r.start > part.index && r.parts.length === 1) : undefined;
    if (key) {
      const j = (this.model.joins ?? []).find((x) => x.keys.length === 1 && x.keys[0]!.from.toLowerCase() === key.parts[0]!.toLowerCase());
      const target = j && toOne(j) ? this.modelOf(j.to) : undefined;
      grain = target ? grainOf(target) : key.parts[0]!;
    }
    if (!column) column = fn === "count" ? onModel.model : "";
    const name = toSpecName(column ? `${fn}_${column}` : fn);
    this.fail(
      "aggregate",
      `the ${this.what} needs an aggregate (${fn === "window" ? "a window function" : `${fn}()`}) over ${onModel.model}; a rule is read row by row on ${this.model.model}`,
      `Ask the owner for a view with one row per ${grain} and ${name}, model it with a join from ${this.model.model}, and run sl check-rule again with the rule over that join.`,
    );
  }

  // Each name the rule reads: an own column, a struct read on one, or a join reference of one or
  // two to-one hops whose column the last target's table has.
  names(text: string): void {
    const own = this.columnsOf(this.model);
    const joins = this.model.joins ?? [];
    const others = new Set<string>(this.input.models.map((m) => m.model));
    for (const t of this.input.snapshot?.tables ?? []) {
      others.add(t.name.toLowerCase());
      if (t.schema) others.add(t.schema.toLowerCase());
    }
    // A call written <name>.<function>( on a name that is not a column reads a schema's function.
    const toks = tokenizeSql(text, this.input.source.dialect);
    for (const [i, t] of toks.entries()) {
      if (t.t !== "id" || toks[i + 1]?.t !== "." || toks[i + 2]?.t !== "id" || toks[i + 3]?.t !== "(" || toks[i - 1]?.t === ".") continue;
      if (own && this.hasColumn(own, t.v, t.quoted)) continue;
      const fn = (toks[i + 2] as Extract<SqlToken, { t: "id" }>).v;
      return this.fail(
        "other_table",
        `${t.v}.${fn}() names a function by its schema; a rule calls functions by their bare names`,
        `Write ${fn}(...) without ${t.v}., and run sl check-rule again.`,
      );
    }
    for (const r of columnRefs(text)) {
      if (this.problem) return;
      const [first, ...rest] = r.parts;
      const name = r.parts.join(".");
      const join = rest.length ? findJoin(joins, first!, r.quoted[0]!) : undefined;
      if (join) {
        this.joinRef(r.parts, r.quoted, join, name);
        continue;
      }
      if (own && this.hasColumn(own, first!, r.quoted[0]!)) continue;
      if (!r.quoted[0] && NOT_COLUMNS.has(first!.toLowerCase()) && !rest.length) continue;
      if (rest.length && (rest.length > 1 || others.has(first!.toLowerCase()))) {
        this.fail(
          "other_table",
          `${name} names a table or schema directly; a rule reads only the columns of model ${this.model.model} and join references (${joins.length ? `its joins are ${joins.map((j) => j.name).join(", ")}` : "it has no joins"})`,
          `Add a many_to_one or one_to_one join from ${this.model.model} to the model of that table and write <join>.<column>, or ${this.viewHint(this.model)}.`,
        );
        continue;
      }
      if (!own) continue;
      const dim = (this.model.dimensions ?? []).find((d) => d.name.toLowerCase() === first!.toLowerCase());
      // A join is offered as <join>.<column>, since a rule reads a join's columns, never the join.
      const close = closestNames(first!, [...own, ...joins.map((j) => j.name)]).map((c) => (own.includes(c) ? c : `${c}.<column>`));
      const table = qualifiedName(findTable(this.input.snapshot!.tables, this.model.table)!);
      this.fail(
        "unknown_column",
        rest.length
          ? `${name}: "${first}" is neither a column of ${table} nor a join of model ${this.model.model}; ${closeNote(close)}`
          : `"${first}" is not a column of ${table}, the table of model ${this.model.model}; ${closeNote(close)}`,
        dim && typeof dim.expr === "string"
          ? `${dim.name} is a dimension of ${this.model.model}, and a rule reads columns: write its expr, ${dim.expr}, in the rule.`
          : `Write ${close.length ? `one of the closest names (${close.join(", ")})` : `a column of ${table}`}, or, if the column is new, run sl introspect --source ${this.input.source.source} and check the rule again.`,
      );
    }
  }

  private joinRef(parts: string[], quoted: boolean[], first: Join, text: string): void {
    const hops: Join[] = [];
    let from = this.model;
    let join = first;
    for (let k = 1; k < parts.length; k++) {
      if (!toOne(join)) {
        this.fail(
          "to_many_join",
          `${text} reads through join ${from.model}.${join.name}, which is ${join.relationship}: it would repeat rows of ${from.model}`,
          `Add a many_to_one or one_to_one join from ${this.model.model} that reaches the column (sl check-join measures it), or ${this.viewHint(this.model)}.`,
        );
        return;
      }
      hops.push(join);
      const target = this.modelOf(join.to);
      if (!target) {
        this.fail("invalid_layer", `join ${from.model}.${join.name} goes to ${join.to}, which is not a model of source ${this.input.source.source}`, "Run sl validate and fix what it reports, then run sl check-rule again.");
        return;
      }
      const isLast = k === parts.length - 1;
      const next = isLast ? undefined : findJoin(target.joins, parts[k]!, quoted[k]!);
      if (next) {
        if (hops.length >= 2) {
          this.fail(
            "too_many_hops",
            `${text} goes more than two hops; a join reference is <join>.<column> or <join>.<join>.<column>`,
            `Add a join from ${this.model.model} that comes closer to ${next.to}, or ${this.viewHint(this.model)}.`,
          );
          return;
        }
        from = target;
        join = next;
        continue;
      }
      const chain = hops.map((h) => h.name).join(".");
      if (!this.chains.includes(chain)) this.chains.push(chain);
      const cols = this.columnsOf(target);
      if (cols && !this.hasColumn(cols, parts[k]!, quoted[k]!)) {
        const close = closestNames(parts[k]!, cols);
        const table = qualifiedName(findTable(this.input.snapshot!.tables, target.table)!);
        this.fail(
          "unknown_column",
          `${text}: "${parts[k]}" is not a column of ${table}, the table of model ${target.model} that ${chain} reaches; ${closeNote(close)}`,
          `Write ${chain}.<column> with ${close.length ? `one of ${close.join(", ")}` : `a column of ${table}`}, or, if the column is new, run sl introspect --source ${this.input.source.source} and check the rule again.`,
        );
      }
      return;
    }
  }
}

// The count query's two columns: the rows the rule matches (a filter is true, a dimension expr is
// not null) and every row the rule is read over.
function counts(dialect: SourceConfig["dialect"], kind: RuleKind, rule: string): string[] {
  const e = embed(rule);
  const matched =
    kind === "dimension_expr"
      ? `count(${e})`
      : COMPILER_DIALECTS.includes(dialect)
        ? `count(*) filter (where ${e})`
        : `coalesce(sum(case when ${e} then 1 else 0 end), 0)`;
  return [`  ${matched} as ${quoteIdent(dialect, "rows_matched")}`, `  count(*) as ${quoteIdent(dialect, "rows_total")}`];
}

// Whether a rule is expressible on a model, and the plan of its count query when it is.
export function checkRule(input: RuleInput): RuleCheck {
  const { source, model, kind, text } = input;
  const base: RuleBase = { source: source.source, model: model.model, kind, rule: text };
  const c = new Checker(input);
  const steps = [() => c.shape(text), () => c.subquery(text), () => c.aggregate(text), () => c.names(text)];
  for (const step of steps) if (!c.problem) step();
  let sql = "";
  let joins: PlannedJoin[] = [];
  if (!c.problem) {
    const ref = `${model.model} rule`;
    const plan = new JoinPlan({
      source: source.source,
      dialect: source.dialect,
      models: input.models,
      snapshot: input.snapshot,
      base: model,
      qualified: readsJoin(text, model),
      add: (code, message, _ref, next) =>
        c.fail(
          code === "join_fans_out" ? "join_fans_out" : "invalid_layer",
          message,
          next?.replace(/run sl sql again\.$/, "run sl check-rule again.") ?? "Run sl validate and fix what it reports, then run sl check-rule again.",
        ),
    });
    const rule = plan.sql(text, plan.base, ref);
    sql = ["select", counts(source.dialect, kind, rule).join(",\n"), ...plan.from()].join("\n");
    joins = plan.joins;
    if (!c.problem) {
      try {
        const root = input.root;
        assertReadOnly(sql, root ? { globAllowed: (p) => globInsideViews(root, source, p) } : {});
      } catch (e) {
        c.fail("not_read_only", `the count query is not read-only (${(e as Error).message})`, "A rule is one read-only SQL expression; remove what the check names and run sl check-rule again.");
      }
    }
  }
  if (c.problem) return { ...base, expressible: false, ...c.problem };
  const plan: QueryPlan = {
    command: "check-rule",
    source: source.source,
    dialect: source.dialect,
    // The id carries a hash of the SQL, so a results file stored for one rule never answers another.
    queries: [{ id: `${RULE_QUERY_PREFIX}${model.model}:${createHash("sha256").update(sql).digest("hex").slice(0, 8)}`, purpose: `Rows of ${model.model} the ${kind === "filter" ? "filter matches" : "expr is not null on"}`, sql, max_rows: 2 }],
  };
  return { ...base, expressible: true, joins_used: c.chains, joins, sql, plan };
}

// rows_matched and rows_total from the count query's one row.
export function ruleCounts(rows: ResultRows | undefined, id: string): { rows_matched: number; rows_total: number } {
  const row = rows?.[0];
  if (!row || rows!.length !== 1) throw new Error(`the result of ${id} must be one row; it has ${rows?.length ?? 0}`);
  const num = (k: string) => {
    const v = row[k];
    const n = typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${k} in the result of ${id} is ${JSON.stringify(typeof v === "bigint" ? String(v) : v)}, not a count`);
    return n;
  };
  const out = { rows_matched: num("rows_matched"), rows_total: num("rows_total") };
  if (out.rows_matched > out.rows_total) throw new Error(`rows_matched (${out.rows_matched}) is above rows_total (${out.rows_total}) in the result of ${id}`);
  return out;
}

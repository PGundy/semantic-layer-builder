// Row filters in a compiled query (references/spec.md, Row filters and Reference compiler): the
// predicate that limits a model's rows for the user, built from the row filters lib/access.ts
// evaluates for them. Every user attribute is a bound parameter, never SQL text; a branch that lacks
// an attribute contributes no rows, and a model of which the user sees no rows reads false.
import type { ExprFilterResult, HierarchyFilterResult, ModelRows } from "../access.ts";
import { quoteIdent, quoteTable } from "../dialect.ts";
import { codeOnly, sqlTextProblem, USER_PLACEHOLDER } from "../sql-text.ts";
import type { Dialect, Model } from "../types.ts";
import type { Instance, JoinPlan } from "./joins.ts";
import { embed, type Params } from "./sql.ts";

// A row filter the query applies: on its base model in WHERE, or in the ON clause of the join that
// reaches its model.
export interface AppliedRows {
  model: string;
  alias: string;
  in: "where" | "on";
  roles: string[]; // the held roles whose row filters limit the model
  rows: "filtered" | "none";
}

export interface RowFilterContext {
  source: string;
  dialect: Dialect;
  models: Model[];
  params: Params;
  plan: () => JoinPlan;
  add: (code: "invalid_request" | "invalid_layer", message: string, ref?: string, next?: string) => void;
}

const FIX_ACCESS = "Fix the row filter in access.yaml, run sl validate, and run sl sql again.";

// Why a row filter's text cannot be applied, or undefined (lib/sql-text.ts): it closes every string,
// name, comment and parenthesis it opens, so it stays inside the compiler's (...) and ANDs with the
// rest of the query, and holds no parameter marker, semicolon or placeholder written against a name
// or a digit. sl validate reports the same problems.
export const rowFilterTextProblem = (text: string): string | undefined => sqlTextProblem(text, "row filter");

const scalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

// An expr row filter with each {{ user.<attribute> }} replaced by bound parameters: one for a single
// value, and one per element for a list, which follows IN: inside parentheses (kept bare when the
// expr already writes them). Undefined, with a refusal, when the text cannot be applied
// (rowFilterTextProblem), a placeholder sits inside a string or a comment, a list is not read by
// IN, or a value is neither a single value nor a list of them.
function bindExpr(f: ExprFilterResult, cx: RowFilterContext, what: string): string | undefined {
  const problem = rowFilterTextProblem(f.expr);
  if (problem) {
    cx.add("invalid_layer", `${what} ${problem}`, undefined, FIX_ACCESS);
    return undefined;
  }
  const code = codeOnly(f.expr)!.code;
  const read = [...code.matchAll(USER_PLACEHOLDER)];
  if (read.length !== [...f.expr.matchAll(USER_PLACEHOLDER)].length) {
    cx.add(
      "invalid_layer",
      `${what} has a {{ user.<attribute> }} inside a string or a comment, where it cannot be bound as a parameter`,
      undefined,
      `Write the placeholder outside quotes (region = {{ user.region }}, not '{{ user.region }}'). ${FIX_ACCESS}`,
    );
    return undefined;
  }
  let out = "";
  let at = 0;
  for (const m of read) {
    const name = m[1]!;
    const value = f.params[name];
    const list = Array.isArray(value);
    if (!(list ? value.every(scalar) : scalar(value))) {
      cx.add("invalid_request", `user.${name} is ${list ? "a list holding a list or an object" : "an object"}; a row filter binds a text, a number, true or false, or a list of them`);
      return undefined;
    }
    const start = m.index!;
    const end = start + m[0].length;
    const before = /\bin\s*(\(\s*)?$/i.exec(code.slice(0, start));
    if (list && !before) {
      cx.add(
        "invalid_layer",
        `${what} reads the list user.${name} outside IN; a list attribute binds one parameter per element, so it is read only as <column> in {{ user.${name} }}`,
        undefined,
        FIX_ACCESS,
      );
      return undefined;
    }
    const inParens = !!before?.[1] && /^\s*\)/.test(code.slice(end));
    const each = list ? value.map((v) => cx.params.add(v)).join(", ") : cx.params.add(value);
    out += f.expr.slice(at, start) + (list && !inParens ? `(${each})` : each);
    at = end;
  }
  return out + f.expr.slice(at);
}

// A hierarchy row filter: the column equals the user's id (with include_self) or is a member below
// them in the closure model, read without its own row filters; the id is bound once per use.
function hierarchy(f: HierarchyFilterResult, inst: Instance, cx: RowFilterContext, what: string): string | undefined {
  const plan = cx.plan();
  const [viaSource, viaModel] = f.via.split(".");
  const via = viaSource === cx.source ? cx.models.find((m) => m.model === viaModel) : undefined;
  if (!via) {
    cx.add("invalid_layer", `${what} reads ${f.via}, which is not a model of source ${cx.source}; the closure model must be in the filtered model's source`, undefined, FIX_ACCESS);
    return undefined;
  }
  const id = f.user_value;
  if (!((typeof id === "number" && Number.isFinite(id)) || (typeof id === "string" && id.trim()))) {
    const shown = typeof id === "string" ? "empty text" : JSON.stringify(id);
    cx.add("invalid_request", `user.${f.user} is ${shown}; ${what} binds one id, a number or a text`, undefined, `Pass the user's id as a number or a text in --user, and run sl sql again.`);
    return undefined;
  }
  const q = (s: string) => quoteIdent(cx.dialect, s);
  const column = plan.sql(f.column, inst, what);
  const self = f.include_self ? `${column} = ${cx.params.add(f.user_value)} or ` : "";
  const v = q(via.model);
  const members = `select ${v}.${q(plan.keyColumn(via, f.member))} from ${quoteTable(cx.dialect, plan.table(via).ref)} as ${v} where ${v}.${q(plan.keyColumn(via, f.manager))} = ${cx.params.add(f.user_value)}`;
  return `(${self}${column} in (${members}))`;
}

// The predicate that limits inst's rows for the user: the OR of each held role's branch, a branch the
// AND of its filters; false when no branch has rows. Undefined when every row is visible or a filter
// is refused.
export function rowsPredicate(rows: ModelRows, inst: Instance, cx: RowFilterContext): string | undefined {
  if (rows.rows === "all") return undefined;
  const branches: string[] = [];
  let refused = false;
  for (const b of rows.branches) {
    if (b.no_rows) continue;
    const what = `role ${b.role}'s row filter on ${cx.source}.${inst.model.model}`;
    const parts = b.filters.map((f) => {
      if (f.kind === "hierarchy") return hierarchy(f, inst, cx, what);
      const bound = bindExpr(f, cx, what);
      if (bound === undefined) return undefined;
      const sql = cx.plan().sql(bound, inst, what);
      const e = embed(sql);
      return e === sql ? `(${sql})` : e;
    });
    if (parts.some((p) => p === undefined)) refused = true;
    else branches.push(parts.length > 1 ? `(${parts.join(" and ")})` : parts[0]!);
  }
  if (refused) return undefined;
  if (!branches.length) return "false";
  return branches.length > 1 ? `(${branches.join(" or ")})` : branches[0]!;
}

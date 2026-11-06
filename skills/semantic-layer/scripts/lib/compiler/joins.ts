// The joins of a compiled query (references/spec.md, Reference compiler): the to-one path a request
// takes to another model's fields, and the definition joins a field's expr or filter reads through.
import { quoteIdent, quoteTable } from "../dialect.ts";
import { findTable, splitQualified } from "../naming.ts";
import type { Dialect, Join, Model, Snapshot } from "../types.ts";
import { columnRefs, rewriteRefs } from "./qualify.ts";

// A model as it appears in the query, under its own alias: the base model is its model name, a
// model a request reaches is the path from the base (orders.customer), and a definition join is its
// owner's alias, ~ and the join chain (orders~test_account, refunds~order.test_account).
export interface Instance {
  alias: string;
  model: Model;
}

export interface PlannedJoin {
  alias: string;
  via: string; // model.join, the declared join this hop follows
  model: string;
  type: "left" | "inner";
  for: "request" | "definition";
}

export type JoinRefusalCode = "invalid_layer" | "no_join_path" | "ambiguous_join_path" | "join_fans_out";

export interface JoinContext {
  source: string;
  dialect: Dialect;
  models: Model[];
  snapshot?: Snapshot | null;
  base: Model;
  // false when the query reads one table: exprs then stay exactly as written.
  qualified: boolean;
  add: (code: JoinRefusalCode, message: string, ref?: string, next?: string) => void;
}

const TO_ONE = ["many_to_one", "one_to_one"];
const toOne = (j: Join) => TO_ONE.includes(j.relationship);
const sameName = (name: string, quoted: boolean) => (j: Join) => (quoted ? j.name === name : j.name.toLowerCase() === name.toLowerCase());
const keySig = (keys: { from: string; to: string }[]) => JSON.stringify(keys.map((k) => [k.from, k.to]));

// Whether a model's expr or filter reads a join reference, <join>.<column> or <join>.<join>.<column>.
export function readsJoin(text: string, model: Model): boolean {
  const joins = model.joins ?? [];
  return columnRefs(text).some((r) => r.parts.length > 1 && joins.some(sameName(r.parts[0]!, r.quoted[0]!)));
}

// Why a to-one join's current evidence says it fans out, or undefined when it does not (or the
// evidence was measured for another target or other keys, which sl validate reports as stale).
function fanOut(j: Join): { why: string; bridge: boolean } | undefined {
  const ev = j.evidence;
  if (!ev || (ev.to !== undefined && ev.to !== j.to) || (Array.isArray(ev.keys) && keySig(ev.keys) !== keySig(j.keys))) return undefined;
  if (ev.suggested_relationship === "many_to_many") return { why: "neither side's key is unique (many_to_many)", bridge: true };
  const why = [
    ev.right_key_unique === false ? `the key of ${j.to} is not unique` : "",
    typeof ev.max_fanout === "number" && ev.max_fanout > 1 ? `a row matches up to ${ev.max_fanout} rows of ${j.to}` : "",
  ].filter(Boolean);
  return why.length ? { why: why.join(" and "), bridge: false } : undefined;
}

export class JoinPlan {
  readonly joins: PlannedJoin[] = [];
  readonly reached: Instance[] = []; // models a request reaches through a path, for their row filters
  readonly base: Instance;
  private readonly lines: string[] = [];
  private readonly instances = new Map<string, Instance>();
  private readonly paths = new Map<string, Instance | undefined>();

  constructor(private readonly cx: JoinContext) {
    this.base = { alias: cx.base.model, model: cx.base };
  }

  private model(name: string): Model | undefined {
    return this.cx.models.find((m) => m.model === name);
  }

  private table(model: Model): { ref: { schema?: string | null; name: string }; columns?: string[] } {
    const t = this.cx.snapshot ? findTable(this.cx.snapshot.tables, model.table) : undefined;
    return t ? { ref: { schema: t.schema, name: t.name }, ...(t.columns.length ? { columns: t.columns.map((c) => c.name) } : {}) } : { ref: splitQualified(model.table) };
  }

  // A key column as the snapshot spells it, when the snapshot has the table.
  private keyColumn(model: Model, name: string): string {
    const cols = this.table(model).columns ?? [];
    return cols.find((c) => c === name) ?? cols.find((c) => c.toLowerCase() === name.toLowerCase()) ?? name;
  }

  // The instance one hop from owner through j, adding its join to the query the first time.
  private hop(owner: Instance, j: Join, alias: string, purpose: PlannedJoin["for"], ref: string): Instance | undefined {
    const known = this.instances.get(alias);
    if (known) return known;
    const { add, dialect, source } = this.cx;
    const target = this.model(j.to);
    const via = `${owner.model.model}.${j.name}`;
    if (!target) {
      add("invalid_layer", `join ${via} goes to ${j.to}, which is not a model of source ${source}; run sl validate`, ref);
      return undefined;
    }
    if (!toOne(j)) {
      add("invalid_layer", `${ref} reads through join ${via}, which is ${j.relationship}; a join reference reads only through many_to_one and one_to_one joins; run sl validate`, ref);
      return undefined;
    }
    const fan = fanOut(j);
    if (fan && (fan.bridge || !(typeof j.fanout_override === "string" && j.fanout_override.trim()))) {
      const check = `sl check-join --source ${source} --model ${owner.model.model} --join ${j.name}`;
      add(
        "join_fans_out",
        fan.bridge
          ? `join ${via} is ${j.relationship}, but its evidence shows ${fan.why}, so it repeats rows of ${owner.model.model} and needs a bridge table whatever fanout_override says`
          : `join ${via} is ${j.relationship}, but its evidence shows fan-out (${fan.why}), so it would repeat rows of ${owner.model.model} and multiply its measures`,
        ref,
        fan.bridge
          ? `Ask the owner for a bridge table or a view with one row per ${owner.model.model} row, model it, and run sl sql again.`
          : `Measure the join again with ${check}; fix its keys or relationship, or record why the owner accepts the data in fanout_override, then run sl sql again.`,
      );
      return undefined;
    }
    const inst = { alias, model: target };
    this.instances.set(alias, inst);
    const type = j.type === "inner" ? "inner" : "left";
    this.joins.push({ alias, via, model: target.model, type, for: purpose });
    const q = (s: string) => quoteIdent(dialect, s);
    const on = j.keys.map((k) => `${q(owner.alias)}.${q(this.keyColumn(owner.model, k.from))} = ${q(alias)}.${q(this.keyColumn(target, k.to))}`);
    this.lines.push(`${type} join ${quoteTable(dialect, this.table(target).ref)} as ${q(alias)} on ${on.join(" and ")}`);
    if (purpose === "request") this.reached.push(inst);
    return inst;
  }

  // The instance of another model a request field reaches: the shortest unique path of to-one
  // joins from the base model, at most two hops. Refuses a tie, a path that would fan out and none.
  requestPath(target: Model, ref: string): Instance | undefined {
    if (target === this.cx.base) return this.base;
    if (this.paths.has(target.model)) return this.paths.get(target.model);
    const base = this.cx.base;
    const routes = (ok: (j: Join) => boolean): Join[][] => {
      const own = (base.joins ?? []).filter(ok);
      const one = own.filter((j) => j.to === target.model).map((j) => [j]);
      if (one.length) return one;
      return own
        .filter((j) => j.to !== base.model)
        .flatMap((j1) => (this.model(j1.to)?.joins ?? []).filter((j2) => ok(j2) && j2.to === target.model).map((j2) => [j1, j2]));
    };
    const name = (r: Join[]) => [base.model, ...r.map((j) => j.name)].join(".");
    const lead = `${ref} is on model ${target.model}, which a request on ${base.model}`;
    const found = routes(toOne);
    let inst: Instance | undefined;
    if (found.length === 1) {
      let at: Instance | undefined = this.base;
      for (const [k, j] of found[0]!.entries()) at = at && this.hop(at, j, name(found[0]!.slice(0, k + 1)), "request", ref);
      inst = at;
    } else if (found.length > 1) {
      const n = found[0]!.length;
      this.cx.add(
        "ambiguous_join_path",
        `${lead} reaches by ${found.length} paths of ${n === 1 ? "one join" : "two joins"} each, ${found.map(name).join(" and ")}, so the request does not say which it means`,
        ref,
        `Ask the owner which path the figure means, then add a dimension to ${base.model} that reads the field through that join (as ${found[0]!.map((j) => j.name).join(".")}.<column>) or a join to ${base.model} that reaches ${target.model} directly, and run sl sql again.`,
      );
    } else {
      const fanning = routes(() => true);
      const many = fanning.length ? fanning[0]!.find((j) => !toOne(j)) : undefined;
      this.cx.add(
        "no_join_path",
        many
          ? `${lead} reaches only through join ${fanning[0]!.indexOf(many) ? `${fanning[0]![0]!.to}.${many.name}` : `${base.model}.${many.name}`}, which is ${many.relationship}: it would repeat rows of ${base.model} and multiply its measures (fan-out)`
          : `${lead} reaches through no many_to_one or one_to_one join within two hops`,
        ref,
        many
          ? `Ask the owner for a view with one row per ${base.model} row that holds the field, model it, and run sl sql again.`
          : `Add a many_to_one or one_to_one join from ${base.model} toward ${target.model} (sl check-join measures it), or ask the owner for a view; then run sl sql again.`,
      );
    }
    this.paths.set(target.model, inst);
    return inst;
  }

  // A layer expr or filter of inst's model as the query reads it: each own column under inst's
  // alias and each join reference under its definition join, added once per chain.
  sql(text: string, inst: Instance, ref: string): string {
    if (!this.cx.qualified) return text;
    const q = (s: string) => quoteIdent(this.cx.dialect, s);
    const refs = columnRefs(text, this.table(inst.model).columns);
    let failed = false;
    const out = rewriteRefs(text, refs, (r) => {
      const as = (from: number) => r.parts.slice(from).map((p, k) => (r.quoted[from + k] ? q(p) : p)).join(".");
      const first = r.parts.length > 1 ? (inst.model.joins ?? []).find(sameName(r.parts[0]!, r.quoted[0]!)) : undefined;
      if (!first) return `${q(inst.alias)}.${as(0)}`;
      const second = r.parts.length > 2 ? (this.model(first.to)?.joins ?? []).find(sameName(r.parts[1]!, r.quoted[1]!)) : undefined;
      const chain = second ? [first, second] : [first];
      let at: Instance | undefined = inst;
      for (const [k, j] of chain.entries()) at = at && this.hop(at, j, `${inst.alias}~${chain.slice(0, k + 1).map((c) => c.name).join(".")}`, "definition", ref);
      if (!at) failed = true;
      return at ? `${q(at.alias)}.${as(chain.length)}` : undefined;
    });
    return failed ? text : out;
  }

  // FROM and its joins, in the order the query first needs them.
  from(): string[] {
    const t = quoteTable(this.cx.dialect, this.table(this.cx.base).ref);
    return [this.cx.qualified ? `from ${t} as ${quoteIdent(this.cx.dialect, this.base.alias)}` : `from ${t}`, ...this.lines];
  }
}

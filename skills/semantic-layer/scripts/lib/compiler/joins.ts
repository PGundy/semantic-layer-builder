// The joins of a compiled query (references/spec.md, Reference compiler): the to-one path a request
// takes to another model's fields, the bridge join a request groups through (bridge.ts), and the
// definition joins a field's expr or filter reads through.
import { quoteIdent, quoteTable } from "../dialect.ts";
import { findTable, splitQualified } from "../naming.ts";
import { addPairCommand, type CrossSchemaPair, crossSchemaLevel, schemaJoin, UNDECLARED_GRACE_ENDS, undeclaredJoinText } from "../schema-scope.ts";
import { joinLegs, type Leg } from "../through.ts";
import type { Dialect, Join, Model, Snapshot } from "../types.ts";
import { type BridgeRoute, bridgeSelect } from "./bridge.ts";
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
  part?: string; // in a metric, the model of the part (CTE) that joins it
  // A bridge join's two joins: its bridge subselect, then its target. Either makes the result
  // many-valued: a row of the base model appears once per target value.
  through?: "bridge" | "target";
}

export type JoinRefusalCode =
  | "invalid_layer"
  | "not_visible"
  | "no_join_path"
  | "ambiguous_join_path"
  | "join_fans_out"
  | "scope.cross_schema_undeclared"
  | "join.through_second_path";

// What a compiled query reports without refusing it.
export interface CompileWarning {
  code: "scope.cross_schema_undeclared";
  message: string;
}

export interface JoinContext {
  source: string;
  dialect: Dialect;
  models: Model[];
  snapshot?: Snapshot | null;
  // The source's declared schema pairs: a join across schemas follows only an approved pair's keys
  // (spec: Schema scope). Left out, joins across schemas are not checked.
  pairs?: readonly CrossSchemaPair[];
  // A join's status for the pair check, by its "model.join" name; the join's own status when left out.
  joinStatus?: (via: string) => unknown;
  base: Model;
  // false when the query reads one table: exprs then stay exactly as written.
  qualified: boolean;
  add: (code: JoinRefusalCode, message: string, ref?: string, next?: string) => void;
  // The user's row filter on a model a request path reaches, for that join's ON clause (rowfilters.ts).
  restrict?: (inst: Instance) => string | undefined;
  // Why the user may not see a model (the access evaluator's reasons), or undefined when they may:
  // a request through a bridge the user may not see is refused.
  hidden?: (model: Model) => string[] | undefined;
}

// One join of the query. A request path's row filter that reads through joins nests them inside it,
// so its ON clause can read them and a left join still keeps the rows it does not match.
interface JoinLine {
  type: "left" | "inner";
  table: string;
  alias: string;
  on: string;
  nest: JoinLine[];
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
// evidence was measured for another target or other keys, which semlayer validate reports as stale).
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
  readonly base: Instance;
  private readonly lines: JoinLine[] = [];
  // Set while a request path's row filter is compiled: the joins it reads through go inside it.
  private nest: JoinLine[] | undefined;
  private readonly instances = new Map<string, Instance>();
  private readonly paths = new Map<string, Instance | undefined>();
  // The bridge join the query groups through, once a request field reaches its target.
  through: BridgeRoute | undefined;

  constructor(private readonly cx: JoinContext) {
    this.base = { alias: cx.base.model, model: cx.base };
  }

  private model(name: string): Model | undefined {
    return this.cx.models.find((m) => m.model === name);
  }

  table(model: Model): { ref: { schema?: string | null; name: string }; columns?: string[] } {
    const t = this.cx.snapshot ? findTable(this.cx.snapshot.tables, model.table) : undefined;
    return t ? { ref: { schema: t.schema, name: t.name }, ...(t.columns.length ? { columns: t.columns.map((c) => c.name) } : {}) } : { ref: splitQualified(model.table) };
  }

  // A key column as the snapshot spells it, when the snapshot has the table.
  keyColumn(model: Model, name: string): string {
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
      add("invalid_layer", `join ${via} goes to ${j.to}, which is not a model of source ${source}; run semlayer validate`, ref);
      return undefined;
    }
    if (this.undeclared(owner.model, target, j.keys, j, via, ref)) return undefined;
    if (!toOne(j)) {
      add(
        "invalid_layer",
        j.through
          ? `${ref} reads through the bridge join ${via}; a join reference reads only through many_to_one and one_to_one joins, and a figure is grouped by a bridge's target only as a request dimension; run semlayer validate`
          : `${ref} reads through join ${via}, which is ${j.relationship}; a join reference reads only through many_to_one and one_to_one joins; run semlayer validate`,
        ref,
      );
      return undefined;
    }
    const fan = fanOut(j);
    if (fan && (fan.bridge || !(typeof j.fanout_override === "string" && j.fanout_override.trim()))) {
      const check = `semlayer check-join --source ${source} --model ${owner.model.model} --join ${j.name}`;
      add(
        "join_fans_out",
        fan.bridge
          ? `join ${via} is ${j.relationship}, but its evidence shows ${fan.why}, so it repeats rows of ${owner.model.model} and needs a bridge table whatever fanout_override says`
          : `join ${via} is ${j.relationship}, but its evidence shows fan-out (${fan.why}), so it would repeat rows of ${owner.model.model} and multiply its measures`,
        ref,
        fan.bridge
          ? `Ask the owner for a bridge table or a view with one row per ${owner.model.model} row, model it, and run semlayer sql again.`
          : `Measure the join again with ${check}; fix its keys or relationship, or record why the owner accepts the data in fanout_override, then run semlayer sql again.`,
      );
      return undefined;
    }
    const inst = { alias, model: target };
    this.instances.set(alias, inst);
    const type = j.type === "inner" ? "inner" : "left";
    this.joins.push({ alias, via, model: target.model, type, for: purpose });
    const q = (s: string) => quoteIdent(dialect, s);
    const on = j.keys.map((k) => `${q(owner.alias)}.${q(this.keyColumn(owner.model, k.from))} = ${q(alias)}.${q(this.keyColumn(target, k.to))}`);
    const line: JoinLine = { type, table: quoteTable(dialect, this.table(target).ref), alias, on: on.join(" and "), nest: [] };
    (this.nest ?? this.lines).push(line);
    if (purpose === "request") {
      this.nest = line.nest;
      const rows = this.cx.restrict?.(inst);
      this.nest = undefined;
      if (rows) line.on += ` and ${rows}`;
    }
    return inst;
  }

  // Whether a hop from one model to another on these keys crosses schemas that no approved pair
  // declares; when it does, the refusal is added.
  private undeclared(from: Model, to: Model, keys: Leg["keys"], j: Join, via: string, ref: string): boolean {
    const scope = this.cx.pairs && schemaJoin(this.cx.snapshot, from.table, to.table, keys);
    if (!scope || crossSchemaLevel(this.cx.pairs!, scope, this.cx.joinStatus ? this.cx.joinStatus(via) : j.status) !== "error") return false;
    this.cx.add(
      "scope.cross_schema_undeclared",
      `${ref} reads through join ${via}, which ${undeclaredJoinText(scope)}`,
      ref,
      `Ask the owner whether the layer joins these schemas; if yes, record the pair with ${addPairCommand(this.cx.source, scope, this.cx.pairs)}, read it back and approve it on their yes, then run semlayer sql again.`,
    );
    return true;
  }

  // The paths from the base model to target of at most two joins that pass ok, the shortest first.
  private routes(target: Model, ok: (j: Join) => boolean): Join[][] {
    const base = this.cx.base;
    const own = (base.joins ?? []).filter(ok);
    const one = own.filter((j) => j.to === target.model).map((j) => [j]);
    if (one.length) return one;
    return own
      .filter((j) => j.to !== base.model)
      .flatMap((j1) => (this.model(j1.to)?.joins ?? []).filter((j2) => ok(j2) && j2.to === target.model).map((j2) => [j1, j2]));
  }

  // The bridge joins of the base model straight to target.
  private bridges(target: Model): Join[] {
    return (this.cx.base.joins ?? []).filter((j) => !!j.through && j.to === target.model);
  }

  // The bridge join ("model.join") a request field of this model is reached through, when the base
  // reaches the model by no to-one path and by one bridge join; it adds nothing to the query.
  bridgeJoin(model: string): string | undefined {
    const target = this.model(model);
    if (!target || target === this.cx.base || this.routes(target, toOne).length) return undefined;
    const b = this.bridges(target);
    return b.length === 1 ? `${this.cx.base.model}.${b[0]!.name}` : undefined;
  }

  // The instance of another model a request field reaches: the shortest unique path of to-one
  // joins from the base model, at most two hops, or else the one bridge join of the base model
  // straight to it. Refuses a tie, a path that would fan out and none.
  requestPath(target: Model, ref: string): Instance | undefined {
    if (target === this.cx.base) return this.base;
    if (this.paths.has(target.model)) return this.paths.get(target.model);
    const base = this.cx.base;
    const routes = (ok: (j: Join) => boolean): Join[][] => this.routes(target, ok);
    const name = (r: Join[]) => [base.model, ...r.map((j) => j.name)].join(".");
    const lead = `${ref} is on model ${target.model}, which a request on ${base.model}`;
    const found = routes(toOne);
    const bridged = found.length ? [] : this.bridges(target);
    let inst: Instance | undefined;
    if (bridged.length === 1) inst = this.bridgeHop(bridged[0]!, ref);
    else if (bridged.length > 1) {
      this.cx.add(
        "ambiguous_join_path",
        `${lead} reaches through ${bridged.length} bridge joins, ${bridged.map((j) => name([j])).join(" and ")}, so the request does not say which it means`,
        ref,
        `Ask the owner which bridge the figure means, remove the other join with semlayer remove-join or ask for a view, and run semlayer sql again.`,
      );
    } else if (found.length === 1) {
      let at: Instance | undefined = this.base;
      for (const [k, j] of found[0]!.entries()) at = at && this.hop(at, j, name(found[0]!.slice(0, k + 1)), "request", ref);
      inst = at;
    } else if (found.length > 1) {
      const n = found[0]!.length;
      this.cx.add(
        "ambiguous_join_path",
        `${lead} reaches by ${found.length} paths of ${n === 1 ? "one join" : "two joins"} each, ${found.map(name).join(" and ")}, so the request does not say which it means`,
        ref,
        `Ask the owner which path the figure means, then add a dimension to ${base.model} that reads the field through that join (as ${found[0]!.map((j) => j.name).join(".")}.<column>) or a join to ${base.model} that reaches ${target.model} directly, and run semlayer sql again.`,
      );
    } else {
      const fanning = routes(() => true);
      const many = fanning.length ? fanning[0]!.find((j) => !toOne(j)) : undefined;
      const via = many && fanning[0]!.indexOf(many) ? `${fanning[0]![0]!.to}.${many.name}` : `${base.model}.${many?.name}`;
      this.cx.add(
        "no_join_path",
        many?.through
          ? `${lead} reaches only through the bridge join ${via} (by way of ${many.through.model}) and another join; the compiler follows a bridge join only from the request's own model straight to its target`
          : many
          ? `${lead} reaches only through join ${fanning[0]!.indexOf(many) ? `${fanning[0]![0]!.to}.${many.name}` : `${base.model}.${many.name}`}, which is ${many.relationship}: it would repeat rows of ${base.model} and multiply its measures (fan-out)`
          : `${lead} reaches through no many_to_one or one_to_one join within two hops`,
        ref,
        many?.through
          ? `Ask the owner for a view with one row per ${base.model} row that holds the field, or for a bridge join from ${base.model} straight to ${target.model} (semlayer add-bridge), and run semlayer sql again.`
          : many
          ? `Ask the owner for a view with one row per ${base.model} row that holds the field, model it, and run semlayer sql again.`
          : `Add a many_to_one or one_to_one join from ${base.model} toward ${target.model} (semlayer check-join measures it), or ask the owner for a view; then run semlayer sql again.`,
      );
    }
    this.paths.set(target.model, inst);
    return inst;
  }

  // The target of a bridge join of the base model, adding its two joins the first time: the bridge
  // as a subselect of one row per pair (bridge.ts), with the user's row filter on the bridge inside
  // it, then the target, with theirs in its ON clause. Both take the join's type. Each hop obeys the
  // schema-pair rule as a join of its own. Refuses a second bridge, a bridge the user may not see and
  // a join without its dedupe rule.
  private bridgeHop(j: Join, ref: string): Instance | undefined {
    const { add, dialect, source } = this.cx;
    const base = this.cx.base;
    const via = `${base.model}.${j.name}`;
    const alias = via;
    const known = this.instances.get(alias);
    if (known) return known;
    if (this.through) {
      add(
        "join.through_second_path",
        `${ref} is on model ${j.to}, which a request on ${base.model} reaches through the bridge join ${via}, but the request already groups through the bridge join ${this.through.via}; grouping by two bridges would count a row of ${base.model} once for each pair of their values`,
        ref,
        `Ask for the figures by one bridge at a time, in a request each, and run semlayer sql again.`,
      );
      return undefined;
    }
    const t = j.through!;
    const bridge = this.model(t.model);
    const target = this.model(j.to);
    const throughKeys = Array.isArray(t.keys) ? t.keys : [];
    if (!bridge || !target || !throughKeys.length) {
      add(
        "invalid_layer",
        !throughKeys.length && bridge && target
          ? `bridge join ${via} has no through.keys pairing ${bridge.model} with ${target.model}; run semlayer validate`
          : `bridge join ${via} names ${!bridge ? `the bridge ${t.model}` : `the target ${j.to}`}, which is not a model of source ${source}; run semlayer validate`,
        ref,
      );
      return undefined;
    }
    if (!t.dedupe || (t.dedupe === "weight" && !t.weight)) {
      add(
        "invalid_layer",
        `bridge join ${via} has ${t.dedupe ? "dedupe weight but no weight column" : "no dedupe rule"}, so the compiler does not know how the figure of one row of ${base.model} is shared among its rows of ${target.model}`,
        ref,
        `Ask the owner how a figure is shared (distinct_pairs, equal_split or weight), remove the join with semlayer remove-join and add it again with semlayer add-bridge --dedupe <rule>, read it back and approve it on their yes, then run semlayer sql again.`,
      );
      return undefined;
    }
    const why = this.cx.hidden?.(bridge);
    if (why) {
      add(
        "not_visible",
        `${ref} is on model ${target.model}, which a request on ${base.model} reaches through the bridge ${bridge.model}, which this user may not see (${why.join(", ")})`,
        ref,
        `Ask the owner whether this user may see ${bridge.model} (semlayer access shows why not), or leave the ${target.model} fields out of the request, and run semlayer sql again.`,
      );
      return undefined;
    }
    const legs = joinLegs(base, j);
    const hops: [Model, Model][] = [[base, bridge], [bridge, target]];
    if (legs.some((leg, k) => this.undeclared(hops[k]![0], hops[k]![1], leg.keys, j, via, ref))) return undefined;

    const q = (s: string) => quoteIdent(dialect, s);
    const type = j.type === "inner" ? "inner" : "left";
    const bAlias = `${alias} bridge`;
    const bInst = { alias: bAlias, model: bridge };
    this.instances.set(bAlias, bInst);
    // The user's row filter on the bridge, and the definition joins it reads, go inside the subselect.
    const nested: JoinLine[] = [];
    this.nest = nested;
    const rows = this.cx.restrict?.(bInst);
    this.nest = undefined;
    const table = bridgeSelect({
      dialect,
      table: quoteTable(dialect, this.table(bridge).ref),
      alias: bAlias,
      factColumns: j.keys.map((k) => this.keyColumn(bridge, k.to)),
      targetColumns: throughKeys.map((k) => this.keyColumn(bridge, k.from)),
      dedupe: t.dedupe,
      ...(t.weight ? { weight: this.keyColumn(bridge, t.weight) } : {}),
      joins: nested.map((l) => this.line(l)),
      ...(rows ? { where: rows } : {}),
    });
    const bOn = j.keys.map((k) => `${q(base.model)}.${q(this.keyColumn(base, k.from))} = ${q(bAlias)}.${q(this.keyColumn(bridge, k.to))}`);
    this.lines.push({ type, table, alias: bAlias, on: bOn.join(" and "), nest: [] });
    this.joins.push({ alias: bAlias, via, model: bridge.model, type, for: "request", through: "bridge" });

    const inst = { alias, model: target };
    this.instances.set(alias, inst);
    const on = throughKeys.map((k) => `${q(bAlias)}.${q(this.keyColumn(bridge, k.from))} = ${q(alias)}.${q(this.keyColumn(target, k.to))}`);
    const line: JoinLine = { type, table: quoteTable(dialect, this.table(target).ref), alias, on: on.join(" and "), nest: [] };
    this.lines.push(line);
    this.joins.push({ alias, via, model: target.model, type, for: "request", through: "target" });
    this.nest = line.nest;
    const targetRows = this.cx.restrict?.(inst);
    this.nest = undefined;
    if (targetRows) line.on += ` and ${targetRows}`;
    this.through = { via, alias: bAlias, bridge: bridge.model, target: target.model, dedupe: t.dedupe };
    return inst;
  }

  // One join line as the query writes it; a request path's row filter joins nest inside it.
  private line(j: JoinLine): string {
    const q = (s: string) => quoteIdent(this.cx.dialect, s);
    return j.nest.length
      ? `${j.type} join (${j.table} as ${q(j.alias)}\n  ${j.nest.map((n) => this.line(n)).join("\n  ")}) on ${j.on}`
      : `${j.type} join ${j.table} as ${q(j.alias)} on ${j.on}`;
  }

  // A layer expr or filter of inst's model as the query reads it: each own column under inst's
  // alias and each join reference under its definition join, added once per chain. Inside a request
  // path's row filter the definition joins are its own, inst's alias, ~row_filter~ and the chain.
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
      const owner = this.nest ? `${inst.alias}~row_filter` : inst.alias;
      for (const [k, j] of chain.entries()) at = at && this.hop(at, j, `${owner}~${chain.slice(0, k + 1).map((c) => c.name).join(".")}`, "definition", ref);
      if (!at) failed = true;
      return at ? `${q(at.alias)}.${as(chain.length)}` : undefined;
    });
    return failed ? text : out;
  }

  // FROM and its joins, in the order the query first needs them.
  from(): string[] {
    const t = quoteTable(this.cx.dialect, this.table(this.cx.base).ref);
    const q = (s: string) => quoteIdent(this.cx.dialect, s);
    return [this.cx.qualified ? `from ${t} as ${q(this.base.alias)}` : `from ${t}`, ...this.lines.map((l) => this.line(l))];
  }
}

// The warnings of the joins a compiled query adds: a join across schemas that no approved pair
// declares, which compiles only because it was approved before pairs existed, until the grace ends.
export function joinWarnings(cx: Pick<JoinContext, "source" | "models" | "snapshot" | "pairs" | "joinStatus">, joins: readonly PlannedJoin[]): CompileWarning[] {
  const out: CompileWarning[] = [];
  for (const planned of joins) {
    const dot = planned.via.indexOf(".");
    const owner = cx.models.find((m) => m.model === planned.via.slice(0, dot));
    const j = owner?.joins?.find((x) => x.name === planned.via.slice(dot + 1));
    // A bridge join's two joins are two hops, each checked as a join of its own.
    const leg = owner && j ? joinLegs(owner, j)[planned.through === "target" ? 1 : 0] : undefined;
    const from = leg && cx.models.find((m) => m.model === leg.from);
    const target = leg && cx.models.find((m) => m.model === leg.to);
    const scope = cx.pairs && leg && from && target ? schemaJoin(cx.snapshot, from.table, target.table, leg.keys) : undefined;
    if (!scope || crossSchemaLevel(cx.pairs!, scope, cx.joinStatus ? cx.joinStatus(planned.via) : j!.status) !== "warning") continue;
    const message =
      `join ${planned.via} ${undeclaredJoinText(scope)}; it compiles only because it was approved before schema pairs were checked, and from semlayer ${UNDECLARED_GRACE_ENDS} it is refused. ` +
      `Ask the owner whether the layer joins these schemas; if yes, record the pair with ${addPairCommand(cx.source, scope, cx.pairs)}, read it back and approve it on their yes`;
    if (!out.some((w) => w.message === message)) out.push({ code: "scope.cross_schema_undeclared", message });
  }
  return out;
}

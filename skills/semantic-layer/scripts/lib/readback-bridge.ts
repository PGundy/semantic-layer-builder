// A bridge join in plain words (spec: Bridges and multi-fact requests): what it links and by which
// columns, the owner's dedupe rule and what it means for a figure, that totals by the target can add up
// to more than the overall total, and the counts semlayer check-join measured on the bridge. The
// readback, check-join's report and the join.through_facts_unbridged warning all use these words.
import { type JoinFinding, nounForms } from "./joins.ts";
import { plainText } from "./output.ts";
import type { ThroughEvidence } from "./sql/through-check.ts";
import { parseRequestField } from "./refs.ts";
import type { Join, JoinKey, Model, QueryRequest } from "./types.ts";

const flat = (v: unknown) => plainText(String(v)).replace(/\s+/g, " ").trim();
const num = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const pairs = (v: unknown): JoinKey[] => (Array.isArray(v) ? v.filter((k) => k && typeof k === "object" && typeof k.from === "string" && typeof k.to === "string") : []);
const on = (a: string, b: string, keys: JoinKey[]) => (keys.length ? keys.map((k) => `${a}.${flat(k.from)} = ${b}.${flat(k.to)}`).join(" and ") : "no keys yet");

// The names a bridge join's words use: the models as they are named, and the fact and target as nouns
// ("an order", "orders"; "a tag", "tags").
function names(from: string, j: Join) {
  const fact = flat(from);
  const target = flat(j.to);
  const f = nounForms(fact);
  const t = nounForms(target);
  return { fact, bridge: flat(j.through?.model), target, aFact: `${article(f.one)} ${f.one}`, facts: f.many, oneTarget: t.one, targets: t.many };
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

// What a dedupe rule does to a figure, and what totals by the target add up to under it.
export function dedupeWords(from: string, j: Join): string[] {
  const { bridge, aFact, facts, oneTarget, targets } = names(from, j);
  const t = j.through;
  const several = `${aFact} with several ${targets}`;
  const overlap = `Totals by ${oneTarget} can add up to more than the overall total: ${several} counts in full under each of them, while the overall total counts it once.`;
  const split = (how: string) => [
    `${how} so its shares add up to its figure once.`,
    `Totals by ${oneTarget} add up to the overall total of the ${facts} that have ${article(oneTarget)} ${oneTarget}; without this rule they could add up to more than it, since ${several} would count in full under each.`,
  ];
  switch (t?.dedupe) {
    case "distinct_pairs":
      return [`Dedupe rule: distinct_pairs. Each (${nounForms(flat(from)).one}, ${oneTarget}) pair counts once, however many times ${bridge} lists it, so ${several} adds its whole figure to each of them.`, overlap];
    case "equal_split":
      return split(`Dedupe rule: equal_split. ${cap(aFact)} with n ${targets} gives each 1/n of its figure,`);
    case "weight":
      return split(`Dedupe rule: weight, by ${bridge}.${flat(t.weight)}. ${cap(aFact)} gives each of its ${targets} a share of its figure in proportion to ${bridge}.${flat(t.weight)},`);
    default:
      return [`No dedupe rule yet: the owner has not said how a figure is shared among the ${targets} of one ${nounForms(flat(from)).one}.`, overlap];
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const has = (n: number) => `${num(n)} ${n === 1 ? "has" : "have"}`;
const verb = (n: number, v: string) => `${num(n)} ${n === 1 ? `${v}s` : v}`;

// The definition of a bridge join: its three models, both key pairs, what happens to a row without a
// bridge row, and the rule.
export function bridgeDefinition(from: string, j: Join): string[] {
  const { fact, bridge, target, aFact, targets } = names(from, j);
  const kept = (j.type ?? "left") === "left" ? `${aFact} without one is kept, with the ${target} columns empty` : `${aFact} without one is left out`;
  return [
    `Links each row of ${fact} to rows of ${target} through the bridge ${bridge}: ${on(fact, bridge, pairs(j.keys))}, then ${on(bridge, target, pairs(j.through?.keys))}.`,
    `${cap(aFact)} can have several ${targets}, or none; ${kept}.`,
    ...dedupeWords(from, j),
  ];
}

export function bridgeSql(from: string, j: Join): string {
  const { fact, bridge, target } = names(from, j);
  const t = j.through;
  return `join ${flat(j.name)}: ${on(fact, bridge, pairs(j.keys))}, then ${on(bridge, target, pairs(t?.keys))} (one_to_many through ${bridge}, dedupe ${flat(t?.dedupe ?? "not set")}${t?.weight ? ` by ${flat(t.weight)}` : ""}, ${j.type ?? "left"} join)`;
}

// What happens to a figure of a row with no bridge row, by the join's type.
function unbridgedWords(j: Join, oneTarget: string, n: number): string {
  const them = n === 1 ? "it" : "them";
  return (j.type ?? "left") === "left" ? `a figure grouped by ${oneTarget} shows ${them} under an empty ${oneTarget}` : `a figure grouped by ${oneTarget} leaves ${them} out`;
}

// The measured counts of the bridge, as lines without a leading dash.
export function throughLines(from: string, j: Join, ev: ThroughEvidence): string[] {
  const { fact, bridge, target, facts, oneTarget } = names(from, j);
  const rows = (n: number) => `${num(n)} ${n === 1 ? "row" : "rows"}`;
  return [
    `Of ${num(ev.fact_rows)} ${facts} (rows of ${fact}), ${has(ev.facts_one_value)} one ${oneTarget}, ${has(ev.facts_many_values)} several (at most ${num(ev.max_values_per_fact)}), and ${has(ev.facts_unbridged)} none` +
      (ev.facts_unbridged ? `, so ${unbridgedWords(j, oneTarget, ev.facts_unbridged)}.` : "."),
    `${bridge} has ${rows(ev.bridge_rows)}: ${verb(ev.duplicate_rows, "repeat")} a pair already listed${ev.duplicate_rows && j.through?.dedupe === "distinct_pairs" ? `, and ${ev.duplicate_rows === 1 ? "counts" : "count"} once` : ""}; ` +
      `${verb(ev.rows_without_fact, "name")} no row of ${fact} and ${num(ev.rows_without_target)} no row of ${target}.`,
  ];
}

// check-join's sentence on a bridge join: what the bridge holds and that the rule shares a figure.
export function throughSentence(from: string, j: Join, ev: ThroughEvidence): string {
  const { aFact, targets } = names(from, j);
  const rule = j.through?.dedupe ? `the dedupe rule ${j.through.dedupe} says how its figure is shared among them` : "the owner's dedupe rule, not yet given, will say how its figure is shared among them";
  return `${cap(aFact)} has up to ${num(ev.max_values_per_fact)} ${targets} through ${flat(j.through?.model)}, and ${rule}.`;
}

// Whether the evidence measured the bridge and keys the join now names.
export function throughCurrent(j: Join, ev: ThroughEvidence): boolean {
  const k = (keys: unknown) => JSON.stringify(pairs(keys).map((x) => [x.from, x.to]));
  return ev.model === j.through?.model && k(ev.keys) === k(j.through?.keys);
}

// The warning of join.through_facts_unbridged, and check-join's finding of the same.
export function unbridgedText(from: string, j: Join, ev: ThroughEvidence): string {
  const { fact, bridge, oneTarget, targets } = names(from, j);
  return `${num(ev.facts_unbridged)} of ${num(ev.fact_rows)} rows of ${fact} have no ${targets} in ${bridge}, so ${unbridgedWords(j, oneTarget, ev.facts_unbridged)}; ask the owner whether that is expected, and say why in the join's description`;
}

// check-join's findings on a bridge: rows with no bridge row, and bridge rows that name nothing.
export function throughFindings(from: string, j: Join, ev: ThroughEvidence): JoinFinding[] {
  const { fact, bridge, target } = names(from, j);
  const out: JoinFinding[] = [];
  if (ev.facts_unbridged) out.push({ level: "warn", message: `${unbridgedText(from, j, ev)}.` });
  if (ev.rows_without_fact || ev.rows_without_target)
    out.push({ level: "warn", message: `${num(ev.rows_without_fact)} ${bridge} rows name no ${fact} row and ${num(ev.rows_without_target)} name no ${target} row; ask the owner whether ${bridge} keeps rows the other tables have lost.` });
  if (ev.duplicate_rows) out.push({ level: "info", message: `${num(ev.duplicate_rows)} ${bridge} rows repeat a pair; the dedupe rule decides how they count.` });
  return out;
}

// A golden's request grouped by a field of a bridge join's target, in words: for each bridge join of the
// request's model to a model it groups by, the join and what its dedupe rule does to the figures.
export function goldenBridgeWords(request: Pick<QueryRequest, "measures" | "dimensions">, lookup: (model: string) => Model | undefined): string[] {
  const model = (ref: unknown) => (typeof ref === "string" ? parseRequestField(ref)?.model : undefined);
  const measures = Array.isArray(request.measures) ? request.measures : [];
  const base = measures.map(model).find((m) => m !== undefined);
  const from = base ? lookup(base) : undefined;
  if (!from) return [];
  const grouped = new Set((Array.isArray(request.dimensions) ? request.dimensions : []).map(model));
  return (Array.isArray(from.joins) ? from.joins : [])
    .filter((j) => j?.through && grouped.has(j.to))
    .map((j) => `- Grouped through the bridge join ${flat(from.model)}.${flat(j.name)}: ${dedupeWords(from.model, j).join(" ")}`);
}

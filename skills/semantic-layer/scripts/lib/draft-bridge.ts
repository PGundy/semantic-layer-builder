// A drafted bridge (spec: Bridges and multi-fact requests): a table that only links two other tables
// (order_tags between orders and tags) already drafts as a model with a many-to-one join to each side.
// This proposes the join an owner would ask for next, from one side to the other through that model,
// as a draft with no dedupe rule: how a figure is shared among the far side's values is the owner's
// choice, and semlayer next asks it.
import { classifyType, isNumeric } from "./column-types.ts";
import { findTable, qualifiedName, toSpecName } from "./naming.ts";
import { type CrossSchemaPair, crossSchemaLevel, schemaJoin } from "./schema-scope.ts";
import type { Join, Model, Snapshot, SnapshotTable } from "./types.ts";

// Names that mark a table as a link between two others (mapping, xref, closure, ...); lib/baseline.ts
// classes such a table bridge by the same pattern.
export const BRIDGE_SUFFIX = /_(map|mapping|link|links|xref|bridge|closure|assignments?)$/;

// A number a link table may carry beside its keys: a weight the owner could use for the dedupe rule.
// Any other number (a discount, a line number) makes the table a fact.
const WEIGHT_NAME = /(^|_)(weight|share|ratio|fraction|proportion)$/;

export interface BridgeProposal {
  // The model the join is added to.
  model: string;
  join: Join;
  // The open question the model gets: which direction was chosen and the command for the other.
  question: string;
}

export interface BridgeContext {
  snapshot: Snapshot;
  // Every model of the source: the existing ones and those drafted in this run.
  models: readonly Model[];
  // Names of the models drafted in this run: the join is added to one of these only.
  drafted: ReadonlySet<string>;
  pairs: readonly CrossSchemaPair[];
  // True when the column's name selects a measure rule (it is a figure, not a link or a weight).
  measureLike: (column: string) => boolean;
}

const lower = (x: string) => x.toLowerCase();

// The bridge proposal for a drafted model, or undefined when the evidence is not structural and
// unambiguous. All of these hold:
// - the model has exactly two joins, both many-to-one to different models other than itself, and the
//   table has no other id-named column or declared foreign key;
// - the table is a link: only id columns, or a link-table name, or at most two extra columns that are
//   dates, times or weight-named numbers (an order_items table with a quantity or a discount is a
//   fact, not a bridge);
// - both models exist (drafted now or earlier) and at least one is drafted in this run, because the
//   join is written on a model this run writes;
// - each hop obeys the schema-pair rule (a hop across schemas needs an approved pair).
// Which side carries the join cannot be known from structure: the drafted side with more rows in the
// snapshot does (a null count is the smallest), ties by model name, and the model's open question
// names the command for the other direction.
export function proposeBridge(bridge: Model, table: SnapshotTable, ctx: BridgeContext): BridgeProposal | undefined {
  const joins = bridge.joins ?? [];
  if (joins.length !== 2 || joins.some((j) => j.through || j.relationship !== "many_to_one")) return undefined;
  const [a, b] = joins as [Join, Join];
  if (a.to === b.to || a.to === bridge.model || b.to === bridge.model) return undefined;
  const sides = [a, b].map((j) => ({ join: j, model: ctx.models.find((m) => m.model === j.to), key: j.keys }));
  if (sides.some((s) => !s.model || s.model.table === bridge.table || !s.key.length)) return undefined;

  const keyed = new Set(joins.flatMap((j) => j.keys.map((k) => lower(k.from))));
  const extra = table.columns.filter((c) => !keyed.has(lower(c.name)));
  if (extra.some((c) => /_id$/.test(toSpecName(c.name)))) return undefined;
  if ((table.foreign_keys ?? []).some((fk) => !fk.columns.every((c) => keyed.has(lower(c))))) return undefined;
  const link =
    !extra.length ||
    (BRIDGE_SUFFIX.test(lower(table.name)) && !extra.some((c) => ctx.measureLike(c.name))) ||
    (extra.length <= 2 && extra.every((c) => ["date", "timestamp", "time"].includes(classifyType(c.type)) || (isNumeric(classifyType(c.type)) && WEIGHT_NAME.test(toSpecName(c.name)))));
  if (!link) return undefined;

  const found = sides.map((s) => ({ ...s, table: findTable(ctx.snapshot.tables, String(s.model!.table)) }));
  if (found.some((s) => !s.table)) return undefined;
  for (const s of found) {
    const shape = schemaJoin(ctx.snapshot, qualifiedName(table), qualifiedName(s.table!), s.join.keys);
    if (shape && crossSchemaLevel(ctx.pairs, shape, "draft")) return undefined;
  }

  const rows = (s: (typeof found)[number]) => s.table!.row_count ?? -1;
  const candidates = found.filter((s) => ctx.drafted.has(s.model!.model));
  if (!candidates.length) return undefined;
  const fact = [...candidates].sort((x, y) => rows(y) - rows(x) || (x.model!.model < y.model!.model ? -1 : x.model!.model > y.model!.model ? 1 : 0))[0]!;
  const far = found.find((s) => s !== fact)!;

  // Fact -> bridge reverses the bridge's join to the fact; bridge -> far is the bridge's join to the far side.
  const keys = fact.join.keys.map((k) => ({ from: k.to, to: k.from }));
  const taken = new Set([...fact.model!.dimensions, ...fact.model!.measures, ...(fact.model!.joins ?? [])].map((f) => f.name));
  const stem = far.join.name;
  const name = [stem, `${stem}_through_${bridge.model}`].find((n) => !taken.has(n));
  if (!name) return undefined;
  const origin = a.origin === "declared" && b.origin === "declared" ? "declared" : "inferred";
  const join: Join = {
    name,
    to: far.model!.model,
    keys,
    relationship: "one_to_many",
    origin,
    through: { model: bridge.model, keys: far.join.keys.map((k) => ({ from: k.from, to: k.to })) },
    status: "draft",
  };
  // The other direction: the far model's keys to the bridge, then the bridge's keys to the fact model.
  const back = far.join.keys.map((k) => `${k.to}=${k.from}`).join(",");
  const onward = fact.join.keys.map((k) => `${k.from}=${k.to}`).join(",");
  const why =
    rows(fact) > rows(far)
      ? "it has more rows"
      : candidates.length === 1
        ? `${far.model!.model} is already modeled and this draft writes only ${fact.model!.model}`
        : "it has the earlier name among equals";
  const question =
    `${bridge.model} links ${fact.model!.model} and ${far.model!.model}, so the draft adds the bridge join ${name} from ${fact.model!.model} to ${far.model!.model} through ${bridge.model}, with no dedupe rule yet (semlayer next asks it). ` +
    `${fact.model!.model} carries it because ${why}; ` +
    `for ${far.model!.model} to reach ${fact.model!.model} instead, run semlayer add-bridge --source ${bridge.source} --model ${far.model!.model} --name ${fact.join.name} --to ${fact.model!.model} --through ${bridge.model} ` +
    `--keys ${back} --through-keys ${onward}.`;
  return { model: fact.model!.model, join, question };
}

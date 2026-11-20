// A bridge join (spec: Bridges and multi-fact requests): a join with `through` reaches its target by
// way of a bridge model that holds one row per (row, target) pair, as order_tags does for orders and
// tags. The join's own keys pair the model with the bridge; `through.keys` pair the bridge with the
// target. The dedupe rule is the owner's choice of how a figure is shared among the target values of
// one row.
import type { Join, JoinKey, Model } from "./types.ts";

export const DEDUPE_RULES = ["distinct_pairs", "equal_split", "weight"] as const;
export type Dedupe = (typeof DEDUPE_RULES)[number];

export interface Through {
  // The bridge model, a model of the same source.
  model: string;
  // Bridge column = target column.
  keys: JoinKey[];
  // Unset while the join is a draft; an approved bridge join has one.
  dedupe?: Dedupe;
  // The bridge column dedupe weight shares by.
  weight?: string;
}

// One hop of a join, as two models and the column pairs between them.
export interface Leg {
  from: string;
  to: string;
  keys: readonly JoinKey[];
}

// The hops a join makes: one for an ordinary join, two for a bridge join (the model to the bridge on
// the join's keys, the bridge to the target on through.keys). Validation and the add commands check
// each hop as a join, so a hop that crosses schemas obeys the same schema-pair rule.
export function joinLegs(model: Pick<Model, "model">, join: Pick<Join, "to" | "keys" | "through">): Leg[] {
  const t = join.through;
  if (!t || typeof t.model !== "string") return [{ from: model.model, to: join.to, keys: join.keys }];
  return [
    { from: model.model, to: t.model, keys: join.keys },
    { from: t.model, to: join.to, keys: Array.isArray(t.keys) ? t.keys : [] },
  ];
}

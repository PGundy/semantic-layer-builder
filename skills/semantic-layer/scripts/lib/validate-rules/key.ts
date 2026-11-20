// A primary_key the stored data shows is not unique is a warning (spec: Validation): a one-column key
// whose whole-table profile has fewer distinct values than rows, and a bridge model whose two-column key
// repeats a pair in its bridge join's evidence. No query runs; the stored profile and evidence are read.
import { keyRepeats } from "../key-uniqueness.ts";
import type { RuleContext } from "./index.ts";

export default function key(ctx: RuleContext): void {
  for (const [source, models] of ctx.models) {
    const all = [...models.values()].map((m) => m.data);
    for (const m of models.values()) {
      const model = m.data;
      if (!Array.isArray(model.primary_key) || !model.primary_key.length || typeof model.table !== "string") continue;
      const fact = keyRepeats(model, ctx.snapshotTable(source, model.table).table, ctx.identRules(source).dialect, all);
      if (!fact) continue;
      ctx.warn(
        m.file,
        "primary_key",
        `the primary_key ${JSON.stringify(model.primary_key)} of ${source}.${model.model} is not unique: ${fact}. ` +
          `Ask the owner whether it is the right key; correct it with semlayer set ${source}.${model.model} primary_key '[<columns>]', or leave it and say in the model's grain that rows repeat`,
        "model.primary_key_not_unique",
        `semlayer set ${source}.${model.model} primary_key`,
      );
    }
  }
}

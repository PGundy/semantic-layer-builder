// Bridge joins (spec: Bridges and multi-fact requests): the bridge of a `through` join is a third model
// of the source, its key and weight columns are columns of the tables in the snapshot, the weight is
// numeric and goes with dedupe weight, and an approved bridge join has a dedupe rule; a bridge whose
// evidence shows rows of the model with no bridge row is a warning. The schema-pair rule for the join's
// two hops is in scope.ts.
import { classifyType, isNumeric } from "../column-types.ts";
import { unbridgedText } from "../readback-bridge.ts";
import type { Join, SnapshotTable } from "../types.ts";
import type { RuleContext } from "./index.ts";

const hasColumn = (table: SnapshotTable, name: string) => table.columns.some((c) => c.name === name || c.name.toLowerCase() === name.toLowerCase());

export default function join(ctx: RuleContext): void {
  for (const [source, models] of ctx.models) {
    for (const m of models.values()) {
      const model = m.data;
      if (!Array.isArray(model.joins)) continue;
      model.joins.forEach((j, i) => {
        const t = j?.through;
        if (!t || typeof t !== "object") return;
        const at = `joins[${i}].through`;
        const ref = `${source}.${model.model}.${j.name}`;
        if (j.relationship !== "one_to_many")
          ctx.error(
            m.file,
            `joins[${i}].relationship`,
            `${ref} goes through a bridge, so its relationship is one_to_many, not ${j.relationship}; remove it (semlayer remove-join --source ${source} --model ${model.model} --name ${j.name}) and add it again with semlayer add-bridge`,
            "join.through_relationship_invalid",
          );
        const bridge = typeof t.model === "string" ? models.get(t.model)?.data : undefined;
        if (!bridge || t.model === model.model || t.model === j.to) {
          ctx.error(
            m.file,
            `${at}.model`,
            `the bridge "${t.model}" of ${ref} is not a third model of source ${source}, so there is nothing to join through; draft the bridge table (semlayer draft --source ${source} --tables <table>) and ` +
              `add the join again with semlayer add-bridge, or remove it with semlayer remove-join --source ${source} --model ${model.model} --name ${j.name}`,
            "join.through_bridge_unknown",
          );
          return;
        }
        const target = models.get(j.to)?.data;
        const bridgeTable = typeof bridge.table === "string" ? ctx.snapshotTable(source, bridge.table).table : undefined;
        const targetTable = target && typeof target.table === "string" ? ctx.snapshotTable(source, target.table).table : undefined;
        const missing = (path: string, what: string, table: SnapshotTable | undefined, column: unknown, model: string) => {
          if (table?.columns.length && typeof column === "string" && !hasColumn(table, column))
            ctx.error(
              m.file,
              path,
              `"${column}" is not a column of ${table.name} (${what} ${model}) in the snapshot; fix it with semlayer remove-join and semlayer add-bridge, or run semlayer introspect --source ${source} if the table changed`,
              "join.through_columns_missing",
            );
        };
        (Array.isArray(t.keys) ? t.keys : []).forEach((k, ki) => {
          missing(`${at}.keys[${ki}].from`, "the bridge", bridgeTable, k?.from, bridge.model);
          if (target) missing(`${at}.keys[${ki}].to`, "the target", targetTable, k?.to, target.model);
        });
        if (t.weight !== undefined) missing(`${at}.weight`, "the bridge", bridgeTable, t.weight, bridge.model);

        if (j.status === "approved" && t.dedupe === undefined)
          ctx.error(
            m.file,
            `${at}.dedupe`,
            `${ref} is approved but has no dedupe rule: the owner has not said how a figure is shared among the ${j.to} values of one ${model.model} row. ` +
              `Ask them (distinct_pairs, equal_split or weight), remove the join (semlayer remove-join) and add it again with semlayer add-bridge --dedupe <rule>, then read it back and approve it on their yes`,
            "join.through_dedupe_missing",
          );
        const weightColumn = typeof t.weight === "string" ? bridgeTable?.columns.find((c) => c.name.toLowerCase() === t.weight!.toLowerCase()) : undefined;
        const ev = j.evidence?.through;
        if (ev && typeof ev === "object" && typeof ev.facts_unbridged === "number" && ev.facts_unbridged > 0)
          ctx.warn(m.file, `joins[${i}].evidence.through.facts_unbridged`, unbridgedText(model.model, j as Join, ev), "join.through_facts_unbridged");
        if (t.dedupe === "weight" && t.weight === undefined)
          ctx.error(m.file, `${at}.weight`, `${ref} shares by weight but names no weight column of ${bridge.model}; add the join again with semlayer add-bridge --dedupe weight --weight <column>`, "join.through_weight_invalid");
        else if (t.weight !== undefined && t.dedupe !== "weight")
          ctx.error(m.file, `${at}.weight`, `${ref} names a weight column but its dedupe rule is ${t.dedupe ?? "not set"}; a weight goes only with dedupe weight`, "join.through_weight_invalid");
        else if (weightColumn && !isNumeric(classifyType(String(weightColumn.type))))
          ctx.error(m.file, `${at}.weight`, `the weight column ${weightColumn.name} of ${bridge.model} is ${weightColumn.type}, not a number, so it cannot share a figure`, "join.through_weight_invalid");
      });
    }
  }
}

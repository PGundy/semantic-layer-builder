// Bridge joins (spec: Bridges and multi-fact requests): the bridge of a `through` join is a third model
// of the source, its key and weight columns are columns of the tables in the snapshot, the weight is
// numeric and goes with dedupe weight, and an approved bridge join has a dedupe rule; a bridge whose
// evidence shows rows of the model with no bridge row is a warning. The schema-pair rule for the join's
// two hops is in scope.ts. A dimension's conforms_to names a dimension of another model of the source,
// of the same type (a time dimension with a grain in common), that conforms to nothing itself, and that
// no other dimension of its model conforms to; the two models' schemas obey the schema-pair rule, and
// two time zones are a warning (lib/conformed.ts).
import { classifyType, isNumeric } from "../column-types.ts";
import { conformedSchemas, conformTarget, zoneClash } from "../conformed.ts";
import { crossSchemaPairs } from "../schema-scope.ts";
import { itemHash } from "../approval-hash.ts";
import { throughCurrent, throughLines, unbridgedWarning } from "../readback-bridge.ts";
import { type Dimension, type Join, type Model, type SnapshotTable, TIME_GRAINS } from "../types.ts";
import type { RuleContext } from "./index.ts";

const hasColumn = (table: SnapshotTable, name: string) => table.columns.some((c) => c.name === name || c.name.toLowerCase() === name.toLowerCase());

export default function join(ctx: RuleContext): void {
  conformed(ctx);
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
        // The evidence is outside the approval hash, so an approved join is settled only when its approval is
        // current and the readback the owner said yes to stated the count that is stored now.
        if (ev && typeof ev === "object" && typeof ev.facts_unbridged === "number" && ev.facts_unbridged > 0) {
          const hash = itemHash("join", j as unknown as Record<string, unknown>, { source, model: model as unknown as Record<string, unknown> });
          const seen = j.status === "approved" && j.approved_hash === hash ? ctx.yesReadbackText(ref, hash) : undefined;
          const settled = !!seen && throughCurrent(j as Join, ev) && seen.includes(throughLines(model.model, j as Join, ev)[0]!);
          if (!settled) ctx.warn(m.file, `joins[${i}].evidence.through.facts_unbridged`, unbridgedWarning(model.model, ref, j as Join, ev), "join.through_facts_unbridged");
        }
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

const grainsOf = (d: Dimension): readonly string[] => (Array.isArray(d.time_grains) ? d.time_grains : TIME_GRAINS);

function conformed(ctx: RuleContext): void {
  for (const [source, models] of ctx.models) {
    const pairs = crossSchemaPairs(ctx.sources.get(source)?.data ?? {});
    const snapshot = ctx.snapshots.get(source);
    for (const m of models.values()) {
      const model = m.data;
      if (!Array.isArray(model.dimensions)) continue;
      model.dimensions.forEach((d, i) => {
        if (typeof d?.conforms_to !== "string") return;
        const path = `dimensions[${i}].conforms_to`;
        const ref = `${source}.${model.model}.${d.name}`;
        const remove = `semlayer set ${ref} conforms_to --unset`;
        const t = conformTarget(d);
        const other = t && t.model !== model.model ? (models.get(t.model)?.data as Model | undefined) : undefined;
        const target = other?.dimensions?.find((x) => x?.name === t!.name);
        if (!target) {
          ctx.error(
            m.file,
            path,
            `${ref} conforms to ${d.conforms_to}, which is not a dimension of another model of source ${source}; name one as <model>.<dimension> with semlayer conform --source ${source} --dimension ${model.model}.${d.name} --to <model>.<dimension>, or remove it with ${remove}`,
            "join.conformed_target_unknown",
          );
          return;
        }
        const named = `${t!.model}.${t!.name}`;
        if (d.type !== target.type || (d.type === "time" && !grainsOf(d).some((g) => grainsOf(target).includes(g))))
          ctx.error(
            m.file,
            path,
            d.type !== target.type
              ? `${ref} is a ${d.type} dimension and conforms to ${named}, a ${target.type} one, so the two cannot group as one column; conform it to a ${d.type} dimension, or remove it with ${remove}`
              : `${ref} conforms to ${named}, but they have no time grain in common (${grainsOf(d).join(", ")} against ${grainsOf(target).join(", ")}); add a common grain with semlayer set ${ref} time_grains, or remove it with ${remove}`,
            "join.conformed_type_mismatch",
          );
        if (conformTarget(target))
          ctx.error(
            m.file,
            path,
            `${ref} conforms to ${named}, which itself conforms to ${target.conforms_to}; conforms_to is one hop: conform ${model.model}.${d.name} to the dimension both mean, or remove it with ${remove}`,
            "join.conformed_chain",
          );
        const twin = model.dimensions!.slice(0, i).find((x) => typeof x?.conforms_to === "string" && x.conforms_to.trim() === d.conforms_to!.trim());
        if (twin)
          ctx.error(
            m.file,
            path,
            `${ref} and ${source}.${model.model}.${twin.name} both conform to ${named}, so a request grouped by it could group ${model.model} by either; keep one and remove the other with ${remove}`,
            "join.conformed_ambiguous",
          );
        const zones = zoneClash(d, target);
        if (zones)
          ctx.warn(
            m.file,
            path,
            `${ref} is stored in time zone ${zones[0]} and ${named} in ${zones[1]}, so a day of one is not a day of the other; semlayer sql refuses a request that combines them. ` +
              `Make both count days in one zone and record it with semlayer set, or remove conforms_to with ${remove}`,
            "join.conformed_time_zone",
          );
        const schemas = snapshot?.valid ? conformedSchemas(snapshot.data, pairs, model, other!) : undefined;
        if (schemas)
          ctx.error(
            m.file,
            path,
            `${ref} conforms to ${named}, but ${model.model} is in schema ${schemas[0]} and ${t!.model} in ${schemas[1]}, and no approved schema pair joins them; ask the owner whether the layer joins these schemas ` +
              `(semlayer add-cross-schema --source ${source} --from ${schemas[0]} --to ${schemas[1]} --keys <table>.<column>=<table>.<column>, then read it back and approve it on their yes), or remove it with ${remove}`,
            "join.conformed_cross_schema",
          );
      });
    }
  }
}

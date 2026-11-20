// Schema scope (spec: Schema scope): a join leaves its model's schema only on the keys of an approved
// schema pair, every key of a pair is in the snapshot, the primary schema is one the source reads, and
// an approved pair is crossed by some join.
import { intakeSchemas } from "../intake.ts";
import { crossSchemaPairs, findPair, keyProblem, pairAllowed, pairApproved, toolVersion, undeclaredApprovedLevel } from "../schema-scope.ts";
import type { Join, Model } from "../types.ts";
import type { RuleContext } from "./index.ts";

export default function scope(ctx: RuleContext): void {
  for (const [name, loaded] of ctx.sources) {
    if (!loaded.valid) continue;
    const source = loaded.data;
    const file = loaded.file;
    const pairs = crossSchemaPairs(source);

    const primary = source.intake?.primary;
    let listed: string[] = [];
    try {
      listed = intakeSchemas(source);
    } catch {
      // A malformed list is reported by the intake checks.
    }
    if (typeof primary === "string" && listed.length && !listed.includes(primary)) {
      ctx.error(
        file,
        "intake.primary",
        `the primary schema ${primary} is not among the schemas read (${listed.join(", ")}); run semlayer setup --source ${name} --dialect ${source.dialect} with --schemas ${[...listed, primary].join(",")}, or with --primary set to one of them`,
        "scope.primary_not_in_schemas",
      );
    }

    const snapshot = ctx.snapshots.get(name);
    if (snapshot?.valid) {
      pairs.forEach((pair, i) => {
        (pair.keys ?? []).forEach((key, k) => {
          const problem = keyProblem(snapshot.data, pair, key);
          if (problem)
            ctx.error(
              file,
              `cross_schema[${i}].keys[${k}]`,
              `${problem}; run semlayer introspect --source ${name} if the catalog changed, or remove the key with semlayer remove-cross-schema --source ${name} --from ${pair.from} --to ${pair.to} --keys ${key.from}=${key.to}`,
              "scope.key_not_in_snapshot",
            );
        });
      });
    }

    const crossed = new Set<string>();
    for (const m of ctx.models.get(name)?.values() ?? []) {
      const model = m.data;
      if (typeof model.table !== "string" || !Array.isArray(model.joins)) continue;
      const near = ctx.snapshotTable(name, model.table).table;
      const nearSchema = near?.schema;
      if (!near || typeof nearSchema !== "string") continue;
      model.joins.forEach((join, i) => {
        if (!join || typeof join !== "object" || !Array.isArray(join.keys)) return;
        const target = ctx.models.get(name)?.get(join.to)?.data;
        const far = target && typeof target.table === "string" ? ctx.snapshotTable(name, target.table).table : undefined;
        const farSchema = far?.schema;
        if (!far || typeof farSchema !== "string" || farSchema === nearSchema) return;
        const keys = join.keys.filter((k) => k && typeof k.from === "string" && typeof k.to === "string");
        const shape = { fromSchema: nearSchema, fromTable: near.name, toSchema: farSchema, toTable: far.name, keys };
        const pair = findPair(pairs, nearSchema, farSchema);
        if (pairAllowed(pairs, shape)) {
          crossed.add(`${pair!.from}\u0000${pair!.to}`);
          return;
        }
        const message = undeclaredMessage(name, model, join, shape);
        if (join.status === "approved" && undeclaredApprovedLevel(toolVersion()) === "warning") ctx.warn(m.file, `joins[${i}]`, message, "scope.cross_schema_undeclared");
        else ctx.error(m.file, `joins[${i}]`, message, "scope.cross_schema_undeclared");
      });
    }

    pairs.forEach((pair, i) => {
      if (pairApproved(pair) && !crossed.has(`${pair.from}\u0000${pair.to}`))
        ctx.warn(
          file,
          `cross_schema[${i}]`,
          `the approved pair ${pair.from} -> ${pair.to} is crossed by no join; add the join with semlayer add-join, or remove the pair with semlayer remove-cross-schema --source ${name} --from ${pair.from} --to ${pair.to}`,
          "scope.pair_unused",
        );
    });
  }
}

// One message whatever the pair's state, so recording or approving a pair is never refused for
// changing the words of an error it leaves standing.
function undeclaredMessage(
  source: string,
  model: Model,
  join: Join,
  shape: { fromSchema: string; fromTable: string; toSchema: string; toTable: string; keys: readonly { from: string; to: string }[] },
): string {
  const keys = shape.keys.map((k) => `${shape.fromTable}.${k.from}=${shape.toTable}.${k.to}`).join(",");
  return (
    `joins ${shape.fromSchema}.${shape.fromTable} to ${shape.toSchema}.${shape.toTable} across schemas, and no approved schema pair declares these keys. ` +
    `Ask the owner whether the layer joins these schemas: record the pair with semlayer add-cross-schema --source ${source} --from ${shape.fromSchema} --to ${shape.toSchema} --keys ${keys}, ` +
    `read it back and approve it on their yes, or remove the join with semlayer remove-join --source ${source} --model ${model.model} --name ${join.name}`
  );
}

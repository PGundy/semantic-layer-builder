import type { CommandSpec } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { checkRule, type Expressible, type RuleKind, ruleCounts } from "../lib/compiler/check-rule.ts";
import { UserError } from "../lib/errors.ts";
import { pct } from "../lib/joins.ts";
import { columnRefs } from "../lib/compiler/qualify.ts";
import { formatJson, plainText, protectedNames, protectedResultColumns } from "../lib/output.ts";
import { emitPlan, executePlan, resultsInput } from "../lib/plan.ts";
import { listModels, loadModel, loadSnapshot, loadSource } from "../lib/project.ts";
import { NAME_PATTERN } from "../lib/types.ts";

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

// Where an expressible rule goes next: a measure's filter or a dimension's expr, after a readback.
function nextStep(r: Expressible): string {
  const [key, field] = r.kind === "filter" ? ["filter", "<measure>"] : ["expr", "<dimension>"];
  return (
    `Put it on a field with sl set ${r.source}.${r.model}.${field} ${key} ${quote(r.rule)}, read it back to the owner, ` +
    "and approve it only after they say yes."
  );
}

const spec: CommandSpec = {
  summary: "Check whether the layer can express a filter or dimension expr on a model, and count the rows it matches.",
  usage:
    "check-rule --source <s> --model <m> (--filter <expr> | --dimension-expr <expr>) [--emit-sql | --results <file> | --plan <plan_id>]   " +
    "(a rule reads the model's own columns and join references of one or two to-one hops; writes no file but the plan --emit-sql stores)",
  options: {
    source: { type: "string" },
    model: { type: "string" },
    filter: { type: "string" },
    "dimension-expr": { type: "string" },
    "emit-sql": { type: "boolean" },
    results: { type: "string" },
    plan: { type: "string" },
  },
  async run({ values }, ctx) {
    const sourceName = str(values, "source");
    const modelName = str(values, "model");
    if (!sourceName || !modelName) throw new UserError("Pass --source <s> and --model <m>: the model the rule is read on.");
    for (const [flag, v] of [["source", sourceName], ["model", modelName]] as const)
      if (!NAME_PATTERN.test(v)) throw new UserError(`--${flag} must match ^[a-z][a-z0-9_]*$; got "${v}".`);
    const filter = str(values, "filter");
    const dimension = str(values, "dimension-expr");
    if ((filter === undefined) === (dimension === undefined))
      throw new UserError("Pass the rule as --filter <expr> (a row-level condition) or --dimension-expr <expr> (a value per row), not both.");
    const kind: RuleKind = filter !== undefined ? "filter" : "dimension_expr";
    const text = (filter ?? dimension)!;
    const source = loadSource(ctx.root, sourceName);
    const model = loadModel(ctx.root, sourceName, modelName).model;
    if (typeof model.table !== "string" || !model.table) throw new UserError(`Model "${modelName}" has no table; run sl validate.`);
    const input = resultsInput(ctx, values);
    const check = checkRule({
      source,
      snapshot: loadSnapshot(ctx.root, sourceName),
      models: listModels(ctx.root, sourceName).map((l) => l.model),
      model,
      kind,
      text,
      root: ctx.root,
    });
    const what = kind === "filter" ? "filter" : "dimension expr";

    if (!check.expressible) {
      if (ctx.json) ctx.out(formatJson(check));
      else {
        ctx.out(plainText(`The layer cannot express this ${what} on ${sourceName}.${modelName}: ${check.reason}.`));
        ctx.out(plainText(check.suggestion));
      }
      return 1;
    }
    if (bool(values, "emit-sql")) {
      ctx.out(formatJson(emitPlan(ctx, check.plan, { name: "check-rule", values })));
      return 0;
    }
    const id = check.plan.queries[0]!.id;
    // A database's error can quote a value it read, so a failed count query over a rule that reads a
    // protected column says what failed without the database's message (invariant 3).
    const live = !input.resultsFile && input.planId === undefined;
    const read = live ? protectedResultColumns([...new Set(columnRefs(text).flatMap((r) => r.parts))], protectedNames(ctx.root, source)) : [];
    const results = await executePlan(check.plan, { root: ctx.root, source, env: ctx.env, ...input }).catch((e: unknown) => {
      if (!read.length || !(e instanceof UserError) || !e.message.startsWith("Query failed:")) throw e;
      throw new UserError(
        `The count query failed. The rule reads the protected ${read.length === 1 ? "column" : "columns"} ${read.join(", ")}, so the database's message, which can quote a value, is not shown.\n` +
          `Check the rule's casts and comparisons against each column's type, then run sl check-rule again.`,
      );
    });
    let counted: { rows_matched: number; rows_total: number };
    try {
      counted = ruleCounts(results[id], id);
    } catch (e) {
      throw new UserError(`${(e as Error).message}. Run the query again and store its one row of rows_matched and rows_total.`);
    }
    const { plan: _plan, ...shown } = check;
    const next = nextStep(check);
    if (ctx.json) {
      ctx.out(formatJson({ ...shown, ...counted, next }));
      return 0;
    }
    const through = check.joins_used.length ? `, through ${check.joins_used.length === 1 ? "the join" : "the joins"} ${check.joins_used.join(", ")}` : "";
    const matched = kind === "filter" ? "It matches" : "It is not null on";
    ctx.out(plainText(`The layer can express this ${what} on ${sourceName}.${modelName}${through}.`));
    ctx.out(`${matched} ${counted.rows_matched} of ${counted.rows_total} rows of ${modelName} (${pct(counted.rows_matched, counted.rows_total)}).`);
    ctx.out(plainText(next));
    return 0;
  },
};
export default spec;

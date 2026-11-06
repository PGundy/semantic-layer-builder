import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isMap, isSeq } from "yaml";
import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { evaluateJoin, pct, type JoinFinding } from "../lib/joins.ts";
import { findTable, splitQualified } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { emitPlan, executePlan, resultsInput } from "../lib/plan.ts";
import { listModels, loadModel, loadSnapshot, loadSource, paths } from "../lib/project.ts";
import { joinCheckPlan, joinQueryId, type JoinCheck, type TableRef } from "../lib/sql/join-check.ts";
import { NAME_PATTERN, type Join, type JoinEvidence, type JoinKey, type Model, type Snapshot } from "../lib/types.ts";
import { updateYaml } from "../lib/yaml.ts";

interface Target {
  path: string;
  model: Model;
  join: Join;
  check: JoinCheck;
}

export interface CheckJoinResult {
  model: string;
  join: string;
  // Null when the join could not be measured (an empty side, or no complete keys); nothing is written then.
  // It records the join's to and keys as declared in the YAML.
  evidence: JoinEvidence | null;
  findings: JoinFinding[];
  sentence: string;
}

// A join that --all could not check, with the reason.
export interface SkippedJoin {
  model: string;
  join: string;
  reason: string;
}

const RELATIONSHIPS = new Set(["many_to_one", "one_to_one", "one_to_many"]);

function requireName(flag: string, value: string | undefined): string | undefined {
  if (value !== undefined && !NAME_PATTERN.test(value)) throw new UserError(`--${flag} must match ^[a-z][a-z0-9_]*$; got "${value}".`);
  return value;
}

// The physical table a model reads, taken from the snapshot when there is one.
function resolveTable(snapshot: Snapshot | null, model: Model, keyColumns: string[], role: string): { ref: TableRef; columns: string[] } {
  if (!model.table) throw new UserError(`Model "${model.model}" has no table.`);
  if (!snapshot) return { ref: splitQualified(model.table), columns: keyColumns };
  const table = findTable(snapshot.tables, model.table);
  if (!table) {
    throw new UserError(
      `Model "${model.model}" reads table "${model.table}", which is not in the snapshot for "${snapshot.source}". ` +
        `Run \`sl introspect --source ${snapshot.source}\` or fix the model's table.`,
    );
  }
  if (!table.columns.length) return { ref: { schema: table.schema, name: table.name }, columns: keyColumns };
  const columns = keyColumns.map((c) => {
    const found = table.columns.find((col) => col.name === c) ?? table.columns.find((col) => col.name.toLowerCase() === c.toLowerCase());
    if (!found) {
      throw new UserError(
        `The ${role} key column "${c}" is not a column of ${model.table} (model "${model.model}"). ` +
          `Columns: ${table.columns.map((col) => col.name).join(", ")}.`,
      );
    }
    return found.name;
  });
  return { ref: { schema: table.schema, name: table.name }, columns };
}

function buildTarget(ctx: CommandContext, source: string, snapshot: Snapshot | null, path: string, model: Model, join: Join): Target {
  const where = `Join "${join.name}" on model "${model.model}"`;
  if (!join.to) throw new UserError(`${where} has no "to" model.`);
  if (typeof join.to !== "string" || !NAME_PATTERN.test(join.to)) {
    throw new UserError(`${where} points to "${String(join.to)}"; "to" must be a model name in source "${source}".`);
  }
  if (join.relationship !== undefined && !RELATIONSHIPS.has(join.relationship)) {
    throw new UserError(`${where} has relationship "${String(join.relationship)}"; use many_to_one, one_to_one or one_to_many.`);
  }
  if (!existsSync(paths(ctx.root).model(source, join.to))) {
    throw new UserError(`${where} points to "${join.to}", which is not a model in source "${source}".`);
  }
  const right = loadModel(ctx.root, source, join.to).model;
  const keys = join.keys ?? [];
  if (!keys.length || keys.some((k) => !k || typeof k.from !== "string" || typeof k.to !== "string")) {
    throw new UserError(`${where} needs keys, each with "from" and "to" columns.`);
  }
  const left = resolveTable(snapshot, model, keys.map((k) => k.from), "left");
  const rightTable = resolveTable(snapshot, right, keys.map((k) => k.to), "right");
  const resolvedKeys: JoinKey[] = keys.map((_, i) => ({ from: left.columns[i]!, to: rightTable.columns[i]! }));
  return {
    path,
    model,
    join,
    check: { id: `${model.model}.${join.name}`, left: left.ref, right: rightTable.ref, keys: resolvedKeys },
  };
}

// The joins to check. With --all, a join that cannot be resolved (its target model is not
// drafted yet, a key column is missing) is skipped with its reason instead of stopping the run.
function selectTargets(
  ctx: CommandContext,
  source: string,
  snapshot: Snapshot | null,
  modelName: string | undefined,
  joinName: string | undefined,
  all: boolean,
): { targets: Target[]; skipped: SkippedJoin[] } {
  if (joinName && all) throw new UserError("Pass either --join or --all, not both.");
  if (joinName && !modelName) throw new UserError("--join needs --model.");
  if (!modelName && !all) throw new UserError("Pass --model <m> --join <j>, --model <m> --all, or --all.");
  if (modelName && !joinName && !all) throw new UserError(`Pass --join <j> or --all to choose which joins of "${modelName}" to check.`);

  const models = modelName ? [loadModel(ctx.root, source, modelName)] : listModels(ctx.root, source);
  const targets: Target[] = [];
  const skipped: SkippedJoin[] = [];
  for (const { path, model } of models) {
    const joins = model.joins ?? [];
    if (joinName) {
      const join = joins.find((j) => j.name === joinName);
      if (!join) {
        const known = joins.map((j) => j.name);
        throw new UserError(`Model "${model.model}" has no join "${joinName}". Joins: ${known.length ? known.join(", ") : "none"}.`);
      }
      targets.push(buildTarget(ctx, source, snapshot, path, model, join));
    } else {
      for (const join of joins) {
        try {
          targets.push(buildTarget(ctx, source, snapshot, path, model, join));
        } catch (err) {
          if (!(err instanceof UserError)) throw err;
          skipped.push({ model: model.model, join: String(join?.name), reason: err.message });
        }
      }
    }
  }
  return { targets, skipped };
}

// Sets joins[i].evidence in the model file, leaving every other key and comment as it was.
function writeEvidence(root: string, path: string, joinName: string, evidence: JoinEvidence): void {
  if (!resolve(path).startsWith(resolve(root) + sep)) throw new UserError(`Refusing to write ${path}: it is outside ${root}.`);
  updateYaml(path, (doc) => {
    const joins = doc.get("joins");
    if (!isSeq(joins)) throw new UserError(`${path}: "joins" is not a list.`);
    const index = joins.items.findIndex((item) => isMap(item) && item.get("name") === joinName);
    if (index < 0) throw new UserError(`${path}: join "${joinName}" not found.`);
    doc.setIn(["joins", index, "evidence"], doc.createNode(evidence));
  });
}

function humanReport(r: CheckJoinResult, target: Target, measuredEvidence: JoinEvidence): string {
  const e = measuredEvidence;
  const yaml = target.join.relationship ?? "none";
  const lines = [
    `${r.model}.${r.join} -> ${target.join.to}  (YAML says ${yaml}, ${r.evidence ? `data says ${e.suggested_relationship}` : "not measured"})`,
    `  ${r.sentence}`,
    `  left rows ${e.left_rows}, matched ${e.matched_rows} (${pct(e.matched_rows, e.left_rows)}), unmatched ${e.left_rows - e.matched_rows}, null keys ${e.left_null_keys}, right rows ${e.right_rows}` +
      (r.evidence
        ? `, right key unique ${e.right_key_unique ? "yes" : "no"}, left key unique ${e.left_key_unique ? "yes" : "no"}, max fan-out ${e.max_fanout}`
        : ""),
  ];
  for (const f of r.findings) lines.push(`  ${f.level}: ${f.message}`);
  return lines.join("\n");
}

const spec: CommandSpec = {
  summary: "Measure joins' match rate, key uniqueness and fan-out and write evidence.",
  usage: "check-join --source <s> (--model <m> --join <j> | --model <m> --all | --all) [--emit-sql] [--results <file>] [--plan <plan_id>] [--no-write]",
  options: {
    source: { type: "string" },
    model: { type: "string" },
    join: { type: "string" },
    all: { type: "boolean" },
    "emit-sql": { type: "boolean" },
    results: { type: "string" },
    plan: { type: "string" },
    "no-write": { type: "boolean" },
  },
  async run({ values }, ctx) {
    const sourceName = requireName("source", str(values, "source"));
    if (!sourceName) throw new UserError("--source is required.");
    const modelName = requireName("model", str(values, "model"));
    const joinName = requireName("join", str(values, "join"));
    const source = loadSource(ctx.root, sourceName);
    const snapshot = loadSnapshot(ctx.root, sourceName);
    const { targets, skipped } = selectTargets(ctx, sourceName, snapshot, modelName, joinName, bool(values, "all"));
    const skippedLines = skipped.map((s) => `${s.model}.${s.join}: skipped: ${s.reason}`);

    const plan = joinCheckPlan(source, targets.map((t) => t.check));
    const input = resultsInput(ctx, values);
    if (bool(values, "emit-sql")) {
      ctx.out(formatJson(emitPlan(ctx, plan, { name: "check-join", values })));
      return 0;
    }
    if (!targets.length) {
      if (ctx.json) ctx.out(formatJson({ source: sourceName, checks: [], skipped }));
      else ctx.out([`No joins to check in source "${sourceName}".`, ...skippedLines].join("\n"));
      return 0;
    }

    const results = await executePlan(plan, { root: ctx.root, source, env: ctx.env, ...input });
    const checkedAt = ctx.now().toISOString();
    const write = !bool(values, "no-write");
    const checks: CheckJoinResult[] = [];
    const reports: string[] = [];
    // Evaluate every row before writing any file, so a bad results row writes nothing.
    const evaluated = targets.map((t) => {
      const id = joinQueryId(t.model.model, t.join.name);
      const row = results[id]?.[0];
      if (!row) throw new UserError(`No result row for "${id}".`);
      try {
        return evaluateJoin(row, t.join.relationship, {
          left: t.model.model,
          // A self-join names its other side by the join, e.g. "manager".
          right: t.join.to === t.model.model ? t.join.name : t.join.to,
          checkedAt,
          to: t.join.to,
          keys: t.join.keys,
        });
      } catch (err) {
        if (err instanceof UserError) throw new UserError(`${id}: ${err.message}`);
        throw err;
      }
    });
    let written = 0;
    let unmeasured = 0;
    targets.forEach((t, i) => {
      const { evidence, measured, findings, sentence } = evaluated[i]!;
      if (measured && write) {
        writeEvidence(ctx.root, t.path, t.join.name, evidence);
        written++;
      }
      if (!measured) unmeasured++;
      const r: CheckJoinResult = { model: t.model.model, join: t.join.name, evidence: measured ? evidence : null, findings, sentence };
      checks.push(r);
      reports.push(humanReport(r, t, evidence));
    });

    if (ctx.json) ctx.out(formatJson({ source: sourceName, checks, skipped }));
    else {
      ctx.out(reports.join("\n\n"));
      const tail: string[] = [];
      if (skippedLines.length) tail.push("", ...skippedLines);
      tail.push(
        "",
        write
          ? `Wrote evidence to ${written} join${written === 1 ? "" : "s"}. Status and relationship are unchanged.`
          : "Nothing written (--no-write).",
      );
      if (unmeasured) tail.push(`${unmeasured} join${unmeasured === 1 ? " was" : "s were"} not measured, so no evidence was written for ${unmeasured === 1 ? "it" : "them"}.`);
      ctx.out(tail.join("\n"));
    }
    return 0;
  },
};
export default spec;

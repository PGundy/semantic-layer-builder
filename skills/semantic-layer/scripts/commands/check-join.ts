import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isMap, isSeq } from "yaml";
import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { evaluateJoin, pct, type JoinFinding } from "../lib/joins.ts";
import { findTable, splitQualified } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { emitPlan, executePlanPartial, resultsInput } from "../lib/plan.ts";
import { listModels, loadModel, loadSnapshot, loadSource, paths } from "../lib/project.ts";
import { type CrossSchemaPair, backedPairs, crossSchemaLevel, schemaJoin, undeclaredPairError } from "../lib/schema-scope.ts";
import { readApprovalLedger } from "../lib/ledger.ts";
import { joinCheckPlan, joinQueryId, type JoinCheck, type TableRef } from "../lib/sql/join-check.ts";
import { throughCheckQuery, throughEvidence, throughQueryId, type ThroughCheck } from "../lib/sql/through-check.ts";
import { throughFindings, throughLines, throughSentence } from "../lib/readback-bridge.ts";
import { joinLegs } from "../lib/through.ts";
import { NAME_PATTERN, type Join, type JoinEvidence, type JoinKey, type Model, type Snapshot } from "../lib/types.ts";
import { updateYaml } from "../lib/yaml.ts";

interface Target {
  path: string;
  model: Model;
  join: Join;
  check: JoinCheck;
  // A bridge join's second query: its check measures the hop from the model to the bridge.
  through?: ThroughCheck;
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

// A join that was not checked, with the reason: one --all could not resolve, or one whose query
// the database refused (no SELECT permission, a timeout, any other error).
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
function resolveTable(snapshot: Snapshot | null, model: Model, keyColumns: string[], role: string, code?: string, source?: string): { ref: TableRef; columns: string[] } {
  if (!model.table) throw new UserError(`Model "${model.model}" has no table.`);
  if (!snapshot) return { ref: splitQualified(model.table), columns: keyColumns };
  const table = findTable(snapshot.tables, model.table);
  if (!table) {
    throw new UserError(
      `Model "${model.model}" reads table "${model.table}", which is not in the snapshot for "${snapshot.source}". ` +
        `Run \`semlayer introspect --source ${snapshot.source}\` or fix the model's table.`,
    );
  }
  if (!table.columns.length) return { ref: { schema: table.schema, name: table.name }, columns: keyColumns };
  const columns = keyColumns.map((c) => {
    const found = table.columns.find((col) => col.name === c) ?? table.columns.find((col) => col.name.toLowerCase() === c.toLowerCase());
    if (!found) {
      throw new UserError(
        `The ${role} key column "${c}" is not a column of ${model.table} (model "${model.model}"). ` +
          `Columns: ${table.columns.map((col) => col.name).join(", ")}.`,
        code && `semlayer tables --source ${source}`,
        code,
      );
    }
    return found.name;
  });
  return { ref: { schema: table.schema, name: table.name }, columns };
}

function buildTarget(ctx: CommandContext, source: string, snapshot: Snapshot | null, pairs: readonly CrossSchemaPair[], path: string, model: Model, join: Join): Target {
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
  const target = loadModel(ctx.root, source, join.to).model;
  const keys = join.keys ?? [];
  if (!keys.length || keys.some((k) => !k || typeof k.from !== "string" || typeof k.to !== "string")) {
    throw new UserError(`${where} needs keys, each with "from" and "to" columns.`);
  }
  // A bridge join's keys pair the model with the bridge, so its first hop is measured against the bridge.
  const t = join.through;
  const viaName = t === undefined ? undefined : typeof t?.model === "string" && NAME_PATTERN.test(t.model) ? t.model : "";
  if (viaName !== undefined && (!viaName || viaName === model.model || viaName === join.to || !existsSync(paths(ctx.root).model(source, viaName))))
    throw new UserError(
      `${where} goes through "${String(t?.model)}", which is not a third model in source "${source}", so there is no bridge to measure. Nothing was written. Fix the join with semlayer remove-join and semlayer add-bridge.`,
      "semlayer status",
      "join.through_bridge_unknown",
    );
  const throughKeys = t?.keys ?? [];
  if (t && (!Array.isArray(throughKeys) || !throughKeys.length || throughKeys.some((k) => !k || typeof k.from !== "string" || typeof k.to !== "string")))
    throw new UserError(`${where} needs through.keys, each with "from" and "to" columns. Nothing was written.`, "semlayer add-bridge --help", "join.through_columns_missing");
  const via = viaName ? loadModel(ctx.root, source, viaName).model : undefined;
  const right = via ?? target;
  const code = via ? "join.through_columns_missing" : undefined;
  const left = resolveTable(snapshot, model, keys.map((k) => k.from), "left", code, source);
  const rightTable = resolveTable(snapshot, right, keys.map((k) => k.to), via ? "bridge" : "right", code, source);
  // A join across schemas is measured only when an approved pair declares its keys, or while an
  // approved join's grace lasts (spec: Schema scope); each hop of a bridge join is a join of its own.
  const tables = new Map([model, target, ...(via ? [via] : [])].map((m) => [m.model, m.table]));
  for (const leg of joinLegs(model, { to: join.to, keys, through: via ? { ...t!, model: via.model } : undefined })) {
    const shape = schemaJoin(snapshot, tables.get(leg.from)!, tables.get(leg.to)!, leg.keys);
    const what = via ? `${where} (${leg.from} to ${leg.to})` : where;
    if (shape && crossSchemaLevel(pairs, shape, join.status) === "error")
      throw undeclaredPairError(what, source, shape, pairs, `run semlayer check-join --source ${source} --model ${model.model} --join ${join.name} again`);
  }
  const resolvedKeys: JoinKey[] = keys.map((_, i) => ({ from: left.columns[i]!, to: rightTable.columns[i]! }));
  const id = `${model.model}.${join.name}`;
  let through: ThroughCheck | undefined;
  if (via) {
    const bridgeSide = resolveTable(snapshot, via, throughKeys.map((k) => k.from), "bridge", code, source);
    const targetSide = resolveTable(snapshot, target, throughKeys.map((k) => k.to), "target", code, source);
    through = {
      id,
      fact: left.ref,
      bridge: rightTable.ref,
      target: targetSide.ref,
      keys: resolvedKeys,
      throughKeys: throughKeys.map((_, i) => ({ from: bridgeSide.columns[i]!, to: targetSide.columns[i]! })),
    };
  }
  return { path, model, join, check: { id, left: left.ref, right: rightTable.ref, keys: resolvedKeys }, ...(through ? { through } : {}) };
}

// The joins to check. With --all, a join that cannot be resolved (its target model is not
// drafted yet, a key column is missing) is skipped with its reason instead of stopping the run.
function selectTargets(
  ctx: CommandContext,
  source: string,
  snapshot: Snapshot | null,
  pairs: readonly CrossSchemaPair[],
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
      targets.push(buildTarget(ctx, source, snapshot, pairs, path, model, join));
    } else {
      for (const join of joins) {
        try {
          targets.push(buildTarget(ctx, source, snapshot, pairs, path, model, join));
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
    `${r.model}.${r.join} -> ${target.join.to}${target.through ? ` through ${String(target.join.through!.model)}` : ""}  (YAML says ${yaml}, ${r.evidence ? `data says ${e.suggested_relationship}` : "not measured"})`,
    `  ${r.sentence}`,
    `  left rows ${e.left_rows}, matched ${e.matched_rows} (${pct(e.matched_rows, e.left_rows)}), unmatched ${e.left_rows - e.matched_rows}, null keys ${e.left_null_keys}, right rows ${e.right_rows}` +
      (r.evidence
        ? `, right key unique ${e.right_key_unique ? "yes" : "no"}, left key unique ${e.left_key_unique ? "yes" : "no"}, max fan-out ${e.max_fanout}`
        : ""),
  ];
  if (r.evidence?.through) lines.push(...throughLines(target.model.model, target.join, r.evidence.through).map((l) => `  ${l}`));
  for (const f of r.findings) lines.push(`  ${f.level}: ${f.message}`);
  return lines.join("\n");
}

// The names a database message about these joins may quote: their tables and key columns, lowercased.
function knownNames(targets: Target[]): Set<string> {
  const names = targets.flatMap(({ check, through }) => [
    ...[check.left, check.right, ...(through ? [through.target] : [])].flatMap((r) => [r.schema ?? "", r.name, r.schema ? `${r.schema}.${r.name}` : r.name]),
    ...[...check.keys, ...(through?.throughKeys ?? [])].flatMap((k) => [k.from, k.to]),
  ]);
  return new Set(names.map((n) => n.toLowerCase()));
}

const spec: CommandSpec = {
  summary:
    "Measure joins' match rate, key uniqueness and fan-out and write evidence, join by join: a join the database refuses " +
    "(no SELECT permission, a timeout) is skipped with its reason and the others are written.",
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
  writes: ({ values }) => (values["emit-sql"] ? "whole" : values["no-write"] ? false : "late"),
  async run({ values }, ctx) {
    const sourceName = requireName("source", str(values, "source"));
    if (!sourceName) throw new UserError("--source is required.");
    const modelName = requireName("model", str(values, "model"));
    const joinName = requireName("join", str(values, "join"));
    const source = loadSource(ctx.root, sourceName);
    const snapshot = loadSnapshot(ctx.root, sourceName);
    const { targets, skipped } = selectTargets(ctx, sourceName, snapshot, backedPairs(source, readApprovalLedger(ctx.root)), modelName, joinName, bool(values, "all"));
    const skippedLines = skipped.map((s) => `${s.model}.${s.join}: skipped: ${s.reason}`);

    const plan = joinCheckPlan(source, targets.map((t) => t.check));
    plan.queries.push(...targets.flatMap((t) => (t.through ? [throughCheckQuery(source.dialect, t.through)] : [])));
    const input = resultsInput(ctx, values);
    if (bool(values, "emit-sql")) {
      ctx.out(formatJson(emitPlan(ctx, plan, { name: "check-join", values, keepsPartial: true })));
      return 0;
    }
    if (!targets.length) {
      if (ctx.json) ctx.out(formatJson({ source: sourceName, checks: [], skipped }));
      else ctx.out([`No joins to check in source "${sourceName}".`, ...skippedLines].join("\n"));
      return 0;
    }

    // Each join's query runs on its own: a failure skips that join and the others are written.
    const { results, failed } = await executePlanPartial(plan, {
      root: ctx.root,
      source,
      env: ctx.env,
      ...input,
      known: knownNames(targets),
    });
    const refused: SkippedJoin[] = [];
    const answered = targets.filter((t) => {
      const reason = failed[joinQueryId(t.model.model, t.join.name)] ?? (t.through ? failed[throughQueryId(t.model.model, t.join.name)] : undefined);
      if (reason !== undefined) refused.push({ model: t.model.model, join: t.join.name, reason });
      return reason === undefined;
    });
    skipped.push(...refused);
    const checkedAt = ctx.now().toISOString();
    const write = !bool(values, "no-write");
    const checks: CheckJoinResult[] = [];
    const reports: string[] = [];
    // Evaluate every row before writing any file, so a bad results row writes nothing.
    const evaluated = answered.map((t) => {
      const id = joinQueryId(t.model.model, t.join.name);
      const row = results[id]?.[0];
      if (!row) throw new UserError(`No result row for "${id}".`);
      const bridgeId = throughQueryId(t.model.model, t.join.name);
      try {
        const out = evaluateJoin(row, t.join.relationship, {
          left: t.model.model,
          // A self-join names its other side by the join, e.g. "manager"; a bridge join's first hop, the bridge.
          right: t.through ? String(t.join.through!.model) : t.join.to === t.model.model ? t.join.name : t.join.to,
          checkedAt,
          to: t.join.to,
          keys: t.join.keys,
        });
        if (!t.through || !out.measured) return out;
        const bridgeRow = results[bridgeId]?.[0];
        if (!bridgeRow) throw new UserError(`No result row for "${bridgeId}".`);
        const through = throughEvidence(bridgeRow, String(t.join.through!.model), t.join.through!.keys);
        // The first hop fans out by design: the bridge's own findings and sentence replace those of a plain join.
        const plain = out.findings.filter((f) => !f.message.startsWith("Match rate is ") && !f.message.includes("so this join fans out"));
        return {
          ...out,
          evidence: { ...out.evidence, through },
          findings: [...plain, ...throughFindings(t.model.model, t.join, through)],
          sentence: throughSentence(t.model.model, t.join, through),
        };
      } catch (err) {
        if (err instanceof UserError) throw new UserError(`${id}: ${err.message}`);
        throw err;
      }
    });
    let written = 0;
    let unmeasured = 0;
    // The queries ran without the lock: each model file is read and written under it.
    const unlock = write ? await ctx.lock() : undefined;
    answered.forEach((t, i) => {
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
    unlock?.();
    // Non-zero only when the database answered for no join.
    const code = answered.length ? 0 : 1;

    if (ctx.json) ctx.out(formatJson({ source: sourceName, checks, skipped }));
    else {
      if (reports.length) ctx.out(reports.join("\n\n"));
      const tail: string[] = [];
      if (skippedLines.length) tail.push("", ...skippedLines);
      if (refused.length) {
        tail.push(
          "",
          `Skipped ${refused.length} join${refused.length === 1 ? "" : "s"} the database did not answer for${answered.length ? "; the others are checked" : ""}:`,
          ...refused.map((r) => `  ${r.model}.${r.join}: ${r.reason}`),
          `Next: fix what each reason names (ask the database's owner for SELECT on both tables and USAGE on their schemas, or raise the timeout), then check each again: ` +
            `semlayer check-join --source ${sourceName} --model ${refused[0]!.model} --join ${refused[0]!.join}.`,
        );
      }
      tail.push(
        "",
        write
          ? `Wrote evidence to ${written} join${written === 1 ? "" : "s"}. Status and relationship are unchanged.`
          : "Nothing written (--no-write).",
      );
      if (unmeasured) tail.push(`${unmeasured} join${unmeasured === 1 ? " was" : "s were"} not measured, so no evidence was written for ${unmeasured === 1 ? "it" : "them"}.`);
      // With no report above it, the tail starts at its first line of text.
      while (!reports.length && tail[0] === "") tail.shift();
      ctx.out(tail.join("\n"));
    }
    return code;
  },
};
export default spec;

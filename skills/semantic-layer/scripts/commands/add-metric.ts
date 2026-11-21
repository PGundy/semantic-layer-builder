import { existsSync } from "node:fs";
import { isSeq, type YAMLMap, type YAMLSeq } from "yaml";
import type { CommandContext, CommandSpec, OptionValues } from "../lib/command.ts";
import { bool, str, today } from "../lib/command.ts";
import { parseFormula } from "../lib/compiler/metrics.ts";
import { APPROVAL_FIELDS, commitEdits, inTurnApply, itemMap, oneLine, parseValue, reapproveLines, relFile, schemaProperties } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { ownerText } from "../lib/ledger.ts";
import { NO_METRICS_COMMAND, type NoMetrics } from "../lib/no-metrics.ts";
import { formatJson } from "../lib/output.ts";
import { listModels, listSourceNames, loadMetrics, loadProject, paths } from "../lib/project.ts";
import { NAME_PATTERN } from "../lib/types.ts";

const MEASURE_REF = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const PLACEHOLDER = /\{\s*([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\s*\}/g;
// What metrics.yaml starts from when there is none.
const NEW_FILE = "metrics: []\n";

const spec: CommandSpec = {
  summary: "Add a draft ratio or derived metric to metrics.yaml, checked as semlayer validate and the compiler read it, or record that the owner reports none.",
  usage:
    "add-metric --name <n> --type ratio|derived [--source <s>] [--numerator <model.measure> --denominator <model.measure>] [--expr <e>] " +
    "[--format number|integer|currency|percent] [--currency <code>] [--description <text>] [--set key=value]...\n" +
    'add-metric --none --by "<owner>" --text "<owner\'s words>"\n\n' +
    "A ratio divides --numerator by --denominator, each a measure as model.measure: --numerator orders.revenue --denominator orders.order_count.\n" +
    'A derived metric\'s --expr combines measures in braces with + - * / and numbers: --expr "{orders.revenue} - {refunds.refund_amount}".\n' +
    "--set writes any other key of the metric (--set synonyms=\"[aov]\"). The metric is a draft; an approved metric uses approved measures only.\n" +
    "--none records the owner's answer that they report no metrics for now, with their name (--by) and words (--text), in metrics.yaml's\n" +
    "no_metrics; semlayer next then goes past the metrics phase while metrics.yaml lists no metric. A metric added later is read back as any other.",
  options: {
    name: { type: "string" },
    type: { type: "string" },
    source: { type: "string" },
    numerator: { type: "string" },
    denominator: { type: "string" },
    expr: { type: "string" },
    format: { type: "string" },
    currency: { type: "string" },
    description: { type: "string" },
    set: { type: "string", multiple: true },
    none: { type: "boolean" },
    by: { type: "string" },
    text: { type: "string" },
  },
  positionals: false,
  writes: "whole",
  async run({ values }, ctx) {
    const project = loadProject(ctx.root);
    if (bool(values, "none")) return recordNone(values, ctx);
    if (str(values, "by") !== undefined || str(values, "text") !== undefined)
      throw new UserError(`--by and --text go with --none only, which records the owner's answer that they report no metrics: ${NO_METRICS_COMMAND}. Nothing was written.`);
    const name = str(values, "name")?.trim();
    const type = str(values, "type")?.trim();
    if (!name || !type) {
      throw new UserError(
        "Usage: semlayer add-metric --name <n> --type ratio|derived ..., for example semlayer add-metric --name average_order_value --type ratio --numerator orders.revenue --denominator orders.order_count.",
      );
    }
    if (!NAME_PATTERN.test(name)) throw new UserError(`"${name}" is not a name: a name is lowercase and matches ^[a-z][a-z0-9_]*$, such as average_order_value.`);
    if (type !== "ratio" && type !== "derived") throw new UserError(`--type is ratio (one measure divided by another) or derived (arithmetic over measures), not ${type}.`);
    if ((loadMetrics(ctx.root).metrics ?? []).some((m) => m?.name === name)) {
      throw new UserError(`metrics.yaml already has a metric "${name}". Pick another name, or change it ${inTurnApply([["set", `metric:${name}`, "<key>", "<value>"]])}.`);
    }
    const sources = listSourceNames(ctx.root);
    const source = str(values, "source")?.trim() ?? project.default_source ?? (sources.length === 1 ? sources[0] : undefined);
    if (!source) throw new UserError(`Name the metric's source with --source (${sources.join(", ") || "none yet"}).`);
    if (!sources.includes(source)) throw new UserError(`No source "${source}". Sources: ${sources.join(", ") || "none yet"}; semlayer add-source adds one.`);

    const props = schemaProperties("metric");
    const metric: Record<string, unknown> = { name, source, type };
    const given = (k: string) => str(values, k)?.trim();
    if (type === "ratio") {
      if (given("expr") !== undefined) throw new UserError("A ratio has no --expr: it divides --numerator by --denominator. For arithmetic over measures, use --type derived --expr.");
      for (const side of ["numerator", "denominator"] as const) {
        const v = given(side);
        if (!v) throw new UserError("A ratio needs --numerator and --denominator, each model.measure, for example --numerator orders.revenue --denominator orders.order_count.");
        if (!MEASURE_REF.test(v)) throw new UserError(`--${side} is model.measure, such as orders.revenue, not "${v}".`);
        metric[side] = v;
      }
    } else {
      if (given("numerator") !== undefined || given("denominator") !== undefined) throw new UserError("A derived metric has no --numerator or --denominator: write its formula with --expr, or use --type ratio.");
      const expr = given("expr");
      if (!expr) throw new UserError('A derived metric needs --expr, {model.measure} placeholders with numbers and + - * / ( ), for example --expr "{orders.revenue} - {refunds.refund_amount}".');
      if (!parseFormula(expr)) {
        throw new UserError(`The compiler cannot read --expr "${oneLine(expr)}": it combines {model.measure} placeholders with numbers and + - * / ( ) only, each parenthesis closed.`);
      }
      metric.expr = expr;
    }
    for (const flag of ["format", "currency", "description"] as const) {
      const v = str(values, flag);
      if (v !== undefined) metric[flag] = flag === "description" ? oneLine(v) : parseValue(flag, v, props[flag]!);
    }
    const sets = Array.isArray(values.set) ? (values.set as unknown[]).map(String) : [];
    for (const s of sets) {
      const eq = s.indexOf("=");
      const key = eq < 0 ? s.trim() : s.slice(0, eq).trim();
      if (eq < 0) throw new UserError(`--set takes key=value, for example --set synonyms="[aov]"; got "${s}".`);
      if (APPROVAL_FIELDS.includes(key)) throw new UserError(`${key} is an approval field: a new metric is always a draft, and only semlayer approve approves it after the owner's yes.`);
      if (key in metric || ["numerator", "denominator", "expr", "source", "type"].includes(key)) throw new UserError(`${key} is set with --${key}, once.`);
      if (!(key in props)) {
        const known = Object.keys(props).filter((k) => !APPROVAL_FIELDS.includes(k) && !(k in metric));
        throw new UserError(`A metric has no key "${key}". Keys a metric takes: ${known.join(", ")}.`);
      }
      metric[key] = key === "description" ? oneLine(s.slice(eq + 1)) : parseValue(key, s.slice(eq + 1), props[key]!);
    }
    metric.status = "draft";
    const order = Object.keys(props);
    const ordered = Object.fromEntries(Object.entries(metric).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)));

    // The measures it uses that are drafts: an approved metric may use approved measures only.
    const refs = type === "ratio" ? [String(metric.numerator), String(metric.denominator)] : [...String(metric.expr).matchAll(PLACEHOLDER)].map((m) => `${m[1]}.${m[2]}`);
    const models = new Map(listModels(ctx.root, source).map((l) => [l.model.model, l.model]));
    const drafts = [...new Set(refs)].filter((r) => {
      const [model, measure] = r.split(".") as [string, string];
      const m = models.get(model)?.measures?.find((x) => x.name === measure);
      return m && m.status !== "approved";
    });

    const file = paths(ctx.root).metrics;
    const create = existsSync(file) ? undefined : new Map([[file, NEW_FILE]]);
    const ref = `metric:${name}`;
    const outcome = commitEdits(
      ctx.root,
      [
        {
          file,
          edit: (doc) => {
            const root = itemMap(doc, []);
            const node = doc.createNode(ordered) as YAMLMap;
            for (const pair of node.items) if (isSeq(pair.value)) (pair.value as YAMLSeq).flow = true;
            const list = root.get("metrics", true);
            if (isSeq(list) && list.items.length) return void list.items.push(node);
            if (list !== undefined && list !== null && !isSeq(list)) throw new UserError(`Cannot add to metrics in ${relFile(ctx.root, file)}: it is not a list.`);
            // An empty or missing list becomes a block list holding the metric, with the old list's comments.
            const created = doc.createNode([]) as YAMLSeq;
            created.items.push(node);
            if (isSeq(list)) Object.assign(created, { comment: list.comment, commentBefore: list.commentBefore });
            root.set("metrics", created);
          },
        },
      ],
      `add ${ref}`,
      undefined,
      undefined,
      { create },
    );
    const result = { changed: outcome.changed, file: relFile(ctx.root, file), reapprove: outcome.reapprove, ref, metric: ordered, draft_measures: drafts, created: !!create };
    if (ctx.json) {
      ctx.out(formatJson(result));
      return 0;
    }
    const lines = [`Added draft ${type} metric ${name} to ${result.file}${create ? ", which is new" : ""}.`];
    if (drafts.length) {
      lines.push(
        `It uses draft measure${drafts.length === 1 ? "" : "s"} ${drafts.join(", ")}: an approved metric may use approved measures only, so read ${drafts.length === 1 ? "it" : "them"} back and approve ${drafts.length === 1 ? "it" : "them"} first.`,
      );
    }
    lines.push(...reapproveLines(outcome.reapprove));
    lines.push(`Next: read the formula back to the owner (semlayer readback --targets ${ref}), record their answer with semlayer reply, and approve it only on their yes (semlayer approve --target ${ref}).`);
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

// semlayer add-metric --none: the owner's answer that they report no metrics for now, in their name and words.
function recordNone(values: OptionValues, ctx: CommandContext): number {
  const other = ["name", "type", "source", "numerator", "denominator", "expr", "format", "currency", "description", "set"].find((k) => values[k] !== undefined);
  if (other) throw new UserError(`--none records that the owner reports no metrics and takes no --${other}: run ${NO_METRICS_COMMAND} on its own. Nothing was written.`);
  const words = (k: string) => {
    const raw = str(values, k);
    return raw === undefined ? "" : oneLine(ownerText(raw).text);
  };
  const by = words("by");
  const text = words("text");
  if (!by || !text) {
    const missing = [!by ? "--by with the owner's name" : "", !text ? "--text with the owner's words" : ""].filter(Boolean).join(" and ");
    throw new UserError(
      `--none records the owner's answer, so it needs ${missing}, such as --by "Dana" --text "Revenue and invoice count are all I need". Nothing was written. Ask the owner, then run ${NO_METRICS_COMMAND}.`,
      NO_METRICS_COMMAND,
      "owner_words_missing",
    );
  }
  const listed = (loadMetrics(ctx.root).metrics ?? []).flatMap((m) => (m && typeof m.name === "string" ? [m.name] : m ? ["<unnamed>"] : []));
  if (listed.length)
    throw new UserError(
      `metrics.yaml already lists ${listed.length === 1 ? "the metric" : "the metrics"} ${listed.join(", ")}, so a none for now would not apply. Nothing was written. ` +
        `Read ${listed.length === 1 ? "it" : "them"} back to the owner as semlayer next names, or, if the owner wants none of them, remove each with semlayer remove-metric <name> first.`,
    );
  const record: NoMetrics = { by, text, at: today(ctx) };
  const file = paths(ctx.root).metrics;
  const create = existsSync(file) ? undefined : new Map([[file, NEW_FILE]]);
  const outcome = commitEdits(
    ctx.root,
    [{ file, edit: (doc) => void itemMap(doc, []).set("no_metrics", doc.createNode(record)) }],
    "record no metrics for now",
    undefined,
    undefined,
    { create },
  );
  const rel = relFile(ctx.root, file);
  if (ctx.json) {
    ctx.out(formatJson({ changed: outcome.changed, file: rel, no_metrics: record, created: !!create, next: "semlayer next" }));
    return 0;
  }
  ctx.out(
    [
      `Recorded in ${rel} that the owner reports no metrics for now, said by ${by} on ${record.at}. The metrics phase is closed while metrics.yaml lists no metric; ` +
        "a metric added later with semlayer add-metric is read back and approved as any other.",
      "Next: semlayer next.",
    ].join("\n"),
  );
  return 0;
}

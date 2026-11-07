import { existsSync } from "node:fs";
import { isSeq, type YAMLMap, type YAMLSeq } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { parseFormula } from "../lib/compiler/metrics.ts";
import { APPROVAL_FIELDS, commitEdits, itemMap, oneLine, parseValue, reapproveLines, relFile, schemaProperties } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { listModels, listSourceNames, loadMetrics, loadProject, paths } from "../lib/project.ts";
import { NAME_PATTERN } from "../lib/types.ts";

const MEASURE_REF = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const PLACEHOLDER = /\{\s*([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\s*\}/g;
// What metrics.yaml starts from when there is none.
const NEW_FILE = "metrics: []\n";

const spec: CommandSpec = {
  summary: "Add a draft ratio or derived metric to metrics.yaml, checked as sl validate and the compiler read it.",
  usage:
    "add-metric --name <n> --type ratio|derived [--source <s>] [--numerator <model.measure> --denominator <model.measure>] [--expr <e>] " +
    "[--format number|integer|currency|percent] [--currency <code>] [--description <text>] [--set key=value]...",
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
  },
  positionals: false,
  async run({ values }, ctx) {
    const project = loadProject(ctx.root);
    const name = str(values, "name")?.trim();
    const type = str(values, "type")?.trim();
    if (!name || !type) {
      throw new UserError(
        "Usage: sl add-metric --name <n> --type ratio|derived ..., for example sl add-metric --name average_order_value --type ratio --numerator orders.revenue --denominator orders.order_count.",
      );
    }
    if (!NAME_PATTERN.test(name)) throw new UserError(`"${name}" is not a name: a name is lowercase and matches ^[a-z][a-z0-9_]*$, such as average_order_value.`);
    if (type !== "ratio" && type !== "derived") throw new UserError(`--type is ratio (one measure divided by another) or derived (arithmetic over measures), not ${type}.`);
    if ((loadMetrics(ctx.root).metrics ?? []).some((m) => m?.name === name)) {
      throw new UserError(`metrics.yaml already has a metric "${name}". Pick another name, or change it with sl set metric:${name} <key> <value>.`);
    }
    const sources = listSourceNames(ctx.root);
    const source = str(values, "source")?.trim() ?? project.default_source ?? (sources.length === 1 ? sources[0] : undefined);
    if (!source) throw new UserError(`Name the metric's source with --source (${sources.join(", ") || "none yet"}).`);
    if (!sources.includes(source)) throw new UserError(`No source "${source}". Sources: ${sources.join(", ") || "none yet"}; sl add-source adds one.`);

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
      if (APPROVAL_FIELDS.includes(key)) throw new UserError(`${key} is an approval field: a new metric is always a draft, and only sl approve approves it after the owner's yes.`);
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
    lines.push(`Next: read the formula back to the owner (sl readback --targets ${ref}), record their answer with sl reply, and approve it only on their yes (sl approve --target ${ref}).`);
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

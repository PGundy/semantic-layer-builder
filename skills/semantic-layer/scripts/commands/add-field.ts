import { isMap, isSeq, type Node, type YAMLMap, type YAMLSeq } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { APPROVAL_FIELDS, commitEdit, fieldColumns, itemMap, locate, oneLine, parseValue, placeKey, reapproveLines, schemaProperties } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { findTable } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject, loadSnapshot, loadSource } from "../lib/project.ts";
import { findField } from "../lib/refs.ts";
import { sqlIdentifiers } from "../lib/snapshot-diff.ts";
import { NAME_PATTERN, PROTECTED_TAGS } from "../lib/types.ts";
import { heldValues } from "../lib/validate.ts";

// The flags that set a key, per kind; every other key the schema allows goes through --set key=value.
const FLAGS = { dimension: ["expr", "type", "description"], measure: ["expr", "agg", "filter", "description"] } as const;

// Words a computed expr uses that are not columns.
const SQL_WORDS = new Set(
  "and or not in is null true false case when then else end between like ilike similar escape distinct as filter where over partition by order asc desc nulls first last any all some exists interval extract from cast"
    .split(" "),
);

// An expr that is one bare or quoted column: the column's name.
function bareColumn(expr: string): string | undefined {
  const t = expr.trim();
  const q = /^"((?:[^"]|"")+)"$/.exec(t) ?? /^`((?:[^`]|``)+)`$/.exec(t);
  if (q) return q[1]!.replace(/""/g, '"').replace(/``/g, "`");
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(t) && !/^(true|false|null)$/i.test(t) ? t : undefined;
}

const spec: CommandSpec = {
  summary: "Add a draft dimension or measure to a model, checking its column against the snapshot.",
  usage:
    "add-field <source.model> --kind dimension|measure --name <n> --expr <e> [--type time|string|number|boolean] [--agg sum|count|count_distinct|avg|min|max] " +
    "[--filter <f>] [--description <text>] [--set key=value]... [--unignore]",
  options: {
    kind: { type: "string" },
    name: { type: "string" },
    expr: { type: "string" },
    type: { type: "string" },
    agg: { type: "string" },
    filter: { type: "string" },
    description: { type: "string" },
    set: { type: "string", multiple: true },
    unignore: { type: "boolean" },
  },
  positionals: true,
  async run({ values, positionals }, ctx) {
    loadProject(ctx.root);
    const [ref, ...extra] = positionals;
    const kind = str(values, "kind");
    const name = str(values, "name")?.trim();
    if (!ref || extra.length || !kind || !name) {
      throw new UserError("Usage: sl add-field <source.model> --kind dimension|measure --name <n> --expr <e> ..., for example sl add-field warehouse.orders --kind dimension --name channel --expr channel --type string.");
    }
    if (kind !== "dimension" && kind !== "measure") throw new UserError(`--kind is dimension or measure, not ${kind}. A join comes from sl draft or is written with the owner and checked with sl check-join.`);
    const loc = locate(ctx.root, ref);
    if (loc.kind !== "model") throw new UserError(`sl add-field adds to a model: name it as source.model (${ref.split(".").slice(0, 2).join(".")}), not ${ref}.`);
    if (!NAME_PATTERN.test(name)) throw new UserError(`"${name}" is not a name: a name is lowercase and matches ^[a-z][a-z0-9_]*$, such as order_channel.`);
    const model = loc.model!;
    const taken = findField(model, name);
    if (taken) throw new UserError(`${ref} already has a ${taken.kind} "${name}": dimensions, measures and joins share one namespace. Pick another name, or change it with sl set ${ref}.${name} <key> <value>.`);

    const props = schemaProperties(kind);
    const field: Record<string, unknown> = { name };
    for (const flag of ["expr", "type", "agg", "filter", "description"] as const) {
      const v = str(values, flag);
      if (v === undefined) continue;
      if (!(FLAGS[kind] as readonly string[]).includes(flag)) throw new UserError(`A ${kind} has no --${flag}${flag === "type" ? "; a measure's display is --set format=<number|integer|currency|percent>" : ""}.`);
      field[flag] = flag === "description" ? oneLine(v) : parseValue(flag, v, props[flag]!);
    }
    const sets = Array.isArray(values.set) ? (values.set as unknown[]).map(String) : [];
    for (const s of sets) {
      const eq = s.indexOf("=");
      const key = eq < 0 ? s.trim() : s.slice(0, eq).trim();
      if (eq < 0) throw new UserError(`--set takes key=value, for example --set synonyms="[sales, gmv]"; got "${s}".`);
      if (APPROVAL_FIELDS.includes(key)) throw new UserError(`${key} is an approval field: a new field is always a draft, and only sl approve approves it after the owner's yes.`);
      if (key === "name" || key in field) throw new UserError(`${key} is given twice: use --${key} or --set ${key}=..., once.`);
      if (!(key in props)) {
        const known = Object.keys(props).filter((k) => !APPROVAL_FIELDS.includes(k) && k !== "name");
        throw new UserError(`A ${kind} has no key "${key}". Keys a ${kind} takes: ${known.join(", ")}.`);
      }
      field[key] = key === "description" ? oneLine(s.slice(eq + 1)) : parseValue(key, s.slice(eq + 1), props[key]!);
    }
    if (kind === "dimension" && (field.expr === undefined || field.type === undefined)) throw new UserError("A dimension needs --expr and --type, for example --expr channel --type string.");
    if (kind === "measure" && field.agg === undefined) throw new UserError("A measure needs --agg (sum, count, count_distinct, avg, min or max).");
    if (kind === "measure" && field.expr === undefined && field.agg !== "count") throw new UserError("A measure needs --expr, except with --agg count, which counts rows.");
    field.status = "draft";
    const order = Object.keys(props);
    const ordered = Object.fromEntries(Object.entries(field).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)));

    const [source] = ref.split(".") as [string];
    const config = loadSource(ctx.root, source);
    const snapshot = loadSnapshot(ctx.root, source);
    const table = Array.isArray(snapshot?.tables) ? findTable(snapshot.tables, String(model.table)) : undefined;
    const warnings: string[] = [];
    const expr = typeof field.expr === "string" ? field.expr : undefined;
    const column = expr === undefined ? undefined : bareColumn(expr);
    if (!table) warnings.push(`The snapshot has no table ${model.table}, so its columns were not checked; run sl introspect --source ${source}, then sl validate.`);
    else if (column !== undefined) {
      if (!table.columns.some((c) => c.name === column || c.name.toLowerCase() === column.toLowerCase())) {
        throw new UserError(`${column} is not a column of ${model.table} in the snapshot. Run sl tables --source ${source} to see its tables, or sl introspect --source ${source} if it is new.`);
      }
    } else {
      const joins = new Set((model.joins ?? []).map((j) => j.name.toLowerCase()));
      const names = [expr, field.filter]
        .filter((s): s is string => typeof s === "string")
        .flatMap((s) => sqlIdentifiers(s, config.dialect))
        .filter((id) => !(!id.quoted && (joins.has(id.v.toLowerCase()) || SQL_WORDS.has(id.v.toLowerCase()))))
        .filter((id) => !table.columns.some((c) => c.name === id.v || (!id.quoted && c.name.toLowerCase() === id.v.toLowerCase())))
        .map((id) => id.v);
      const unknown = [...new Set(names)];
      if (unknown.length) {
        warnings.push(
          `${unknown.join(", ")} ${unknown.length === 1 ? "is not a column" : "are not columns"} of ${model.table} in the snapshot. The expr is computed, so it was written anyway; ` +
            `if a column is misspelled, fix it with sl set ${ref}.${name} ${field.filter !== undefined && !expr ? "filter" : "expr"} "<sql>".`,
        );
      }
    }
    const ignored = (model.ignored_columns ?? []).map(String);
    const reads = fieldColumns(model, kind, field, table, config.dialect).map((c) => c.toLowerCase());
    const unignored = ignored.filter((c) => reads.includes(c.toLowerCase()));
    if (unignored.length && !bool(values, "unignore")) {
      throw new UserError(
        `${unignored.join(", ")} ${unignored.length === 1 ? "is" : "are"} in ${ref}'s ignored_columns: left out of the layer on purpose. Nothing was written. ` +
          `Confirm with the owner, then run this again with --unignore, which also removes ${unignored.length === 1 ? "it" : "them"} from ignored_columns.`,
      );
    }

    // A protected field over a column whose profile holds sample values: the snapshot keeps counts only once redacted.
    const tags = Array.isArray(field.tags) ? field.tags.map(String) : [];
    const redact =
      tags.some((t) => (PROTECTED_TAGS as readonly string[]).includes(t)) &&
      fieldColumns(model, kind, field, table, config.dialect).some((c) => {
        const col = table?.columns.find((x) => x.name === c);
        return !!col && heldValues(col.profile, col.type) !== null;
      });
    const fieldRef = `${ref}.${name}`;
    const section = kind === "dimension" ? "dimensions" : "measures";
    const outcome = commitEdit(ctx.root, loc.file, `add ${fieldRef}`, (doc) => {
      const root = itemMap(doc, []);
      const node = doc.createNode(ordered) as YAMLMap;
      for (const pair of node.items) if (isSeq(pair.value) && (pair.value as YAMLSeq).items.every((i) => !isMap(i) && !isSeq(i))) (pair.value as YAMLSeq).flow = true;
      const list = root.get(section, true);
      if (isSeq(list) && list.items.length) list.items.push(node);
      else {
        const created = doc.createNode([]) as YAMLSeq;
        created.items.push(node as Node);
        placeKey(doc, root, section, created, kind === "measure" ? ["dimensions"] : [], ["measures", "joins"]);
      }
      if (!unignored.length) return;
      const ig = root.get("ignored_columns", true);
      if (!isSeq(ig)) return;
      ig.items = ig.items.filter((i) => !unignored.includes(String((i as { value?: unknown }).value ?? i)));
      if (!ig.items.length) root.delete("ignored_columns");
    });
    if (ctx.json) {
      ctx.out(formatJson({ ...outcome, ref: fieldRef, kind, field: ordered, unignored, warnings, redact }));
      return 0;
    }
    const lines = [`Added draft ${kind} ${name} to ${ref} in ${outcome.file}.`];
    if (unignored.length) lines.push(`Removed ${unignored.join(", ")} from ${ref}'s ignored_columns.`);
    if (redact) lines.push(`The field is protected and the snapshot holds sample values of a column it reads: run sl profile --source ${source} --redact to keep counts only.`);
    lines.push(...warnings, ...reapproveLines(outcome.reapprove));
    lines.push(`Next: read ${fieldRef} back to the owner, and approve it only on their yes (sl approve --target ${fieldRef} --by "<owner>").`);
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

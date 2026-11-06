import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, isSeq, type Node } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { bool } from "../lib/command.ts";
import {
  accessGuard,
  APPROVAL_FIELDS,
  commitEdit,
  itemMap,
  locate,
  parseValue,
  placeKey,
  protectionGuard,
  reapproveLines,
  relFile,
  schemaProperties,
} from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";

// Keys another command owns, with the command to use instead.
const FIELDS = "fields are added and removed one at a time with sl add-field <source.model> and sl remove-field <source.model.field>";
const OWNED: Record<string, string> = {
  name: "renaming changes every reference to the item, which sl rename <ref> <new_name> updates in one write",
  model: "a model's name is its file name, and sl rename does not rename models: rename the file and its model key together, update every reference, and run sl validate",
  dimensions: FIELDS,
  measures: FIELDS,
  joins: FIELDS,
  ignored_columns: "use sl ignore-column --source <s> --model <m> --column <c>",
  open_questions: 'use sl question add <ref> --text "<question>"',
  evidence: "sl check-join measures the join and writes its evidence",
};

// The access.yaml keys sl set takes; roles, restrictions and user attributes are larger edits.
const ACCESS_KEYS = ["mode", "default_role"];

function scalarsOnly(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => x === null || typeof x !== "object");
}

const spec: CommandSpec = {
  summary: "Set one key of a model, field, metric or the access file, validating before it writes.",
  usage: "set <source.model | source.model.field | metric:<name> | access> <key> (<value> | --unset)",
  options: { unset: { type: "boolean" } },
  positionals: true,
  async run({ values, positionals }, ctx) {
    loadProject(ctx.root);
    const unset = bool(values, "unset");
    const [ref, key, raw, ...extra] = positionals;
    if (!ref || !key || (unset ? raw !== undefined : raw === undefined) || extra.length) {
      throw new UserError(
        'Usage: sl set <ref> <key> <value>, or sl set <ref> <key> --unset. Quote a value with spaces: sl set warehouse.orders.revenue description "Order value."',
      );
    }
    const loc = locate(ctx.root, ref);
    if (APPROVAL_FIELDS.includes(key)) {
      throw new UserError(
        `${key} is an approval field, which only sl approve writes, after the owner's yes to a readback: sl approve --target ${ref} --by "<owner>".`,
      );
    }
    const props = schemaProperties(loc.kind);
    if (OWNED[key] && key in props) throw new UserError(`sl set does not change ${key}: ${OWNED[key]}.`);
    if (loc.kind === "access" && !ACCESS_KEYS.includes(key)) {
      throw new UserError(
        `sl set access takes ${ACCESS_KEYS.join(" or ")}. Roles, restrictions and user attributes are edited in access.yaml and read back to the owner (sl access shows the result).`,
      );
    }
    if (!(key in props)) {
      const known = Object.keys(props).filter((k) => !APPROVAL_FIELDS.includes(k) && !OWNED[k]);
      throw new UserError(`A ${loc.kind} has no key "${key}". Keys sl set takes on a ${loc.kind}: ${known.join(", ")}.`);
    }
    const value = unset ? undefined : parseValue(key, raw!, props[key]!);
    const result = { ref, key, value: value ?? null };
    if (unset ? !(key in loc.item) : isDeepStrictEqual(loc.item[key], value)) {
      if (ctx.json) ctx.out(formatJson({ changed: false, file: relFile(ctx.root, loc.file), reapprove: [], ...result }));
      else ctx.out(`${ref} already has ${unset ? `no ${key}` : `that ${key}`}; nothing changed. Next: sl status.`);
      return 0;
    }
    const what = `${unset ? "remove" : "set"} ${key} on ${ref}`;
    const tagsOf = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    const guard = loc.kind === "access" ? accessGuard(what) : key === "tags" ? protectionGuard(ref, tagsOf(loc.item.tags), tagsOf(value)) : undefined;
    const outcome = commitEdit(ctx.root, loc.file, what, (doc) => {
      const map = itemMap(doc, loc.path);
      if (unset) return void map.delete(key);
      const node = map.get(key, true);
      if (isScalar(node) && (value === null || typeof value !== "object")) {
        node.value = value;
        return;
      }
      const created = doc.createNode(value) as Node;
      if (isSeq(created) || isMap(created)) created.flow = isSeq(node) || isMap(node) ? !!node.flow : scalarsOnly(value);
      if (loc.kind === "access") placeKey(doc, map, key, created, ["mode", "approved_hash", "approved_at", "approved_by", "last_approved", "status"]);
      else placeKey(doc, map, key, created, [], ["status"]);
    }, guard);
    if (ctx.json) {
      ctx.out(formatJson({ ...outcome, ...result }));
      return 0;
    }
    const lines = [unset ? `Removed ${key} from ${ref} in ${outcome.file}.` : `Set ${key} on ${ref} in ${outcome.file}.`];
    lines.push(...reapproveLines(outcome.reapprove));
    if (!outcome.reapprove.length) lines.push("Next: sl status.");
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

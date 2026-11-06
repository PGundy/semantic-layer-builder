import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, isSeq, type Node } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { bool } from "../lib/command.ts";
import {
  accessGuard,
  APPROVAL_FIELDS,
  commitEdit,
  type ItemKind,
  itemMap,
  locate,
  placeKey,
  protectionGuard,
  reapproveLines,
  relFile,
} from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { SCHEMAS_DIR } from "../lib/validate.ts";
import { parseYamlText } from "../lib/yaml.ts";

interface Prop {
  type?: string;
  enum?: unknown[];
}

// The keys the JSON Schema allows on an item of this kind.
function schemaProperties(kind: ItemKind): Record<string, Prop> {
  const file = kind === "metric" ? "metrics" : kind === "access" ? "access" : "model";
  const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${file}.schema.json`), "utf8")) as {
    properties: Record<string, Prop>;
    $defs: Record<string, { properties: Record<string, Prop> }>;
  };
  return kind === "model" || kind === "access" ? schema.properties : schema.$defs[kind]!.properties;
}

// Keys another command owns, with the command to use instead. sl rename, sl add-field and
// sl remove-field are not in this version yet.
const LATER = "is not in this version yet; until it is, edit the model file and run sl validate";
const OWNED: Record<string, string> = {
  name: `renaming changes every reference to the item, which sl rename does (it ${LATER})`,
  model: `a model's name is its file name, which sl rename changes (it ${LATER})`,
  dimensions: `fields are added and removed one at a time with sl add-field and sl remove-field (each ${LATER})`,
  measures: `fields are added and removed one at a time with sl add-field and sl remove-field (each ${LATER})`,
  joins: `fields are added and removed one at a time with sl add-field and sl remove-field (each ${LATER})`,
  ignored_columns: "use sl ignore-column --source <s> --model <m> --column <c>",
  open_questions: 'use sl question add <ref> --text "<question>"',
  evidence: "sl check-join measures the join and writes its evidence",
};

// The access.yaml keys sl set takes; roles, restrictions and user attributes are larger edits.
const ACCESS_KEYS = ["mode", "default_role"];

// The value as written, trimmed: text for a key whose schema is text or a choice of words (so an expr keeps
// its quotes, colons and #), and YAML for every other key, so [a, b] is a list and true a boolean.
function parseValue(key: string, raw: string, prop: Prop): unknown {
  const words = Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === "string");
  if (prop.type === "string" || words) return raw.trim();
  const value = parseYamlText(raw, `the value of ${key}`);
  if (prop.type === "array" && !Array.isArray(value)) throw new UserError(`${key} is a list: write it as [a, b], for example [${raw.trim()}].`);
  return value;
}

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

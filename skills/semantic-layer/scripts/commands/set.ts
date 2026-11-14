import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, isSeq, type Node } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { bool } from "../lib/command.ts";
import { ENTRY_KEYS, ENTRY_KINDS, type EntryKind, accessEditLines, READBACK_NEXT, setEntryKey } from "../lib/access-edit.ts";
import {
  accessDraftLines,
  accessToDraft,
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
import { loadProject, paths } from "../lib/project.ts";
import { createAccess, GOLDEN_KEYS, setGolden, setSource, type SetOutcome, SOURCE_KEYS } from "../lib/set-targets.ts";

// Keys another command owns, with the command to use instead.
const FIELDS = "fields are added and removed one at a time with sl add-field <source.model> and sl remove-field <source.model.field>";
const OWNED: Record<string, string> = {
  name: "renaming changes every reference to the item, which sl rename <ref> <new_name> updates in one write",
  model: "a model's name is its file name, and renaming it moves the file and updates every reference, which sl rename <source.model> <new_name> does in one write",
  dimensions: FIELDS,
  measures: FIELDS,
  joins: FIELDS,
  ignored_columns: "use sl ignore-column --source <s> --model <m> --column <c>",
  open_questions: 'use sl question add <ref> --text "<question>"',
  evidence: "sl check-join measures the join and writes its evidence",
};

// The access.yaml keys sl set takes at the top level; a role, restriction or user attribute is named as <kind>:<name>.
const ACCESS_KEYS = ["mode", "default_role"];
const ACCESS_ENTRY = new RegExp(`^(${ENTRY_KINDS.join("|")}):(.*)$`, "s");
const ACCESS_COMMANDS =
  "A role, restriction or user attribute is added with sl add-role, sl add-restriction or sl add-attribute (sl remove-* removes one), a row filter with sl add-row-filter, " +
  "and one key of an existing one is set with sl set access role:<name> | restriction:<name> | attribute:<name> <key> <value>";

function scalarsOnly(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => x === null || typeof x !== "object");
}

// Prints the outcome of a golden, source or new access.yaml edit as the other sl set calls print theirs.
function report(ctx: Parameters<CommandSpec["run"]>[1], ref: string, key: string, unset: boolean, o: SetOutcome): number {
  const { notes, value, ...rest } = o;
  if (ctx.json) {
    ctx.out(formatJson({ ...rest, ref, key, value }));
    return 0;
  }
  if (!o.changed) ctx.out(`${ref} already has ${unset ? `no ${key}` : `that ${key}`}; nothing changed. Next: sl status.`);
  else ctx.out([...(o.created ? [] : [unset ? `Removed ${key} from ${ref} in ${o.file}.` : `Set ${key} on ${ref} in ${o.file}.`]), ...notes].join("\n"));
  return 0;
}

const spec: CommandSpec = {
  summary: "Set one key of a model, field, metric, golden, source or the access file, validating before it writes.",
  usage:
    "set <source.model | source.model.field | metric:<name> | access> <key> (<value> | --unset)\n" +
    `       sl set access (${ENTRY_KINDS.map((k) => `${k}:<name>`).join(" | ")}) <key> (<value> | --unset)\n` +
    `       sl set golden:<name> (${GOLDEN_KEYS.join(" | ")}) (<value> | --unset)\n` +
    `       sl set source:<name> ${SOURCE_KEYS.join(" | ")} (<value> | --unset)\n\n` +
    "With no access.yaml, sl set access mode open|closed creates a draft one holding that mode.\n" +
    `Keys of a role: ${Object.keys(ENTRY_KEYS.role).join(", ")}; of a restriction: ${Object.keys(ENTRY_KEYS.restriction).join(", ")};\n` +
    `of an attribute: ${Object.keys(ENTRY_KEYS.attribute).join(", ")}. A list is written a,b. An edit to an approved access.yaml makes it a draft again.`,
  options: { unset: { type: "boolean" } },
  positionals: true,
  writes: "whole",
  async run({ values, positionals }, ctx) {
    loadProject(ctx.root);
    const unset = bool(values, "unset");
    const entry = positionals[0] === "access" ? ACCESS_ENTRY.exec(positionals[1] ?? "") : null;
    if (entry) {
      const [, , k, v, ...more] = positionals;
      const [, kind, name] = entry as unknown as [string, EntryKind, string];
      if (!k || (unset ? v !== undefined : v === undefined) || more.length)
        throw new UserError(`Usage: sl set access ${kind}:<name> <key> <value>, or --unset in place of the value. Keys of a ${kind}: ${Object.keys(ENTRY_KEYS[kind]).join(", ")}.`);
      const o = setEntryKey(ctx.root, kind, name, k, unset ? undefined : v);
      const target = `${kind} ${name}`;
      if (ctx.json) ctx.out(formatJson({ ...o, ref: "access", [kind]: name, key: k }));
      else if (!o.changed) ctx.out(`${target} already has ${unset ? `no ${k}` : `that ${k}`}; nothing changed. Next: sl status.`);
      else ctx.out([unset ? `Removed ${k} from ${target} in ${o.file}.` : `Set ${k} on ${target} in ${o.file}.`, ...accessEditLines(o, `sl access shows what people see; ${READBACK_NEXT}`)].join("\n"));
      return 0;
    }
    const [ref, key, raw, ...extra] = positionals;
    if (!ref || !key || (unset ? raw !== undefined : raw === undefined) || extra.length) {
      throw new UserError(
        'Usage: sl set <ref> <key> <value>, or sl set <ref> <key> --unset. Quote a value with spaces: sl set warehouse.orders.revenue description "Order value."',
      );
    }
    const named = /^(golden|source):(.*)$/s.exec(ref);
    if (named) {
      const [, kind, name] = named as unknown as [string, "golden" | "source", string];
      if (!/^[a-z][a-z0-9_]*$/.test(name))
        throw new UserError(`${kind} names are lower-case letters, digits and _, starting with a letter, not ${JSON.stringify(name)}; sl status lists them.`);
      const set = kind === "golden" ? setGolden : setSource;
      return report(ctx, ref, key, unset, set(ctx.root, name, key, unset ? undefined : raw));
    }
    if (ref === "access" && !existsSync(paths(ctx.root).access)) {
      if (key !== "mode" || unset)
        throw new UserError(`No access.yaml yet. Ask the owner the exceptions question first (sl status names it), then create it with sl set access mode open (or closed for an allowlist).`);
      return report(ctx, ref, key, unset, createAccess(ctx.root, raw!.trim()));
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
      throw new UserError(`sl set access takes ${ACCESS_KEYS.join(" or ")} at the top level. ${ACCESS_COMMANDS}. sl access shows the result.`);
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
    const guard = key === "tags" ? protectionGuard(ref, tagsOf(loc.item.tags), tagsOf(value)) : undefined;
    // An approved access.yaml is written as a draft again, so the edit applies only once the owner approves it.
    let drafted: ReturnType<typeof accessToDraft>;
    const outcome = commitEdit(ctx.root, loc.file, what, (doc) => {
      const map = itemMap(doc, loc.path);
      if (loc.kind === "access") drafted = accessToDraft(doc);
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
      ctx.out(formatJson({ ...outcome, ...result, ...(drafted ? { returned_to_draft: true, ...drafted } : {}) }));
      return 0;
    }
    const lines = [unset ? `Removed ${key} from ${ref} in ${outcome.file}.` : `Set ${key} on ${ref} in ${outcome.file}.`];
    lines.push(...reapproveLines(outcome.reapprove), ...(drafted ? accessDraftLines(drafted) : []));
    if (!outcome.reapprove.length) lines.push("Next: sl status.");
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

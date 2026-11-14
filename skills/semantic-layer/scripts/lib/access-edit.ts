// Typed edits of access.yaml's rules: user attributes, roles, restrictions and row filters (sl
// add-attribute, add-role, add-restriction, add-row-filter, their remove-* commands, and sl set
// access role:<name> | restriction:<name> | attribute:<name> <key>). Each goes through commitEdits
// (lib/edit.ts): comments and untouched bytes stay, the project is validated with the edit, and
// nothing is written when it adds an error. A restriction target that matches nothing is refused
// too. An approved access.yaml is written as a draft again in the same edit (accessToDraft).
import { isMap, isScalar, isSeq, type Document, type Node, type YAMLMap, type YAMLSeq } from "yaml";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LastApproval } from "./access.ts";
import { checkRule } from "./compiler/check-rule.ts";
import { conditionAttributes, parseCondition } from "./conditions.ts";
import { accessDraftLines, accessToDraft, commitEdits, itemMap, locate, oneLine, placeKey, relFile } from "./edit.ts";
import { UserError } from "./errors.ts";
import { listGoldens, listModels, loadSnapshot, loadSource, paths, stem } from "./project.ts";
import { USER_PLACEHOLDER } from "./sql-text.ts";
import { NAME_PATTERN } from "./types.ts";
import type { Issue } from "./validate.ts";
import { parseYamlText } from "./yaml.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");

export type EntryKind = "attribute" | "role" | "restriction";
export const ENTRY_KINDS: readonly EntryKind[] = ["role", "restriction", "attribute"];
const SECTION: Record<EntryKind, string> = { attribute: "user_attributes", role: "roles", restriction: "restrictions" };
const WORD: Record<EntryKind, string> = { attribute: "user attribute", role: "role", restriction: "restriction" };
const ADD: Record<EntryKind, string> = {
  attribute: "sl add-attribute --name <name> --type string|number|string_list|number_list",
  role: "sl add-role --name <name>",
  restriction: "sl add-restriction --name <name> --targets <ref>,... (--roles <role>,... | --when <condition>)",
};

export const ATTRIBUTE_TYPES = ["string", "number", "string_list", "number_list"] as const;
// The condition syntax, as the commands' --help and refusals print it.
export const CONDITION_HELP =
  "A condition tests user attributes, never SQL: user.department == 'finance', user.level >= 3, user.region in ['emea', 'apac'], " +
  "user.teams contains 'sales', user.employee_id is set; join tests with and, or, not and parentheses.";

// The keys an entry takes besides its name, in file order: text, a condition, a list of names or
// patterns, or one of a choice of words. A dotted key sits inside allow or deny.
type KeyType = "text" | "condition" | "list" | readonly string[];
export const ENTRY_KEYS: Record<EntryKind, Record<string, KeyType>> = {
  attribute: { type: ATTRIBUTE_TYPES, description: "text" },
  role: { description: "text", assign_when: "condition", "allow.models": "list", "allow.tags": "list", "deny.models": "list", "deny.fields": "list", "deny.tags": "list" },
  restriction: { description: "text", targets: "list", "allow.roles": "list", "allow.when": "condition" },
};
const REQUIRED: Record<EntryKind, string[]> = { attribute: ["type"], role: [], restriction: ["targets"] };

// Where a new key goes: after the nearest key before it in these lists, else before the next one.
const TOP = ["status", "last_approved", "approved_by", "approved_at", "approved_hash", "mode", "default_role", "user_attributes", "roles", "restrictions", "open_questions"];
const ORDER: Record<string, string[]> = {
  attribute: ["name", "type", "description"],
  role: ["name", "description", "assign_when", "allow", "deny", "row_filters", "open_questions"],
  restriction: ["name", "description", "targets", "allow"],
  allow: ["models", "tags", "roles", "when"],
  deny: ["models", "fields", "tags"],
};

export interface AccessEditOutcome {
  changed: boolean;
  // access.yaml, relative to the semantic root.
  file: string;
  reapprove: string[];
  // The warnings sl validate gives that the edit added, each as "<path>: <message>".
  warnings: string[];
  // Present when access.yaml was approved and the edit made it a draft again.
  returned_to_draft?: true;
  last_approved?: LastApproval;
}

// Warnings an edit is refused for: a restriction target that matches nothing, or an allow tag that
// hides nothing (most likely a typo), since either would set the approval aside for no effect.
const NO_TARGET = (i: Issue) =>
  i.file === "access.yaml" &&
  ((/^restrictions\[\d+\]\.targets\[\d+\]$/.test(i.path) && / matches no (metric|model or field)/.test(i.message)) ||
    (/^roles\[\d+\]\.allow\.tags\[\d+\]$/.test(i.path) && / is not a protected tag/.test(i.message)));

function unchanged(root: string): AccessEditOutcome {
  return { changed: false, file: relFile(root, paths(root).access), reapprove: [], warnings: [] };
}

// Applies one edit of access.yaml's rules, which an approval covers: an approved file becomes a draft.
function commit(root: string, what: string, edit: (doc: Document, map: YAMLMap) => void): AccessEditOutcome {
  const file = paths(root).access;
  const issues: Issue[] = [];
  let set: ReturnType<typeof accessToDraft>;
  const apply = (doc: Document) => {
    edit(doc, itemMap(doc, []));
    set = accessToDraft(doc);
  };
  const o = commitEdits(root, [{ file, edit: apply }], what, undefined, undefined, { warnings: issues, refuse: NO_TARGET });
  const warnings = issues.map((i) => `${i.file === "access.yaml" ? "" : `${i.file} `}${i.path ? `${i.path}: ` : ""}${i.message}`);
  return { changed: o.changed, file: relFile(root, file), reapprove: o.reapprove, warnings, ...(o.changed && set ? { returned_to_draft: true as const, ...set } : {}) };
}

// The lines every access edit prints after its own: the warnings it added, the draft notice and the next command.
export function accessEditLines(o: AccessEditOutcome, next: string): string[] {
  return [...o.warnings.map((w) => `Warning: ${w}`), ...(o.returned_to_draft ? accessDraftLines(o) : []), `Next: ${next}`];
}
export const READBACK_NEXT = "when the owner's exceptions are all in, read the file back with sl readback --targets access.";

// A scalar list is written on one line ([pii, sensitive]); anything holding maps in block style.
function node(doc: Document, value: unknown): Node {
  const n = doc.createNode(value) as Node;
  const flow = (x: unknown): void => {
    if (isSeq(x)) {
      if (x.items.every((i) => !isMap(i) && !isSeq(i))) x.flow = true;
      else x.items.forEach(flow);
    } else if (isMap(x)) x.items.forEach((p) => flow(p.value));
  };
  flow(n);
  return n;
}

// Sets a key, an existing one in place (a single value keeps its trailing comment), a new one where `order` puts it.
function put(doc: Document, map: YAMLMap, key: string, value: unknown, order: string[]): void {
  const old = map.get(key, true);
  if (isScalar(old) && (value === null || typeof value !== "object")) return void (old.value = value);
  const i = order.indexOf(key);
  placeKey(doc, map, key, node(doc, value), i < 0 ? [] : order.slice(0, i).reverse(), i < 0 ? [] : order.slice(i + 1));
}

function append(doc: Document, map: YAMLMap, key: string, value: unknown, order: string[]): void {
  const seq = map.get(key, true);
  if (isSeq(seq) && seq.items.length) return void seq.items.push(node(doc, value));
  put(doc, map, key, [value], order);
}

// Removes one entry of a list; the last one takes the key with it.
function removeAt(map: YAMLMap, key: string, index: number): void {
  const seq = map.get(key, true);
  if (!isSeq(seq) || index >= seq.items.length) throw new UserError(`access.yaml changed while it was read; run this again.`);
  if (seq.items.length === 1) map.delete(key);
  else (seq as YAMLSeq).items.splice(index, 1);
}

function entryMap(doc: Document, kind: EntryKind, index: number): YAMLMap {
  return itemMap(doc, [SECTION[kind], index]);
}

function names(access: Obj, kind: EntryKind): string[] {
  return arr(access[SECTION[kind]]).flatMap((x) => (isObj(x) && typeof x.name === "string" ? [x.name] : []));
}

function find(access: Obj, kind: EntryKind, name: string): { index: number; item: Obj } {
  const index = arr(access[SECTION[kind]]).findIndex((x) => isObj(x) && x.name === name);
  if (index < 0) {
    const known = names(access, kind);
    throw new UserError(`No ${WORD[kind]} "${name}" in access.yaml. Known: ${known.join(", ") || "none"}. Check the spelling, or add it with ${ADD[kind].replace("<name>", NAME_PATTERN.test(name) ? name : "<name>")}.`);
  }
  return { index, item: arr(access[SECTION[kind]])[index] as Obj };
}

function checkName(kind: EntryKind, name: string | undefined): string {
  const n = (name ?? "").trim();
  if (!NAME_PATTERN.test(n)) throw new UserError(`A ${WORD[kind]} needs --name, a lowercase name matching ^[a-z][a-z0-9_]*$, such as ${kind === "attribute" ? "department" : kind === "role" ? "finance" : "refunds_finance_only"}; got ${JSON.stringify(name ?? "")}.`);
  return n;
}

// A condition as written, trimmed, refused with the syntax when it cannot be read.
function condition(label: string, raw: string): string {
  const text = raw.trim();
  try {
    parseCondition(text);
  } catch (e) {
    throw new UserError(`${label} is not a condition the layer can read: ${(e as Error).message}. ${CONDITION_HELP}`);
  }
  return text;
}

// A key's value as written: a list is a,b or [a, b].
function parse(kind: EntryKind, key: string, raw: string | string[]): unknown {
  const type = ENTRY_KEYS[kind][key]!;
  const text = Array.isArray(raw) ? raw.join(",") : raw;
  if (type === "text") {
    const t = oneLine(text);
    if (!t) throw new UserError(`${key} is empty; write it in the owner's words, or remove it with --unset.`);
    return t;
  }
  if (type === "condition") return condition(key, text);
  if (type === "list") {
    const yaml = !Array.isArray(raw) && text.trim().startsWith("[") ? parseYamlText(text, `the value of ${key}`) : undefined;
    if (yaml !== undefined && !(Array.isArray(yaml) && yaml.every((x) => typeof x === "string")))
      throw new UserError(`${key} is a list of names or patterns: write it as a,b or [a, b].`);
    const items = [...new Set(((yaml as string[] | undefined) ?? (Array.isArray(raw) ? raw : text.split(","))).map((x) => x.trim()).filter(Boolean))];
    if (!items.length) throw new UserError(`${key} is empty; write it as a,b${REQUIRED[kind].includes(key) ? "" : ", or remove it with --unset"}.`);
    return items;
  }
  if (!type.includes(text.trim())) throw new UserError(`${key} is ${type.slice(0, -1).join(", ")} or ${type[type.length - 1]}, not ${JSON.stringify(text.trim())}.`);
  return text.trim();
}

function getIn(item: Obj, key: string): unknown {
  const [head, sub] = key.split(".") as [string, string?];
  return sub === undefined ? item[head] : isObj(item[head]) ? (item[head] as Obj)[sub] : undefined;
}

// --- add and remove an attribute, role or restriction -----------------------------------------

// Adds an entry with the given keys (as ENTRY_KEYS names them), refusing a name already taken.
export function addEntry(root: string, kind: EntryKind, rawName: string | undefined, given: Record<string, string | string[] | undefined>): AccessEditOutcome & { entry: Obj } {
  const access = locate(root, "access").item;
  const name = checkName(kind, rawName);
  if (names(access, kind).includes(name))
    throw new UserError(`access.yaml already has a ${WORD[kind]} "${name}". Nothing was written. Pick another name, or change it with sl set access ${kind}:${name} <key> <value> (keys: ${Object.keys(ENTRY_KEYS[kind]).join(", ")}).`);
  const entry: Obj = { name };
  for (const key of Object.keys(ENTRY_KEYS[kind])) {
    const raw = given[key];
    if (raw === undefined || (Array.isArray(raw) && !raw.length)) continue;
    const [head, sub] = key.split(".") as [string, string?];
    if (sub === undefined) entry[head] = parse(kind, key, raw);
    else entry[head] = { ...((entry[head] as Obj | undefined) ?? {}), [sub]: parse(kind, key, raw) };
  }
  for (const key of REQUIRED[kind]) if (entry[key] === undefined) throw new UserError(`A ${WORD[kind]} needs --${key}. Usage: ${ADD[kind]}.`);
  if (kind === "restriction" && !isObj(entry.allow))
    throw new UserError(`A restriction needs --roles or --when: with neither, its targets are hidden from everyone. Usage: ${ADD.restriction}. ${CONDITION_HELP}`);
  const outcome = commit(root, `add ${WORD[kind]} ${name}`, (doc, map) => append(doc, map, SECTION[kind], entry, TOP));
  return { ...outcome, entry };
}

// What names a role or a user attribute, each with the command that changes it.
function referrers(root: string, access: Obj, kind: EntryKind, name: string): string[] {
  const out: string[] = [];
  const reads = (cond: unknown) => {
    try {
      return typeof cond === "string" && conditionAttributes(parseCondition(cond)).includes(name);
    } catch {
      return false;
    }
  };
  if (kind === "role" && access.default_role === name) out.push("default_role names it (sl set access default_role --unset)");
  for (const r of arr(access.restrictions).filter(isObj)) {
    const allow = isObj(r.allow) ? r.allow : {};
    const rest = strs(allow.roles).filter((x) => x !== name);
    const fix = rest.length ? `allow.roles ${rest.join(",")}` : "allow.roles --unset";
    if (kind === "role" && strs(allow.roles).includes(name)) out.push(`restriction ${String(r.name)} names it in allow.roles (sl set access restriction:${String(r.name)} ${fix})`);
    if (kind === "attribute" && reads(allow.when)) out.push(`restriction ${String(r.name)} reads it in allow.when (sl set access restriction:${String(r.name)} allow.when "<condition>")`);
  }
  if (kind === "attribute") {
    for (const r of arr(access.roles).filter(isObj)) {
      if (reads(r.assign_when)) out.push(`role ${String(r.name)} reads it in assign_when (sl set access role:${String(r.name)} assign_when "<condition>", or --unset)`);
      for (const rf of arr(r.row_filters).filter(isObj)) {
        const h = isObj(rf.hierarchy) ? rf.hierarchy : undefined;
        const inExpr = typeof rf.expr === "string" && [...rf.expr.matchAll(USER_PLACEHOLDER)].some((m) => m[1] === name);
        if (inExpr || (typeof h?.user === "string" && h.user.replace(/^user\./, "") === name))
          out.push(`role ${String(r.name)}'s row filter on ${String(rf.model)} reads it (sl remove-row-filter --role ${String(r.name)} --model ${String(rf.model)})`);
      }
    }
  }
  let goldens: ReturnType<typeof listGoldens> = [];
  try {
    goldens = listGoldens(root);
  } catch {
    // A golden that cannot be read names nothing here; sl validate reports it.
  }
  for (const { golden: g } of goldens) {
    if (kind === "role" && g?.role === name) out.push(`golden ${g.name} runs as it (sl set golden:${g.name} role --unset)`);
    if (kind === "attribute" && isObj(g?.user) && name in g.user) out.push(`golden ${g.name} sets it in user (sl set golden:${g.name} user '<json>', or --unset)`);
  }
  return out;
}

// Removes an entry, refusing while anything names it.
export function removeEntry(root: string, kind: EntryKind, rawName: string | undefined): AccessEditOutcome & { name: string } {
  const name = (rawName ?? "").trim();
  if (!name) throw new UserError(`Usage: sl remove-${kind} <name>.`);
  const access = locate(root, "access").item;
  const { index } = find(access, kind, name);
  const named = kind === "restriction" ? [] : referrers(root, access, kind, name);
  if (named.length)
    throw new UserError(
      `Cannot remove ${WORD[kind]} ${name}: ${named.length === 1 ? "this names" : "these name"} it, so nothing was written:\n${named.map((n) => `  - ${n}`).join("\n")}\n` +
        `Change or remove each one first, then run this again.`,
    );
  return { ...commit(root, `remove ${WORD[kind]} ${name}`, (_doc, map) => removeAt(map, SECTION[kind], index)), name };
}

// sl set access <kind>:<name> <key> (<value> | --unset).
export function setEntryKey(root: string, kind: EntryKind, name: string, key: string, raw: string | undefined): AccessEditOutcome & { value: unknown } {
  const access = locate(root, "access").item;
  const { index, item } = find(access, kind, name);
  const keys = Object.keys(ENTRY_KEYS[kind]);
  if (key === "name") throw new UserError(`sl set does not rename a ${WORD[kind]}: add it under the new name (${ADD[kind]}) and remove the old one (sl remove-${kind} ${name}).`);
  if (kind === "role" && key === "row_filters") throw new UserError(`Row filters are added and removed one at a time: sl add-row-filter --role ${name} --model <source.model> ..., sl remove-row-filter --role ${name} --model <source.model>.`);
  if (kind === "role" && key === "open_questions") throw new UserError(`A role's open questions are added with sl question add access.roles.${name} --text "<question>".`);
  if (!keys.includes(key)) throw new UserError(`A ${WORD[kind]} has no key "${key}". Keys sl set access ${kind}:${name} takes: ${keys.join(", ")}.`);
  if (raw === undefined && REQUIRED[kind].includes(key)) throw new UserError(`A ${WORD[kind]} needs ${key}; set another value, or remove the ${WORD[kind]} with sl remove-${kind} ${name}.`);
  const value = raw === undefined ? undefined : parse(kind, key, raw);
  if (isDeepStrictEqual(getIn(item, key), value)) return { ...unchanged(root), value: value ?? null };
  const other = key === "allow.roles" ? "allow.when" : "allow.roles";
  if (kind === "restriction" && raw === undefined && key.startsWith("allow.") && getIn(item, other) === undefined)
    throw new UserError(`Restriction ${name} needs allow.roles or allow.when: with neither, its targets are hidden from everyone. Nothing was written. Set ${other} first, or remove the restriction with sl remove-restriction ${name}.`);
  const [head, sub] = key.split(".") as [string, string?];
  const outcome = commit(root, `${raw === undefined ? "remove" : "set"} ${key} on ${WORD[kind]} ${name}`, (doc) => {
    const entry = entryMap(doc, kind, index);
    const inner = sub === undefined ? undefined : entry.get(head, true);
    if (sub === undefined) return value === undefined ? void entry.delete(head) : put(doc, entry, head, value, ORDER[kind]!);
    if (value !== undefined) return isMap(inner) ? put(doc, inner, sub, value, ORDER[head]!) : put(doc, entry, head, { [sub]: value }, ORDER[kind]!);
    if (!isMap(inner)) return;
    // The last key of allow or deny takes the map with it.
    if (inner.items.length === 1) entry.delete(head);
    else inner.delete(sub);
  });
  return { ...outcome, value: value ?? null };
}

// --- row filters --------------------------------------------------------------------------------

export interface RowFilterInput {
  role?: string;
  model?: string;
  expr?: string;
  // The hierarchy form: all five, with user as the attribute's name or user.<name>.
  column?: string;
  via?: string;
  manager?: string;
  member?: string;
  user?: string;
  exclude_self?: boolean;
}

const MODEL_REF = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const FILTER_USAGE =
  'sl add-row-filter --role <role> --model <source.model> --expr "<sql predicate>", or for a span of control --column <column> --via <source.model> --manager <column> --member <column> --user <attribute>';

function describe(rf: Obj): string {
  const h = isObj(rf.hierarchy) ? rf.hierarchy : undefined;
  return h ? `hierarchy: ${String(h.column)} under ${String(h.user)} in ${String(h.via)}` : `expr: ${oneLine(String(rf.expr))}`;
}

function roleAndModel(root: string, input: RowFilterInput, usage: string): { access: Obj; role: string; index: number; item: Obj; model: string } {
  const role = (input.role ?? "").trim();
  const model = (input.model ?? "").trim();
  if (!role || !model) throw new UserError(`Usage: ${usage}.`);
  if (!MODEL_REF.test(model)) throw new UserError(`--model is a model as source.model, such as warehouse.orders; got ${JSON.stringify(model)}. Run sl status to list the models.`);
  const access = locate(root, "access").item;
  return { access, role, model, ...find(access, "role", role) };
}

// Why an expr names a column the model's table lacks, as the compiler's rule check reads it (sl
// validate checks an expr's join references and text, not its plain column names), or undefined:
// also when the model, its source or its snapshot cannot be read, which sl validate reports.
function unknownColumn(root: string, modelRef: string, expr: string): string | undefined {
  const [source, name] = modelRef.split(".") as [string, string];
  try {
    const models = listModels(root, source).map((l) => ({ ...l.model, model: stem(basename(l.path)) }));
    const model = models.find((m) => m.model === name);
    if (!model) return undefined;
    const check = checkRule({ source: loadSource(root, source), snapshot: loadSnapshot(root, source), models, model, kind: "filter", text: expr.replace(USER_PLACEHOLDER, "NULL"), root });
    return !check.expressible && check.code === "unknown_column" ? `${check.reason}. ${check.suggestion.replace(/ and check the rule again\.$/, " and run this again.")}` : undefined;
  } catch {
    return undefined;
  }
}

// Adds a row filter to a role: an expr, or a hierarchy (a span of control over a closure model).
export function addRowFilter(root: string, input: RowFilterInput): AccessEditOutcome & { filter: Obj } {
  const { role, index, item, model } = roleAndModel(root, input, FILTER_USAGE);
  const parts = { column: input.column, via: input.via, manager: input.manager, member: input.member, user: input.user };
  const given = Object.entries(parts).filter(([, v]) => v !== undefined);
  let filter: Obj;
  if (input.expr !== undefined) {
    if (given.length || input.exclude_self) throw new UserError(`A row filter is an --expr or a hierarchy (--column, --via, --manager, --member, --user), not both. Usage: ${FILTER_USAGE}.`);
    if (!input.expr.trim()) throw new UserError("--expr is empty; write the predicate, such as \"region = {{ user.region }}\".");
    filter = { model, expr: input.expr.trim() };
    const unknown = unknownColumn(root, model, input.expr);
    if (unknown) throw new UserError(`Cannot add a row filter on ${model} to role ${role}: ${unknown} Nothing was written.`);
  } else {
    const missing = Object.entries(parts).filter(([, v]) => v === undefined || !v.trim()).map(([k]) => `--${k}`);
    if (missing.length) throw new UserError(`A row filter needs --expr, or all of --column, --via, --manager, --member and --user for a span of control; missing ${given.length ? missing.join(", ") : "--expr"}. Usage: ${FILTER_USAGE}.`);
    const user = parts.user!.trim().replace(/^user\./, "");
    if (!NAME_PATTERN.test(user)) throw new UserError(`--user is the user attribute holding the user's own id, such as employee_id; got ${JSON.stringify(parts.user)}.`);
    filter = { model, hierarchy: { column: parts.column!.trim(), via: parts.via!.trim(), manager: parts.manager!.trim(), member: parts.member!.trim(), user: `user.${user}`, include_self: !input.exclude_self } };
  }
  // The same filter again changes nothing; a hierarchy without include_self includes the user's own rows.
  const full = (rf: unknown) => (isObj(rf) && isObj(rf.hierarchy) ? { ...rf, hierarchy: { ...rf.hierarchy, user: `user.${String(rf.hierarchy.user).replace(/^user\./, "")}`, include_self: rf.hierarchy.include_self !== false } } : rf);
  if (arr(item.row_filters).some((rf) => isDeepStrictEqual(full(rf), filter))) return { ...unchanged(root), filter };
  const outcome = commit(root, `add a row filter on ${model} to role ${role}`, (doc) => append(doc, entryMap(doc, "role", index), "row_filters", filter, ORDER.role!));
  return { ...outcome, filter };
}

// Removes a role's row filter on a model; --index picks one when the role has several there.
export function removeRowFilter(root: string, input: RowFilterInput & { index?: string }): AccessEditOutcome & { filter: Obj } {
  const { role, index, item, model } = roleAndModel(root, input, "sl remove-row-filter --role <role> --model <source.model> [--index <n>]");
  const all = arr(item.row_filters);
  const on = all.map((rf, at) => ({ rf, at })).filter((x): x is { rf: Obj; at: number } => isObj(x.rf) && x.rf.model === model);
  if (!on.length) {
    const models = [...new Set(all.filter(isObj).map((rf) => String(rf.model)))];
    const has = models.length ? `its row filters are on ${models.join(", ")}` : "it has no row filters";
    throw new UserError(`Role ${role} has no row filter on ${model}; ${has}. Nothing was written. Next: sl access --roles ${role} shows what the role sees.`);
  }
  const listed = on.map((x, i) => `  ${i + 1}. ${describe(x.rf)}`).join("\n");
  const n = input.index === undefined ? (on.length === 1 ? 1 : 0) : /^\d+$/.test(input.index.trim()) ? Number(input.index.trim()) : 0;
  if (n < 1 || n > on.length)
    throw new UserError(`Role ${role} has ${on.length} row filter${on.length === 1 ? "" : "s"} on ${model}; pass --index 1${on.length > 1 ? ` to ${on.length}` : ""} to pick one:\n${listed}`);
  const picked = on[n - 1]!;
  const outcome = commit(root, `remove a row filter on ${model} from role ${role}`, (doc) => removeAt(entryMap(doc, "role", index), "row_filters", picked.at));
  return { ...outcome, filter: picked.rf };
}

// --- a role's open questions (sl question add|resolve access.roles.<role>) --------------------

// The role an access.roles.<role> ref names: its path in access.yaml and its parsed value.
export function locateRole(root: string, ref: string): { file: string; path: (string | number)[]; item: Obj } | undefined {
  const name = /^access\.roles\.(.+)$/s.exec(ref)?.[1];
  if (name === undefined) return undefined;
  const { index, item } = find(locate(root, "access").item, "role", name);
  return { file: paths(root).access, path: ["roles", index], item };
}

// sl set on the targets the approve-style refs do not cover: creating a draft access.yaml, a
// golden's role, user, reference and tolerance, and a source's description. Each write keeps the
// file's comments and every untouched byte, and is validated before it is written (lib/edit.ts).
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, type Document, type YAMLMap } from "yaml";
import { goldenHash } from "./approval-hash.ts";
import { commitEdit, itemMap, oneLine, placeKey, relFile } from "./edit.ts";
import { UserError } from "./errors.ts";
import { DEFAULT_TOLERANCE } from "./goldens.ts";
import { currentYes, LEDGER_FILE, ledgerReplies } from "./ledger.ts";
import { paths } from "./project.ts";
import { validateProject } from "./validate.ts";
import { readYamlIfExists } from "./yaml.ts";

type Obj = Record<string, unknown>;

export interface SetOutcome {
  changed: boolean;
  file: string;
  reapprove: string[];
  value: unknown;
  // Lines for the human output after the "Set ..." line; the last names the next command.
  notes: string[];
  created?: boolean;
}

// The access modes a new access.yaml takes.
export const ACCESS_MODES = ["open", "closed"];

// sl set access mode <open|closed> with no access.yaml: writes a draft file holding the mode, after
// validating the project as it would read it, and never over a file or a link already at the path.
export function createAccess(root: string, mode: string): SetOutcome {
  if (!ACCESS_MODES.includes(mode)) throw new UserError(`mode is open or closed, not "${mode}". Run sl set access mode open (or closed for an allowlist).`);
  const file = paths(root).access;
  const text = `mode: ${mode}\nstatus: draft\n`;
  const key = (i: { file: string; path: string; message: string }) => `${i.file}\0${i.path}\0${i.message}`;
  const known = new Set(validateProject(root).filter((i) => i.level === "error").map(key));
  const added = validateProject(root, new Map([[file, text]])).filter((i) => i.level === "error" && !known.has(key(i)));
  if (added.length) {
    const lines = added.map((i) => `  - ${i.file}${i.path ? ` ${i.path}` : ""}: ${i.message}`);
    // A golden's role or user waits for access.yaml; anything else is what the mode lets nobody see.
    const waiting = added.some((i) => i.file.startsWith("goldens/") && (i.path === "role" || i.path.startsWith("user.")));
    const hint = waiting
      ? "Remove the golden's role or user first (sl set golden:<g> role --unset, sl set golden:<g> user --unset), then run it again."
      : mode === "closed"
        ? "Closed mode lets nobody see anything until roles are added, so start with sl set access mode open, then add roles and switch to closed."
        : "Fix these first, then run it again; sl validate lists the project's errors.";
    throw new UserError(`Cannot create access.yaml: the project would not validate with it, so nothing was written:\n${lines.join("\n")}\n${hint}`);
  }
  let exists = false;
  try {
    lstatSync(file);
    exists = true;
  } catch {}
  // A link at the path, even one to nothing, could point outside the semantic root.
  if (exists) throw new UserError(`Refusing to create access.yaml: something is already at ${file} (a link, or a file written meanwhile). Nothing was written. Remove it or run sl validate.`);
  writeFileSync(file, text, { flag: "wx" });
  const notes = [
    `Created access.yaml as a draft with mode ${mode}${mode === "open" ? ": everyone sees every approved item, minus protected tags, restrictions and role denials" : ": a user sees only what a role's allow.models grants, and it has no roles yet, so nobody sees anything until roles are added"}.`,
    "Tools serve nothing under a draft access.yaml until it is approved.",
    "Next: sl access shows what the default audience sees; record exceptions with sl question add access --text \"<question>\", then read the file back with sl readback --targets access and approve it only on the owner's yes.",
  ];
  return { changed: true, created: true, file: relFile(root, file), reapprove: [], value: mode, notes };
}

// The keys sl set takes on a golden and a source.
export const GOLDEN_KEYS = ["role", "user", "reference", "tolerance"];
export const SOURCE_KEYS = ["description"];

const CONFIRM_FIELDS = ["status", "confirmed_by", "confirmed_at", "confirmed_as", "expected"];

function readItem(file: string, what: string, next: string): Obj {
  if (!existsSync(file)) throw new UserError(`No ${what} at ${file}. ${next}`);
  const item = readYamlIfExists<unknown>(file);
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new UserError(`${file} is not a mapping; run sl validate and fix it first.`);
  return item as Obj;
}

// The value of a golden key as written: user is a JSON object, tolerance a number from 0 up to 1
// (as sl goldens confirm --tolerance takes it), role and reference text.
function goldenValue(key: string, raw: string): unknown {
  if (key === "user") {
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch (e) {
      throw new UserError(`user is a JSON object of user attributes, such as '{"department": "sales"}': ${(e as Error).message}`);
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new UserError(`user is a JSON object of user attributes, such as '{"department": "sales"}'.`);
    // Attribute values are data text: control characters and line breaks are refused, not written.
    const texts = (x: unknown): string[] =>
      typeof x === "string" ? [x] : x && typeof x === "object" ? Object.entries(x).flatMap(([k, y]) => [k, ...texts(y)]) : [];
    if (texts(v).some((t) => /[\u0000-\u001f\u007f-\u009f]/.test(t)))
      throw new UserError(`user attribute names and values are plain one-line text with no control characters; got ${JSON.stringify(raw)}.`);
    return v;
  }
  if (key === "tolerance") {
    // A plain decimal, so 0x0 or 0b1 is not read as a number.
    const t = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(raw.trim()) ? Number(raw) : NaN;
    if (!Number.isFinite(t) || t < 0 || t >= 1) throw new UserError(`tolerance is a number from 0 up to 1, such as 0.005 (0 for figures finance signs off); got "${raw}".`);
    return t;
  }
  const text = key === "reference" ? oneLine(raw) : raw.trim();
  if (!text) throw new UserError(`${key} is empty; write it as text, or remove it with --unset.`);
  return text;
}

// sl set golden:<g> <key> (<value> | --unset). A confirmed golden's tolerance is refused, since only
// sl goldens confirm records it with the rows; a change to its role or user is written and named in
// reapprove until a recorded owner yes matches the golden again.
export function setGolden(root: string, name: string, key: string, raw: string | undefined): SetOutcome {
  const ref = `golden:${name}`;
  const file = paths(root).golden(name);
  const g = readItem(file, `golden "${name}"`, "Run sl goldens new --name <g> --question \"<question>\" --request <json> to write one, or sl status to list them.");
  const confirm = `sl readback --targets ${ref}, record the owner's answer with sl reply, then sl goldens confirm --name ${name}`;
  if (CONFIRM_FIELDS.includes(key) && key !== "expected")
    throw new UserError(`${key} is a confirmation field, which only sl goldens confirm writes, on the owner's recorded yes: ${confirm}.`);
  if (!GOLDEN_KEYS.includes(key))
    throw new UserError(
      `sl set ${ref} takes ${GOLDEN_KEYS.join(", ")}, not "${key}". The expected rows are recorded by sl goldens confirm; a new question or request is a new golden (sl goldens new).`,
    );
  const value = raw === undefined ? undefined : goldenValue(key, raw);
  // role and user are checked against access.yaml's roles and attributes, so they wait for the file.
  if ((key === "role" || key === "user") && value !== undefined && !existsSync(paths(root).access))
    throw new UserError(
      `There is no access.yaml yet, so a golden's ${key} cannot be checked against it. Nothing was written. Create access.yaml first with sl set access mode open (or closed for an allowlist), then run this again.`,
    );
  const confirmed = g.status === "approved";
  const expected = g.expected && typeof g.expected === "object" ? (g.expected as Obj) : undefined;
  // On a confirmed golden a missing tolerance is the default its confirmation hashed.
  const current = key === "tolerance" ? (expected?.tolerance ?? (confirmed && value !== undefined ? DEFAULT_TOLERANCE : undefined)) : g[key];
  if (isDeepStrictEqual(current, value)) return { changed: false, file: relFile(root, file), reapprove: [], value: value ?? null, notes: [] };
  if (key === "tolerance" && confirmed) {
    const t = value === undefined ? "<t>" : String(value);
    throw new UserError(
      `${ref} is confirmed, and its tolerance is what the owner said yes to with its rows; only sl goldens confirm records it. Nothing was written. ` +
        `Read it back at the new tolerance with sl readback --targets ${ref} --tolerance ${t}, record the owner's answer with sl reply, then run sl goldens confirm --name ${name} --tolerance ${t}.`,
    );
  }
  const outcome = commitEdit(root, file, `${value === undefined ? "remove" : "set"} ${key} on ${ref}`, (doc) => {
    const map = itemMap(doc, []);
    if (key !== "tolerance") {
      if (value === undefined) return void map.delete(key);
      const after = key === "role" ? ["question"] : key === "user" ? ["role", "question"] : ["cross_check_sql", "sql", "request"];
      return placeKey(doc, map, key, value, after, ["status"]);
    }
    const exp = map.get("expected", true);
    if (isMap(exp)) {
      if (value !== undefined) return placeKey(doc, exp as YAMLMap, "tolerance", value, [], ["rows"]);
      exp.delete("tolerance");
      // The expected: { rows: [] } a draft's tolerance left behind goes with it.
      if (exp.items.length === 1 && isDeepStrictEqual(expected?.rows, [])) map.delete("expected");
      return;
    }
    if (value !== undefined) placeKey(doc, map, "expected", { tolerance: value, rows: [] }, ["status"]);
  });
  const notes: string[] = [];
  const reapprove = confirmed && outcome.changed && unconfirmed(root, file, g) ? [ref] : [];
  if (reapprove.length)
    notes.push(
      `${ref} is confirmed and its ${key} changed, so its confirmation needs the owner's yes again: run sl goldens check --name ${name}, then ${confirm}.`,
    );
  else if (key === "tolerance") notes.push(`Next: sl readback --targets ${ref} reads it back at tolerance ${value ?? DEFAULT_TOLERANCE}.`);
  else notes.push(confirmed ? `Next: sl goldens check --name ${name}.` : `Next: sl goldens run --name ${name}.`);
  return { ...outcome, reapprove, value: value ?? null, notes };
}

// Whether the edit changed what a confirmed golden's hash covers and no recorded owner yes matches
// the golden as its file now stands (a change back to what the owner said yes to needs none).
function unconfirmed(root: string, file: string, before: Obj): boolean {
  const ledger = join(root, LEDGER_FILE);
  const replies = existsSync(ledger) ? ledgerReplies(readFileSync(ledger, "utf8")) : [];
  const hash = (g: Obj) => {
    const exp = (g.expected ?? {}) as Obj;
    return goldenHash(g, Array.isArray(exp.rows) ? exp.rows : [], typeof exp.tolerance === "number" ? exp.tolerance : DEFAULT_TOLERANCE);
  };
  const after = readYamlIfExists<Obj>(file) ?? {};
  return hash(after) !== hash(before) && !currentYes(replies, `golden:${String(before.name)}`, hash(after));
}

// sl set source:<s> description (<text> | --unset): the text folded to one plain line, as data text is.
export function setSource(root: string, name: string, key: string, raw: string | undefined): SetOutcome {
  const ref = `source:${name}`;
  const file = paths(root).source(name);
  const source = readItem(file, `source "${name}"`, "Run sl status to list the sources; sl setup adds one.");
  if (!SOURCE_KEYS.includes(key))
    throw new UserError(
      `sl set ${ref} takes ${SOURCE_KEYS.join(", ")}, not "${key}". sl setup writes a source's dialect, connection and intake.`,
    );
  const value = raw === undefined ? undefined : oneLine(raw);
  if (value === "") throw new UserError("description is empty; write what the source holds, in the owner's words, or remove it with --unset.");
  if (isDeepStrictEqual(source[key], value)) return { changed: false, file: relFile(root, file), reapprove: [], value: value ?? null, notes: [] };
  const outcome = commitEdit(root, file, `${value === undefined ? "remove" : "set"} ${key} on ${ref}`, (doc: Document) => {
    const map = itemMap(doc, []);
    if (value === undefined) return void map.delete(key);
    placeKey(doc, map, key, value, ["dialect", "source"]);
  });
  return { ...outcome, value: value ?? null, notes: ["Next: sl status."] };
}

#!/usr/bin/env bun
// The plugin's PreToolUse hook against hand edits (spec: Hand edits). Claude Code runs it before
// Edit, MultiEdit, Write, NotebookEdit and Bash with the call as JSON on stdin. For a file under a
// semantic root (a directory holding semantic.yaml) it exits 2, with the reason and the command to
// use on stderr, when the call would add, change or remove an approval field, change what an
// approved item's content hash covers, change a confirmed golden's recorded rows, or write
// .sl/ledger.jsonl or .sl/pending/ by hand. Before those checks, a call from one of the plugin's
// role agents (spec: Agent roles) is held to what lib/roles.ts lets that role run and edit.
// Anything else exits 0. The CLI's own checks (sl validate, sl approve) remain the guarantee; this
// hook stops the edit before it is made.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { accessEntry, carriesHash, metricEntries, modelEntries, type ApprovalEntry } from "../lib/approval-hash.ts";
import { commandList, DENIED_FLAGS, roleOf, slRefusal, type Role } from "../lib/roles.ts";
import { DIALECTS, type Dialect, type Model } from "../lib/types.ts";
import { parseYamlText } from "../lib/yaml.ts";
import { shellWrites, tokenize } from "./shell-writes.ts";

export interface Verdict {
  // false: the hook exits 2 and Claude Code refuses the call.
  allow: boolean;
  // The refusal, or a warning when the hook could not read its input and lets the call through.
  message?: string;
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// Keys only sl approve and sl goldens confirm write; status counts when it says approved.
const MARK_KEYS = ["approved_by", "approved_at", "approved_hash", "last_approved", "confirmed_by", "confirmed_at", "confirmed_as"];
// Approval fields in text that does not parse, read loosely (flow style and quoted keys too).
const STATUS_TEXT = /\bstatus["']?\s*:\s*["']?approved\b/;
const MARK_TEXT = new RegExp(`\\b(?:${MARK_KEYS.join("|")})\\b|${STATUS_TEXT.source}`);
const REPLY = 'sl reply --readback <id> --item <n> --text "<owner\'s words>" --verdict yes --by "<owner>"';
const LEDGER =
  "is written only by the CLI, so it records exactly what the owner heard and said: sl readback writes .sl/pending/, and sl reply, " +
  `sl question resolve and sl review apply append to .sl/ledger.jsonl. Record an owner's answer with ${REPLY.replace("yes", "yes|no|change")}.`;
const MAX_LINES = 5;
const TYPED = "sl set, sl tag, sl ignore-column, sl question add, sl add-field, sl remove-field or sl rename";

// A stable JSON text: object keys sorted.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

// The path with links resolved, for a file that may not exist yet.
function realPath(p: string): string {
  const rest: string[] = [];
  let cur = p;
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return p;
    rest.unshift(basename(cur));
    cur = up;
  }
  return join(realpathSync.native(cur), ...rest);
}

// The nearest directory holding semantic.yaml at or above `p`.
export function semanticRoot(p: string): string | undefined {
  for (let dir = p; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "semantic.yaml"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

type Area = "ledger" | "layer" | "dir";

// Which guarded part of the root a path is: the ledger and pending readbacks, a layer YAML file
// (models/, goldens/, metrics.yaml, access.yaml), or a directory holding either.
function areaOf(root: string, abs: string): { area: Area; rel: string } | undefined {
  const rel = relative(root, abs).split(sep).join("/");
  if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return undefined;
  if (rel === ".sl" || rel === ".sl/ledger.jsonl" || rel === ".sl/pending" || rel.startsWith(".sl/pending/")) return { area: "ledger", rel };
  if (rel === "" || rel === "models" || rel === "goldens") return { area: "dir", rel };
  if (rel === "metrics.yaml" || rel === "access.yaml") return { area: "layer", rel };
  if (/^(models|goldens)\//.test(rel)) {
    if (/\.ya?ml$/.test(rel)) return { area: "layer", rel };
    if (existsSync(abs) && statSync(abs).isDirectory()) return { area: "dir", rel };
  }
  return undefined;
}

function guarded(abs: string, self = false) {
  const real = realPath(abs);
  const root = semanticRoot(self ? real : dirname(real));
  const where = root ? areaOf(root, real) : undefined;
  return root && where ? { root, real, ...where } : undefined;
}

// --- YAML files ------------------------------------------------------------------------------

type FileKind = { kind: "model"; source: string; name: string } | { kind: "golden"; name: string } | { kind: "metrics" | "access" | "other" };

function fileKind(rel: string): FileKind {
  const m = /^models\/([^/]+)\/([^/]+)\.ya?ml$/.exec(rel);
  if (m) return { kind: "model", source: m[1]!, name: m[2]! };
  const g = /^goldens\/([^/]+)\.ya?ml$/.exec(rel);
  if (g) return { kind: "golden", name: g[1]! };
  return { kind: rel === "metrics.yaml" ? "metrics" : rel === "access.yaml" ? "access" : "other" };
}

function readText(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function parse(text: string | null, label: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: text === null ? null : parseYamlText(text, label) };
  } catch {
    return { ok: false };
  }
}

// Every approval field in a parsed file, keyed by where it sits: list items by name when they have
// one, so reordering a list moves nothing.
function marks(v: unknown, skip: ReadonlySet<string>, path = "", out = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(v)) {
    const seen = new Map<string, number>();
    v.forEach((x, i) => {
      let seg = String(i);
      if (isObject(x) && typeof x.name === "string") {
        const n = (seen.get(x.name) ?? 0) + 1;
        seen.set(x.name, n);
        seg = n > 1 ? `${x.name}#${n}` : x.name;
      }
      marks(x, skip, `${path}[${seg}]`, out);
    });
  } else if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === "status" && x === "approved") out.set(`${path}\u0000status`, "approved");
      else if (MARK_KEYS.includes(k)) out.set(`${path}\u0000${k}`, canonical(x));
      else if (!(path === "" && skip.has(k))) marks(x, skip, path ? `${path}.${k}` : k, out);
    }
  }
  return out;
}

interface Violation {
  ref: string;
  what: "changed" | "via_join" | "removed" | "renamed" | "approval" | "expected";
  keys?: string[];
}

function sourceDialect(root: string, source: string): Dialect | undefined {
  const p = parse(readText(join(root, "sources", `${source}.yaml`)), "source");
  const d = p.ok && isObject(p.value) ? p.value.dialect : undefined;
  return typeof d === "string" && (DIALECTS as readonly string[]).includes(d) ? (d as Dialect) : undefined;
}

// The approved items of `before` whose content `after` changes or drops, unless the change restores
// the content their approved_hash records.
function contentViolations(before: ApprovalEntry[], after: ApprovalEntry[], what: "changed" | "via_join"): Violation[] {
  const now = new Map(after.map((e) => [e.ref, e]));
  const out: Violation[] = [];
  for (const b of before) {
    if (b.item.status !== "approved") continue;
    const a = now.get(b.ref);
    if (!a) out.push({ ref: b.ref, what: "removed" });
    else if (a.hash !== b.hash && !(carriesHash(a.item) && String(a.item.approved_hash).trim() === a.hash)) out.push({ ref: b.ref, what });
  }
  return out;
}

// Model files of a source by file name, read from disk.
function sourceModels(root: string, source: string): Map<string, Model> {
  const dir = join(root, "models", source);
  const out = new Map<string, Model>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const p = parse(readText(join(dir, f)), f);
    if (p.ok && isObject(p.value)) out.set(f.replace(/\.ya?ml$/, ""), p.value as unknown as Model);
  }
  return out;
}

// The approval entries of a model file's parsed value, hashed with the source and model name as the
// file writes them (as sl validate and sl approve hash them); `of` names the file for a value
// without a model key. Lookups of the source's other models go by file name, as in sl validate.
function modelScope(root: string, k: { source: string; name: string }) {
  let siblings: Map<string, Model> | undefined;
  const others = () => (siblings ??= sourceModels(root, k.source));
  const dialects = new Map<string, Dialect | undefined>();
  const entries = (self: unknown, of: string = k.name, value: unknown = self): ApprovalEntry[] => {
    if (!isObject(value)) return [];
    const source = typeof value.source === "string" ? value.source : k.source;
    if (!dialects.has(source)) dialects.set(source, sourceDialect(root, source));
    const lookup = (n: string) => (n === k.name ? (isObject(self) ? (self as unknown as Model) : undefined) : others().get(n));
    return modelEntries(source, { ...(value as unknown as Model), model: typeof value.model === "string" ? value.model : of }, lookup, dialects.get(source));
  };
  return { entries, others };
}

function modelViolations(root: string, k: { source: string; name: string }, before: unknown, after: unknown): Violation[] {
  const { entries, others } = modelScope(root, k);
  const was = entries(before);
  // An approval covers the model's source and name: changing either key renames every item in it.
  const id = (v: unknown) => canonical(isObject(v) ? [v.source, v.model] : null);
  if (isObject(after) && id(before) !== id(after) && was.some((e) => e.item.status === "approved")) return [{ ref: was[0]!.ref, what: "renamed" }];
  const out = contentViolations(was, entries(after), "changed");
  // Fields of other models read through this model's joins (a second hop): changing a join here
  // changes their content too.
  if (canonical(isObject(before) ? before.joins : undefined) !== canonical(isObject(after) ? after.joins : undefined)) {
    for (const [name, m] of others()) {
      if (name === k.name) continue;
      out.push(...contentViolations(entries(before, name, m), entries(after, name, m), "via_join"));
    }
  }
  return out;
}

// Why the text `after`, which parses, may not replace a file that does not parse now, or undefined
// when it may: every approved item must match the approved_hash it records, a hash the file held
// before, and no approval field may appear more often than it did in the old text.
function repairProblem(root: string, kind: FileKind, before: string, after: string, value: unknown, marked: boolean): string | undefined {
  const scope = kind.kind === "model" ? modelScope(root, kind) : undefined;
  const own =
    scope
      ? scope.entries(value)
      : kind.kind === "metrics"
        ? metricEntries(isObject(value) ? value.metrics : undefined)
        : kind.kind === "access"
          ? [accessEntry(value)].filter((e): e is ApprovalEntry => e !== undefined)
          : undefined;
  if (!own) return marked ? `the hook cannot match its approval fields to ${kind.kind === "golden" ? "the rows a confirmed golden records" : "items"}` : undefined;
  // Fields of the source's other models that read through this model's joins count too; their
  // hashes are recorded in their own files.
  const others = scope && kind.kind === "model" ? [...scope.others()].filter(([n]) => n !== kind.name).flatMap(([n, m]) => scope.entries(value, n, m)) : [];
  for (const e of [...own, ...others]) {
    if (e.item.status !== "approved") continue;
    const h = carriesHash(e.item) ? String(e.item.approved_hash).trim() : "";
    if (h !== e.hash || (own.includes(e) && !before.includes(h))) return `approved ${e.ref} would not match the approved_hash it recorded`;
  }
  const fields: [string, RegExp][] = [...MARK_KEYS.map((k): [string, RegExp] => [k, new RegExp(`\\b${k}\\b`, "g")]), ["status: approved", new RegExp(STATUS_TEXT.source, "g")]];
  for (const [label, re] of fields) if ((after.match(re)?.length ?? 0) > (before.match(re)?.length ?? 0)) return `it would add an approval field (${label})`;
  return undefined;
}

function markViolations(kind: FileKind, before: unknown, after: unknown): Violation[] {
  const skip = new Set(kind.kind === "golden" ? ["expected"] : []);
  const was = marks(before, skip);
  const now = marks(after, skip);
  const byPath = new Map<string, Set<string>>();
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    if (was.get(key) === now.get(key)) continue;
    const [path, field] = key.split("\u0000") as [string, string];
    byPath.set(path, (byPath.get(path) ?? new Set()).add(field));
  }
  return [...byPath].map(([path, keys]) => ({ ref: refOf(kind, path), what: "approval" as const, keys: [...keys].sort() }));
}

function refOf(kind: FileKind, path: string): string {
  switch (kind.kind) {
    case "model": {
      const base = `${kind.source}.${kind.name}`;
      const f = /^(?:dimensions|measures|joins)\[([^\]#]+)/.exec(path);
      return path === "" ? base : f ? `${base}.${f[1]}` : `${base} (${path})`;
    }
    case "metrics": {
      const f = /^metrics\[([^\]#]+)/.exec(path);
      return f ? `metric:${f[1]}` : path ? `metrics.yaml (${path})` : "metrics.yaml";
    }
    case "access":
      return "access";
    case "golden":
      return `golden:${kind.name}`;
    case "other":
      return path || "the file";
  }
}

function message(v: Violation): string {
  const g = v.ref.startsWith("golden:") ? v.ref.slice("golden:".length) : undefined;
  switch (v.what) {
    case "approval":
      if (g !== undefined)
        return (
          `this edit changes the confirmation fields of ${v.ref} (${v.keys!.join(", ")}). Only sl goldens confirm writes them, on the owner's recorded yes: ` +
          `sl readback --targets ${v.ref}, ${REPLY}, then sl goldens confirm --name ${g}.`
        );
      return (
        `this edit changes the approval fields of ${v.ref} (${v.keys!.join(", ")}). Only sl approve writes them, on the owner's recorded yes: ` +
        `sl readback --targets ${v.ref}, ${REPLY}, then sl approve --target ${v.ref}. To make it a draft, run sl approve --target ${v.ref} --revoke.`
      );
    case "expected":
      return (
        `${v.ref} is confirmed, and its expected rows and tolerance are what the owner said yes to. Only sl goldens confirm records them: ` +
        `sl readback --targets ${v.ref} [--tolerance <t>], ${REPLY}, then sl goldens confirm --name ${g}.`
      );
    case "removed": {
      const head = `this edit removes or renames approved ${v.ref}.`;
      const revoke = `make it a draft first with sl approve --target ${v.ref} --revoke`;
      if (!v.ref.includes(":") && v.ref.split(".").length === 3) return `${head} Rename it with sl rename ${v.ref} <new_name> or remove it with sl remove-field ${v.ref}, or ${revoke}.`;
      if (v.ref.startsWith("metric:")) return `${head} Rename it with sl rename ${v.ref} <new_name>, or ${revoke}.`;
      return `${head} To remove it, ${revoke} --recursive, then remove it.`;
    }
    case "renamed":
      return (
        `this edit changes the model or source key of ${v.ref}, which holds approved items, and an approval covers the model's source and name. ` +
        `Make them drafts first with sl approve --target ${v.ref} --revoke --recursive, then rename the file and its model key together and read them back (sl readback --targets ${v.ref}).`
      );
    case "via_join":
      return (
        `${v.ref} is approved and reads through a join this edit changes, so the edit changes what the owner approved. ` +
        `Change the join with sl set <source.model.join> <key> <value>, which names every approved item to read back again, or revoke ${v.ref} first (sl approve --target ${v.ref} --revoke).`
      );
    case "changed":
      if (v.ref === "access")
        return (
          "access.yaml is approved, and this edit changes the rules the owner approved. Revoke it first (sl approve --target access --revoke; " +
          "the approved version keeps applying where it is deployed), edit the draft, then read it back with sl readback --targets access."
        );
      return (
        `${v.ref} is approved, and this edit changes what the owner approved. Use a typed edit (${TYPED}), which routes it back to the owner ` +
        `for re-approval, or make it a draft first with sl approve --target ${v.ref} --revoke. Descriptions and open questions are outside the approval and may be edited directly.`
      );
  }
}

// The violations of replacing a layer file's text `before` (null: no file) with `after` (null: deleted).
export function layerViolations(root: string, rel: string, before: string | null, after: string | null): string[] {
  const kind = fileKind(rel);
  const b = parse(before, rel);
  const a = parse(after, rel);
  if (!b.ok || !a.ok) {
    const has = (p: typeof b, text: string | null) => (p.ok ? marks(p.value, new Set()).size > 0 : MARK_TEXT.test(text ?? ""));
    const marked = has(b, before) || has(a, after);
    if (a.ok) {
      // A repair of a file that does not parse now (a merge conflict, say): allowed when it leaves
      // every approval as recorded, in this file and in fields that read through its joins.
      const why = repairProblem(root, kind, before ?? "", after ?? "", a.value, marked);
      return why
        ? [
            `${rel} does not parse as YAML now, and as this edit leaves it ${why}. A repair may change nothing an approval covers ` +
              `and add no approval field. Restore the committed file with git checkout -- ${rel} and redo the change with a typed edit (${TYPED}), or ask the owner to fix the file.`,
          ]
        : [];
    }
    if (!marked) return [];
    return [`${rel} holds approval fields and would not parse as YAML after this edit, so its approvals could not be checked. Make an edit that leaves valid YAML, or use a typed edit (${TYPED}).`];
  }
  const out: Violation[] = [];
  if (kind.kind === "model") out.push(...modelViolations(root, kind, b.value, a.value));
  if (kind.kind === "metrics") out.push(...contentViolations(metricEntries(isObject(b.value) ? b.value.metrics : undefined), metricEntries(isObject(a.value) ? a.value.metrics : undefined), "changed"));
  if (kind.kind === "access") {
    const was = accessEntry(b.value);
    const now = accessEntry(a.value);
    out.push(...contentViolations(was ? [was] : [], now ? [now] : [], "changed"));
  }
  if (kind.kind === "golden" && isObject(b.value) && b.value.status === "approved") {
    if (canonical(b.value.expected) !== canonical(isObject(a.value) ? a.value.expected : undefined)) out.push({ ref: `golden:${kind.name}`, what: "expected" });
  }
  out.push(...markViolations(kind, b.value, a.value));
  // One message per item: a content change explains a removed or changed approval field as well.
  const seen = new Set<string>();
  const lines = out.filter((v) => !seen.has(v.ref) && seen.add(v.ref)).map(message);
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `and ${lines.length - MAX_LINES} more approved items.`] : lines;
}

// --- Tool calls ------------------------------------------------------------------------------

const QUOTES: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"' };
const straight = (s: string) => s.replace(/[‘’“”]/g, (c) => QUOTES[c]!);

// The file text after one Edit-style replacement, matched as the Edit tool matches it (also with
// LF line endings and straight quotes); an Error when it cannot be applied.
function applyEdit(text: string | null, e: unknown): string | Error {
  if (!isObject(e) || typeof e.old_string !== "string" || typeof e.new_string !== "string") return new Error("old_string or new_string is missing");
  const { old_string: from, new_string: to } = e;
  if (from === "") return text === null || text === "" ? to : new Error("old_string is empty but the file exists");
  if (text === null) return new Error("the file does not exist");
  for (const t of [text, text.replace(/\r\n/g, "\n")]) {
    const at = straight(t).indexOf(straight(from));
    if (at < 0) continue;
    if (e.replace_all !== true) return t.slice(0, at) + to + t.slice(at + from.length);
    let out = "";
    let pos = 0;
    const hay = straight(t);
    const needle = straight(from);
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
      out += t.slice(pos, i) + to;
      pos = i + needle.length;
    }
    return out + t.slice(pos);
  }
  return new Error("old_string does not occur in the file as it now stands");
}

function refuse(lines: string[]): Verdict {
  return { allow: false, message: lines.join("\n") };
}

function fileCall(tool: string, input: Obj, cwd: string): Verdict {
  const raw = tool === "NotebookEdit" ? input.notebook_path : input.file_path;
  if (typeof raw !== "string" || !raw) return { allow: true, message: `semantic-layer hook: ${tool} input has no file path; not checked.` };
  const g = guarded(resolve(cwd, raw));
  if (!g || g.area === "dir") return { allow: true };
  const head = `semantic-layer: refused ${tool} on ${g.rel} in the semantic layer at ${g.root}:`;
  if (g.area === "ledger") return refuse([head, `- ${g.rel} ${LEDGER}`]);
  if (tool === "NotebookEdit") return refuse([head, `- ${g.rel} is not a notebook; change it with a typed edit (${TYPED}).`]);
  // From here the file is inside a semantic root: input that cannot be read is refused.
  try {
    const before = readText(g.real);
    let after: string | Error;
    if (tool === "Write") after = typeof input.content === "string" ? input.content : new Error("content is missing");
    else if (tool === "Edit") after = applyEdit(before, input);
    else if (Array.isArray(input.edits) && input.edits.length) {
      after = before ?? "";
      let text: string | null = before;
      for (const e of input.edits) {
        after = applyEdit(text, e);
        if (after instanceof Error) break;
        text = after;
      }
    } else after = new Error("edits is missing or empty");
    if (after instanceof Error)
      return refuse([head, `- the hook could not apply this edit to check it (${after.message}). Read the file again and retry, or use a typed edit (${TYPED}).`]);
    const problems = layerViolations(g.root, g.rel, before, after);
    return problems.length ? refuse([head, ...problems.map((p) => `- ${p}`)]) : { allow: true };
  } catch (e) {
    return refuse([head, `- the hook failed while checking it (${(e as Error).message}), so the edit is refused. Use a typed edit (${TYPED}), or retry.`]);
  }
}

// Expands a glob in a resolved path against the files that exist; the path itself is kept too.
function expand(p: string): string[] {
  const segs = p.split("/");
  const k = segs.findIndex((s) => /[*?[]/.test(s));
  if (k < 0) return [p];
  const base = segs.slice(0, k).join("/") || "/";
  const out = [p];
  if (!existsSync(base)) return out;
  for (const m of new Bun.Glob(segs.slice(k).join("/")).scanSync({ cwd: base, onlyFiles: false, dot: true })) {
    out.push(join(base, m));
    if (out.length > 2000) break;
  }
  return out;
}

function bashCall(input: Obj, cwd: string): Verdict {
  if (typeof input.command !== "string") return { allow: true, message: "semantic-layer hook: Bash input has no command; not checked." };
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const w of shellWrites(input.command, cwd)) {
    if (w.dynamic) {
      if (/(^|\/)\.sl\/(ledger\.jsonl|pending)(\/|$)/.test(w.path) && !seen.has(w.path)) {
        seen.add(w.path);
        lines.push(`- it may write ${w.path} (${w.how}), which names the answer ledger or a pending readback; that file ${LEDGER}`);
      }
      continue;
    }
    for (const p of expand(w.path)) {
      // semantic.yaml marks the root: removing or moving it would leave every guarded file unguarded.
      if (/^(rm|unlink|mv)$/.test(w.how) && basename(p) === "semantic.yaml" && existsSync(p) && !seen.has(p)) {
        seen.add(p);
        lines.push(`- it removes or moves ${p} (${w.how}), which marks the semantic layer at ${dirname(p)}. Leave it in place; change it with the Edit tool.`);
        continue;
      }
      const g = guarded(p, true);
      if (!g || seen.has(g.real)) continue;
      seen.add(g.real);
      const where = g.rel || "the semantic root itself";
      lines.push(
        g.area === "ledger"
          ? `- it writes ${where} in ${g.root} (${w.how}); ${g.rel} ${LEDGER}`
          : `- it writes ${where} in ${g.root} (${w.how}). A shell write cannot be checked against approvals: change YAML with a typed edit (${TYPED}), or edit a draft with the Edit tool, which this hook checks. Approvals come only from sl approve and sl goldens confirm on the owner's recorded yes.`,
      );
    }
  }
  return lines.length ? refuse(["semantic-layer: refused this shell command:", ...lines]) : { allow: true };
}

// --- Role agents -----------------------------------------------------------------------------

// The CLI entry this hook ships with: the only sl a role agent may run.
const SL_ENTRY = join(import.meta.dir, "..", "sl.ts");
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SEPARATORS = new Set([";", ";;", "&&", "||", "|", "|&", "&", "(", ")"]);
const OUTPUT_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
type Word = { word: string; dynamic: boolean; pattern?: boolean };
const isWord = (t: unknown): t is Word => isObject(t) && typeof t.word === "string";
const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
// Command prefixes the interviewer's sl invocations are read through (env SL_NOW=x bun <sl.ts> ...).
const PREFIXES = new Set(["env", "command", "exec", "nohup", "time", "nice"]);
const isDenied = (w: string) => DENIED_FLAGS.some((f) => w === f || w.startsWith(`${f}=`));

// Every word of a command, also inside its $(...) and `...`, to look for a flag no role passes.
function allWords(command: string, depth = 0): string[] {
  const subs: string[] = [];
  const words = tokenize(command, subs).flatMap((t) => (isWord(t) ? [t.word] : []));
  return depth < 3 ? [...words, ...subs.flatMap((x) => allWords(x, depth + 1))] : words;
}

// Why a role agent's shell command is refused: one line per problem, none when it may run it. For a
// role whose shell is "sl_only" every simple command must be `bun [run] <the plugin's sl.ts> ...`
// written out (no variable, no $(...), no unquoted pattern) or a `cd`; input comes only from a heredoc with a quoted
// delimiter or a <<< string, and output goes nowhere but the terminal and /dev/null. For any role,
// every sl invocation it can see must be one the role may run.
function roleShell(role: Role, command: string, cwd: string): string[] {
  const strict = role.shell === "sl_only";
  const subs: string[] = [];
  const toks = tokenize(command, subs);
  const out: string[] = [];
  const flag = allWords(command).find(isDenied);
  if (flag) out.push(`it passes ${flag.split("=")[0]}; protected values are for the owner to print by hand, so no agent passes it. Run the command without it.`);
  if (strict && subs.length) out.push("it runs a command inside $(...) or `...`, which the hook cannot check; write each value out.");
  // Every directory a cd may have left the shell in: a relative sl path must name the entry from each.
  const dirs = [cwd];
  const entry = realPath(SL_ENTRY);
  for (let i = 0; i < toks.length; i++) {
    const words: Word[] = [];
    for (; i < toks.length; i++) {
      const t = toks[i]!;
      if (isWord(t)) {
        words.push(t);
        continue;
      }
      const op = t.op;
      if (SEPARATORS.has(op)) break;
      if (op === "<<" || op === "<<-") {
        if (strict && t.quoted !== true)
          out.push("its heredoc's delimiter is not written as a plain quoted word, so the shell may expand the rows or end them elsewhere; write <<'ROWS'.");
        continue;
      }
      const target = toks[i + 1];
      const to = isWord(target) ? target : undefined;
      if (to) i++;
      if (!strict) continue;
      if (op === "<<<" && to && !to.dynamic) continue;
      if ((op === ">&" || op === "<&") && to && /^(\d+-?|-)$/.test(to.word)) continue;
      if (OUTPUT_REDIRECTS.has(op) && to?.word === "/dev/null") continue;
      out.push(`it uses the redirection ${op}${to ? ` ${to.word}` : ""}; a role agent writes no files and gives sl its input in a heredoc (<<'ROWS') or a <<< string.`);
    }
    if (!words.length) continue;
    let k = 0;
    // The interviewer's command is read through assignments and prefixes; a role that runs only sl has neither.
    while (!strict && k < words.length && (ASSIGNMENT.test(words[k]!.word) || PREFIXES.has(words[k]!.word) || (k > 0 && words[k - 1]!.word === "env" && words[k]!.word.startsWith("-"))))
      k++;
    const first = words[k];
    if (!first) continue;
    if (strict && ASSIGNMENT.test(first.word)) {
      out.push(`it sets ${first.word.split("=")[0]} before the command; a role agent runs sl with no variables set.`);
      continue;
    }
    if (first.word === "cd" && !first.dynamic) {
      const args = words.slice(k + 1);
      if (args.length > 1 || args.some((a) => a.dynamic || a.word.startsWith("-"))) {
        if (strict) out.push("it runs a cd the hook cannot follow; give sl.ts its absolute path instead.");
      } else for (const d of [...dirs]) if (dirs.length < 8) dirs.push(resolve(d, expandHome(args[0]?.word ?? "~")));
      continue;
    }
    const bun = !first.dynamic && (first.word === "bun" || (isAbsolute(first.word) && realPath(first.word) === realPath(process.execPath)));
    const at = bun && words[k + 1]?.word === "run" ? k + 2 : k + 1;
    const path = words[at];
    const sl =
      bun &&
      path !== undefined &&
      !path.dynamic &&
      // To allow a strict role's call the path must name the entry from every directory; to check an
      // interviewer's call, naming it from any is enough.
      (isAbsolute(expandHome(path.word)) ? [expandHome(path.word)] : dirs.map((d) => resolve(d, path.word)))[strict ? "every" : "some"]((p) => realPath(p) === entry);
    if (!sl) {
      if (strict) out.push(`it runs ${first.dynamic ? "a command named by a variable" : basename(first.word)}${bun ? " on a file other than the plugin's sl.ts" : ""}, and the ${role.title.toLowerCase()} runs only sl.`);
      continue;
    }
    const args = words.slice(at + 1);
    // The shell may turn a pattern into other words (--{show-protected,json}), so the hook cannot read it.
    if (words.some((w) => w.pattern)) {
      out.push("it passes sl an unquoted *, ?, [ or {, which the shell may expand into other arguments; quote that argument.");
      continue;
    }
    // A variable or a command's output may hold any flag (--show-protected), so no role passes one to sl.
    if (args.some((a) => a.dynamic)) {
      out.push("it passes sl a variable or a command's output; write each value out.");
      continue;
    }
    const why = slRefusal(role, args.map((a) => a.word));
    if (why && !(flag && args.some((a) => isDenied(a.word)))) out.push(why);
  }
  return [...new Set(out)];
}

const ROLE_TYPED = `Change it with a typed edit (${TYPED}, sl draft, or sl setup --view for a source's connection.views).`;

// The files inside a semantic root a shell command plainly writes, for a role that edits only outside
// one. Removing an abandoned plan under .sl/plans/ is the one shell write it makes there.
function layerShellWrites(command: string, cwd: string, who: string): string[] {
  const out: string[] = [];
  for (const w of shellWrites(command, cwd)) {
    if (w.dynamic) continue;
    for (const p of expand(w.path)) {
      const real = realPath(p);
      const root = semanticRoot(dirname(real));
      if (!root) continue;
      const rel = relative(root, real);
      if (/^(rm|unlink)$/.test(w.how) && rel.startsWith(join(".sl", "plans") + sep)) continue;
      out.push(`it writes ${rel} in ${root} (${w.how}), and ${who} never edits the semantic layer by hand. ${ROLE_TYPED}`);
    }
  }
  return [...new Set(out)];
}

// The role check of a call from one of the plugin's agents: a refusal, or undefined to go on to the
// checks every call gets.
function roleCall(role: Role, tool: string, input: Obj, cwd: string): Verdict | undefined {
  const who = `the ${role.title.toLowerCase()} (${role.agent})`;
  if (EDIT_TOOLS.has(tool)) {
    if (role.edits === "none")
      return refuse([`semantic-layer: refused ${tool} for ${who}:`, `- it edits no files. Report the change to the interviewer, who makes it with a typed edit (${TYPED}).`]);
    const raw = tool === "NotebookEdit" ? input.notebook_path : input.file_path;
    if (typeof raw !== "string" || !raw) return undefined;
    const real = realPath(resolve(cwd, raw));
    const root = semanticRoot(dirname(real));
    if (root)
      return refuse([`semantic-layer: refused ${tool} for ${who}:`, `- ${relative(root, real)} is in the semantic layer at ${root}, which ${who} never edits by hand. ${ROLE_TYPED}`]);
    return undefined;
  }
  if (tool !== "Bash" || typeof input.command !== "string") return undefined;
  const problems = roleShell(role, input.command, cwd);
  if (role.edits === "outside_layer") problems.push(...layerShellWrites(input.command, cwd, who));
  if (!problems.length) return undefined;
  return refuse([
    `semantic-layer: refused this shell command for ${who}:`,
    ...problems.map((p) => `- ${p}`),
    `It may run ${commandList(role)}, each as bun <skill dir>/scripts/sl.ts <command> with the path written out.`,
  ]);
}

// The verdict on one PreToolUse call, given the hook's stdin. Input that is not a tool call
// (not JSON, no tool name, no path or command) is let through with a warning: it names no file
// the hook could check. Inside a semantic root, input the hook cannot read is refused.
export function checkToolUse(stdin: string, fallbackCwd = process.cwd()): Verdict {
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    return { allow: true, message: "semantic-layer hook: the hook input is not JSON; not checked." };
  }
  if (!isObject(input) || typeof input.tool_name !== "string" || !isObject(input.tool_input))
    return { allow: true, message: "semantic-layer hook: the hook input has no tool_name or tool_input; not checked." };
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : fallbackCwd;
  // A call from one of the plugin's role agents: its role is checked first, and a failure refuses.
  const role = roleOf(input.agent_type);
  if (role) {
    try {
      const v = roleCall(role, input.tool_name, input.tool_input, cwd);
      if (v) return v;
    } catch (e) {
      return refuse([`semantic-layer: the hook failed while checking this call for the ${role.title.toLowerCase()} (${(e as Error).message}), so it is refused. Retry it.`]);
    }
  }
  try {
    switch (input.tool_name) {
      case "Edit":
      case "MultiEdit":
      case "Write":
      case "NotebookEdit":
        return fileCall(input.tool_name, input.tool_input, cwd);
      case "Bash":
        return bashCall(input.tool_input, cwd);
      default:
        return { allow: true };
    }
  } catch (e) {
    return { allow: true, message: `semantic-layer hook: could not check this call (${(e as Error).message}); not checked.` };
  }
}

if (import.meta.main) {
  const verdict = checkToolUse(await Bun.stdin.text());
  if (verdict.message) process.stderr.write(`${verdict.message}\n`);
  process.exit(verdict.allow ? 0 : 2);
}

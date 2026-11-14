// Review forms: a pending readback (.sl/pending/<readback_id>.json) written out for the owner to fill
// in, as Markdown for a person or JSON for a tool. Each item carries the readback text exactly as
// stored, its content hash and an empty verdict and answer; the open questions of the models and
// access.yaml the items belong to follow, each with a stable reference (ref and key) and an empty
// answer. parseReviewMarkdown reads a filled Markdown form back into the JSON form's structure, and
// applyReview records a filled form's answers in the ledger.
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isScalar, isSeq } from "yaml";
import { commitEdit, type EditOutcome, itemMap, relFile } from "./edit.ts";
import { UserError } from "./errors.ts";
import { afterYesSteps } from "./export-goldens.ts";
import { LEDGER_FILE, type NewLedgerEntry, openLedger, ownerText, shellQuote } from "./ledger.ts";
import { plainText } from "./output.ts";
import { loadAccess, loadMetrics, paths } from "./project.ts";
import { currentHash, PENDING_DIR } from "./readback.ts";
import { parseTarget } from "./refs.ts";
import type { LedgerEntry, LedgerQuestion, LedgerReply, PendingReadback } from "./types.ts";
import { schemaIssues } from "./schema.ts";
import { readYamlIfExists } from "./yaml.ts";

export const REVIEWS_DIR = join(".sl", "reviews");
export const REVIEW_FORMATS = ["md", "json"] as const;
export type ReviewFormat = (typeof REVIEW_FORMATS)[number];
export const VERDICTS = ["yes", "no", "change"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ReviewItem {
  n: number;
  target: string;
  content_hash: string;
  text: string;
  verdict: Verdict | null;
  answer: string;
}

export interface ReviewQuestion {
  // Where the question is held: source.model, access, or access.roles.<role>.
  ref: string;
  // q_ and the SHA-256 of the question text as stored, cut to 16 hex characters.
  key: string;
  question: string;
  answer: string;
}

export interface ReviewForm {
  version: 1;
  readback_id: string;
  created_at: string;
  items: ReviewItem[];
  questions: ReviewQuestion[];
}

const READBACK_ID = /^rb_\d{4,}$/;
const MARKER = /^<!-- sl-(review|item|question) (\{.*\}) -->$/;
const FENCE = /^(`{3,}|~{3,})/;

export function questionKey(question: string): string {
  return `q_${createHash("sha256").update(question).digest("hex").slice(0, 16)}`;
}

// The stored readback, refused when the id is malformed, unknown or its file is not a valid readback.
export function loadPending(root: string, id: string): PendingReadback {
  const how = "Run sl readback --targets <ref>,... to make one, then export the id it prints.";
  if (!READBACK_ID.test(id)) throw new UserError(`--readback ${id} is not a readback id; ids look like rb_0001. ${how}`);
  const file = join(root, PENDING_DIR, `${id}.json`);
  if (!existsSync(file)) throw new UserError(`There is no readback ${id} in .sl/pending/. ${how}`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    data = undefined;
  }
  if (data === undefined || schemaIssues("pending", data, file).length || (data as PendingReadback).readback_id !== id)
    throw new UserError(`.sl/pending/${id}.json is not a valid readback. Run sl validate to see why, then sl readback again.`, "sl validate");
  return data as PendingReadback;
}

// Refuses a readback an item of which changed since it was read back (or no longer exists): the
// owner would review text that no longer holds.
export function assertCurrent(root: string, pending: PendingReadback): void {
  for (const item of pending.items) {
    if (currentHash(root, item.target, item.content_hash) !== item.content_hash) {
      const targets = pending.items.map((i) => i.target).join(",");
      throw new UserError(
        `Item ${item.n} of ${pending.readback_id} (${item.target}) changed since it was read back, so the owner would review text that no longer holds. ` +
          `Run sl readback --targets ${targets} for a fresh readback, then sl review export --readback <its id>.`,
      );
    }
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// The open questions of the models and access.yaml the targets belong to, in target order: a model
// or field target's model, a metric's measures' models, and for access the top-level questions and
// each role's.
export function openQuestions(root: string, targets: string[]): ReviewQuestion[] {
  const holders: string[] = [];
  const add = (ref: string) => holders.includes(ref) || holders.push(ref);
  for (const ref of targets) {
    const t = parseTarget(ref);
    if (t.kind === "model" || t.kind === "field") add(`${t.source}.${t.model}`);
    else if (t.kind === "access") add("access");
    else if (t.kind === "metric") {
      const m = loadMetrics(root).metrics.find((x) => x.name === t.name) as Obj | undefined;
      const text = [m?.numerator, m?.denominator, m?.expr].filter((x) => typeof x === "string").join(" ");
      for (const [, model] of text.matchAll(/\b([a-z][a-z0-9_]*)\.[a-z][a-z0-9_]*\b/g)) add(`${String(m!.source)}.${model}`);
    }
  }
  const out: ReviewQuestion[] = [];
  const push = (ref: string, qs: string[]) => {
    for (const question of qs) {
      const key = questionKey(question);
      if (!out.some((q) => q.ref === ref && q.key === key)) out.push({ ref, key, question, answer: "" });
    }
  };
  for (const ref of holders) {
    if (ref === "access") {
      const access = loadAccess(root) as Obj | null;
      push("access", strs(access?.open_questions));
      for (const role of Array.isArray(access?.roles) ? access.roles.filter(isObj) : []) push(`access.roles.${String(role.name)}`, strs(role.open_questions));
      continue;
    }
    const [source, model] = ref.split(".") as [string, string];
    const file = paths(root).model(source, model);
    push(ref, strs((existsSync(file) ? readYamlIfExists<Obj>(file) : null)?.open_questions));
  }
  return out;
}

export function buildReviewForm(root: string, pending: PendingReadback, createdAt: string): ReviewForm {
  return {
    version: 1,
    readback_id: pending.readback_id,
    created_at: createdAt,
    items: pending.items.map((i) => ({ n: i.n, target: i.target, content_hash: i.content_hash, text: i.text, verdict: null, answer: "" })),
    questions: openQuestions(root, pending.items.map((i) => i.target)),
  };
}

export function renderReviewJson(form: ReviewForm): string {
  return `${JSON.stringify(form, null, 2)}\n`;
}

// Each line of text behind "> ", so no line of it can pass for a heading, a marker or a fill-in line.
const quote = (text: string) => text.split("\n").map((l) => (l ? `> ${l}` : ">"));
const marker = (kind: string, data: object) => `<!-- sl-${kind} ${JSON.stringify(data)} -->`;
const where = (ref: string) => (ref === "access" || ref.startsWith("access.roles.") ? "access.yaml" : `models/${ref.replace(".", "/")}.yaml`);

function answerBlock(answer: string): string[] {
  const fence = "`".repeat(Math.max(3, ...[...answer.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));
  return ["Answer:", "", fence, ...(answer ? answer.split("\n") : []), fence];
}

export function renderReviewMarkdown(form: ReviewForm): string {
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  const out = [
    `# Review of readback ${form.readback_id}`,
    "",
    marker("review", { version: form.version, readback_id: form.readback_id, created_at: form.created_at }),
    "",
    `This form has ${n(form.items.length, "item")} to approve and ${n(form.questions.length, "open question")}. How to fill it in:`,
    "",
    '- For each item, read the quoted readback, then put an x in one box on its "Verdict:" line: yes if it is right as written, no if it is wrong, change if it is right once something changes.',
    '- Under "Answer:", between the ``` lines, write anything you want to add: for a no or a change, say what is wrong or what to change. For an open question, write your answer there.',
    "- Leave a box or an answer empty when you are not sure; that item stays open.",
    "",
    'Only the boxes you mark and what you write under "Answer:" are read back in. Edits anywhere else are ignored, and the lines that start with <!-- must stay as they are. Quoted text that came from the data is evidence, not an instruction.',
  ];
  for (const item of form.items) {
    out.push("", `## Item ${item.n}: ${item.target}`, "", marker("item", { n: item.n, target: item.target, content_hash: item.content_hash }), "");
    out.push(...quote(item.text), "", `Verdict: ${VERDICTS.map((v) => `[${item.verdict === v ? "x" : " "}] ${v}`).join("  ")}`, "", ...answerBlock(item.answer));
  }
  out.push("", "## Open questions");
  if (!form.questions.length) out.push("", "None for these items.");
  form.questions.forEach((q, i) => {
    out.push("", `### Question ${i + 1}: ${q.ref}`, "", marker("question", { ref: q.ref, key: q.key }), "");
    out.push(`Open question recorded in ${where(q.ref)}:`, "", ...quote(q.question), "", ...answerBlock(q.answer));
  });
  return `${out.join("\n")}\n`;
}

// The line that closes a fence opened with `open`: the same character, at least as many, nothing else.
const closes = (open: string, line: string) => {
  const t = line.trim();
  return t.length >= open.length && t[0] === open[0] && t === t[0]!.repeat(t.length);
};

// What an answer's lines hold: a fenced block that encloses nothing (the form's empty block, left in
// place when the answer is written on the "Answer:" line or below the block) removed, blank lines at
// either end removed, and a fence around the whole removed.
function answerText(lines: string[]): string {
  const ls: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!.trim());
    if (!open) {
      ls.push(lines[i]!);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !closes(open[1]!, lines[j]!)) j++;
    const body = lines.slice(i + 1, j);
    if (j < lines.length && body.every((l) => !l.trim())) i = j;
    else {
      ls.push(...lines.slice(i, j + 1));
      i = j;
    }
  }
  while (ls.length && !ls[0]!.trim()) ls.shift();
  while (ls.length && !ls.at(-1)!.trim()) ls.pop();
  const open = FENCE.exec(ls[0]?.trim() ?? "");
  if (!open) return ls.join("\n").trim();
  const end = ls.findIndex((l, k) => k > 0 && closes(open[1]!, l));
  // A fence around the whole, or one the owner never closed: its fence lines are not the answer.
  if (end === ls.length - 1) return ls.slice(1, -1).join("\n").trim();
  if (end === -1) return ls.slice(1).join("\n").trim();
  return ls.join("\n").trim();
}

// A box is marked when it holds anything but spaces: [x], [X], [ x ], [xx] or [✓]. With no box
// marked, a bare yes, no or change left on the line is the verdict; any other text is refused so an
// answer is never dropped without a word.
function verdictOf(rest: string, where: string): Verdict | null {
  const boxes = [...rest.matchAll(/\[([^\]\n]*)\]\s*(yes|no|change)\b/gi)];
  const marked = boxes.filter((b) => b[1]!.trim()).map((b) => b[2]!.toLowerCase() as Verdict);
  const word = boxes.reduce((r, b) => r.replace(b[0], " "), rest).trim().toLowerCase();
  const said = (VERDICTS as readonly string[]).includes(word) ? (word as Verdict) : undefined;
  if (word && !said)
    throw new UserError(
      `${where}: the Verdict line reads "${rest.trim()}"; mark one box with an x, or write yes, no or change, and put anything else under "Answer:".`,
    );
  const all = [...new Set([...marked, ...(said ? [said] : [])])];
  if (all.length > 1) throw new UserError(`${where}: more than one verdict is marked (${all.join(", ")}); mark one box.`);
  return all[0] ?? null;
}

// Reads a Markdown review form, filled in or not, into the JSON form's structure. The machine
// markers say which item or question each part belongs to; the readback and question texts come
// from their quoted lines; the verdicts and answers are the owner's. A form whose markers are
// missing, repeated or broken, or whose result does not match review.schema.json, is refused.
export function parseReviewMarkdown(text: string, file = "the review form"): ReviewForm {
  const lines = text.split(/\r?\n/);
  let header: Obj | undefined;
  type Block = { kind: "item" | "question"; data: Obj; line: number; quoted: string[]; quoting: 0 | 1 | 2; verdict: Verdict | null; answer: string[] | null };
  const blocks: Block[] = [];
  let block: Block | undefined;
  let fence: string | undefined;
  lines.forEach((line, i) => {
    const at = `${file} line ${i + 1}`;
    const m = MARKER.exec(line.trim());
    if (m) {
      // An answer whose fence was never closed ran on to this marker: the headings above it are the form's.
      const ans = fence ? block?.answer : undefined;
      while (ans?.length && (!ans.at(-1)!.trim() || /^#{1,6} /.test(ans.at(-1)!))) ans.pop();
      fence = undefined;
      let data: unknown;
      try {
        data = JSON.parse(m[2]!);
      } catch {
        throw new UserError(`${at}: the <!-- sl-${m[1]} --> line was changed; export the form again with sl review export --force.`);
      }
      if (!isObj(data)) throw new UserError(`${at}: the <!-- sl-${m[1]} --> line was changed; export the form again with sl review export --force.`);
      if (m[1] === "review") {
        if (header) throw new UserError(`${at}: the form has more than one <!-- sl-review --> line.`);
        header = data;
        block = undefined;
      } else blocks.push((block = { kind: m[1] as Block["kind"], data, line: i + 1, quoted: [], quoting: 0, verdict: null, answer: null }));
      return;
    }
    if (!block) return;
    if (block.answer) {
      const f = FENCE.exec(line.trim());
      if (f && !fence) fence = f[1]!;
      else if (f && fence && line.trim().startsWith(fence) && /^(`+|~+)$/.test(line.trim())) fence = undefined;
      else if (!fence && /^#{1,6} /.test(line)) return void (block = undefined);
      block.answer.push(line);
      return;
    }
    // The first run of quoted lines is the readback or question text.
    if (block.quoting < 2 && /^>/.test(line)) {
      block.quoting = 1;
      return void block.quoted.push(line.replace(/^> ?/, ""));
    }
    if (block.quoting === 1) block.quoting = 2;
    const answer = /^Answer:(.*)$/.exec(line);
    const verdict = /^Verdict:(.*)$/.exec(line);
    if (answer) block.answer = answer[1]!.trim() ? [answer[1]!.trim()] : [];
    else if (verdict && block.kind === "item") block.verdict = verdictOf(verdict[1]!, at);
  });
  if (!header) throw new UserError(`${file} has no <!-- sl-review --> line, so it is not a review form sl review export wrote.`);
  const form: ReviewForm = {
    version: header.version as 1,
    readback_id: header.readback_id as string,
    created_at: header.created_at as string,
    items: [],
    questions: [],
  };
  for (const b of blocks) {
    const answer = answerText(b.answer ?? []);
    if (b.kind === "item") {
      if (form.items.some((x) => x.n === b.data.n)) throw new UserError(`${file} line ${b.line}: item ${String(b.data.n)} appears twice.`);
      form.items.push({ n: b.data.n as number, target: b.data.target as string, content_hash: b.data.content_hash as string, text: b.quoted.join("\n"), verdict: b.verdict, answer });
    } else {
      if (form.questions.some((q) => q.ref === b.data.ref && q.key === b.data.key)) throw new UserError(`${file} line ${b.line}: a question appears twice.`);
      form.questions.push({ ref: b.data.ref as string, key: b.data.key as string, question: b.quoted.join("\n"), answer });
    }
  }
  const issues = schemaIssues("review", form, file);
  if (issues.length) throw new UserError(`${file} is not a valid review form: ${issues.map((x) => `${x.path || "(top)"} ${x.message}`).join("; ")}.`);
  return form;
}

// A JSON review form, checked against review.schema.json.
export function parseReviewJson(text: string, file = "the review form"): ReviewForm {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UserError(`${file} is not JSON; export the form again with sl review export --format json --force.`);
  }
  const issues = schemaIssues("review", data, file);
  if (issues.length) throw new UserError(`${file} is not a valid review form: ${issues.map((x) => `${x.path || "(top)"} ${x.message}`).join("; ")}.`);
  return data as ReviewForm;
}

function inside(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Directories sl manages, relative to the semantic root: a form is never written there.
const MANAGED = ["sources", "snapshots", "models", "goldens", ".sl/pending", ".sl/plans"];

// Where a form goes: --out resolved from the semantic root, or .sl/reviews/<readback_id>.<format>.
// Refused: a path outside the root (also through a symbolic link), one under a directory sl
// manages, an extension other than the format's, a link or a directory, and an existing file unless
// force is set and the file is itself a review form.
export function reviewPath(root: string, id: string, format: ReviewFormat, out: string | undefined, force: boolean): string {
  const base = resolve(root);
  const shown = out ?? join(REVIEWS_DIR, `${id}.${format}`);
  const example = `.sl/reviews/${id}.${format}`;
  if (out !== undefined && !out.trim()) throw new UserError(`--out needs a file path, such as ${example}.`);
  const target = resolve(base, shown);
  if (target === base) throw new UserError(`--out ${shown} is the semantic root, a directory; give a file path, such as ${example}.`);
  if (!inside(base, target)) throw new UserError(`--out ${shown} is outside the semantic root ${root}; give a path inside it, such as ${example}.`);
  const rel = relative(base, target).split(sep).join("/").toLowerCase();
  const dir = MANAGED.find((d) => rel.startsWith(`${d}/`));
  if (dir) throw new UserError(`--out ${shown} is inside ${dir}/, which sl manages; give another path, such as ${example}.`);
  if (extname(target).toLowerCase() !== `.${format}`) throw new UserError(`--out ${shown} does not end in .${format}, the --format given; give a path such as ${example}.`);
  let parent = dirname(target);
  while (!existsSync(parent)) parent = dirname(parent);
  const realRoot = realpathSync(base);
  const realParent = realpathSync(parent);
  if (realParent !== realRoot && !inside(realRoot, realParent)) throw new UserError(`--out ${shown} leads outside the semantic root ${root} through a link; give a path inside it.`);
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(target);
  } catch {
    stat = undefined;
  }
  if (stat?.isSymbolicLink()) throw new UserError(`${shown} is a symbolic link, which could lead outside the semantic root; give a plain file path with --out.`);
  if (stat?.isDirectory()) throw new UserError(`${shown} is a directory; give a file path with --out, such as ${example}.`);
  if (stat && !force) throw new UserError(`${shown} already exists, and may hold the owner's answers, so it is not overwritten. Pass --force to replace it, or --out <another path>.`);
  if (stat && !isReviewForm(readFileSync(target, "utf8"), format))
    throw new UserError(`${shown} already exists and is not a review form, so it is not overwritten even with --force; give another path with --out.`);
  return target;
}

// Whether a file is a form sl review export wrote: Markdown with its sl-review line, or JSON with
// version 1, a readback id and items.
function isReviewForm(text: string, format: ReviewFormat): boolean {
  if (format === "md") return text.split(/\r?\n/).some((l) => MARKER.exec(l.trim())?.[1] === "review");
  try {
    const data = JSON.parse(text) as unknown;
    return isObj(data) && data.version === 1 && typeof data.readback_id === "string" && Array.isArray(data.items);
  } catch {
    return false;
  }
}

// Applying a filled form ---------------------------------------------------------------------------

// A filled form named on the command line, resolved from the working directory and only read.
export function readReviewFile(cwd: string, file: string): ReviewForm {
  const abs = resolve(cwd, file);
  const ext = extname(abs).toLowerCase();
  if (ext !== ".md" && ext !== ".json") throw new UserError(`${file} does not end in .md or .json; give the form sl review export wrote, such as .sl/reviews/rb_0001.md.`);
  const stat = statSync(abs, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new UserError(`${file} ${stat ? "is not a file" : "does not exist"}; give the path of the filled form, such as .sl/reviews/rb_0001.md.`);
  const text = readFileSync(abs, "utf8");
  return ext === ".md" ? parseReviewMarkdown(text, file) : parseReviewJson(text, file);
}

// Where a question's ref keeps its open_questions: the file and the map's path inside it.
function questionHolder(root: string, ref: string): { file: string; path: (string | number)[]; list: string[] } | null {
  if (ref === "access" || ref.startsWith("access.roles.")) {
    const file = paths(root).access;
    const access = existsSync(file) ? readYamlIfExists<Obj>(file) : null;
    if (ref === "access") return access ? { file, path: [], list: strs(access.open_questions) } : null;
    const roles = Array.isArray(access?.roles) ? access.roles : [];
    const i = roles.findIndex((r) => isObj(r) && r.name === ref.slice("access.roles.".length));
    return i < 0 ? null : { file, path: ["roles", i], list: strs((roles[i] as Obj).open_questions) };
  }
  const [source, model] = ref.split(".") as [string, string];
  const file = paths(root).model(source, model);
  const data = existsSync(file) ? readYamlIfExists<Obj>(file) : null;
  return data ? { file, path: [], list: strs(data.open_questions) } : null;
}

export interface ApplyItemNote {
  item: number;
  target: string;
  verdict: Verdict | null;
  reason?: string;
  id?: string;
}

export interface ApplyQuestionNote {
  ref: string;
  key: string;
  question: string;
  id?: string;
}

export interface ReviewApplyOutcome {
  readback_id: string;
  recorded: LedgerEntry[];
  already_recorded: ApplyItemNote[];
  refused: ApplyItemNote[];
  questions_already_resolved: ApplyQuestionNote[];
  questions_not_found: ApplyQuestionNote[];
  unanswered: { items: ApplyItemNote[]; questions: ApplyQuestionNote[] };
  edited: EditOutcome[];
  redacted: boolean;
  next_steps: string[];
}

// Appends one entry to the ledger under the next id; a parameter so a test can make it fail.
export type LedgerAppend = (root: string, entry: NewLedgerEntry) => LedgerEntry;
const appendEntry: LedgerAppend = (root, entry) => openLedger(root).append(entry);

// Puts the ledger back to the bytes it had (size, or no file), without following a link.
function truncateLedger(root: string, size: number | null): void {
  const file = join(root, LEDGER_FILE);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return;
  if (size === null) return void unlinkSync(file);
  const fd = openSync(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
}

// Records a filled form: each answered item as a reply line exactly as sl reply writes it, unless
// its hash changed since the form was exported, and each answered open question as sl question
// resolve does. Everything is checked first; the ledger lines are appended, then the YAML edited, and
// a failure puts every file and the ledger back, so a question is never gone without its answer. An answer already in the ledger, or a question no
// longer open, records nothing, so applying a form twice records it once. It never approves.
export function applyReview(root: string, form: ReviewForm, by: string, at: string, append: LedgerAppend = appendEntry): ReviewApplyOutcome {
  const id = form.readback_id;
  const pending = loadPending(root, id);
  const again = `export the form again with sl review export --readback ${id} --format md|json --force`;
  const seen = new Set<number>();
  for (const it of form.items) {
    const p = pending.items.find((x) => x.n === it.n);
    if (!p || p.target !== it.target)
      throw new UserError(`Item ${it.n} (${it.target}) of the form is not an item of ${id}, whose items are ${pending.items.map((i) => `${i.n} (${i.target})`).join(", ")}. Nothing was recorded; ${again}.`);
    if (seen.has(it.n)) throw new UserError(`Item ${it.n} appears twice in the form. Nothing was recorded; ${again}.`);
    seen.add(it.n);
  }
  const keys = form.questions.map((q) => `${q.ref} ${q.key}`);
  if (new Set(keys).size !== keys.length) throw new UserError(`A question appears twice in the form. Nothing was recorded; ${again}.`);
  openLedger(root);
  const ledgerFile = join(root, LEDGER_FILE);
  type Line = Partial<LedgerReply> & Partial<LedgerQuestion>;
  const lines = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line) : [];
  const out: ReviewApplyOutcome = { readback_id: id, recorded: [], already_recorded: [], refused: [], questions_already_resolved: [], questions_not_found: [], unanswered: { items: [], questions: [] }, edited: [], redacted: false, next_steps: [] };
  const replies: Omit<LedgerReply, "id">[] = [];
  for (const it of form.items) {
    const p = pending.items.find((x) => x.n === it.n)!;
    const note: ApplyItemNote = { item: p.n, target: p.target, verdict: it.verdict };
    const answer = ownerText(it.answer);
    if (it.verdict === null && !answer.text) {
      out.unanswered.items.push(note);
      continue;
    }
    // A marked box with no words is recorded with the verdict as the owner's words.
    const text = answer.text || it.verdict!;
    const dup = lines.find((l) => l.kind === "reply" && l.readback_id === id && l.item === p.n && l.verdict === it.verdict && l.text === text);
    if (dup) out.already_recorded.push({ ...note, id: dup.id });
    else if (it.content_hash !== p.content_hash) out.refused.push({ ...note, reason: `its hash in the form is not the one ${id} recorded, so the form does not show what was read back` });
    else if (currentHash(root, p.target, p.content_hash) !== p.content_hash) out.refused.push({ ...note, reason: `${p.target} changed since the form was exported, so the owner answered text that no longer holds` });
    else {
      out.redacted ||= answer.redacted;
      replies.push({ kind: "reply", readback_id: id, item: p.n, target: p.target, content_hash: p.content_hash, text, verdict: it.verdict, by, at });
    }
  }
  // An item or an open question the form leaves out (deleted by the owner, or added since export)
  // still needs an answer.
  for (const p of pending.items) if (!seen.has(p.n)) out.unanswered.items.push({ item: p.n, target: p.target, verdict: null });
  out.unanswered.items.sort((a, b) => a.item - b.item);
  const inForm = new Set(keys);
  for (const q of openQuestions(root, pending.items.map((i) => i.target)))
    if (!inForm.has(`${q.ref} ${q.key}`)) out.unanswered.questions.push({ ref: q.ref, key: q.key, question: plainText(q.question) });
  // A question line for this ref with this answer, to a question whose text or key is the form's.
  const resolvedLine = (q: ReviewQuestion, text: string) =>
    lines.find((l) => l.kind === "question" && l.target === q.ref && l.text === text && (l.question === plainText(q.question).trim() || questionKey(l.question ?? "") === q.key));
  // entry is null when the ledger already holds the answer (a run stopped after appending it), so
  // only the YAML edit is left to make.
  const resolutions: { file: string; path: (string | number)[]; question: string; entry: Omit<LedgerQuestion, "id"> | null }[] = [];
  for (const q of form.questions) {
    const note: ApplyQuestionNote = { ref: q.ref, key: q.key, question: plainText(q.question) };
    const answer = ownerText(q.answer);
    if (!answer.text) {
      out.unanswered.questions.push(note);
      continue;
    }
    const holder = questionHolder(root, q.ref);
    const question = holder?.list.find((x) => questionKey(x) === q.key);
    const done = resolvedLine(q, answer.text);
    if (done) out.questions_already_resolved.push({ ...note, id: done.id });
    else if (!holder || question === undefined) out.questions_not_found.push(note);
    else out.redacted ||= answer.redacted;
    if (holder && question !== undefined)
      resolutions.push({ file: holder.file, path: holder.path, question, entry: done ? null : { kind: "question", target: q.ref, question: plainText(question).trim(), text: answer.text, by, at } });
  }

  const written: { file: string; before: string }[] = [];
  const size = existsSync(ledgerFile) ? statSync(ledgerFile).size : null;
  let appended = false;
  try {
    for (const entry of [...replies, ...resolutions.flatMap((r) => (r.entry ? [r.entry] : []))]) {
      appended = true;
      out.recorded.push(append(root, entry));
    }
    for (const file of [...new Set(resolutions.map((r) => r.file))]) {
      const mine = resolutions.filter((r) => r.file === file);
      const before = readFileSync(file, "utf8");
      const rel = relFile(root, file);
      const outcome = commitEdit(root, file, `resolve open questions of ${rel}`, (doc) => {
        for (const r of mine) {
          const map = itemMap(doc, r.path);
          const node = map.get("open_questions", true);
          // Every copy of the question goes, so a question written twice is resolved once.
          const kept = isSeq(node) ? node.items.filter((n) => !(isScalar(n) && n.value === r.question)) : [];
          if (!isSeq(node) || kept.length === node.items.length) throw new UserError(`${rel} changed while it was read; run this again.`);
          node.items = kept;
          if (!node.items.length) map.delete("open_questions");
        }
      });
      if (outcome.changed) written.push({ file, before });
      out.edited.push(outcome);
    }
  } catch (e) {
    for (const w of written.reverse()) writeFileSync(w.file, w.before);
    if (appended) truncateLedger(root, size);
    const why = e instanceof Error ? e.message : String(e);
    throw new UserError(`${why}\nNothing was recorded: ${LEDGER_FILE} and the YAML files are as they were. Fix the cause and run sl review apply again.`);
  }

  const owner = shellQuote(by);
  const steps = out.next_steps;
  const replied = [...out.recorded.filter((e): e is LedgerReply => e.kind === "reply"), ...out.already_recorded];
  // A yes to an export source's golden waits on that source's upgrade, named once per source at the
  // place of its first golden; every other yes names its own command.
  const yeses = replied.filter((r) => {
    const read = pending.items.find((x) => x.n === r.item)?.content_hash;
    return r.verdict === "yes" && read !== undefined && currentHash(root, r.target, read) === read;
  });
  steps.push(...afterYesSteps(root, yeses.map((r) => r.target), (t) => (t.startsWith("golden:") ? `sl goldens confirm --name ${t.slice(7)}` : `sl approve --target ${t} --by ${owner}`)));
  const edits = [...new Set(replied.filter((r) => r.verdict === "no" || r.verdict === "change").map((r) => r.target))];
  if (edits.length) steps.push(`make the corrections and changes the owner asked for with typed edits (sl set, sl tag, sl ignore-column or sl question add), then sl readback --targets ${edits.join(",")}`);
  for (const r of replied.filter((x) => x.verdict === null))
    steps.push(`ask the owner whether item ${r.item} is a yes, a no or a change, then sl reply --readback ${id} --item ${r.item} --text "<owner's words>" --verdict yes|no|change --by ${owner}`);
  if (out.refused.length) steps.push(`sl readback --targets ${out.refused.map((r) => r.target).join(",")}, then sl review export --readback <its id> --format md for a new form`);
  if (out.unanswered.items.length || out.unanswered.questions.length) steps.push(`ask the owner for what is still unanswered, then sl review apply again with the form they return`);
  if (out.questions_not_found.length) steps.push("sl status lists the open questions that remain");
  if (!steps.length) steps.push("sl status");
  return out;
}

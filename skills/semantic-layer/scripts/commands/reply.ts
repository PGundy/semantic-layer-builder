import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { oneLine } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { afterYesSteps, goldenExportSource, goldenUpgradeNext } from "../lib/export-goldens.ts";
import { readJsonObject, unknownKeys } from "../lib/json-input.ts";
import { approveMany } from "./approve.ts";
import { confirmReadback } from "./goldens.ts";
import { LEDGER_FILE, latestReply, openLedger, ownerText, readPending, readReplies, shellQuote } from "../lib/ledger.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { currentHash } from "../lib/readback.ts";
import type { LedgerReply, PendingReadback, ReadbackItem, ReplyVerdict } from "../lib/types.ts";

const VERDICTS: readonly ReplyVerdict[] = ["yes", "no", "change"];
const USAGE = 'semlayer reply --readback <readback_id> --item <n> --text "<owner\'s words>" [--verdict yes|no|change] [--about access] --by "<owner>"';
const ANSWERS_USAGE =
  'semlayer reply --readback <readback_id> --answers <file | -> holding {"by": "<owner>", "answers": [{"item": 1, "verdict": "yes", "text": "<owner\'s words>"}, ' +
  '{"items": [2, 3], "verdict": "change", "text": "<owner\'s words>"}]} [--approve]';

// One reply as the ledger records it, the single form and --answers alike: the same keys from the
// same inputs, so a batch writes the lines the single form would, apart from ids and times.
function replyLine(pending: PendingReadback, item: ReadbackItem, text: string, verdict: ReplyVerdict | null, about: "access" | undefined, by: string, at: string): Omit<LedgerReply, "id"> {
  return {
    kind: "reply",
    readback_id: pending.readback_id,
    item: item.n,
    target: item.target,
    content_hash: item.content_hash,
    ...(item.definition_hash ? { definition_hash: item.definition_hash } : {}),
    text,
    verdict,
    ...(about ? { about } : {}),
    by,
    at,
  };
}

// Why --about access does not go with this verdict or item, or undefined when it does; `answers`
// words it for an entry of --answers.
function aboutRefusal(item: ReadbackItem, verdict: ReplyVerdict | null, answers = false): string | undefined {
  const change = answers ? '"verdict": "change"' : "--verdict change";
  const without = answers ? 'without "about"' : "without --about";
  if (verdict !== "change")
    return `${answers ? '"about": "access"' : "--about access"} records a change to who sees the item, so it goes with ${change}. Record the owner's ${verdict} to the item itself in its own ${answers ? "entry" : "semlayer reply"}, ${without}.`;
  if (item.target === "access") return `This item is access.yaml itself, so a change to who sees what is a change to it: record it with ${change}, ${without}.`;
  return undefined;
}

// The step after a yes to a target: its approve or confirm, or the upgrade an export source's golden waits on.
function afterYes(root: string, target: string, by: string): { next: string; waits?: string } {
  if (!target.startsWith("golden:")) return { next: `semlayer approve --target ${target} --by ${shellQuote(by)}` };
  // Decision D2: an export source's golden is confirmed only once its source has a connection.
  const waits = goldenExportSource(root, target.slice(7));
  return waits ? { next: goldenUpgradeNext(waits.source, waits.dialect, [target.slice(7)]), waits: waits.source } : { next: `semlayer goldens confirm --name ${target.slice(7)}` };
}

// The --answers form: every entry is checked before any line is written, then one ledger line per
// item, in one write, each the line the single form writes for it.
async function replyAnswers(ctx: CommandContext, rb: string, file: string, approve: boolean): Promise<number> {
  const data = await readJsonObject(ctx, "answers", file, `Usage: ${ANSWERS_USAGE}.`);
  const fail = (why: string): never => {
    throw new UserError(`${why} Nothing was written. Fix it and run the same command again. Usage: ${ANSWERS_USAGE}.`);
  };
  const extra = unknownKeys(data, ["by", "answers"]);
  if (extra.length) fail(`The answers file has key(s) ${extra.join(", ")}; it holds only "by" and "answers".`);
  const by = typeof data.by === "string" ? ownerText(oneLine(data.by)).text : "";
  if (!by) fail('"by" is missing or empty; give the name of the owner who answered.');
  if (!Array.isArray(data.answers) || !data.answers.length) fail('"answers" is missing or empty; give one entry per answer the owner gave.');
  // Recorded, and approved, under the lock; --approve releases it before a golden's query runs.
  const release = approve ? await ctx.lock() : () => {};
  const pending = readPending(ctx.root, rb.trim());
  const list = pending.items.map((i) => `${i.n} (${i.target})`).join(", ");
  const named = new Map<number, number>();
  const picked: { item: ReadbackItem; text: string; redacted: boolean; verdict: ReplyVerdict; about?: "access" }[] = [];
  (data.answers as unknown[]).forEach((raw, i) => {
    const at = `Entry ${i + 1} of "answers"`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail(`${at} is not an object.`);
    const e = raw as Record<string, unknown>;
    const bad = unknownKeys(e, ["item", "items", "verdict", "text", "about"]);
    if (bad.length) fail(`${at} has key(s) ${bad.join(", ")}; an entry holds "item" or "items", "verdict", "text" and, on a change to who sees an item, "about": "access".`);
    if ((e.item === undefined) === (e.items === undefined)) fail(`${at} gives ${e.item === undefined ? "neither" : "both"} "item" and "items"; give one: "item": <n> or "items": [<n>, ...].`);
    const ns = e.item !== undefined ? [e.item] : Array.isArray(e.items) && e.items.length ? e.items : fail(`${at} has "items" that is not a list of item numbers.`);
    const verdict = typeof e.verdict === "string" ? (e.verdict.trim().toLowerCase() as ReplyVerdict) : undefined;
    if (!verdict || !VERDICTS.includes(verdict)) fail(`${at} has verdict ${JSON.stringify(e.verdict ?? null)}; a verdict is "yes", "no" or "change".`);
    const { text, redacted } = typeof e.text === "string" ? ownerText(e.text) : { text: "", redacted: false };
    if (!text) fail(`${at} has no "text"; record the owner's words as they said them.`);
    const about = e.about === undefined ? undefined : e.about === "access" ? ("access" as const) : fail(`${at} has "about": ${JSON.stringify(e.about)}; "about" is "access" (a change to who sees the item), or left out.`);
    for (const n of ns) {
      const item = typeof n === "number" && Number.isInteger(n) ? pending.items.find((x) => x.n === n) : undefined;
      if (typeof n !== "number") fail(`${at} names item ${JSON.stringify(n)}; an item number is a whole number, not text: "item": 1.`);
      if (!item) fail(`${at} names item ${JSON.stringify(n)}, which ${pending.readback_id} does not have; its items are ${list}.`);
      if (named.has(item!.n)) fail(`${at} names item ${item!.n}, which entry ${named.get(item!.n)} already names; give each item once.`);
      named.set(item!.n, i + 1);
      if (about) {
        const why = aboutRefusal(item!, verdict!, true);
        if (why) fail(`${at}, item ${item!.n}: ${why}`);
      }
      picked.push({ item: item!, text, redacted, verdict: verdict!, ...(about ? { about } : {}) });
    }
  });
  const at = ctx.now().toISOString();
  const entries = openLedger(ctx.root).appendAll(picked.map((p) => replyLine(pending, p.item, p.text, p.verdict, p.about, by, at))) as LedgerReply[];

  // What each recorded line leaves to do.
  const warnings: string[] = [];
  if (picked.some((p) => p.redacted)) warnings.push("The owner's words held what looks like a credential; it was stored as [redacted]. Ask the owner to change that credential, since it was shared in the conversation.");
  const stale: string[] = [];
  const gone: string[] = [];
  const yesApprove: number[] = [];
  const yesGolden: number[] = [];
  const waiting: string[] = [];
  const edits: string[] = [];
  const access: string[] = [];
  for (const p of picked) {
    const t = p.item.target;
    const now = currentHash(ctx.root, t, p.item.content_hash);
    if (now === null) gone.push(t);
    else if (now !== p.item.content_hash) stale.push(t);
    else if (p.about) access.push(t);
    else if (p.verdict === "yes") {
      if (t.startsWith("golden:") && afterYes(ctx.root, t, by).waits) waiting.push(t);
      else (t.startsWith("golden:") ? yesGolden : yesApprove).push(p.item.n);
    } else edits.push(t);
  }
  if (gone.length) warnings.push(`${gone.join(", ")} no longer exist${gone.length === 1 ? "s" : ""} in the YAML, so ${gone.length === 1 ? "its reply" : "their replies"} cannot approve anything; run semlayer status to see the current targets.`);
  if (stale.length) warnings.push(`${stale.join(", ")} changed since ${stale.length === 1 ? "it was" : "they were"} read back; read ${stale.length === 1 ? "it" : "them"} back again with semlayer readback --targets ${stale.join(",")}, and record the owner's answers to the new readback.`);
  // Each step with the command it starts with, which --json gives as next.
  const steps: [string, string][] = [];
  if (yesApprove.length) steps.push([`semlayer approve --readback ${pending.readback_id}`, ""]);
  if (yesGolden.length) steps.push([`semlayer goldens confirm --readback ${pending.readback_id}`, ""]);
  for (const s of afterYesSteps(ctx.root, waiting, (t) => afterYes(ctx.root, t, by).next)) steps.push([s, ""]);
  const redo = [...new Set([...edits, ...stale])];
  if (edits.length) steps.push(["semlayer apply --file -", `make the changes the owner asked for to ${edits.join(", ")} with one semlayer apply --file -, then semlayer readback --targets ${redo.join(",")}`]);
  else if (stale.length) steps.push([`semlayer readback --targets ${stale.join(",")}`, ""]);
  // --approve: the approve and confirm the yeses allow, run here as their own commands run them.
  const done = approve ? await approveAnswered(ctx, pending, picked, by, entries, release) : undefined;
  if (done) steps.splice(0, steps.length, ...done.steps);
  if (!steps.length) steps.push(["semlayer next", ""]);
  const next = steps[0]![0];
  const stepText = steps.map(([cmd, text]) => text || cmd);
  if (ctx.json) {
    ctx.out(formatJson({ readback_id: pending.readback_id, path: LEDGER_FILE, ids: entries.map((e) => e.id), entries, warnings, next, next_steps: stepText, ...(done ? done.json : {}) }));
    return done?.code ?? 0;
  }
  const counts = (["yes", "no", "change"] as const)
    .map((v) => [v, picked.filter((p) => p.verdict === v && !p.about).map((p) => p.item.n)] as const)
    .filter(([, ns]) => ns.length)
    .map(([v, ns]) => `${v} to item${ns.length === 1 ? "" : "s"} ${ns.join(", ")}`);
  const aboutItems = picked.filter((p) => p.about).map((p) => p.item.n);
  if (aboutItems.length) counts.push(`a change to who sees item${aboutItems.length === 1 ? "" : "s"} ${aboutItems.join(", ")}`);
  const span = entries.length === 1 ? entries[0]!.id : `${entries[0]!.id} to ${entries[entries.length - 1]!.id}`;
  const lines = [`Recorded ${span} in ${LEDGER_FILE}: ${by}'s replies to ${entries.length} item${entries.length === 1 ? "" : "s"} of ${pending.readback_id}, ${counts.join("; ")}.`];
  lines.push(...warnings.map((w) => `Warning: ${w}`));
  if (access.length) lines.push(`Who sees ${access.join(", ")} is decided in the access phase: semlayer next brings ${access.length === 1 ? "that change" : "those changes"} up there, and ${access.length === 1 ? "it does" : "they do"} not hold the items' sign-off.`);
  if (done) lines.push(...done.text);
  lines.push(`Next: ${stepText.join("; then ")}.`);
  ctx.out(lines.join("\n"));
  return done?.code ?? 0;
}

type Picked = { item: ReadbackItem; verdict: ReplyVerdict; about?: "access" };

// After semlayer reply --answers has recorded a turn, --approve approves each item of it the owner said
// yes to with semlayer approve --readback's own code (approveMany) and confirms each such golden with semlayer
// goldens confirm --readback's (confirmReadback), both kept to the items this turn answered: each
// rests on its item's own recorded yes to it as it stands, with the same refusals. A golden read
// back from --results or --plan, or one whose export source waits on an upgrade, is left to its own
// semlayer goldens confirm --name, named. The exit code is theirs: 1 when a yes was not acted on.
async function approveAnswered(ctx: CommandContext, pending: PendingReadback, picked: Picked[], by: string, entries: LedgerReply[], release: () => void) {
  const yes = picked.filter((p) => p.verdict === "yes" && !p.about);
  const answered = picked.filter((p) => !p.about);
  const rowsFrom = yes.filter((p) => p.item.target.startsWith("golden:") && p.item.rows_from);
  const waits = yes.filter((p) => p.item.target.startsWith("golden:") && !p.item.rows_from && afterYes(ctx.root, p.item.target, by).waits);
  const own = new Set([...rowsFrom, ...waits].map((p) => p.item.target));
  const approveSet = new Set(answered.map((p) => p.item.target).filter((t) => !t.startsWith("golden:")));
  const confirmSet = new Set(answered.map((p) => p.item.target).filter((t) => t.startsWith("golden:") && !own.has(t)));
  const text: string[] = [];
  const json: Record<string, unknown> = {};
  let code = 0;
  const steps: [string, string][] = [];
  const recorded = `The answers stay recorded (${entries[0]!.id}${entries.length > 1 ? ` to ${entries[entries.length - 1]!.id}` : ""})`;
  // Each runs as its command does, its output captured: the report is that command's own, its
  // closing Next: left to the one line this command ends with.
  const run = async (key: "approval" | "confirmation", what: string, again: string, go: (c: CommandContext) => Promise<number>): Promise<{ code: number }> => {
    const out: string[] = [];
    try {
      const c = await go({ ...ctx, out: (x) => out.push(x) });
      if (ctx.json) json[key] = JSON.parse(out.join("\n"));
      else text.push(...out.join("\n").replace(/ Next: [^\n]*\.$/, "").split("\n"));
      return { code: c };
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      throw new UserError(`${recorded}, but ${what} was refused: ${e.message} Next: ${again}.`, e.next);
    }
  };
  if (yes.some((p) => approveSet.has(p.item.target))) {
    const again = `semlayer approve --readback ${pending.readback_id}`;
    code = Math.max(code, (await run("approval", "approving them", again, (c) => approveMany(c, {}, [], pending.readback_id, approveSet))).code);
  }
  release();
  if (yes.some((p) => confirmSet.has(p.item.target))) {
    const again = `semlayer goldens confirm --readback ${pending.readback_id}`;
    code = Math.max(code, (await run("confirmation", "confirming the goldens", again, (c) => confirmReadback(c, {}, pending.readback_id, confirmSet))).code);
  }
  // A golden left to its own confirm: why, and the command.
  const left = [
    ...rowsFrom.map((p) => ({
      name: p.item.target.slice(7),
      item: p.item.n,
      reason: `it was read back from stored rows (${p.item.rows_from}), which only its own confirm reads`,
      next: `semlayer goldens confirm --name ${p.item.target.slice(7)} ${p.item.rows_from}`,
    })),
    ...waits.map((p) => ({ name: p.item.target.slice(7), item: p.item.n, reason: `its source ${afterYes(ctx.root, p.item.target, by).waits} has no connection yet`, next: afterYes(ctx.root, p.item.target, by).next })),
  ];
  if (left.length) {
    if (ctx.json) json.confirm_each = left;
    else {
      text.push(`Not confirmed by --approve (${left.length}):`);
      for (const l of left) text.push(`  - golden:${l.name} (item ${l.item}): ${l.reason}. Next: ${l.next}.`);
    }
    for (const s of [...new Set(left.map((l) => l.next))]) steps.push([s, ""]);
  }
  // The steps the turn's no, change and stale answers leave, as without --approve.
  const edits = answered.filter((p) => p.verdict !== "yes" && p.verdict !== null).map((p) => p.item.target);
  const changed = (p: Picked) => {
    const now = currentHash(ctx.root, p.item.target, p.item.content_hash);
    return now !== null && now !== p.item.content_hash;
  };
  const stale = answered.filter(changed).map((p) => p.item.target);
  const redo = [...new Set([...edits, ...stale])];
  if (edits.length) steps.push(["semlayer apply --file -", `make the changes the owner asked for to ${edits.join(", ")} with one semlayer apply --file -, then semlayer readback --targets ${redo.join(",")}`]);
  else if (stale.length) steps.push([`semlayer readback --targets ${stale.join(",")}`, ""]);
  if (!steps.length && confirmSet.size && code === 0) steps.push(["semlayer goldens check", ""]);
  return { text, json, code, steps };
}

const spec: CommandSpec = {
  summary: "Record the owner's answers to the items of a readback in the answer ledger, .semlayer/ledger.jsonl.",
  usage:
    'reply --readback <readback_id> --item <n> --text "<owner\'s words>" [--verdict yes|no|change] [--about access] --by "<owner>"\n' +
    "       reply --readback <readback_id> --answers <file | -> [--approve]\n\n" +
    "Appends one line to .semlayer/ledger.jsonl with the item's target and the content hash it had when it was read\n" +
    "back, the owner's words (credentials redacted), the verdict and the time. Never rewrites earlier lines.\n" +
    "--about access records a change to who sees the item, not to the item: it is settled in the access phase\n" +
    "(semlayer next brings it up there) and does not hold the item's sign-off, which still takes its own yes.\n" +
    "--answers records one owner turn: the file, or stdin with -, holds\n" +
    '  {"by": "<owner>", "answers": [{"item": 1, "verdict": "yes", "text": "<owner\'s words>"},\n' +
    '                                {"items": [2, 3], "verdict": "change", "text": "<owner\'s words>", "about": "access"}]}\n' +
    "Every entry is checked first (each item exists and is named once, a verdict, words, about only on a change);\n" +
    "on any error nothing is written. Then each item gets the line the single form writes for it. \"items\" shares\n" +
    "one answer only when the owner said those words of each of those items.\n" +
    "--approve, with --answers only, then approves each item answered yes as semlayer approve --readback would and confirms\n" +
    "each golden answered yes as semlayer goldens confirm --readback would, on that item's own yes to it as it stands, and lists\n" +
    "every other with why; a golden read back from --results or --plan is left to its own semlayer goldens confirm --name. The\n" +
    "answers stay recorded when an approval is refused; it exits 1 when an item answered yes was not approved or confirmed.",
  options: {
    readback: { type: "string" },
    item: { type: "string" },
    text: { type: "string" },
    verdict: { type: "string" },
    about: { type: "string" },
    by: { type: "string" },
    answers: { type: "string", mcp: "omit" },
    approve: { type: "boolean", mcp: "omit" },
  },
  // --approve confirms goldens, whose queries run outside the lock: it takes the lock itself.
  writes: ({ values }) => (values.approve === true ? "late" : "whole"),
  async run({ values }, ctx) {
    const approve = bool(values, "approve");
    loadProject(ctx.root);
    const answers = str(values, "answers");
    if (approve && answers === undefined)
      throw new UserError(`--approve goes with --answers, which records the turn's answers first: ${ANSWERS_USAGE}. One answer is recorded with semlayer reply --item, then approved with semlayer approve --target <ref>.`);
    if (answers !== undefined) {
      const rb = str(values, "readback");
      if (rb === undefined) throw new UserError(`--answers needs --readback <readback_id>. Usage: ${ANSWERS_USAGE}.`);
      const mixed = ["item", "text", "verdict", "about", "by"].filter((f) => str(values, f) !== undefined);
      if (mixed.length) throw new UserError(`--answers takes no ${mixed.map((f) => `--${f}`).join(", ")}: the answers file holds the owner's name, each item, its verdict and words. Nothing was written. Usage: ${ANSWERS_USAGE}.`);
      return replyAnswers(ctx, rb, answers, approve);
    }
    const [rb, itemRaw, raw, byRaw] = [str(values, "readback"), str(values, "item"), str(values, "text"), str(values, "by")];
    if (rb === undefined || itemRaw === undefined || raw === undefined || byRaw === undefined) throw new UserError(`Usage: ${USAGE}.`);
    if (/[,\s]/.test(itemRaw.trim()))
      throw new UserError(`--item takes one item number, not ${JSON.stringify(itemRaw)}; nothing was written. To record several answers at once, give each item its own entry, with the owner's words for it: ${ANSWERS_USAGE}.`);
    const verdictRaw = str(values, "verdict");
    const aboutRaw = str(values, "about");
    const about = aboutRaw === undefined ? undefined : aboutRaw.trim().toLowerCase();
    if (about !== undefined && about !== "access") throw new UserError(`--about is access (a change to who sees the item), not ${JSON.stringify(aboutRaw)}. Usage: ${USAGE}.`);
    // A change to who sees an item is a change, whatever else the owner says about the item itself.
    const verdict = verdictRaw === undefined ? (about ? "change" : null) : (verdictRaw.trim().toLowerCase() as ReplyVerdict);
    if (verdict !== null && !VERDICTS.includes(verdict)) throw new UserError(`--verdict is yes, no or change, not ${JSON.stringify(verdictRaw)}. Usage: ${USAGE}.`);
    if (about && verdict !== "change") throw new UserError(aboutRefusal({ target: "" } as ReadbackItem, verdict)!);
    const by = ownerText(oneLine(byRaw)).text;
    if (!by) throw new UserError('--by is empty; give the name of the owner who answered (--by "<owner>").');
    const { text, redacted } = ownerText(raw);
    if (!text) throw new UserError("--text is empty; record the owner's words as they said them.");
    const pending = readPending(ctx.root, rb.trim());
    const n = /^\d+$/.test(itemRaw.trim()) ? Number(itemRaw.trim()) : NaN;
    const item = pending.items.find((i) => i.n === n);
    if (!item) {
      const items = pending.items.map((i) => `${i.n} (${i.target})`).join(", ");
      throw new UserError(`Readback ${pending.readback_id} has no item ${JSON.stringify(itemRaw)}; its items are ${items}. To ask about something else, read it back first with semlayer readback --targets <ref>.`);
    }
    if (about) {
      const why = aboutRefusal(item, verdict);
      if (why) throw new UserError(why);
    }
    const ledger = openLedger(ctx.root);
    const now = currentHash(ctx.root, item.target, item.content_hash);
    const changed = now !== item.content_hash;
    const entry = ledger.append(replyLine(pending, item, text, verdict, about ? "access" : undefined, by, ctx.now().toISOString()));
    const t = item.target;
    const again = `semlayer readback --targets ${t}`;
    const warnings: string[] = [];
    if (redacted) warnings.push("The owner's words held what looks like a credential; it was stored as [redacted]. Ask the owner to change that credential, since it was shared in the conversation.");
    if (now === null) warnings.push(`${t} no longer exists in the YAML, so this reply cannot approve anything; run semlayer status to see the current targets.`);
    else if (changed) warnings.push(`${t} changed since it was read back; read it back again with ${again}, and record the owner's answer to the new readback.`);
    let next: string;
    let advice: string;
    if (about) {
      // The item's own sign-off stands where it stood: approved on a recorded yes, else still to be answered.
      const own = latestReply(readReplies(ctx.root), t);
      const yes = !changed && own?.verdict === "yes" && own.content_hash === item.content_hash;
      next = yes
        ? t.startsWith("golden:") ? `semlayer goldens confirm --name ${t.slice(7)}` : `semlayer approve --target ${t} --by ${shellQuote(by)}`
        : `semlayer reply --readback ${pending.readback_id} --item ${item.n} --text "<owner's words>" --verdict yes|no|change --by ${shellQuote(by)}`;
      advice =
        `Recorded as a change to who sees ${t}. Who sees what is decided once, in the access phase: semlayer next brings this change up there, and it does not hold ${t}'s sign-off. ` +
        (yes ? `The owner's yes to ${t} itself stands. Next: ${next}.` : `Ask the owner whether the rest of the item is right as read back, and record that answer: ${next}.`);
    } else if (verdict === null) {
      next = `semlayer reply --readback ${pending.readback_id} --item ${item.n} --text "<owner's words>" --verdict yes|no|change --by ${shellQuote(by)}`;
      advice = `The reply has no verdict, so no approval can use it. Ask the owner whether that is a yes, a no or a change, then record it: ${next}.`;
    } else if (changed) {
      next = now === null ? "semlayer status" : again;
      advice = `Next: ${next}.`;
    } else if (verdict === "yes") {
      const step = afterYes(ctx.root, t, by);
      next = step.next;
      advice = step.waits
        ? `The owner said yes to the item as read back, and the yes stays recorded, but ${t} cannot be confirmed until source ${step.waits} has a connection. Next: ${next}.`
        : `The owner said yes to the item as read back. Next: ${next}.`;
    } else {
      next = again;
      advice = `Make the ${verdict === "no" ? "correction" : "change"} the owner asked for with a typed edit (semlayer set, semlayer tag, semlayer ignore-column or semlayer question add), then read it back again: ${next}.`;
      // Who sees an item is not part of the item: such a change waits for the access phase and the item goes on.
      if (t !== "access" && !t.startsWith("golden:"))
        advice += ` If the change is only to who sees ${t}, record that as well with --verdict change --about access, then the owner's answer to the item itself: who sees what is decided in the access phase and does not hold this item.`;
    }
    if (ctx.json) {
      ctx.out(formatJson({ id: entry.id, path: LEDGER_FILE, entry, current_hash: now, hash_changed: changed, redacted, warnings, next }));
      return 0;
    }
    const head = `Recorded ${entry.id} in ${LEDGER_FILE}: ${by}'s reply to item ${item.n} of ${pending.readback_id} (${t}), ${verdict === null ? "no verdict yet" : about ? "a change to who sees it" : `verdict ${verdict}`}.`;
    ctx.out([head, ...warnings.map((w) => `Warning: ${w}`), advice].join("\n"));
    return 0;
  },
};
export default spec;

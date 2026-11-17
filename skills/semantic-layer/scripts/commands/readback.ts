import { lstatSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { CommandSpec, CommandContext, OptionValues } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { readbackGate } from "../lib/approve-checks.ts";
import { afterYesSteps } from "../lib/export-goldens.ts";
import { formatJson, UNPROTECT } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { ledgerState } from "../lib/ledger.ts";
import { DISCARDED, type GoldenRun, nextReadbackId, PENDING_DIR, PROTECTED_FACT, renderReadbacks, writePending } from "../lib/readback.ts";
import { writeFileAtomic } from "../lib/lock.ts";
import { readbackFigures } from "../lib/readback-figures.ts";
import { parseTarget } from "../lib/refs.ts";
import { goldenRun, passedFlags } from "./goldens.ts";
import type { PendingReadback } from "../lib/types.ts";

// The next readback id: past every file in .semlayer/pending/ and every readback the ledger's replies
// name, so a discarded readback's id is never given to another.
function freshReadbackId(root: string): string {
  const fromFiles = Number(nextReadbackId(root).slice(3));
  const answered = ledgerState(root).replies.map((r) => Number(/^rb_(\d{4,})$/.exec(r.readback_id)?.[1] ?? 0));
  return `rb_${String(Math.max(fromFiles, ...answered.map((n) => n + 1))).padStart(4, "0")}`;
}

// semlayer readback --discard <id>: sets a pending readback aside by removing its file and leaving the
// empty marker <id>.discarded in its place, which nextReadbackId counts, so the id is never issued
// again. The answers already recorded from it stay in the ledger.
function discard(ctx: CommandContext, values: OptionValues, id: string): number {
  const other = ["targets", "tolerance", "results", "plan"].find((f) => values[f] !== undefined);
  if (other) throw new UserError(`--discard takes no --${other}: run semlayer readback --discard ${id} on its own.`);
  if (!/^rb_\d{4,}$/.test(id)) throw new UserError(`--discard takes a readback id such as rb_0001; semlayer next names the pending ones.`, "semlayer next");
  const rel = `${PENDING_DIR.split("\\").join("/")}/${id}.json`;
  const file = join(ctx.root, rel);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) throw new UserError(`There is no pending readback ${id} (${rel}); nothing was removed. Run semlayer next to see what is pending.`, "semlayer next");
  // The file is removed only from inside the semantic root, never through a linked .semlayer directory.
  const dir = realpathSync(join(ctx.root, PENDING_DIR));
  const root = realpathSync(ctx.root);
  if (!stat.isFile() || !dir.startsWith(root + sep)) throw new UserError(`${rel} is not a plain file inside the semantic root ${resolve(ctx.root)}; nothing was removed. Run semlayer validate.`, "semlayer validate");
  writeFileAtomic(join(ctx.root, PENDING_DIR, `${id}${DISCARDED}`), "");
  rmSync(file);
  if (ctx.json) ctx.out(formatJson({ discarded: id, path: rel, next: "semlayer next" }));
  else ctx.out(`Set aside readback ${id}: removed ${rel}; its id is not given to another readback. Answers already recorded from it stay in the ledger. Next: semlayer next.`);
  return 0;
}

// What semlayer reply --answers --approve does for a readback after recording the answers.
function batchedDoes(b: { approve: string[] }): string {
  const approves = b.approve.some((a) => a.startsWith("semlayer approve "));
  const confirms = b.approve.some((a) => a.startsWith("semlayer goldens confirm "));
  if (approves && confirms) return "approves every item and confirms every golden they said yes to as it stands";
  if (approves) return "approves every item they said yes to as it stands";
  if (confirms) return "confirms every golden they said yes to as it stands";
  return "records the answers";
}

const spec: CommandSpec = {
  summary: "Render a plain-English readback of approve targets and store it in .semlayer/pending/ for the owner's answer.",
  usage:
    "readback --targets <ref>,<ref>,... [--tolerance <t>] [--results <file> | --plan <plan_id>] | readback --discard <readback_id>\n\n" +
    "Each ref is an approve target: source.model, source.model.field, metric:<name> or access, or a golden to\n" +
    "confirm, golden:<name>, whose request it compiles and runs with its cross_check_sql (live, or from --results\n" +
    "or --plan) to read back the rows and tolerance semlayer goldens confirm would record (--tolerance, else the\n" +
    "file's, else the default). A target semlayer approve would refuse for what its file lacks (a description, a grain,\n" +
    "a primary_key, a metric's measure) is refused first, naming the one semlayer apply that supplies it. Writes\n" +
    ".semlayer/pending/<readback_id>.json with the numbered items and each item's content hash. --discard <readback_id> sets\n" +
    "a pending readback the owner will not answer aside: it removes its file, leaving <readback_id>.discarded so the id is\n" +
    "never issued again, and answers recorded from it stay in the ledger.",
  options: {
    targets: { type: "string", multiple: true },
    tolerance: { type: "string" },
    results: { type: "string" },
    plan: { type: "string" },
    discard: { type: "string" },
  },
  writes: ({ values }) => (values.discard !== undefined ? "whole" : "late"),
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const gone = str(values, "discard");
    if (gone !== undefined) return discard(ctx, values, gone);
    const refs = list(values, "targets");
    if (!refs.length) {
      throw new UserError("--targets is required: a comma-separated list of source.model, source.model.field, metric:<name>, golden:<name> or access. Run semlayer status to see them.");
    }
    const names = refs.map(parseTarget).flatMap((t) => (t.kind === "golden" ? [t.name] : []));
    const flags = (["tolerance", "results", "plan"] as const).filter((f) => str(values, f) !== undefined);
    if (flags.length && !names.length) throw new UserError(`--${flags[0]} applies only to golden:<name> targets, which read back a golden's rows.`);
    // An item semlayer approve would refuse after the owner's yes is not read back: the lack is fixed first.
    readbackGate(ctx.root, refs);
    // A golden's rows come from compiling and running its request, before anything is written.
    const goldens = new Map<string, GoldenRun>();
    for (const name of names) if (!goldens.has(name)) goldens.set(name, await goldenRun(ctx, values, name));
    // A measure's or metric's figure on today's data, as evidence: a failure is its reason, never an error.
    const figures = await readbackFigures(ctx.root, refs, ctx.env);
    // The items are rendered, numbered and stored under the lock, so two readbacks never share an id.
    await ctx.lock();
    const rendered = renderReadbacks(ctx.root, refs, goldens, figures);
    // Where a golden's rows came from when not from a live run, for the confirm that records them.
    const rowsFrom = passedFlags(values, ["results", "plan"]);
    const pending: PendingReadback = {
      readback_id: freshReadbackId(ctx.root),
      created_at: ctx.now().toISOString(),
      items: rendered.map((r, i) => {
        const run = r.target.startsWith("golden:") ? goldens.get(r.target.slice(7)) : undefined;
        const evidence = figures.get(r.target);
        return { n: i + 1, target: r.target, kind: "approve" as const, text: r.text, content_hash: r.content_hash, ...(run ? { tolerance: run.tolerance } : {}), ...(run && rowsFrom ? { rows_from: rowsFrom.trim() } : {}), ...(evidence ? { evidence } : {}) };
      }),
    };
    const path = writePending(ctx.root, pending);
    // What runs once the owner says yes to an item: its semlayer approve, or for a golden its semlayer goldens
    // confirm, reading the rows from where the readback did; an export source's goldens wait on the
    // upgrade to a connection, named once per source (decision D2).
    const nextSteps = afterYesSteps(
      ctx.root,
      pending.items.map((i) => i.target),
      (t) => (t.startsWith("golden:") ? `semlayer goldens confirm --name ${t.slice(7)}${rowsFrom}` : `semlayer approve --target ${t} --by "<owner>"`),
    );
    const next = `semlayer reply --readback ${pending.readback_id} --item <n> --text "<owner's words>" --verdict yes|no|change --by "<owner>"`;
    // A readback of several items is answered as one owner turn: one semlayer reply --answers, then one
    // approve (and one confirm for goldens) for the whole readback. An export source's golden waits
    // on its upgrade, so such a readback keeps the steps item by item. semlayer goldens confirm --readback
    // takes no --results or --plan, so goldens read from them are confirmed one by one.
    const targets = pending.items.map((i) => i.target);
    const waits = nextSteps.some((s) => !/^semlayer (approve --target|goldens confirm --name) /.test(s));
    const hasGolden = targets.some((t) => t.startsWith("golden:"));
    const batched =
      targets.length > 1 && !waits
        ? {
            reply: `semlayer reply --readback ${pending.readback_id} --answers -`,
            reply_approve: `semlayer reply --readback ${pending.readback_id} --answers - --approve`,
            approve: [
              ...(targets.some((t) => !t.startsWith("golden:")) ? [`semlayer approve --readback ${pending.readback_id}`] : []),
              ...(hasGolden && !rowsFrom ? [`semlayer goldens confirm --readback ${pending.readback_id}`] : []),
            ],
            confirm_each: hasGolden && rowsFrom ? nextSteps.filter((s) => s.startsWith("semlayer goldens confirm --name ")) : [],
          }
        : undefined;
    // An item that shows a column as protected names how one the owner says is not personal comes out.
    const guarded = pending.items.some((i) => i.text.includes(PROTECTED_FACT));
    if (ctx.json) {
      ctx.out(formatJson({ readback_id: pending.readback_id, path, items: pending.items, next, next_steps: nextSteps, ...(batched ? { batched } : {}), ...(guarded ? { protected_note: UNPROTECT } : {}) }));
      return 0;
    }
    const lines = [`Readback ${pending.readback_id}, stored in ${path}. Read each item to the owner as written, ending with "Approve?".`, ""];
    for (const item of pending.items) {
      const [head, ...rest] = item.text.split("\n");
      lines.push(`${item.n}. ${head}`, ...rest.map((l) => `   ${l}`), "");
    }
    lines.push(
      batched
        ? `Record the owner's answers in one ${batched.reply_approve}, each item with its own verdict and their words: it ${batchedDoes(batched)}` +
            (batched.confirm_each.length ? `; then confirm each golden they said yes to: ${batched.confirm_each.join("; ")}` : "") +
            ". For a no or a change, make the edit with a typed command (semlayer set, or several in one semlayer apply), then run semlayer readback again."
        : `Only after the owner says yes to an item, approve it: ${nextSteps.join("; ")}. For a no or a change, make the edit with a typed command (semlayer set, or several in one semlayer apply), then run semlayer readback again.`,
    );
    if (guarded) lines.push(UNPROTECT);
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

import { lstatSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { CommandSpec, CommandContext, OptionValues } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { afterYesSteps } from "../lib/export-goldens.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { ledgerState } from "../lib/ledger.ts";
import { type GoldenRun, nextReadbackId, PENDING_DIR, renderReadbacks, writePending } from "../lib/readback.ts";
import { readbackFigures } from "../lib/readback-figures.ts";
import { parseTarget } from "../lib/refs.ts";
import { goldenRun, passedFlags } from "./goldens.ts";
import type { PendingReadback } from "../lib/types.ts";

// The next readback id: past every file in .sl/pending/ and every readback the ledger's replies
// name, so a discarded readback's id is never given to another.
function freshReadbackId(root: string): string {
  const fromFiles = Number(nextReadbackId(root).slice(3));
  const answered = ledgerState(root).replies.map((r) => Number(/^rb_(\d{4,})$/.exec(r.readback_id)?.[1] ?? 0));
  return `rb_${String(Math.max(fromFiles, ...answered.map((n) => n + 1))).padStart(4, "0")}`;
}

// sl readback --discard <id>: sets a pending readback aside by removing its file. The answers
// already recorded from it stay in the ledger.
function discard(ctx: CommandContext, values: OptionValues, id: string): number {
  const other = ["targets", "tolerance", "results", "plan"].find((f) => values[f] !== undefined);
  if (other) throw new UserError(`--discard takes no --${other}: run sl readback --discard ${id} on its own.`);
  if (!/^rb_\d{4,}$/.test(id)) throw new UserError(`--discard takes a readback id such as rb_0001; sl next names the pending ones.`, "sl next");
  const rel = `${PENDING_DIR.split("\\").join("/")}/${id}.json`;
  const file = join(ctx.root, rel);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) throw new UserError(`There is no pending readback ${id} (${rel}); nothing was removed. Run sl next to see what is pending.`, "sl next");
  // The file is removed only from inside the semantic root, never through a linked .sl directory.
  const dir = realpathSync(join(ctx.root, PENDING_DIR));
  const root = realpathSync(ctx.root);
  if (!stat.isFile() || !dir.startsWith(root + sep)) throw new UserError(`${rel} is not a plain file inside the semantic root ${resolve(ctx.root)}; nothing was removed. Run sl validate.`, "sl validate");
  rmSync(file);
  if (ctx.json) ctx.out(formatJson({ discarded: id, path: rel, next: "sl next" }));
  else ctx.out(`Set aside readback ${id}: removed ${rel}. Answers already recorded from it stay in the ledger. Next: sl next.`);
  return 0;
}

const spec: CommandSpec = {
  summary: "Render a plain-English readback of approve targets and store it in .sl/pending/ for the owner's answer.",
  usage:
    "readback --targets <ref>,<ref>,... [--tolerance <t>] [--results <file> | --plan <plan_id>] | readback --discard <readback_id>\n\n" +
    "Each ref is an approve target: source.model, source.model.field, metric:<name> or access, or a golden to\n" +
    "confirm, golden:<name>, whose request it compiles and runs with its cross_check_sql (live, or from --results\n" +
    "or --plan) to read back the rows and tolerance sl goldens confirm would record (--tolerance, else the\n" +
    "file's, else the default). Writes\n" +
    ".sl/pending/<readback_id>.json with the numbered items and each item's content hash. --discard <readback_id> sets\n" +
    "a pending readback the owner will not answer aside: it removes its file, and answers recorded from it stay in the ledger.",
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
      throw new UserError("--targets is required: a comma-separated list of source.model, source.model.field, metric:<name>, golden:<name> or access. Run sl status to see them.");
    }
    const names = refs.map(parseTarget).flatMap((t) => (t.kind === "golden" ? [t.name] : []));
    const flags = (["tolerance", "results", "plan"] as const).filter((f) => str(values, f) !== undefined);
    if (flags.length && !names.length) throw new UserError(`--${flags[0]} applies only to golden:<name> targets, which read back a golden's rows.`);
    // A golden's rows come from compiling and running its request, before anything is written.
    const goldens = new Map<string, GoldenRun>();
    for (const name of names) if (!goldens.has(name)) goldens.set(name, await goldenRun(ctx, values, name));
    // A measure's or metric's figure on today's data, as evidence: a failure is its reason, never an error.
    const figures = await readbackFigures(ctx.root, refs, ctx.env);
    // The items are rendered, numbered and stored under the lock, so two readbacks never share an id.
    await ctx.lock();
    const rendered = renderReadbacks(ctx.root, refs, goldens, figures);
    const pending: PendingReadback = {
      readback_id: freshReadbackId(ctx.root),
      created_at: ctx.now().toISOString(),
      items: rendered.map((r, i) => {
        const run = r.target.startsWith("golden:") ? goldens.get(r.target.slice(7)) : undefined;
        const evidence = figures.get(r.target);
        return { n: i + 1, target: r.target, kind: "approve" as const, text: r.text, content_hash: r.content_hash, ...(run ? { tolerance: run.tolerance } : {}), ...(evidence ? { evidence } : {}) };
      }),
    };
    const path = writePending(ctx.root, pending);
    // What runs once the owner says yes to an item: its sl approve, or for a golden its sl goldens
    // confirm, reading the rows from where the readback did; an export source's goldens wait on the
    // upgrade to a connection, named once per source (decision D2).
    const rowsFrom = passedFlags(values, ["results", "plan"]);
    const nextSteps = afterYesSteps(
      ctx.root,
      pending.items.map((i) => i.target),
      (t) => (t.startsWith("golden:") ? `sl goldens confirm --name ${t.slice(7)}${rowsFrom}` : `sl approve --target ${t} --by "<owner>"`),
    );
    const next = `sl reply --readback ${pending.readback_id} --item <n> --text "<owner's words>" --verdict yes|no|change --by "<owner>"`;
    if (ctx.json) {
      ctx.out(formatJson({ readback_id: pending.readback_id, path, items: pending.items, next, next_steps: nextSteps }));
      return 0;
    }
    const lines = [`Readback ${pending.readback_id}, stored in ${path}. Read each item to the owner as written, ending with "Approve?".`, ""];
    for (const item of pending.items) {
      const [head, ...rest] = item.text.split("\n");
      lines.push(`${item.n}. ${head}`, ...rest.map((l) => `   ${l}`), "");
    }
    lines.push(`Only after the owner says yes to an item, approve it: ${nextSteps.join("; ")}. A no or a change goes into the YAML, then run sl readback again.`);
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

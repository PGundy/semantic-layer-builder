import type { CommandSpec } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { afterYesSteps } from "../lib/export-goldens.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { type GoldenRun, nextReadbackId, renderReadbacks, writePending } from "../lib/readback.ts";
import { parseTarget } from "../lib/refs.ts";
import { goldenRun, passedFlags } from "./goldens.ts";
import type { PendingReadback } from "../lib/types.ts";

const spec: CommandSpec = {
  summary: "Render a plain-English readback of approve targets and store it in .sl/pending/ for the owner's answer.",
  usage:
    "readback --targets <ref>,<ref>,... [--tolerance <t>] [--results <file> | --plan <plan_id>]\n\n" +
    "Each ref is an approve target: source.model, source.model.field, metric:<name> or access, or a golden to\n" +
    "confirm, golden:<name>, whose request it compiles and runs with its cross_check_sql (live, or from --results\n" +
    "or --plan) to read back the rows and tolerance sl goldens confirm would record (--tolerance, else the\n" +
    "file's, else the default). Writes\n" +
    ".sl/pending/<readback_id>.json with the numbered items and each item's content hash.",
  options: {
    targets: { type: "string", multiple: true },
    tolerance: { type: "string" },
    results: { type: "string" },
    plan: { type: "string" },
  },
  writes: "late",
  async run({ values }, ctx) {
    loadProject(ctx.root);
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
    // The items are rendered, numbered and stored under the lock, so two readbacks never share an id.
    await ctx.lock();
    const rendered = renderReadbacks(ctx.root, refs, goldens);
    const pending: PendingReadback = {
      readback_id: nextReadbackId(ctx.root),
      created_at: ctx.now().toISOString(),
      items: rendered.map((r, i) => {
        const run = r.target.startsWith("golden:") ? goldens.get(r.target.slice(7)) : undefined;
        return { n: i + 1, target: r.target, kind: "approve" as const, text: r.text, content_hash: r.content_hash, ...(run ? { tolerance: run.tolerance } : {}) };
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

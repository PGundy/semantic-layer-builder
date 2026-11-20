import { type CommandSpec, str } from "../lib/command.ts";
import { CHANGE_FILE, loadChange, readChange, writeChange } from "../lib/change-record.ts";
import { changeSince, type ItemDiff } from "../lib/changeset.ts";
import { type DriftRecord, readDrift } from "../lib/drift-record.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { readChangelog } from "../lib/release.ts";

const SUBCOMMANDS = ["status", "start"] as const;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The version a release after `v` would take if the owner counts up by one minor.
const nextVersion = (v: string) => `${v.split(".")[0]}.${Number(v.split(".")[1]) + 1}`;

function driftLines(drift: DriftRecord): string[] {
  const out: string[] = [];
  for (const s of drift.sources) {
    const d = s.diff;
    const parts = [
      d.tables_added.length ? plural(d.tables_added.length, "table") + " added" : "",
      d.tables_removed.length ? plural(d.tables_removed.length, "table") + " removed" : "",
      d.columns.length ? plural(d.columns.length, "table") + " with changed columns" : "",
    ].filter(Boolean);
    out.push(`  ${s.source}, found ${s.at}: ${parts.join(", ") || "no table or column change"}`);
    for (const r of s.retyped) out.push(`    ${r.table}.${r.column} retyped ${r.from} -> ${r.to}, read by ${r.reads.map((x) => x.ref).join(", ") || "no approved field"}`);
  }
  return out;
}

function statusCommand(root: string, ctx: { json: boolean; out: (t: string) => void }): number {
  loadProject(root);
  const log = readChangelog(root);
  const drift = readDrift(root);
  if (!log || !log.entries.length) {
    const next = "semlayer change close --version 1.0";
    if (ctx.json) ctx.out(formatJson({ released: false, version: null, added: [], changed: [], removed: [], drift, next }));
    else {
      const lines = ["This layer has no release yet, so there is nothing to compare with.", `Next: ${next} records the layer as it stands as release 1.0.`];
      if (drift) lines.push("Schema changes on record (.semlayer/drift.json):", ...driftLines(drift));
      ctx.out(lines.join("\n"));
    }
    return 0;
  }
  const last = log.entries[log.entries.length - 1]!;
  const diff: ItemDiff = changeSince(root, last.items);
  const none = !diff.added.length && !diff.changed.length && !diff.removed.length;
  const drafts = diff.changed.filter((c) => c.state === "draft").map((c) => c.ref);
  const next = none ? "semlayer next" : drafts.length ? `semlayer readback --targets ${drafts[0]}` : `semlayer change close --version ${nextVersion(last.version)}`;
  if (ctx.json) {
    ctx.out(formatJson({ released: true, version: last.version, date: last.date, ...diff, drift, next }));
    return 0;
  }
  const lines = [none ? `No changes since release ${last.version} (${last.date}).` : `Changes since release ${last.version} (${last.date}):`];
  if (diff.added.length) lines.push(`  added (${diff.added.length}): ${diff.added.join(", ")}`);
  if (diff.changed.length) {
    lines.push(`  changed (${diff.changed.length}):`);
    for (const c of diff.changed) lines.push(`    ${c.ref}: ${c.state === "draft" ? "draft, waits for the owner's yes" : "approved again"}${c.affected_goldens.length ? `; read by goldens ${c.affected_goldens.join(", ")}` : ""}`);
  }
  if (diff.removed.length) lines.push(`  removed (${diff.removed.length}): ${diff.removed.join(", ")}`);
  if (drift) lines.push("Schema changes on record (.semlayer/drift.json):", ...driftLines(drift));
  lines.push(`Next: ${next}`);
  ctx.out(lines.join("\n"));
  return 0;
}

const START = 'semlayer change start --note "<what the owner wants changed>" --by "<owner>"';

// Opens a change round on a released layer: .semlayer/change.json holds the note, who asked, when
// (the command's clock) and the release the round starts from. Called under the root's lock.
function startCommand(root: string, note: string | undefined, by: string | undefined, ctx: { json: boolean; now: () => Date; out: (t: string) => void }): number {
  loadProject(root);
  if (!note?.trim() || !by?.trim())
    throw new UserError(`semlayer change start needs --note (what the owner wants changed) and --by (who asked for it). Run ${START}.`, START, "release.change_missing_input");
  if (note.trim().length > 500 || by.trim().length > 200)
    throw new UserError(
      `The note can be at most 500 characters and the name at most 200 (this one has ${note.trim().length} and ${by.trim().length}). Shorten them and run ${START}.`,
      START,
      "release.change_too_long",
    );
  const { change, problem } = loadChange(root);
  if (problem) readChange(root);
  if (change)
    throw new UserError(
      `A change round is already open (started ${change.started_at.slice(0, 10)} by ${change.started_by}: "${change.note}"). Run semlayer change status to see what it changed; only one round is open at a time.`,
      "semlayer change status",
      "release.change_open",
    );
  const last = readChangelog(root)?.entries.at(-1);
  if (!last)
    throw new UserError(
      "This layer has no release yet, so there is no version to start a change round from. Record the layer as release 1.0 first (it saves the items and golden figures as they stand), then start the round.",
      "semlayer change close --version 1.0",
      "release.change_unreleased",
    );
  const record = { version: 1 as const, note: note.trim().replace(/\s+/g, " "), started_by: by.trim().replace(/\s+/g, " "), started_at: ctx.now().toISOString(), from_version: last.version };
  writeChange(root, record);
  const next = "semlayer next";
  if (ctx.json) ctx.out(formatJson({ started: true, file: CHANGE_FILE, ...record, next }));
  else
    ctx.out(
      [
        `Change round started from release ${last.version}: "${record.note}".`,
        "Make only the edits the owner asked for; each item you change goes back to draft until the owner's recorded yes.",
        `Next: ${next} names the next step; semlayer change status lists what has moved since release ${last.version}.`,
      ].join("\n"),
    );
  return 0;
}

const spec: CommandSpec = {
  summary: "Start a change round on a released layer, or show the items added, changed and removed since its last release.",
  usage: `change status | change start --note <text> --by <name>`,
  options: {
    note: { type: "string" },
    by: { type: "string" },
  },
  positionals: true,
  writes: ({ positionals }) => (positionals[0] === "start" ? "whole" : false),
  async run({ positionals, values }, ctx) {
    const [sub, ...rest] = positionals;
    if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub))
      throw new UserError(`Pass a subcommand: ${SUBCOMMANDS.join(", ")}. semlayer change status lists what changed since the last release.`, "semlayer change status");
    if (rest.length) throw new UserError(`Unexpected argument "${rest[0]}". Run semlayer change ${sub}.`, `semlayer change ${sub}`);
    const flags = (["note", "by"] as const).filter((f) => str(values, f) !== undefined);
    if (sub === "status") {
      if (flags.length) throw new UserError(`semlayer change status takes no --${flags[0]}; that flag is for semlayer change start.`, "semlayer change status");
      return statusCommand(ctx.root, ctx);
    }
    return startCommand(ctx.root, str(values, "note"), str(values, "by"), ctx);
  },
};
export default spec;

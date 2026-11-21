import { canRun, openAdapter } from "../lib/adapters/index.ts";
import { type CommandContext, type CommandSpec, str } from "../lib/command.ts";
import { CHANGE_FILE, loadChange, readChange, removeChange, writeChange } from "../lib/change-record.ts";
import { affectedGoldens, changeSince, type ItemDiff, deferredAtStart, goldensLeftOut, itemDefinitions, itemMap, leftOut } from "../lib/changeset.ts";
import { type DriftRecord, readDrift } from "../lib/drift-record.ts";
import { resolveConnection } from "../lib/env-file.ts";
import { UserError } from "../lib/errors.ts";
import { compareRows, compileGolden, groupingColumns, resultColumns } from "../lib/goldens.ts";
import { intakeMode } from "../lib/intake.ts";
import { BACKFILL_BATCH } from "../lib/next.ts";
import { formatJson, plainText, protectedNames, protectedResultColumns } from "../lib/output.ts";
import { listGoldens, loadProject, loadSource, paths } from "../lib/project.ts";
import type { GoldenRun } from "../lib/readback.ts";
import { appendEntry, CHANGELOG_FILE, compareVersions, movedCells, readChangelog, VERSION_PATTERN } from "../lib/release.ts";
import type { ChangelogEntry, GoldenMoved } from "../lib/release-types.ts";
import type { Golden, SourceConfig } from "../lib/types.ts";
import { validateProject } from "../lib/validate.ts";
import { updateYaml } from "../lib/yaml.ts";
import { goldenRun } from "./goldens.ts";

const SUBCOMMANDS = ["status", "start", "close"] as const;

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
  const diff: ItemDiff = changeSince(root, last.items, last.definitions, last.date);
  // An added item that is a draft is not approved. The close leaves a plain one (never approved, not in the
  // last release) out, so only an item the close would refuse waits for the owner's yes.
  const now = itemMap(root);
  const addedDrafts = diff.added.filter((r) => now.get(r)?.approved === false);
  const round = readChange(root);
  const atStart = round ? (round.drafts_at_start ?? []) : null;
  const waiting = [...now].filter(([r, v]) => !v.approved && !deferredAtStart(r, v, last.items, atStart)).map(([r]) => r).sort();
  const none = !diff.added.length && !diff.changed.length && !diff.removed.length && !waiting.length;
  const next = none ? "semlayer next" : waiting.length ? `semlayer readback --targets ${waiting[0]}` : `semlayer change close --version ${nextVersion(last.version)}`;
  if (ctx.json) {
    ctx.out(formatJson({ released: true, version: last.version, date: last.date, ...diff, added_drafts: addedDrafts, drift, next }));
    return 0;
  }
  const lines = [none ? `No changes since release ${last.version} (${last.date}).` : `Changes since release ${last.version} (${last.date}):`];
  if (diff.added.length) lines.push(`  added (${diff.added.length}): ${diff.added.map((r) => (addedDrafts.includes(r) ? `${r} (draft)` : r)).join(", ")}`);
  if (diff.changed.length) {
    lines.push(`  changed (${diff.changed.length}):`);
    for (const c of diff.changed)
      lines.push(
        `    ${c.ref}: ${c.description_only ? "description only, its definition and figures as released; " : ""}${c.state === "draft" ? "draft, waits for the owner's yes" : "approved again"}${c.affected_goldens.length ? `; read by goldens ${c.affected_goldens.join(", ")}` : ""}`,
      );
  }
  if (diff.removed.length) lines.push(`  removed (${diff.removed.length}): ${diff.removed.join(", ")}`);
  const held = waiting.filter((r) => !diff.added.includes(r) && !diff.changed.some((c) => c.ref === r));
  if (held.length) lines.push(`  not approved as they stand, so the close waits (${held.length}): ${held.join(", ")}`);
  if (addedDrafts.some((r) => !waiting.includes(r))) lines.push("  A draft the owner deferred is left out of the release until they approve it.");
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
  // The drafts never approved now are the owner's deferred ones: next leaves them to the close, and reads back any draft made later.
  const draftsAtStart = [...itemMap(root)].filter(([ref, x]) => leftOut(ref, x, last.items)).map(([ref]) => ref).sort();
  const record = { version: 1 as const, note: note.trim().replace(/\s+/g, " "), started_by: by.trim().replace(/\s+/g, " "), started_at: ctx.now().toISOString(), from_version: last.version, drafts_at_start: draftsAtStart };
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

const CLOSE = (v: string) => `semlayer change close --version ${v}`;

// An affected golden whose figures were not compared with its recorded rows, and why.
interface NotRerun {
  golden: string;
  source: string;
  reason: string;
}

// Why the goldens of `source` cannot be rerun now, or null when its connection opens. Names a
// variable that is not set, never a value or the database's message.
async function cannotQuery(ctx: CommandContext, source: SourceConfig): Promise<string | null> {
  if (intakeMode(source) === "export") return `source ${source.source} was set up from a schema export and has no connection`;
  if (!canRun(source)) return `semlayer does not connect to ${source.dialect} sources`;
  try {
    const res = resolveConnection(ctx.root, source, ctx.env);
    if (res.status === "unset") return `source ${source.source} has no connection here: ${res.variables.join(", ")} ${res.variables.length === 1 ? "is" : "are"} not set`;
    const adapter = await openAdapter(ctx.root, source, ctx.env, { warn: () => {} });
    await adapter.close();
  } catch {
    return `the connection to source ${source.source} did not open`;
  }
  return null;
}

// Records a release (spec: Iterating a layer, Closing a round): the first, 1.0 or the version the owner
// chose, with no round open; later ones close the open round. The release holds the items approved as
// they stand; a draft never approved and not in the last release is left out and listed. Refused, writing
// nothing, while another item is not approved as it stands (edited since its approval, or held by the last
// release and now a draft), a confirmed golden reads a left-out draft, semlayer validate has an error, or an
// affected golden's figures moved from its recorded rows; each blocker is listed with its command. Approves and confirms nothing. Called
// under the root's lock, which it holds from its first read to its last write.
async function closeCommand(ctx: CommandContext, version: string | undefined): Promise<number> {
  const project = loadProject(ctx.root);
  const last = readChangelog(ctx.root)?.entries.at(-1);
  const round = readChange(ctx.root);
  const suggested = last ? nextVersion(last.version) : "1.0";
  // A close stopped after its entry leaves the round's file behind, from a release below the last: removing it finishes that close.
  if (round && last && compareVersions(round.from_version, last.version) < 0) {
    removeChange(ctx.root);
    const said = `The change round from release ${round.from_version} was already recorded as release ${last.version}; its file, ${CHANGE_FILE}, is removed and nothing else changed.`;
    ctx.out(ctx.json ? formatJson({ closed: true, version: last.version, already_recorded: true, layer_version: project.layer_version ?? null, next: START }) : `${said}\nNext: ${START}.`);
    return 0;
  }
  const v = version?.trim() ?? "";
  if (!v)
    throw new UserError(
      `semlayer change close needs --version, the version the owner chose for this release (major.minor, ${last ? `above ${last.version}, such as ${suggested}` : "such as 1.0"}). Run ${CLOSE(suggested)} with the owner's version.`,
      CLOSE(suggested),
      "release.close_missing_version",
    );
  if (!VERSION_PATTERN.test(v))
    throw new UserError(`"${v}" is not a layer version: write it as major.minor, such as ${suggested}. Nothing was written.`, CLOSE(suggested), "release.version_invalid");
  if (last && compareVersions(v, last.version) <= 0)
    throw new UserError(
      `Version ${v} is not above the last release, ${last.version}, so it cannot be recorded; nothing was written. Ask the owner for a higher version, such as ${suggested}.`,
      CLOSE(suggested),
      "release.version_not_above",
    );
  if (last && !round)
    throw new UserError(
      `No change round is open, so there is nothing to close: release ${last.version} is the layer as it stands. When the owner asks for a change, open a round with ${START}.`,
      START,
      "release.close_no_round",
    );

  const all = itemMap(ctx.root);
  const baseline = last?.items ?? {};
  // The release holds only the items approved as they stand. A draft never approved and absent from the last release is left out.
  const draftsLeftOut = [...all].filter(([ref, x]) => leftOut(ref, x, baseline)).map(([ref]) => ref).sort();
  const items = new Map([...all].filter(([, x]) => x.approved));
  const blockers: { why: string; next: string }[] = [];
  const pending = [...all].filter(([ref, x]) => !x.approved && !leftOut(ref, x, baseline)).map(([ref]) => ref).sort();
  if (pending.length)
    blockers.push({
      why: `${plural(pending.length, "item")} ${pending.length === 1 ? "is" : "are"} not approved as ${pending.length === 1 ? "it stands" : "they stand"} (edited since approval, or a draft the owner approved or released before): ${pending.join(", ")}. Read each back to the owner and approve it on their recorded yes.`,
      next: `semlayer readback --targets ${pending.slice(0, BACKFILL_BATCH).join(",")}`,
    });
  // A close stopped after writing layer_version is finished by the same command: that mismatch is not a blocker.
  const errors = validateProject(ctx.root).filter((i) => i.level === "error" && !(i.code === "release.version_mismatch" && project.layer_version === v));
  if (errors.length)
    blockers.push({ why: `semlayer validate reports ${plural(errors.length, "error")}: ${errors.map((i) => `${i.file}${i.path ? ` ${i.path}` : ""}: ${i.message}`).join("; ")}.`, next: "semlayer validate" });

  const goldens = new Map<string, Golden>();
  for (const { golden: g } of listGoldens(ctx.root)) if (g && typeof g === "object" && g.status === "approved" && typeof g.name === "string") goldens.set(g.name, g);
  const diff: ItemDiff = last ? changeSince(ctx.root, last.items, last.definitions, last.date) : { added: [], changed: [], removed: [] };
  const affected = [...new Set(diff.changed.flatMap((c) => c.affected_goldens))].sort();
  const notRerun: NotRerun[] = [];
  const reach = new Map<string, string | null>();
  for (const name of affected) {
    const g = goldens.get(name)!;
    const source = loadSource(ctx.root, g.request.source);
    if (!reach.has(source.source)) reach.set(source.source, await cannotQuery(ctx, source));
    const reason = reach.get(source.source);
    if (reason) {
      notRerun.push({ golden: name, source: source.source, reason });
      continue;
    }
    let run: GoldenRun;
    try {
      run = await goldenRun(ctx, {}, name);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      blockers.push({ why: `golden ${name}'s queries did not run, so its figures could not be compared with its recorded rows.`, next: `semlayer goldens check --name ${name}` });
      continue;
    }
    const recorded = (g.expected?.rows ?? []).map((r) => Object.fromEntries(Object.entries(r ?? {}).map(([k, x]) => [k.toLowerCase(), x])));
    const cmp = compareRows(recorded, run.rows, {
      ordered: (g.request.order_by ?? []).length > 0,
      tolerance: run.tolerance,
      protectedColumns: [...run.masked, ...protectedResultColumns(resultColumns([...recorded, ...run.rows]), protectedNames(ctx.root, source))],
      groupingColumns: groupingColumns(compileGolden(ctx.root, g)),
    });
    if (!cmp.ok)
      blockers.push({
        why:
          `golden ${name}'s figures moved from its recorded rows (expected is recorded, got is now): ${cmp.diffs.join(" ")} Show the owner the old and the new figures; their yes to the new rows, recorded with semlayer goldens confirm --name ${name}, settles it. ` +
          `If the owner cannot check the new figures now, semlayer goldens unconfirm --name ${name} returns it to draft and this release leaves it out.`,
        next: `semlayer readback --targets golden:${name}`,
      });
  }
  // A confirmed golden's recorded rows rest on every item it reads: one that reads a draft the release leaves out would put figures
  // in the release that the owner has not approved. validate only warns about it (golden.uses_draft), so the close refuses.
  if (draftsLeftOut.length) {
    const readers = affectedGoldens(ctx.root, draftsLeftOut);
    for (const [ref, names] of readers)
      for (const name of names)
        blockers.push({
          why: `golden ${name} is confirmed and reads ${ref}, a draft the release would leave out, so its recorded rows would rest on an item the owner has not approved. Read ${ref} back for the owner's yes, or return the golden to draft with semlayer goldens unconfirm --name ${name}.`,
          next: `semlayer readback --targets ${ref}`,
        });
  }
  const skipped = notRerun.length
    ? `Not rerun (${notRerun.length}): ${notRerun.map((n) => `${n.golden} (${n.reason})`).join(", ")}; their figures were not compared with their recorded rows, so the release does not show whether they moved.`
    : "";
  if (blockers.length)
    throw new UserError(
      plainText(
        [`Cannot record release ${v}: ${plural(blockers.length, "thing")} must be settled first; nothing was written.`, ...blockers.map((b) => `- ${b.why} Next: ${b.next}`), ...(skipped ? [skipped] : [])].join("\n"),
      ),
      blockers[0]!.next,
      "release.close_blocked",
    );

  const recordedRows = Object.fromEntries([...goldens.keys()].sort().flatMap((n) => (Array.isArray(goldens.get(n)!.expected?.rows) ? [[n, goldens.get(n)!.expected!.rows]] : [])));
  const moved: GoldenMoved[] = [];
  for (const [name, rows] of Object.entries(recordedRows)) {
    const before = last?.goldens[name];
    if (!before || JSON.stringify(before) === JSON.stringify(rows)) continue;
    const g = goldens.get(name)!;
    // An ordered golden's rows pair by position; another's by its grouping columns.
    const cells = movedCells(before, rows, (g.request.order_by ?? []).length ? [] : groupingColumns(compileGolden(ctx.root, g)));
    if (cells.changed) moved.push({ golden: name, ...cells });
  }
  // A golden the last release recorded that is a draft now, or gone, is left out of this one and named; so is one
  // the last release left out that is still a draft with the same request.
  const outGoldens = goldensLeftOut(ctx.root, last?.goldens ?? {}, last?.goldens_unconfirmed_requests ?? {});
  const entry: ChangelogEntry = {
    version: v,
    date: ctx.now().toISOString().slice(0, 10),
    note: round?.note ?? "First release.",
    items: Object.fromEntries([...items].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([ref, x]) => [ref, x.hash])),
    definitions: itemDefinitions(items),
    goldens: recordedRows,
    added: diff.added.filter((r) => items.has(r)),
    changed: diff.changed.map((c) => c.ref),
    removed: diff.removed,
    goldens_moved: moved,
    ...(outGoldens.unconfirmed.length ? { goldens_unconfirmed: outGoldens.unconfirmed, goldens_unconfirmed_requests: outGoldens.requests } : {}),
    ...(outGoldens.removed.length ? { goldens_removed: outGoldens.removed } : {}),
  };
  // semantic.yaml first, then the changelog, then the round's file: a stop after the first write leaves
  // layer_version above the last entry (semlayer validate: release.version_mismatch), and the same close run
  // again finishes the release.
  updateYaml(paths(ctx.root).project, (doc) => doc.set("layer_version", v));
  appendEntry(ctx.root, entry);
  removeChange(ctx.root);

  const next = START;
  if (ctx.json) {
    ctx.out(formatJson({ closed: true, version: v, date: entry.date, note: entry.note, file: CHANGELOG_FILE, items: items.size, added: entry.added, changed: entry.changed, removed: entry.removed, goldens_moved: moved, goldens_unconfirmed: outGoldens.unconfirmed, goldens_removed: outGoldens.removed, not_rerun: notRerun, drafts_left_out: draftsLeftOut, layer_version: v, next }));
    return 0;
  }
  const list = (xs: string[]) => (xs.length ? `${xs.length} (${xs.join(", ")})` : "none");
  const lines = [`Release ${v} recorded in ${CHANGELOG_FILE} on ${entry.date}: "${entry.note}"`];
  if (last) {
    lines.push(`Since release ${last.version}: added ${list(entry.added)}; changed ${list(entry.changed)}; removed ${list(entry.removed)}.`);
    lines.push(
      moved.length
        ? `Goldens whose recorded figures moved since release ${last.version}: ${moved.map((m) => `${m.golden} (${m.changed} of ${m.after} cells changed)`).join(", ")}.`
        : `No golden's recorded figures moved since release ${last.version}.`,
    );
  } else lines.push(`It holds the ${plural(items.size, "item")} and the recorded rows of ${plural(Object.keys(recordedRows).length, "approved golden")} as they stand; later releases are compared with them.`);
  if (skipped) lines.push(skipped);
  if (outGoldens.unconfirmed.length)
    lines.push(
      `Goldens left out (${outGoldens.unconfirmed.length}): ${outGoldens.unconfirmed.join(", ")}. Release ${last!.version} held them; they are drafts now (returned to draft with semlayer goldens unconfirm: the owner has not confirmed their figures as they stand) and join a later release once the owner confirms them.`,
    );
  if (outGoldens.removed.length) lines.push(`Goldens removed (${outGoldens.removed.length}): ${outGoldens.removed.join(", ")}. Release ${last!.version} held them; their files are gone.`);
  if (draftsLeftOut.length) lines.push(`Drafts left out (${draftsLeftOut.length}): ${draftsLeftOut.join(", ")}. They are not part of this release and join a later one once the owner approves them.`);
  lines.push(`layer_version in semantic.yaml is now ${v}${round ? ", and the change round is closed" : ""}.`, `Next: when the owner asks for another change, ${next}.`);
  ctx.out(plainText(lines.join("\n")));
  return 0;
}

const spec: CommandSpec = {
  summary: "Start a change round on a released layer, show the items added, changed and removed since its last release, or close the round as a new release.",
  usage: `change status | change start --note <text> --by <name> | change close --version <major.minor>`,
  options: {
    note: { type: "string" },
    by: { type: "string" },
    version: { type: "string" },
  },
  positionals: true,
  writes: ({ positionals }) => (positionals[0] === "start" || positionals[0] === "close" ? "whole" : false),
  async run({ positionals, values }, ctx) {
    const [sub, ...rest] = positionals;
    if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub))
      throw new UserError(`Pass a subcommand: ${SUBCOMMANDS.join(", ")}. semlayer change status lists what changed since the last release.`, "semlayer change status");
    if (rest.length) throw new UserError(`Unexpected argument "${rest[0]}". Run semlayer change ${sub}.`, `semlayer change ${sub}`);
    const flags = (["note", "by", "version"] as const).filter((f) => str(values, f) !== undefined);
    const owner = (f: string) => (f === "version" ? "semlayer change close" : "semlayer change start");
    if (sub === "status") {
      if (flags.length) throw new UserError(`semlayer change status takes no --${flags[0]}; that flag is for ${owner(flags[0]!)}.`, "semlayer change status");
      return statusCommand(ctx.root, ctx);
    }
    if (sub === "close") {
      const extra = flags.find((f) => f !== "version");
      if (extra) throw new UserError(`semlayer change close takes no --${extra}; the round's note is the one semlayer change start recorded.`, "semlayer change close --version <version>");
      return closeCommand(ctx, str(values, "version"));
    }
    if (flags.includes("version")) throw new UserError("semlayer change start takes no --version; the version is chosen when the round closes.", START);
    return startCommand(ctx.root, str(values, "note"), str(values, "by"), ctx);
  },
};
export default spec;

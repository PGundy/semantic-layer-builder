import type { CommandSpec } from "../lib/command.ts";
import { changeSince, type ItemDiff } from "../lib/changeset.ts";
import { type DriftRecord, readDrift } from "../lib/drift-record.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { readChangelog } from "../lib/release.ts";

const SUBCOMMANDS = ["status"] as const;

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

const spec: CommandSpec = {
  summary: "Show the items added, changed and removed since the layer's last release.",
  usage: "change status",
  options: {},
  positionals: true,
  writes: false,
  async run({ positionals }, ctx) {
    const [sub, ...rest] = positionals;
    if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub))
      throw new UserError(`Pass a subcommand: ${SUBCOMMANDS.join(", ")}. semlayer change status lists what changed since the last release.`, "semlayer change status");
    if (rest.length) throw new UserError(`Unexpected argument "${rest[0]}". Run semlayer change status.`, "semlayer change status");
    return statusCommand(ctx.root, ctx);
  },
};
export default spec;

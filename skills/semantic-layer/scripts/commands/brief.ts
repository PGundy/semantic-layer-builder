import { type BriefPacket, buildBrief, DEFAULT_BRIEF_BUDGET, type DroppedKind, serializeBrief } from "../lib/brief.ts";
import type { CommandSpec } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { loadProject } from "../lib/project.ts";
import { sourceFlag } from "./tables.ts";

function positiveInt(flag: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v.trim()) || Number(v) < 1) throw new UserError(`--${flag} needs a whole number of 1 or more, such as --${flag} ${flag === "budget" ? DEFAULT_BRIEF_BUDGET : 1}.`);
  return Number(v);
}

// A word as a shell argument: kept bare when it is plain, single-quoted otherwise.
function arg(word: string): string {
  return /^[A-Za-z0-9_.,:-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

const KIND_WORDS: Record<DroppedKind, string> = {
  top_values: "top values",
  column_details: "column details",
  baseline_guesses: "baseline guesses",
};

// What was trimmed, by kind, as "top values of 2 tables, column details of 1 table".
function trimmed(p: BriefPacket): string {
  return (Object.keys(KIND_WORDS) as DroppedKind[])
    .map((what) => [what, new Set(p.budget.dropped.filter((d) => d.what === what).map((d) => d.table)).size] as const)
    .filter(([, n]) => n > 0)
    .map(([what, n]) => `${KIND_WORDS[what]} of ${n} table${n === 1 ? "" : "s"}`)
    .join(", ");
}

function render(p: BriefPacket, again: string): string {
  const head = p.batch === null ? `Packet for ${p.source}` : `Batch ${p.batch} of ${p.batches} for ${p.source}`;
  const lines = [`${head}: ${p.tables.length} table${p.tables.length === 1 ? "" : "s"}.`];
  for (const t of p.tables) lines.push(`  ${t.table}  ${t.model ? `${t.model_status} model ${t.model}` : "no model"}, ${t.columns.length} columns, ${t.drafted_fields.length} fields, ${t.open_questions.length} open questions`);
  const b = p.budget;
  lines.push(`About ${b.used.toLocaleString("en-US")} of ${b.limit.toLocaleString("en-US")} tokens${b.truncated ? `; ${b.within_limit ? "trimmed to fit" : "trimmed"} (${trimmed(p)})` : ""}.`);
  if (!b.within_limit) lines.push(`Still over the budget: drafted fields and open questions are never trimmed. Name fewer tables with --tables, or pass a larger --budget.`);
  lines.push(`For the packet: ${again} --json`);
  lines.push(p.batch !== null && p.batch < p.batches ? `Next batch: sl brief --source ${p.source} --batch ${p.batch + 1}` : "Then: sl next");
  return lines.join("\n");
}

const spec: CommandSpec = {
  summary:
    "Print one interview batch as a compact JSON packet for a batch analyst: columns with counts, drafted fields, joins, open questions and baseline guesses, " +
    "under a token budget. Data text is fenced with its provenance; protected columns carry counts only. Writes nothing.",
  usage:
    "brief --source <s> (--batch <n> | --tables t,...) [--budget <tokens>]\n\n" +
    "Batch n is the nth batch_size tables of the order sl status takes next_batch from (batch 1 is next_batch); --tables names the tables instead.\n" +
    `--budget is the token budget (default ${DEFAULT_BRIEF_BUDGET}; tokens are estimated as the printed JSON's characters / 4, rounded up).\n` +
    "--json prints { source, batch, batches, tables: [{ table, model, model_status, grain?, row_count, description?, columns, drafted_fields, joins,\n" +
    "open_questions, baseline_guesses? }], budget: { limit, used, truncated, within_limit, dropped } }.",
  options: {
    source: { type: "string" },
    batch: { type: "string" },
    tables: { type: "string", multiple: true },
    budget: { type: "string" },
  },
  writes: false,
  async run({ values }, ctx) {
    const source = sourceFlag(values, loadProject(ctx.root));
    const batch = positiveInt("batch", str(values, "batch"));
    const budget = positiveInt("budget", str(values, "budget"));
    const tables = list(values, "tables");
    if (batch !== undefined && tables.length) throw new UserError("Give --batch <n> or --tables, not both: --tables names the packet's tables itself.");
    if (batch === undefined && !tables.length) throw new UserError(`Give --batch <n> (1 is sl status's next_batch), as in sl brief --source ${source} --batch 1, or --tables t,...`);
    const packet = buildBrief(ctx.root, { source, ...(batch !== undefined ? { batch } : {}), tables, ...(budget !== undefined ? { budget } : {}) });
    if (ctx.json) {
      ctx.out(serializeBrief(packet));
      return 0;
    }
    const again = `sl brief --source ${source} ${batch !== undefined ? `--batch ${batch}` : `--tables ${arg(tables.join(","))}`}${budget !== undefined ? ` --budget ${budget}` : ""}`;
    ctx.out(render(packet, again));
    return 0;
  },
};
export default spec;

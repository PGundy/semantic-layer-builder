import { relative, resolve } from "node:path";
import type { CommandContext, CommandSpec, OptionValues } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { addResult, planStatus } from "../lib/plan.ts";

const SUBCOMMANDS = ["add", "status"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function required(values: OptionValues, key: string, sub: Subcommand): string {
  const v = str(values, key);
  if (!v) throw new UserError(`results ${sub} needs --${key} <${key === "file" ? "rows.json" : key === "plan" ? "plan_id" : "query id"}>.`);
  return v;
}

function shown(ctx: CommandContext, path: string): string {
  return relative(ctx.cwd, path) || path;
}

function addCommand(ctx: CommandContext, values: OptionValues): number {
  const id = required(values, "plan", "add");
  const query = required(values, "query", "add");
  const file = resolve(ctx.cwd, required(values, "file", "add"));
  const added = addResult(ctx.root, id, query, file);
  const status = planStatus(ctx.root, id);
  if (ctx.json) {
    ctx.out(formatJson({ ...added, remaining: status.remaining, complete: status.complete, next: status.next }));
    return 0;
  }
  const what =
    added.state === "unchanged"
      ? `The same ${added.rows} row${added.rows === 1 ? " was" : "s were"} already stored for "${query}"; nothing changed.`
      : `${added.state === "added" ? "Stored" : "Replaced the stored result with"} ${added.rows} row${added.rows === 1 ? "" : "s"} for "${query}" in ${shown(ctx, added.path)}.`;
  const left = status.remaining.length;
  ctx.out(`${what} ${left ? `${left} of ${status.queries.length} queries still need results.` : "Every query of the plan has its result."}`);
  ctx.out(status.next);
  return 0;
}

function statusCommand(ctx: CommandContext, values: OptionValues): number {
  const status = planStatus(ctx.root, required(values, "plan", "status"));
  if (ctx.json) {
    ctx.out(formatJson(status));
    return 0;
  }
  const done = status.queries.length - status.remaining.length;
  const lines = [`Plan ${status.plan_id} (sl ${status.command}, source ${status.source}): ${done} of ${status.queries.length} results stored.`];
  for (const q of status.queries) {
    lines.push(`  ${q.stored ? "stored " : "missing"}  ${q.id}${q.stored ? ` (${q.rows} row${q.rows === 1 ? "" : "s"})` : ` (max_rows ${q.max_rows})`}`);
  }
  lines.push(status.next);
  ctx.out(lines.join("\n"));
  return 0;
}

const spec: CommandSpec = {
  summary: "Store the result of one query of an emitted plan, or show which queries of the plan still need results.",
  usage: "results add --plan <plan_id> --query <query id> --file <rows.json> | results status --plan <plan_id>",
  options: {
    plan: { type: "string" },
    query: { type: "string" },
    file: { type: "string" },
  },
  positionals: true,
  async run({ values, positionals }, ctx) {
    const [sub, ...rest] = positionals;
    if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
      throw new UserError(`Pass a subcommand: ${SUBCOMMANDS.join(", ")}. sl results status --plan <plan_id> shows a plan's progress.`);
    }
    if (rest.length) {
      throw new UserError(
        `Unexpected argument "${rest[0]}". Run sl results add --plan <plan_id> --query <query id> --file <rows.json> or sl results status --plan <plan_id>.`,
      );
    }
    if (sub === "status" && (str(values, "query") !== undefined || str(values, "file") !== undefined)) {
      throw new UserError("results status takes only --plan <plan_id>; store a result with sl results add.");
    }
    return sub === "add" ? addCommand(ctx, values) : statusCommand(ctx, values);
  },
};
export default spec;

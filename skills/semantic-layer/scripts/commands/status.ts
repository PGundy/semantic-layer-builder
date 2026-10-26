import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { formatJson } from "../lib/output.ts";
import { computeStatus, type ApprovalCount, type ProjectStatus, type SourceStatus } from "../lib/status.ts";

function ratio(c: ApprovalCount): string {
  return `${c.approved}/${c.approved + c.draft} approved`;
}

function sourceLines(s: SourceStatus): string[] {
  const lines = [`${s.source} (${s.dialect}${s.runnable ? "" : ", via query plans"})`];
  if (!s.snapshot) {
    lines.push("  snapshot: none");
    return lines;
  }
  const snap = s.snapshot;
  lines.push(
    `  snapshot: ${snap.method}, ${snap.captured_at}; ${snap.tables} tables, ${snap.in_scope} in scope, ${snap.profiled} profiled` +
      (s.needs_focus ? " (needs focus)" : ""),
  );
  lines.push(
    `  models: ${s.models.approved}/${s.models.total} approved, ${s.tables_without_model} in-scope table(s) without a model`,
  );
  lines.push(`  dimensions ${ratio(s.dimensions)}, measures ${ratio(s.measures)}, joins ${ratio(s.joins)}`);
  const extras: string[] = [];
  if (s.joins_without_evidence) extras.push(`${s.joins_without_evidence} join(s) without evidence`);
  if (s.open_questions) extras.push(`${s.open_questions} open question(s)`);
  if (extras.length) lines.push(`  ${extras.join(", ")}`);
  return lines;
}

function render(st: ProjectStatus): string {
  const lines = [`Project ${st.project}`];
  for (const s of st.sources) lines.push(...sourceLines(s));
  if (!st.sources.length) lines.push("No sources.");
  lines.push(
    `metrics ${ratio(st.metrics)}; access ${st.access.state}${st.access.state === "missing" ? "" : ` (${st.access.roles} role(s))`}; goldens ${ratio(st.goldens)}`,
  );
  if (st.next_batch) {
    lines.push(`Next batch (${st.next_batch.source}):`);
    for (const b of st.next_batch.tables) {
      lines.push(`  ${b.table}  [${b.model ? `model ${b.model}, draft` : "no model"}]  ${b.reasons.join("; ")}`);
    }
  }
  lines.push(`Next step (${st.next_step.phase}): ${st.next_step.message}`);
  lines.push(`  ${st.next_step.command}`);
  return lines.join("\n");
}

const spec: CommandSpec = {
  summary: "Show progress per source and the next batch of tables to interview.",
  usage: "status [--source <source>]",
  options: { source: { type: "string" } },
  async run({ values }, ctx) {
    const st = computeStatus(ctx.root, str(values, "source"));
    ctx.out(ctx.json ? formatJson(st) : render(st));
    return 0;
  },
};
export default spec;

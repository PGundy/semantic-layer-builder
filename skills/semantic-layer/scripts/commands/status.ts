import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { formatJson } from "../lib/output.ts";
import { computeStatus, preview, type ApprovalCount, type ProjectStatus, type SourceStatus } from "../lib/status.ts";

function ratio(c: ApprovalCount): string {
  return `${c.approved}/${c.approved + c.draft} approved`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// One line naming the access mode and what a user with no attributes and no roles sees.
function audienceLine(st: ProjectStatus): string {
  const a = st.access.default_audience;
  const hidden = a.hidden_by_protected_tags ? `; ${a.hidden_by_protected_tags} hidden by protected tags` : "";
  return (
    `access mode ${st.access.mode}${st.access.state === "missing" ? " (no access.yaml)" : ""}; the default audience sees ` +
    `${plural(a.models, "model")}, ${plural(a.fields, "field")}, ${plural(a.metrics, "metric")}${hidden}`
  );
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
  // Draft fields inside approved models do not block later phases; they are listed for the handoff.
  const approvedDrafts = s.draft_fields.filter((f) => s.models_with_draft_fields.includes(f.split(".")[0]!));
  if (approvedDrafts.length) lines.push(`  draft fields in approved models: ${approvedDrafts.join(", ")}`);
  if (s.missing_columns.length) {
    const items = s.missing_columns.map((m) => `${m.model}.${m.field} reads ${m.column}`);
    lines.push(`  missing columns: ${preview(items, 8)}`);
  }
  if (s.new_columns.length) {
    const items = s.new_columns.map((c) => `${c.model}.${c.column} (${c.type})`);
    lines.push(`  new columns without a field: ${preview(items, 8)}`);
  }
  if (s.missing_tables.length) {
    const items = s.missing_tables.map((m) => `${m.model} (${m.table})`);
    lines.push(`  models on tables the snapshot no longer has: ${preview(items, 8)}`);
  }
  return lines;
}

function render(st: ProjectStatus): string {
  const lines = [`Project ${st.project}`];
  for (const s of st.sources) lines.push(...sourceLines(s));
  if (!st.sources.length) lines.push("No sources.");
  const accessQuestions = st.access.open_questions ? `, ${st.access.open_questions} open question(s)` : "";
  lines.push(
    `metrics ${ratio(st.metrics)}; access ${st.access.state}${st.access.state === "missing" ? "" : ` (${st.access.roles} role(s)${accessQuestions})`}; goldens ${ratio(st.goldens)}`,
  );
  lines.push(audienceLine(st));
  if (st.draft_metrics.length) lines.push(`draft metrics: ${st.draft_metrics.join(", ")}`);
  if (st.draft_goldens.length) lines.push(`draft goldens: ${st.draft_goldens.join(", ")}`);
  if (st.roles_without_goldens.length) lines.push(`roles without an approved golden: ${st.roles_without_goldens.join(", ")}`);
  if (st.next_batch) {
    lines.push(`Next batch (${st.next_batch.source}):`);
    for (const b of st.next_batch.tables) {
      lines.push(`  ${b.table}  [${b.model ? `model ${b.model}, draft` : "no model"}]  ${b.reasons.join("; ")}`);
    }
  }
  lines.push(`Next step (${st.next_step.phase}): ${st.next_step.message}`);
  lines.push(
    st.next_step.after_owner_yes
      ? `  Only after the owner says yes to its readback: ${st.next_step.command}`
      : `  ${st.next_step.command}`,
  );
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

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AccessVisibility,
  type AppliedRowFilter,
  CHANGED_SINCE_APPROVAL,
  type Counts,
  evaluateAccess,
  HASH_MISSING,
  lastApprovedNote,
  type ModelRows,
  type ModelVisibility,
  reapproveCommand,
  type RowFilterJoinRef,
  type SourceCounts,
} from "../lib/access.ts";
import type { CommandSpec } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";

type Show = "visible" | "hidden" | "all";

function parseUser(text: string, label: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new UserError(`${label} is not valid JSON: ${(e as Error).message}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new UserError(`${label} must be a JSON object of user attributes, such as {"region": "emea"}.`);
  return v as Record<string, unknown>;
}

const show = (v: unknown) => JSON.stringify(v);

// Where each join reference of a row filter reads from, e.g. "order.sales_rep_id reads wh.orders
// through join order".
function joinNotes(refs: RowFilterJoinRef[] | undefined): string[] {
  return (refs ?? []).map((r) => {
    const joins = r.hops.map((h) => h.join);
    return `${r.text} reads ${r.hops[r.hops.length - 1]!.to} through join${joins.length > 1 ? "s" : ""} ${joins.join(", ")}, without its row filters`;
  });
}

function describeFilter(f: AppliedRowFilter): string {
  if (f.kind === "expr") {
    const bound = Object.entries(f.params).map(([k, v]) => `user.${k} = ${show(v)}`);
    const missing = f.missing.map((k) => `user.${k} missing`);
    const extra = [...bound, ...missing].join(", ");
    const notes = [...(extra ? [extra] : []), ...joinNotes(f.join_refs)];
    return notes.length ? `${f.expr} (${notes.join("; ")})` : f.expr;
  }
  const who = f.missing.length ? `user.${f.user} missing` : `user.${f.user} = ${show(f.user_value)}`;
  const notes = [`${f.manager} -> ${f.member}`, who, ...joinNotes(f.join_refs)];
  return `${f.column} ${f.include_self ? "is the user or anyone" : "is anyone"} below them in ${f.via} (${notes.join("; ")})`;
}

function rowLines(ref: string, rows: ModelRows): string[] {
  if (rows.rows === "all") return [];
  if (rows.rows === "none") {
    const why = rows.branches.flatMap((b) => [
      ...b.filters.flatMap((f) => f.missing.map((m) => `${b.role} needs user.${m}`)),
      ...b.problems.map((p) => `${b.role}: ${p}`),
    ]);
    return [`    ${ref}: no rows (${[...new Set(why)].join("; ")})`];
  }
  const lines = [`    ${ref}: rows matching any of`];
  for (const b of rows.branches) {
    const body = b.no_rows
      ? `no rows (${[...b.filters.flatMap((f) => f.missing.map((m) => `needs user.${m}`)), ...b.problems].join("; ")})`
      : b.filters.map(describeFilter).join(" AND ");
    lines.push(`      ${b.role}: ${body}`);
  }
  return lines;
}

const counts = (c: Counts, word: string) => `${c.visible}/${c.visible + c.hidden} ${word}`;
const allCounts = (c: SourceCounts) => `${counts(c.models, "models")}, ${counts(c.fields, "fields")}, ${counts(c.metrics, "metrics")}`;

// Why an item is hidden; on an approved item that changed or lost its hash, its draft reason says so.
function why(x: { reasons: string[]; changed_since_approval?: true; hash_missing?: true }): string {
  const draft = x.changed_since_approval ? "draft: changed since approval" : x.hash_missing ? "draft: approved_hash missing" : "draft";
  return x.reasons.map((r) => (r === "draft" ? draft : r)).join(", ");
}

function modelLines(m: ModelVisibility, mode: Show): string[] {
  const out: string[] = [];
  if (!m.visible) {
    if (mode !== "visible") out.push(`    model ${m.ref}: hidden (${why(m)})${m.fields.length ? `, with its ${m.fields.length} field(s)` : ""}`);
    return out;
  }
  if (mode !== "hidden") out.push(`    model ${m.ref}`);
  for (const f of m.fields) {
    if (f.visible && mode !== "hidden") out.push(`      ${f.kind} ${f.name}`);
    else if (!f.visible && mode !== "visible") out.push(`    ${f.kind} ${f.ref}: hidden (${why(f)})`);
  }
  return out;
}

// The label on a draft access.yaml: with last_approved, the approved version that keeps applying;
// on an approved one that changed since or lost its hash, also how it is approved again.
function draftLabel(v: AccessVisibility): string {
  const note = v.changed_since_approval.includes("access") ? CHANGED_SINCE_APPROVAL : v.hash_missing.includes("access") ? HASH_MISSING : "";
  const changed = note ? `access.yaml ${note} (${reapproveCommand("access")}). ` : "";
  return v.last_approved
    ? `${changed}This explains a draft. ${lastApprovedNote(v.last_approved)}`
    : `${changed}This explains the draft access.yaml, which is awaiting sign-off: tools serve nothing under it until it is approved.`;
}

const NO_ROW_FILTERS = "  row filters: none (every row of every visible model)";

function render(v: AccessVisibility, mode: Show, rolesGiven: boolean): string {
  const lines: string[] = [];
  const file = v.access_file === "missing" ? "no access.yaml" : `access.yaml ${v.access_file}`;
  lines.push(`Access mode ${v.mode} (${file})`);
  if (v.access_file === "draft") lines.push(draftLabel(v));
  const attrs = Object.entries(v.user.attributes);
  // The assigned roles are named only when --roles gave them; roles held by condition or default follow.
  const assigned = rolesGiven ? `; assigned roles: ${v.user.roles.length ? v.user.roles.join(", ") : "none"}` : "";
  lines.push(
    v.user.default_audience
      ? "User: the default audience (no attributes, no assigned roles)"
      : `User: ${attrs.length ? attrs.map(([k, x]) => `${k}=${show(x)}`).join(", ") : "no attributes"}${assigned}`,
  );
  const held = v.roles.map((r) => (r.how === "condition" ? `${r.name} (condition: ${r.condition})` : `${r.name} (${r.how})`));
  lines.push(`Roles held: ${held.length ? held.join(", ") : v.mode === "open" ? "none (the open baseline, no row filters)" : "none (closed mode: nothing is allowed)"}`);
  if (v.unknown_roles.length) lines.push(`Unknown roles, not held: ${v.unknown_roles.join(", ")}`);
  if (v.broken_roles.length)
    lines.push(`Broken roles that might apply, so this user sees nothing: ${v.broken_roles.join(", ")} (see skipped entries)`);
  if (v.access_file === "invalid") lines.push("access.yaml cannot be applied, so access is closed and nothing is visible (see skipped entries)");
  if (v.undeclared_attributes.length) lines.push(`Attributes not declared in user_attributes: ${v.undeclared_attributes.join(", ")}`);
  if (v.skipped.length) {
    lines.push("Skipped entries:");
    for (const s of v.skipped) lines.push(`  ${s.path}: ${s.message}`);
  }
  if (v.warnings.length) {
    lines.push("Warnings:");
    for (const w of v.warnings) lines.push(`  ${w.path}: ${w.message}`);
  }
  const changed = v.changed_since_approval.filter((r) => r !== "access");
  if (changed.length) {
    lines.push("Approved items that changed since approval:");
    for (const r of changed) lines.push(`  ${r}: ${CHANGED_SINCE_APPROVAL} (${reapproveCommand(r)})`);
  }
  const missing = v.hash_missing.filter((r) => r !== "access");
  if (missing.length) {
    lines.push("Approved items without approved_hash:");
    for (const r of missing) lines.push(`  ${r}: ${HASH_MISSING} (${reapproveCommand(r)})`);
  }
  const n = v.sources.length;
  lines.push(
    `Items visible across ${n} source${n === 1 ? "" : "s"} (row filters limit rows, not these counts): ${allCounts(v.summary)}` +
      (v.summary.hidden_by_protected_tags ? `; ${v.summary.hidden_by_protected_tags} approved item(s) hidden by protected tags` : ""),
  );
  for (const s of v.sources) {
    lines.push(`Source ${s.source}: visible ${allCounts(s.summary)}`);
    const items: string[] = [];
    for (const m of s.models) items.push(...modelLines(m, mode));
    for (const m of s.metrics) {
      if (m.visible && mode !== "hidden") items.push(`    metric ${m.name}`);
      else if (!m.visible && mode !== "visible") items.push(`    metric ${m.name}: hidden (${why(m)})`);
    }
    lines.push(`  ${mode === "all" ? "items" : mode}:`);
    lines.push(...(items.length ? items : ["    none"]));
    const rows = s.models.filter((m) => m.row_filters).flatMap((m) => rowLines(m.ref, m.row_filters!));
    lines.push(...(rows.length ? ["  row filters:", ...rows] : [NO_ROW_FILTERS]));
  }
  if (!v.sources.some((s) => s.models.length || s.metrics.length)) lines.push("No models or metrics.");
  return lines.join("\n");
}

const spec: CommandSpec = {
  summary: "Explain what one user sees: roles held, visible and hidden items with reasons, and row filters.",
  usage: "access [--user <json object of attributes>] [--user-file <path>] [--roles r1,r2] [--show visible|hidden|all]",
  options: {
    user: { type: "string" },
    "user-file": { type: "string" },
    roles: { type: "string", multiple: true },
    show: { type: "string" },
  },
  writes: false,
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const inline = str(values, "user");
    const file = str(values, "user-file");
    if (inline !== undefined && file !== undefined) throw new UserError("Pass --user or --user-file, not both.");
    let attributes: Record<string, unknown> = {};
    if (inline !== undefined) attributes = parseUser(inline, "--user");
    if (file !== undefined) {
      const path = resolve(ctx.cwd, file);
      if (!existsSync(path)) throw new UserError(`--user-file ${file} does not exist.`);
      attributes = parseUser(readFileSync(path, "utf8"), `--user-file ${file}`);
    }
    const showValue = str(values, "show") ?? "hidden";
    if (!["visible", "hidden", "all"].includes(showValue)) throw new UserError(`--show must be visible, hidden or all, not "${showValue}".`);
    const result = evaluateAccess(ctx.root, { attributes, roles: list(values, "roles") });
    ctx.out(ctx.json ? formatJson(result) : render(result, showValue as Show, values.roles !== undefined));
    return 0;
  },
};
export default spec;

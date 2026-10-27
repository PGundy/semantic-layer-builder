import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AccessVisibility,
  type AppliedRowFilter,
  type Counts,
  evaluateAccess,
  type ModelRows,
  type ModelVisibility,
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

function describeFilter(f: AppliedRowFilter): string {
  if (f.kind === "expr") {
    const bound = Object.entries(f.params).map(([k, v]) => `user.${k} = ${show(v)}`);
    const missing = f.missing.map((k) => `user.${k} missing`);
    const extra = [...bound, ...missing];
    return extra.length ? `${f.expr} (${extra.join(", ")})` : f.expr;
  }
  const who = f.missing.length ? `user.${f.user} missing` : `user.${f.user} = ${show(f.user_value)}`;
  const span = `${f.column} ${f.include_self ? "is the user or anyone" : "is anyone"} below them in ${f.via} (${f.manager} -> ${f.member}; ${who})`;
  return span;
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

function modelLines(m: ModelVisibility, mode: Show): string[] {
  const out: string[] = [];
  if (!m.visible) {
    if (mode !== "visible") out.push(`    model ${m.ref}: hidden (${m.reasons.join(", ")})${m.fields.length ? `, with its ${m.fields.length} field(s)` : ""}`);
    return out;
  }
  if (mode !== "hidden") out.push(`    model ${m.ref}`);
  for (const f of m.fields) {
    if (f.visible && mode !== "hidden") out.push(`      ${f.kind} ${f.name}`);
    else if (!f.visible && mode !== "visible") out.push(`    ${f.kind} ${f.ref}: hidden (${f.reasons.join(", ")})`);
  }
  return out;
}

function render(v: AccessVisibility, mode: Show): string {
  const lines: string[] = [];
  const file = v.access_file === "missing" ? "no access.yaml" : `access.yaml ${v.access_file}`;
  lines.push(`Access mode ${v.mode} (${file})`);
  const attrs = Object.entries(v.user.attributes);
  lines.push(
    v.user.default_audience
      ? "User: the default audience (no attributes, no assigned roles)"
      : `User: ${attrs.length ? attrs.map(([k, x]) => `${k}=${show(x)}`).join(", ") : "no attributes"}; assigned roles: ${v.user.roles.length ? v.user.roles.join(", ") : "none"}`,
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
  lines.push(
    `Visible: ${counts(v.summary.models, "models")}, ${counts(v.summary.fields, "fields")}, ${counts(v.summary.metrics, "metrics")}` +
      (v.summary.hidden_by_protected_tags ? `; ${v.summary.hidden_by_protected_tags} approved item(s) hidden by protected tags` : ""),
  );
  for (const s of v.sources) {
    lines.push(`Source ${s.source}:`);
    const items: string[] = [];
    for (const m of s.models) items.push(...modelLines(m, mode));
    for (const m of s.metrics) {
      if (m.visible && mode !== "hidden") items.push(`    metric ${m.name}`);
      else if (!m.visible && mode !== "visible") items.push(`    metric ${m.name}: hidden (${m.reasons.join(", ")})`);
    }
    lines.push(`  ${mode === "all" ? "items" : mode}:`);
    lines.push(...(items.length ? items : ["    none"]));
    const rows = s.models.filter((m) => m.row_filters).flatMap((m) => rowLines(m.ref, m.row_filters!));
    if (rows.length) lines.push("  row filters:", ...rows);
  }
  if (!v.sources.length) lines.push("No models or metrics.");
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
    ctx.out(ctx.json ? formatJson(result) : render(result, showValue as Show));
    return 0;
  },
};
export default spec;

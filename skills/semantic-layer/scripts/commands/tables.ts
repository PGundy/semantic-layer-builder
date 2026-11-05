import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { groupTables, suggestScope, type SuggestedScope, type TableGroup } from "../lib/groups.ts";
import { findTable, qualifiedName } from "../lib/naming.ts";
import { formatJson, formatTable } from "../lib/output.ts";
import { inScope } from "../lib/patterns.ts";
import { listModels, loadProject, loadSource, projectSettings, requireSnapshot } from "../lib/project.ts";
import { rankTables } from "../lib/rank.ts";
import { profileState, type ProfileState } from "../lib/status.ts";
import { NAME_PATTERN, type Project, type SnapshotTable, type Status } from "../lib/types.ts";

export interface TableRow {
  table: string;
  rows: number | null;
  columns: number;
  in_scope: boolean;
  model: string | null;
  model_status: Status | null;
  // True only when the profile is complete (profile_state yes).
  profiled: boolean;
  profile_state: ProfileState;
  score: number;
  reasons: string[];
}

// The --source flag, or the project's default source. The name must be a spec
// name, so it cannot point a source path outside the project.
export function sourceFlag(values: Record<string, unknown>, project: Project): string {
  const s = typeof values.source === "string" ? values.source : project.default_source;
  if (!s) throw new UserError("--source is required.");
  if (!NAME_PATTERN.test(s)) throw new UserError(`--source "${s}" must match ${NAME_PATTERN.source}.`);
  return s;
}

// Whether a table's profile is complete, by the rule sl status applies: profiled_at is set.
export function isProfiled(t: SnapshotTable): boolean {
  return profileState(t) === "yes";
}

// Maps each snapshot table's qualified name to the first model (by file name) built on it.
function modelsByTable(ctx: CommandContext, source: string, tables: SnapshotTable[]): Map<string, { model: string; status: Status }> {
  const out = new Map<string, { model: string; status: Status }>();
  for (const { model } of listModels(ctx.root, source)) {
    if (typeof model?.table !== "string") continue;
    const t = findTable(tables, model.table);
    const key = t ? qualifiedName(t) : model.table;
    if (!out.has(key)) out.set(key, { model: model.model, status: model.status ?? "draft" });
  }
  return out;
}

// Longest pattern shown in the human groups table; --json has the full text.
export const PATTERN_WIDTH = 60;

function shortPattern(pattern: string): string {
  return pattern.length > PATTERN_WIDTH ? `${pattern.slice(0, PATTERN_WIDTH)}…` : pattern;
}

// A group's row total: ? when no table has a row count, "N+" when some lack one.
export function groupRowsText(g: Pick<TableGroup, "total_rows" | "rows_unknown">): string {
  if (g.total_rows === null) return "?";
  const total = g.total_rows.toLocaleString("en-US");
  return g.rows_unknown > 0 ? `${total}+` : total;
}

// Quotes a pattern for a POSIX shell when it holds anything beyond plain name characters.
function shellQuote(s: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function scopeCommand(source: string, scope: SuggestedScope): string {
  return [
    `sl scope --source ${source}`,
    ...scope.include.map((p) => `--include ${shellQuote(p)}`),
    ...scope.exclude.map((p) => `--exclude ${shellQuote(p)}`),
  ].join(" ");
}

function groupRows(groups: TableGroup[]): Record<string, unknown>[] {
  return groups.map((g) => ({
    kind: g.kind,
    pattern: shortPattern(g.pattern),
    tables: g.tables.length,
    rows: groupRowsText(g),
    in_scope: g.in_scope,
    suggest: g.suggestion,
    reason: g.reason,
  }));
}

const spec: CommandSpec = {
  summary: "List a source's tables with size, scope and modeling state; --groups suggests scope patterns.",
  usage: "tables --source <source> [--groups] [--all]",
  options: { source: { type: "string" }, groups: { type: "boolean" }, all: { type: "boolean" } },
  async run({ values }, ctx) {
    const project = loadProject(ctx.root);
    const sourceName = sourceFlag(values, project);
    const source = loadSource(ctx.root, sourceName);
    const snapshot = requireSnapshot(ctx.root, sourceName);
    const { focus_threshold } = projectSettings(project);
    const all = bool(values, "all");
    const models = modelsByTable(ctx, sourceName, snapshot.tables);

    const ranked = rankTables(snapshot.tables);
    const rows: TableRow[] = [];
    let inScopeCount = 0;
    for (const r of ranked) {
      const scoped = inScope(source.scope, r.table);
      if (scoped) inScopeCount++;
      if (!scoped && !all) continue;
      const m = models.get(r.qualified);
      rows.push({
        table: r.qualified,
        rows: r.table.row_count ?? null,
        columns: r.table.columns.length,
        in_scope: scoped,
        model: m?.model ?? null,
        model_status: m?.status ?? null,
        profiled: isProfiled(r.table),
        profile_state: profileState(r.table),
        score: r.score,
        reasons: r.reasons,
      });
    }
    const needsFocus = inScopeCount > focus_threshold;
    const groups = bool(values, "groups") ? groupTables(snapshot.tables, source.scope) : undefined;
    const suggested = groups ? suggestScope(snapshot.tables, groups) : undefined;

    if (ctx.json) {
      ctx.out(
        formatJson({
          source: sourceName,
          total: snapshot.tables.length,
          in_scope: inScopeCount,
          focus_threshold,
          needs_focus: needsFocus,
          tables: rows,
          ...(groups ? { groups, suggested_scope: suggested } : {}),
        }),
      );
      return 0;
    }

    const lines: string[] = [];
    lines.push(
      formatTable(
        rows.map((r) => ({
          table: r.table,
          rows: r.rows === null ? "?" : r.rows.toLocaleString("en-US"),
          columns: r.columns,
          in_scope: r.in_scope ? "yes" : "no",
          model: r.model ? `${r.model} (${r.model_status})` : "",
          profiled: r.profile_state,
        })),
        ["table", "rows", "columns", "in_scope", "model", "profiled"],
      ),
    );
    lines.push("");
    lines.push(`${snapshot.tables.length} tables in ${sourceName}, ${inScopeCount} in scope.${all || inScopeCount === snapshot.tables.length ? "" : " Pass --all to list every table."}`);
    if (needsFocus) {
      lines.push(
        `${inScopeCount} in-scope tables is more than the focus threshold of ${focus_threshold}. ` +
          `Ask the owner which tables to focus on first; run \`sl tables --source ${sourceName} --groups\` to see patterns to choose from, ` +
          `then preview with \`sl scope --source ${sourceName} --include <pattern>\`.`,
      );
    }
    if (groups) {
      lines.push("");
      lines.push("Groups (use a pattern with `sl scope --include` or `--exclude`):");
      lines.push(groups.length ? formatTable(groupRows(groups)) : "(no groups of 2 or more tables)");
      if (groups.some((g) => g.pattern.length > PATTERN_WIDTH)) {
        lines.push(`Patterns longer than ${PATTERN_WIDTH} characters end in …; pass --json for the full text.`);
      }
      if (suggested && (suggested.include.length || suggested.exclude.length)) {
        lines.push("");
        lines.push("Suggested scope (the include-suggested groups, less the noise and staging tables they would select):");
        lines.push(`  ${scopeCommand(sourceName, suggested)}`);
        lines.push("Preview it, agree it with the owner, then add --write to save it.");
      }
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

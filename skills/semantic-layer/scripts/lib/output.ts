import { protectedColumns } from "./profile.ts";
import { listModels, loadSnapshot } from "./project.ts";
import { sensitivityOf } from "./sensitivity.ts";
import type { SourceConfig } from "./types.ts";
import { PROTECTED_TAGS, PUBLIC_TAG } from "./types.ts";

// ANSI escape sequences (CSI, OSC and two-character escapes) and C0/C1 control characters other
// than tab and newline.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

// Text as printed: ANSI escapes and control characters other than tab and newline removed, so a
// value read from a database cannot move the cursor, recolor or rewrite the terminal.
export function plainText(text: string): string {
  return text.replace(ANSI, "").replace(CONTROL, "");
}

// Plain-text tables for terminal output. Cells and headers are plainText with tabs and line
// breaks shown as spaces, so a value cannot break the table's layout.
export function formatTable(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return "(no rows)";
  const cols = columns ?? Object.keys(rows[0]!);
  const clean = (s: string) => plainText(s).replace(/[\t\n]/g, " ");
  const cell = (v: unknown) => clean(v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const heads = cols.map(clean);
  const widths = cols.map((c, i) => Math.max(heads[i]!.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(heads), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join("\n");
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// Protected values ---------------------------------------------------------------

// What a protected value is shown as.
export const PROTECTED_VALUE = "[protected]";

export interface ProtectedNames {
  // Lowercased names whose values are protected.
  names: Set<string>;
  // Lowercased names of fields tagged public, which the name rules do not protect.
  publicNames: Set<string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function hasTag(tags: unknown, wanted: readonly string[]): boolean {
  return strings(tags).some((t) => wanted.includes(t.toLowerCase()));
}

// The names a source's protected values go by: the fields tagged pii or sensitive (all fields of a
// model so tagged), the columns a model lists in ignored_columns, and the columns of its snapshot
// that protectedColumns in lib/profile.ts protects. Model files or a snapshot that cannot be read
// are skipped; the name rules of lib/sensitivity.ts still apply.
export function protectedNames(root: string, source: SourceConfig): ProtectedNames {
  const names = new Set<string>();
  const publicNames = new Set<string>();
  let models: unknown[] = [];
  try {
    models = listModels(root, source.source).map((l) => l.model as unknown);
  } catch {
    models = [];
  }
  for (const m of models) {
    if (!isRecord(m)) continue;
    const modelTagged = hasTag(m.tags, PROTECTED_TAGS);
    for (const c of strings(m.ignored_columns)) names.add(c.toLowerCase());
    for (const list of [m.dimensions, m.measures]) {
      for (const f of Array.isArray(list) ? list.filter(isRecord) : []) {
        if (typeof f.name !== "string") continue;
        if (modelTagged || hasTag(f.tags, PROTECTED_TAGS)) names.add(f.name.toLowerCase());
        else if (hasTag(f.tags, [PUBLIC_TAG])) publicNames.add(f.name.toLowerCase());
      }
    }
  }
  try {
    const snapshot = loadSnapshot(root, source.source);
    if (snapshot && Array.isArray(snapshot.tables)) {
      for (const cols of protectedColumns(snapshot.tables, models, source.dialect).values()) for (const c of cols) names.add(c.toLowerCase());
    }
  } catch {
    // An unreadable snapshot protects nothing beyond the rules above.
  }
  for (const n of names) publicNames.delete(n);
  return { names, publicNames };
}

// The result columns whose values are protected: named like a protected name, or flagged by the
// name rules of sensitivityOf unless a public-tagged field has that name.
export function protectedResultColumns(columns: string[], prot: ProtectedNames): string[] {
  return columns.filter((c) => {
    const k = c.toLowerCase();
    return prot.names.has(k) || (!prot.publicNames.has(k) && sensitivityOf(c) !== null);
  });
}

// Rows with every non-null value of the given columns shown as PROTECTED_VALUE.
export function maskRows(rows: Record<string, unknown>[], columns: string[]): Record<string, unknown>[] {
  if (!columns.length) return rows;
  return rows.map((r) => {
    const out = { ...r };
    for (const c of columns) if (c in out && out[c] !== null && out[c] !== undefined) out[c] = PROTECTED_VALUE;
    return out;
  });
}

// The note printed under a table with protected columns.
export function protectedNote(columns: string[]): string {
  return `Protected column${columns.length === 1 ? "" : "s"} shown as ${PROTECTED_VALUE}: ${columns.map(plainText).join(", ")}.`;
}

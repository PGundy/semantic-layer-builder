// Plain-text tables for terminal output.
export function formatTable(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return "(no rows)";
  const cols = columns ?? Object.keys(rows[0]!);
  const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(cols), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join("\n");
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

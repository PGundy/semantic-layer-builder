import { existsSync } from "node:fs";
import { bool, type CommandSpec } from "../lib/command.ts";
import { issueCodes } from "../lib/issue-codes/index.ts";
import { formatJson } from "../lib/output.ts";
import { noLayer } from "../lib/project.ts";
import { type Issue, trackedEnvFileIssues, validateProject } from "../lib/validate.ts";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function describe(issue: Issue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

// Every registered code, sorted by code, so the codes of one family (the prefix) are together.
function listCodes(json: boolean): string {
  const rows = [...issueCodes()].map(([code, { level, meaning, next }]) => ({ code, level, meaning, ...(next !== undefined ? { next } : {}) })).sort((a, b) => (a.code < b.code ? -1 : 1));
  if (json) return formatJson(rows);
  const lines: string[] = [];
  let family = "";
  for (const r of rows) {
    const f = r.code.slice(0, r.code.indexOf("."));
    if (f !== family) lines.push(...(family ? [""] : []), `${f}.*`);
    family = f;
    lines.push(`  ${r.code}  ${r.level}  ${r.meaning}${r.next ? ` (next: ${r.next})` : ""}`);
  }
  return lines.join("\n");
}

const spec: CommandSpec = {
  summary: "Check every file's structure and cross-references; exit 1 on any error. --codes lists every issue code instead.",
  usage: "validate [--codes]",
  options: { codes: { type: "boolean" } },
  writes: false,
  async run({ values }, ctx) {
    if (bool(values, "codes")) {
      ctx.out(listCodes(ctx.json));
      return 0;
    }
    if (!existsSync(ctx.root)) throw noLayer(ctx.root);
    const issues = [...validateProject(ctx.root), ...trackedEnvFileIssues(ctx.root, ctx.env)];
    const errors = issues.filter((i) => i.level === "error").length;
    const warnings = issues.length - errors;
    if (ctx.json) {
      // Each issue as {level, file, path, message, code, next?}: code is registered in lib/issue-codes/.
      const listed = issues.map(({ level, file, path, message, code, next }) => ({ level, file, path, message, code, ...(next !== undefined ? { next } : {}) }));
      ctx.out(formatJson({ ok: errors === 0, errors, warnings, issues: listed }));
    } else {
      const byFile = new Map<string, Issue[]>();
      for (const i of issues) byFile.set(i.file, [...(byFile.get(i.file) ?? []), i]);
      const lines: string[] = [];
      for (const file of [...byFile.keys()].sort()) {
        lines.push(file);
        const list = byFile.get(file)!;
        for (const i of [...list.filter((x) => x.level === "error"), ...list.filter((x) => x.level === "warning")])
          lines.push(`  ${i.level.padEnd(7)} ${describe(i)}`);
      }
      if (lines.length) lines.push("");
      lines.push(errors === 0 ? `Valid: ${plural(warnings, "warning")}.` : `Invalid: ${plural(errors, "error")}, ${plural(warnings, "warning")}.`);
      ctx.out(lines.join("\n"));
    }
    return errors === 0 ? 0 : 1;
  },
};
export default spec;

import { existsSync } from "node:fs";
import type { CommandSpec } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { type Issue, trackedEnvFileIssues, validateProject } from "../lib/validate.ts";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function describe(issue: Issue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

const spec: CommandSpec = {
  summary: "Check every file's structure and cross-references; exit 1 on any error.",
  usage: "validate",
  options: {},
  async run(_input, ctx) {
    if (!existsSync(ctx.root)) throw new UserError(`No semantic layer at ${ctx.root}. Run \`sl init --name <name>\` first, or pass --root.`);
    const issues = [...validateProject(ctx.root), ...trackedEnvFileIssues(ctx.root, ctx.env)];
    const errors = issues.filter((i) => i.level === "error").length;
    const warnings = issues.length - errors;
    if (ctx.json) {
      ctx.out(formatJson({ ok: errors === 0, errors, warnings, issues }));
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

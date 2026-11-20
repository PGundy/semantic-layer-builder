import { readdirSync } from "node:fs";

// One procedure rule: the document that keeps it ("SKILL.md", a topic reference such as "intake.md",
// or a phase card such as "phases/intake.md"), what the rule is, and the phrase that must stay in it.
export type DocRule = [doc: string, rule: string, phrase: string | RegExp];

export interface RulesFile {
  file: string;
  rules: DocRule[];
}

// Every rules file beside this one, in sorted file order. A file named doc-<document>.ts holds the rules
// of one document; a workstream's own file is named after its topic and may hold rules of several.
export const RULES_FILES: RulesFile[] = readdirSync(import.meta.dir)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts")
  .sort()
  .map((file) => {
    const rules = (require(`./${file}`) as { RULES?: DocRule[] }).RULES;
    if (!Array.isArray(rules)) throw new Error(`tests/docs-rules/${file} exports no RULES array`);
    return { file, rules };
  });

export const DOC_RULES: DocRule[] = RULES_FILES.flatMap((f) => f.rules);

// The document a doc-<document>.ts file holds the rules of: doc-skill.ts is SKILL.md, doc-phases-intake.ts
// is phases/intake.md, doc-interview-guide.ts is interview-guide.md.
export function docOfFile(file: string): string | undefined {
  const m = /^doc-(.+)\.ts$/.exec(file);
  if (!m) return undefined;
  if (m[1] === "skill") return "SKILL.md";
  return `${m[1]!.replace(/^phases-/, "phases/")}.md`;
}

// validate: the final semantic root passes validation, the check semlayer validate runs. The score is 1
// when validateProject finds no error and 0 when it finds one; warnings do not count. The details list
// every error with its file, its issue code (lib/issue-codes/) and its message. Nothing here reads a
// connection or the environment, so the same root always scores the same.
import { existsSync } from "node:fs";
import { validateProject } from "../../skills/semantic-layer/scripts/lib/validate.ts";
import { redactSecrets } from "../runner/redact.ts";
import { maskProtected, protectedValues } from "./secrets.ts";
import type { GraderResult, RunFiles } from "./types.ts";

export async function gradeValidate(run: RunFiles): Promise<GraderResult> {
  if (!existsSync(run.root)) return { grader: "validate", score: 0, passed: false, details: ["semantic/: the run left no semantic root to validate; rerun the scenario with bun evals/runner/run.ts."] };
  const issues = validateProject(run.root);
  const errors = issues.filter((i) => i.level === "error");
  if (!errors.length) {
    const warnings = issues.filter((i) => i.level === "warning").length;
    return { grader: "validate", score: 1, passed: true, details: [`semantic/: validation found no error (${warnings} warning${warnings === 1 ? "" : "s"}).`] };
  }
  const words = (await protectedValues(run.fixtureDir, run.grading.protected_columns).catch(() => undefined))?.words;
  const details = errors.map((i) => maskProtected(redactSecrets(`semantic/${i.file}: ${i.code}${i.path ? ` at ${i.path}` : ""}: ${i.message}`), words));
  return { grader: "validate", score: 0, passed: false, details: [...details, `Fix each error, then run semlayer validate on the root; codes: ${[...new Set(errors.map((i) => i.code))].sort().join(", ")}.`] };
}

// selection: each source's final scope (lib/patterns.ts filterInScope over its snapshot) equals the
// tables the scenario's grading.selection lists for it.
import { qualifiedName } from "../../skills/semantic-layer/scripts/lib/naming.ts";
import { filterInScope } from "../../skills/semantic-layer/scripts/lib/patterns.ts";
import { listSourceNames, loadSnapshot, loadSource } from "../../skills/semantic-layer/scripts/lib/project.ts";
import type { GraderResult, RunFiles } from "./types.ts";

export function gradeSelection(run: RunFiles): GraderResult {
  const intended = run.grading.selection;
  if (!intended || !Object.keys(intended).length) {
    return { grader: "selection", score: null, passed: true, details: ["not graded: the scenario lists no intended tables (grading.selection)"] };
  }
  const present = new Set(listSourceNames(run.root));
  const details: string[] = [];
  let graded = 0;
  let matched = 0;
  for (const source of Object.keys(intended).sort()) {
    const want = intended[source]!;
    const file = `semantic/sources/${source}.yaml`;
    // A listed source the run never set up is graded only when it is the scenario's own intake source.
    if (!present.has(source)) {
      if (source === run.intakeSource) {
        graded++;
        details.push(`${file} is missing: the run lost its source ${source}.`);
      } else details.push(`${source}: not graded, the run has no source ${source}.`);
      continue;
    }
    graded++;
    const snapshot = loadSnapshot(run.root, source);
    if (!snapshot) {
      details.push(`semantic/snapshots/${source}.json is missing, so ${source} has no scope to grade; the skill never ran sl introspect --source ${source}.`);
      continue;
    }
    const scope = filterInScope(loadSource(run.root, source).scope, snapshot.tables);
    const named = (t: { schema?: string | null; name: string }, entry: string) =>
      entry.toLowerCase() === t.name.toLowerCase() || entry.toLowerCase() === qualifiedName(t).toLowerCase();
    const missing = want.filter((w) => !scope.some((t) => named(t, w)));
    const extra = scope.filter((t) => !want.some((w) => named(t, w))).map(qualifiedName);
    if (!missing.length && !extra.length) {
      matched++;
      details.push(`${file}: the scope is the intended ${want.length} table(s): ${want.join(", ")}.`);
      continue;
    }
    if (missing.length) details.push(`${file}: the scope leaves out ${missing.join(", ")}, which the owner's brief puts in scope.`);
    if (extra.length) details.push(`${file}: the scope keeps ${extra.join(", ")}, which the owner's brief leaves out.`);
  }
  if (!graded) return { grader: "selection", score: null, passed: true, details };
  return { grader: "selection", score: matched / graded, passed: matched === graded, details };
}


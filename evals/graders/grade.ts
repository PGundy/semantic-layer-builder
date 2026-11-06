#!/usr/bin/env bun
// bun evals/graders/grade.ts --run <dir> [--scenario <name|file>] [--json]
// Grades a finished run, prints the grades and writes <dir>/grades.json.
// Exit codes: 0 when every grader passed, 1 when one failed or on an error.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadScenario, scenarioPath, stableJson } from "../runner/files.ts";
import { EvalError } from "../runner/types.ts";
import { formatReport, gradeRun, writeGrades } from "./index.ts";

export const USAGE = "Usage: bun evals/graders/grade.ts --run <run directory> [--scenario <name|file>] [--json]";

export async function main(argv: string[], io: { out: (t: string) => void; err: (t: string) => void }): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { run: { type: "string" }, scenario: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      strict: true,
    });
    if (values.help) {
      io.out(USAGE);
      return 0;
    }
    if (!values.run) throw new EvalError(`--run is required: a directory bun evals/runner/run.ts wrote. ${USAGE}`);
    const dir = resolve(values.run);
    const scenarioFile = values.scenario ? scenarioPath(values.scenario) : undefined;
    const report = await gradeRun(dir, scenarioFile ? { scenario: loadScenario(scenarioFile), scenarioFile } : {});
    const file = writeGrades(dir, report);
    if (values.json) io.out(stableJson(report, 2));
    else {
      io.out(formatReport(report));
      io.out("");
      io.out(`Wrote ${file}.`);
      io.out(report.passed ? "Next: compare the scores with an earlier run's grades.json." : `Next: read the failing details above, and ${dir}/transcript.jsonl for the turns they name.`);
    }
    return report.passed ? 0 : 1;
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`grade: ${(e as Error).message}. ${USAGE}`);
      return 1;
    }
    io.err(e instanceof EvalError ? `grade: ${(e as Error).message}` : `grade: unexpected error: ${(e as Error).stack ?? e}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t) }));
}

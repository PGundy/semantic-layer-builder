#!/usr/bin/env bun
// bun evals/runner/run.ts --scenario <name> [--driver scripted|sdk] [--script <file>] [--out <dir>]
//   [--now <iso time>] [--model <id>]
// Exit codes: 0 when the skill agent finished, 2 when a budget stopped the run, 1 on an error.
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { scriptedDriver } from "./drivers/scripted.ts";
import { sdkDriver } from "./drivers/sdk.ts";
import { loadScenario, loadScript, REPO_ROOT, scenarioPath } from "./files.ts";
import { runScenario, steppingClock } from "./runner.ts";
import { EvalError, type Clock, type Driver } from "./types.ts";

export const USAGE =
  "Usage: bun evals/runner/run.ts --scenario <name> [--driver scripted|sdk] [--script <file>] [--out <dir>] [--now <iso time>] [--model <id>]";

export interface MainIO {
  out: (t: string) => void;
  err: (t: string) => void;
  env: Record<string, string | undefined>;
}

export async function main(argv: string[], io: MainIO): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        scenario: { type: "string" },
        driver: { type: "string" },
        script: { type: "string" },
        out: { type: "string" },
        now: { type: "string" },
        model: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    });
    if (values.help) {
      io.out(USAGE);
      return 0;
    }
    if (!values.scenario) throw new EvalError(`--scenario is required. ${USAGE}`);
    const driverName = values.driver ?? "scripted";
    if (driverName !== "scripted" && driverName !== "sdk") throw new EvalError(`--driver is scripted or sdk, not "${driverName}".`);
    if (values.script && driverName !== "scripted") throw new EvalError("--script is for the scripted driver; drop it or pass --driver scripted.");
    const file = scenarioPath(values.scenario);
    const scenario = loadScenario(file);
    // --now fixes the clock (one second per read) so a run is reproducible.
    const clock: Clock = values.now ? steppingClock(values.now) : () => new Date();
    const driver: Driver =
      driverName === "sdk"
        ? await sdkDriver({ model: values.model, env: io.env })
        : scriptedDriver(loadScript(scenario, file, values.script), clock);
    const outDir = resolve(values.out ?? resolve(REPO_ROOT, "evals", "runs"));
    const { runDir, summary, replaced } = await runScenario({ scenario, driver, driverName, clock, outDir });
    const rel = relative(process.cwd(), runDir);
    const shown = rel && !rel.startsWith("..") ? rel : runDir;
    io.out(
      `Run ${summary.run_id}: ${summary.turns} turns (${summary.owner_turns} owner), ${summary.tokens} tokens, stopped: ${summary.stop_reason}.` +
        (replaced ? " It replaced an earlier run with the same id." : ""),
    );
    io.out(`Wrote ${shown}/transcript.jsonl, ${shown}/summary.json and the final semantic root in ${shown}/semantic.`);
    if (summary.stop_reason === "error") {
      io.err(`The run stopped on an error: ${summary.error}`);
      io.err(`Next: fix it and rerun bun evals/runner/run.ts --scenario ${scenario.name}.`);
      return 1;
    }
    if (summary.stop_reason !== "done") {
      io.out(`Next: read ${shown}/transcript.jsonl to see where the budget ran out, or raise budgets in the scenario.`);
      return 2;
    }
    io.out(`Next: read ${shown}/transcript.jsonl.`);
    return 0;
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`eval: ${(e as Error).message}. ${USAGE}`);
      return 1;
    }
    if (e instanceof EvalError) {
      io.err(`eval: ${(e as Error).message}`);
      return 1;
    }
    io.err(`eval: unexpected error: ${(e as Error).stack ?? e}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t), env: process.env }));
}

// Replays canned turns in order, deterministically: the driver tests and CI use. A skill turn may
// write files in the working root by hand (a draft golden), then run sl commands there, with the
// run's clock. With the scenario's fixture, `{fixture}` in an sl argument stands for the fixture
// directory relative to the working root, as in a scenario's views, so a script can give a source
// its connection (the upgrade from an export); the transcript keeps the argument as written.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { estimateTokens, REPO_ROOT, type Script, scriptWritePath } from "../files.ts";
import { slIn } from "../runner.ts";
import type { Clock, CommandRun, Driver } from "../types.ts";
import { EvalError } from "../types.ts";

export function scriptedDriver(script: Script, clock: Clock, fixture?: string): Driver {
  let skillAt = 0;
  let ownerAt = 0;
  return {
    async skillTurn(input) {
      const turn = script.skill[skillAt++];
      if (!turn) throw new EvalError(`The script has ${script.skill.length} skill turn(s) and the run asked for another; add turns or mark the last one "done": true.`);
      for (const [file, text] of Object.entries(turn.write ?? {})) {
        const path = scriptWritePath(input.root, file, text);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
      const commands: CommandRun[] = [];
      const fixtureDir = fixture === undefined ? undefined : relative(input.root, join(REPO_ROOT, "fixtures", fixture)).split(sep).join("/");
      for (const args of turn.sl ?? []) {
        const r = await slIn(input.root, fixtureDir === undefined ? args : args.map((a) => a.replaceAll("{fixture}", fixtureDir)), clock);
        commands.push({ command: ["sl", ...args].join(" "), exit_code: r.code });
      }
      return { text: turn.text, tokens: turn.tokens ?? estimateTokens(turn.text), done: turn.done === true, commands };
    },
    async ownerTurn() {
      const turn = script.owner[ownerAt++];
      if (!turn) throw new EvalError(`The script has ${script.owner.length} owner turn(s) and the run asked for another; add owner turns or end the skill turns with "done": true.`);
      return { text: turn.text, tokens: turn.tokens ?? estimateTokens(turn.text) };
    },
  };
}

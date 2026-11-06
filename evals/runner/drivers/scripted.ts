// Replays canned turns in order, deterministically: the driver tests and CI use. A skill turn may
// run sl commands in the working root first, with the run's clock.
import { estimateTokens, type Script } from "../files.ts";
import { slIn } from "../runner.ts";
import type { Clock, CommandRun, Driver } from "../types.ts";
import { EvalError } from "../types.ts";

export function scriptedDriver(script: Script, clock: Clock): Driver {
  let skillAt = 0;
  let ownerAt = 0;
  return {
    async skillTurn(input) {
      const turn = script.skill[skillAt++];
      if (!turn) throw new EvalError(`The script has ${script.skill.length} skill turn(s) and the run asked for another; add turns or mark the last one "done": true.`);
      const commands: CommandRun[] = [];
      for (const args of turn.sl ?? []) {
        const r = await slIn(input.root, args, clock);
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

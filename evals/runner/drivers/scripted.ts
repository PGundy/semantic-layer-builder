// Replays canned turns in order, deterministically: the driver tests and CI use. A skill turn may
// write files in the working root by hand (a draft golden), then run sl commands there, with the
// run's clock. With the scenario's fixture, `{fixture}` in an sl argument stands for the fixture
// directory relative to the working root, as in a scenario's views, so a script can give a source
// its connection (the upgrade from an export); the transcript keeps the argument as written.
// In a multi-agent script, the turns with "agent" after an interviewer turn are the tasks it
// dispatched: each runs its sl commands through the role guard of lib/roles.ts, which refuses a
// command the role may not run, and comes back to the interviewer as that role's turn. An owner
// turn with "fill" fills in a review form the skill wrote and hands it back under shared/.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { parseReviewJson, parseReviewMarkdown, renderReviewJson, renderReviewMarkdown } from "../../../skills/semantic-layer/scripts/lib/review.ts";
import { type Role, ROLES, slRefusal } from "../../../skills/semantic-layer/scripts/lib/roles.ts";
import { estimateTokens, type FormFill, REPO_ROOT, type Script, type ScriptTurn, scriptWritePath } from "../files.ts";
import { slIn } from "../runner.ts";
import type { Clock, CommandRun, Driver, RoleTurn } from "../types.ts";
import { EvalError } from "../types.ts";

// The owner's copy of a review form the skill wrote, with the owner's verdicts and words written in
// as a person fills in the form: only the items' verdicts and answers and the questions' answers change.
export function fillForm(fill: FormFill, forms: Record<string, string>, turn: number): string {
  const text = forms[fill.form];
  if (text === undefined) throw new EvalError(`Owner turn ${turn} fills ${fill.form}, which the skill has not written; export it first with sl review export --readback <id> --format ${extname(fill.form).slice(1)}.`);
  const form = extname(fill.form) === ".json" ? parseReviewJson(text, fill.form) : parseReviewMarkdown(text, fill.form);
  for (const [target, answer] of Object.entries(fill.items ?? {})) {
    const item = form.items.find((i) => i.target === target);
    if (!item) throw new EvalError(`Owner turn ${turn} answers ${target}, which is not an item of ${fill.form} (${form.items.map((i) => i.target).join(", ")}); fix the script.`);
    item.verdict = answer.verdict ?? null;
    item.answer = answer.answer ?? "";
  }
  for (const [match, answer] of Object.entries(fill.questions ?? {})) {
    const question = form.questions.find((q) => q.question.includes(match));
    if (!question) throw new EvalError(`Owner turn ${turn} answers a question holding "${match}", which ${fill.form} does not ask; fix the script.`);
    question.answer = answer;
  }
  return extname(fill.form) === ".json" ? renderReviewJson(form) : renderReviewMarkdown(form);
}

export function scriptedDriver(script: Script, clock: Clock, fixture?: string): Driver {
  let skillAt = 0;
  let ownerAt = 0;
  // Runs a turn's sl commands as `role`; a command the role may not run is refused and not run.
  const runAs = async (role: Role, turn: ScriptTurn, root: string): Promise<CommandRun[]> => {
    const commands: CommandRun[] = [];
    const fixtureDir = fixture === undefined ? undefined : relative(root, join(REPO_ROOT, "fixtures", fixture)).split(sep).join("/");
    for (const args of turn.sl ?? []) {
      const command = ["sl", ...args].join(" ");
      const refused = slRefusal(role, args);
      if (refused) {
        commands.push({ command, exit_code: 1, refused });
        continue;
      }
      const r = await slIn(root, fixtureDir === undefined ? args : args.map((a) => a.replaceAll("{fixture}", fixtureDir)), clock);
      commands.push({ command, exit_code: r.code });
    }
    return commands;
  };
  return {
    async skillTurn(input) {
      const turn = script.skill[skillAt++];
      if (!turn) throw new EvalError(`The script has ${script.skill.length} skill turn(s) and the run asked for another; add turns or mark the last one "done": true.`);
      if (turn.agent) throw new EvalError(`Skill turn ${skillAt} is a ${turn.agent} task where an interviewer turn was due; put an interviewer turn before it.`);
      for (const [file, text] of Object.entries(turn.write ?? {})) {
        const path = scriptWritePath(input.root, file, text);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
      const commands = await runAs(ROLES.interviewer, turn, input.root);
      const dispatches: RoleTurn[] = [];
      while (script.skill[skillAt]?.agent) {
        const task = script.skill[skillAt++]!;
        const done = await runAs(ROLES[task.agent!], task, input.root);
        dispatches.push({ agent: task.agent!, text: task.text, tokens: task.tokens ?? estimateTokens(task.text), ...(done.length ? { commands: done } : {}) });
      }
      return {
        text: turn.text,
        tokens: turn.tokens ?? estimateTokens(turn.text),
        done: turn.done === true,
        commands,
        ...(dispatches.length ? { dispatches } : {}),
      };
    },
    async ownerTurn(input) {
      const turn = script.owner[ownerAt++];
      if (!turn) throw new EvalError(`The script has ${script.owner.length} owner turn(s) and the run asked for another; add owner turns or end the skill turns with "done": true.`);
      const files = Object.fromEntries((turn.fill ?? []).map((f) => [f.as, fillForm(f, input.forms ?? {}, ownerAt)]));
      return { text: turn.text, tokens: turn.tokens ?? estimateTokens(turn.text), ...(turn.fill?.length ? { files } : {}) };
    },
  };
}

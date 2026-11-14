import type { CommandSpec } from "../lib/command.ts";
import { type NextAction, nextAction } from "../lib/next.ts";
import { formatJson } from "../lib/output.ts";
import { actionText, type StepAction } from "../lib/status.ts";

// The action in one or two plain lines, the second naming the command, printed from its action.
function render(a: NextAction): string {
  const head = `Next (${a.phase}): ${a.why}`;
  const command = actionText(a.action as StepAction);
  switch (a.kind) {
    case "run":
      return `${head}\n  ${a.blocked_on ? "Meanwhile: " : ""}${command}`;
    case "ask_owner":
      return a.ask_owner?.readback_id
        ? `${head}\n  Read the items to the owner from sl next --json (ask_owner.text) or sl review export --readback ${a.ask_owner.readback_id} --format md.`
        : `${head}\n  Ask the owner, then: ${command}`;
    case "dispatch": {
      const t = a.dispatch!.task;
      return `${head}\n  Dispatch to a connector runner: plan ${t.plan_id}, queries ${t.queries.map((q) => q.id).join(", ")}; ${t.store}`;
    }
    default:
      return `Done: ${a.why}`;
  }
}

const spec: CommandSpec = {
  summary: "Print the one next action: a command to run, a question or readback to put to the owner, a plan to dispatch, or done.",
  usage:
    "next\n\n" +
    "Reads sl status, the answer ledger, .sl/pending/, .sl/plans/ and where each connection variable is set (never its\n" +
    "value), and writes nothing. --json prints { kind, phase, why, action, run?, ask_owner?, dispatch?, blocked_on,\n" +
    "connection? } with kind run, ask_owner, dispatch or done; action is { command, args, kind }, the command printed.",
  options: {},
  writes: false,
  async run(_input, ctx) {
    const action = nextAction(ctx.root, ctx.env);
    ctx.out(ctx.json ? formatJson(action) : render(action));
    return 0;
  },
};
export default spec;

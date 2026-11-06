import type { CommandSpec } from "../lib/command.ts";
import { type NextAction, nextAction } from "../lib/next.ts";
import { formatJson } from "../lib/output.ts";

// The action in one or two plain lines, the second naming the command.
function render(a: NextAction): string {
  const head = `Next (${a.phase}): ${a.why}`;
  switch (a.kind) {
    case "run":
      return `${head}\n  ${a.blocked_on ? "Meanwhile: " : ""}${a.run!.command}`;
    case "ask_owner":
      return `${head}\n  Read the items to the owner from sl next --json (ask_owner.text) or sl review export --readback ${a.ask_owner!.readback_id} --format md.`;
    case "dispatch": {
      const t = a.dispatch!.task;
      return `${head}\n  Dispatch to a connector runner: plan ${t.plan_id}, queries ${t.queries.map((q) => q.id).join(", ")}; ${t.store}`;
    }
    default:
      return `Done: ${a.why}`;
  }
}

const spec: CommandSpec = {
  summary: "Print the one next action: a command to run, a readback to put to the owner, a plan to dispatch, or done.",
  usage:
    "next\n\n" +
    "Reads sl status, the answer ledger, .sl/pending/ and .sl/plans/, and writes nothing. --json prints\n" +
    "{ kind, phase, why, run?, ask_owner?, dispatch?, blocked_on } with kind run, ask_owner, dispatch or done.",
  options: {},
  async run(_input, ctx) {
    const action = nextAction(ctx.root);
    ctx.out(ctx.json ? formatJson(action) : render(action));
    return 0;
  },
};
export default spec;

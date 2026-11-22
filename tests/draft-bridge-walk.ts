// Follows semlayer next the way an agent does, for the tests of a drafted bridge join: a run it names is
// run, a readback it names is answered yes, an edit it asks for gets a placeholder answer, until the
// question about how the bridge join shares a figure is the next thing to ask. Returns that question.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { semlayer } from "./helpers.ts";

interface Step {
  kind: string;
  why: string;
  ask_owner?: { text: string };
  action: { command: string; args: string[]; stdin?: string };
}

// `keys` gives the primary_key an edit asks for, by model name, where the draft could not infer one.
export async function walkToDedupeQuestion(root: string, env: Record<string, string | undefined> = {}, keys: Record<string, string> = {}): Promise<string> {
  const seen: string[] = [];
  for (let i = 0; i < 60; i++) {
    const n = await semlayer(root, ["next", "--json"], env);
    if (n.code !== 0) throw new Error(`semlayer next: ${n.err}`);
    const a = n.json<Step>();
    seen.push(`${a.kind}:${a.action.command}`);
    if (a.ask_owner?.text.includes("how is its figure shared")) return a.ask_owner.text;
    const run = async (args: string[]) => {
      const r = await semlayer(root, args, env);
      if (r.code !== 0) throw new Error(`semlayer ${args.join(" ")}: ${r.err}`);
    };
    const scratch = join(root, "..", "walk.json");
    if (a.kind === "run") await run([a.action.command, ...a.action.args]);
    else if (a.action.command === "reply") {
      const body = JSON.parse(a.action.stdin!) as { answers: { item: number }[] };
      writeFileSync(scratch, JSON.stringify({ by: "Dana", answers: body.answers.map((x) => ({ item: x.item, verdict: "yes", text: "Yes, that is right." })) }));
      await run(["reply", ...a.action.args.map((x) => (x === "-" ? scratch : x))]);
    } else if (a.action.stdin) {
      const edits = (JSON.parse(a.action.stdin) as { edits: string[][] }).edits.map((e) => e[2] === "primary_key" ? [...e.slice(0, 3), keys[e[1]!.split(".")[1]!] ?? e[3]!] : e.map((word) => (word.startsWith("<") ? "One row as the shop records it." : word)));
      writeFileSync(scratch, JSON.stringify({ edits }));
      await run(["apply", "--file", scratch]);
    } else break;
  }
  throw new Error(`semlayer next never asked the dedupe question: ${seen.join(" ")}`);
}

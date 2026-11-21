// A draft golden whose request the compiler refuses for its own shape (spec: goldens, Writing and confirming):
// approving an item does not make it compile, so it is removed and written again. A refusal that waits on a
// draft or not-yet-approved item, or a field not yet in the layer, is left to the other golden checks, and so
// is a request they already report an error on.
import { compileGolden } from "../goldens.ts";
import type { RuleContext } from "./index.ts";

export default function goldenRequest(ctx: RuleContext): void {
  for (const l of ctx.goldens) {
    const g = l.data;
    if (!l.valid || g.status === "approved" || !ctx.sources.has(g.request.source)) continue;
    if (ctx.issues.some((i) => i.level === "error" && i.file === l.file && i.path.startsWith("request"))) continue;
    let reasons: string[];
    try {
      const compiled = compileGolden(ctx.root, g);
      reasons = compiled.ok ? [] : compiled.refusals.filter((r) => r.code === "invalid_request").map((r) => r.message);
    } catch {
      continue;
    }
    if (!reasons.length) continue;
    ctx.warn(
      l.file,
      "request",
      `does not compile: ${reasons.join("; ")}. A golden's request is not edited: remove the draft with semlayer goldens remove --name ${g.name} and write it again with semlayer goldens new`,
      "golden.draft_request_invalid",
    );
  }
}

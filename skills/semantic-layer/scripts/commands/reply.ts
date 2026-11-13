import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { oneLine } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { LEDGER_FILE, openLedger, ownerText, readPending, shellQuote } from "../lib/ledger.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { currentHash } from "../lib/readback.ts";
import { goldenExportSource, goldenUpgradeNext } from "../lib/export-goldens.ts";
import type { LedgerReply, ReplyVerdict } from "../lib/types.ts";

const VERDICTS: readonly ReplyVerdict[] = ["yes", "no", "change"];
const USAGE = 'sl reply --readback <readback_id> --item <n> --text "<owner\'s words>" [--verdict yes|no|change] --by "<owner>"';

const spec: CommandSpec = {
  summary: "Record the owner's answer to one item of a readback in the answer ledger, .sl/ledger.jsonl.",
  usage:
    'reply --readback <readback_id> --item <n> --text "<owner\'s words>" [--verdict yes|no|change] --by "<owner>"\n\n' +
    "Appends one line to .sl/ledger.jsonl with the item's target and the content hash it had when it was read\n" +
    "back, the owner's words (credentials redacted), the verdict and the time. Never rewrites earlier lines.",
  options: {
    readback: { type: "string" },
    item: { type: "string" },
    text: { type: "string" },
    verdict: { type: "string" },
    by: { type: "string" },
  },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const [rb, itemRaw, raw, byRaw] = [str(values, "readback"), str(values, "item"), str(values, "text"), str(values, "by")];
    if (rb === undefined || itemRaw === undefined || raw === undefined || byRaw === undefined) throw new UserError(`Usage: ${USAGE}.`);
    const verdictRaw = str(values, "verdict");
    const verdict = verdictRaw === undefined ? null : (verdictRaw.trim().toLowerCase() as ReplyVerdict);
    if (verdict !== null && !VERDICTS.includes(verdict)) throw new UserError(`--verdict is yes, no or change, not ${JSON.stringify(verdictRaw)}. Usage: ${USAGE}.`);
    const by = ownerText(oneLine(byRaw)).text;
    if (!by) throw new UserError('--by is empty; give the name of the owner who answered (--by "<owner>").');
    const { text, redacted } = ownerText(raw);
    if (!text) throw new UserError("--text is empty; record the owner's words as they said them.");
    const pending = readPending(ctx.root, rb.trim());
    const n = /^\d+$/.test(itemRaw.trim()) ? Number(itemRaw.trim()) : NaN;
    const item = pending.items.find((i) => i.n === n);
    if (!item) {
      const items = pending.items.map((i) => `${i.n} (${i.target})`).join(", ");
      throw new UserError(`Readback ${pending.readback_id} has no item ${JSON.stringify(itemRaw)}; its items are ${items}. To ask about something else, read it back first with sl readback --targets <ref>.`);
    }
    const ledger = openLedger(ctx.root);
    const now = currentHash(ctx.root, item.target, item.content_hash);
    const changed = now !== item.content_hash;
    const entry = ledger.append({
      kind: "reply",
      readback_id: pending.readback_id,
      item: item.n,
      target: item.target,
      content_hash: item.content_hash,
      text,
      verdict,
      by,
      at: ctx.now().toISOString(),
    } satisfies Omit<LedgerReply, "id">);
    const t = item.target;
    const again = `sl readback --targets ${t}`;
    const warnings: string[] = [];
    if (redacted) warnings.push("The owner's words held what looks like a credential; it was stored as [redacted]. Ask the owner to change that credential, since it was shared in the conversation.");
    if (now === null) warnings.push(`${t} no longer exists in the YAML, so this reply cannot approve anything; run sl status to see the current targets.`);
    else if (changed) warnings.push(`${t} changed since it was read back; read it back again with ${again}, and record the owner's answer to the new readback.`);
    let next: string;
    let advice: string;
    if (verdict === null) {
      next = `sl reply --readback ${pending.readback_id} --item ${item.n} --text "<owner's words>" --verdict yes|no|change --by ${shellQuote(by)}`;
      advice = `The reply has no verdict, so no approval can use it. Ask the owner whether that is a yes, a no or a change, then record it: ${next}.`;
    } else if (changed) {
      next = now === null ? "sl status" : again;
      advice = `Next: ${next}.`;
    } else if (verdict === "yes") {
      // Decision D2: an export source's golden is confirmed only once its source has a connection.
      const waits = t.startsWith("golden:") ? goldenExportSource(ctx.root, t.slice(7)) : undefined;
      if (waits) next = goldenUpgradeNext(waits.source, waits.dialect, [t.slice(7)]);
      else next = t.startsWith("golden:") ? `sl goldens confirm --name ${t.slice(7)}` : `sl approve --target ${t} --by ${shellQuote(by)}`;
      advice = waits
        ? `The owner said yes to the item as read back, and the yes stays recorded, but ${t} cannot be confirmed until source ${waits.source} has a connection. Next: ${next}.`
        : `The owner said yes to the item as read back. Next: ${next}.`;
    } else {
      next = again;
      advice = `Make the ${verdict === "no" ? "correction" : "change"} the owner asked for with a typed edit (sl set, sl tag, sl ignore-column or sl question add), then read it back again: ${next}.`;
    }
    if (ctx.json) {
      ctx.out(formatJson({ id: entry.id, path: LEDGER_FILE, entry, current_hash: now, hash_changed: changed, redacted, warnings, next }));
      return 0;
    }
    const head = `Recorded ${entry.id} in ${LEDGER_FILE}: ${by}'s reply to item ${item.n} of ${pending.readback_id} (${t}), ${verdict === null ? "no verdict yet" : `verdict ${verdict}`}.`;
    ctx.out([head, ...warnings.map((w) => `Warning: ${w}`), advice].join("\n"));
    return 0;
  },
};
export default spec;

// MCP elicitation (protocol 2025-06-18) for the calls that rest on the owner's yes: sl_approve,
// sl_goldens confirm and sl_reply with verdict yes. When the client declares the elicitation
// capability, the server shows the owner the readback in the client (elicitation/create), records
// their answer with sl reply, and only on their yes runs the approval. No yes is ever read from the
// agent's tool arguments.
import { LEDGER_FILE, readPending } from "../lib/ledger.ts";
import { oneLine } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { paths } from "../lib/project.ts";
import { parseTarget } from "../lib/refs.ts";
import type { Model, PendingReadback } from "../lib/types.ts";
import { readYamlIfExists } from "../lib/yaml.ts";

type Msg = Record<string, unknown>;
const isObj = (v: unknown): v is Msg => typeof v === "object" && v !== null && !Array.isArray(v);

// How long the server waits for the owner's answer before it gives up, recording nothing.
export const ELICIT_TIMEOUT_MS = 600_000;
export const ELICIT_METHOD = "elicitation/create";
export const VERDICTS = ["yes", "no", "change"] as const;
type Verdict = (typeof VERDICTS)[number];

// The form the client shows the owner under the readback.
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      title: "Approve?",
      description: "yes approves it exactly as read back above; no or change records your answer and approves nothing.",
      enum: [...VERDICTS],
      enumNames: ["Yes, approve it as read back", "No, it is wrong", "Change something first"],
    },
    by: { type: "string", title: "Your name", description: "The owner answering, as the answer ledger records it.", minLength: 1 },
    comment: { type: "string", title: "Comment", description: "Your words, recorded with the answer (optional)." },
  },
  required: ["verdict", "by"],
};

// What came back for one elicitation/create request.
export type Asked =
  | { kind: "answer"; action: string; content: unknown }
  | { kind: "error"; message: string }
  | { kind: "timeout" }
  | { kind: "closed" };

// Sends elicitation/create requests to the client and matches each response to its request by id.
export class Elicitor {
  private next = 1;
  private waiting = new Map<string, (a: Asked) => void>();

  constructor(
    private readonly send: (msg: Msg) => void,
    readonly timeoutMs: number = ELICIT_TIMEOUT_MS,
  ) {}

  ask(message: string): Promise<Asked> {
    // Ids the server sends are strings of its own, so they never stand for a request of the client's.
    const id = `sl-elicit-${this.next++}`;
    return new Promise<Asked>((done) => {
      const timer = setTimeout(() => {
        if (!this.waiting.delete(id)) return;
        this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "The owner's answer did not arrive in time." } });
        done({ kind: "timeout" });
      }, this.timeoutMs);
      this.waiting.set(id, (a) => {
        clearTimeout(timer);
        done(a);
      });
      this.send({ jsonrpc: "2.0", id, method: ELICIT_METHOD, params: { message, requestedSchema: ANSWER_SCHEMA } });
    });
  }

  // A response from the client. One that answers no request still waiting (late, or never sent) is dropped.
  receive(m: Msg): void {
    const id = typeof m.id === "string" ? m.id : undefined;
    const done = id === undefined ? undefined : this.waiting.get(id);
    if (!done) return;
    this.waiting.delete(id!);
    if ("error" in m) {
      const e = m.error;
      done({ kind: "error", message: isObj(e) && typeof e.message === "string" ? e.message : "the client answered with an error" });
    } else if (isObj(m.result)) done({ kind: "answer", action: String(m.result.action), content: m.result.content });
    else done({ kind: "error", message: "the client's response has no result object" });
  }

  // The client went away: every request still waiting ends with nothing recorded.
  close(): void {
    for (const done of this.waiting.values()) done({ kind: "closed" });
    this.waiting.clear();
  }
}

// A command's run, as the server makes it.
export interface Run {
  code: number;
  out: string;
  err: string;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

export function toolResult(command: string, r: Run): ToolResult {
  const content = [r.out, r.err].filter((t) => t !== "").map((text) => ({ type: "text" as const, text }));
  if (!content.length) content.push({ type: "text", text: r.code === 0 ? "{}" : `sl ${command} exited with code ${r.code}.` });
  return r.code === 0 ? { content } : { content, isError: true };
}

export interface GateDeps {
  root: string;
  // The call as the command would run without elicitation.
  argv: string[];
  run(argv: string[]): Promise<Run>;
  ask(message: string): Promise<Asked>;
  timeoutMs: number;
}

// The tool description's note on how the owner's yes arrives, by whether the client declared elicitation.
export function elicitationNote(command: string, elicits: boolean): string {
  if (command === "reply") {
    return elicits
      ? "\n\nThis client declared MCP elicitation: a call with verdict yes records no yes from its arguments. The server shows the owner the item as read back in the client and records the owner's own answer."
      : "\n\nA client that declares MCP elicitation lets the owner give this answer in the client directly, instead of the agent recording it.";
  }
  if (command !== "approve" && command !== "goldens") return "";
  const what = command === "approve" ? "approves" : "confirms (goldens confirm)";
  return elicits
    ? `\n\nThis client declared MCP elicitation: before it ${what} anything, the server reads the target back to the owner in the client and records their answer in ${LEDGER_FILE} as sl reply does. No yes is taken from the arguments.`
    : `\n\nThis client did not declare MCP elicitation, so the owner's yes must already be in ${LEDGER_FILE}: sl_readback, ask the owner in the chat, then sl_reply. A client that declares elicitation gives the owner's answer directly.`;
}

// The targets a call approves and the readback flags that go with them, or undefined when the call
// approves nothing or fails before reading the ledger, so it runs as on the CLI.
function approvalTargets(root: string, command: string, a: Msg): { tool: string; refs: string[]; flags: string[] } | undefined {
  if (command === "approve") {
    const target = typeof a.target === "string" ? a.target.trim() : "";
    if (!target || target.startsWith("golden:") || a.revoke === true || a["stamp-hashes"] === true || a["confirm-unchanged"] === true || a.date !== undefined) return undefined;
    if (a.recursive !== true) return { tool: "sl_approve", refs: [target], flags: [] };
    let t;
    try {
      t = parseTarget(target);
    } catch (e) {
      if (e instanceof UserError) return undefined;
      throw e;
    }
    if (t.kind !== "model") return undefined;
    let model: Model | null = null;
    try {
      model = readYamlIfExists<Model>(paths(root).model(t.source, t.model));
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
    }
    // A model and every field of it, as sl approve --recursive approves them.
    const fields = isObj(model) ? (["dimensions", "measures", "joins"] as const).flatMap((k) => (Array.isArray(model![k]) ? model![k]! : []).map((f) => `${target}.${f.name}`)) : [];
    return { tool: "sl_approve", refs: [target, ...fields], flags: [] };
  }
  if (command === "goldens") {
    const pos = Array.isArray(a.positionals) ? a.positionals : [];
    if (pos.length !== 1 || pos[0] !== "confirm" || typeof a.name !== "string" || a["emit-sql"] === true) return undefined;
    const flags = (["tolerance", "results", "plan"] as const).flatMap((f) => (typeof a[f] === "string" ? [`--${f}=${a[f]}`] : []));
    return { tool: "sl_goldens confirm", refs: [`golden:${a.name.trim()}`], flags };
  }
  return undefined;
}

// The readback items as one message, as sl readback prints them: one item as it is, several numbered.
export function readbackMessage(items: PendingReadback["items"]): string {
  if (items.length === 1) return items[0]!.text;
  return items
    .map((i) => {
      const [head, ...rest] = i.text.split("\n");
      return [`${i.n}. ${head}`, ...rest.map((l) => `   ${l}`)].join("\n");
    })
    .join("\n\n");
}

interface Answer {
  verdict: Verdict;
  by: string;
  text: string;
}

// The owner's accepted form, or why it cannot be recorded.
function readAnswer(content: unknown): Answer | string {
  if (!isObj(content)) return "the answer has no content";
  const verdict = typeof content.verdict === "string" ? content.verdict.trim().toLowerCase() : "";
  if (!(VERDICTS as readonly string[]).includes(verdict)) return `its verdict is ${JSON.stringify(content.verdict ?? null)}, not yes, no or change`;
  const by = typeof content.by === "string" ? oneLine(content.by) : "";
  if (!by) return "it does not name the owner who answered (by)";
  if (content.comment !== undefined && typeof content.comment !== "string") return "its comment is not text";
  const comment = typeof content.comment === "string" ? content.comment.trim() : "";
  return { verdict: verdict as Verdict, by, text: comment || verdict };
}

function summary(owner: Msg, message: string, isError = false): ToolResult {
  const r: ToolResult = { content: [{ type: "text", text: JSON.stringify({ owner_answer: owner, message }, null, 2) }] };
  if (isError) r.isError = true;
  return r;
}

// Asks the owner and records their answer to each item of a stored readback. Returns the answer and
// the ledger ids, or the result to return when nothing (more) should run.
async function askAndRecord(
  deps: GateDeps,
  tool: string,
  readbackId: string,
  items: PendingReadback["items"],
  nothing: string,
): Promise<{ answer: Answer; owner: Msg; ran: Run[] } | ToolResult> {
  const asked = await deps.ask(readbackMessage(items));
  const again = `Next: call ${tool} again when the owner is ready to answer in the client.`;
  if (asked.kind === "timeout")
    return summary({ asked: "elicitation", outcome: "timeout", readback_id: readbackId, recorded: [] }, `The owner's answer did not arrive within ${deps.timeoutMs / 1000} seconds; nothing was recorded and ${nothing}. ${again}`, true);
  if (asked.kind === "closed") return summary({ asked: "elicitation", outcome: "closed", readback_id: readbackId, recorded: [] }, `The client closed before the owner answered; nothing was recorded and ${nothing}. Next: reconnect the client, then call ${tool} again.`, true);
  if (asked.kind === "error")
    return summary({ asked: "elicitation", outcome: "error", readback_id: readbackId, recorded: [] }, `The client could not ask the owner (${asked.message}); nothing was recorded and ${nothing}. ${again}`, true);
  if (asked.action !== "accept") {
    const how = asked.action === "decline" ? "declined to answer" : "cancelled without answering";
    return summary({ asked: "elicitation", action: asked.action, readback_id: readbackId, recorded: [] }, `The owner ${how}; nothing was recorded and ${nothing}. ${again}`);
  }
  const answer = readAnswer(asked.content);
  if (typeof answer === "string")
    return summary({ asked: "elicitation", action: "accept", readback_id: readbackId, recorded: [] }, `The owner's answer cannot be recorded: ${answer}; nothing was recorded and ${nothing}. ${again}`, true);
  // Each item's answer is recorded by sl reply itself, with the owner's name and words.
  const ran: Run[] = [];
  const recorded: string[] = [];
  for (const item of items) {
    const r = await deps.run(["reply", `--readback=${readbackId}`, `--item=${item.n}`, `--text=${answer.text}`, `--verdict=${answer.verdict}`, `--by=${answer.by}`, "--json", `--root=${deps.root}`]);
    ran.push(r);
    if (r.code !== 0) {
      const owner = { asked: "elicitation", action: "accept", verdict: answer.verdict, by: answer.by, readback_id: readbackId, recorded };
      return { content: [...toolResult("reply", r).content, ...summary(owner, `Recording the owner's answer to item ${item.n} failed (above), so ${nothing}. Next: fix what that output names, then call ${tool} again.`).content], isError: true };
    }
    recorded.push(String((JSON.parse(r.out) as { id: unknown }).id));
  }
  return { answer, owner: { asked: "elicitation", action: "accept", verdict: answer.verdict, by: answer.by, readback_id: readbackId, recorded }, ran };
}

// The result of a call that needs the owner's answer, asked in the client, or undefined when the call
// runs as on the CLI.
export async function ownerGate(command: string, a: Msg, deps: GateDeps): Promise<ToolResult | undefined> {
  if (command === "reply") return replyGate(a, deps);
  const target = approvalTargets(deps.root, command, a);
  if (!target) return undefined;
  const nothing = command === "approve" ? "nothing was approved" : "nothing was confirmed";
  // The readback the owner answers is stored exactly as sl readback stores it.
  const rb = await deps.run(["readback", ...target.refs.map((r) => `--targets=${r}`), ...target.flags, "--json", `--root=${deps.root}`]);
  if (rb.code !== 0) return { content: [...toolResult("readback", rb).content, { type: "text", text: `The target could not be read back to the owner, so ${nothing}.` }], isError: true };
  const pending = JSON.parse(rb.out) as PendingReadback;
  const got = await askAndRecord(deps, target.tool, pending.readback_id, pending.items, nothing);
  if (!("answer" in got)) return got;
  const recorded = `recorded ${(got.owner.recorded as string[]).join(", ")} in ${LEDGER_FILE}`;
  if (got.answer.verdict !== "yes") {
    return summary(
      got.owner,
      `The owner (${got.answer.by}) answered ${got.answer.verdict}; ${recorded} and ${nothing}. Next: make the ${got.answer.verdict === "no" ? "correction" : "change"} the owner asked for with a typed edit (sl set, sl tag, sl ignore-column or sl question add), then call ${target.tool} again.`,
    );
  }
  const r = await deps.run(deps.argv);
  const verb = command === "approve" ? "sl approve" : "sl goldens confirm";
  const done =
    r.code === 0
      ? summary(got.owner, `The owner (${got.answer.by}) answered yes in the client; ${recorded}, then ran ${verb} (its output is above).`)
      : summary(
          got.owner,
          `The owner (${got.answer.by}) answered yes in the client and ${recorded}, but ${verb} refused (its output is above), so ${nothing}. ` +
            `Next: fix what that output names (when it is a by that does not name the owner, leave by out), then call ${target.tool} again.`,
          true,
        );
  const out = toolResult(command, r);
  return { ...out, content: [...out.content, ...done.content] };
}

// sl_reply with verdict yes: the owner answers the stored item in the client; the agent's words, name
// and yes are not recorded.
async function replyGate(a: Msg, deps: GateDeps): Promise<ToolResult | undefined> {
  if (typeof a.verdict !== "string" || a.verdict.trim().toLowerCase() !== "yes") return undefined;
  const fail = (text: string): ToolResult => ({ content: [{ type: "text", text: `sl reply: ${text}` }], isError: true });
  const id = typeof a.readback === "string" ? a.readback.trim() : "";
  let pending: PendingReadback;
  try {
    pending = readPending(deps.root, id);
  } catch (e) {
    if (e instanceof UserError) return fail(e.message);
    throw e;
  }
  const raw = typeof a.item === "string" ? a.item.trim() : "";
  const item = pending.items.find((i) => /^\d+$/.test(raw) && i.n === Number(raw));
  if (!item) {
    const list = pending.items.map((i) => `${i.n} (${i.target})`).join(", ");
    return fail(`Readback ${pending.readback_id} has no item ${JSON.stringify(a.item ?? null)}; its items are ${list}. Nothing was recorded.`);
  }
  const got = await askAndRecord(deps, "sl_reply", pending.readback_id, [item], "no yes was recorded");
  if (!("answer" in got)) return got;
  const ran = got.ran[0]!;
  const next = (JSON.parse(ran.out) as { next?: unknown }).next;
  const after = typeof next === "string" ? ` Next: ${next}.` : "";
  const again = got.answer.verdict === "yes" ? " Under elicitation that call reads the target back to the owner again before it approves." : "";
  const done = summary(got.owner, `The owner (${got.answer.by}) answered ${got.answer.verdict} in the client; that answer, not the call's arguments, was recorded.${after}${again}`);
  const out = toolResult("reply", ran);
  return { ...out, content: [...out.content, ...done.content] };
}

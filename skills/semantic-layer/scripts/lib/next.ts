// The one next action of the skill (semlayer next): semlayer status's next step, read together with the answer
// ledger, the pending readbacks and the stored query plans. It reads files only and writes nothing.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { approvalLacks, type Lack, lacksFile, lacksNote } from "./approve-checks.ts";
import { loadChange, releaseLead } from "./change-record.ts";
import { inTurnApply } from "./edit.ts";
import { type Env, resolveConnection } from "./env-file.ts";
import { intakeMode } from "./intake.ts";
import { currentYes, latestReply, openAccessChanges, readApprovalLedger } from "./ledger.ts";
import { changeSince, deferredAtStart } from "./changeset.ts";
import { loadChangelog } from "./release.ts";
import { plainText } from "./output.ts";
import { PLAN_ID_PATTERN, planStatus, loadStoredPlan } from "./plan.ts";
import { loadSnapshot, loadSource, paths } from "./project.ts";
import { PENDING_DIR } from "./readback.ts";
import { answered, hashNow, openReadbacks, pendingReadbacks } from "./readback-open.ts";
import { APPLY_COMMANDS } from "./roles.ts";
import { act, actionText, flagValue, liveRunnable, type ProjectStatus, type StatusDetail, type StepAction, statusDetail } from "./status.ts";
import type { Golden, LedgerReply, ReadbackItem, SourceConfig } from "./types.ts";
import { inScope } from "./patterns.ts";
import { effectiveScope } from "./table-list.ts";
import { type SchemaAnswer, type SchemaQuestion, schemaAnswers, schemaQuestion, schemaQuestionArgs, schemaQuestionText } from "./schema-scope.ts";
import { readYaml } from "./yaml.ts";

export const NEXT_KINDS = ["run", "ask_owner", "record_reply", "dispatch", "done"] as const;
export type NextKind = (typeof NEXT_KINDS)[number];

// Most items one readback of approved items without a recorded yes holds, so a message to the owner
// stays a short numbered list. A golden is read back on its own, since its rows may need a plan of their own.
export const BACKFILL_BATCH = 8;

export interface ConnectorTask {
  plan_id: string;
  source: string;
  dialect: string;
  // The plan's queries that have no stored result yet, in plan order.
  queries: { id: string; purpose: string; sql: string; max_rows: number }[];
  // How the runner stores each result, and the command the interviewer finishes the plan with.
  store: string;
  finish: string;
}

// The action as data: the semlayer command, its arguments and the kind. run.command is it printed.
export interface NextStepAction {
  command: string;
  args: string[];
  kind: NextKind;
  // What the command reads on its standard input (semlayer apply --file -, semlayer reply --answers -), with <placeholders> for the owner's answers.
  stdin?: string;
}

export interface NextAction {
  kind: NextKind;
  phase: string;
  why: string;
  action: NextStepAction;
  run?: { command: string };
  // A pending readback's open items (readback_id set), or, without readback_id, what to ask the owner
  // (text, with items empty) before running action, whose <placeholders> stand for their answer.
  ask_owner?: {
    readback_id?: string;
    text: string;
    items: { n: number; target: string; kind: ReadbackItem["kind"] }[];
    // The schema question only: each answer the owner can give and the commands that record it.
    options?: SchemaAnswer[];
  };
  dispatch?: { role: "connector_runner"; task: ConnectorTask };
  // What the action waits on: open_questions while open questions in access.yaml or a model wait on
  // the owner, whatever the action, which can be taken meanwhile; "connection: <variables> in <env file>"
  // while a variable the action's connection needs is set nowhere; else null.
  blocked_on: string | null;
  // With a connection block: the source, the variables nothing sets, the env file to add them to
  // and the line or lines to add, with <placeholders> for the values.
  connection?: { source: string; variables: string[]; add_to: string; line_to_add: string };
  // On an action of the access phase: the owner's changes to who sees an item, recorded on that
  // item's readback (semlayer reply --about access) and not yet settled by a yes to access.yaml.
  access_changes?: { id: string; target: string; text: string; by: string }[];
}

// A NextAction for an action: run carries the printed command, ask_owner what to ask (`ask`, else why).
function fromAction(a: StepAction | NextStepAction, phase: string, why: string, blocked_on: string | null, ask?: string): NextAction {
  const action: NextStepAction = { command: a.command, args: a.args, kind: a.kind };
  if (a.kind === "run") return { kind: "run", phase, why, action, run: { command: actionText(action as StepAction) }, blocked_on };
  if (a.kind === "ask_owner") return { kind: "ask_owner", phase, why, action, ask_owner: { text: ask ?? why, items: [] }, blocked_on };
  return { kind: a.kind, phase, why, action, blocked_on };
}

const REPLY = (id: string) => `semlayer reply --readback ${id} --item <n> --text "<owner's words>" --verdict yes|no|change --by "<owner>"`;
const EDITS =
  "a typed edit (semlayer set, semlayer tag, semlayer ignore-column, semlayer question add, semlayer add-field, semlayer remove-field, semlayer add-metric, semlayer remove-metric, semlayer add-join, semlayer add-bridge, semlayer remove-join, semlayer add-segment, semlayer remove-segment, semlayer conform or semlayer rename), " +
  "every edit of the owner's turn as one entry of one semlayer apply --file -";
// Who sees an item is decided once, in the access phase, so a change to it never holds the item.
const ABOUT_ACCESS = "--verdict change --about access";
const ACCESS_EDITS =
  "semlayer add-role, semlayer add-restriction, semlayer add-row-filter, semlayer add-attribute, semlayer set access role:<name> <key> <value> (also restriction:<name>, attribute:<name>, mode, default_role), " +
  "semlayer tag <ref> pii|sensitive, or semlayer remove-role, semlayer remove-restriction, semlayer remove-row-filter, semlayer remove-attribute";

// A golden's source config, or undefined when the golden names none or it cannot be read.
function goldenSource(root: string, name: string): SourceConfig | undefined {
  try {
    const source = readYaml<Golden>(paths(root).golden(name)).request?.source;
    return source ? loadSource(root, source) : undefined;
  } catch {
    return undefined;
  }
}

// The owner's reply a golden returned to draft set aside (semlayer goldens unconfirm writes its id), on which no confirm is offered.
function unconfirmedYes(root: string, name: string): string | undefined {
  try {
    return readYaml<Golden>(paths(root).golden(name)).unconfirmed_yes;
  } catch {
    return undefined;
  }
}

// Whether semlayer can run a golden's SQL itself, as semlayer status reads it (a dialect semlayer runs, not an export,
// a connection named); otherwise its readback and confirm take --plan or --results.
function goldenRunnable(root: string, name: string): boolean {
  const source = goldenSource(root, name);
  return !source || liveRunnable(source);
}

// For a golden semlayer cannot run: `args` with --plan <id> of a stored plan of `semlayer goldens run --name <name>`
// that has every result; an action writing that plan when none is stored; undefined while one waits
// on results (the connector runner's dispatch comes first).
function withGoldenPlan(root: string, name: string, command: string, args: string[]): StepAction | undefined {
  const plans = storedPlans(root).filter((p) => p.finish === `semlayer goldens run --name ${name} --plan ${p.plan_id}`);
  const done = plans.find((p) => p.complete);
  if (done) return act(command, [...args, "--plan", done.plan_id]);
  return plans.length ? undefined : act("goldens", ["run", "--name", name, "--emit-sql"]);
}

// The phase an approve target belongs to.
function targetPhase(st: ProjectStatus, ref: string): string {
  if (st.changed_since_approval.includes(ref) || st.hash_missing.includes(ref) || st.stamped_without_yes.includes(ref)) return "reapprove";
  if (st.approved_without_yes.includes(ref)) return "done";
  if (ref.startsWith("golden:")) return "verify";
  if (ref.startsWith("metric:")) return "metrics";
  if (ref.startsWith("schema-pair:")) return "scope";
  return ref === "access" ? "access" : "interview";
}

// A target the owner's latest reply is a yes to as it stands, and that is not approved as it stands:
// the command that records the approval. Targets are taken in the order of those replies.
function approvalReady(root: string, d: StatusDetail): NextAction | undefined {
  const last = new Map<string, number>();
  d.replies.forEach((r, i) => last.set(r.target, i));
  const blocked_on = d.status.next_step.blocked_on ?? null;
  for (const [target] of [...last].sort((a, b) => a[1] - b[1])) {
    // A target with only a change to who sees it has no reply to its content yet.
    const r = latestReply(d.replies, target);
    if (r?.verdict !== "yes") continue;
    const t = d.targets.get(target);
    const golden = target.startsWith("golden:") ? target.slice(7) : undefined;
    if (golden !== undefined) {
      if (!existsSync(paths(root).golden(golden)) || t?.hash === r.content_hash || unconfirmedYes(root, golden) === r.id) continue;
      // An export source's golden confirm refuses (Decision D2): the yes stays in the ledger for after
      // the upgrade, and semlayer status's connect step names that upgrade.
      const source = goldenSource(root, golden);
      if (source && intakeMode(source) === "export") continue;
      const confirm = goldenRunnable(root, golden) ? act("goldens", ["confirm", "--name", golden]) : withGoldenPlan(root, golden, "goldens", ["confirm", "--name", golden]);
      if (!confirm) continue;
      const write = confirm.command === "goldens" && confirm.args[0] === "run";
      return fromAction(
        confirm,
        targetPhase(d.status, target),
        `The owner said yes to golden:${golden} as read back (${r.id} in the ledger) and it is not confirmed with those rows yet. ` +
          (write
            ? `semlayer cannot run its SQL and no plan of its rows has every result: write one with the command below, store the rows with semlayer results add, then run semlayer next again.`
            : "Confirm it, passing the same --results or --plan the readback used; confirm refuses if the rows changed since."),
        blocked_on,
      );
    }
    if (!t || t.hash !== r.content_hash || t.state === "current" || t.state === "unhashed") continue;
    // Yeses of one readback, each ready to approve and none that approve would refuse, are approved
    // in one semlayer approve --readback, as the owner's turn answered them.
    const ofReadback = [...last.keys()].filter((x) => !x.startsWith("golden:") && latestReply(d.replies, x)?.verdict === "yes" && latestReply(d.replies, x)?.readback_id === r.readback_id);
    const ready = ofReadback.filter((x) => {
      const tx = d.targets.get(x);
      return !!tx && tx.hash === latestReply(d.replies, x)!.content_hash && tx.state !== "current" && tx.state !== "unhashed";
    });
    const refused = ofReadback.some((x) => !ready.includes(x) && d.targets.get(x)?.state !== "current");
    if (ready.length > 1 && !refused && existsSync(join(root, PENDING_DIR, `${r.readback_id}.json`))) {
      return fromAction(
        act("approve", ["--readback", r.readback_id]),
        targetPhase(d.status, target),
        `The owner said yes to ${ready.join(", ")} as they now stand (readback ${r.readback_id} in the ledger) and they are not approved yet. ` +
          "Approve them in one command; approved_by and approved_at come from each reply.",
        blocked_on,
      );
    }
    return fromAction(
      act("approve", ["--target", target]),
      targetPhase(d.status, target),
      `The owner said yes to ${target} as it now stands (${r.id} in the ledger) and it is not approved yet. Approve it; approved_by and approved_at come from that reply.`,
      blocked_on,
    );
  }
  return undefined;
}

// Owner text quoted as data in a why: plain, on one line, cut at 200 characters.
function quoted(text: string): string {
  const t = plainText(text).replace(/\s+/g, " ").trim();
  return `"${t.length > 200 ? `${t.slice(0, 200)}…` : t}"`;
}

// The owner's latest no or change to a target at the hash it has as it stands, unless a change was
// only to who sees it: an about-access reply to the same content after it says so.
function declinedReply(d: StatusDetail, target: string, hash: string | null): LedgerReply | undefined {
  const r = latestReply(d.replies, target);
  if (!r || r.verdict === null || r.verdict === "yes" || r.content_hash !== hash) return undefined;
  const at = d.replies.indexOf(r);
  const onlyAccess = r.verdict === "change" && d.replies.some((x, i) => i > at && x.about === "access" && x.target === target && x.content_hash === hash);
  return onlyAccess ? undefined : r;
}

// The oldest readback with items the owner has not answered, each still as it was read back.
function askOwner(root: string, d: StatusDetail): NextAction | undefined {
  // An item a newer readback of the same target settled on the owner's recorded reply is not asked again.
  for (const { readback: p, current, open } of openReadbacks(root, d.targets, d.replies)) {
    if (!open.length) continue;
    const text = open.map((i) => `${i.n}. ${plainText(i.text).split("\n").join("\n   ")}`).join("\n\n");
    // An item whose who-sees the owner asked to change still waits for a yes to the item itself.
    const noted = openAccessChanges(d.replies).filter((r) => open.some((i) => i.target === r.target && i.content_hash === r.content_hash));
    const kept = noted.length
      ? ` The owner's change to who sees ${[...new Set(noted.map((r) => r.target))].join(", ")} (${noted.map((r) => r.id).join(", ")}) is kept for the access phase and does not hold the item: ask only whether the rest of it is right.`
      : "";
    // Items of this readback the owner already asked to change: their words, for after this round.
    const changes = current.flatMap((i) => {
      const r = declinedReply(d, i.target, i.content_hash);
      return r ? [`item ${i.n} (${i.target}, ${r.id}, ${plainText(r.by)} said ${r.verdict}): ${quoted(r.text)}`] : [];
    });
    const asked = changes.length ? ` The owner already answered no or change to ${changes.join("; ")}; make each change with a typed edit once this round is answered.` : "";
    return {
      kind: "ask_owner",
      phase: targetPhase(d.status, open[0]!.target),
      why:
        `Readback ${p.readback_id} has ${open.length} item(s) waiting for the owner's answer: ${open.map((i) => `${i.n} (${i.target})`).join(", ")}. ` +
        `Read each to the owner as written, ending with "Approve?", then ` +
        (open.length > 1
          ? `record the turn's answers, each item with its own verdict and their words, and approve each yes in one semlayer reply --readback ${p.readback_id} --answers - --approve (one answer alone: ${REPLY(p.readback_id)}). `
          : `record the answer in their words with ${REPLY(p.readback_id)}. `) +
        `A change only to who sees an item is recorded with ${ABOUT_ACCESS} and never holds the item.${kept}${asked} ` +
        `A readback the owner will not answer is set aside with semlayer readback --discard ${p.readback_id}.`,
      // More than one open item: the batched reply, its answers on stdin, one entry per item.
      action:
        open.length > 1
          ? {
              command: "reply",
              args: ["--readback", p.readback_id, "--answers", "-", "--approve"],
              kind: "ask_owner",
              stdin: JSON.stringify({ by: "<owner>", answers: open.map((i) => ({ item: i.n, verdict: "yes|no|change", text: "<owner's words>" })) }),
            }
          : { command: "reply", args: ["--readback", p.readback_id, "--item", "<n>", "--text", "<owner's words>", "--verdict", "yes|no|change", "--by", "<owner>"], kind: "ask_owner" },
      ask_owner: { readback_id: p.readback_id, text, items: open.map((i) => ({ n: i.n, target: i.target, kind: i.kind })) },
      blocked_on: d.status.next_step.blocked_on ?? null,
    };
  }
  return undefined;
}

// The stored plans of .semlayer/plans/, by plan id, each with its status; a plan that cannot be read is skipped.
function storedPlans(root: string): ReturnType<typeof planStatus>[] {
  const dir = join(root, ".semlayer", "plans");
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && PLAN_ID_PATTERN.test(f.slice(0, -5)))
    .map((f) => f.slice(0, -5))
    .sort();
  return ids.flatMap((id) => {
    try {
      return [planStatus(root, id)];
    } catch {
      return [];
    }
  });
}

// The phase of the command a plan finishes; another command's plan belongs to the current phase.
const PLAN_PHASE: Record<string, string> = { introspect: "introspect", profile: "profile", "check-join": "check-join", goldens: "verify", readback: "verify" };

// A plan emitted with --emit-sql that still needs results: a task for the connector runner.
function dispatchRunner(root: string, d: StatusDetail): NextAction | undefined {
  const plan = storedPlans(root).find((p) => p.remaining.length);
  if (!plan) return undefined;
  const stored = loadStoredPlan(root, plan.plan_id);
  const queries = stored.queries.filter((q) => plan.remaining.includes(q.id)).map(({ id, purpose, sql, max_rows }) => ({ id, purpose, sql, max_rows }));
  return {
    kind: "dispatch",
    phase: PLAN_PHASE[plan.command] ?? d.status.next_step.phase,
    why:
      `Query plan ${plan.plan_id} (${plan.command} on "${plan.source}") still needs results for ${queries.length} of ${plan.queries.length} queries. ` +
      `A connector runner runs each read-only query with a row limit of its max_rows and stores the rows with semlayer results add; then run ${plan.finish}. ` +
      `A plan nobody needs any more is removed by deleting .semlayer/plans/${plan.plan_id}.json.`,
    // The runner's own check of what the plan still needs.
    action: { command: "results", args: ["status", "--plan", plan.plan_id], kind: "dispatch" },
    dispatch: {
      role: "connector_runner",
      task: {
        plan_id: plan.plan_id,
        source: plan.source,
        dialect: plan.dialect,
        queries,
        store: `semlayer results add --plan ${plan.plan_id} --query <query id> --file <rows.json>`,
        finish: plan.finish,
      },
    },
    blocked_on: d.status.next_step.blocked_on ?? null,
  };
}

// semlayer status's next step as one action. A readback whose targets the owner already declined as they
// stand leaves them out and quotes the owner's words; with none left it asks for the edit they want.
// An --emit-sql step whose plan has every result becomes the plan's finish command; done reads back
// approved items without a recorded yes first.
function fromStatus(root: string, d: StatusDetail): NextAction {
  const st = d.status;
  const step = st.next_step;
  const blocked_on = step.blocked_on ?? null;
  // A draft golden on a source semlayer cannot run is read back from its plan once every result is stored.
  const draft = step.phase === "verify" && step.action.command === "goldens" && step.action.args[0] === "run" ? flagValue(step.action, "--name") : undefined;
  const planned = draft !== undefined && step.action.args.includes("--emit-sql") ? withGoldenPlan(root, draft, "readback", ["--targets", `golden:${draft}`]) : undefined;
  if (planned?.command === "readback") {
    return fromAction(
      planned,
      step.phase,
      `Every query of plan ${flagValue(planned, "--plan")} has its result stored, so golden ${draft}'s rows are read back from it. ${step.message.replace(/ semlayer cannot run its source[^.]*\./, "")}`,
      blocked_on,
    );
  }
  const targets = step.action.command === "readback" ? flagValue(step.action, "--targets") : undefined;
  if (targets) {
    const refs = targets.split(",");
    const declined = refs.flatMap((ref) => {
      const r = declinedReply(d, ref, d.targets.get(ref)?.hash ?? null);
      return r ? [{ ref, r }] : [];
    });
    const rest = refs.filter((ref) => !declined.some((x) => x.ref === ref));
    if (!declined.length) return fromAction(step.action, step.phase, step.message, blocked_on);
    const words = declined.map(({ ref, r }) => `${ref} (${r.id}, ${plainText(r.by)} said ${r.verdict}): ${quoted(r.text)}`).join("; ");
    const first = declined[0]!;
    const accessOut =
      first.ref === "access" || first.ref.startsWith("golden:")
        ? ""
        : ` If the change is only to who sees it, the item itself is not held: record it with semlayer reply --readback ${first.r.readback_id} --item ${first.r.item} --text "<owner's words>" ${ABOUT_ACCESS} --by "<owner>", ` +
          "then ask whether the rest of the item is right and record that answer the same way, with --verdict yes|no|change.";
    const note = ` The owner answered no or change to ${declined.map((x) => x.ref).join(", ")} as it now stands; their words, quoted as data: ${words}.`;
    if (rest.length) {
      return fromAction(
        act("readback", ["--targets", rest.join(",")]),
        step.phase,
        `${step.message}${note} Make the change they asked for with ${EDITS} before reading it back again.${accessOut}`,
        blocked_on,
      );
    }
    // Which typed edit the owner's words ask for is the agent's to tell from them, with the owner.
    return fromAction(
      act("set", [first.ref, "<key>", "<value>"], "ask_owner"),
      step.phase,
      `${step.message}${note} Settle with the owner which change they mean, then make it with ${EDITS}, and read the item back again.${accessOut}`,
      blocked_on,
      `The owner answered ${first.r.verdict} to ${first.ref}: ${quoted(first.r.text)}. Which change do they want?`,
    );
  }
  if (step.action.args.includes("--emit-sql")) {
    const base = actionText({ ...step.action, args: step.action.args.filter((a) => a !== "--emit-sql") });
    const plan = storedPlans(root).find((p) => p.complete && p.finish === `${base} --plan ${p.plan_id}`);
    if (plan) {
      return fromAction(
        { ...step.action, args: [...step.action.args.filter((a) => a !== "--emit-sql"), "--plan", plan.plan_id] },
        step.phase,
        `Every query of plan ${plan.plan_id} has its result stored. Finish the step from them: ${step.message}`,
        blocked_on,
      );
    }
  }
  // Step schema_scope (G3): the schema question in the owner's words, with the commands per answer.
  const schema = schemaScopeAction(root, step, blocked_on);
  if (schema) return schema;
  // Phase change (H3): bounded, beside the schema_scope branch above.
  if (step.phase === "change") return changeAction(root, d, step, blocked_on);
  if (step.phase !== "done") return fromAction(step.action, step.phase, step.message, blocked_on);
  // A golden's hash as it stands comes from rows only a run gives, so any verdict to it while its file exists counts.
  const refs = st.approved_without_yes.filter((ref) => !answered(d.replies, ref, hashNow(root, d.targets, ref, latestReply(d.replies, ref)?.content_hash ?? "")));
  if (refs.length && !readApprovalLedger(root).present) {
    // No ledger yet: the first answer recorded would end the rule that lets these approvals count, so the
    // owner confirms them as they stand before anything is read back.
    return fromAction(
      act("approve", ["--confirm-existing", "--by", "<owner>", "--reply", "<owner's words>"], "ask_owner"),
      "done",
      `Every phase is done, but ${refs.length} approved item(s) have no recorded owner yes (approved before semlayer approve required one, or the ledger is missing: if this is a clone, restore .semlayer/ledger.jsonl from version control). ` +
        "They count as approved until the first answer is recorded. Ask the owner whether they stand as they are, and if so record it in their words before any readback.",
      blocked_on,
    );
  }
  if (refs.length) {
    const items = refs.filter((r) => !r.startsWith("golden:"));
    const batch = items.length ? items.slice(0, BACKFILL_BATCH) : refs.slice(0, 1);
    const golden = items.length ? undefined : batch[0]!.slice(7);
    const readback = act("readback", ["--targets", batch.join(",")]);
    const lead = releaseLead(root);
    // dispatchRunner comes before this, so a plan of the golden here has every result or there is none.
    const planned = golden !== undefined && !goldenRunnable(root, golden) ? withGoldenPlan(root, golden, "readback", readback.args) : undefined;
    return fromAction(
      planned ?? readback,
      "done",
      `Every phase is done, but ${refs.length} approved item(s) have no recorded owner yes that matches them as they stand (approved before semlayer approve required one). ` +
        "They stay approved: read them back so the owner's answer is in the ledger, and revoke any the owner no longer confirms." +
        (planned?.command === "goldens" ? ` semlayer cannot run golden:${golden}'s SQL: write its plan with the command below, store the rows with semlayer results add, then run semlayer next again.` : "") +
        (lead ? ` Meanwhile: ${lead}` : ""),
      blocked_on,
    );
  }
  return fromAction(step.action, "done", step.message, blocked_on);
}

// Phase change: while a change round is open and every earlier phase is complete, the next step per
// item the round left to read back (not approved as it stands, except a draft the owner deferred: one never approved
// and not in the last release that was already a draft when the round started, which the close leaves out), up to
// BACKFILL_BATCH in one readback, then the close, semlayer change close, with the next minor above the
// release as the version; the owner chooses the version, so why says to ask them before running it.
function changeAction(root: string, d: StatusDetail, step: ProjectStatus["next_step"], blocked_on: string | null): NextAction {
  const last = loadChangelog(root).log?.entries.at(-1);
  const baseline = last?.items ?? {};
  const atStart = loadChange(root).change?.drafts_at_start ?? [];
  const pending = [...d.targets]
    .filter(([ref, t]) => !ref.startsWith("golden:") && t.state !== "current" && t.state !== "unhashed" && !deferredAtStart(ref, { hash: t.hash, approved: false, plain: t.state === "draft" && !t.stamped }, baseline, atStart))
    .map(([ref]) => ref)
    .sort();
  if (pending.length) {
    const batch = pending.slice(0, BACKFILL_BATCH);
    // A metric is read back by the metrics card's rules; anything else by the change card's.
    return fromAction(
      act("readback", ["--targets", batch.join(",")]),
      batch[0]!.startsWith("metric:") ? "metrics" : "change",
      `${step.message} ${pending.length} item(s) the round changed or added wait for the owner's yes (${batch.join(", ")}${pending.length > batch.length ? ", and more" : ""}): read ${batch.length === 1 ? "it" : "them"} back, record the answer, then run semlayer next again.`,
      blocked_on,
    );
  }
  // Goldens that read a changed item and rest on a yes older than the change: the close reruns them, so the
  // step names them and the check to run first; one whose figures did not move needs no new yes.
  const unsettled = last ? unsettledGoldens(root, d, last.items, last.definitions, last.date) : [];
  const shown = unsettled.slice(0, BACKFILL_BATCH);
  const goldensText = unsettled.length
    ? ` Before asking for the version, run semlayer goldens check: ${unsettled.length} confirmed golden(s) read an item the round changed and have not been confirmed since (${shown.join(", ")}${unsettled.length > shown.length ? ", and more" : ""}). ` +
      "One that passes needs nothing. One whose figures moved is settled by the owner's yes to the new rows (semlayer readback --targets golden:<g>, showing the old and the new figures, then semlayer goldens confirm --name <g>) or, " +
      "when the owner cannot check the new figures now, by semlayer goldens unconfirm --name <g>, which returns it to draft so the release leaves it out. The close refuses while one that moved is still confirmed on the old figures."
    : "";
  const [major, minor] = (last?.version ?? "1.-1").split(".").map(Number) as [number, number];
  const suggested = `${major}.${minor + 1}`;
  const left = [...d.targets].filter(([ref, t]) => !ref.startsWith("golden:") && deferredAtStart(ref, { hash: t.hash, approved: false, plain: t.state === "draft" && !t.stamped }, baseline, atStart)).map(([ref]) => ref).sort();
  const leftText = left.length
    ? ` Drafts the owner deferred, which the release leaves out (${left.length}): ${left.slice(0, BACKFILL_BATCH).join(", ")}${left.length > BACKFILL_BATCH ? ", and more" : ""}; name them to the owner, who can approve any of them first to have it in this release.`
    : "";
  return fromAction(
    act("change", ["close", "--version", suggested]),
    "change",
    `${step.message} Every item the round added or changed is approved; a draft the owner deferred before the round stays out of the release, and the summary to the owner names it. The last step closes the round as a release with the version the owner chooses: ` +
      `ask them first ("The change is ready to release${last ? `; the layer is at ${last.version}` : ""}. Which version should it be? I suggest ${suggested}` +
      `${last ? ` (a large change could be ${major + 1}.0)` : ""}; say if you prefer another."), then run semlayer change close --version <their version>. ` +
      "It records the release in changelog.yaml and sets layer_version, or refuses, naming each item, error or moved golden that must be settled first." + leftText + goldensText,
    blocked_on,
  );
}

// The confirmed goldens that read an item changed since the last release (its `affected_goldens`) and rest on
// no owner yes given after the yes to that item, sorted. Read from the ledger only, with no query: the reply ids
// rise in the order they were recorded, so a golden's yes (to it as it stands) newer than the item's settles it.
// A golden returned to draft is settled: the release leaves it out. A golden semlayer can never run here (an
// export source, a dialect it does not connect to, no connection named) is left out, as the close lists it as not rerun.
function unsettledGoldens(root: string, d: StatusDetail, items: Record<string, string>, definitions?: Record<string, string>, releaseDate?: string): string[] {
  const seq = (r: LedgerReply | undefined) => (r ? Number(/(\d+)$/.exec(r.id)?.[1] ?? 0) : 0);
  const out = new Set<string>();
  for (const c of changeSince(root, items, definitions, releaseDate).changed) {
    const itemYes = seq(currentYes(d.replies, c.ref, d.targets.get(c.ref)?.hash ?? ""));
    for (const g of c.affected_goldens) {
      const t = d.targets.get(`golden:${g}`);
      const source = goldenSource(root, g);
      if (!t || !source || !liveRunnable(source)) continue;
      const own = seq(currentYes(d.replies, `golden:${g}`, t.hash));
      if (!own || own <= itemYes) out.add(g);
    }
  }
  return [...out].sort();
}

// The schema question of semlayer status's scope step, when that is the step: ask_owner with the
// question and, in ask_owner.options and in why, the commands that record each answer.
function schemaScopeAction(root: string, step: ProjectStatus["next_step"], blocked_on: string | null): NextAction | undefined {
  if (step.phase !== "scope" || !step.source || step.action.kind !== "ask_owner") return undefined;
  let q: SchemaQuestion | undefined;
  try {
    const source = loadSource(root, step.source);
    const scope = effectiveScope(root, source);
    q = schemaQuestion(source, loadSnapshot(root, step.source), (t) => inScope(scope, t));
  } catch {
    return undefined;
  }
  if (!q) return undefined;
  const a = schemaQuestionArgs(q);
  if (a.command !== step.action.command || a.args.join("\u0000") !== step.action.args.join("\u0000")) return undefined;
  const text = schemaQuestionText(q);
  const options = schemaAnswers(q);
  const answers = options.map((o) => `"${o.answer}": ${o.commands.join(", then ")}`).join("; ");
  const out = fromAction(step.action, step.phase, `${step.message} Ask: "${text}" Then record the answer. ${answers}.`, blocked_on, text);
  return { ...out, ask_owner: { ...out.ask_owner!, options } };
}

// The source whose connection a run action opens, or undefined: introspect, profile, check-join and
// goldens run, confirm and check read the database unless they write or read a plan; a readback
// reads it for a golden target.
function connectionSource(root: string, a: NextStepAction): string | undefined {
  if (a.kind !== "run" || ["--emit-sql", "--plan", "--results"].some((f) => a.args.includes(f))) return undefined;
  if (["introspect", "profile", "check-join"].includes(a.command)) return flagValue(a as StepAction, "--source");
  if (a.command === "goldens" && ["run", "confirm", "check"].includes(a.args[0] ?? "")) {
    const name = flagValue(a as StepAction, "--name");
    return name ? (goldenSource(root, name)?.source ?? flagValue(a as StepAction, "--source")) : flagValue(a as StepAction, "--source");
  }
  if (a.command === "readback") {
    const golden = (flagValue(a as StepAction, "--targets") ?? "").split(",").find((t) => t.startsWith("golden:"));
    return golden ? goldenSource(root, golden.slice(7))?.source : undefined;
  }
  return undefined;
}

// An action whose connection variable nothing sets cannot run: the owner adds the line to the env
// file instead (no value is read or printed here), and semlayer setup with the source's own arguments
// checks the connection.
function connectionBlock(root: string, env: Env, a: NextAction): NextAction | undefined {
  const name = connectionSource(root, a.action);
  if (!name) return undefined;
  let source: SourceConfig;
  try {
    source = loadSource(root, name);
  } catch {
    return undefined;
  }
  let res: ReturnType<typeof resolveConnection>;
  try {
    res = resolveConnection(root, source, env);
  } catch {
    // A connection block semlayer cannot read (connection.env beside env_prefix): semlayer validate names it.
    return fromAction(act("validate", []), a.phase, `The next step (${actionText(a.action as StepAction)}) connects to source "${name}", whose connection block cannot be read. semlayer validate names what to fix.`, a.blocked_on);
  }
  if (res.status !== "unset") return undefined;
  const how = source.connection?.env ? ["--env", source.connection.env] : ["--env-prefix", source.connection?.env_prefix ?? ""];
  const blocked = `connection: ${res.variables.join(", ")} in ${res.add_to}`;
  return {
    ...fromAction(
      act("setup", ["--source", name, "--dialect", source.dialect, ...how], "ask_owner"),
      a.phase,
      `The next step (${actionText(a.action as StepAction)}) connects to source "${name}", and ${res.message.replace(/^Source "[^"]*": /, "").replace(/, then run the same command again:\n/, ":\n")}\n` +
        `Once the owner has added it, check the connection with the command below, then run semlayer next again. Never read or print the env file.`,
      blocked,
      `Please add ${res.variables.length > 1 ? "these lines" : "this line"} to ${res.add_to}, with the real values in place of each <...> (the values stay out of the chat):\n${res.line_to_add}`,
    ),
    connection: { source: name, variables: res.variables, add_to: res.add_to, line_to_add: res.line_to_add },
  };
}

// The first step, in a directory with no semantic layer yet: create it under the name the owner gives.
function noLayerAction(root: string): NextAction {
  const why =
    `No semantic layer at ${root} yet, so the first step creates it (if one exists elsewhere, pass --root <dir>). Follow references/phases/intake.md, ` +
    "First turn: ask the owner for a read-only connection to their Postgres database (DuckDB for sample data and files), and propose a default <name> for the layer from the company or the source " +
    "(a short name such as acme, in lowercase letters, digits and _; it can be changed later in semantic.yaml). Once they name the connection, " +
    "semlayer setup with --name <name> creates the layer and its first source in one command; without a connection, run the command below.";
  const ask =
    "Which database should the layer read, through a read-only connection? It is built on a Postgres database, or on DuckDB for sample data and files such as Parquet or CSV. " +
    "Name the environment variable or env file that holds it, never its value. " +
    "I suggest calling the layer <name> (a short name from the company or the source, such as acme); say if you prefer another.";
  return { kind: "ask_owner", phase: "init", why, action: { command: "init", args: ["--name", "<name>"], kind: "ask_owner" }, ask_owner: { text: ask, items: [] }, blocked_on: null };
}

// The one action the skill takes next: approve what the owner said yes to, ask the owner what a
// pending readback holds, dispatch a plan that waits on results, else semlayer status's next step. A
// ledger semlayer approve would refuse comes first, and a step whose connection is not set waits on it.
// record_reply is not returned yet: an answer the owner gave in chat is the agent's to record.
export function nextAction(root: string, env: Env = {}): NextAction {
  if (!existsSync(paths(root).project)) return noLayerAction(root);
  const d = statusDetail(root);
  if (d.ledger_problem !== null) return fromAction(act("validate", []), d.status.next_step.phase, d.ledger_problem, d.status.next_step.blocked_on ?? null);
  const first = approvalReady(root, d) ?? askOwner(root, d) ?? dispatchRunner(root, d);
  const action = inApply(lacking(root, withAccessChanges(d, first ?? fromStatus(root, d), !first)));
  return connectionBlock(root, env, action) ?? action;
}

// An action that names one typed edit says where it goes: one owner turn's edits go in one semlayer apply,
// so `why` gives the entry that apply takes beside the command on its own.
function inApply(a: NextAction): NextAction {
  const words = [a.action.command, ...a.action.args];
  const named = APPLY_COMMANDS.some((c) => c.split(" ").every((w, i) => words[i] === w));
  if (!named || a.kind === "done" || a.kind === "dispatch") return a;
  return { ...a, why: `${a.why} Record it ${inTurnApply([words], "beside the turn's other edits")}.` };
}

// A readback (or an approve) of items semlayer readback would refuse for what their files lack (a
// description, a grain, a primary_key, a metric's measure, what semlayer validate would raise once they
// are approved) becomes the one semlayer apply that gives it, the owner's words in
// place of each <placeholder>, so the command named runs.
function lacking(root: string, a: NextAction): NextAction {
  const command = a.action.command;
  if (!((a.kind === "run" && command === "readback") || command === "approve")) return a;
  if (a.action.args.includes("--confirm-existing")) return a;
  // A semlayer approve the gate would refuse (a yes recorded before the item lacked something) gets the same apply.
  const rb = command === "approve" ? flagValue(a.action as StepAction, "--readback") : undefined;
  const refs = rb
    ? (pendingReadbacks(root).find((p) => p.readback_id === rb)?.items ?? []).map((i) => i.target).filter((t) => !t.startsWith("golden:"))
    : (flagValue(a.action as StepAction, command === "readback" ? "--targets" : "--target") ?? "").split(",");
  const lacks = approvalLacks(root, refs);
  if (!lacks.length) return a;
  const why = `${a.why} ${lacksNote(lacks)}`;
  // A lack no typed edit below gives is fixed as its words say; semlayer validate lists it meanwhile.
  const edits = lacks.some((l) => l.edit);
  const action = edits ? act("apply", ["--file", "-"], "ask_owner") : act("validate", [], "ask_owner");
  const out = fromAction(action, a.phase, why, a.blocked_on, edits ? lackQuestions(lacks) : undefined);
  if (edits) out.action = { ...out.action, stdin: lacksFile(lacks) };
  return { ...out, ...(a.access_changes ? { access_changes: a.access_changes } : {}) };
}

// An item as the owner knows it: a metric, a field on its table, or a table.
function itemWords(ref: string): string {
  if (ref.startsWith("metric:")) return `the figure ${ref.slice(7)}`;
  const [, model, field] = ref.split(".");
  return field ? `${field} on ${model}` : `the table ${model}`;
}

// What to ask the owner for each lack a typed edit gives, one numbered question each: the answers
// fill the <placeholders> of action.stdin.
function lackQuestions(lacks: Lack[]): string {
  const ask = (l: Lack): string | undefined => {
    if (!l.edit) return undefined;
    const [command, ref = l.target, key] = l.edit;
    const it = itemWords(ref);
    if (command === "tag") return `Is ${it} personal or sensitive data, or may everyone see it?`;
    switch (key) {
      case "description":
        return `In your words, what is ${it}: what does it count or add up?`;
      case "grain":
        return `What is one row of ${it.replace(/^the table /, "")}?`;
      case "primary_key":
        return `Which column, or columns, tell one row of ${it.replace(/^the table /, "")} from another?`;
      case "currency":
        return `Which currency are the amounts of ${it} in?`;
      case "through":
        return `When one row has several values through the join ${it}, how is its figure shared: in full to each (distinct_pairs), split equally (equal_split), or by a numeric column of the bridge (weight)?`;
      case "fanout_override":
        return `The join ${it} matches some rows more than once. Why is that fine?`;
      case "numerator":
      case "denominator":
        return `Which figure is the ${key} of ${it}?`;
      case "expr":
        return `How is ${it} worked out from the other figures?`;
      default:
        return `What should the ${key ?? "value"} of ${it} be?`;
    }
  };
  const questions = [...new Set(lacks.map(ask).filter((q): q is string => !!q))];
  return [`Before I read ${questions.length === 1 ? "this" : "these"} back for your sign-off, I need your words:`, ...questions.map((q, i) => `${i + 1}. ${q}`)].join("\n");
}

// Routes the owner's changes to who sees an item to the access phase: an action of that phase names
// them, and when access.yaml is approved and nothing else is left before the goldens or the
// handoff, they reopen the phase. Items of other phases go on meanwhile.
function withAccessChanges(d: StatusDetail, action: NextAction, fromStep: boolean): NextAction {
  const changes = openAccessChanges(d.replies);
  if (!changes.length) return action;
  const reopen = fromStep && d.status.access.state === "approved" && (action.phase === "verify" || action.phase === "done");
  if (action.phase !== "access" && !reopen) return action;
  const short = (t: string) => (t.length > 200 ? `${t.slice(0, 200)}…` : t);
  const asked =
    `The owner asked for ${changes.length} change(s) to who sees what while answering other items: ` +
    `${changes.map((r) => `${r.target} (${r.id}, ${plainText(r.by)}): "${short(plainText(r.text))}"`).join("; ")}. ` +
    `Make each with an access command (${ACCESS_EDITS}), then read access.yaml back with semlayer readback --targets access: the owner's yes to it settles them.`;
  const access_changes = changes.map((r) => ({ id: r.id, target: r.target, text: r.text, by: r.by }));
  if (reopen)
    return { ...fromAction(act("access", []), "access", `access.yaml is approved, and an edit makes it a draft again until the owner approves it. ${asked}`, action.blocked_on), access_changes };
  return { ...action, why: `${action.why} ${asked}`, ...(action.ask_owner && !action.ask_owner.readback_id ? { ask_owner: { ...action.ask_owner, text: `${action.ask_owner.text} ${asked}` } } : {}), access_changes };
}

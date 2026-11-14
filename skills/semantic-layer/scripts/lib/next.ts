// The one next action of the skill (sl next): sl status's next step, read together with the answer
// ledger, the pending readbacks and the stored query plans. It reads files only and writes nothing.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canRun } from "./adapters/index.ts";
import { intakeMode } from "./intake.ts";
import { latestReply, openAccessChanges } from "./ledger.ts";
import { plainText } from "./output.ts";
import { PLAN_ID_PATTERN, planStatus, loadStoredPlan } from "./plan.ts";
import { loadSource, paths } from "./project.ts";
import { PENDING_DIR } from "./readback.ts";
import { type ProjectStatus, type StatusDetail, statusDetail } from "./status.ts";
import type { Golden, LedgerReply, PendingReadback, ReadbackItem, SourceConfig } from "./types.ts";
import { schemaIssues } from "./schema.ts";
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

export interface NextAction {
  kind: NextKind;
  phase: string;
  why: string;
  run?: { command: string };
  ask_owner?: { readback_id: string; text: string; items: { n: number; target: string; kind: ReadbackItem["kind"] }[] };
  dispatch?: { role: "connector_runner"; task: ConnectorTask };
  // What sl status's step waits on: open_questions while access.yaml's open questions wait on the owner,
  // else null. It is set whatever the action, which can be taken meanwhile.
  blocked_on: string | null;
  // On an action of the access phase: the owner's changes to who sees an item, recorded on that
  // item's readback (sl reply --about access) and not yet settled by a yes to access.yaml.
  access_changes?: { id: string; target: string; text: string; by: string }[];
}

const REPLY = (id: string) => `sl reply --readback ${id} --item <n> --text "<owner's words>" --verdict yes|no|change --by "<owner>"`;
const EDITS = "a typed edit (sl set, sl tag, sl ignore-column, sl question add, sl add-field, sl remove-field, sl add-metric, sl remove-metric or sl rename)";
// Who sees an item is decided once, in the access phase, so a change to it never holds the item.
const ABOUT_ACCESS = "--verdict change --about access";
const ACCESS_EDITS =
  "sl add-role, sl add-restriction, sl add-row-filter, sl add-attribute, sl set access role:<name> <key> <value> (also restriction:<name>, attribute:<name>, mode, default_role), " +
  "sl tag <ref> pii|sensitive, or sl remove-role, sl remove-restriction, sl remove-row-filter, sl remove-attribute";

// A target's content hash as it now stands, or null when it no longer exists. A golden's hash covers
// rows only a run gives, so while its file exists the hash a readback stored stands, as sl reply reads it.
function hashNow(root: string, d: StatusDetail, target: string, stored: string): string | null {
  const golden = /^golden:([a-z][a-z0-9_]*)$/.exec(target)?.[1];
  if (golden) return existsSync(paths(root).golden(golden)) ? stored : null;
  return d.targets.get(target)?.hash ?? null;
}

// Whether the owner's latest reply to the target, in any readback, gave a verdict on it with this
// content hash. A later reply without a verdict, or one to other content, leaves the target open: the
// one rule approval, the declined check, the open items and the done readbacks all read.
function answered(replies: LedgerReply[], target: string, hash: string | null): boolean {
  const r = latestReply(replies, target);
  return !!r && r.verdict !== null && r.content_hash === hash;
}

// A golden's source config, or undefined when the golden names none or it cannot be read.
function goldenSource(root: string, name: string): SourceConfig | undefined {
  try {
    const source = readYaml<Golden>(paths(root).golden(name)).request?.source;
    return source ? loadSource(root, source) : undefined;
  } catch {
    return undefined;
  }
}

// Whether sl can run a golden's SQL itself; otherwise its readback and confirm take --plan or --results.
function goldenRunnable(root: string, name: string): boolean {
  const source = goldenSource(root, name);
  return !source || (canRun(source) && intakeMode(source) !== "export");
}

// The phase an approve target belongs to.
function targetPhase(st: ProjectStatus, ref: string): string {
  if (st.changed_since_approval.includes(ref) || st.hash_missing.includes(ref)) return "reapprove";
  if (st.approved_without_yes.includes(ref)) return "done";
  if (ref.startsWith("golden:")) return "verify";
  if (ref.startsWith("metric:")) return "metrics";
  return ref === "access" ? "access" : "interview";
}

// A target the owner's latest reply is a yes to as it stands, and that is not approved as it stands:
// the command that records the approval. Targets are taken in the order of those replies.
function approvalReady(root: string, d: StatusDetail): NextAction | undefined {
  const last = new Map<string, number>();
  d.replies.forEach((r, i) => last.set(r.target, i));
  for (const [target] of [...last].sort((a, b) => a[1] - b[1])) {
    // A target with only a change to who sees it has no reply to its content yet.
    const r = latestReply(d.replies, target);
    if (r?.verdict !== "yes") continue;
    const t = d.targets.get(target);
    const golden = target.startsWith("golden:") ? target.slice(7) : undefined;
    if (golden !== undefined) {
      if (!existsSync(paths(root).golden(golden)) || t?.hash === r.content_hash) continue;
      // An export source's golden confirm refuses (Decision D2): the yes stays in the ledger for after
      // the upgrade, and sl status's connect step names that upgrade.
      const source = goldenSource(root, golden);
      if (source && intakeMode(source) === "export") continue;
      return {
        kind: "run",
        phase: targetPhase(d.status, target),
        why:
          `The owner said yes to golden:${golden} as read back (${r.id} in the ledger) and it is not confirmed with those rows yet. ` +
          "Confirm it, passing the same --results or --plan the readback used; confirm refuses if the rows changed since.",
        run: { command: `sl goldens confirm --name ${golden}${goldenRunnable(root, golden) ? "" : " --plan <plan_id>"}` },
        blocked_on: d.status.next_step.blocked_on ?? null,
      };
    }
    if (!t || t.hash !== r.content_hash || t.state === "current" || t.state === "unhashed") continue;
    return {
      kind: "run",
      phase: targetPhase(d.status, target),
      why: `The owner said yes to ${target} as it now stands (${r.id} in the ledger) and it is not approved yet. Approve it; approved_by and approved_at come from that reply.`,
      run: { command: `sl approve --target ${target}` },
      blocked_on: d.status.next_step.blocked_on ?? null,
    };
  }
  return undefined;
}

// The readbacks in .sl/pending/, oldest first; a file that is not a valid readback is skipped (sl validate reports it).
function pendingReadbacks(root: string): PendingReadback[] {
  const dir = join(root, PENDING_DIR);
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir)
    .map((f) => /^(rb_(\d{4,}))\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[2]) - Number(b[2]));
  return ids.flatMap((m) => {
    try {
      const data = JSON.parse(readFileSync(join(dir, m[0]), "utf8")) as PendingReadback;
      return schemaIssues("pending", data, m[0]).length || data.readback_id !== m[1] ? [] : [data];
    } catch {
      return [];
    }
  });
}

// The oldest readback with items the owner has not answered, each still as it was read back.
function askOwner(root: string, d: StatusDetail): NextAction | undefined {
  for (const p of pendingReadbacks(root)) {
    const open = p.items.filter((i) => hashNow(root, d, i.target, i.content_hash) === i.content_hash && !answered(d.replies, i.target, i.content_hash));
    if (!open.length) continue;
    const text = open.map((i) => `${i.n}. ${plainText(i.text).split("\n").join("\n   ")}`).join("\n\n");
    // An item whose who-sees the owner asked to change still waits for a yes to the item itself.
    const noted = openAccessChanges(d.replies).filter((r) => open.some((i) => i.target === r.target && i.content_hash === r.content_hash));
    const kept = noted.length
      ? ` The owner's change to who sees ${[...new Set(noted.map((r) => r.target))].join(", ")} (${noted.map((r) => r.id).join(", ")}) is kept for the access phase and does not hold the item: ask only whether the rest of it is right.`
      : "";
    return {
      kind: "ask_owner",
      phase: targetPhase(d.status, open[0]!.target),
      why:
        `Readback ${p.readback_id} has ${open.length} item(s) waiting for the owner's answer: ${open.map((i) => `${i.n} (${i.target})`).join(", ")}. ` +
        `Read each to the owner as written, ending with "Approve?", then record each answer in their words with ${REPLY(p.readback_id)}. ` +
        `A change only to who sees an item is recorded with ${ABOUT_ACCESS} and never holds the item.${kept} ` +
        `A readback the owner will not answer is set aside by deleting .sl/pending/${p.readback_id}.json.`,
      ask_owner: { readback_id: p.readback_id, text, items: open.map((i) => ({ n: i.n, target: i.target, kind: i.kind })) },
      blocked_on: d.status.next_step.blocked_on ?? null,
    };
  }
  return undefined;
}

// The stored plans of .sl/plans/, by plan id, each with its status; a plan that cannot be read is skipped.
function storedPlans(root: string): ReturnType<typeof planStatus>[] {
  const dir = join(root, ".sl", "plans");
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
      `A connector runner runs each read-only query with a row limit of its max_rows and stores the rows with sl results add; then run ${plan.finish}. ` +
      `A plan nobody needs any more is removed by deleting .sl/plans/${plan.plan_id}.json.`,
    dispatch: {
      role: "connector_runner",
      task: {
        plan_id: plan.plan_id,
        source: plan.source,
        dialect: plan.dialect,
        queries,
        store: `sl results add --plan ${plan.plan_id} --query <query id> --file <rows.json>`,
        finish: plan.finish,
      },
    },
    blocked_on: d.status.next_step.blocked_on ?? null,
  };
}

// sl status's next step as one action. A readback whose targets the owner already declined as they
// stand becomes the typed edit they asked for; an --emit-sql step whose plan has every result becomes
// the plan's finish command; done reads back approved items without a recorded yes first.
function fromStatus(root: string, d: StatusDetail): NextAction {
  const st = d.status;
  const step = st.next_step;
  const blocked_on = step.blocked_on ?? null;
  const run = (command: string, why = step.message, phase: string = step.phase): NextAction => ({ kind: "run", phase, why, run: { command }, blocked_on });
  const readback = /^sl readback --targets (\S+)$/.exec(step.command);
  if (readback) {
    const refs = readback[1]!.split(",");
    const declined = refs.filter((ref) => answered(d.replies, ref, d.targets.get(ref)?.hash ?? null) && latestReply(d.replies, ref)!.verdict !== "yes");
    const rest = refs.filter((r) => !declined.includes(r));
    const last = declined.length ? latestReply(d.replies, declined[0]!)! : undefined;
    const note = last
      ? ` The owner answered no or change to ${declined.join(", ")} as it now stands: make the change they asked for with ${EDITS} before reading it back again.` +
        (declined[0] === "access" || declined[0]!.startsWith("golden:")
          ? ""
          : ` If the change is only to who sees it, the item itself is not held: record it with sl reply --readback ${last.readback_id} --item ${last.item} --text "<owner's words>" ${ABOUT_ACCESS} --by "<owner>", ` +
            "then ask whether the rest of the item is right and record that answer the same way, with --verdict yes|no|change.")
      : "";
    return rest.length ? run(`sl readback --targets ${rest.join(",")}`, step.message + note) : run(`sl set ${declined[0]} <key> <value>`, step.message + note);
  }
  if (step.command.endsWith(" --emit-sql")) {
    const base = step.command.slice(0, -" --emit-sql".length);
    const plan = storedPlans(root).find((p) => p.complete && p.finish === `${base} --plan ${p.plan_id}`);
    if (plan) return run(plan.finish, `Every query of plan ${plan.plan_id} has its result stored. Finish the step from them: ${step.message}`);
  }
  if (step.phase !== "done") return run(step.command);
  // A golden's hash as it stands comes from rows only a run gives, so any verdict to it while its file exists counts.
  const refs = st.approved_without_yes.filter((ref) => !answered(d.replies, ref, hashNow(root, d, ref, latestReply(d.replies, ref)?.content_hash ?? "")));
  if (refs.length) {
    const items = refs.filter((r) => !r.startsWith("golden:"));
    const batch = items.length ? items.slice(0, BACKFILL_BATCH) : refs.slice(0, 1);
    const golden = items.length ? undefined : batch[0]!.slice(7);
    const planned = golden !== undefined && !goldenRunnable(root, golden);
    return run(
      `sl readback --targets ${batch.join(",")}${planned ? " --plan <plan_id>" : ""}`,
      `Every phase is done, but ${refs.length} approved item(s) have no recorded owner yes that matches them as they stand (approved before sl approve required one). ` +
        "They stay approved: read them back so the owner's answer is in the ledger, and revoke any the owner no longer confirms." +
        (planned ? ` sl cannot run golden:${golden}'s SQL: write its plan with sl goldens run --name ${golden} --emit-sql, store the rows with sl results add, then read it back with that plan.` : ""),
    );
  }
  return { kind: "done", phase: "done", why: step.message, blocked_on };
}

// The one action the skill takes next: approve what the owner said yes to, ask the owner what a
// pending readback holds, dispatch a plan that waits on results, else sl status's next step.
// record_reply is not returned yet: an answer the owner gave in chat is the agent's to record.
export function nextAction(root: string): NextAction {
  const d = statusDetail(root);
  const first = approvalReady(root, d) ?? askOwner(root, d) ?? dispatchRunner(root, d);
  return withAccessChanges(d, first ?? fromStatus(root, d), !first);
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
    `Make each with an access command (${ACCESS_EDITS}), then read access.yaml back with sl readback --targets access: the owner's yes to it settles them.`;
  const access_changes = changes.map((r) => ({ id: r.id, target: r.target, text: r.text, by: r.by }));
  if (reopen)
    return { kind: "run", phase: "access", why: `access.yaml is approved, and an edit makes it a draft again until the owner approves it. ${asked}`, run: { command: "sl access" }, blocked_on: action.blocked_on, access_changes };
  return { ...action, why: `${action.why} ${asked}`, access_changes };
}

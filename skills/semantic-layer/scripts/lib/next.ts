// The one next action of the skill (sl next): sl status's next step, read together with the answer
// ledger, the pending readbacks and the stored query plans. It reads files only and writes nothing.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Env, resolveConnection } from "./env-file.ts";
import { intakeMode } from "./intake.ts";
import { latestReply, openAccessChanges } from "./ledger.ts";
import { plainText } from "./output.ts";
import { PLAN_ID_PATTERN, planStatus, loadStoredPlan } from "./plan.ts";
import { loadSource, paths } from "./project.ts";
import { PENDING_DIR } from "./readback.ts";
import { act, actionText, flagValue, liveRunnable, type ProjectStatus, type StatusDetail, type StepAction, statusDetail } from "./status.ts";
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

// The action as data: the sl command, its arguments and the kind. run.command is it printed.
export interface NextStepAction {
  command: string;
  args: string[];
  kind: NextKind;
}

export interface NextAction {
  kind: NextKind;
  phase: string;
  why: string;
  action: NextStepAction;
  run?: { command: string };
  // A pending readback's open items (readback_id set), or, without readback_id, what to ask the owner
  // (text, with items empty) before running action, whose <placeholders> stand for their answer.
  ask_owner?: { readback_id?: string; text: string; items: { n: number; target: string; kind: ReadbackItem["kind"] }[] };
  dispatch?: { role: "connector_runner"; task: ConnectorTask };
  // What the action waits on: open_questions while open questions in access.yaml or a model wait on
  // the owner, whatever the action, which can be taken meanwhile; "connection: <variables> in <env file>"
  // while a variable the action's connection needs is set nowhere; else null.
  blocked_on: string | null;
  // With a connection block: the source, the variables nothing sets, the env file to add them to
  // and the line or lines to add, with <placeholders> for the values.
  connection?: { source: string; variables: string[]; add_to: string; line_to_add: string };
  // On an action of the access phase: the owner's changes to who sees an item, recorded on that
  // item's readback (sl reply --about access) and not yet settled by a yes to access.yaml.
  access_changes?: { id: string; target: string; text: string; by: string }[];
}

// A NextAction for an action: run carries the printed command, ask_owner what to ask (`ask`, else why).
function fromAction(a: StepAction | NextStepAction, phase: string, why: string, blocked_on: string | null, ask?: string): NextAction {
  const action: NextStepAction = { command: a.command, args: a.args, kind: a.kind };
  if (a.kind === "run") return { kind: "run", phase, why, action, run: { command: actionText(action as StepAction) }, blocked_on };
  if (a.kind === "ask_owner") return { kind: "ask_owner", phase, why, action, ask_owner: { text: ask ?? why, items: [] }, blocked_on };
  return { kind: a.kind, phase, why, action, blocked_on };
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

// Whether sl can run a golden's SQL itself, as sl status reads it (a dialect sl runs, not an export,
// a connection named); otherwise its readback and confirm take --plan or --results.
function goldenRunnable(root: string, name: string): boolean {
  const source = goldenSource(root, name);
  return !source || liveRunnable(source);
}

// For a golden sl cannot run: `args` with --plan <id> of a stored plan of `sl goldens run --name <name>`
// that has every result; an action writing that plan when none is stored; undefined while one waits
// on results (the connector runner's dispatch comes first).
function withGoldenPlan(root: string, name: string, command: string, args: string[]): StepAction | undefined {
  const plans = storedPlans(root).filter((p) => p.finish === `sl goldens run --name ${name} --plan ${p.plan_id}`);
  const done = plans.find((p) => p.complete);
  if (done) return act(command, [...args, "--plan", done.plan_id]);
  return plans.length ? undefined : act("goldens", ["run", "--name", name, "--emit-sql"]);
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
  const blocked_on = d.status.next_step.blocked_on ?? null;
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
      const confirm = goldenRunnable(root, golden) ? act("goldens", ["confirm", "--name", golden]) : withGoldenPlan(root, golden, "goldens", ["confirm", "--name", golden]);
      if (!confirm) continue;
      const write = confirm.command === "goldens" && confirm.args[0] === "run";
      return fromAction(
        confirm,
        targetPhase(d.status, target),
        `The owner said yes to golden:${golden} as read back (${r.id} in the ledger) and it is not confirmed with those rows yet. ` +
          (write
            ? `sl cannot run its SQL and no plan of its rows has every result: write one with the command below, store the rows with sl results add, then run sl next again.`
            : "Confirm it, passing the same --results or --plan the readback used; confirm refuses if the rows changed since."),
        blocked_on,
      );
    }
    if (!t || t.hash !== r.content_hash || t.state === "current" || t.state === "unhashed") continue;
    return fromAction(
      act("approve", ["--target", target]),
      targetPhase(d.status, target),
      `The owner said yes to ${target} as it now stands (${r.id} in the ledger) and it is not approved yet. Approve it; approved_by and approved_at come from that reply.`,
      blocked_on,
    );
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
  for (const p of pendingReadbacks(root)) {
    const current = p.items.filter((i) => hashNow(root, d, i.target, i.content_hash) === i.content_hash);
    const open = current.filter((i) => !answered(d.replies, i.target, i.content_hash));
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
        `Read each to the owner as written, ending with "Approve?", then record each answer in their words with ${REPLY(p.readback_id)}. ` +
        `A change only to who sees an item is recorded with ${ABOUT_ACCESS} and never holds the item.${kept}${asked} ` +
        `A readback the owner will not answer is set aside with sl readback --discard ${p.readback_id}.`,
      action: { command: "reply", args: ["--readback", p.readback_id, "--item", "<n>", "--text", "<owner's words>", "--verdict", "yes|no|change", "--by", "<owner>"], kind: "ask_owner" },
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
    // The runner's own check of what the plan still needs.
    action: { command: "results", args: ["status", "--plan", plan.plan_id], kind: "dispatch" },
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
// stand leaves them out and quotes the owner's words; with none left it asks for the edit they want.
// An --emit-sql step whose plan has every result becomes the plan's finish command; done reads back
// approved items without a recorded yes first.
function fromStatus(root: string, d: StatusDetail): NextAction {
  const st = d.status;
  const step = st.next_step;
  const blocked_on = step.blocked_on ?? null;
  // A draft golden on a source sl cannot run is read back from its plan once every result is stored.
  const draft = step.phase === "verify" && step.action.command === "goldens" && step.action.args[0] === "run" ? flagValue(step.action, "--name") : undefined;
  const planned = draft !== undefined && step.action.args.includes("--emit-sql") ? withGoldenPlan(root, draft, "readback", ["--targets", `golden:${draft}`]) : undefined;
  if (planned?.command === "readback") {
    return fromAction(
      planned,
      step.phase,
      `Every query of plan ${flagValue(planned, "--plan")} has its result stored, so golden ${draft}'s rows are read back from it. ${step.message.replace(/ sl cannot run its source[^.]*\./, "")}`,
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
        : ` If the change is only to who sees it, the item itself is not held: record it with sl reply --readback ${first.r.readback_id} --item ${first.r.item} --text "<owner's words>" ${ABOUT_ACCESS} --by "<owner>", ` +
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
  if (step.phase !== "done") return fromAction(step.action, step.phase, step.message, blocked_on);
  // A golden's hash as it stands comes from rows only a run gives, so any verdict to it while its file exists counts.
  const refs = st.approved_without_yes.filter((ref) => !answered(d.replies, ref, hashNow(root, d, ref, latestReply(d.replies, ref)?.content_hash ?? "")));
  if (refs.length) {
    const items = refs.filter((r) => !r.startsWith("golden:"));
    const batch = items.length ? items.slice(0, BACKFILL_BATCH) : refs.slice(0, 1);
    const golden = items.length ? undefined : batch[0]!.slice(7);
    const readback = act("readback", ["--targets", batch.join(",")]);
    // dispatchRunner comes before this, so a plan of the golden here has every result or there is none.
    const planned = golden !== undefined && !goldenRunnable(root, golden) ? withGoldenPlan(root, golden, "readback", readback.args) : undefined;
    return fromAction(
      planned ?? readback,
      "done",
      `Every phase is done, but ${refs.length} approved item(s) have no recorded owner yes that matches them as they stand (approved before sl approve required one). ` +
        "They stay approved: read them back so the owner's answer is in the ledger, and revoke any the owner no longer confirms." +
        (planned?.command === "goldens" ? ` sl cannot run golden:${golden}'s SQL: write its plan with the command below, store the rows with sl results add, then run sl next again.` : ""),
      blocked_on,
    );
  }
  return fromAction(step.action, "done", step.message, blocked_on);
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
// file instead (no value is read or printed here), and sl setup with the source's own arguments
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
    // A connection block sl cannot read (connection.env beside env_prefix): sl validate names it.
    return fromAction(act("validate", []), a.phase, `The next step (${actionText(a.action as StepAction)}) connects to source "${name}", whose connection block cannot be read. sl validate names what to fix.`, a.blocked_on);
  }
  if (res.status !== "unset") return undefined;
  const how = source.connection?.env ? ["--env", source.connection.env] : ["--env-prefix", source.connection?.env_prefix ?? ""];
  const blocked = `connection: ${res.variables.join(", ")} in ${res.add_to}`;
  return {
    ...fromAction(
      act("setup", ["--source", name, "--dialect", source.dialect, ...how], "ask_owner"),
      a.phase,
      `The next step (${actionText(a.action as StepAction)}) connects to source "${name}", and ${res.message.replace(/^Source "[^"]*": /, "").replace(/, then run the same command again:\n/, ":\n")}\n` +
        `Once the owner has added it, check the connection with the command below, then run sl next again. Never read or print the env file.`,
      blocked,
      `Please add ${res.variables.length > 1 ? "these lines" : "this line"} to ${res.add_to}, with the real values in place of each <...> (the values stay out of the chat):\n${res.line_to_add}`,
    ),
    connection: { source: name, variables: res.variables, add_to: res.add_to, line_to_add: res.line_to_add },
  };
}

// The one action the skill takes next: approve what the owner said yes to, ask the owner what a
// pending readback holds, dispatch a plan that waits on results, else sl status's next step. A
// ledger sl approve would refuse comes first, and a step whose connection is not set waits on it.
// record_reply is not returned yet: an answer the owner gave in chat is the agent's to record.
export function nextAction(root: string, env: Env = {}): NextAction {
  const d = statusDetail(root);
  if (d.ledger_problem !== null) return fromAction(act("validate", []), d.status.next_step.phase, d.ledger_problem, d.status.next_step.blocked_on ?? null);
  const first = approvalReady(root, d) ?? askOwner(root, d) ?? dispatchRunner(root, d);
  const action = withAccessChanges(d, first ?? fromStatus(root, d), !first);
  return connectionBlock(root, env, action) ?? action;
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
    return { ...fromAction(act("access", []), "access", `access.yaml is approved, and an edit makes it a draft again until the owner approves it. ${asked}`, action.blocked_on), access_changes };
  return { ...action, why: `${action.why} ${asked}`, ...(action.ask_owner && !action.ask_owner.readback_id ? { ask_owner: { ...action.ask_owner, text: `${action.ask_owner.text} ${asked}` } } : {}), access_changes };
}

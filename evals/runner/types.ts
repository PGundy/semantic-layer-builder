import type { GradingSpec } from "../graders/types.ts";
import type { RoleName } from "../../skills/semantic-layer/scripts/lib/roles.ts";

// The eval harness's data: scenarios, the driver contract, transcript turns and run summaries.
// The JSON Schemas under skills/semantic-layer/schemas/eval-*.schema.json encode the same shapes,
// and skills/semantic-layer/references/spec.md (Eval runs) documents them.

export interface Budgets {
  // Transcript turns, the owner's opening included, after which the run stops.
  max_turns: number;
  // Tokens across every turn, role agents' included; the run stops on the turn that goes past it.
  max_tokens: number;
}

// How the working semantic root starts. A connection intake starts with the project and one
// source already written, as a setup engineer leaves it; the skill agent carries on from there.
export interface ConnectionIntake {
  path: "connection";
  source: string;
  dialect: "duckdb";
  // View name -> relation. `{fixture}` is replaced by the fixture directory, relative to the root.
  views?: Record<string, string>;
  // A DuckDB SQL script, relative to the repository's fixtures/ directory, that the runner runs
  // into a new database, <run dir>/<source>.duckdb, beside the root; the source reads it with
  // --database. `{fixture}` in the script stands for the scenario's fixture directory (absolute).
  database?: string;
}

// An export intake starts the working root with the project only and, at shared/<source>-schema.csv,
// the schema export the owner shares when a connection is not possible: the fixture's views read
// with sl export-sql's catalog query. The skill imports it (sl setup --export) only after asking
// for a connection. export_upgrade starts the same way; later the owner gives the connection and
// the script upgrades the source to the same views, written in its sl arguments with {fixture}.
export interface ExportIntake {
  path: "export" | "export_upgrade";
  source: string;
  dialect: "duckdb";
  views: Record<string, string>;
}

export type Intake = ConnectionIntake | ExportIntake;

export interface Scenario {
  name: string;
  description?: string;
  fixture: string;
  intake: Intake;
  // Appended to the owner's brief: what this scenario changes about the owner's situation.
  brief_note?: string;
  persona: string;
  // "multi": the interviewer dispatches tasks to the role agents of lib/roles.ts; "single" (the
  // default): one skill agent does everything.
  agents?: "single" | "multi";
  budgets: Budgets;
  // The owner's first message, turn 1 of every transcript.
  opening: string;
  // Canned turns for the scripted driver, relative to the scenario file.
  script?: string;
  // What the graders compare the run with (evals/graders/).
  grading?: GradingSpec;
}

// The role agents an interviewer dispatches tasks to in a multi-agent run.
export type AgentRole = Exclude<RoleName, "interviewer">;
export const AGENT_ROLES: readonly AgentRole[] = ["connector_runner", "batch_analyst", "readback_verifier", "golden_builder"];
// skill is the interviewer, the one agent that talks to the owner.
export type Speaker = "skill" | "owner" | AgentRole;
export type StopReason = "done" | "turn_budget" | "token_budget" | "error";

// One sl command a skill turn ran, as written, without --root.
export interface CommandRun {
  command: string;
  exit_code: number;
  // Why the role guard (lib/roles.ts) refused the command; a refused command did not run.
  refused?: string;
}

// The task a role agent did inside an interviewer turn, recorded as its own transcript turn.
export interface RoleTurn {
  agent: AgentRole;
  text: string;
  tokens: number;
  commands?: CommandRun[];
}

export interface TranscriptTurn {
  turn: number;
  speaker: Speaker;
  text: string;
  tokens: number;
  timestamp: string;
  commands?: CommandRun[];
}

// Everything a skill turn starts from, and nothing else: a fresh context per owner turn.
export interface SkillTurnInput {
  // The per-run working copy of the semantic root; the agent works in it and may run sl status.
  root: string;
  // Every file under root, by path relative to it (forward slashes), as it stands now.
  files: Record<string, string>;
  // The owner's latest message.
  owner_message: string;
}

export interface SkillTurnOutput {
  text: string;
  tokens: number;
  // The skill agent says the session is over.
  done?: boolean;
  commands?: CommandRun[];
  // The tasks the interviewer dispatched in this turn, in order (multi-agent runs).
  dispatches?: RoleTurn[];
}

// The simulated owner answers from a private brief and a persona; like a person, it remembers
// the conversation.
export interface OwnerTurnInput {
  brief: string;
  persona: string;
  persona_prompt: string;
  skill_message: string;
  history: { speaker: Speaker; text: string }[];
}

export interface OwnerTurnOutput {
  text: string;
  tokens: number;
}

export interface Driver {
  skillTurn(input: SkillTurnInput): Promise<SkillTurnOutput>;
  ownerTurn(input: OwnerTurnInput): Promise<OwnerTurnOutput>;
}

export interface Summary {
  run_id: string;
  scenario: string;
  fixture: string;
  intake: string;
  persona: string;
  driver: string;
  budgets: Budgets;
  turns: number;
  skill_turns: number;
  owner_turns: number;
  tokens: number;
  tokens_by_speaker: { skill: number; owner: number };
  // Multi-agent runs only: "multi", the role agents' turns, the tokens of each role (the interviewer's
  // are the skill turns') and the interviewer's share of the agents' tokens, owner left out.
  agents?: "multi";
  role_turns?: number;
  tokens_by_role?: Record<RoleName, number>;
  interviewer_token_share?: number | null;
  stop_reason: StopReason;
  error?: string;
  started_at: string;
  finished_at: string;
}

// The clock every timestamp and the run id come from; tests inject a fixed one.
export type Clock = () => Date;

// An error meant for the person running the harness: printed without a stack trace.
export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalError";
  }
}

// The eval harness's data: scenarios, the driver contract, transcript turns and run summaries.
// The JSON Schemas under skills/semantic-layer/schemas/eval-*.schema.json encode the same shapes,
// and skills/semantic-layer/references/spec.md (Eval runs) documents them.

export interface Budgets {
  // Transcript turns, the owner's opening included, after which the run stops.
  max_turns: number;
  // Tokens across both speakers; the run stops on the turn that goes past it.
  max_tokens: number;
}

// How the working semantic root starts. A connection intake starts with the project and one
// source already written, as a setup engineer leaves it; the skill agent carries on from there.
export interface ConnectionIntake {
  path: "connection";
  source: string;
  dialect: "duckdb";
  // View name -> relation. `{fixture}` is replaced by the fixture directory, relative to the root.
  views: Record<string, string>;
}

export interface Scenario {
  name: string;
  description?: string;
  fixture: string;
  intake: ConnectionIntake;
  persona: string;
  budgets: Budgets;
  // The owner's first message, turn 1 of every transcript.
  opening: string;
  // Canned turns for the scripted driver, relative to the scenario file.
  script?: string;
}

export type Speaker = "skill" | "owner";
export type StopReason = "done" | "turn_budget" | "token_budget" | "error";

// One sl command a skill turn ran, as written, without --root.
export interface CommandRun {
  command: string;
  exit_code: number;
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

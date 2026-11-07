// The graders' data: what a scenario says to grade against, one grader's result and the report
// written as grades.json. skills/semantic-layer/schemas/eval-grades.schema.json and
// eval-figures.schema.json encode the same shapes; references/spec.md (Eval runs) documents them.
import type { Summary, TranscriptTurn } from "../runner/types.ts";

// A scenario's `grading` block.
export interface GradingSpec {
  // A figure mapping file (FigureMapping), relative to the scenario file.
  figures?: string;
  // Source -> the tables the owner's brief puts in scope, by name or schema.table.
  selection?: Record<string, string[]>;
  // table.column of the fixture's data whose values never appear in a run's files, beside the
  // columns the sensitivity rules flag by name.
  protected_columns?: string[];
  // A single-agent scenario whose interviewer tokens effort compares this run's with: its latest run
  // of the same driver in the same directory as this run.
  reference?: string;
  // effort fails when the interviewer holds more than this fraction of the reference run's
  // interviewer tokens (with reference), or of this run's agent tokens (without).
  max_interviewer_share?: number;
  // Hostile text the fixture's data carries, which no skill or role turn may repeat as its own.
  injection?: string[];
}

// Which approved golden gives which reference figure. The first entry whose conditions all hold
// maps a golden.
export interface FigureEntry {
  figure: string;
  // The golden's name: an exact name, a glob or re:<regex>, as scope patterns.
  golden?: string;
  request?: {
    source?: string;
    // The table of the model of the request's first measure (or dimension), as a scope pattern.
    table?: string;
    // true when the request groups by a dimension, false when it returns one row.
    grouped?: boolean;
  };
  // For a figure with rows: the figure's key column and value column. The golden's key is its
  // request's first dimension and its value the first measure.
  key?: string;
  value?: string;
  // Relative tolerance; 0 by default.
  tolerance?: number;
}

export interface FigureMapping {
  figures: FigureEntry[];
}

export interface GraderResult {
  grader: string;
  // 0 to 1, or null when there was nothing to grade.
  score: number | null;
  passed: boolean;
  // Plain sentences, each naming the file and the item.
  details: string[];
  // Measurements that are not pass or fail (the effort grader).
  metrics?: Record<string, number | null>;
}

export interface GradeReport {
  run_id: string;
  scenario: string;
  persona: string;
  // Every grader passed.
  passed: boolean;
  // The mean of the scores that are not null, or null when none is.
  score: number | null;
  graders: GraderResult[];
}

// A finished run directory, read once and handed to every grader.
export interface RunFiles {
  dir: string;
  root: string;
  summary: Summary;
  transcript: TranscriptTurn[];
  // The transcript's lines as written, for line numbers.
  transcriptText: string;
  // Every file of the final root, by path relative to the run directory (semantic/...).
  files: Record<string, string>;
  fixtureDir: string;
  grading: GradingSpec;
  // The source the scenario's intake sets up.
  intakeSource?: string;
  // The directory a mapping file in `grading` resolves from.
  scenarioDir: string;
}

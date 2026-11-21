import type { DocRule } from "./index.ts";

// The rules that keep semlayer next's guided flow reaching its end (the owner's none for now, the
// calendar keys in the interview's apply, a golden per role): one phrase per rule.
export const RULES: DocRule[] = [
  ["phases/metrics.md", "the owner's none for now is recorded in their words", 'semlayer add-metric --none --by "<owner>" --text "<the owner\'s words>"'],
  ["phases/metrics.md", "default_time_dimension goes in the interview's apply", "put `default_time_dimension` in the same `semlayer apply` as the model's other interview edits"],
  ["phases/verify.md", "each role needs a golden run as it, planned up front", "each role in `access.yaml` needs one golden that runs as that role"],
  ["spec.md", "no metrics for now closes the metrics phase", "While `metrics` lists no metric it closes the metrics phase"],
  ["spec.md", "a newer readback's recorded reply settles an older item", "Only such a recorded reply settles an item"],
];

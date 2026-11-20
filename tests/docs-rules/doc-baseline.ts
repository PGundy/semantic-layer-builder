import type { DocRule } from "./index.ts";

// The procedure rules references/baseline.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Schema exports and the baseline.
  ["baseline.md", "guesses never become facts", "Never write a guess from the brief into a model as fact, and never read a brief line back as something to approve"],
  ["baseline.md", "out stays under the root", "`--out` writes the markdown to a path resolved from the semantic root, never outside it"],
  ["baseline.md", "the left-out note is the scoping question", "that note is the scoping question (`phases/scope.md`)"],
  ["baseline.md", "relationships are checked, not taken", "the brief's relationship is never the evidence"],
  ["baseline.md", "likely keys need proof", "A likely key from names alone is a question, not a `primary_key`"],
  ["baseline.md", "candidate measures are a menu", "never a list to approve"],
  ["baseline.md", "shares become ratio metrics", "a `count` measure filtered on the flag over the row count"],
  ["baseline.md", "splits by name are guesses", "Without profiles they are guessed from names"],
  ["baseline.md", "joined attributes are reached through the join", "a dimension of the joined model, which a request reaches through the join"],
  ["baseline.md", "no sensitive values", "The brief names sensitive columns but never quotes their values"],
  ["baseline.md", "answers before a model exists", "Answers given before a table has a model go into its model as soon as `semlayer draft` writes it, in the same turn"],
  ["baseline.md", "disagreements are asked", "ask the owner rather than picking one silently"],
  ["baseline.md", "plain words for the brief's terms", "a fact table is \"a table of things that happen (orders, refunds)\""],
  // Connection first (docs/PRD.md FR-1.0).
  ["baseline.md", "focus before profiling", "Ignore the brief's closing `semlayer profile` and `semlayer draft` hint until then"],
  ["baseline.md", "the first message shares the item budget", "the baseline items share that budget with the items the first turn adds"],
  ["baseline.md", "fan-out warnings are guesses", "probably several lines per order, to be checked with `semlayer check-join`"],
  ["baseline.md", "example values before a profile", "Any values a question names before then are examples, not values found in the data"],
  // Time zones per type and dialect.
  ["baseline.md", "the stored zone is asked", "which zone its values are recorded in (`time_zone`)"],
  // Heuristics.
  ["baseline.md", "the left-out note's wording", "\"covers 12 of the 22 in-scope tables\""],
  ["baseline.md", "the top-N skips noise", "skipping the tables it classifies as noise"],
  ["baseline.md", "profiling after an import needs a connection", "After an import, `semlayer profile` needs a connection the snapshot did not come with"],
];

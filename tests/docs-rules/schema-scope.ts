import type { DocRule } from "./index.ts";

// The schema-scope rules the docs keep (workstream G): one phrase per rule.
export const RULES: DocRule[] = [
  ["spec.md", "the primary schema is never guessed", "With more than one candidate there is none, and the tools never guess one"],
  ["spec.md", "a name never joins across schemas in draft", "a column joins by its name (`<x>_id`, or the name of a single-column key) only to a table in the same schema"],
  ["spec.md", "a cross-schema foreign key is a question, not a join", "a declared foreign key into another schema drafts no join and adds one open question"],
  ["spec.md", "snapshots keep the constraint name", "A snapshot's foreign key keeps its constraint name"],
  ["spec.md", "the cross-schema question names add-cross-schema and --decline", "names `semlayer add-cross-schema` with the key for a yes and with `--decline` for a no"],
  ["spec.md", "a pair runs from the foreign key's schema", "Each runs from the schema holding the foreign key (`from`) to the schema it references (`to`)"],
  ["spec.md", "a join crosses only on an approved pair's keys", "is allowed only when the pair is approved and lists every key of the join"],
  ["spec.md", "the grace ends at the next minor version", "an error from then on"],
  ["spec.md", "the join commands and the compiler decide as validate does", "The join commands and the compiler decide by the same rule as validate"],
  ["spec.md", "add-join refuses a join across an undeclared pair", "`semlayer add-join` refuses a join across schemas no approved pair declares"],
  ["spec.md", "an approved pair drafts its listed keys only", "on those keys only, whether or not a foreign key carries them"],
  ["spec.md", "a pair is approved on the owner's yes with its target", "`semlayer approve --target schema-pair:<s>:<from>:<to>` writes `status: approved`, `approved_by`, `approved_at` and `approved_hash`"],
  ["spec.md", "a pair counts as approved only while its hash matches", "A pair counts as approved only when its `approved_hash` matches the hash of its `from`, `to` and `keys` as they now stand"],
  ["spec.md", "the edit hook guards a pair's approval fields", "or the schema pairs of `sources/<s>.yaml`: only `semlayer approve` and `semlayer goldens confirm` write them"],
  ["spec.md", "the schema question asks before draft on more than one schema", "While it is open, `semlayer status` holds the `scope` phase at it"],
  ["spec.md", "the schema question's words", "Your data sits in more than one schema (A, B). Is A enough for your questions?"],
  ["spec.md", "the answers carry their commands", "`ask_owner.options`, `[{ answer, commands }]`"],
  ["spec.md", "draft refuses until a primary is set", "`semlayer draft` refuses with `scope.primary_unset`"],
  ["spec.md", "draft keeps to the primary schema by default", "draft without `--tables` drafts only the primary schema's tables"],
  ["phases/intake.md", "intake names the schema question", "**Which schema?** A first layer reads one schema, the primary"],
  ["phases/scope.md", "the scope card reads the question and runs the chosen answer", "Read `ask_owner.text` to the owner as written, then run the commands of the answer they give from `ask_owner.options`"],
  ["phases/scope.md", "a pair is approved only on the owner's yes", "approves it only on their yes"],
  ["phases/draft.md", "draft keeps to the primary schema", "draft drafts by default only the primary schema's tables"],
];

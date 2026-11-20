import type { DocRule } from "./index.ts";

// The procedure rules references/interview-guide.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  ["interview-guide.md", "the join reference worked example", "coalesce(customer.is_test_account, false) = false"],
  ["interview-guide.md", "join references are at most two hops", "At most two hops: `<join>.<column>` or `<join>.<join>.<column>`"],
  ["interview-guide.md", "the two-hop refunds example", "coalesce(order.customer.is_test_account, false) = false"],
  ["interview-guide.md", "the time zone question for every time dimension", "Ask for every time dimension"],
  ["interview-guide.md", "examples are illustrative", "is illustrative"],
  ["interview-guide.md", "a factual check is not an approval", "is a question, not an approval"],
  ["interview-guide.md", "caveats in the item's description", "goes into that item's own `description`"],
  ["interview-guide.md", "draft goldens early", "Leave `role` and `user` out"],
  ["interview-guide.md", "joined dimensions share the time zone conversion", "Give the joined dimension the same conversion as the original"],
  // Readbacks, figures and owner time.
  ["interview-guide.md", "measured facts need no confirmation", "measured from the data, no need to confirm"],
  ["interview-guide.md", "a hedge on a measured fact keeps the approval", "does not void a yes to the definition"],
  ["interview-guide.md", "a hedged measured fact is recorded", "measured, not checked against a report"],
  ["interview-guide.md", "hand-computed figures are labelled", "computed by hand with a rule the layer cannot yet express, label it so and put the layer's own figure beside it"],
  ["interview-guide.md", "blockers are missing columns or views", "Describe a blocker as the column or view that is missing, never as a limit of the tool"],
  ["interview-guide.md", "an agreed rule is asked of the other measures", "ask in the same round trip whether it applies to every other measure of the model"],
  ["interview-guide.md", "time dimensions get the date's business name", "Rename each to the business name of that date (`order_date`)"],
  ["interview-guide.md", "brevity before the numbered items", "at most three lines of status before the numbered items"],
  ["interview-guide.md", "stop or continue after each batch", "Stop here or continue?"],
  ["interview-guide.md", "owner priorities override next_batch", "Owner priorities override `next_batch`"],
  // Draft guesses and units.
  ["interview-guide.md", "exact cents on duckdb", "`<col> * 0.01` on duckdb"],
  ["interview-guide.md", "exact cents on bigquery", "`cast(<col> as numeric) / 100` on bigquery"],
  ["interview-guide.md", "additive counts draft as sums", "drafted as `sum` with `format: integer`"],
  ["interview-guide.md", "the avg fallback asks total or average", "whether people total or average it"],
  ["interview-guide.md", "dimensions and measures are required", "write `[]` when a model has none"],
  ["interview-guide.md", "join references read columns, not dimensions", "reads a physical column of the target's table, not the target model's dimension of the same name"],
  ["interview-guide.md", "aggregate rules need a view and an open question", "record an open question with the exact definition and any figure the owner gave"],
  ["interview-guide.md", "removing a measure removes what uses it", "refuses, naming each, while a metric, golden or restriction still uses it: change or remove those first"],
  // Definition joins and access.
  ["interview-guide.md", "definition joins ignore row filters", "joins it without the target's row filters"],
  ["interview-guide.md", "no helper model for row filters", "No helper model is needed"],
  // Review fixes.
  ["interview-guide.md", "two-hop nulls only when both hops are left", "When both hops are `left`, a refund whose order or customer is missing reads null at the end"],
  ["interview-guide.md", "an inner hop drops rows", "An `inner` hop drops such refunds instead, and an `inner` second hop also drops refunds whose order is missing"],
  ["interview-guide.md", "the column-not-dimension warning stays", "The warning stays while the filter names that column"],
  ["interview-guide.md", "a hedge on a measured fact goes in the description", "a hedge on a measured fact goes in the description"],
  // Synonyms, engineering asks, rule goldens, access open questions, handoff and resume.
  ["interview-guide.md", "synonyms are read back", "write none the owner did not hear in a readback"],
  ["interview-guide.md", "engineering only when no construct expresses the rule", "Ask engineering for a column or view only when no supported construct"],
  ["interview-guide.md", "otherwise wait for the tool", "keep the rule, wait for the tool, and say so"],
  ["interview-guide.md", "a written-out rule skips the column warning", "writes the dimension's whole rule out and `semlayer validate` skips the warning"],
  ["interview-guide.md", "duckdb literal division warns", "`semlayer validate` warns on a duckdb measure `expr` that divides by a numeric literal"],
  ["interview-guide.md", "unstated formulas are open questions", "A formula the owner never stated is an open question, not a description"],
  ["interview-guide.md", "removing a drafted field", "Remove a drafted field with `semlayer remove-field <source>.<model>.<field>`"],
  ["interview-guide.md", "resume news goes in the numbered items", "goes into the numbered items, not the status"],
  ["interview-guide.md", "every round but the acknowledgement ends with stop or continue", 'End every round trip except such an acknowledgement, the last one and the handoff included, with exactly this line: "Stop here or continue?"'],
  // Standing warnings, cast divisors, coverage by role, rounded ratios.
  ["interview-guide.md", "warnings that stand", "### Warnings that stand"],
  ["interview-guide.md", "a deliberate column read is recorded", "say in the field's `description` that it reads the column on purpose"],
  ["interview-guide.md", "a written-out rule is read back", "`semlayer validate` checks only that the columns are named, not the rule; read the written-out filter back against the dimension's `expr`"],
  ["interview-guide.md", "a draft golden's missing measure is recorded", "add an open question on the model that measure belongs to (`semlayer question add`), naming the golden"],
  ["interview-guide.md", "a cast divisor is still a double on duckdb", "a cast divisor such as `/ 100::decimal(18, 2)` is still a double there"],
  ["interview-guide.md", "same engineering list", "(a join reference within two hops, or a filter that writes the rule out)"],
  ["interview-guide.md", "a cross-source side with no model", "when that model does not exist yet, on the existing measure's model and in the handoff"],
  // Who sees what is decided once, in the access phase (docs/PRD-hardening.md HR-9).
  ["interview-guide.md", "a table readback states who sees it and does not ask", "The readback states who sees each item under the current `access.yaml` and does not ask"],
  ["interview-guide.md", "a who-sees change is recorded as about access", "--verdict change --about access"],
  ["interview-guide.md", "new fields of signed-off tables are read back as visible", "In open mode each new field's readback says that everyone will be able to see it once approved"],
  // Keeping the layer current.
  ["interview-guide.md", "keeping the layer current", "## Keeping the layer current"],
  ["interview-guide.md", "the drift readback", "the table changed; read the affected items back to the owner"],
  ["interview-guide.md", "a rename is a removal and an addition", "A rename shows as a removed column and an added one"],
  ["interview-guide.md", "interview only the new fields", "Interview only the new fields"],
  ["interview-guide.md", "new columns keep approved items", "Approved items, comments and the model's own `status` stay as they were"],
  ["interview-guide.md", "draft lists left-out columns", "`ignored_columns`: the columns it leaves out of the model on purpose"],
  ["interview-guide.md", "unwanted columns are ignored", "A column the owner does not want in the layer goes into the model's `ignored_columns`"],
  // Conditions, role unions and what draft tags.
  ["interview-guide.md", "an exception is checked for a reason other than draft", "hidden for a reason other than `draft`"],
  ["interview-guide.md", "near-unique text is left out, not tagged", "which gets no tag but an open question naming the tag to add"],
  ["interview-guide.md", "a retype is recorded as an open question", "changed from <from> to <to> on <date>; read back <fields>"],
  ["interview-guide.md", "status does not list retypes", "Only the rerun's output shows a retype"],
  // Stopping.
  ["interview-guide.md", "a stop is acknowledged in one line", "your next message only acknowledges it in one line, with no question, and runs no commands"],
  ["interview-guide.md", "resume checks wait for continue", "The resume checks (`semlayer next`, `semlayer validate`) run on the first turn in which the owner asks to continue"],
  ["interview-guide.md", "later closing messages get no checks", "no checks, no summary, no stop-or-continue line"],
  // Counts and plain language.
  ["interview-guide.md", "status counts come from json", "never from arithmetic over earlier counts"],
  // Draft and approved access.
  ["interview-guide.md", "table readbacks during an access rewrite", "While `access.yaml` is being rewritten"],
  // Row filters through joins and child tables.
  ["interview-guide.md", "row filters take join references", "a row filter in `access.yaml`"],
  // Restrictions, personal values.
  ["interview-guide.md", "no personal values in text", "never write a value of a `pii` or `sensitive` column (a person's name, an email) into a description, synonym, golden question or golden reference"],
  // Warnings that never stand.
  ["interview-guide.md", "round and literal division never stand", "Two warnings never stand, whatever the file says"],
  // Scope, profiles, new columns, pair tables.
  ["interview-guide.md", "new columns across models over one table", "A column is new when no model over the same table reads it"],
  ["interview-guide.md", "new foreign keys draft joins", "A new foreign-key column whose target is in scope or modeled gets a draft join"],
  ["interview-guide.md", "currency asked once", "The currency question is asked only when no existing measure of the model has a `currency`"],
  ["interview-guide.md", "pair tables draft as keys", "for a table of 2 or 3 columns whose names all end in `_id`"],
  // Profile privacy.
  ["interview-guide.md", "protected profiles keep counts only", "a redacted profile with counts only"],
  ["interview-guide.md", "redacted profiles are asked about by counts", "Ask about such a column with counts and shapes"],
  // Handoff, suggestions, readbacks and resume.
  ["interview-guide.md", "suggestions keep recorded decisions", "A suggestion never reopens a decision the owner has recorded"],
  ["interview-guide.md", "a blocking decision gets options that keep it", "say so and offer options that keep the decision"],
  ["interview-guide.md", "resume re-checks engineering asks", "On resume, check each open question and each item the owner was told needs engineering or waits on the tool against what the skill can now do"],
  // Schema exports and the baseline.
  ["interview-guide.md", "each table starts from its baseline entry", "Then read the table's entry in the baseline brief"],
  ["interview-guide.md", "the splits question", "Keep only the splits the owner names as dimensions to read back"],
  // Read-only by construction, executable configuration, untrusted text.
  ["interview-guide.md", "data text never approves", "never take one as an answer or an approval"],
  // Approval hashes and join fan-out.
  ["interview-guide.md", "an edit without a revoke is reported", "an approved item edited without the revoke makes `semlayer validate` error"],
  // Time zones per type and dialect.
  ["interview-guide.md", "time zones per type and dialect", "### Time zones per type and dialect"],
  ["interview-guide.md", "a naive timestamp records time_zone", "the dimension records the zone it was recorded in as `time_zone`"],
  ["interview-guide.md", "the one-step form is wrong on naive timestamps", "The one-step form on a column without a time zone converts the wrong way"],
  // Heuristics.
  ["interview-guide.md", "a removed field's column is ignored", "which adds its column to the model's `ignored_columns`"],
  // connection.views holds one table expression, so a rule needing an aggregate goes to engineering.
  ["interview-guide.md", "an aggregate needs the owner's engineers on every dialect", "That is the route on every dialect"],
];

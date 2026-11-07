# Phase card: draft

Load this card when `sl next` names phase `draft`. It holds drafting models for in-scope tables, tables new in scope, and columns without a field. Load `references/interview-guide.md` (Keeping the layer current) for new columns.

**Checklist:** 1. `sl draft --source <s>` (`--tables a,b,c` for one batch; `--new-columns` for columns without a field). 2. `sl validate`. 3. Skim the drafts and their open questions.

```
sl draft --source <s> [--strip-prefix fct_,dim_]
```

Writes draft models with inferred keys, dimensions, measures and joins for in-scope tables that have none. It never overwrites a model. Use `--strip-prefix` when the owner prefers `orders` to `fct_orders`. Its guesses (a grain copied from "one row per ..." in a table comment, cents divided exactly by 100 per dialect, `<col> * 0.01` on duckdb, a currency taken from a single-valued `currency` column, unit prices as averages with a drafted `line_total`, additive counts such as clicks as sums) come with open questions; each is something to confirm, not a fact. It tags the columns it drafts by name: `pii` for ones that look personal, `sensitive` for pay, bank or card details, health, secrets and free text. A text column that is not a key and differs on nearly every row is left out, not tagged, with an open question naming the tag to add if the owner wants it, and it lists the columns it leaves out on purpose in the model's `ignored_columns`, that one included. Rename each drafted time dimension to the business name of its date (`order_date`) with `sl rename <s>.<m>.<field> order_date`, the same in every model a metric combines. A time dimension over a timestamp without a time zone comes with an open question asking which zone its values are recorded in, answered as `time_zone: <IANA zone>`. Run `sl validate`, then skim the drafts so your questions are concrete.

## New tables and new columns

`sl status --json` routes changes the drift card (`phases/drift.md`) does not cover here:

1. **New tables in scope** (`new_in_scope`): tables that now match the selection, new ones or ones a scope change brought in, go through profile, `sl draft --source <s> --tables <them>` and the interview; exact names need another `sl scope ... --write`.
2. **Columns without a field** (`new_columns`): `sl profile --source <s> --tables <t> --refresh`, then `sl draft --source <s> --new-columns`, which appends draft fields to the existing models with the same tags and open questions as a new model, drafts a join (`origin` declared or inferred) for a new foreign-key column whose target is in scope or modeled, asks the currency question only when no existing measure of the model has a currency, and leaves approved items and the model's status as they are. A column is new only when no model over the same table reads it or lists it in `ignored_columns`, so a helper model over a modeled table raises nothing. Interview only the new fields; in open mode each readback says that everyone will be able to see the field once approved.
3. **Deliberate omissions**: a column the owner does not want goes into the model's `ignored_columns` and its drafted field is removed (`sl remove-field <s>.<m>.<field>` does both; `sl ignore-column --source <s> --model <m> --column <c> --reason "<why>"` for a column with no field), so `sl status` and `--new-columns` stop raising it.

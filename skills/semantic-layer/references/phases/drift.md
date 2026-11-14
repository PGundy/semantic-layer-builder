# Phase card: drift, keeping the layer current

Load this card when `sl next` names phase `drift`, when the owner says tables changed, or on a scheduled rerun. It holds rereading a source and settling what changed. Load `references/interview-guide.md` (Keeping the layer current) only when a change is not a missing, retyped or new column (a renamed table, a changed key).

**Checklist:** 1. `sl introspect --source <s>` (or `sl import` with a fresh export). 2. Tell the owner what changed. 3. Missing columns first, then retyped ones. 4. `sl validate`, `sl goldens check`.

Tables change: columns are added, dropped, renamed or retyped. Rerun `sl introspect --source <s>` (or `sl import` with a fresh export, from the same `sl export-sql` query) on a schedule the owner picks, such as weekly, and whenever the owner says tables changed. It prints the changes, tables added and removed and columns added, removed and retyped (`changes` in `--json`): tell the owner in plain words. Then `sl validate` and `sl status --json`:

1. **Missing columns first** (`missing_columns`; phase `drift` when an approved field reads one): read each affected approved item back with what changed ("`discount_cents` is gone from `fct_orders`, and revenue subtracts it"), ask what replaced it (a rename shows as a removed column and an added one), then revoke, edit, read back and approve again, and run `sl goldens check`.
2. **Retyped columns**: only the rerun's output shows them, so as soon as it does, before step 1's readbacks, write an open question on each model with a field that reads one (`sl question add <s>.<m> --text "<column> changed from <from> to <to> on <date>; read back <fields>"`), then read back each such field when its unit or meaning may have changed (cents to dollars, a number turned text) and delete the question after the readback (`sl question resolve`).
3. **New tables and columns without a field** go to the draft card (`phases/draft.md`), and a modeled table that left scope to the scope card (`phases/scope.md`).

On an export source drift from data waits on a connection: a fresh export shows tables and columns that changed, not what the data holds.

Then `sl validate`, `sl goldens check`, and the stop-or-continue line.

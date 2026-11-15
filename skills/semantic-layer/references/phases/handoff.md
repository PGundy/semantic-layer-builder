# Phase card: handoff

Load this card when `semlayer next` names phase `done`. It holds the last readbacks, the coverage checklist and the summary the owner keeps.

**Checklist:** 1. `semlayer validate`. 2. `semlayer status --json`. 3. Tick the coverage checklist below. 4. Send the summary below.

`semlayer validate`, `semlayer status --json`. `next_step` reaches `done` when the phases the CLI can measure are complete, even with draft metrics, goldens or fields the owner deferred, and its message names each; it does not tick the coverage checklist. With an export source it stops at `connect` instead, since profiles, join evidence, goldens and drift from data wait on a connection. While approved items have no recorded owner yes that matches them as they stand (approved before `semlayer approve` required one), `semlayer next` reads them back first (kind `run`, `semlayer readback --targets <refs>`) instead of `done`: they stay approved; record the owner's answer with `semlayer reply`, and revoke any the owner no longer confirms (`semlayer approve --target <ref> --revoke`). Tick the coverage checklist, then give the owner the short summary below, ending with the stop-or-continue line.

## Coverage checklist

- [ ] Every approved measure and metric is in at least one approved golden. A first build often has figures the owner has no number for: name each such measure and metric in the summary as not yet checked against a figure. That gap does not hold the handoff, and `semlayer status` does not track it.
- [ ] Every role in `access.yaml`, restricted or not, has an approved golden that runs as it (one with no `role` runs as `default_role`); `roles_without_goldens` in `semlayer status --json` lists the gaps.
- [ ] An approved golden crosses a join to a row-filtered model as the role with the filter; `row_filter_joins_without_goldens` lists the gaps, and the line is N/A, with the reason, when no join the role may use reaches that model.
- [ ] Every figure the owner gave has a golden, draft or approved.

## The summary

- **Approved**: models, measures, metrics, joins, access roles and goldens, by source, and the access mode with what is hidden from the default audience, named rather than counted (`semlayer access`). Name exceptions rather than counts: "every detail except `products.launched_on`", not "11 of 12 details".
- **Still draft**: deferred tables (now out of scope), every draft metric (`draft_metrics` in status), draft golden (`draft_goldens`) and draft field (`draft_fields`), and the draft fields a role or golden relies on, each with why (skipped, waiting on someone, deferred); a draft `access.yaml`, saying what applies until it is approved (the last approved version where one is deployed; otherwise tools reading it serve nothing). A draft measure known to give a wrong number is fixed or removed first; `semlayer remove-field` refuses while a draft metric or golden uses it, naming each, so change or remove those first.
- **Validate warnings**: every warning `semlayer validate` still prints, with the reason it stands. Write that reason into the file the warning points at, so a resumed session leaves it: the field's `description` ("reads the column on purpose", with `semlayer set`), or an `open_questions` entry on its model or in `access.yaml` (`semlayer question add`); for a draft golden naming a measure not written yet, an open question on the model that measure belongs to, naming the golden.
- **Verification gaps**: every unticked line of the coverage checklist, naming each role in `roles_without_goldens` and each entry of `row_filter_joins_without_goldens` from `semlayer status --json`, and each line that does not apply, named N/A with the reason.
- **Open questions**: every `open_questions` entry in the models and in `access.yaml`, and every cross-source question, with who could answer it. Resolve questions the owner has since answered (`semlayer question resolve`).
- **Waiting on a command**: each change the owner agreed that a typed command does not cover yet and the `semlayer-interviewer` role recorded as an open question (`SKILL.md`, Hand edits).
- **Cross-source metrics and engineering asks**: every cross-source metric's formula in words, with any figure the owner gave; each measure that waits on engineering (a missing column or view), tied to the metrics that need it.
- **How to continue**: "Ask me to continue the semantic layer"; the next batch from `semlayer status`; how to widen scope.

# Phase card: access

Load this card when `sl next` names phase `access`. It holds the access interview, `sl access` in the readback and the sign-off of `access.yaml`. Load `references/access.md` with it.

**Checklist:** 1. Ask the exceptions question; create `access.yaml` as a draft with `sl set access mode open` (or `closed` for an allowlist). 2. `sl access` for the default audience, then `sl access --roles <role> --user '<json>'` per role. 3. Read back each role, then the whole file. 4. `sl reply` with each answer; `sl approve --target access` on a recorded yes to the whole file.

While a draft `access.yaml` holds open questions, `next_step` is `{ phase: access, blocked_on: open_questions, command: sl access, after_owner_yes: false }`: the step waits on the owner's answers, its message names the first question, and you raise it and never push the approval.

## The interview

Access is open by default: with `mode: open`, or no `access.yaml`, everyone sees every approved model, field and metric except items tagged `pii` or `sensitive` (unless a role they hold lists the tag in `allow.tags`), the targets of `restrictions` and the denials of the roles they hold. Draft items are never exposed. `mode: closed` makes each role's `allow.models` an allowlist. Interview in this order:

1. The exceptions question, "is there anything some people should not see?".
2. Every `pii` and `sensitive` tag and who may see it.
3. Roles, held by an attribute (`assign_when: user.department == 'finance'`) or assigned by name, several per user, an item visible when any held role shows it.
4. The default role, which applies only to a user with no other role: ask it open, note that the most limited view is the safe default, and state the concrete consequence of the owner's choice.
5. Restrictions on metrics and fields, preferring a restriction's `allow.when` to a role made only to be named in `allow.roles`.
6. Row filters with `{{ user.<attribute> }}`, and a manager's span of control as a `hierarchy` filter over a closure model (ask for a view when the source has only `manager_id`). A row filter's `expr` and a hierarchy's `column` may read join references through the filtered model's own to-one joins (order lines filtered by `order.sales_rep_id`), joined without their targets' row filters. For each row-filtered model, list every model with a to-one join into it (lines, refunds, shipments) and settle each with the owner: a row filter of its own, a denial, or the reason in the role's `open_questions` (`sl validate` warns until then).

## Writing the file

Tools serve only an approved `access.yaml`: one that loads a draft serves nothing and says access is awaiting sign-off, so a change is edited as a draft in version control while the deployed approved version keeps applying; when you revoke to edit, tell the owner that the last approved version keeps applying where it is deployed until the new one is approved (the revoke keeps its sign-off as `last_approved`, and `sl access` names it). Write `access.yaml` as a draft, with `open_questions` for anything unsettled; with no exceptions it is `mode: open` with no roles, and it is still read back and approved. `sl set access mode open|closed` creates a draft file holding only the mode when there is none, and changes the mode of one that exists; `sl set access default_role <value>` and `sl question add access --text "<question>"` refuse until it exists. Its roles, restrictions and row filters are writes without a typed command (`SKILL.md`, Hand edits). `deny.fields` names dimensions and measures only; a join is hidden when its target model is hidden.

## What people see

Row filters of several held roles combine as a union, a held role with no filter on a model contributes every row, and in open mode a user with no role sees every row; say so. A row filter on a joined model limits only the joined rows on a left join; say so in the readback. A measure filter or dimension that reads through a join applies whatever the role may see and ignores row filters on its target; `sl validate` warns when a role may see a dimension that reads a model hidden from it, so show that model or deny the dimension. A dimension that reads a model the role row-filters shows every row's value and validate does not warn; deny it or read that back.

## The readback

Show the owner what people see with `sl access` (the default audience) and `sl access --roles <role> --user '<json>'` for each role, as part of the readback. When the readback changes the mode, state the old and new mode and who gains or loses visibility, naming the users who hold no role. Read every role back, then the whole file; they may share one message as separate "Approve?" items, the whole file last, and a no or correction to any of them voids the whole-file yes (read the whole file again after any change made after the per-role readbacks; a comment-only edit is not a change, and neither is deleting an answered open question or adding one, which you mention in the next message; writing its answer into roles, patterns, denials or row filters is a change), then record each answer with `sl reply`, and on a yes to the whole file run `sl approve --target access`.

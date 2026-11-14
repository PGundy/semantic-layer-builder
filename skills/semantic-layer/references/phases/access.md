# Phase card: access

Load this card when `sl next` names phase `access`. It holds the access interview, `sl access` in the readback and the sign-off of `access.yaml`. Load `references/access.md` only when access goes past this card: a span of control over a closure model, closed mode, the child tables of a row filter, "totals only", or a definition join.

**Checklist:** 1. Ask the exceptions question; create `access.yaml` as a draft with `sl set access mode open` (or `closed` for an allowlist). 2. Write each answer with its command (below). 3. `sl access`, default audience and per role. 4. `sl readback --targets access`, the whole file (no single role). 5. One `sl reply --readback <id> --answers -`, then `sl approve --readback <id>`.

Who sees what is decided once, here. A table, field or metric readback states who will see the item and does not ask, and a change the owner asked for there was recorded with `sl reply ... --verdict change --about access`, which did not hold that item. `sl next` lists those changes in this phase (`access_changes`, and in `why` with the owner's words): make each one with a command below, and the owner's yes to the whole-file readback settles them. When `access.yaml` is already approved, they reopen this phase.

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

Every rule has a command; never edit `access.yaml` by hand. Each validates the project with the edit and writes nothing when it adds an error, keeps the file's comments, and prints the warnings `sl validate` would add (rows of a child table a row filter does not limit, a tag nothing carries).

| The owner says | Command |
|---|---|
| open, or an allowlist | `sl set access mode open` (or `closed`) |
| the tool knows a user's department, region, id | `sl add-attribute --name department --type string` (`number`, `string_list`, `number_list`); `sl set access attribute:<name> description "<text>"` |
| a group that sees more, less or fewer rows | `sl add-role --name finance --assign-when "user.department == 'finance'"`, with `--allow-tags pii,sensitive`, `--deny-models <pattern>,...`, `--deny-fields <source.model.field>,...`, `--deny-tags <tag>,...`, and in closed mode `--allow-models <pattern>,...` |
| change one thing about a role | `sl set access role:<name> <key> <value>` (keys `description`, `assign_when`, `allow.models`, `allow.tags`, `deny.models`, `deny.fields`, `deny.tags`; a list is `a,b`; `--unset` removes the key) |
| a figure, table or field only some may see | `sl add-restriction --name <n> --targets metric:<name>,<source.model>,<source.model.field> --roles <role>,...` or `--when "<condition>"`; change it with `sl set access restriction:<name> <key> <value>` (keys `description`, `targets`, `allow.roles`, `allow.when`) |
| a role sees only some rows | `sl add-row-filter --role <r> --model <source.model> --expr "region = {{ user.region }}"` |
| a manager sees their team's rows | `sl add-row-filter --role <r> --model <source.model> --column <id column> --via <closure model> --manager <column> --member <column> --user <attribute>` (`--exclude-self` leaves out the manager's own rows) |
| who holds no other role | `sl set access default_role <role>` |
| a column is personal or sensitive | `sl tag <source.model.field> pii` (or `sensitive`) |
| not settled yet | `sl question add access --text "<question>"`, or on one role `sl question add access.roles.<role> --text "<question>"` |
| take one back | `sl remove-role <name>`, `sl remove-restriction <name>`, `sl remove-attribute <name>`, `sl remove-row-filter --role <r> --model <source.model>` (`--index <n>` when the role has several there) |

A condition (`--assign-when`, `--when`) tests user attributes, never SQL: `user.department == 'finance'`, `user.level >= 3`, `user.region in ['emea', 'apac']`, `user.teams contains 'sales'`, `user.employee_id is set`, joined with `and`, `or`, `not` and parentheses. Declare each attribute first. A row filter's `--expr` is SQL over the model's columns and `<join>.<column>` through its to-one joins, with `{{ user.<attribute> }}` for the user's value. `sl remove-role` and `sl remove-attribute` refuse while a restriction, a condition, a row filter, `default_role` or a golden names what they remove, and say which command changes each; `sl add-restriction` refuses a target that matches nothing.

Tools serve only an approved `access.yaml`: one that loads a draft serves nothing and says access is awaiting sign-off. An edit to an approved file makes it a draft again in the same write and keeps its sign-off as `last_approved`; tell the owner that the last approved version keeps applying where it is deployed until the new one is approved (`sl access` names it). With no exceptions the file is `mode: open` with no roles, and it is still read back and approved. Until `sl set access mode open|closed` creates the file, every other access command refuses and names it. `deny.fields` names dimensions and measures only; a join is hidden when its target model is hidden.

## What people see

Row filters of several held roles combine as a union, a held role with no filter on a model contributes every row, and in open mode a user with no role sees every row; say so. A row filter on a joined model limits only the joined rows on a left join; say so in the readback. A measure filter or dimension that reads through a join applies whatever the role may see and ignores row filters on its target; `sl validate` warns when a role may see a dimension that reads a model hidden from it, so show that model or deny the dimension. A dimension that reads a model the role row-filters shows every row's value and validate does not warn; deny it or read that back.

## The readback

Show the owner what people see with `sl access` (the default audience) and `sl access --roles <role> --user '<json>'` for each role, as part of the readback. When the readback changes the mode, state the old and new mode and who gains or loses visibility, naming the users who hold no role. `sl readback --targets access` reads the whole file back as one item and names every role in it with what the role adds and takes away; `sl readback` takes `access` and no single role. Walk the owner through each role in that readback, with its `sl access` view; a no or correction about any role voids the whole-file yes (read the file back again after any change made since that readback; a comment-only edit is not a change, and neither is deleting an answered open question or adding one, which you mention in the next message; writing its answer into roles, patterns, denials or row filters is a change), then record the answers in one `sl reply --readback <id> --answers -` and run `sl approve --readback <id>`; it approves the file only on a yes to the whole file.

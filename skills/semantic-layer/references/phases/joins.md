# Phase card: joins

Load this card when `semlayer next` names phase `check-join`, or when the interview reaches a join. It holds adding, measuring, explaining and approving joins. Load `references/joins.md` only when a join is `many_to_many`, the owner asks for a join across two sources, a role's span of control needs a closure model, or a join's measured evidence disagrees with what the owner expects.

**Checklist:** 1. `semlayer check-join --source <s> --model <m> --all`. 2. Explain the evidence in plain words. 3. Read each join back; `semlayer reply` with the answer, `semlayer approve` on a recorded yes.

For every join in the batch's models, including every join on the path of a join reference a measure filter or dimension uses (both hops of `order.customer.<column>`):

```
semlayer check-join --source <s> --model <m> --join <j>
```

It writes `evidence` into the model; `semlayer check-join --source <s> --model <m> --all` checks every join of one model. Explain the result plainly (how many rows match, whether each side appears once, whether the join would repeat rows). Flag every `one_to_many` join: it multiplies the left table's totals. A `many_to_many` result cannot be approved as is; it needs a bridge table or a pre-aggregated model. An approved `many_to_one` or `one_to_one` join whose evidence contradicts it (the right side's key is not unique, or `max_fanout` is above 1) is an error: fix the keys or the relationship (`semlayer set <s>.<m>.<j> keys <value>`, `semlayer set <s>.<m>.<j> relationship <value>`), or, when the owner explains why the measured repeats do not matter, record their reason as `fanout_override: "<reason>"` on the join (`semlayer set <s>.<m>.<j> fanout_override "<reason>"`).

**A join the draft did not write.** When the owner names one ("orders ship to a region: `ship_region` is the region's code"), add it:

```
semlayer add-join --source <s> --model <m> --name <join> --to <model> --keys <left>=<right>
```

In an owner turn that changes more, it goes in the turn's one `semlayer apply --file -` as the entry `["add-join", "--source", "<s>", ...]`. It writes a draft join with `origin: owner` (`--origin inferred` for one you guessed from names or matching values), `relationship: many_to_one` unless `--relationship one_to_one|one_to_many`, and `--type inner` when rows without a match should drop. Name the join after the role its target plays for the model (`ship_to_region`, `customer`), not after a column: joins share one namespace with the model's fields. Then measure it with `semlayer check-join` and read it back like any other. A join the owner rules out is `semlayer remove-join --source <s> --model <m> --name <join>`, which refuses while a field or row filter reads through it, naming each. Read the join back, record the owner's answer with `semlayer reply`, and on a yes approve it with `semlayer approve --target <s>.<m>.<j>`.

**A bridge join.** When a row can carry many values of something, such as the tags of an order held in a table with one row per (order, tag), ask the owner how a figure is shared among one row's values: in full to each (`distinct_pairs`, so totals by tag can add up to more than the overall total), split equally (`equal_split`) or by a numeric column of the bridge (`weight`). Add it with `semlayer add-bridge --source <s> --model <m> --name <join> --to <target> --through <bridge> --keys <left>=<bridge column> --through-keys <bridge column>=<target column> --dedupe <rule>`, measure it with `semlayer check-join` (it counts repeated pairs, bridge rows that name nothing, rows with no bridge row and values per row), and read it back: the readback states the rule and the overlap, and `semlayer readback` refuses a bridge join without the rule or without that evidence, naming the command that gives it.

A join reaches a model of the same source only; a link across sources is an open question on both models (`semlayer question add`), named in the handoff.

On an export source a join has no evidence until the source has a connection: its interview step goes straight to the sign-off readback, and an approved join warns until `semlayer check-join` measures it after the upgrade.

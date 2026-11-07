# Phase card: joins

Load this card when `sl next` names phase `check-join`, or when the interview reaches a join. It holds measuring, explaining and approving joins. Load `references/joins.md` with it.

**Checklist:** 1. `sl check-join --source <s> --model <m> --all`. 2. Explain the evidence in plain words. 3. Read each join back; `sl reply` with the answer, `sl approve` on a recorded yes.

For every join in the batch's models, including every join on the path of a join reference a measure filter or dimension uses (both hops of `order.customer.<column>`):

```
sl check-join --source <s> --model <m> --join <j>
```

It writes `evidence` into the model; `sl check-join --source <s> --model <m> --all` checks every join of one model. Explain the result plainly (how many rows match, whether each side appears once, whether the join would repeat rows). Flag every `one_to_many` join: it multiplies the left table's totals. A `many_to_many` result cannot be approved as is; it needs a bridge table or a pre-aggregated model. An approved `many_to_one` or `one_to_one` join whose evidence contradicts it (the right side's key is not unique, or `max_fanout` is above 1) is an error: fix the keys or the relationship (`sl set <s>.<m>.<j> keys <value>`, `sl set <s>.<m>.<j> relationship <value>`), or, when the owner explains why the measured repeats do not matter, record their reason as `fanout_override: "<reason>"` on the join (`sl set <s>.<m>.<j> fanout_override "<reason>"`). A join you add yourself, guessed from names or from matching values, has `origin: inferred` (adding one is a write without a typed command: `SKILL.md`, Hand edits); a join the owner rules out is `sl remove-field <s>.<m>.<j>`. Read the join back, record the owner's answer with `sl reply`, and on a yes approve it with `sl approve --target <s>.<m>.<j>`.

On an export source a join has no evidence until the source has a connection: its interview step goes straight to the sign-off readback, and an approved join warns until `sl check-join` measures it after the upgrade (`references/intake.md`).

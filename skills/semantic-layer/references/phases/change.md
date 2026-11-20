# Phase card: change, iterating a finished layer

Load this card when `semlayer next` names phase `change`. It holds one change round on a layer that has been released: what the owner asked for, the edits that make it, the readback of what moved, and the close. Load `references/phases/metrics.md` for a metric the round adds, `references/phases/interview.md` for a table or field, `references/phases/drift.md` when the change is a column that changed in the database, and `references/phases/joins.md` for a join; each holds the steps for its own item.

**Checklist:** 1. `semlayer change status --json`. 2. Make only the edits the owner asked for. 3. Read back only the items that changed. 4. `semlayer validate`, `semlayer goldens check`. 5. Close the round with the version the owner chooses.

## Order: the first release, then rounds

A layer is released once, then changed in rounds. A finished layer with no release yet is not changed: `semlayer next` ends its `done` step with the first release (`semlayer change close`, version 1.0, once the owner agrees the layer is finished), and `semlayer change start` refuses it. A released layer with no round open ends its `done` step with how to open one. Do not open a round for the owner's first build, or to tidy a layer you have not finished.

## Opening a round

The owner asks for one more metric, table, definition or a changed rule. Write their request in their words, with their name, in one command: `semlayer change start --note "<what the owner wants changed>" --by "<owner>"`. It saves the note, who asked, when, and the release the round starts from in `.semlayer/change.json`. Only one round is open at a time; a second start is refused and names `semlayer change status`. Never write the file by hand: the plugin's hook refuses it.

Start the round before the first edit, not after, so `semlayer change status` compares from the release.

## Changing only what was asked

Make the edits the request needs and nothing else. The interview is not redone: do not reopen a table, a decision or a question the owner has recorded, and do not tidy a description or add a field the owner did not ask for, even when you see a better one. Write an idea for later as an open question (`semlayer question add`) and tell the owner in one line. Use the typed edits (`semlayer add-metric`, `semlayer add-field`, `semlayer set`, `semlayer apply` for a turn's edits together) and never write approval fields: the phase cards of each item hold which command it uses.

A changed approved item goes back to draft, and stays draft until the owner's recorded yes to it as it now stands (`semlayer readback --targets <ref>`, the owner's answer with `semlayer reply`, then `semlayer approve --target <ref>`). An edit never carries the old approval over. If `semlayer next` names `reapprove`, the metrics card or any phase before this one, take that step first: the round is back in this phase once they are complete.

## Reading back what moved

`semlayer change status --json` lists the items added, changed and removed since the release, each changed item `approved` (approved again at its new content) or `draft` (waiting for the owner's yes), with the approved goldens that read it (`affected_goldens`). Read back only the items that changed or were added, never the whole layer: `semlayer next` names them, up to eight to a readback. Tell the owner what moved in plain words ("revenue now counts only completed orders; two goldens use it"), and put the sign-offs in a block of their own, as in every other phase.

Run `semlayer goldens check` after a definition changes. A golden whose figures moved is shown to the owner with the old and the new figure, and confirmed again only on their yes to the new rows (`semlayer readback --targets golden:<g>`, then `semlayer goldens confirm --name <g>`). A moved figure the owner did not expect is a finding to raise, not to confirm; never edit a golden's rows to make a check pass.

When a column changed in the database, the drift record (`.semlayer/drift.json`, shown in `semlayer change status`) names it; `release.column_retyped` in `semlayer validate` names each approved field that still reads it.

## Closing the round

When nothing is waiting for the owner's yes, `semlayer next` names the close, `semlayer change close`, and asks the owner for the version: it suggests the next minor above the release (1.0 to 1.1) and offers the next major for a large change, and the owner chooses. Say what the round changed, which goldens moved, and the suggested version, in the numbered items, then close with their answer. The close records the release in `changelog.yaml`, sets `layer_version`, and removes the round's file. It refuses while an item is still a draft, `semlayer validate` has an error, or an affected golden's figures moved and were not confirmed again; each refusal names the item and the command that settles it.

`semlayer change close` may not be in this version of `semlayer` yet. When `semlayer next` names it and the command is unknown, say the change is made and read back, name the version you would use, and stop there; leave `.semlayer/change.json` in place.

End the round trip with the line every other phase ends with: "Stop here or continue?"

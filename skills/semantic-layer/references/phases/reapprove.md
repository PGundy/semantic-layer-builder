# Phase card: reapprove

Load this card when `sl next` names phase `reapprove`. It holds approved items whose content changed since the owner approved them, and approvals that predate content hashes.

**Checklist:** 1. `sl validate` lists each `changed since it was approved` item. 2. Read each back with what changed, or restore its approved text. 3. `sl reply`, then `sl approve --target <ref>` on a recorded yes. 4. `sl goldens check`.

**Changed since approval.** `sl approve` records `approved_hash`, a hash of what the owner approved: a field's definition (with the joins it reads through), a join's target, keys and relationship, a model's table, grain, key and tags, a metric's definition, or the whole access file. `sl validate` errors "changed since it was approved" on an approved item whose content no longer matches, and `next_step` is `reapprove`, listing them, ahead of the interview. Read each one back with what changed (version control shows the edit) and approve it again only on the owner's yes, or restore the approved text; never approve to clear the error. A typed edit of an approved item routes it here itself; `sl approve --target <ref> --revoke` withdraws an approval before a larger change.

**Approved before content hashes.** A file whose approved items predate hashes gets one warning, "approved before content hashes"; on resume, before any edit and after checking in version control that no approved item changed since its `approved_at`, run `sl approve` with `--stamp-hashes`, which records the hashes and keeps `approved_by` and `approved_at`, and say so in the numbered items.

After the items are approved again, run `sl goldens check`: an approved edit that changes a figure fails the goldens that use it (`phases/verify.md`).

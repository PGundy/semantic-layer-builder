#!/bin/sh
# Writes semantic/.semlayer/ledger.jsonl, the example layer's answer ledger: one kind: confirm line in
# which the synthetic owner, Dana Ruiz, confirms every approval of the layer as it stands, since the
# example's YAML is written by hand rather than through readbacks. Run it from the repository root
# after changing an approved item of the example on purpose: sh examples/acme/confirm-approvals.sh
# The line it writes is the same every run; tests/recorded-yes.test.ts checks that it backs every approval.
set -eu
cd "$(dirname "$0")/semantic"
rm -f .semlayer/ledger.jsonl
SEMLAYER_NOW=2026-10-27T18:00:00.000Z bun ../../../skills/semantic-layer/scripts/semlayer.ts approve --root . --confirm-existing \
  --by "Dana Ruiz" --reply "These are the definitions, access rules and figures we agreed in the interview; they stand as they are."

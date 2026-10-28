#!/bin/bash
# Score all six grouping targets. Usage: scripts/grouping-bench.sh <dir of saved reviews> ; EXTRA=--split (model, cached) or EXTRA=--saved (as saved).
# External targets live in ~/.cache/lookout/bench/ and are never committed (block ids + labels of other orgs' PRs).
cd ~/dev/lookout
dir=${1:-/tmp/lookout-eval}
for n in review-a review-b review-d; do bun scripts/grouping-score.ts ${dir}/$n.json fixtures/grouping/$n.target.json $EXTRA; done
for n in PR A PR B PR C; do bun scripts/grouping-score.ts ${dir}/$n.json ~/.cache/lookout/bench/$n.target.json $EXTRA; done

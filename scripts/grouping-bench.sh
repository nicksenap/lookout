#!/bin/bash
# Score the grouping targets. Usage: scripts/grouping-bench.sh [dir of saved reviews]
#   EXTRA=--split runs the model splitter first (network, cached); EXTRA=--saved scores the cards as saved.
# In-repo targets are reviews of this repo's own commits (fixtures/grouping/). External targets, if you have
# judged any, live in ~/.cache/lookout/bench/<name>.target.json next to <dir>/<name>.json and are never committed.
set -euo pipefail
cd "$(dirname "$0")/.."
dir=${1:-fixtures/reviews}
for n in review-a review-b review-d; do bun scripts/grouping-score.ts "${dir}/$n.json" "fixtures/grouping/$n.target.json" ${EXTRA:-}; done
bench=~/.cache/lookout/bench
if ls "$bench"/*.target.json >/dev/null 2>&1; then
  for t in "$bench"/*.target.json; do
    n=$(basename "$t" .target.json)
    [ -f "${dir}/$n.json" ] && bun scripts/grouping-score.ts "${dir}/$n.json" "$t" ${EXTRA:-} || echo "skip $n: no ${dir}/$n.json" >&2
  done
else
  echo "no external targets in $bench; scored the in-repo ones only" >&2
fi

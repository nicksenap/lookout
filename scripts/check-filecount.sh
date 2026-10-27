#!/usr/bin/env bash
# Step 2 check: `lookout --json` file count equals `git diff --stat` for ranges in REPO (read-only).
set -euo pipefail
REPO=${1:?repo path}
LOOKOUT="bun $(cd "$(dirname "$0")/.." && pwd)/bin/lookout"
cd "$REPO"
fail=0; n=0
ranges=$(git log -50 --no-merges --format='%H^..%H'; echo "HEAD~20..HEAD"; echo "HEAD~5...HEAD"; echo "HEAD~40..HEAD~10")
for r in $ranges; do
  stat=$(git diff --stat "$r" | tail -1 | grep -oE '^ *[0-9]+ files? changed' | grep -oE '[0-9]+' || echo 0)
  got=$($LOOKOUT --json "$r" | bun -e 'const r=await Bun.stdin.json(); console.log(r.changeSet.files.length)')
  n=$((n+1))
  if [ "$stat" != "$got" ]; then echo "MISMATCH $r stat=$stat lookout=$got"; fail=1; fi
done
wstat=$(git diff --stat HEAD | tail -1 | grep -oE '^ *[0-9]+' | tr -d ' ' || true); wstat=${wstat:-0}
wgot=$($LOOKOUT --json | bun -e 'const r=await Bun.stdin.json(); console.log(r.changeSet.files.length)')
echo "worktree stat=$wstat lookout=$wgot"; [ "$wstat" = "$wgot" ] || fail=1
echo "checked $n ranges + worktree; fail=$fail"
exit $fail

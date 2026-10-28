#!/bin/sh
# Fake verifier for tests and manual TUI checks.
# Usage: fake-verifier.sh <prompt_file> [confirm|reject|unsure|mixed|malformed|silent]
# Reads the finding ids from the "Findings to verify" list in the prompt and answers each.
prompt_file=$1
mode=${2:-confirm}
ids=$(sed -n 's/^- \(d[0-9][0-9]*-[0-9][0-9]*\) \[.*/\1/p' "$prompt_file")
echo "Verifying $(printf '%s\n' "$ids" | wc -l | tr -d ' ') finding(s) ..."
case $mode in
  silent) echo "I could not finish."; exit 0 ;;
  malformed) echo '```json'; echo '{"verdicts": [{"id": '; echo '```'; exit 0 ;;
esac
first=1
echo '```json'
printf '{"verdicts": ['
n=0
for id in $ids; do
  n=$((n+1))
  [ $first = 1 ] || printf ', '
  first=0
  case $mode in
    confirm) printf '{"id": "%s", "verdict": "confirmed", "note": "evidence: the call on the next line passes the value through unchecked"}' "$id" ;;
    reject)  printf '{"id": "%s", "verdict": "rejected", "note": "reason: the caller validates this before the call"}' "$id" ;;
    unsure)  printf '{"id": "%s", "verdict": "unsure"}' "$id" ;;
    # mixed: 1st confirmed with evidence, 2nd rejected without a reason, the rest unmentioned
    mixed)
      case $n in
        1) printf '{"id": "%s", "verdict": "confirmed", "note": "evidence: reachable from main()"}' "$id" ;;
        2) printf '{"id": "%s", "verdict": "rejected"}' "$id" ;;
        *) printf '{"id": "%s", "verdict": "maybe"}' "$id" ;;
      esac ;;
  esac
done
printf ']}\n'
echo '```'
exit 0

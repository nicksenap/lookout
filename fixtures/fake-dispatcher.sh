#!/bin/sh
# Fake review agent for tests and manual TUI checks.
# Usage: fake-dispatcher.sh <prompt_file> [ok|slow|stubborn|fail]
# Reads the diff slice from the prompt and reports one p1 finding on the first added line.
prompt_file=$1
mode=${2:-ok}
[ "$mode" = stubborn ] && trap '' TERM
path=$(sed -n 's#^+++ b/##p' "$prompt_file" | head -1)
header=$(grep -m1 '^@@ ' "$prompt_file")
start=$(printf '%s\n' "$header" | sed -E 's/^@@ -[0-9,]+ \+([0-9]+).*/\1/')
# Walk the first hunk to find the first added line's new-side number.
line=$(awk -v start="$start" '
  /^@@ / { if (seen) exit; seen=1; n=start; next }
  seen && /^\+/ && !/^\+\+\+/ { print n; exit }
  seen && /^-/ { next }
  seen { n++ }
' "$prompt_file")
echo "Reviewing $path ..."
case $mode in
  slow|stubborn) i=0; while [ $i -lt 600 ]; do echo "thinking $i"; sleep 0.1; i=$((i+1)); done ;;
esac
echo "The first added line deserves a second look."
echo '```json'
printf '{"findings": [{"severity": "p1", "title": "Check first added line", "body": "Fake dispatcher finding.", "path": "%s", "line": %s}]}\n' "$path" "${line:-1}"
echo '```'
[ "$mode" = fail ] && exit 3
exit 0

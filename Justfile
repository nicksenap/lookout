set dotenv-load := false

# List available recipes
default:
    @just --list

# Run all checks (typecheck + unit tests + fixture consistency + boundary test).
# CI runs exactly this recipe — add new checks here, not in ci.yml.
check: typecheck test fixtures-check

# Type-check without emitting
typecheck:
    bun run typecheck

# Run the test suite (no network: mock models and fake dispatcher scripts)
test *args:
    bun test {{ args }}

# Rebuild saved fixtures from their change sets and fail if the committed ones drifted.
# Fixtures are reviews of this repo's own commits; see AGENTS.md.
fixtures-check:
    #!/usr/bin/env bash
    set -euo pipefail
    bun scripts/refresh-fixtures.ts > /dev/null
    if ! git diff --quiet -- fixtures/reviews; then
        echo "fixtures/reviews drifted from the pipeline; commit the refreshed files:"
        git --no-pager diff --stat -- fixtures/reviews
        exit 1
    fi

# Refresh saved fixtures after a grouping or kind-guard change
fixtures:
    bun scripts/refresh-fixtures.ts

# Render the real App against a saved review in your terminal (e.g. `just story review-a --paragraphs`)
story *args:
    bun stories/run.ts {{ args }}

# Grouping benchmark against the hand-judged targets (EXTRA=--split runs the model splitter, cached)
bench dir="/tmp/bench/baseline":
    scripts/grouping-bench.sh {{ dir }}

# Drive the stack in a PTY against a repo and target; always ends with q (usage: just smoke ../some-repo HEAD~3..HEAD)
smoke repo target:
    python3 scripts/pty-smoke.py {{ repo }} {{ target }}

# Install the pre-commit hook (fast subset of `just check`)
install-hooks:
    git config core.hooksPath .githooks

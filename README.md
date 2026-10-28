# lookout

Review agent-written code as a stack of colour-coded cards, each a paragraph about one logical change, instead of a mountain of diff.

```
 acme/api#402 · Add retry to token refresh              HIGH · 2 humans · 5 cards · 1 claim ✗

█ RED   logic · auth/*   tests touched                        6 edits · 2 files · 3 claims ✗
█ Retry Token Refresh With Backoff
█ `refresh()` now retries three times with backoff, threading a new `attempts`
█ parameter through its two callers in api/route.ts. The final error is returned
█ instead of rethrown.
█   ✗ contradicted 91%  Existing callers are unaffected

┃ AMBER additive · api/   unmentioned                          2 edits · 1 file
┃ Return 503 When Refresh Fails
┃ `route.ts` now answers 503 instead of 500 when refresh fails.

┃ GREEN test   covers card 1                                   4 edits · 1 file · 1 claim ✓
┃ Test Refresh Retries
┃ Adds success-after-one-failure and exhaustion-after-three cases for `refresh()`.

┃ GREY  verified clean · 3 edits                               lockfile, import order

┃ UNTOUCHED  billing · data · infra

 j/k card · enter expand · a review card · A review all · c claims · ? keys · q quit
```

A pipeline of cheap typed decisions (the AI SDK's Decisions API) and a few short LLM calls produces the cards in 4–10 seconds. Rules bound the model: a model may raise a card's attention and never lower it, and only rules may call an edit inert. The diff is the appendix inside an expanded card.

## Install

Requires [Bun](https://bun.sh), `git`, and `gh` (for PR targets; uses `gh`'s own login, read-only).

```sh
git clone https://github.com/nicksenap/lookout && cd lookout
bun install
bun link            # puts `lookout` on PATH (needs ~/.bun/bin on PATH)
```

Put an API key in `~/.config/lookout/.env` (mode 600). Shell variables win over the file.

```
OPENAI_API_KEY=sk-…
```

Without a key lookout still runs: rules only, one card per file, rule colours, no paragraphs, a banner saying so.

## Use

```sh
lookout                          # working tree vs HEAD
lookout main..                   # a range (A..B, or A...B from the merge-base)
lookout owner/repo#123           # a pull request
lookout https://github.com/owner/repo/pull/123
lookout <target> --json          # the same Review as JSON
lookout <target> --all           # also show rejected and dropped findings, with why
```

Keys in the stack: `j/k` move, `enter` expands a card (findings, questions, claims, tests, door signals, then its diff with other cards' edits faded), `c` opens the claims view, `a` reviews the card (a proposer agent, then a verifier on what it found), `A` on every red and amber card, `x` cancels, `?` lists everything, `q` quits. In an expanded card `y` / `n` / `u` answer its first open question.

## What you are looking at

**Card**: one logical change, built from edit blocks (contiguous `+`/`-` runs) across any files, titled and described in at most three sentences from its own edits. Two fixed cards: *verified clean* collects every inert edit (lockfiles, whitespace, generated code), *untouched* lists sensitive areas the change does not reach.

**Colour** is a rule, not an opinion. Red: a suspicious edit, or behaviour changed inside a sensitive area. Amber: needs eyes, or dependency/config/CI changes. Green: fine. Grey: verified clean. Tests, renames and docs inside a sensitive area stay green and keep the area badge.

**Verdict** (header): risk tier and how many humans must review, from the repo's policy: change kind defaults, area rules, and floors (a touched area is never low; a needs-eyes edit is at least medium).

**Claims**: each `- ` bullet of the PR description, graded against the diff. `✓ supported`, `✗ contradicted` (shown only at ≥ 70 % confidence), `~ unclear`, `∅ not in diff`. A card no claim describes is **unmentioned**. The claims view also shows the **door** (one-way signals found in the diff: migrations, destructive SQL, data writes, removed public exports or routes, versus what the author wrote) and the **blast radius** (sensitive areas touched, files importing the changed files).

**tests touched / covers**: a test card in the same change exercises this card's files (same directory, name stem, or import); the test card lists what it covers.

**Findings** come from `a`: a proposer agent reviews the card's diff, then a verifier gets each finding and must confirm it with evidence, reject it with a reason, or say unsure; Decisions scores whether the evidence holds (below 70 % the finding is shown as unsure). `✓✓` verified, `✓` proposed and not yet verified, `?` unsure (p0/p1 only, dimmed). Rejected, duplicate and unsure p2 findings are hidden unless `--all`. A finding anchored to a line the change did not touch is marked **pre-existing**.

**Questions**: 2–4 yes/no prompts per card, picked by Decisions from a tier-specific bank (intent match, error path tested, rollback, sensitive callers, sets a pattern, …) once the evidence has landed. Your answers are stored in the Review.

Vocabulary is in `GLOSSARY.md`; the design and roadmap in `PLAN.md`.

## Configure

Global `~/.config/lookout/config.toml`, then the repo's `.lookout.toml` layered on top. Every error names the key.

```toml
[model]
decide = "openai:gpt-6-luna"   # Decisions API: attention, kinds, claim grounding
write  = "openai:gpt-6-luna"   # prose: titles, paragraphs

# Sensitive areas: name = path globs. An empty list removes a default area.
[areas]
auth    = ["src/auth/**", "src/middleware/session*.ts"]
billing = ["src/billing/**"]
data    = []

[policy.kinds]          # minimum tier per change kind
docs = "low"
logic = "medium"

[policy.humans]
low = 0
medium = 1
high = 2

[[policy.rules]]        # raise the tier when every condition holds
area = "auth"
tier = "high"
reason = "touches auth"

[dispatch.pi]           # agents for `a` / `A`; the first is the default proposer
cmd = "pi -p @{prompt_file}"

[verify]                # optional: which dispatcher verifies findings (default: the first)
dispatcher = "pi"
```

Default areas are `auth`, `billing`, `data`, `infra`, `prompts`; their globs are deliberately broad and worth narrowing per repo.

## How it works

```
diff ─► edit blocks ─► rules (labels, inert, sensitive paths)        0 calls
     ─► Decisions: attention score + kind per block                  1 call / 20 blocks
     ─► deterministic grouping into cards; mechanical templates      0 calls
     ─► LLM: title + paragraph per card, in parallel                 1 call / card
     ─► claims from the PR body's bullets (LLM only if none)         0–1 calls
     ─► Decisions: ground every claim against the cards              1 call
     ─► policy: colour, tier, humans; door; tests touched; radius    0 calls
     ─► Decisions: 2–4 questions per card from the tier bank         1 call
  a  ─► proposer agent on the card ─► dedupe ─► verifier agent        2 agent runs
     ─► Decisions: does the verifier's evidence hold? gate at 70 %    1 call
```

Everything is cached by content hash under `~/.cache/lookout`, so re-running a PR after a push only recomputes changed blocks. Every model step degrades to rules plus a warning; nothing is fatal.

## Develop

```sh
bun test                 # no network; mock models and fake agents
bun run typecheck
bun run story review-a --paragraphs   # the real TUI over a saved review
scripts/pty-smoke.py <repo> <target>  # drive the TUI in a pty
```

`AGENTS.md` has the working rules. Fixtures under `fixtures/` are reviews of this repo's own commits.

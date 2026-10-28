<h1 align="center">lookout</h1>

<p align="center"><b>lookout</b> /ˈlʌkaʊt/ <i>noun</i> — a person who keeps watch; a place from which to keep watch.</p>

<p align="center">
  <a href="https://github.com/nicksenap/lookout/actions/workflows/ci.yml"><img src="https://github.com/nicksenap/lookout/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/nicksenap/lookout/blob/main/LICENSE"><img src="https://img.shields.io/github/license/nicksenap/lookout" alt="License"></a>
</p>

<p align="center">Review agent-written code as a stack of colour-coded cards, each a paragraph about one logical change, instead of a mountain of diff.</p>

```
 acme/api#402 · Add retry to token refresh                MEDIUM · 1 human · 5 cards · gpt-6-luna

█ RED   logic · auth/*   one-way · data-write                             6 edits · 2 files
█ Retry Token Refresh With Backoff
█ Callers of `refresh()` now get three attempts with backoff before an error; the final
█ error is returned instead of rethrown. `attempts` threads through its two callers in
█ api/route.ts.

┃ AMBER additive · api/                                                    2 edits · 1 file
┃ Return 503 When Refresh Fails
┃ `route.ts` now answers 503 instead of 500 when refresh fails.

┃ GREEN test   covers card 1                                               4 edits · 1 file
┃ Test Refresh Retries
┃ Adds success-after-one-failure and exhaustion-after-three cases for `refresh()`.

┃ GREY  verified clean · 3 edits                                           lockfile, import order

┃ UNTOUCHED  billing · data · infra

 j/k card  ·  enter expand  ·  {/} next hot  ·  / search  ·  a ask  ·  ? help  ·  q quit
```

## Why?

A 20-file PR written by an agent is not 20 files of decisions. It is four or five: a new key tree, the callers that adopt it, a narrowed cache invalidation, the tests. The diff view shows you the files; the cards show you the decisions, riskiest first, each with a paragraph a checker has read against the edits.

Rules do the judging and the model does the reading. Rules decide what is inert, what counts as mechanical, which colour a card gets and which card comes first; a model may raise attention and never lower it. Every paragraph and every answer is written from the edits alone and then scored by a typed Decisions question; what fails the check is shown dimmed and says so. When the cards are not enough, `a` asks a question grounded in the same edits, and the diff is one keypress away.

## Getting Started

Requires [Bun](https://bun.sh), `git`, and `gh` for pull requests (uses `gh`'s own login, read-only).

### 1. Install

```sh
git clone https://github.com/nicksenap/lookout && cd lookout
bun install
bun link            # puts `lookout` on PATH (needs ~/.bun/bin on PATH)
```

### 2. Add a key

Put an API key in `~/.config/lookout/.env` (mode 600). Shell variables win over the file.

```
OPENAI_API_KEY=sk-…
```

Without a key lookout still runs: rules only, one card per file, rule colours, no paragraphs, a banner saying so.

### 3. Review something

```sh
cd some-repo
lookout                          # dirty tree: review it · clean tree: pick an open PR
lookout owner/repo#123           # a pull request
```

## Usage

```sh
lookout                          # working tree vs HEAD; clean tree in a GitHub repo → picker of open PRs
lookout --pick                   # the picker
lookout main..                   # a range (A..B, or A...B from the merge-base)
lookout owner/repo#123           # a pull request
lookout https://github.com/owner/repo/pull/123
lookout <target> --json          # the same Review as JSON
lookout <target> --json --evidence   # plus claims, grounding, unmentioned and questions (JSON only)
```

### Keys

Vim and helix conventions. `?` overlays the full list and a glossary.

| Keys | Action |
|---|---|
| `j/k` `ctrl-d/u` `gg`/`G` | move; half page; first/last |
| `]`/`[` · `}`/`{` | next/previous colour band · next/previous red or amber card |
| `enter` `l` · `o` · `esc` `h` | expand a card (scope, tests, door signals, its diff) · toggle · back |
| `/` `n` `N` | search the stack or the expanded diff; next/previous match |
| `a` | ask about the selected card (`tab`: the whole change; `↑/↓` earlier questions) |
| `?` · `q` | help and glossary · quit |

While cards load, a bar under the header shows the phase (ranking → splitting → writing) and the count.

## What you are looking at

**Card**: one logical change, built from edit blocks (contiguous `+`/`-` runs) across any files, titled and described in at most three sentences from its own edits. Two fixed cards: *verified clean* collects every inert edit (lockfiles, whitespace, generated code), *untouched* lists sensitive areas the change does not reach.

**Colour** is a rule, not an opinion. Red: a suspicious edit, behaviour changed inside a sensitive area, or a one-way signal on an edit that needs eyes. Amber: needs eyes, dependency/config/CI changes, or a one-way signal. Green: fine. Grey: verified clean. Tests, renames and docs inside a sensitive area stay green and keep the area badge. The stack is red → amber → green; mechanical and docs cards last; a configuration switch first within its colour.

**Mechanical** cards (renames, typing, moves) carry a template sentence only when rules confirm the model's label: a consistent one-to-one identifier substitution, type-only edits with no narrowing and no new return type, code that reappears verbatim. Anything else is behaviour.

**One-way** signals in the diff (migrations, destructive SQL, in-place data writes incl. key-value updates, removed public exports or members, removed routes, contract files) attach to the card that owns the line and raise its colour.

Cards whose paragraph failed the check twice (a name not in the edits, or Decisions puts under 70 % on "every statement follows from the edits") show **paragraph unverified** and dim the text.

**Verdict** (header): risk tier and how many humans must review, from the repo's policy: change kind defaults, area rules, and floors (a touched area is never low; a needs-eyes edit is at least medium).

**tests touched / covers**: a test card in the same change exercises this card's files (same directory, name stem, or import); the test card lists what it covers.

**Evidence layer** (`--evidence`, JSON only for now): each `- ` bullet of the PR description graded against the diff (`supported`, `contradicted` at ≥ 70 % confidence, `unclear`, `not-in-diff`), cards no claim describes marked `unmentioned`, and 2–4 yes/no questions per card from a tier-specific bank. Agent find + verify (`dispatch/`, `verify/`) is wired to the same flag through the session commands. These were built in v1 and are parked until the cards themselves pass review (`PLAN-v2.md`).

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

[dispatch.pi]           # review agents (--evidence, session commands); the first is the default proposer
cmd = "pi -p @{prompt_file}"

[verify]                # optional: which dispatcher verifies findings (default: the first)
dispatcher = "pi"
```

Default areas are `auth`, `billing`, `data`, `infra`, `prompts`; their globs are deliberately broad and worth narrowing per repo.

## How it works

```
diff ─► edit blocks ─► rules (labels, inert, sensitive paths, scope at head)   0 calls
     ─► Decisions: attention score + kind per block                            1 call / 20 blocks
     ─► rules confirm mechanical kinds; fragments join their owner             0 calls
     ─► deterministic grouping; oversized cards split by the writer,
        the partition repaired or rejected by rules                            1 call / blob
     ─► LLM: title + paragraph per card shape, in parallel                     1 call / card
     ─► rules + Decisions: does every sentence follow from the edits?          1 call / card
     ─► policy: colour, order, tier, humans; door signals; tests touched       0 calls
  a  ─► LLM answer from the scope's edits ─► Decisions consistency check       2 calls
  --evidence ─► claims, grounding, unmentioned, questions, agents               parked (JSON only)
```

Everything is cached by content hash under `~/.cache/lookout`, so re-running a PR after a push only recomputes changed blocks. Every model step degrades to rules plus a warning; nothing is fatal.

## Development

```sh
just check          # what CI runs: typecheck, tests, fixture drift
just install-hooks  # pre-commit runs the fast subset
just story review-a --paragraphs   # the real App against a saved review, no models
just bench          # grouping benchmark against hand-judged targets
```

`AGENTS.md` has the working rules, `GLOSSARY.md` the vocabulary, `PLAN-v2.md` the current plan (the v1 design is `PLAN.md`), `HANDOFF.md` where things stand.

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
cd some-repo && lookout
```

## Usage

```sh
lookout                          # dirty tree: review it · clean tree in a GitHub repo: pick an open PR
lookout main..                   # a range (A..B, or A...B from the merge-base)
lookout owner/repo#123           # a pull request (or its URL)
lookout <target> --json          # the Review as JSON; --evidence adds claims, unmentioned, questions
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

## Reading a card

A **card** is one logical change: edit blocks from any files, a title and a paragraph written from those edits alone and checked against them. **Colour** is a rule, never an opinion: red for a suspicious edit, behaviour in a sensitive area or a one-way edit that needs eyes; amber for needs-eyes, config and one-way signals; green for the rest; grey for verified-clean. Renames, typing and moves get a template sentence only when rules confirm the model's label. **One-way** signals (migrations, destructive SQL, in-place data writes, removed public exports or routes) attach to the card that owns the line. A paragraph that fails its check twice is shown dimmed as *unverified*. The header's **verdict** is the tier and how many humans must review, from the repo's policy.

`?` in the app has the full glossary; so does [GLOSSARY.md](GLOSSARY.md).

## Configure

Global `~/.config/lookout/config.toml`, then the repo's `.lookout.toml` on top. Every error names the key.

```toml
[model]
decide = "openai:gpt-6-luna"   # Decisions API: attention, kinds, checks
write  = "openai:gpt-6-luna"   # prose: titles, paragraphs, answers

[areas]                        # sensitive areas: name = globs; [] removes a default
auth    = ["src/auth/**"]
billing = ["src/billing/**"]

[[policy.rules]]               # raise the tier when every condition holds
area = "auth"
tier = "high"
```

Defaults: areas `auth`, `billing`, `data`, `infra`, `prompts` (broad globs, worth narrowing per repo); `docs`/`additive` low, `logic`/`config`/`deps` medium; `[policy.kinds]`, `[policy.humans]` and `unless` on rules are in [docs](HANDOFF.md). The evidence layer (`--evidence`: PR claims graded against the diff, unmentioned cards, review questions, agents) is JSON-only and parked until the cards pass review; see [PLAN-v2.md](PLAN-v2.md).

## Development

```sh
bun run check       # what CI runs: typecheck · biome · complexity · knip · test · fixture drift
bun run lint:fix    # format and fix
bun run story review-a --paragraphs   # the real App over a saved review, no models
```

[AGENTS.md](AGENTS.md) has the working rules, [HANDOFF.md](HANDOFF.md) where things stand and what's next.

# lookout — v1

Review agent-written code as a stack of color-coded cards, each a paragraph about one logical change, instead of a mountain of diff. A pipeline of cheap typed decisions (Decisions API) and a few LLM calls produces the cards; agents deepen the ones that earn it; the diff is the appendix.

North light: semantic change classifier → approval policy; multi-agent find + verify; risk tier with required humans; evidence requirements; depth dials; convergence and metrics later.

## The interface

A single-column interactive stack, riskiest card first:

```
 acme/api#402 · Add retry to token refresh                 MEDIUM · 1 human · 5 cards

┃ RED   logic · error-handling · auth/*                   2 findings · 1 claim ✗
┃ Wraps token refresh in a 3-attempt retry with backoff, threading a new
┃ `attempts` parameter through refresh() and its two callers in api/route.ts.
┃ The PR says existing callers are unaffected, but route.ts:88 now swallows
┃ the final error instead of rethrowing it.
┃   P1 ✓✓ token compared with == not timingSafeEqual        auth/refresh.ts:51
┃   ☐ Is swallowing the final refresh error intended?

┃ AMBER logic · api/                                       unmentioned · needs-eyes
┃ Changes api/route.ts to return 503 instead of 500 when refresh fails.
┃ The PR description doesn't mention this.

┃ GREEN test                                               covers card 1
┃ Adds retry tests for refresh(). No test covers the 503 path in card 2.

┃ GREY  verified clean                                     3 files · 7 edits
┃ Lockfile, import reordering, a comment reword in Sidebar.tsx.

┃ UNTOUCHED  auth middleware · session store · billing

 j/k card · enter expand · a review this card · A review all · c claims · q
```

- `enter` expands a card: its edit blocks as a diff with findings inline, the claims it answers, the questions, the agent log. `esc` collapses.
- `a` dispatches proposer + verifier on this card; `A` on all RED/AMBER cards. Findings stream into the card.
- Paragraphs, claims and colors stream in as the pipeline lands them; the stack is readable with titles and rule colors in ~2 s.
- Pretty: a thick colored left border per card, a badge line, dim metadata, a spinner on cards still being written, smooth re-render (windowed, throttled). Design tokens in one theme file.
- `--json` prints the same Review. `--depth quick|standard|deep` runs agents up front instead of on demand.

## Session contract

The TUI, `--json`, and any later web client or remote daemon talk to the core only through one interface:

```ts
interface ReviewSession {
  snapshot(): Review                              // the JSON --json prints
  subscribe(fn: (e: ReviewEvent) => void): () => void   // patches, not snapshots: card.updated, finding.added, claim.updated, dispatch.output, verdict.updated, done
  command(c: ReviewCommand): Promise<void>        // dispatchCard, dispatchAll, cancel, answerQuestion, setDepth, refresh
}
```

v1 implements it in-process (`core/session.ts` wrapping store + runner). A boundary test ensures `src/tui/` imports only `core/session.ts`, `core/types.ts` and its own files. Later `lookout serve` exposes the same three over a socket and the TUI gains `--connect`; nothing in the pipeline changes.

## Done when

On 3 real agent-written PRs from a production repo you already reviewed: you understand each PR from the cards alone in under 3 minutes; the tier and humans match your call; every card's paragraph is accurate against its diff; every ✗ claim is a real mismatch; every verified finding is one you would act on and nothing you found by hand is missing.

## The pipeline

Rule: **deterministic where it can be, Decisions where a typed answer will do, LLM only for prose.** Measured on a 4-file production PR: the first design (LLM grouping + paragraphs) took 65 s; this one takes 4–7 s end to end, 10 s on a 101-file PR. Everything is cached by content hash, so re-runs only recompute changed cards.

| # | Step | Kind | Calls |
|---|---|---|---|
| 1 | Labels, inert, sensitive paths | rules | 0 (exists) |
| 2 | Attention score + **kind** (`typing-refactor | rename | move | behavior | test | types | config | docs`) per edit block | decide | 1 batched |
| 3 | Group blocks into logical changes: kind first; punctuation-only orphans join their hunk neighbour; mechanical kinds form one card per kind across files; others merge by hunk proximity or a shared changed identifier | rules | 0 |
| 4 | Mechanical cards (typing/rename/move): deterministic title and one-line paragraph | rules | 0 |
| 5 | Title + ≤3-sentence paragraph per non-mechanical card, from its own edits only, cached by card id | llm (reasoning low) | N, parallel |
| 6 | Extract claims from the PR body; template-aware for `/pr` bodies (Summary, Evidence, Merge Danger) | llm | 1 |
| 7 | Ground each claim: `supported \| contradicted \| not-in-diff`; evidence = `choice` over cards | decide | 1 batched |
| 8 | Card risk: sensitive? behavior change? reversible? test-covered? → color; merged with rule floors; tier + humans derived | decide | 1 batched |
| 9 | Proposer agents per card (on demand or by depth) | agents | existing runner |
| 10 | Verifier: evidence or reject per finding; Decisions scores confidence; gate | agents + decide | per finding |
| 11 | Pick 2–4 questions per card from a tier-specific bank | decide | 1 batched |

Without a key: steps 1 and 8's rule floors only → one card per file, rule colors, no prose, banner.

**Fixed cards**: `verified clean` (all GREY edit blocks, one line) and `UNTOUCHED` (sensitive areas from policy config not touched by any edit block).

## Scope

**Input**: `lookout` (working tree), `lookout A..B`, `lookout <pr-url>` / `owner/repo#N` via `gh`. Exists.

**Edit blocks** (`core/`): a hunk is split into contiguous runs of `+`/`-` lines; each is an edit block with its own id, anchor and labels. Hunks remain for the diff view. AST-level units are roadmap.

**Policy** (`policy/`): `.lookout.toml` + global config. Sensitive areas as named path sets (`auth`, `billing`, `data-access`, …); tier rules; hard floors (sensitive → never low; `suspicious` → ≥ medium). Defaults: docs/additive → low; logic/config/deps → medium; auth, schema, CI, prompts → high.

**Find + verify** (`dispatch/` exists, `verify/` new): proposer uses the existing prompt/contract with a card's diff; verifier gets each finding + its slice and must return `confirmed` with evidence (reachability, repro, or test) or `rejected` with a reason, `unsure` allowed. Dedupe by anchor + title before verifying. Only `confirmed` shows by default; `unsure` p0/p1 dimmed; `rejected` behind `--all`. `✓✓` = verified, `✓` = confirmed by one pass. Findings anchored to context lines are marked `pre-existing`.

**Evidence** (`evidence/`): claims (6–7); unmentioned cards; tests touched per card; door check (author says one-/two-way vs. diff evidence: migrations, deleted columns, public contract changes, data writes); blast radius: author's word vs. computed from policy areas + importers of changed files.

**Questions** (`questions/`): tier-specific bank (intent match, rollback clear, sensitive paths still correct, sets a pattern, error path tested…). Decisions picks which apply to a card; the human answers in the expanded card (`y/n/?`), stored in the Review.

**Depth** (`--depth`, config, or policy rule per area): quick = steps 1–8 + 11, no agents; standard = + proposer + verifier on RED/AMBER; deep = all proposers, second verify round on `unsure`. DEPTH, agent count and time shown in the header.

## Stack

**Errors**: expected, recoverable failures are returned as `Result<T, E>` (`core/result.ts`), never thrown: missing key, failed model call, `gh` missing, invalid config, unparseable agent output, a claim with no evidence. Every pipeline step returns a `Result` or a value carrying a `warning`. Programmer errors and impossible states throw. Modules that call throwing libraries convert once at the call site (`attempt`/`attemptAsync`); callers never see try/catch. `cli/main.ts` is the only place that catches everything and maps to an exit code.

Bun + strict TS. **Ink 6** for the stack (single column is what it renders well; windowed rows, ~10/s throttle, alt screen, one `theme.ts`). AI SDK `ai` pinned exact: `experimental_decide` + `createProviderRegistry` (BYOK, no gateway) for every typed step, `generateText` from the same registry for prose; all `experimental_*` in `rank/model.ts`. One model id does both by default (`openai:gpt-6-luna`: the only Decisions model, and at `reasoningEffort: low` it writes the tightest paragraphs of the five tried, ~2 s per card). Config: `[model] decide = … write = …`; `[rank] model` remains as an alias. Own diff parser. `git`/`gh` via shell. Hand-written config validation. Mock decision/language models in tests; no network.

## Layout

```
src/
  core/       types.ts, diff.ts, blocks.ts (edit blocks), store.ts, session.ts (ReviewSession)   (diff/store exist)
  sources/    git.ts, github.ts, resolve.ts, exec.ts                          (exist)
  rank/       rules.ts, lexer.ts, model.ts, rank.ts, cache.ts                 (exist; per-block)
  cards/      propose.ts (3), assign.ts (4), write.ts (5), risk.ts (8), build.ts (orchestrate + stream)
  policy/     schema.ts, defaults.ts, evaluate.ts
  evidence/   claims.ts (6–7), tests.ts, door.ts, radius.ts
  dispatch/   config.ts, prompt.ts, runner.ts, parse.ts                       (exist) + plan.ts
  verify/     prompt.ts, verify.ts, dedupe.ts
  questions/  bank.ts, pick.ts
  tui/        App.tsx, Stack.tsx, Card.tsx, Expanded.tsx, theme.ts, keys.ts
  cli/        main.ts
fixtures/     real diffs, PR bodies (incl. /pr template), recorded agent outputs
```

## Data model

```ts
EditBlock  { id, path, hunkId, from, to (index range into hunk.lines), oldRange?, newRange?, labels, attention, score }   // lives on Hunk.blocks; hunk labels/attention/score derive from its blocks
Card       { id, title, color: red|amber|green|grey, kind, flags, areas: string[], blockIds, paragraph?,
             claimIds, unmentioned: boolean, findings: Finding[], questions: Question[], testsTouched: boolean }
Claim      { id, text, section?: summary|evidence|door|radius, status: supported|contradicted|not-in-diff, cardId? }
Finding    { id, severity, title, body, anchor?, dispatcher, status: proposed|confirmed|rejected|unsure,
             evidence?, verifierNote?, preExisting: boolean }
Question   { id, text, answer?: yes|no|unsure }
Verdict    { tier: low|medium|high, requiredHumans: 0|1|2, reasons: string[] }
Review     { changeSet, cards, verdict, untouched: string[], claims, dispatches, depth, rankedBy, timing, warning? }
ReviewEvent   { type: card.updated | finding.added | claim.updated | dispatch.output | verdict.updated | done, id?, patch? }
ReviewCommand { type: dispatchCard | dispatchAll | cancel | answerQuestion | setDepth | refresh, ... }
```

## Steps

Each ends with a check that must pass before the next. Existing: scaffold, parser/sources, rules, model ranking, dispatch runner/parser.

7. **Edit blocks + per-block ranking.** Split hunks; move rules/model ranking to blocks. Check: fixture tests (fused hunk → 2 blocks, pure-context hunk → 0); inert audit over a production repo still 0 false hides.
8. **Policy.** Config, areas, tier rules, floors, `.lookout.toml`. Check: table tests; sensitive never low; tier per commit over the last 30 commits of a production repo, spot-check 10.
9. **Cards without prose.** Steps 4 (with rule-based titles as a stand-in), 8, fixed cards, build/stream orchestration, `--json`, and `core/session.ts` with typed events and commands. Check: every block in exactly one card; verified-clean and untouched correct on 3 production PRs; events are patches (a 40-card review streaming paragraphs never re-sends the whole Review).
10. **Stack TUI.** Single column, colors, badges, expand/collapse, streaming spinners, theme; talks to the core only via `ReviewSession`. Check: boundary test; render tests at 80/120/200 columns with 1, 5 and 40 cards and no overflow; PTY smoke (always ends with `q`, wrapped in a timeout); you say it's pretty.
11. **Prose.** Kind question in the ranking batch; deterministic grouping; mechanical templates; writer per card. Check: mock-model tests; property tests over every saved review in `fixtures/reviews/` (reviews of this repo's own commits, 1–14 files); on 3 production PRs every paragraph is accurate against its card's diff and the refactor/behavior split matches how you'd describe the PR.
12. **Evidence.** Claims (template-aware), unmentioned, tests touched, door, radius. Check: mock tests incl. no-evidence claim and uncovered card; every ✗ real on 3 PRs.
13. **Find + verify + questions.** `a`/`A`, verifier protocol, gate, dedupe, pre-existing, question bank/pick/answer. Check: fake proposer/verifier scripts (confirm/reject/unsure/malformed); on one PR `standard` yields only findings you'd act on; `--all` shows what was dropped and why.
14. **Depth + timing.** Check: quick makes 0 agent runs; deep re-verifies only `unsure`; header matches the log.
15. **Done gate.**

## Roadmap

`--html` static single-file export of a Review (renders /pr Mermaid and screenshots, side-by-side diff; doubles as the PR-comment artifact); `lookout serve` + `--connect` (same ReviewSession over a socket; TUI on laptop, pipeline on devbox); live web client on the same contract; AST-level edit units (tree-sitter); splitting an edit block across cards; post card/findings to GitHub and read existing comments; convergence (re-review only new blocks, round caps, bug classes); metrics store (human time, substantive findings, noise, revert rate); watch/continuous mode and pre-commit; worktree isolation and concurrency for agents; local models; claims from commit messages; behavior diffs by running code; web mode on the same core; single binary.

## Defaults to revisit with data

Tier defaults and area list; verifier gate for `unsure`; N for proposed changes (start: ≤ 8, model may return fewer); paragraph length (start: ≤ 4 sentences); question bank size (start: 12).

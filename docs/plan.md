# lookout — plan (v2: cards first; v3: point at the risk; v4: one level up)

v1 built the whole north light (cards, claims, door, radius, find+verify, questions). Three production PRs (PR A, PR B, PR C; reports in `/tmp/lookout-eval/`) scored it 3/3/2 out of 5, and every evaluator named the same cause: the cards are wrong before anything downstream runs. v2 narrows to one question — **can a reviewer understand a PR from the card titles and paragraphs alone?** — and measures it before anything else gets attention back.

## What v1 got wrong, by evidence

| Failure | Where it showed | Root cause in code |
|---|---|---|
| Mechanical card hides behaviour, template says "behaviour is unchanged" | #822 "Rename across 6 files" holds cache-key *value* changes; #1128 "Typing refactor" holds a 5-minute timeout constant and nullable signatures | `group.ts` trusts the Decisions `kind` per block; nothing checks a rename is a rename |
| One amber blob holds all the risk | #822 24 blocks; #1128 ~59 blocks / 15 files incl. non-transactional key-value rewrites; nothing red | rule 3 + rule 4 union-find is transitive: a shared identifier chains a whole feature |
| Lone fragments become cards | a request model type card, `export {…}` lines as "Rename in the deployment file", a header component over 3 cards | no "join the card that owns this file" rule; kind decides before context |
| Config card misses the fact that matters | #3309 never says *stage*, nor two near-identical lists, nor preview runtimes | writer sees edits only, no file context; no card-shape-specific prompt |
| One factual error per PR in prose | "`commit_x` is replaced by `clear_x`" (it is added) | no check that the paragraph's claims are in the diff |
| Radius is noise, flips a true claim to ✗ | 32 / 87 / 235 importers; author's "local" contradicted at 0.9 | `findImporters` matches file *stems*; monorepos have a `query-keys.ts` per package |
| Unmentioned false positive 2/3 | infra card flagged unmentioned while the body describes it; claim attached to the test card | claim→card is a `choice` over cards with no file-name preference |

Claims grounding itself was mostly right (22/29 statuses agreed). It is not the problem; it was judged on bad cards.

## Decision

- **In scope**: edit blocks, kind, grouping, titles, paragraphs, colour, tier, TUI stack, `--json`. One model call for kinds, one per card for prose, optionally one per blob for splitting.
- **Dormant** (code stays, tests stay, not on the default path, not in the TUI): claims, grounding, unmentioned, door, radius, find+verify, questions, depth. Gated behind `--evidence` so the data still exists when we come back. No new work on them until the Done gate below passes.
- **Removed**: `findImporters`. Stem matching is wrong in every monorepo we care about and nothing downstream survives without it.

Reconsider claims/grounding after the gate, with the three evaluation reports as the baseline: the question then is "does ✓/✗ on good cards save time", which v1 never got to ask.

## Done when

On the same three PRs plus three fresh ones, re-run through the same evaluator prompt:
- grouping and prose each score ≥ 4/5 on every PR;
- no card's paragraph contains a sentence the evaluator marks wrong;
- no mechanical card contains a block the evaluator calls behavioural;
- the card a human would read first is the first card;
- `lookout <pr> --json` under 10 s on a 20-file PR.

## Steps

Each ends with a check. `bun run typecheck` and `bun test` pass before every commit.

**15. Grouping benchmark.** `fixtures/grouping/<name>.json`: for a diff, a hand-judged target `{ concern: string, blockIds: string[] }[]` plus `mechanical: blockIds[]` (blocks a reviewer would accept as "unchanged behaviour"). Targets for this repo's own commits are committed; targets for the three external PRs live in `~/.cache/lookout/bench/` (block ids and labels only, but keep them out of the repo). `scripts/grouping-score.ts <repo> <target>` runs the real pipeline and prints: pairwise block agreement with the target (ARI), largest-card size vs target, and **mechanical leaks** (blocks in a mechanical card that the target calls behaviour). Check: script runs on 6 targets; current scores recorded in `docs/handoff.md` as the baseline.

**16. Mechanical guard (rules bound the model).** A block keeps a mechanical kind only when rules can confirm it; otherwise it becomes `behavior` and the model's label is kept as `suggestedKind` for the debug view.
- `rename`: a consistent one-to-one identifier substitution maps every removed line onto an added line (whitespace-normalised). `deps(ws, id)` → `depsByField(ws, id)` passes; `[…, id, 'dependencies']` → `[…, 'dependencies', id]` fails.
- `typing-refactor`: added and removed lines are equal after stripping type annotations, generics, `as` casts and `import type`; any literal, call or operator difference fails. a 5-minute timeout constant fails (it is additive).
- `move`: the removed text appears verbatim elsewhere in the diff's added lines.
Check: 0 mechanical leaks on all 6 targets; `fixtures/rule-cases.ts` gains adversarial rename/typing cases (reordered array, changed literal, dropped argument); existing kind tests still pass.

**17. Ownership before kind.** Blocks that cannot stand alone join the card that owns their file rather than forming or joining a kind card: import-only blocks, `export { … }` lines, a lone type/interface whose name appears in another block of the same file, prop destructures whose prop is added in the same PR. "Owner" = the non-mechanical card with the most blocks in that file, else the file's only card. Check: no card in the 6 targets consists only of imports/exports/a single type; #3309 drops from 6 cards to 4; #1128's a header component is one card.

**18. Blob splitting (LLM proposes, rules check).** A behaviour group with > 8 blocks or > 3 files is a *blob*. One `generateText` call per blob gets the blob's edits with block ids and must return concerns: `{ title, blockIds }[]`, 2–6 of them, each block exactly once. Rules validate (all ids present, none repeated, none foreign; a concern with one block is merged into its nearest neighbour) and fall back to per-file groups when the answer is unusable. Decisions then asks one `boolean` per concern pair "are these the same change" to re-merge over-splits. Cached by blob id. Check: on #1128 the 59-block card becomes separate concerns for move orchestration, stale-move rollback, storage scope rewrite, run-start guard, and UI, matching the target; on #822 invalidation narrowing is its own card; ARI ≥ 0.8 on all 6; blob calls add ≤ 3 s.

**19. Card-shape writers.** The writer prompt is chosen by card shape, and every prompt gets the file path, the enclosing symbol (from context lines) and the hunk header, not edits alone.
- behaviour: first sentence is *what changes for the caller or user*, then how, then what is not covered by tests in this card.
- config/infra: must name the environment, the key and the consumer (the `servedTools` entry of the `stage` policy), and say what turning it back off takes.
- mechanical: template as today, now trustworthy because of step 16.
- test: what it pins, which card it covers.
Then one Decisions `boolean` per paragraph: "does every statement follow from these edits" — below 0.7 the paragraph is rewritten once with the failing sentence quoted; still below, the card shows the title only with `paragraph unverified`. Check: on the 3 evaluated PRs the four quoted wrong sentences do not recur; #3309's config card names `stage`; mock tests for the rewrite loop.

**20. Colour and order from the card, not the file.** Rules: a card whose blocks write to a datastore in place (`UPDATE`/`REMOVE`/`UpdateExpression`, migrations), remove a public export from `packages/*/src`, `index.*`, `api/`, or change a routing/served-tools list is at least amber, red when it also carries `needs-eyes`. Stack order: red → amber by block count → green, mechanical and docs last. The reused door-signal detector moves into `cards/` as card labels; no verdict section. Check: #1128's key-value store card is red and first; #3309's infra card is first; tier survey over 30 commits of this repo unchanged for low/medium.

**21. Trim the TUI and JSON.** Remove the claims view, radius row, questions and finding glyphs from the default render (they return under `--evidence`). Card JSON gains `files: string[]` and `suggestedKind`. Header: cards · time · model. Check: TUI tests at narrow/wide pass; story `review-a` reads clean; boundary test unchanged.

**22. Done gate.** Run the evaluator prompt from this session (`/tmp/lookout-eval/` reports hold the baseline) on the 3 PRs plus 3 fresh ones from production repos (the list is kept outside the repo in `~/.cache/lookout/bench/targets.txt`). Record scores in `docs/handoff.md`. Only then decide which of claims, door, find+verify come back, in that order of evidence.

# v3: point at the risk

Step 22 did not pass (grouping 2–4, prose 3–4; `docs/handoff.md`). A probe over five fresh PRs of a production repo (2–56 files, 8–44 s; `docs/handoff.md` "Probe, 2026-11-07") found the prose accurate on every statement checked, and three things wrong that no amount of grouping polish fixes:

| Failure | Where it showed | Root cause in code |
|---|---|---|
| Red goes to the wrong card | Two PRs: the only red card is prompt text (`**/prompts/**`, attention `routine`); the enforcement change the reviewer found a bug in is amber, below it | `colorFloor` reddens any behaviour card in a sensitive area regardless of attention; `compareCards` sorts colour first |
| Tests shatter | 9 files → 14 cards, 7 of them test cards from one test file; 4 files → 6 cards | test blocks group by kind and proximity, never by what they pin; `markTests` knows (`exercises`) but runs after grouping |
| Trivia gets a card | a one-character ` \| ` → `\|` edit in a decision record, an `updated:` date bump, a lone `import type` | `isFragment` missed the import (type import in a file whose owner card is elsewhere); no inert rule for whitespace/punctuation-only edits in doc files |

And one thing missing: on a repo whose PR bodies are good, cards restate the body. The value is in what the body does not say (a stowaway formatting edit in a feature PR). `--evidence` tried to answer that with a model and got it wrong (a true "EU and US are unchanged" marked ✗ at 0.84; 16/34 cards "unmentioned" on a fully described PR). It stays dormant.

## Done when

On the five probe PRs (ids in `~/.cache/lookout/bench/probe.txt`) and the next five merged PRs of the same repo:
- the first card is the one a reviewer would read first (the behaviour change with the highest attention, not a path hit) on every PR;
- no PR has more than one test card per production card it pins, and none has a card that is only an import, a date, or punctuation;
- every behaviour card that narrows, removes or widens something callers rely on carries a one-line risk reason; no mechanical or docs card does;
- the header counts the cards the PR body does not mention, and on the probe PRs that count is exactly the stowaways (1 on the 56-file PR, 0 on the rest);
- `bun run check` green; `bun run story review-a` reads clean.

## Steps

Steps 23–26 are independent slices (one issue each); they touch `cards/build.ts` in different functions, so merge in order 23 → 24 → 25 → 26 and rebase the later ones.

**23. Attention before area.** In `colorFloor`: a sensitive area makes a `routine` behaviour card amber, not red; `needs-eyes` behaviour is red when it is in a sensitive area and amber otherwise; `suspicious` stays red everywhere. Tests, docs, mechanical and plumbing rules unchanged. In `compareCards`, within a colour, attention ranks before the toggle-first and skim keys. The invariant holds: rules set the floor, the model only raises attention. Check: unit cases in `test/cards.test.ts` for each (attention × area × kind) cell; `scripts/tier-survey.ts` over 30 commits of this repo unchanged; on probe PR #3701 the `field-mutation` refusal card is first and the prompt-text card is amber; on #3699 the context-list removal outranks the prompt card.

**24. Tests join the card they pin.** Move `exercises` from `evidence/tests.ts` into grouping: after kind and ownership (steps 16–17) and before splitting, a test block whose added lines name a changed identifier or the file stem of exactly one non-test group joins that group; test blocks that resolve to no group or to several form one test group per directory. `markTests` keeps `covers`/`testsTouched` for the JSON but reads the result rather than recomputing it. Also: a lone `import`/`import type` block joins its file's owner card even when the owner is a different kind (the `chat-deps.ts` miss), and a block whose non-context lines differ from their counterparts only in whitespace or punctuation in a `.md` file is inert. Check: `fixtures/grouping/` targets gain the test blocks as members of the concern they pin, purity does not drop on any of the 6 targets; on probe PR #3699 cards ≤ 7 with one test card; on #3697 ≤ 3; no card in the 5 probe PRs is a lone import; `bun run grouping-bench` recorded in `docs/handoff.md`.

**25. Risk line from the model, inside the invariant.** New `src/cards/risk.ts`: for each behaviour card (not mechanical, test, docs or config) one Decisions call over the card's edits plus the enclosing symbols: `score` "does this change narrow, remove or widen something existing callers or users rely on" and, when ≥ 0.7, one `generateText` sentence naming what and for whom, gated by `unsupportedNames` and the existing consistency check. The sentence becomes `Card.risk`; a card with a risk floors at amber (a raise, so allowed) and `compareCards` ranks risk-bearing cards first within a colour. Cached by card id with a prompt version. TUI: the risk line renders under the title before the paragraph, dimmed when the gate failed. Check: mock-model tests for score below/above threshold and a gated sentence; on probe PR #3701 the refusal card and on #3699 the dashboard removal carry a risk line; no mechanical or docs card in the 5 probe PRs does; adds ≤ 3 s cold on a 20-file PR (runs in parallel with prose).

**26. Body versus diff, deterministic.** `src/cards/mention.ts`: from `changeSet.intent.body`, collect file paths (any token containing `/` that matches a changed file's suffix) and backticked identifiers; a card is *mentioned* when any of its files or changed identifiers appears. No model, no claim statuses. `Review.unmentionedCount` and `Card.mentioned` land in the JSON; the header shows `N not in body` when N > 0; the TUI marks unmentioned cards with a word (`body: no`), not only a colour. Mechanical, docs and test cards are never counted. Replaces the model-driven `unmentioned` under `--evidence` for the default path; the `--evidence` flag is untouched. Check: unit tests over a fixture body; on probe PR #3703 the count is 1 (the Intercom formatting stowaway); on #3697, #3699, #3701, #3705 it is 0.

**27. Re-probe.** Run the five probe PRs and the next five merged PRs; record first-card correctness, card counts, risk-line hits and misses, and the not-in-body count in `docs/handoff.md`. Then write `scripts/review-recall.ts`: for merged PRs with human review comments, map each comment's file:line to a card and count whether the card was non-green or its risk line named the thing. That number replaces the persona gate.

# v4: one level up

v3 is tagged `v3-checkpoint`. Steps 23–27 fixed what the evaluators named: the first card is the one to read first on 10/13 out-of-sample PRs, risk lines fire on 43 % of behaviour cards and were right every time read, and review recall is 0.75 on 15 PRs. Two things stayed wrong after dogfooding, and neither is a grouping or ordering problem:

1. **The card is too low level.** Its paragraph is the diff translated to English ("`DataContextServiceImpl` now fetches only workspace metadata and `explorer.listExplorerViews(workspaceId)` with `Promise.allSettled`"). Every probe where the author had written a /pr-style diff sketch, the sketch beat the stack. The level a reviewer wants sits between the sketch and the hunk: the program's shape with `+`/`-` on it.
2. **The screen shows the machinery.** `HIGH · 2 humans · 4 cards · rules+openai:gpt-6-luna`, badges `sensitive`, `added`, `test`, `lockfile`. These are v1 policy-gate ideas and internal labels. A reader needs colour, kind, area, risk and shape.

## Done when

On the five probe PRs and the 13 out-of-sample PRs (`~/.cache/lookout/bench/probe.txt`, `probe2.txt`):
- the stack opens on a change map (one diff-shaped sketch of the whole PR, ≤ 20 lines) whose nodes are the cards; every identifier in it is in the diff;
- each card above two blocks shows a sketch instead of a paragraph; every identifier in a sketch is in the card's edits or their context lines, every `+`/`-` line maps to an added/removed symbol, else the sketch is marked unverified;
- the header shows the target, the elapsed time while running and `N not in body` only when the body names a path or identifier; no tier, humans, card count or model name on the default screen;
- card badges are colour word, kind, area (`auth/*`), `body: no`, nothing else;
- `bun run recall` on the 15 baseline PRs does not drop below 0.75; the TUI tests pass at 80×24 and 140×45.

## Steps

**28. Fewer elements.** Header: title · progress/elapsed · `N not in body` (only when `mention.ts` found at least one path or backticked name in the body). Tier, humans, card count and model move to `--json` and to the `?` help screen's last line. Card badges: colour word, kind, area, `body: no`; drop `sensitive`, `added`, `test`, `lockfile` and every other label from the default render (labels stay in JSON). Check: TUI tests updated at both sizes; `bun run story review-a` shows nothing from the removed list; JSON unchanged.

**29. Card sketch.** `src/cards/sketch.ts`: for a non-mechanical card above two blocks, one writer call asks for a diff-shaped sketch (≤ 12 lines) in the shape the card's kind suggests: call tree or control flow for behaviour, key tree for config, component tree for `.tsx`, file tree for a refactor; `+`/`-` prefixes mark what the change adds or removes, unprefixed lines are kept context. Rules gate it: every identifier appears in the card's edits or their context lines (`unsupportedNames` extended with context); every `+` line names something in an added line and every `-` line something in a removed line; otherwise one rewrite quoting the offending lines, then `sketchUnverified`. Decisions consistency check as for paragraphs. Cached by card id with a prompt version. The paragraph is still written and kept in JSON; the TUI shows the sketch in the stack and the paragraph only in the expanded card under the hunks. Check: mock tests for the two gates and the rewrite; hand-written target sketches for six probe cards in `fixtures/sketches/` (this repo's own commits only) with a test that the gate accepts them; live on the five probe PRs, paste every sketch in the PR.

**30. Change map.** `src/cards/map.ts`: one writer call over every card's title, risk line and sketch (not the diff) asks for the PR's shape as one sketch ≤ 20 lines, each card appearing as one node or `+`/`-` line, in the order of the stack. Gate: every identifier is in some card's sketch or the diff; every card title or one of its identifiers appears; otherwise one rewrite, then no map (the stack opens as today). `Review.map`, event `map.updated`. TUI: the map renders above the stack, selected card's node highlighted with a glyph, `m` toggles it. Check: mock tests; TUI tests at both sizes with and without a map; live on the five probe PRs and three of the out-of-sample ones.

**31. Re-probe and recall.** The five probe PRs and the 13 out-of-sample ones through the new stack, read by hand; `bun run recall --prs 15`; record both in `docs/handoff.md`. Decide whether the paragraph writer still earns its call.

## What stays true from v1

Deterministic → Decisions → LLM; rules bound the model (a model may raise attention, never lower it; only rules call a block inert or a card mechanical); `Result` for expected failures; one `ReviewSession` contract; TUI tests on one deterministic frame; fixtures are this repo's own commits. Step 18 is the one place an LLM proposes structure, and it is followed by typed validation, as `AGENTS.md` requires.

## Roadmap (unchanged, pushed back)

Claims and grounding on good cards; door and radius as card labels only; find+verify with a time budget; questions; depth; `--html`; `serve`/`--connect`; AST-level blocks; splitting a block across cards; GitHub comments; convergence; metrics.

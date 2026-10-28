# lookout — v2: cards first

v1 built the whole north light (cards, claims, door, radius, find+verify, questions). Three production PRs (PR A, PR B, PR C; reports in `/tmp/lookout-eval/`) scored it 3/3/2 out of 5, and every evaluator named the same cause: the cards are wrong before anything downstream runs. v2 narrows to one question — **can a reviewer understand a PR from the card titles and paragraphs alone?** — and measures it before anything else gets attention back.

## What v1 got wrong, by evidence

| Failure | Where it showed | Root cause in code |
|---|---|---|
| Mechanical card hides behaviour, template says "behaviour is unchanged" | #822 "Rename across 6 files" holds cache-key *value* changes; #1128 "Typing refactor" holds `_STALE_MOVE_AFTER = 5min` and nullable signatures | `group.ts` trusts the Decisions `kind` per block; nothing checks a rename is a rename |
| One amber blob holds all the risk | #822 24 blocks; #1128 ~59 blocks / 15 files incl. non-transactional DynamoDB rewrites; nothing red | rule 3 + rule 4 union-find is transitive: a shared identifier chains a whole feature |
| Lone fragments become cards | `a request model` type card, `export {…}` lines as "Rename in the deployment file", ChatHeader over 3 cards | no "join the card that owns this file" rule; kind decides before context |
| Config card misses the fact that matters | #3309 never says *stage*, nor `servedTools` vs `tools`, nor preview runtimes | writer sees edits only, no file context; no card-shape-specific prompt |
| One factual error per PR in prose | "`commit_promotion` is replaced by `clear_promotion`" (it is added) | no check that the paragraph's claims are in the diff |
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

**15. Grouping benchmark.** `fixtures/grouping/<name>.json`: for a diff, a hand-judged target `{ concern: string, blockIds: string[] }[]` plus `mechanical: blockIds[]` (blocks a reviewer would accept as "unchanged behaviour"). Targets for this repo's own commits are committed; targets for the three external PRs live in `~/.cache/lookout/bench/` (block ids and labels only, but keep them out of the repo). `scripts/grouping-score.ts <repo> <target>` runs the real pipeline and prints: pairwise block agreement with the target (ARI), largest-card size vs target, and **mechanical leaks** (blocks in a mechanical card that the target calls behaviour). Check: script runs on 6 targets; current scores recorded in `HANDOFF.md` as the baseline.

**16. Mechanical guard (rules bound the model).** A block keeps a mechanical kind only when rules can confirm it; otherwise it becomes `behavior` and the model's label is kept as `suggestedKind` for the debug view.
- `rename`: a consistent one-to-one identifier substitution maps every removed line onto an added line (whitespace-normalised). `dependencies(ws, id)` → `dependenciesByField(ws, id)` passes; `[…, id, 'dependencies']` → `[…, 'dependencies', id]` fails.
- `typing-refactor`: added and removed lines are equal after stripping type annotations, generics, `as` casts and `import type`; any literal, call or operator difference fails. `_STALE_MOVE_AFTER = timedelta(minutes=5)` fails (it is additive).
- `move`: the removed text appears verbatim elsewhere in the diff's added lines.
Check: 0 mechanical leaks on all 6 targets; `fixtures/rule-cases.ts` gains adversarial rename/typing cases (reordered array, changed literal, dropped argument); existing kind tests still pass.

**17. Ownership before kind.** Blocks that cannot stand alone join the card that owns their file rather than forming or joining a kind card: import-only blocks, `export { … }` lines, a lone type/interface whose name appears in another block of the same file, prop destructures whose prop is added in the same PR. "Owner" = the non-mechanical card with the most blocks in that file, else the file's only card. Check: no card in the 6 targets consists only of imports/exports/a single type; #3309 drops from 6 cards to 4; #1128's ChatHeader is one card.

**18. Blob splitting (LLM proposes, rules check).** A behaviour group with > 8 blocks or > 3 files is a *blob*. One `generateText` call per blob gets the blob's edits with block ids and must return concerns: `{ title, blockIds }[]`, 2–6 of them, each block exactly once. Rules validate (all ids present, none repeated, none foreign; a concern with one block is merged into its nearest neighbour) and fall back to per-file groups when the answer is unusable. Decisions then asks one `boolean` per concern pair "are these the same change" to re-merge over-splits. Cached by blob id. Check: on #1128 the 59-block card becomes separate concerns for move orchestration, stale-move rollback, storage scope rewrite, run-start guard, and UI, matching the target; on #822 invalidation narrowing is its own card; ARI ≥ 0.8 on all 6; blob calls add ≤ 3 s.

**19. Card-shape writers.** The writer prompt is chosen by card shape, and every prompt gets the file path, the enclosing symbol (from context lines) and the hunk header, not edits alone.
- behaviour: first sentence is *what changes for the caller or user*, then how, then what is not covered by tests in this card.
- config/infra: must name the environment, the key and the consumer (`servedTools["web"]` of the `stage` policy), and say what turning it back off takes.
- mechanical: template as today, now trustworthy because of step 16.
- test: what it pins, which card it covers.
Then one Decisions `boolean` per paragraph: "does every statement follow from these edits" — below 0.7 the paragraph is rewritten once with the failing sentence quoted; still below, the card shows the title only with `paragraph unverified`. Check: on the 3 evaluated PRs the four quoted wrong sentences do not recur; #3309's config card names `stage`; mock tests for the rewrite loop.

**20. Colour and order from the card, not the file.** Rules: a card whose blocks write to a datastore in place (`UPDATE`/`REMOVE`/`UpdateExpression`, migrations), remove a public export from `packages/*/src`, `index.*`, `api/`, or change a routing/served-tools list is at least amber, red when it also carries `needs-eyes`. Stack order: red → amber by block count → green, mechanical and docs last. The reused door-signal detector moves into `cards/` as card labels; no verdict section. Check: #1128's DynamoDB card is red and first; #3309's infra card is first; tier survey over 30 commits of this repo unchanged for low/medium.

**21. Trim the TUI and JSON.** Remove the claims view, radius row, questions and finding glyphs from the default render (they return under `--evidence`). Card JSON gains `files: string[]` and `suggestedKind`. Header: cards · time · model. Check: TUI tests at narrow/wide pass; story `review-a` reads clean; boundary test unchanged.

**22. Done gate.** Run the evaluator prompt from this session (`/tmp/lookout-eval/` reports hold the baseline) on the 3 PRs plus 3 fresh ones from `production repos`. Record scores in `HANDOFF.md`. Only then decide which of claims, door, find+verify come back, in that order of evidence.

## What stays true from v1

Deterministic → Decisions → LLM; rules bound the model (a model may raise attention, never lower it; only rules call a block inert or a card mechanical); `Result` for expected failures; one `ReviewSession` contract; TUI tests on one deterministic frame; fixtures are this repo's own commits. Step 18 is the one place an LLM proposes structure, and it is followed by typed validation, as `AGENTS.md` requires.

## Roadmap (unchanged, pushed back)

Claims and grounding on good cards; door and radius as card labels only; find+verify with a time budget; questions; depth; `--html`; `serve`/`--connect`; AST-level blocks; splitting a block across cards; GitHub comments; convergence; metrics.

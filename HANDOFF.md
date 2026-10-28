# Handoff

State of lookout for the next session. `PLAN.md` is the spec, `GLOSSARY.md` the vocabulary, `AGENTS.md` the working rules. Read those three first; this file is what they don't say.

## Where we are

Steps 1–13 of `PLAN.md` are done and committed. `bun run typecheck` is clean and `bun test` passes (292 tests, no network).

What works end to end today, `lookout <range | PR>`:
1. Diff → edit blocks (contiguous +/- runs) → rules (path labels, whitespace/comment detection, inert).
2. One Decisions call per 8 blocks: attention score + **kind** (`typing-refactor | rename | move | behavior | test | types | config | docs`).
3. Deterministic grouping into cards: kind first; punctuation-only orphans join their hunk neighbour; mechanical kinds form one card per kind across all files; others merge by hunk proximity or a shared changed identifier.
4. Mechanical cards get template prose; every other card gets a title + ≤3-sentence paragraph from `gpt-6-luna` at `reasoningEffort: low`, in parallel, cached by card id.
5. Policy (`.lookout.toml` over `~/.config/lookout/config.toml`): areas, kind defaults, floors → tier + required humans.
6. Evidence (`src/evidence/`): claims from the PR body's bullets (model only when the summary is prose or a `/pr` diff sketch), grounded in one Decisions call with a confidence gate; unmentioned cards; tests touched / covers per card; door signals; blast radius (areas + `git grep` importers). `c` opens the claims view.
7. Ink single-column stack TUI; `--json` for everything else.
8. Find + verify (`src/verify/`): `a` runs the proposer on a card, dedupes its findings against the card (same anchor, half the title words), then a verifier dispatch that must `confirmed` with evidence / `rejected` with a reason / `unsure`. One Decisions `boolean` per argued verdict scores whether the note holds; < 0.7 → `unsure` with the gate in the note. Findings anchored to context lines are `preExisting`. Default view: confirmed `✓✓`, proposed `✓`, unsure p0/p1 dimmed `?`; rejected/duplicates/unsure p2 behind `--all`. `[verify] dispatcher` picks the verifier (default: first dispatcher).
9. Questions (`src/questions/`): 12-entry bank with tier + rule filters; one Decisions `boolean` per (card, candidate) after grounding; top 2–4 at p ≥ 0.5, min 2. `y/n/u` in the expanded card answer the first open one (`?` is help, hence `u` not `?`). Rules-only fallback: first 3 candidates in bank order.

Timing with the model: 4–7 s for typical PRs, ~10 s for a 101-file refactor (218 blocks → 9 cards). Grounding adds ~0.3–1 s; claim extraction by the model runs in parallel with the paragraphs.

## Decisions worth not re-litigating

- **Not a diff browser.** A lazygit-style TUI was built, judged "a worse git client", and deleted. Cards over logical changes are the product; the diff is the appendix inside an expanded card.
- **Deterministic → Decisions → LLM.** The first design (LLM grouping + paragraphs) took 65 s and grouped worse. Decisions nails the refactor/behavior split in ~2 s; identifier-based grouping only works *after* kind is known.
- **One model id**: `openai:gpt-6-luna` is the only Decisions model and, at low reasoning, wrote the tightest paragraphs of five tried. `[model] decide` / `write` can split them.
- **Rules bound the model**: a model may raise attention/color and never lower it; only rules may call a block inert or a card grey.
- **Errors**: expected failures return `Result` (`core/result.ts`); only `cli/main.ts` catches.
- **TUI tests** follow opencode's method: real `App` against a `FixtureSession`, one deterministic frame, injected size/frame/throttle, keys via stdin, signal-based waits, narrow + wide. `bun run story review-a --paragraphs` to eyeball.
- **Fixtures are reviews of this repo's own commits** (`fixtures/*.diff`, `fixtures/reviews/*.json`). Never commit another organisation's code or PR text. `review-c` carries a hand-written PR body (about our own commit) with grounded claims, for the TUI tests.
- **Claims are bullets, not an LLM pass** (0.4 ms vs 18 s). The model is asked for claims only when the summary has no bullets; a `/pr` diff sketch in a fence is the input then, and luna turns it into 4–5 accurate claims.
- **The ✗ gate is prompt + threshold, and both mattered.** With the first prompt luna called two true absence claims ("there is no deprecated alias", "only imports and names change") contradicted at 0.93 and 0.76 on a 101-file rename, because `@deprecated` comments elsewhere resembled the words. The criteria now say contradiction needs a specific edit that makes the claim false; those became `not-in-diff` at ~0.5. Grounding cache keys carry a prompt version (`ground-v2`) so a sharper question is never answered from an old cache.
- **`Before: … After: …` evidence bullets keep only the After.** The Before is the old state; the diff only shows it as removed lines, which luna read as contradiction.
- **Door and radius are not model calls for the verdict.** Door is rules (signals in the diff); the author's word is a claim judged by rules. Radius: areas + importers are computed; only the author's one-word description is a Decisions question against the computed radius.
- **A sensitive area reddens only behaviour cards.** On an earlier production PR the old rule painted 5 of 8 cards red; three were a test card, a rename and a lone `import type`. Now tests, mechanical edits and docs in an area stay green with the area badge, config plumbing there is amber, behaviour is red. Five rule variants were scored against a hand-judged target over that PR plus four PRs of a frontend monorepo; this one scored 0 with no regressions. Tier floors unchanged (still HIGH · 2 humans). Not done, noted for grouping: an import-only block should join the card that owns its file; a mechanical card hiding one net-new statement (`createLogger('dashboard-commands')` inside a 63-file rename) should eject that block rather than lose its template.
- **Verifier verdicts are gated by Decisions, not trusted.** On the first real run the verifier confirmed 8 of 9; the `boolean` "does the note establish the verdict" question put 65/48/29 % on three of them and those were the three a human would have shrugged at. Keep the gate at 0.7 until more data says otherwise.
- **Questions are rules then Decisions, never free text.** The bank is fixed (12); rules filter by tier and card shape; the model only ranks. A card with one candidate gets one question.
- **Removed exports count as one-way only in public-looking files** (`index.*`, `api/`, `sdk/`, `packages/*/src`). Internal renames in this repo produced false one-way doors otherwise.

## Known rough edges (not bugs to fix blindly)

- Decisions sometimes mislabels a kind (a behavior block called `docs` on one PR). Only mechanical kinds get the "behaviour unchanged" template, so the damage is a wrong color, not a wrong claim.
- Default `auth` area globs (`**/*token*`, `**/session/**` …) are broad; some test/docs cards go red by path. Repo `.lookout.toml` fixes it per repo; defaults may want narrowing with more data.
- The attention question seems to favour the largest edit of a change. Watch it once paragraphs let you read cards quickly.
- Mechanical cards group per kind across *all* files. A rename in one unrelated file would be folded into the big rename card.
- True claims sometimes land as `not-in-diff` at ~0.5 rather than `supported` (absence claims about a 60-file rename). Not red, but not a tick either; more data before touching the gate.
- The radius claim is often `not-in-diff`/`unclear`: a one-word author description ("local", "chat cards") against areas + importers is a weak question. Importers are computed from the local checkout; a stale clone gets a warning in the radius row rather than a wrong count.
- Tests touched is deterministic (same dir, name stem, import in the test's added lines). A test file that already imported the code and only adds a case is matched by stem or directory only; the "Decisions for ambiguous" half of the plan is not built.
- Mechanical cards are never unmentioned, and nothing is unmentioned until grounding has landed (otherwise every card is unmentioned for a few seconds).

## Step 13 check, as run

Fake scripts: `fixtures/fake-verifier.sh <prompt> confirm|reject|unsure|mixed|malformed|silent` next to `fake-dispatcher.sh`; `test/verify.test.ts` covers parse (confirmed without evidence → unsure, unknown/repeat ids, missing ids stay proposed), dedupe, pre-existing, the gate with a mock model, config, and the session chain (proposer → verifier → `finding.updated`; second `a` drops the repeat and skips the verifier). On our own `d159204` (evidence commit), card 1 with `pi` as both roles: 9 proposed in 96 s, verifier 378 s (it ran Bun snippets to prove things), 8 confirmed + 1 unsure; the gate downgraded 3 confirmed at 65/48/29 %. The 5 that stayed `✓✓` are all real and actionable (listed under follow-ups below); the two hidden ones were the weakest. Questions landed on 5 of 6 cards (docs card: no candidates).

### Follow-ups the verifier found in `src/evidence/` (not fixed; real)

- `session.assemble()` copies `previous.radius.importers` but not `warning`; a stale-checkout or git-failure warning is lost when the model update rebuilds the Review, and the claims view shows `importers…` forever (session.ts).
- `attachDoorSignals.owner()` matches a signal's line against both `newRange` and `oldRange`; add-line signals should use new, removed-export/route old (door.ts).
- `stillExported` builds a RegExp from an unescaped identifier; `$` in a name makes a kept export a false removed-export door (door.ts).
- `tests.exercises()`: `dirOf` is `""` for root-level files, so any root-level test covers every root-level file (tests.ts).
- `cleanBullet`'s Before/After rewrite has no word boundary: "Beforehand … afterwards" is mangled (claims.ts).
- Weaker (gated to unsure): deleted files counted as "not in this checkout"; grounding cache key for the radius claim ignores importers; bullets under `## Merge Danger` become summary claims.

## Step 12 check, as run

Mock tests cover: bullet extraction incl. a no-evidence claim (card `none`), a `contradicted` at 0.5 gated to unclear, an uncovered needs-eyes card flagged unmentioned, door signals incl. a test block ignored, importers in a temp git repo, and the session wiring (claims at once, grounding after prose, `claim.updated` / `evidence.updated` events). On four production PRs (1–101 files) after the prompt fix there were no false ✗; against a hand-written body with two false claims about our own `user-env` commit luna gave ✗ at 0.99 and 0.94, the true claim ✓ 0.99, the PATH claim `not-in-diff`.

## Next: Step 14, depth + timing

`--depth quick|standard|deep` (CLI, config, or policy rule per area): quick = no agents; standard = proposer + verifier on red/amber up front (what `A` does today); deep = all proposers, second verify round on `unsure` only. `setDepth` command exists as a stub returning an error. Header shows DEPTH, agent count and time. Check: quick makes 0 agent runs; deep re-verifies only `unsure`; header matches the log. Timing note: a real `pi` verifier took 6 min on one card because it ran code to prove things; a time budget or a lighter verifier prompt may be needed before `A` is pleasant.

Design notes to keep: `dispatch/` never imports `verify/` (the verify job carries its prompt; the session parses verdicts), so there is no sibling cycle. Decisions scoring of verdicts is not cached (findings differ per run). Dedupe marks the repeat `rejected` with `verifierNote: "duplicate of <id>"` rather than a new status.

## Environment

- `~/.bun/bin` on PATH (`bun link` installs `lookout`); `~/.config/lookout/.env` holds `OPENAI_API_KEY` and is loaded by `src/cli/env.ts`.
- `scripts/inert-audit.ts <repo> [n]` and `scripts/tier-survey.ts <repo> [n]` run read-only over any repo's recent commits; use them as the data checks in `PLAN.md`.
- Remote: private GitHub repo `nicksenap/lookout`.

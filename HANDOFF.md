# Handoff

State of lookout for the next session. `PLAN.md` is the spec, `GLOSSARY.md` the vocabulary, `AGENTS.md` the working rules. Read those three first; this file is what they don't say.

## Where we are

Steps 1–12 of `PLAN.md` are done and committed. `bun run typecheck` is clean and `bun test` passes (270 tests, no network).

What works end to end today, `lookout <range | PR>`:
1. Diff → edit blocks (contiguous +/- runs) → rules (path labels, whitespace/comment detection, inert).
2. One Decisions call per 8 blocks: attention score + **kind** (`typing-refactor | rename | move | behavior | test | types | config | docs`).
3. Deterministic grouping into cards: kind first; punctuation-only orphans join their hunk neighbour; mechanical kinds form one card per kind across all files; others merge by hunk proximity or a shared changed identifier.
4. Mechanical cards get template prose; every other card gets a title + ≤3-sentence paragraph from `gpt-6-luna` at `reasoningEffort: low`, in parallel, cached by card id.
5. Policy (`.lookout.toml` over `~/.config/lookout/config.toml`): areas, kind defaults, floors → tier + required humans.
6. Evidence (`src/evidence/`): claims from the PR body's bullets (model only when the summary is prose or a `/pr` diff sketch), grounded in one Decisions call with a confidence gate; unmentioned cards; tests touched / covers per card; door signals; blast radius (areas + `git grep` importers). `c` opens the claims view.
7. Ink single-column stack TUI; `--json` for everything else. `a` dispatches a configured agent on a card (proposer only; no verifier yet).

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

## Step 12 check, as run

Mock tests cover: bullet extraction incl. a no-evidence claim (card `none`), a `contradicted` at 0.5 gated to unclear, an uncovered needs-eyes card flagged unmentioned, door signals incl. a test block ignored, importers in a temp git repo, and the session wiring (claims at once, grounding after prose, `claim.updated` / `evidence.updated` events). On four production PRs (1–101 files) after the prompt fix there were no false ✗; against a hand-written body with two false claims about our own `user-env` commit luna gave ✗ at 0.99 and 0.94, the true claim ✓ 0.99, the PATH claim `not-in-diff`.

## Next: Step 13, find + verify + questions

`a`/`A` exist (proposer only). To build: `verify/` (verifier prompt: `confirmed` with evidence, `rejected` with reason, `unsure`; Decisions scores confidence; gate), dedupe by anchor + title before verifying, `pre-existing` for findings anchored to context lines, `questions/` (tier-specific bank, Decisions picks 2–4 per card, `y/n/?` in the expanded card). Check: fake proposer/verifier scripts (confirm/reject/unsure/malformed); on one PR `standard` yields only findings you'd act on; `--all` shows what was dropped and why. Then Step 14 (depth dials).

## Environment

- `~/.bun/bin` on PATH (`bun link` installs `lookout`); `~/.config/lookout/.env` holds `OPENAI_API_KEY` and is loaded by `src/cli/env.ts`.
- `scripts/inert-audit.ts <repo> [n]` and `scripts/tier-survey.ts <repo> [n]` run read-only over any repo's recent commits; use them as the data checks in `PLAN.md`.
- Remote: private GitHub repo `nicksenap/lookout`.

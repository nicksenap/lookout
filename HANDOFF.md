# Handoff

State of lookout for the next session. `PLAN.md` is the spec, `GLOSSARY.md` the vocabulary, `AGENTS.md` the working rules. Read those three first; this file is what they don't say.

## Where we are

Steps 1–11 of `PLAN.md` are done and committed. `bun run typecheck` is clean and `bun test` passes (246 tests, no network).

What works end to end today, `lookout <range | PR>`:
1. Diff → edit blocks (contiguous +/- runs) → rules (path labels, whitespace/comment detection, inert).
2. One Decisions call per 8 blocks: attention score + **kind** (`typing-refactor | rename | move | behavior | test | types | config | docs`).
3. Deterministic grouping into cards: kind first; punctuation-only orphans join their hunk neighbour; mechanical kinds form one card per kind across all files; others merge by hunk proximity or a shared changed identifier.
4. Mechanical cards get template prose; every other card gets a title + ≤3-sentence paragraph from `gpt-6-luna` at `reasoningEffort: low`, in parallel, cached by card id.
5. Policy (`.lookout.toml` over `~/.config/lookout/config.toml`): areas, kind defaults, floors → tier + required humans.
6. Ink single-column stack TUI; `--json` for everything else. `a` dispatches a configured agent on a card (proposer only; no verifier yet).

Timing with the model: 4–7 s for typical PRs, ~10 s for a 101-file refactor (218 blocks → 9 cards).

## Decisions worth not re-litigating

- **Not a diff browser.** A lazygit-style TUI was built, judged "a worse git client", and deleted. Cards over logical changes are the product; the diff is the appendix inside an expanded card.
- **Deterministic → Decisions → LLM.** The first design (LLM grouping + paragraphs) took 65 s and grouped worse. Decisions nails the refactor/behavior split in ~2 s; identifier-based grouping only works *after* kind is known.
- **One model id**: `openai:gpt-6-luna` is the only Decisions model and, at low reasoning, wrote the tightest paragraphs of five tried. `[model] decide` / `write` can split them.
- **Rules bound the model**: a model may raise attention/color and never lower it; only rules may call a block inert or a card grey.
- **Errors**: expected failures return `Result` (`core/result.ts`); only `cli/main.ts` catches.
- **TUI tests** follow opencode's method: real `App` against a `FixtureSession`, one deterministic frame, injected size/frame/throttle, keys via stdin, signal-based waits, narrow + wide. `bun run story review-a --paragraphs` to eyeball.
- **Fixtures are reviews of this repo's own commits** (`fixtures/*.diff`, `fixtures/reviews/*.json`). Never commit another organisation's code or PR text.

## Known rough edges (not bugs to fix blindly)

- Decisions sometimes mislabels a kind (a behavior block called `docs` on one PR). Only mechanical kinds get the "behaviour unchanged" template, so the damage is a wrong color, not a wrong claim.
- Default `auth` area globs (`**/*token*`, `**/session/**` …) are broad; some test/docs cards go red by path. Repo `.lookout.toml` fixes it per repo; defaults may want narrowing with more data.
- The attention question seems to favour the largest edit of a change. Watch it once paragraphs let you read cards quickly.
- Mechanical cards group per kind across *all* files. A rename in one unrelated file would be folded into the big rename card.

## Next: Step 12, evidence

Design is settled in `PLAN.md` ("Evidence") and in the measured experiment:
- **Claims**: split `- ` bullets of the PR body (drop bullets that are just a file path; flatten sub-bullets). LLM extraction only when a body has no bullets. Measured: 0.4 ms vs 18 s.
- **Grounding**: one Decisions call, two questions per claim: `status` choice (`supported | contradicted | not-in-diff`) and `evidence` choice over card ids. State = card titles + paragraphs + the diff. **Confidence gate**: show ✗ only ≥ 0.7; 0.4–0.6 renders as "unclear", not red. In the experiment the headline claim got ✗ at 50% while a true claim got `not-in-diff` at 76%, so the gate is not optional.
- **Unmentioned**: cards no claim points to, at needs-eyes or above → badge on the card.
- **Tests touched** per card (same dir / name stem / import; Decisions for ambiguous), **door** (one-way signals: migrations, deleted columns, public contract, data writes) and **blast radius** (author's word vs computed areas + importers) as rows in the expanded card and the header.
- Then Step 13 (find + verify: evidence-or-reject verifier, gate, dedupe, questions) and Step 14 (depth dials).

## Environment

- `~/.bun/bin` on PATH (`bun link` installs `lookout`); `~/.config/lookout/.env` holds `OPENAI_API_KEY` and is loaded by `src/cli/env.ts`.
- `scripts/inert-audit.ts <repo> [n]` and `scripts/tier-survey.ts <repo> [n]` run read-only over any repo's recent commits; use them as the data checks in `PLAN.md`.
- Remote: private GitHub repo `nicksenap/lookout`.

# AGENTS.md

Guidance for agents working in this repository. `PLAN.md` is the spec; `GLOSSARY.md` is the vocabulary. Read both before changing the model or the pipeline, and use the glossary's terms in code, comments and tests.

## Repository

- Bun + strict TypeScript, no build step. `bin/lookout` runs `src/cli/main.ts` directly.
- Dependency direction: `core` ← `sources`, `rank`, `policy`, `cards`, `evidence`, `dispatch`, `verify`, `questions` ← `tui`, `cli`. Nothing below `tui` may import `react` or `ink`; `src/tui/` may import only `core/session.ts`, `core/types.ts` and its own files. `test/boundaries.test.ts` enforces this.
- All `experimental_*` AI SDK usage lives in `src/rank/model.ts`. `ai` and every `@ai-sdk/*` package are pinned to exact versions; do not add a caret.
- Decisions API calls (`experimental_decide`) classify, score and verify. LLM calls (`generateText`) write prose and propose structure. Every free-text step is followed by a typed step that checks it. Do not use an LLM where a Decisions question will do.
- Config is TOML: `~/.config/lookout/config.toml`, then the repo's `.lookout.toml` layered on top. Validation is hand-written and names the exact key in every error. No zod.
- `git` and `gh` are shelled out to; parse only stable output (`--porcelain`, `--json`). No libgit2, no Octokit.

## Errors

- Expected, recoverable failures return `Result<T, E>` from `src/core/result.ts`: missing key, failed model call, `gh` missing, invalid config, unparseable agent output, a claim with no evidence. The pipeline degrades past them, usually to rules-only with a `warning`.
- Programmer errors and impossible states throw.
- Convert throwing library calls once, at the call site, with `attempt` / `attemptAsync`. Callers never see `try`/`catch`. `src/cli/main.ts` is the only place that catches everything.

## Style

- Keep things in one function unless composable or reusable. Do not extract single-use helpers preemptively; extract when the helper names a real concept (`requireConfig`, `isolateBlock`).
- Make the main function read as the happy path; move supporting detail into small helpers below it.
- Validate unknown values once at the boundary that owns them, then pass typed values inward. Do not revalidate what a type already guarantees.
- Before adding complexity for a speculative race or edge case, state the concrete failure mode and cost and get buy-in. Do not expand scope for theoretical robustness.
- Prefer `const`; use ternaries or early returns instead of reassignment. Avoid `else`. Avoid `any`.
- Prefer functional array methods over loops when they stay readable; use type guards on `filter`.
- Inline a value used once. Use dot notation rather than destructuring when it preserves context.
- Never alias imports, never star-import, never use type-position `import("...")`.
- Use Bun APIs when they exist (`Bun.file`, `Bun.spawn`, `Bun.TOML`, `Bun.CryptoHasher`).
- Comment non-obvious constraints and surprising behaviour, not control flow.
- Rules bound the model: a model may raise attention and never lower it, and only rules may call a block inert. Keep that invariant wherever ranking is merged.

## Testing

- `bun test` from the repo root. Tests never touch the network: use the SDK's mock decision/language models (`ai/test`) and fake dispatcher scripts in `fixtures/`.
- Test the real implementation; do not duplicate logic into tests. Avoid mocks beyond the model mocks; never patch `globalThis`.
- Rule-ranking cases live in `fixtures/rule-cases.ts` and are turned into genuine `git diff` hunks by the test. Add adversarial cases there, not ad-hoc strings.
- Diff fixtures are real `git` output. Agent-output fixtures are de-identified excerpts; strip anything that looks like a secret, a customer or internal code before committing.
- Scripts under `scripts/` are data checks against a real repo passed as an argument and are read-only there: never checkout, modify or commit in that repo.
- PTY smoke scripts must always end by sending `q` and be run under a timeout.

### TUI tests (adapted from opencode's method)

- Render the real `App` with `ink-testing-library` against a `FixtureSession` (`stories/fixture-session.ts`) over a saved Review in `fixtures/reviews/`. No git, models or agents in TUI tests.
- One frame, deterministic: always pass `size`, `frame` (spinner) and `throttleMs={0}` so a frame follows each event; assert on `lastFrame()` with ANSI stripped. Cover a narrow and a wide size (`describe.each`). Measure by counting rows and columns, never by timing.
- Wait on the signal, not on time: subscribe to the session event you expect (`dispatch.finished`, `card.updated`) and then paint one frame. A sleep is a bug waiting for a slower machine. If a wait needs a production constant, make the constant injectable instead.
- Drive keys through `app.stdin.write(...)`; `\r` enter, `\x1b` esc.
- Selection and status must be visible without color (a different bar glyph, a word), so stripped frames can assert on them and color-blind users can read them.
- Stories: `bun run story <fixture> [--size 100x30] [--paragraphs] [--slow]` runs the real App against a fixture in your terminal for eyeballing. Add a fixture by saving `lookout <target> --json` under `fixtures/reviews/`. Fixtures are reviews of this repo's own commits; never commit another organisation's code or PR text.

## Checks

- `bun run check` (typecheck with unused-import errors, biome lint, complexity gate, knip, tests, fixture drift) must pass before a commit; CI runs the same scripts as separate steps. Add a new check as a script in `package.json`, in `check`, and as a step in `ci.yml`. Biome formats at 140 columns; run `bun run lint:fix` before committing. Rules turned off on purpose: `noNonNullAssertion` (`x!` after a bounds check is the idiom here), `noAssignInExpressions` (union-find), `useIterableCallbackReturn`, `noControlCharactersInRegex` (ANSI), `noArrayIndexKey` and `useExhaustiveDependencies` (TUI rows are positional and memo deps are deliberate). `bun run hooks` installs the pre-commit fast subset.
- Max 3 attempts on the same failing command or approach, then stop and report what was tried.
- Each numbered step in `PLAN.md` ends with a check. Do not start step N+1 until step N's check passes.

## Commits

- One commit per completed plan step, `type(scope): summary` style: `feat(policy): …`, `fix(rank): …`, `test(blocks): …`, `docs: …`, `chore: …`.
- Never push and never create remotes unless asked.
- Never commit `.env` or anything under `~/.cache/lookout`. API keys live in `~/.config/lookout/.env` (`KEY=value`, mode 600), loaded by `src/cli/env.ts` at startup; shell variables win over the file.

// Story runner: render the real App against a saved Review, no git, models or agents.
// Usage: bun stories/run.ts [review-a|review-b|review-c] [--size 100x30] [--paragraphs] [--slow]
//   a asks a question (answered by a canned sentence after 1.2s); --paragraphs fills in sample paragraphs after 1.5s;
//   while pending, a fake progress bar walks ranking → writing.
import { runTui } from "../src/tui/App.tsx";
import { FixtureSession, loadReview } from "./fixture-session.ts";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--")) ?? "review-a";
const sizeArg = args[args.indexOf("--size") + 1];
if (args.includes("--size") && sizeArg) {
  const [c, r] = sizeArg.split("x").map(Number);
  Object.defineProperty(process.stdout, "columns", { value: c, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: r, configurable: true });
}
const slow = args.includes("--slow");
const review = await loadReview(name);
const pendingMs = slow ? 4000 : 800;
const session = new FixtureSession(review, { pendingMs, dispatchMs: slow ? 8000 : 2500, answerMs: 1200 });
// A fake pipeline for the eye: the bar walks ranking then writing and clears when `done` fires.
const steps = [{ phase: "ranking" as const, total: 3 }, { phase: "writing" as const, total: review.cards.length }];
const ticks = steps.reduce((n, s) => n + s.total + 1, 0);
let k = 0;
for (const step of steps) for (let d = 0; d <= step.total; d++) setTimeout(() => session.setProgress({ phase: step.phase, done: d, total: step.total }), (pendingMs * k++) / ticks);
setTimeout(() => session.setProgress(undefined), pendingMs);

if (args.includes("--paragraphs")) {
  const samples = [
    "Wraps token refresh in a 3-attempt retry with backoff, threading a new `attempts` parameter through refresh() and its two callers. The PR says existing callers are unaffected, but the final error is now swallowed instead of rethrown.",
    "Changes the route to return 503 instead of 500 when refresh fails. The PR description does not mention this.",
    "Adds retry tests for refresh(): success after one failure and exhaustion after three. No test covers the 503 path.",
  ];
  setTimeout(() => review.cards.filter((c) => !c.fixed).forEach((c, k) => setTimeout(() => session.setParagraph(c.id, samples[k % samples.length]!), k * 400)), 1500);
}

await runTui(session, async () => session.dispose());
process.exit(0);

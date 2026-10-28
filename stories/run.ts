// Story runner: render the real App against a saved Review, no git, models or agents.
// Usage: bun stories/run.ts [review-a|review-b|review-c] [--size 100x30] [--paragraphs] [--slow]
//   a on a card streams a fake review and lands a finding; --paragraphs fills in sample paragraphs after 1.5s.
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
const session = new FixtureSession(review, { pendingMs: slow ? 4000 : 800, dispatchMs: slow ? 8000 : 2500 });

if (args.includes("--paragraphs")) {
  const samples = [
    "Wraps token refresh in a 3-attempt retry with backoff, threading a new `attempts` parameter through refresh() and its two callers. The PR says existing callers are unaffected, but the final error is now swallowed instead of rethrown.",
    "Changes the route to return 503 instead of 500 when refresh fails. The PR description does not mention this.",
    "Adds retry tests for refresh(): success after one failure and exhaustion after three. No test covers the 503 path.",
  ];
  setTimeout(() => review.cards.filter((c) => !c.fixed).forEach((c, k) => setTimeout(() => session.setParagraph(c.id, samples[k % samples.length]!), k * 400)), 1500);
}

await runTui(session, { dispatchable: true, showAll: args.includes("--all") }, async () => session.dispose());
process.exit(0);

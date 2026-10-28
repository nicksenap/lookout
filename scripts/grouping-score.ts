// Step 15: score lookout's cards against a hand-judged grouping target.
// Usage: bun scripts/grouping-score.ts <review.json> <target.json> [--saved]
// Cards are recomputed from the saved change set (block kinds included) with the current code, so
// a saved Review doubles as an offline benchmark; `--saved` scores the cards as saved instead.
// Target: { concerns: [{ concern: string, blockIds: string[] }], mechanical: string[] }
// Prints agreement (adjusted Rand index over live blocks), largest card vs largest concern,
// mechanical leaks (blocks lookout calls mechanical that the judge calls behaviour) and
// fragment cards (a card of ≤ 2 blocks whose blocks the judge put in a larger concern).
import { buildCards } from "../src/cards/build.ts";
import { isFragment } from "../src/cards/group.ts";
import { allBlocks } from "../src/core/blocks.ts";
import type { Review } from "../src/core/types.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { guardKinds } from "../src/rank/mechanical.ts";

interface Target {
  concerns: { concern: string; blockIds: string[] }[];
  mechanical: string[];
}

const [reviewPath, targetPath] = process.argv.slice(2);
if (!reviewPath || !targetPath) throw new Error("usage: bun scripts/grouping-score.ts <review.json> <target.json>");
const review = (await Bun.file(reviewPath).json()) as Review;
const target = (await Bun.file(targetPath).json()) as Target;
const saved = process.argv.includes("--saved");
// Policy only affects colour, not membership, so defaults are fine here.
const result = score(saved ? review : { ...review, cards: buildCards(guardKinds(review.changeSet), DEFAULT_POLICY) }, target);
console.log(JSON.stringify(result, null, 2));

export function score(review: Review, target: Target) {
  const live = allBlocks(review.changeSet)
    .filter((r) => r.block.attention !== "inert")
    .map((r) => r.block.id);
  const judged = new Map<string, number>();
  target.concerns.forEach((c, k) => c.blockIds.forEach((id) => judged.set(id, k)));
  // A block the judge did not place is its own concern, so it counts against agreement only mildly.
  live.forEach((id, k) => {
    if (!judged.has(id)) judged.set(id, target.concerns.length + k);
  });
  const cards = review.cards.filter((c) => c.fixed === undefined);
  const byCard = new Map<string, number>();
  cards.forEach((c, k) => c.blockIds.forEach((id) => byCard.set(id, k)));

  const ari = adjustedRand(live.map((id) => judged.get(id)!), live.map((id) => byCard.get(id) ?? -1));
  const judgedMechanical = new Set(target.mechanical);
  const leaks = cards.filter((c) => c.mechanical).flatMap((c) => c.blockIds.filter((id) => !judgedMechanical.has(id)).map((id) => ({ card: c.title, blockId: id })));
  // A fragment (import, re-export, lone type) that joined its owner card is also "skipped" by the reader.
  const skipped = new Set([...cards.filter((c) => c.mechanical).flatMap((c) => c.blockIds), ...allBlocks(review.changeSet).filter(isFragment).map((r) => r.block.id)]);
  const kept = target.mechanical.filter((id) => skipped.has(id)).length;
  const concernSize = new Map<number, number>();
  for (const k of judged.values()) concernSize.set(k, (concernSize.get(k) ?? 0) + 1);
  const fragments = cards.filter((c) => c.blockIds.length <= 2 && c.blockIds.some((id) => (concernSize.get(judged.get(id)!) ?? 0) > 2)).map((c) => c.title);
  const unplaced = live.filter((id) => !target.concerns.some((c) => c.blockIds.includes(id)));
  return {
    target: review.changeSet.target,
    liveBlocks: live.length,
    cards: cards.length,
    concerns: target.concerns.length,
    ari: Number(ari.toFixed(3)),
    largestCard: Math.max(0, ...cards.map((c) => c.blockIds.length)),
    largestConcern: Math.max(0, ...target.concerns.map((c) => c.blockIds.length)),
    mechanicalLeaks: leaks,
    /** Share of the judge's mechanical blocks that lookout shows as mechanical or folds into an owner card as a fragment. */
    mechanicalRecall: target.mechanical.length ? Number((kept / target.mechanical.length).toFixed(2)) : null,
    fragmentCards: fragments,
    unplacedByJudge: unplaced.length,
  };
}

/** Hubert–Arabie adjusted Rand index of two labelings of the same items. 1 = identical, ~0 = chance. */
export function adjustedRand(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 1;
  const table = new Map<string, number>();
  const rows = new Map<number, number>();
  const cols = new Map<number, number>();
  for (let k = 0; k < n; k++) {
    table.set(`${a[k]}|${b[k]}`, (table.get(`${a[k]}|${b[k]}`) ?? 0) + 1);
    rows.set(a[k]!, (rows.get(a[k]!) ?? 0) + 1);
    cols.set(b[k]!, (cols.get(b[k]!) ?? 0) + 1);
  }
  const c2 = (x: number) => (x * (x - 1)) / 2;
  const sumTable = [...table.values()].reduce((s, x) => s + c2(x), 0);
  const sumRows = [...rows.values()].reduce((s, x) => s + c2(x), 0);
  const sumCols = [...cols.values()].reduce((s, x) => s + c2(x), 0);
  const expected = (sumRows * sumCols) / c2(n);
  const max = (sumRows + sumCols) / 2;
  return max === expected ? 1 : (sumTable - expected) / (max - expected);
}

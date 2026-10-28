// Step 15: every live edit block of a saved Review, for a human (or an agent standing in for one) to
// group into logical changes by hand, without seeing lookout's cards or kinds.
// Usage: bun scripts/grouping-digest.ts <review.json>
import { allBlocks, blockText } from "../src/core/blocks.ts";
import type { Review } from "../src/core/types.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: bun scripts/grouping-digest.ts <review.json>");
const review = (await Bun.file(path).json()) as Review;
const live = allBlocks(review.changeSet).filter((r) => r.block.attention !== "inert");
console.log(`# ${review.changeSet.target} · ${review.changeSet.files.length} files · ${live.length} live edit blocks\n`);
for (const r of live) {
  const where = r.block.newRange
    ? `new ${r.block.newRange.start}-${r.block.newRange.end}`
    : `old ${r.block.oldRange!.start}-${r.block.oldRange!.end}`;
  console.log(`## block ${r.block.id} · ${r.file.path} · ${where}`);
  console.log("```diff");
  console.log(blockText(r.hunk, r.block, 2));
  console.log("```\n");
}

# Rank edit blocks instead of hunks

review: review-d.json
card: a5a703f380d5

File tree: the block model is new, scoring and rules move from hunks to blocks.

```diff
 src/core/types.ts
+  EditBlock { hunkId, from, to, oldRange, newRange }
+src/core/blocks.ts        splitHunk, isolateBlock, allBlocks, mapBlocks
+src/core/result.ts        Result, attempt, attemptAsync
 src/rank/model.ts
-  scoreHunkBatch(model, hunks)
+  scoreBlockBatch(model, refs)
 src/rank/rules.ts
+  rankBlockByRules(file, hunk, block)
 src/rank/rank.ts
 scripts/inert-audit.ts
+  for (const b of h.blocks)
```

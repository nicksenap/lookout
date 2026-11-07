import { describe, expect, test } from "bun:test";
import { mapComment } from "../scripts/review-recall.ts";
import { allBlocks } from "../src/core/blocks.ts";
import { parseDiff } from "../src/core/diff.ts";
import type { ChangeSet } from "../src/core/types.ts";

// 43f4835 in this repo, src/cards/build.ts: compareCards gains `rank(...)` as new line 158 and loses it at old line 160.
const changeSet: ChangeSet = {
  target: "43f4835",
  base: "",
  head: "",
  files: parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/recall.diff`).text()),
};
const path = "src/cards/build.ts";
const blockAt = (side: "newRange" | "oldRange", line: number) =>
  allBlocks(changeSet).find((r) => r.block[side]?.start === line && r.block[side]?.end === line)!.block.id;

describe("review comment to block", () => {
  test("a comment on an added line maps to the block holding it", () => {
    expect(mapComment(changeSet, { path, line: 158, side: "new" })).toEqual({ blockId: blockAt("newRange", 158), on: "edit" });
  });

  test("a comment on a removed line maps by the old side", () => {
    expect(mapComment(changeSet, { path, line: 160, side: "old" })).toEqual({ blockId: blockAt("oldRange", 160), on: "edit" });
  });

  test("a comment on a context line maps to the nearest block in its hunk", () => {
    // New 159 is `skim(a) - skim(b)`, one line below the added `rank(...)` and two above the removed one.
    expect(mapComment(changeSet, { path, line: 159, side: "new" })).toEqual({ blockId: blockAt("newRange", 158), on: "context" });
  });

  test("a comment outside every hunk, on another file or on the whole file is unmapped", () => {
    expect(mapComment(changeSet, { path, line: 10, side: "new" })).toBeUndefined();
    expect(mapComment(changeSet, { path: "src/cards/other.ts", line: 158, side: "new" })).toBeUndefined();
    expect(mapComment(changeSet, { path, side: "new" })).toBeUndefined();
  });
});

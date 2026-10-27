import { describe, expect, test } from "bun:test";
import { allBlocks, blockText, deriveHunk, isolateBlock, splitHunk } from "../src/core/blocks.ts";
import { parseDiff } from "../src/core/diff.ts";
import type { EditBlock, Hunk } from "../src/core/types.ts";
import { applyRules } from "../src/rank/rules.ts";

const diff = (path: string, header: string, body: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, header, ...body].join("\n") + "\n";

describe("edit blocks", () => {
  test("a hunk fusing two edits splits into two blocks with correct line ranges", () => {
    const files = parseDiff(
      diff("src/a.ts", "@@ -1,6 +1,6 @@", [" const a = 1;", "-const b = 2;", "+const b = 3;", " const c = 4;", " const d = 5;", "-const e = 6;", "+const e = 7;", " const f = 8;"]),
    );
    const hunk = files[0]!.hunks[0]!;
    expect(hunk.blocks).toHaveLength(2);
    const [first, second] = hunk.blocks as [EditBlock, EditBlock];
    expect(first.oldRange).toEqual({ start: 2, end: 2 });
    expect(first.newRange).toEqual({ start: 2, end: 2 });
    expect(second.oldRange).toEqual({ start: 5, end: 5 });
    expect(second.newRange).toEqual({ start: 5, end: 5 });
    expect(first.id).not.toBe(second.id);
    expect(hunk.blocks.every((b) => b.hunkId === hunk.id && b.path === "src/a.ts")).toBe(true);
  });

  test("pure additions have no old range; pure deletions have no new range", () => {
    const files = parseDiff(diff("a.ts", "@@ -1,2 +1,3 @@", [" x", "+y", " z"]));
    const b = files[0]!.hunks[0]!.blocks[0]!;
    expect(b.oldRange).toBeUndefined();
    expect(b.newRange).toEqual({ start: 2, end: 2 });
    const del = parseDiff(diff("a.ts", "@@ -1,3 +1,2 @@", [" x", "-y", " z"]))[0]!.hunks[0]!.blocks[0]!;
    expect(del.newRange).toBeUndefined();
    expect(del.oldRange).toEqual({ start: 2, end: 2 });
  });

  test("a mixed del+add run is one block; context-only input yields none", () => {
    const h = { id: "h", path: "p", lines: [{ kind: "del" as const, text: "a", oldLine: 1 }, { kind: "add" as const, text: "b", newLine: 1 }, { kind: "add" as const, text: "c", newLine: 2 }] };
    expect(splitHunk(h)).toHaveLength(1);
    expect(splitHunk({ id: "h", path: "p", lines: [{ kind: "context", text: "x", oldLine: 1, newLine: 1 }] })).toEqual([]);
  });

  test("block ids are stable for the same content at the same position and differ by position", () => {
    const a = parseDiff(diff("a.ts", "@@ -1,2 +1,2 @@", [" x", "-y", "+z"]))[0]!.hunks[0]!.blocks[0]!;
    const b = parseDiff(diff("a.ts", "@@ -1,2 +1,2 @@", [" x", "-y", "+z"]))[0]!.hunks[0]!.blocks[0]!;
    const c = parseDiff(diff("a.ts", "@@ -10,2 +10,2 @@", [" x", "-y", "+z"]))[0]!.hunks[0]!.blocks[0]!;
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  test("isolateBlock shows only this block's change; other blocks appear as their new side on both sides", () => {
    const hunk = parseDiff(diff("a.ts", "@@ -1,5 +1,5 @@", [" k", "-a1", "+a2", " m", "-b1", "+b2"]))[0]!.hunks[0]!;
    const [first, second] = hunk.blocks as [EditBlock, EditBlock];
    expect(isolateBlock(hunk, first)).toEqual({ oldText: "k\na1\nm\nb2", newText: "k\na2\nm\nb2" });
    expect(isolateBlock(hunk, second)).toEqual({ oldText: "k\na2\nm\nb1", newText: "k\na2\nm\nb2" });
  });

  test("blockText includes limited context on each side", () => {
    const body = [" c1", " c2", " c3", " c4", " c5", "-old", "+new", " d1", " d2", " d3", " d4"];
    const hunk = parseDiff(diff("a.ts", "@@ -1,10 +1,10 @@", body))[0]!.hunks[0]!;
    expect(blockText(hunk, hunk.blocks[0]!, 2).split("\n")).toEqual([" c4", " c5", "-old", "+new", " d1", " d2"]);
  });
});

describe("hunks derive from their blocks", () => {
  const base = (blocks: Partial<EditBlock>[]): Hunk => ({
    id: "h", path: "p", header: "@@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [], labels: [], attention: "routine", score: 0,
    blocks: blocks.map((b, k) => ({ id: `b${k}`, hunkId: "h", path: "p", from: 0, to: 0, labels: [], attention: "routine", score: 0, ...b })),
  });
  test("attention is the highest block; score the highest block", () => {
    const h = deriveHunk(base([{ attention: "inert", score: 0 }, { attention: "suspicious", score: 0.9 }, { attention: "routine", score: 0.3 }]));
    expect(h.attention).toBe("suspicious");
    expect(h.score).toBe(0.9);
  });
  test("content label only when every block has one; comment-only wins over whitespace-only", () => {
    expect(deriveHunk(base([{ labels: ["whitespace-only"] }, { labels: ["comment-only"] }])).labels).toEqual(["comment-only"]);
    expect(deriveHunk(base([{ labels: ["whitespace-only"] }, { labels: [] }])).labels).toEqual([]);
    expect(deriveHunk(base([{ labels: ["test", "whitespace-only"] }, { labels: ["test", "whitespace-only"] }])).labels).toEqual(["test", "whitespace-only"]);
  });
});

describe("rules per block", () => {
  test("a fused hunk with a reindent and a logic change: the reindent block is inert, the hunk is not", () => {
    const body = [
      " export function f(a: number) {",
      "-    if (a > 1) {",
      "-        return a;",
      "-    }",
      "+  if (a > 1) {",
      "+    return a;",
      "+  }",
      "   const unrelated = 1;",
      "   const alsoUnrelated = 2;",
      "   const stillUnrelated = 3;",
      "-  return 0;",
      "+  return a * 2;",
      " }",
    ];
    const cs = applyRules({ target: "t", base: "", head: "", files: parseDiff(diff("src/f.ts", "@@ -1,9 +1,9 @@", body)) });
    const hunk = cs.files[0]!.hunks[0]!;
    expect(hunk.blocks).toHaveLength(2);
    expect(hunk.blocks[0]!.attention).toBe("inert");
    expect(hunk.blocks[0]!.labels).toContain("whitespace-only");
    expect(hunk.blocks[1]!.attention).toBe("routine");
    expect(hunk.attention).toBe("routine");
    expect(hunk.labels).not.toContain("whitespace-only");
  });

  test("allBlocks walks every block with its file and hunk", async () => {
    const files = parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/result-errors.diff`).text());
    const refs = allBlocks({ target: "t", base: "", head: "", files });
    expect(refs).toHaveLength(81);
    expect(refs.every((r) => r.hunk.blocks.includes(r.block) && r.file.hunks.includes(r.hunk))).toBe(true);
  });
});

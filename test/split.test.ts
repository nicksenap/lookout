import { describe, expect, test } from "bun:test";
import { buildCards, cardId } from "../src/cards/build.ts";
import { isBlob, parseSplit, proposeSplits, splitPrompt } from "../src/cards/split.ts";
import { allBlocks, mapBlocks } from "../src/core/blocks.ts";
import { parseDiff } from "../src/core/diff.ts";
import type { BlockKind, ChangeSet } from "../src/core/types.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { RankCache } from "../src/rank/cache.ts";
import { applyRules } from "../src/rank/rules.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `n` behaviour blocks in `file`, each its own hunk, all sharing the identifier `shared` so grouping fuses them. */
const file = (path: string, n: number, start = 1) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...Array.from({ length: n }, (_, k) => [`@@ -${start + k * 10},2 +${start + k * 10},3 @@`, " a", `+  shared.step${k}(${path.length});`, " b"]).flat()].join("\n") + "\n";
const cs = (text: string, kind: BlockKind = "behavior"): ChangeSet => mapBlocks(applyRules({ target: "t", base: "", head: "", files: parseDiff(text) }), ({ block }) => ({ ...block, kind }));

describe("blob splitting", () => {
  const changeSet = cs(file("src/a.ts", 6) + file("src/b.ts", 6));
  const whole = buildCards(changeSet, DEFAULT_POLICY);
  const blob = whole.find((c) => !c.fixed)!;
  const ids = allBlocks(changeSet).map((r) => r.block.id);
  const a = ids.slice(0, 6);
  const b = ids.slice(6);

  test("a card over 8 blocks or 3 files is a blob; a mechanical card never is", () => {
    expect(whole.filter((c) => !c.fixed).length).toBe(1);
    expect(isBlob(changeSet, blob)).toBe(true);
    expect(isBlob(changeSet, { ...blob, mechanical: true })).toBe(false);
    const wide = cs(file("a.ts", 1) + file("b.ts", 1) + file("c.ts", 1) + file("d.ts", 1));
    expect(isBlob(wide, buildCards(wide, DEFAULT_POLICY)[0]!)).toBe(true);
    const small = cs(file("src/a.ts", 4));
    expect(isBlob(small, buildCards(small, DEFAULT_POLICY)[0]!)).toBe(false);
  });

  test("parseSplit repairs the model's partition: foreign ids dropped, duplicates kept once, unplaced ids homed by file, singletons merged", () => {
    const refs = allBlocks(changeSet);
    const answer = JSON.stringify({ concerns: [{ title: "a", blockIds: [...a.slice(0, 4), "nope"] }, { title: "b", blockIds: [...b.slice(0, 5), a[0]] }, { title: "lonely", blockIds: [a[4]] }] });
    const got = parseSplit(`Sure:\n${answer}`, blob, refs)!;
    expect(got.length).toBe(2);
    expect(got.flat().sort()).toEqual(ids.slice().sort());
    expect(got[0]!.sort()).toEqual(a.slice().sort());
    expect(got[1]!.sort()).toEqual(b.slice().sort());
    expect(parseSplit("not json", blob, refs)).toBeUndefined();
    expect(parseSplit(JSON.stringify({ concerns: [{ blockIds: ids }] }), blob, refs)).toBeUndefined();
    expect(parseSplit(JSON.stringify({ concerns: [{ blockIds: [a[0]] }, { blockIds: ids.slice(1) }] }), blob, refs)).toBeUndefined();
  });

  test("buildCards turns a split into one card per concern; every block keeps exactly one home; the prompt names every edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookout-split-"));
    const cache = new RankCache(dir);
    const prompts: string[] = [];
    const write = async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify({ concerns: [{ title: "a", blockIds: a }, { title: "b", blockIds: b }] });
    };
    const res = await proposeSplits(changeSet, whole, { modelSpec: "fake:m", cache, write });
    expect(res.warning).toBeUndefined();
    expect(res.splits.get(blob.id)!.map((g) => g.length)).toEqual([6, 6]);
    expect(prompts.length).toBe(1);
    for (const id of ids) expect(prompts[0]).toContain(`edit ${id}`);
    const cards = buildCards(changeSet, DEFAULT_POLICY, res.splits).filter((c) => !c.fixed);
    expect(cards.length).toBe(2);
    expect(cards.flatMap((c) => c.blockIds).sort()).toEqual(ids.slice().sort());
    expect(cards.map((c) => c.id).sort()).toEqual([cardId(a), cardId(b)].sort());
    // Second run: answered from the cache, no model call.
    const again = await proposeSplits(changeSet, whole, { modelSpec: "fake:m", cache: new RankCache(dir), write });
    expect(prompts.length).toBe(1);
    expect(again.splits.get(blob.id)).toEqual(res.splits.get(blob.id));
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unusable answer leaves the blob whole with a warning, and is cached as no-split", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookout-split-"));
    let calls = 0;
    const write = async () => {
      calls++;
      return "TITLE: nope\nPARAGRAPH: nope";
    };
    const res = await proposeSplits(changeSet, whole, { modelSpec: "fake:m", cache: new RankCache(dir), write });
    expect(res.splits.size).toBe(0);
    expect(res.warning).toMatch(/not split/);
    await proposeSplits(changeSet, whole, { modelSpec: "fake:m", cache: new RankCache(dir), write });
    expect(calls).toBe(1);
    expect(splitPrompt(changeSet, blob)).toContain("JSON only");
    rmSync(dir, { recursive: true, force: true });
  });
});

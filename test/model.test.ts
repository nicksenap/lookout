import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import { parseDiff } from "../src/core/diff.ts";
import type { ChangeSet, Hunk } from "../src/core/types.ts";
import { RankCache } from "../src/rank/cache.ts";
import { questionId, resolveAttentionModel } from "../src/rank/model.ts";
import { mergeModelScore, rankChangeSet } from "../src/rank/rank.ts";

const dirs: string[] = [];
const tmpCache = () => {
  const d = mkdtempSync(join(tmpdir(), "lookout-cache-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const sample = async (): Promise<ChangeSet> => ({
  target: "fixture",
  base: "a",
  head: "b",
  files: parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/result-errors.diff`).text()),
  intent: { title: "render configured budgets", body: "" },
});

/** Mock decision model: scores every hunk via `scoreFor`, counts calls, records question counts. */
function mockModel(scoreFor: (hunkId: string) => number) {
  const calls: number[] = [];
  const model = new Experimental_DecisionMockModelV4({
    provider: "mock",
    modelId: "attention",
    supportedQuestionTypes: ["score", "choice"],
    doDecide: async ({ questions }) => {
      calls.push(Object.keys(questions).length);
      const answers: Record<string, { type: "score"; score: number }> = {};
      for (const id of Object.keys(questions)) {
        if (id.startsWith("kind_")) (answers as Record<string, unknown>)[id] = { type: "choice", choice: "behavior" };
        else answers[id] = { type: "score", score: scoreFor(id.replace("review_attention_", "")) };
      }
      return { answers, warnings: [] };
    },
  });
  return { model, calls };
}

describe("model ranking with the mock decision model", () => {
  test("batches questions, one review_attention score question per edit block", async () => {
    const cs = await sample();
    const { model, calls } = mockModel(() => 1);
    const res = await rankChangeSet(cs, {
      modelSpec: "mock:attention",
      cache: new RankCache(tmpCache()),
      resolveModel: () => ({ ok: true, model }),
      batchSize: 8,
    });
    expect(res.rankedBy).toBe("rules+mock:attention");
    expect(res.warning).toBeUndefined();
    expect(calls).toEqual([16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 2]); // 81 edit blocks, two questions each, 8 blocks per batch
  });

  test("second run makes 0 requests (cache by hunk hash)", async () => {
    const cs = await sample();
    const dir = tmpCache();
    const first = mockModel(() => 2);
    await rankChangeSet(cs, { modelSpec: "mock:attention", cache: new RankCache(dir), resolveModel: () => ({ ok: true, model: first.model }) });
    expect(first.calls.length).toBeGreaterThan(0);

    const second = mockModel(() => 0);
    const res = await rankChangeSet(cs, { modelSpec: "mock:attention", cache: new RankCache(dir), resolveModel: () => ({ ok: true, model: second.model }) });
    expect(second.calls).toEqual([]);
    expect(res.rankedBy).toBe("rules+mock:attention");
    // Cached scores (2 = needs-eyes) were used, not the second model's 0s.
    expect(res.changeSet.files.flatMap((f) => f.hunks).every((h) => h.attention === "needs-eyes")).toBe(true);
  });

  test("model raises attention per hunk and sorts within a level", async () => {
    const cs = await sample();
    const hunk = cs.files[0]!.hunks[0]!;
    const target = hunk.blocks[0]!.id;
    const { model } = mockModel((id) => (id === target ? 3 : 0.4));
    const res = await rankChangeSet(cs, { modelSpec: "mock:attention", cache: new RankCache(tmpCache()), resolveModel: () => ({ ok: true, model }) });
    const hunks = res.changeSet.files.flatMap((f) => f.hunks);
    const blocks = hunks.flatMap((h) => h.blocks);
    expect(blocks.find((b) => b.id === target)!.attention).toBe("suspicious");
    expect(blocks.filter((b) => b.attention === "suspicious")).toHaveLength(1);
    // The hunk inherits its highest block.
    expect(hunks.find((h) => h.id === hunk.id)!.attention).toBe("suspicious");
  });

  test("missing key → rankedBy rules with a warning", async () => {
    const cs = await sample();
    const res = await rankChangeSet(cs, { modelSpec: "openai:gpt-6-luna", env: {}, cache: new RankCache(tmpCache()) });
    expect(res.rankedBy).toBe("rules");
    expect(res.warning).toContain("OPENAI_API_KEY");
  });

  test("forced error → rankedBy rules with a warning", async () => {
    const cs = await sample();
    const model = new Experimental_DecisionMockModelV4({
      supportedQuestionTypes: ["score", "choice"],
      doDecide: async () => {
        throw new Error("boom: provider down");
      },
    });
    const res = await rankChangeSet(cs, { modelSpec: "mock:attention", cache: new RankCache(tmpCache()), resolveModel: () => ({ ok: true, model }) });
    expect(res.rankedBy).toBe("rules");
    expect(res.warning).toContain("boom: provider down");
    expect(res.changeSet.files.flatMap((f) => f.hunks).every((h) => h.labels !== undefined)).toBe(true);
  });

  test("invalid model answer (out of range score) → rules with a warning", async () => {
    const cs = await sample();
    const { model } = mockModel(() => 99);
    const res = await rankChangeSet(cs, { modelSpec: "mock:attention", cache: new RankCache(tmpCache()), resolveModel: () => ({ ok: true, model }) });
    expect(res.rankedBy).toBe("rules");
    expect(res.warning).toBeDefined();
  });
});

describe("mergeModelScore: rules bound the model", () => {
  const base: Hunk = { id: "x", path: "a.ts", header: "@@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [], blocks: [], labels: [], attention: "inert", score: 0 };
  test("model cannot make a hunk inert", () => {
    expect(mergeModelScore({ ...base, attention: "routine" }, { score: 0, kind: "behavior" }).attention).toBe("routine");
    expect(mergeModelScore({ ...base, attention: "needs-eyes" }, { score: 0, kind: "behavior" }).attention).toBe("needs-eyes");
  });
  test("trivial/routine model answers keep inert hunks hidden; needs-eyes raises them", () => {
    expect(mergeModelScore(base, { score: 1, kind: "behavior" }).attention).toBe("inert");
    expect(mergeModelScore(base, { score: 2, kind: "behavior" }).attention).toBe("needs-eyes");
    expect(mergeModelScore(base, { score: 3, kind: "behavior" }).attention).toBe("suspicious");
  });
});

describe("registry from present keys", () => {
  test("resolves a model when the provider key is present (no network)", () => {
    const r = resolveAttentionModel("openai:gpt-6-luna", { OPENAI_API_KEY: "sk-test" });
    expect(r.ok).toBe(true);
    if (r.ok && typeof r.model !== "string") expect(r.model.modelId).toBe("gpt-6-luna");
  });
  test("unknown provider", () => {
    const r = resolveAttentionModel("nope:x", {});
    expect(r.ok).toBe(false);
  });
  test("key for another provider does not satisfy the configured one", () => {
    const r = resolveAttentionModel("anthropic:claude-haiku-4-5-20251001", { OPENAI_API_KEY: "sk-test" });
    expect(r).toEqual({ ok: false, reason: "no ANTHROPIC_API_KEY set" });
  });
  test("question ids", () => expect(questionId("abc")).toBe("review_attention_abc"));
});

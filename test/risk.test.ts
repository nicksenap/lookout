import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Experimental_DecisionMockModelV4, MockLanguageModelV4 } from "ai/test";
import { buildCards, compareCards } from "../src/cards/build.ts";
import { riskCards } from "../src/cards/risk.ts";
import { parseDiff } from "../src/core/diff.ts";
import type { Card, ChangeSet } from "../src/core/types.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { RankCache } from "../src/rank/cache.ts";
import { applyRules } from "../src/rank/rules.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const cache = () => {
  const dir = mkdtempSync(join(tmpdir(), "lookout-risk-"));
  dirs.push(dir);
  return new RankCache(dir);
};
const changeSet: ChangeSet = applyRules({
  target: "risk",
  base: "a",
  head: "b",
  files: parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/user-env.diff`).text()),
});
const card = (): Card => ({ ...buildCards(changeSet, DEFAULT_POLICY).find((c) => !c.fixed)!, color: "green", blockKind: "behavior" });
const sentence = "Existing callers now use the changed environment value.";
const writer = (texts: string[]) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: texts.shift() ?? sentence }],
      finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    }),
  });
const model = (score: number, checks = [0.95], calls: unknown[] = []) =>
  new Experimental_DecisionMockModelV4({
    doDecide: async (options) => {
      calls.push(options);
      return {
        answers: Object.fromEntries(
          Object.entries(options.questions).map(([id, q]) => [
            id,
            q.type === "score" ? { type: "score", score } : { type: "boolean", value: true, probability: checks.shift() ?? 0.95 },
          ]),
        ),
        usage: { inputTokens: 1, outputTokens: 1 },
        warnings: [],
      };
    },
  });

test("risk-bearing cards rank first within their colour, without outranking a red card", () => {
  const risky = { ...card(), id: "risk", color: "amber" as const, risk: sentence };
  const toggle = { ...card(), id: "config", color: "amber" as const, kind: "config" as const, attention: "needs-eyes" as const };
  const red = { ...card(), id: "red", color: "red" as const };
  expect([toggle, risky, red].sort(compareCards).map((c) => c.id)).toEqual(["red", "risk", "config"]);
});

test("below the score threshold nothing is written; behaviour alone is eligible", async () => {
  const c = card();
  const skipped: Card[] = [
    { ...c, id: "mechanical", mechanical: true },
    { ...c, id: "test", blockKind: "test" },
    { ...c, id: "docs", kind: "docs" },
    { ...c, id: "config", blockKind: "config" },
    { ...c, id: "clean", fixed: "clean", color: "grey" },
  ];
  const calls: unknown[] = [];
  const decision = model(0.69, [], calls);
  const language = writer([sentence]);
  const patches: Partial<Card>[] = [];
  await riskCards(
    changeSet,
    [c, ...skipped],
    { modelSpec: "mock:w", checkSpec: "mock:d", cache: cache(), model: decision, writer: language },
    (_id, p) => patches.push(p),
  );
  expect(calls).toHaveLength(1);
  expect(language.doGenerateCalls).toHaveLength(0);
  expect(patches).toEqual([]);
});

test("a failed consistency gate rewrites once, stays unverified and does not raise colour", async () => {
  const decision = model(0.9, [0.6, 0.69]);
  const language = writer([sentence, "Existing callers lose the previous environment value."]);
  const patches: Partial<Card>[] = [];
  await riskCards(
    changeSet,
    [card()],
    { modelSpec: "mock:w", checkSpec: "mock:d", cache: cache(), model: decision, writer: language },
    (_id, p) => patches.push(p),
  );
  expect(patches).toEqual([{ risk: "Existing callers lose the previous environment value.", riskCheck: 0.69, riskUnverified: true }]);
  expect(language.doGenerateCalls).toHaveLength(2);
});

test("unsupported names and consistency share one rewrite; a corrected sentence can verify", async () => {
  const calls: unknown[] = [];
  const decision = model(0.9, [0.6], calls);
  const language = writer(["Callers lose `inventedOperation`.", sentence]);
  const patches: Partial<Card>[] = [];
  await riskCards(
    changeSet,
    [card()],
    { modelSpec: "mock:w", checkSpec: "mock:d", cache: cache(), model: decision, writer: language },
    (_id, p) => patches.push(p),
  );
  expect(patches).toEqual([{ risk: sentence, riskCheck: 0.6, riskUnverified: true }]);
  expect(language.doGenerateCalls).toHaveLength(2);
  expect(calls).toHaveLength(2);
  const verified: Partial<Card>[] = [];
  await riskCards(
    changeSet,
    [card()],
    {
      modelSpec: "mock:w",
      checkSpec: "mock:d",
      cache: cache(),
      model: model(1),
      writer: writer(["Callers lose `inventedOperation`.", sentence]),
    },
    (_id, p) => verified.push(p),
  );
  expect(verified[0]).toEqual({ risk: sentence, riskCheck: 0.95, color: "amber" });
});

test("cached risks skip model calls and never lower red or touch grey", async () => {
  const shared = cache();
  const calls: unknown[] = [];
  const decision = model(1, [0.95], calls);
  const language = writer([sentence]);
  const patches: Partial<Card>[] = [];
  const opts = { modelSpec: "mock:w", checkSpec: "mock:d", cache: shared, model: decision, writer: language };
  await riskCards(changeSet, [{ ...card(), color: "red" }], opts, (_id, p) => patches.push(p));
  await riskCards(changeSet, [{ ...card(), color: "grey" }], opts, (_id, p) => patches.push(p));
  expect(patches).toEqual([
    { risk: sentence, riskCheck: 0.95 },
    { risk: sentence, riskCheck: 0.95 },
  ]);
  expect(calls).toHaveLength(2);
  expect(language.doGenerateCalls).toHaveLength(1);
});

test("a verified risk sentence raises a routine green card to amber", async () => {
  const c = card();
  const patches: Partial<Card>[] = [];
  await riskCards(
    changeSet,
    [c],
    { modelSpec: "mock:w", checkSpec: "mock:d", cache: cache(), model: model(0.7), writer: writer([sentence]) },
    (_id, patch) => patches.push(patch),
  );
  expect(patches).toEqual([{ risk: sentence, riskCheck: 0.95, color: "amber" }]);
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Experimental_DecisionMockModelV4, MockLanguageModelV4 } from "ai/test";
import { buildCards } from "../src/cards/build.ts";
import { mapCards, mapProblems, mapSource } from "../src/cards/map.ts";
import { parseDiff } from "../src/core/diff.ts";
import type { Card, ChangeMap, ChangeSet } from "../src/core/types.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { RankCache } from "../src/rank/cache.ts";
import { applyRules } from "../src/rank/rules.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const cache = () => {
  const dir = mkdtempSync(join(tmpdir(), "lookout-map-"));
  dirs.push(dir);
  return new RankCache(dir);
};
const changeSet: ChangeSet = applyRules({
  target: "map",
  base: "a",
  head: "b",
  files: parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/user-env.diff`).text()),
});
// Three cards: the env-file loader, its test, and the call in main.
const titles: Record<string, string> = {
  "src/cli/env.ts": "Load the user env file",
  "test/sources.test.ts": "Test the loader against a temp directory",
  "src/cli/main.ts": "Call the loader at startup",
};
const cards: Card[] = buildCards(changeSet, DEFAULT_POLICY).map((c) => ({ ...c, title: titles[c.title] ?? c.title }));
const good = [" main", "+  loadUserEnv()", "+loadUserEnv(path = USER_ENV_PATH, env = process.env)", "+  describe user env file"].join("\n");
// No line names the test card: not its title words, its file, or any name its edits show (it imports `loadUserEnv`).
const missing = [" main", "+  USER_ENV_PATH"].join("\n");

const writer = (texts: string[]) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: texts.shift() ?? good }],
      finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    }),
  });
const model = (checks: number[]) =>
  new Experimental_DecisionMockModelV4({
    doDecide: async (options) => ({
      answers: Object.fromEntries(
        Object.keys(options.questions).map((id) => [id, { type: "boolean", value: true, probability: checks.shift() ?? 0.95 }]),
      ),
      usage: { inputTokens: 1, outputTokens: 1 },
      warnings: [],
    }),
  });
const run = async (language: MockLanguageModelV4, decision = model([]), shared = cache(), input = cards) => {
  const maps: ChangeMap[] = [];
  const res = await mapCards(changeSet, input, { modelSpec: "mock:w", cache: shared, model: decision, writer: language }, (m) =>
    maps.push(m),
  );
  return { maps, res };
};

test("a map that names every card and only names the diff is kept, with each card's node line", async () => {
  const language = writer([`\`\`\`diff\n${good}\n\`\`\``]);
  const { maps, res } = await run(language, model([0.9]));
  expect(maps).toHaveLength(1);
  expect(maps[0]!.text).toBe(good);
  expect(maps[0]!.check).toBe(0.9);
  const id = (file: string) => cards.find((c) => c.files.includes(file))!.id;
  // The main card's node is ` main` (its file); the loader card's is the line only its edits name.
  expect(maps[0]!.nodes[id("src/cli/main.ts")]).toBe(0);
  expect(maps[0]!.nodes[id("src/cli/env.ts")]).toBe(2);
  expect(maps[0]!.nodes[id("test/sources.test.ts")]).toBe(3);
  expect(res.map).toEqual(maps[0]);
  expect(language.doGenerateCalls).toHaveLength(1);
});

test("a map missing a card is rewritten once, quoting the card", async () => {
  const language = writer([missing, good]);
  const { maps } = await run(language);
  expect(maps.map((m) => m.text)).toEqual([good]);
  expect(language.doGenerateCalls).toHaveLength(2);
  expect(JSON.stringify(language.doGenerateCalls[1]!.prompt)).toContain("Test the loader against a temp directory");
});

test("a map still missing a card after the rewrite is dropped: no map, no callback", async () => {
  const language = writer([missing, missing]);
  const { maps, res } = await run(language);
  expect(maps).toEqual([]);
  expect(res.map).toBeUndefined();
  expect(language.doGenerateCalls).toHaveLength(2);
});

test("a map failing the consistency check twice is kept, marked unverified", async () => {
  const { maps } = await run(writer([good, good]), model([0.5, 0.6]));
  expect(maps).toEqual([expect.objectContaining({ text: good, check: 0.6, unverified: true })]);
});

test("the map is cached by the review's card-id set", async () => {
  const shared = cache();
  await run(writer([good]), model([0.9]), shared);
  const again = writer([]);
  const { maps } = await run(again, model([0.9]), shared);
  expect(maps.map((m) => m.text)).toEqual([good]);
  expect(again.doGenerateCalls).toHaveLength(0);
});

test("a review with one card to map gets no call", async () => {
  const language = writer([]);
  const { maps } = await run(language, model([]), cache(), cards.slice(0, 1));
  expect(maps).toEqual([]);
  expect(language.doGenerateCalls).toHaveLength(0);
});

test("an identifier neither in the diff, a sketch nor a title is a problem; so is a 21st line", () => {
  const source = mapSource(changeSet, cards);
  expect(mapProblems(good, source)).toEqual([]);
  expect(mapProblems(`${good}\n   inventedLoader()`, source)).toEqual([
    "`inventedLoader()` names inventedLoader, which the edits do not show",
  ]);
  const long = [...good.split("\n"), ...Array.from({ length: 17 }, () => "   loadUserEnv")].join("\n");
  expect(mapProblems(long, source)).toEqual(["the sketch has 21 lines; at most 20"]);
});

test("a map line may run to 120 columns, past the 100 a card sketch gets; a longer one is a problem", () => {
  const source = mapSource(changeSet, cards);
  const at = (n: number) => `${good}\n   loadUserEnv${" ".repeat(n - 18)}→ env`;
  expect(mapProblems(at(110), source)).toEqual([]);
  expect(mapProblems(at(130), source)).toHaveLength(1);
});

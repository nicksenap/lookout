import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Experimental_DecisionMockModelV4, MockLanguageModelV4 } from "ai/test";
import { buildCards } from "../src/cards/build.ts";
import { mapCards, mapProblems, mapSource, parseConcerns } from "../src/cards/map.ts";
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
  const { maps } = await run(language, model([0.9]));
  expect(maps).toHaveLength(1);
  expect(maps[0]!.text).toBe(good);
  expect(maps[0]!.check).toBe(0.9);
  const id = (file: string) => cards.find((c) => c.files.includes(file))!.id;
  // The main card's node is ` main` (its file); the loader card's is the line only its edits name.
  expect(maps[0]!.nodes[id("src/cli/main.ts")]).toBe(0);
  expect(maps[0]!.nodes[id("src/cli/env.ts")]).toBe(2);
  expect(maps[0]!.nodes[id("test/sources.test.ts")]).toBe(3);
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
  const { maps } = await run(language);
  expect(maps).toEqual([]);
  expect(language.doGenerateCalls).toHaveLength(2);
});

test("a rewrite call that fails is a warning, not a verdict: the next run draws again", async () => {
  const shared = cache();
  let calls = 0;
  const flaky = new MockLanguageModelV4({
    doGenerate: async () => {
      if (++calls > 1) throw new Error("network down");
      return {
        content: [{ type: "text", text: missing }],
        finishReason: { unified: "stop", raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  const first = await run(flaky, model([]), shared);
  expect(first.maps).toEqual([]);
  expect(first.res.warning).toContain("network down");
  const { maps } = await run(writer([good]), model([0.9]), shared);
  expect(maps.map((m) => m.text)).toEqual([good]);
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

// Nine cards: each fixture card three times over, so the stack is past six and the map groups it into concerns.
const many: Card[] = cards.flatMap((c) =>
  ["", " again", " once more"].map((s, k) => ({ ...c, id: `${c.id}${k}`, title: `${c.title}${s}` })),
);
const grouping = JSON.stringify({
  concerns: [
    { title: "Load the user env file", cards: [1, 2, 3, 7, 8, 9] },
    { title: "Test the loader", cards: [4, 5, 6] },
  ],
});
const concernMap = [
  " Load the user env file",
  "+  loadUserEnv(path = USER_ENV_PATH, env = process.env)",
  "   main",
  "+    loadUserEnv()",
  " Test the loader",
  "+  describe user env file",
].join("\n");

test("past six cards, a first call groups them into concerns and the map draws one top-level node per concern", async () => {
  const shared = cache();
  const language = writer([grouping, concernMap]);
  const { maps } = await run(language, model([0.9]), shared, many);
  expect(language.doGenerateCalls).toHaveLength(2);
  expect(JSON.stringify(language.doGenerateCalls[1]!.prompt)).toContain("1. Load the user env file\\n   holds cards 1, 2, 3, 7, 8, 9");
  expect(maps.map((m) => m.text)).toEqual([concernMap]);
  expect(maps[0]!.concerns).toEqual([
    { title: "Load the user env file", cardIds: [1, 2, 3, 7, 8, 9].map((n) => many[n - 1]!.id) },
    { title: "Test the loader", cardIds: [4, 5, 6].map((n) => many[n - 1]!.id) },
  ]);
  // Both steps are cached by the card-id set.
  const again = writer([]);
  await run(again, model([0.9]), shared, many);
  expect(again.doGenerateCalls).toHaveLength(0);
});

test("concern grouping keeps every card once: foreign ids dropped, a repeat keeps its first concern, the unplaced and singletons join the concern sharing their files", () => {
  const answer = JSON.stringify({
    concerns: [
      { title: "loader", cards: [1, 2, 99, "x"] },
      { title: "tests", cards: [4, 5, 2] },
      { title: "lonely test", cards: [6] },
      { title: "startup", cards: [7, 8, 9] },
    ],
  });
  // Card 3 is unplaced and shares files with 1 and 2; card 6 is alone and shares its file with 4 and 5.
  expect(parseConcerns(answer, many)).toEqual([
    { title: "loader", cardIds: [1, 2, 3].map((n) => many[n - 1]!.id) },
    { title: "tests", cardIds: [4, 5, 6].map((n) => many[n - 1]!.id) },
    { title: "startup", cardIds: [7, 8, 9].map((n) => many[n - 1]!.id) },
  ]);
  expect(parseConcerns("no json", many)).toBeUndefined();
  expect(parseConcerns(JSON.stringify({ concerns: [{ title: "all", cards: [1, 2, 3, 4, 5, 6, 7, 8, 9] }] }), many)).toBeUndefined();
});

test("more than six concerns merge, smallest first, into the concern sharing their files", () => {
  const sixteen = [...many, ...many.slice(0, 7).map((c) => ({ ...c, id: `${c.id}x` }))];
  const answer = JSON.stringify({
    concerns: Array.from({ length: 8 }, (_, k) => ({ title: `c${k}`, cards: [2 * k + 1, 2 * k + 2] })),
  });
  const parsed = parseConcerns(answer, sixteen)!;
  expect(parsed).toHaveLength(6);
  expect(parsed.flatMap((c) => c.cardIds).sort()).toEqual(sixteen.map((c) => c.id).sort());
});

test("a seventh top-level line is a problem; the top level is the map's least-indented lines", () => {
  const source = mapSource(changeSet, cards);
  const flat = Array.from({ length: 7 }, () => "+    loadUserEnv()").join("\n");
  expect(mapProblems(`${good}\n${flat.replaceAll("+    ", "+  ")}`, source)).toEqual([]);
  expect(mapProblems(`${flat}\n+    describe user env file`, source)).toEqual(["the map has 8 top-level lines; at most 6"]);
});

test("a card named only above the first top-level line is not in the map", () => {
  const source = mapSource(changeSet, cards);
  const orphan = ["+  describe user env file", " main", "+  USER_ENV_PATH"].join("\n");
  expect(mapProblems(orphan, source)).toEqual([
    'the card "Test the loader against a temp directory" is not in the map; name it by its title words, a file or a name from its edits',
  ]);
});

test("a line naming a hyphenated file represents the card of that file", () => {
  const source = mapSource(changeSet, cards);
  const card = { id: "x", title: "Typing refactor across 2 files", tokens: new Set(["widget-edit-resume"]) };
  const map = [
    " main",
    "+  loadUserEnv(path = USER_ENV_PATH, env = process.env)",
    "+  describe user env file",
    "   widget-edit-resume.ts",
  ].join("\n");
  expect(mapProblems(map, { ...source, cards: [...source.cards, card] }).filter((p) => p.includes("Typing"))).toEqual([]);
});

test("with concerns, a top-level line that is not a concern's title is a problem", () => {
  const concerns = [
    { title: "Load the user env file", cardIds: [cards[0]!.id, cards[1]!.id] },
    { title: "Test the loader", cardIds: [cards[2]!.id] },
  ];
  const source = mapSource(changeSet, cards, concerns);
  expect(mapProblems(concernMap, source)).toEqual([]);
  expect(mapProblems(concernMap.replace(" Test the loader", " Test the loader env"), source)).toEqual([
    "`Test the loader env` is at the top level but is not a concern title; the top level is the concern titles exactly as given",
  ]);
});

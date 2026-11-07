import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Experimental_DecisionMockModelV4, MockLanguageModelV4 } from "ai/test";
import { buildCards } from "../src/cards/build.ts";
import { type Sketch, sketchCards, sketchProblems, sketchSource } from "../src/cards/sketch.ts";
import { parseDiff } from "../src/core/diff.ts";
import type { Card, ChangeSet, Review } from "../src/core/types.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { RankCache } from "../src/rank/cache.ts";
import { applyRules } from "../src/rank/rules.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const cache = () => {
  const dir = mkdtempSync(join(tmpdir(), "lookout-sketch-"));
  dirs.push(dir);
  return new RankCache(dir);
};
const changeSet: ChangeSet = applyRules({
  target: "sketch",
  base: "a",
  head: "b",
  files: parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/user-env.diff`).text()),
});
// Every block of the diff in one behaviour card: five blocks over three files.
const card = (): Card => {
  const cards = buildCards(changeSet, DEFAULT_POLICY).filter((c) => !c.fixed);
  return { ...cards[0]!, blockIds: cards.flatMap((c) => c.blockIds), files: [...new Set(cards.flatMap((c) => c.files))] };
};
const good = [
  " main",
  "+  loadUserEnv()",
  "   parseArgs",
  "+loadUserEnv(path = USER_ENV_PATH, env = process.env)",
  "+  existsSync(path)",
].join("\n");
const writer = (texts: string[]) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: texts.shift() ?? good }],
      finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    }),
  });
const model = (checks: number[], calls: unknown[] = []) =>
  new Experimental_DecisionMockModelV4({
    doDecide: async (options) => {
      calls.push(options);
      return {
        answers: Object.fromEntries(
          Object.keys(options.questions).map((id) => [id, { type: "boolean", value: true, probability: checks.shift() ?? 0.95 }]),
        ),
        usage: { inputTokens: 1, outputTokens: 1 },
        warnings: [],
      };
    },
  });
const run = async (cards: Card[], language: MockLanguageModelV4, decision = model([])) => {
  const patches: Sketch[] = [];
  const res = await sketchCards(changeSet, cards, { modelSpec: "mock:w", cache: cache(), model: decision, writer: language }, (_id, s) =>
    patches.push(s),
  );
  return { patches, warning: res.warning };
};

test("a sketch that passes the rules and the consistency check is kept with its probability", async () => {
  const calls: unknown[] = [];
  const language = writer([`\`\`\`diff\n${good}\n\`\`\``]);
  const { patches } = await run([card()], language, model([0.9], calls));
  expect(patches).toEqual([{ sketch: good, sketchCheck: 0.9 }]);
  expect(language.doGenerateCalls).toHaveLength(1);
  expect(calls).toHaveLength(1);
});

test("a name absent from the edits and their context is rewritten once, quoting the line, then unverified", async () => {
  const invented = `${good}\n+  inventedLoader(path)`;
  const calls: unknown[] = [];
  const language = writer([invented, invented]);
  const { patches } = await run([card()], language, model([], calls));
  expect(patches).toEqual([{ sketch: invented, sketchUnverified: true }]);
  expect(language.doGenerateCalls).toHaveLength(2);
  expect(JSON.stringify(language.doGenerateCalls[1]!.prompt)).toContain("`+  inventedLoader(path)` names inventedLoader");
  // A rule failure costs no model check.
  expect(calls).toHaveLength(0);
});

test("a failed consistency check rewrites once; a verified redraw is kept", async () => {
  const language = writer([good, good]);
  const { patches } = await run([card()], language, model([0.6, 0.8]));
  expect(patches).toEqual([{ sketch: good, sketchCheck: 0.8 }]);
  expect(language.doGenerateCalls).toHaveLength(2);
});

test("a + line naming only what removed lines name fails, so a removal cannot be drawn as an addition", () => {
  const source = {
    edits: "-  explorer.listDashboards()\n+  explorer.listExplorerViews()",
    added: "explorer.listExplorerViews()",
    removed: "explorer.listDashboards()",
  };
  expect(sketchProblems("-  explorer.listDashboards", source)).toEqual([]);
  expect(sketchProblems("+  listDashboards", source)).toEqual(["`+  listDashboards` is marked + but names nothing an added line names"]);
  expect(sketchProblems("-  listExplorerViews", source)).toEqual([
    "`-  listExplorerViews` is marked - but names nothing a removed line names",
  ]);
});

test("only a lowercase word in angle brackets is a placeholder; a type name in brackets must be in the edits", () => {
  const added = "explorer.listExplorerViews(): Promise<View> // viewSaved:id";
  const source = { edits: `+${added}`, added, removed: "" };
  expect(sketchProblems("+  explorer.listExplorerViews → viewSaved:<id>", source)).toEqual([]);
  expect(sketchProblems("+  explorer.listExplorerViews → Promise<View>", source)).toEqual([]);
  expect(sketchProblems("+  explorer.listExplorerViews → <InventedType>", source)).toEqual([
    "`+  explorer.listExplorerViews → <InventedType>` names InventedType, which the edits do not show",
  ]);
});

test("a sketch drawn without a check is not served from the cache once a check model is available", async () => {
  const shared = cache();
  const opts = { modelSpec: "mock:w", cache: shared, writer: writer([good, good]) };
  const first: Sketch[] = [];
  await sketchCards(changeSet, [card()], opts, (_id, s) => first.push(s));
  const second: Sketch[] = [];
  await sketchCards(changeSet, [card()], { ...opts, model: model([0.9]) }, (_id, s) => second.push(s));
  expect(first).toEqual([{ sketch: good }]);
  expect(second).toEqual([{ sketch: good, sketchCheck: 0.9 }]);
});

test("a 13-line sketch or a line over 100 characters fails", () => {
  const source = sketchSource(changeSet, card());
  const lines = Array.from({ length: 13 }, () => "   loadUserEnv");
  expect(sketchProblems(lines.slice(0, 12).join("\n"), source)).toEqual([]);
  expect(sketchProblems(lines.join("\n"), source)).toEqual(["the sketch has 13 lines; at most 12"]);
  expect(sketchProblems(`   loadUserEnv${" ".repeat(90)}→ env`, source)).toHaveLength(1);
});

test("cards with two blocks or fewer, mechanical and fixed cards never get a call", async () => {
  const c = card();
  const language = writer([]);
  const { patches } = await run(
    [
      { ...c, id: "two", blockIds: c.blockIds.slice(0, 2) },
      { ...c, id: "mechanical", mechanical: true },
      { ...c, id: "clean", fixed: "clean" },
    ],
    language,
  );
  expect(patches).toEqual([]);
  expect(language.doGenerateCalls).toHaveLength(0);
});

const targets = readdirSync(`${import.meta.dir}/../fixtures/sketches`).filter((f) => f.endsWith(".md"));
test.each(targets)("the gate accepts the hand-written target %s", async (name) => {
  const text = await Bun.file(`${import.meta.dir}/../fixtures/sketches/${name}`).text();
  const review = (await Bun.file(`${import.meta.dir}/../fixtures/reviews/${/^review: (\S+)/m.exec(text)![1]}`).json()) as Review;
  const target = review.cards.find((c) => c.id === /^card: (\S+)/m.exec(text)![1])!;
  const sketch = /```diff\n([\s\S]*?)\n```/.exec(text)![1]!;
  expect(sketchProblems(sketch, sketchSource(review.changeSet, target))).toEqual([]);
});

test("six hand-written targets", () => expect(targets).toHaveLength(6));

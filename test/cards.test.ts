import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import { buildCards, colorFloor, untouchedAreas } from "../src/cards/build.ts";
import { allBlocks } from "../src/core/blocks.ts";
import { parseDiff } from "../src/core/diff.ts";
import { cardPatches, LocalSession } from "../src/core/session.ts";
import type { ReviewEvent } from "../src/core/store.ts";
import type { Card, ChangeSet } from "../src/core/types.ts";
import { DEFAULT_CONFIG } from "../src/dispatch/config.ts";
import { DispatchRunner } from "../src/dispatch/runner.ts";
import { DEFAULT_POLICY, validatePolicy } from "../src/policy/schema.ts";
import { RankCache } from "../src/rank/cache.ts";
import { rankWithModel } from "../src/rank/rank.ts";
import { applyRules } from "../src/rank/rules.ts";

const fixture = async (name: string): Promise<ChangeSet> => ({
  target: name,
  base: "a",
  head: "b",
  files: parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/${name}.diff`).text()),
});

const diff = (path: string, header: string, body: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, header, ...body].join("\n") + "\n";

describe("buildCards", () => {
  test("every block is in exactly one card; inert blocks are in the clean card, which is last", async () => {
    const cs = applyRules(await fixture("user-env"));
    const cards = buildCards(cs, DEFAULT_POLICY);
    const seen = new Map<string, number>();
    for (const c of cards) for (const id of c.blockIds) seen.set(id, (seen.get(id) ?? 0) + 1);
    const all = allBlocks(cs).map((r) => r.block);
    expect(seen.size).toBe(all.length);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    const inert = all.filter((b) => b.attention === "inert").map((b) => b.id);
    const clean = cards.find((c) => c.fixed === "clean");
    if (inert.length > 0) {
      expect(clean).toBeDefined();
      expect(clean!.blockIds.sort()).toEqual(inert.sort());
      expect(cards.at(-1)).toBe(clean);
      expect(clean!.color).toBe("grey");
    } else expect(clean).toBeUndefined();
  });

  test("no inert blocks → no clean card", () => {
    const cs = applyRules({ target: "t", base: "", head: "", files: parseDiff(diff("src/a.ts", "@@ -1,2 +1,2 @@", [" x", "-y", "+z"])) });
    expect(buildCards(cs, DEFAULT_POLICY).map((c) => c.fixed)).toEqual([undefined]);
  });

  test("cards are riskiest first; a sensitive-area card is red and sorts above routine", () => {
    const files = parseDiff(
      diff("src/util.ts", "@@ -1,2 +1,2 @@", [" a", "-b", "+c"]) +
        diff("src/auth/login.ts", "@@ -1,2 +1,2 @@", [" a", "-b", "+c"]) +
        diff("README.md", "@@ -1,2 +1,2 @@", [" a", "-b", "+c"]),
    );
    const cards = buildCards(applyRules({ target: "t", base: "", head: "", files }), DEFAULT_POLICY);
    expect(cards.map((c) => [c.title, c.color])).toEqual([
      ["src/auth/login.ts", "red"],
      ["src/util.ts", "green"],
      ["README.md", "green"],
    ]);
    expect(cards[0]!.areas).toEqual(["auth"]);
    expect(cards[0]!.labels).toContain("sensitive");
  });

  test("card ids are stable across re-ranking (same blocks → same id)", async () => {
    const cs = applyRules(await fixture("result-errors"));
    const a = buildCards(cs, DEFAULT_POLICY).map((c) => c.id).sort();
    const b = buildCards(applyRules(cs), DEFAULT_POLICY).map((c) => c.id).sort();
    expect(a).toEqual(b);
  });
});

describe("colorFloor", () => {
  const base: Pick<Card, "attention" | "areas" | "labels" | "kind"> = { attention: "routine", areas: [], labels: [], kind: "logic" };
  test("grey only for inert; red for suspicious, or areas/sensitive on a behaviour card; amber for needs-eyes and deps/config/ci", () => {
    expect(colorFloor({ ...base, attention: "inert" })).toBe("grey");
    expect(colorFloor(base)).toBe("green");
    expect(colorFloor({ ...base, attention: "needs-eyes" })).toBe("amber");
    expect(colorFloor({ ...base, kind: "deps" })).toBe("amber");
    expect(colorFloor({ ...base, attention: "suspicious" })).toBe("red");
    expect(colorFloor({ ...base, areas: ["billing"] })).toBe("red");
    expect(colorFloor({ ...base, labels: ["sensitive"] })).toBe("red");
  });
  test("a sensitive area does not redden tests, mechanical edits or docs; config there is amber; types follow attention; suspicious is always red", () => {
    const auth = { ...base, areas: ["auth"], attention: "needs-eyes" as const };
    expect(colorFloor({ ...auth, kind: "test" })).toBe("green");
    expect(colorFloor({ ...auth, blockKind: "test" })).toBe("green");
    expect(colorFloor({ ...auth, blockKind: "rename", mechanical: true })).toBe("green");
    expect(colorFloor({ ...auth, kind: "docs" })).toBe("green");
    expect(colorFloor({ ...auth, blockKind: "config" })).toBe("amber");
    expect(colorFloor({ ...auth, kind: "additive", blockKind: "types" })).toBe("red");
    expect(colorFloor({ ...base, attention: "needs-eyes", blockKind: "types" })).toBe("amber");
    expect(colorFloor({ ...auth, kind: "test", attention: "suspicious" })).toBe("red");
  });
});

describe("untouchedAreas", () => {
  test("lists policy areas no file touches, sorted", () => {
    const cs: ChangeSet = { target: "t", base: "", head: "", files: parseDiff(diff("src/auth/a.ts", "@@ -1 +1 @@", ["-a", "+b"])) };
    expect(untouchedAreas(cs, DEFAULT_POLICY)).toEqual(["billing", "data", "infra", "prompts"]);
    const own = validatePolicy({ areas: { auth: [], billing: [], data: [], infra: [], prompts: [], money: ["pay/**"] } }, "t");
    if (!own.ok) throw new Error(own.error);
    expect(untouchedAreas(cs, own.value)).toEqual(["money"]);
  });
});

describe("cardPatches", () => {
  const card = (id: string, color: Card["color"] = "green"): Card => ({ id, title: id, color, kind: "logic", areas: [], labels: [], blockIds: [id], attention: "routine", score: 0.1, claimIds: [], unmentioned: false, testsTouched: false });
  test("same order → one card.updated per changed card with only the changed fields", () => {
    const before = [card("a"), card("b")];
    const after = [card("a"), { ...card("b", "amber"), attention: "needs-eyes" as const }];
    expect(cardPatches(before, after, [])).toEqual([{ type: "card.updated", id: "b", patch: { color: "amber", attention: "needs-eyes" } }]);
    expect(cardPatches(before, before, [])).toEqual([]);
  });
  test("a changed order or set → one cards.replaced", () => {
    const before = [card("a"), card("b")];
    const after = [card("b"), card("a")];
    const events = cardPatches(before, after, ["billing"]);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("cards.replaced");
  });
});

describe("LocalSession", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "lookout-session-"));
    dirs.push(d);
    return d;
  };
  const mock = (scoreFor: (id: string) => number) =>
    new Experimental_DecisionMockModelV4({
      provider: "mock",
      modelId: "attention",
      supportedQuestionTypes: ["score", "choice"],
      doDecide: async ({ questions }) => ({
        answers: Object.fromEntries(
          Object.keys(questions).map((q) => (q.startsWith("kind_") ? [q, { type: "choice" as const, choice: "behavior" }] : [q, { type: "score" as const, score: scoreFor(q.replace("review_attention_", "")) }])),
        ),
        warnings: [],
      }),
    });
  const rankWith = (model: Experimental_DecisionMockModelV4) => (cs: ChangeSet, opts: Parameters<typeof rankWithModel>[1]) =>
    rankWithModel(cs, { ...opts, cache: new RankCache(tmp()), resolveModel: () => ({ ok: true, model }) });

  test("rules give an immediate snapshot; the model then patches cards and emits verdict + done", async () => {
    const cs = await fixture("result-errors");
    const target = cs.files[0]!.hunks[0]!.blocks[0]!.id;
    const session = new LocalSession({ config: DEFAULT_CONFIG, changeSet: cs, rank: rankWith(mock((id) => (id === target ? 3 : 1))) });
    const first = session.snapshot();
    expect(first.rankedBy).toBe("rules");
    expect(first.cards.length).toBeGreaterThan(0);
    const events: ReviewEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.ready();
    const after = session.snapshot();
    expect(after.rankedBy).toBe("rules+openai:gpt-6-luna");
    expect(after.cards.find((c) => c.blockIds.includes(target))!.color).toBe("red");
    const types = events.map((e) => e.type);
    expect(types.at(-1)).toBe("done");
    expect(types.some((t) => t === "card.updated" || t === "cards.replaced")).toBe(true);
    // Patches, not snapshots: no event carries a ChangeSet.
    expect(events.some((e) => "changeSet" in e)).toBe(false);
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  test("missing key → warning event, rules stay, done still fires", async () => {
    const session = new LocalSession({ config: DEFAULT_CONFIG, changeSet: await fixture("user-env"), env: {} });
    const events: ReviewEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.ready();
    expect(session.snapshot().rankedBy).toBe("rules");
    expect(events.find((e) => e.type === "warning")).toMatchObject({ type: "warning", text: expect.stringContaining("OPENAI_API_KEY") });
    expect(events.at(-1)!.type).toBe("done");
  });

  test("dispatchCard runs the dispatcher on that card's hunks and records cardId; unknown card and cancel-when-idle fail softly", async () => {
    const cs = await fixture("result-errors");
    const fake = `${import.meta.dir}/../fixtures/fake-dispatcher.sh`;
    const config = { ...DEFAULT_CONFIG, dispatchers: [{ name: "fake", cmd: `sh ${fake} {prompt_file}` }] };
    const repo = tmp();
    const session = new LocalSession({ config, changeSet: cs, env: {}, runner: (store) => new DispatchRunner(store, { repo, config }) });
    await session.ready();
    const card = session.snapshot().cards[0]!;
    expect((await session.command({ type: "dispatchCard", cardId: "nope" })).ok).toBe(false);
    expect((await session.command({ type: "cancel" })).ok).toBe(false);
    const started = await session.command({ type: "dispatchCard", cardId: card.id });
    expect(started.ok).toBe(true);
    await session.settled();
    const d = session.snapshot().dispatches[0]!;
    expect(d.scope).toBe("card");
    expect(d.cardId).toBe(card.id);
    expect(d.status).toBe("done");
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });
});

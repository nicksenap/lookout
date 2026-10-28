import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import { buildCards } from "../src/cards/build.ts";
import { parseDiff } from "../src/core/diff.ts";
import { LocalSession } from "../src/core/session.ts";
import type { ReviewEvent } from "../src/core/store.ts";
import type { Card, ChangeSet, Claim } from "../src/core/types.ts";
import { DEFAULT_CONFIG } from "../src/dispatch/config.ts";
import {
  ANSWER_MIN,
  applyClaims,
  authorDoor,
  CONTRADICTED_MIN,
  extractClaims,
  extractClaimsWithModel,
  gateStatus,
  groundClaims,
  judgeDoorClaim,
  needsModelExtraction,
  parseClaimList,
} from "../src/evidence/claims.ts";
import { attachDoorSignals, detectDoor, doorSignals } from "../src/evidence/door.ts";
import { markTests, stemOf } from "../src/evidence/tests.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { RankCache } from "../src/rank/cache.ts";
import { claimCardId, claimStatusId } from "../src/rank/model.ts";
import { rankWithModel } from "../src/rank/rank.ts";
import { applyRules } from "../src/rank/rules.ts";

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const fixture = async (name: string, intent?: ChangeSet["intent"]): Promise<ChangeSet> => {
  const cs: ChangeSet = {
    target: name,
    base: "a",
    head: "b",
    files: parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/${name}.diff`).text()),
  };
  if (intent) cs.intent = intent;
  return cs;
};
const diff = (path: string, header: string, body: string[]) =>
  `${[`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, header, ...body].join("\n")}\n`;

const BODY = `## Summary

Loads the API key from a user-level file so lookout works from any directory.

- Reads \`~/.config/lookout/.env\` at startup and never overrides variables already set in the shell
- Shell variables are overridden by the file
  so the file is the single source of truth
- src/cli/env.ts
- [x] Adds \`lookout\` to the PATH via \`~/.zshrc\`
  - and documents the new location
1. Numbered items count too

\`\`\`
- a bullet inside a fence is code, not a claim
\`\`\`
<!-- - a bullet in a comment is not a claim -->

## Evidence

- Test covers comments, quotes and a missing file
![screenshot](shot.png)

## Merge Danger

**Door:** two-way

**Blast Radius:** minimal
`;

describe("extractClaims", () => {
  test("bullets become claims tagged by section; paths, fences, comments and images are dropped; sub-bullets flatten", () => {
    const claims = extractClaims({ title: "t", body: BODY });
    expect(claims.map((c) => [c.section, c.text])).toEqual([
      ["summary", "Reads `~/.config/lookout/.env` at startup and never overrides variables already set in the shell"],
      ["summary", "Shell variables are overridden by the file so the file is the single source of truth"],
      ["summary", "Adds `lookout` to the PATH via `~/.zshrc`"],
      ["summary", "and documents the new location"],
      ["summary", "Numbered items count too"],
      ["evidence", "Test covers comments, quotes and a missing file"],
      ["door", "two-way"],
      ["radius", "minimal"],
    ]);
    expect(new Set(claims.map((c) => c.id)).size).toBe(claims.length);
    expect(claims[0]!.id).toBe(
      extractClaims({
        title: "x",
        body: "- reads `~/.config/lookout/.env`  at startup and never overrides variables already set in the shell",
      })[0]!.id,
    );
  });

  test("no body, or a body of only prose, yields no claims; prose asks for the model, bullets and empty bodies do not", () => {
    expect(extractClaims(undefined)).toEqual([]);
    expect(extractClaims({ title: "t", body: "   " })).toEqual([]);
    const prose = { title: "t", body: "This change makes the loader read the user env file before parsing arguments." };
    expect(extractClaims(prose)).toEqual([]);
    expect(needsModelExtraction(prose, [])).toBe(true);
    expect(needsModelExtraction({ title: "t", body: BODY }, extractClaims({ title: "t", body: BODY }))).toBe(false);
    expect(needsModelExtraction({ title: "t", body: "**Door:** one-way" }, extractClaims({ title: "t", body: "**Door:** one-way" }))).toBe(
      false,
    );
    expect(needsModelExtraction(undefined, [])).toBe(false);
  });

  test("model fallback parses its bullet list and treats `- none` as nothing", async () => {
    const intent = { title: "t", body: "Prose only, long enough to be worth a model call for claims." };
    const got = await extractClaimsWithModel(intent, {
      modelSpec: "mock:x",
      write: async (prompt) => (prompt.includes(intent.body) ? "- Reads the env file\n- Never overrides shell variables" : "- none"),
    });
    expect(got.claims.map((c) => c.text)).toEqual(["Reads the env file", "Never overrides shell variables"]);
    expect(parseClaimList("- none")).toEqual([]);
    const failed = await extractClaimsWithModel(intent, { modelSpec: "mock:x", write: async () => Promise.reject(new Error("down")) });
    expect(failed.claims).toEqual([]);
    expect(failed.warning).toContain("down");
    const noKey = await extractClaimsWithModel(intent, { modelSpec: "openai:gpt-6-luna", env: {} });
    expect(noKey.warning).toContain("OPENAI_API_KEY");
  });

  test("authorDoor reads the Door line, or a one-way/two-way phrase in the body", () => {
    const claims = extractClaims({ title: "t", body: BODY });
    expect(authorDoor({ title: "t", body: BODY }, claims)).toBe("two-way");
    expect(
      authorDoor(
        { title: "t", body: "Door: irreversible, drops a column" },
        extractClaims({ title: "t", body: "Door: irreversible, drops a column" }),
      ),
    ).toBe("one-way");
    expect(authorDoor({ title: "t", body: "This is a one-way door." }, [])).toBe("one-way");
    expect(authorDoor({ title: "t", body: "nothing here" }, [])).toBeUndefined();
  });
});

describe("confidence gate and door judgement", () => {
  test("contradicted needs 0.7; anything under 0.4 is unclear", () => {
    expect(gateStatus("contradicted", 0.5)).toBe("unclear");
    expect(gateStatus("contradicted", CONTRADICTED_MIN)).toBe("contradicted");
    expect(gateStatus("supported", 0.45)).toBe("supported");
    expect(gateStatus("supported", ANSWER_MIN - 0.01)).toBe("unclear");
    expect(gateStatus("not-in-diff", 0.76)).toBe("not-in-diff");
  });
  test("rules judge the door claim", () => {
    const oneWay = {
      computed: "one-way" as const,
      signals: [{ kind: "migration" as const, path: "db/migrations/1.sql", text: "migration file changed" }],
    };
    const twoWay = { computed: "two-way" as const, signals: [] };
    expect(judgeDoorClaim("two-way", oneWay).status).toBe("contradicted");
    expect(judgeDoorClaim("one-way", oneWay).status).toBe("supported");
    expect(judgeDoorClaim("one-way", twoWay).status).toBe("unclear");
    expect(judgeDoorClaim(undefined, twoWay).status).toBe("unclear");
  });
});

/** The SDK wraps a plain-object state into parts; the mock reads the JSON part back. */
const jsonState = (state: unknown): Record<string, unknown> => {
  const parts = state as { type: string; value?: unknown }[];
  return (Array.isArray(parts) ? parts.find((p) => p.type === "json")?.value : state) as Record<string, unknown>;
};
/** A complete distribution with `p` on `choice` and the rest spread over the other options. */
const distribution = (options: string[], choice: string, p: number): Record<string, number> =>
  Object.fromEntries(options.map((o) => [o, o === choice ? p : (1 - p) / (options.length - 1)]));

/** Mock decision model: answers status + card per claim from `answer`, counts calls. */
function groundingMock(answer: (claimText: string) => { status: string; p: number; card?: string }) {
  const calls: Record<string, unknown>[] = [];
  const model = new Experimental_DecisionMockModelV4({
    provider: "mock",
    modelId: "ground",
    supportedQuestionTypes: ["choice"],
    doDecide: async ({ questions, state }) => {
      calls.push(jsonState(state));
      const answers: Record<string, { type: "choice"; choice: string; probabilities?: Record<string, number> }> = {};
      for (const [id, q] of Object.entries(questions)) {
        const text = /"([^"]+)"/.exec(String(q.instructions))?.[1] ?? "";
        const a = answer(text);
        if (id.startsWith("claim_status_"))
          answers[id] = {
            type: "choice",
            choice: a.status,
            probabilities: distribution(Object.keys((q as { criteria?: Record<string, string> }).criteria ?? {}), a.status, a.p),
          };
        else answers[id] = { type: "choice", choice: a.card ?? "none" };
      }
      return { answers, warnings: [] };
    },
  });
  return { model, calls };
}

describe("groundClaims", () => {
  const setup = async () => {
    const cs = applyRules(await fixture("user-env", { title: "t", body: BODY }));
    const cards = buildCards(cs, DEFAULT_POLICY);
    const claims = extractClaims(cs.intent);
    const env = cards.find((c) => c.title === "src/cli/env.ts")!;
    return { cs, cards, claims, env };
  };

  test("one call, two questions per claim (status only for radius, none for door); statuses gated; no-evidence claim has no card; not-in-diff drops the card", async () => {
    const { cs, cards, claims, env } = await setup();
    const { model, calls } = groundingMock((text) => {
      if (text.startsWith("Reads")) return { status: "supported", p: 0.93, card: env.id };
      if (text.startsWith("Shell variables")) return { status: "contradicted", p: 0.88, card: env.id };
      if (text.startsWith("Adds `lookout`")) return { status: "not-in-diff", p: 0.76, card: env.id };
      if (text.startsWith("Numbered")) return { status: "contradicted", p: 0.5 };
      return { status: "supported", p: 0.8 };
    });
    const res = await groundClaims(cs, cards, claims, {
      modelSpec: "mock:ground",
      cache: new RankCache(tmp("lookout-ground-")),
      resolveModel: () => ({ ok: true, model }),
      radius: { areas: [], importers: ["x.ts"] },
    });
    expect(res.warning).toBeUndefined();
    expect(calls).toHaveLength(1);
    const by = (prefix: string) => res.claims.find((c) => c.text.startsWith(prefix))!;
    expect(by("Reads")).toMatchObject({ status: "supported", confidence: 0.93, cardId: env.id });
    expect(by("Shell variables")).toMatchObject({ status: "contradicted", cardId: env.id });
    expect(by("Adds `lookout`").status).toBe("not-in-diff");
    expect(by("Adds `lookout`").cardId).toBeUndefined();
    // The experiment's case: a ✗ at 50% is not red.
    expect(by("Numbered").status).toBe("unclear");
    expect(by("and documents")).toMatchObject({ status: "supported" });
    expect(by("and documents").cardId).toBeUndefined();
    // Door is never sent; radius goes with its status question only.
    expect(res.claims.find((c) => c.section === "door")!.status).toBeUndefined();
    expect(res.claims.find((c) => c.section === "radius")).toMatchObject({ status: "supported" });
  });

  test("question ids are stable per claim; the state carries cards with paragraphs, diffs and the radius", async () => {
    const { cs, cards, claims } = await setup();
    const withProse = cards.map((c) => ({ ...c, paragraph: `about ${c.title}` }));
    const seen: Record<string, unknown>[] = [];
    const model = new Experimental_DecisionMockModelV4({
      supportedQuestionTypes: ["choice"],
      doDecide: async ({ questions, state }) => {
        seen.push({ questions: Object.keys(questions), state: jsonState(state) });
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "choice" as const, choice: id.startsWith("claim_status_") ? "supported" : "none" },
            ]),
          ),
          warnings: [],
        };
      },
    });
    await groundClaims(cs, withProse, claims, {
      modelSpec: "mock:ground",
      cache: new RankCache(tmp("lookout-ground-")),
      resolveModel: () => ({ ok: true, model }),
      radius: { areas: ["auth"], importers: ["a.ts"] },
    });
    const ids = seen[0]!.questions as string[];
    const sent = claims.filter((c) => c.section !== "door");
    for (const c of sent) expect(ids).toContain(claimStatusId(c.id));
    for (const c of sent.filter((c) => c.section !== "radius")) expect(ids).toContain(claimCardId(c.id));
    expect(ids).not.toContain(claimCardId(claims.find((c) => c.section === "radius")!.id));
    expect(ids).toHaveLength(sent.length * 2 - 1);
    const state = seen[0]!.state as { cards: { paragraph: string; diff: string }[]; radius: { areas: string[] } };
    expect(state.cards.every((c) => c.paragraph.startsWith("about") && c.diff.includes("@@"))).toBe(true);
    expect(state.radius.areas).toEqual(["auth"]);
  });

  test("second run is served from the cache; a failed call or missing key leaves claims ungrounded with a warning", async () => {
    const { cs, cards, claims } = await setup();
    const dir = tmp("lookout-ground-");
    const first = groundingMock(() => ({ status: "supported", p: 0.9 }));
    await groundClaims(cs, cards, claims, {
      modelSpec: "mock:ground",
      cache: new RankCache(dir),
      resolveModel: () => ({ ok: true, model: first.model }),
    });
    const second = groundingMock(() => ({ status: "contradicted", p: 0.99 }));
    const again = await groundClaims(cs, cards, claims, {
      modelSpec: "mock:ground",
      cache: new RankCache(dir),
      resolveModel: () => ({ ok: true, model: second.model }),
    });
    expect(second.calls).toHaveLength(0);
    expect(again.claims.filter((c) => c.section !== "door").every((c) => c.status === "supported")).toBe(true);

    const broken = new Experimental_DecisionMockModelV4({
      supportedQuestionTypes: ["choice"],
      doDecide: async () => {
        throw new Error("boom");
      },
    });
    const failed = await groundClaims(cs, cards, claims, {
      modelSpec: "mock:ground",
      cache: new RankCache(tmp("lookout-ground-")),
      resolveModel: () => ({ ok: true, model: broken }),
    });
    expect(failed.warning).toContain("boom");
    expect(failed.claims.every((c) => c.status === undefined)).toBe(true);
    const noKey = await groundClaims(cs, cards, claims, {
      modelSpec: "openai:gpt-6-luna",
      env: {},
      cache: new RankCache(tmp("lookout-ground-")),
    });
    expect(noKey.warning).toContain("OPENAI_API_KEY");
    expect(await groundClaims(cs, cards, [], { modelSpec: "openai:gpt-6-luna", env: {} })).toEqual({ claims: [] });
  });

  test("applyClaims: cards get their claim ids; an uncovered card at needs-eyes or above is unmentioned, a routine or mechanical one is not", () => {
    const card = (id: string, attention: Card["attention"], extra: Partial<Card> = {}): Card => ({
      id,
      title: id,
      color: "green",
      kind: "logic",
      areas: [],
      labels: [],
      blockIds: [id],
      files: [id],
      attention,
      score: 0,
      claimIds: [],
      unmentioned: false,
      testsTouched: false,
      questions: [],
      ...extra,
    });
    const cards = [
      card("a", "needs-eyes"),
      card("b", "needs-eyes"),
      card("c", "routine"),
      card("d", "suspicious", { mechanical: true }),
      card("clean", "inert", { fixed: "clean" }),
    ];
    const claims: Claim[] = [
      { id: "1", text: "x", section: "summary", status: "supported", cardId: "a" },
      { id: "2", text: "y", section: "summary", status: "not-in-diff" },
    ];
    const out = applyClaims(cards, claims);
    expect(out.map((c) => [c.id, c.claimIds, c.unmentioned])).toEqual([
      ["a", ["1"], false],
      ["b", [], true],
      ["c", [], false],
      ["d", [], false],
      ["clean", [], false],
    ]);
    // No authored claims at all: nothing is unmentioned.
    expect(applyClaims(cards, [{ id: "3", text: "two-way", section: "door" }]).every((c) => !c.unmentioned)).toBe(true);
  });
});

describe("tests touched", () => {
  test("stems strip test markers and use the directory for index files", () => {
    expect(stemOf("src/cli/env.ts")).toBe("env");
    expect(stemOf("test/env.test.ts")).toBe("env");
    expect(stemOf("tests/test_env.py")).toBe("env");
    expect(stemOf("src/env_test.go")).toBe("env");
    expect(stemOf("src/policy/index.ts")).toBe("policy");
  });

  test("a test card covers the cards whose files it imports or shares a stem/dir with; others are untouched", async () => {
    const cs = applyRules(await fixture("user-env"));
    const cards = markTests(cs, buildCards(cs, DEFAULT_POLICY));
    const by = (title: string) => cards.find((c) => c.title === title)!;
    expect(by("src/cli/env.ts").testsTouched).toBe(true); // test/sources.test.ts imports ../src/cli/env.ts
    expect(by("src/cli/main.ts").testsTouched).toBe(false);
    expect(by("test/sources.test.ts").covers).toEqual([by("src/cli/env.ts").id]);
    expect(by("test/sources.test.ts").testsTouched).toBe(false);
  });

  test("a change with no test card leaves every card untouched", () => {
    const cs = applyRules({ target: "t", base: "", head: "", files: parseDiff(diff("src/a.ts", "@@ -1,2 +1,2 @@", [" x", "-y", "+z"])) });
    expect(markTests(cs, buildCards(cs, DEFAULT_POLICY)).map((c) => c.testsTouched)).toEqual([false]);
  });
});

describe("door", () => {
  test("migrations, destructive SQL, removed public exports and routes are one-way signals; test code and internal renames are not", () => {
    const files = parseDiff(
      diff("db/migrations/0042_drop_legacy.sql", "@@ -0,0 +1,2 @@", [
        "+ALTER TABLE users DROP COLUMN legacy_id;",
        "+INSERT INTO audit (what) VALUES ('drop');",
      ]) +
        diff("src/api/index.ts", "@@ -1,3 +1,2 @@", [
          "-export function legacyHandler() {}",
          "-router.get('/v1/legacy', legacyHandler);",
          " export function keep() {}",
          "+export function renamedKeep() {}",
        ]) +
        diff("src/rank/model.ts", "@@ -1,1 +1,1 @@", ["-export function scoreHunkBatch() {}", "+export function scoreBlockBatch() {}"]) +
        diff("test/db.test.ts", "@@ -1,1 +1,2 @@", [" x", "+await db.deleteMany({});"]),
    );
    const cs = applyRules({ target: "t", base: "", head: "", files });
    const signals = doorSignals(cs);
    expect(signals.map((s) => [s.kind, s.path])).toEqual([
      ["migration", "db/migrations/0042_drop_legacy.sql"],
      ["destructive-sql", "db/migrations/0042_drop_legacy.sql"],
      ["data-write", "db/migrations/0042_drop_legacy.sql"],
      ["removed-export", "src/api/index.ts"],
      ["removed-route", "src/api/index.ts"],
    ]);
    expect(signals.find((s) => s.kind === "removed-export")!.text).toBe("export legacyHandler removed");
    const door = detectDoor(cs, "two-way");
    expect(door).toMatchObject({ computed: "one-way", author: "two-way" });
    const cards = attachDoorSignals(cs, buildCards(cs, DEFAULT_POLICY), door.signals);
    expect(cards.find((c) => c.title.includes("api/index"))!.doorSignals!.map((s) => s.kind)).toEqual(["removed-export", "removed-route"]);
    expect(cards.find((c) => c.title.includes("model.ts"))!.doorSignals).toBeUndefined();
  });

  test("a plain edit is a two-way door", () => {
    const cs = applyRules({ target: "t", base: "", head: "", files: parseDiff(diff("src/a.ts", "@@ -1,2 +1,2 @@", [" x", "-y", "+z"])) });
    expect(detectDoor(cs, undefined)).toEqual({ computed: "two-way", signals: [] });
  });
});

describe("LocalSession evidence", () => {
  const rankMock = () =>
    new Experimental_DecisionMockModelV4({
      supportedQuestionTypes: ["score", "choice"],
      doDecide: async ({ questions }) => ({
        answers: Object.fromEntries(
          Object.keys(questions).map((q) =>
            q.startsWith("kind_")
              ? [q, { type: "choice" as const, choice: q.includes("test") ? "test" : "behavior" }]
              : [q, { type: "score" as const, score: 2 }],
          ),
        ),
        warnings: [],
      }),
    });

  test("with --evidence, claims are extracted from the intent at once, grounded after prose, and cards point at them", async () => {
    const cs = await fixture("user-env", { title: "t", body: BODY });
    const model = rankMock();
    const events: ReviewEvent[] = [];
    const session = new LocalSession({
      config: DEFAULT_CONFIG,
      changeSet: cs,
      evidence: true,
      repo: `${import.meta.dir}/..`,
      rank: (c, opts) => rankWithModel(c, { ...opts, cache: new RankCache(tmp("lookout-ev-")), resolveModel: () => ({ ok: true, model }) }),
      write: async () => "TITLE: Load user env\nPARAGRAPH: Reads the env file.",
      ground: async (_cs, cards, claims) => ({
        claims: claims.map((c) =>
          c.section === "door"
            ? c
            : { ...c, status: "supported" as const, confidence: 0.9, cardId: c.section === "radius" ? undefined : cards[0]!.id },
        ),
      }),
    });
    const first = session.snapshot();
    expect(first.claims.map((c) => c.section)).toEqual([
      "summary",
      "summary",
      "summary",
      "summary",
      "summary",
      "evidence",
      "door",
      "radius",
    ]);
    expect(first.claims.find((c) => c.section === "door")).toMatchObject({ status: "supported", confidence: 1 });
    expect(first.door).toEqual({ author: "two-way", computed: "two-way", signals: [] });
    expect(first.radius).toEqual({ areas: [], author: "minimal" });
    expect(first.cards.every((c) => c.claimIds.length === 0 && !c.unmentioned)).toBe(true);
    session.subscribe((e) => events.push(e));
    await session.ready();
    const after = session.snapshot();
    expect(after.claims.filter((c) => c.section === "summary").every((c) => c.status === "supported")).toBe(true);
    expect(after.cards[0]!.claimIds.length).toBeGreaterThan(0);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "claim.updated").length).toBe(7);
    expect(types.at(-1)).toBe("done");
    expect(events.some((e) => "changeSet" in e)).toBe(false);
  });

  test("without a key nothing is grounded, the door claim is still judged, and done fires", async () => {
    const session = new LocalSession({
      config: DEFAULT_CONFIG,
      changeSet: await fixture("user-env", { title: "t", body: BODY }),
      env: {},
      evidence: true,
    });
    await session.ready();
    const r = session.snapshot();
    expect(r.claims.filter((c) => c.section !== "door").every((c) => c.status === undefined)).toBe(true);
    expect(r.claims.find((c) => c.section === "door")!.status).toBe("supported");
  });

  test("without --evidence there are no claims, no questions, and dispatch is refused", async () => {
    const session = new LocalSession({ config: DEFAULT_CONFIG, changeSet: await fixture("user-env", { title: "t", body: BODY }), env: {} });
    await session.ready();
    const r = session.snapshot();
    expect(r.evidence).toBe(false);
    expect(r.claims).toEqual([]);
    expect(r.cards.every((c) => c.questions.length === 0 && !c.unmentioned)).toBe(true);
    expect(await session.command({ type: "dispatchAll" })).toMatchObject({ ok: false, error: expect.stringContaining("--evidence") });
  });
});

import { describe, expect, test } from "bun:test";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import { buildCards, untouchedAreas } from "../src/cards/build.ts";
import { parseDiff } from "../src/core/diff.ts";
import type { Card, ChangeSet, Review } from "../src/core/types.ts";
import { classify, evaluate } from "../src/policy/evaluate.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { pickQuestionId } from "../src/rank/model.ts";
import { BANK, candidatesFor } from "../src/questions/bank.ts";
import { answer, ASK_MIN, MAX_QUESTIONS, MIN_QUESTIONS, pickQuestions } from "../src/questions/pick.ts";

async function review(): Promise<Review> {
  const files = parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/result-errors.diff`).text());
  const cs: ChangeSet = { target: "t", base: "a", head: "b", files };
  const classification = classify(cs, DEFAULT_POLICY);
  return { changeSet: cs, classification, verdict: evaluate(classification, DEFAULT_POLICY), cards: buildCards(cs, DEFAULT_POLICY), untouched: untouchedAreas(cs, DEFAULT_POLICY), claims: [], door: { computed: "two-way", signals: [] }, radius: { areas: [] }, dispatches: [], rankedBy: "rules", evidence: true };
}
const card = (extra: Partial<Card>): Card => ({ id: "c", title: "c", color: "amber", kind: "logic", areas: [], labels: [], blockIds: ["b1", "b2", "b3"], files: ["f.ts"], attention: "needs-eyes", score: 0.5, claimIds: [], unmentioned: false, testsTouched: false, questions: [], ...extra });

describe("bank", () => {
  test("12 questions with unique ids; candidates follow tier and card shape; fixed cards get none", async () => {
    const r = await review();
    expect(BANK).toHaveLength(12);
    expect(new Set(BANK.map((q) => q.id)).size).toBe(12);
    const high = { ...r, verdict: { ...r.verdict, tier: "high" as const } };
    const low = { ...r, verdict: { ...r.verdict, tier: "low" as const } };
    const logic = card({});
    expect(candidatesFor(logic, high).map((q) => q.id)).toEqual(["intent", "error-path", "rollback", "pattern", "coverage", "security"]);
    expect(candidatesFor(logic, low).map((q) => q.id)).toEqual(["intent"]);
    expect(candidatesFor(card({ kind: "test", blockKind: "test" }), high).map((q) => q.id)).toEqual(["tests-claim"]);
    expect(candidatesFor(card({ mechanical: true, blockKind: "rename" }), high).map((q) => q.id)).toEqual(["rename-complete"]);
    expect(candidatesFor(card({ areas: ["auth"], unmentioned: true, doorSignals: [{ kind: "migration", path: "m.sql", text: "x" }] }), high).map((q) => q.id)).toContain("sensitive");
    expect(candidatesFor(card({ unmentioned: true }), low).map((q) => q.id)).toContain("unmentioned");
    expect(candidatesFor(card({ fixed: "clean" }), high)).toEqual([]);
  });
});

describe("pickQuestions", () => {
  test("the model ranks the rule candidates: those at or above ASK_MIN win, capped at MAX, padded to MIN", async () => {
    const r = await review();
    const high = { ...r, verdict: { ...r.verdict, tier: "high" as const }, cards: [card({ id: "many" }), card({ id: "few", kind: "test", blockKind: "test" }), card({ id: "clean", fixed: "clean" })] };
    const p: Record<string, number> = { [pickQuestionId("many", "security")]: 0.95, [pickQuestionId("many", "coverage")]: 0.9, [pickQuestionId("many", "intent")]: 0.8, [pickQuestionId("many", "rollback")]: 0.7, [pickQuestionId("many", "pattern")]: 0.6, [pickQuestionId("few", "tests-claim")]: 0.1 };
    let state: unknown;
    const model = new Experimental_DecisionMockModelV4({
      supportedQuestionTypes: ["boolean"],
      doDecide: async ({ questions, state: s }) => {
        state = s;
        return { answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "boolean" as const, probability: p[id] ?? 0.2 }])), warnings: [] };
      },
    });
    const res = await pickQuestions(high, { modelSpec: "mock:q", resolveModel: () => ({ ok: true, model }) });
    expect(res.warning).toBeUndefined();
    expect(res.questions.get("many")!.map((q) => q.id)).toEqual(["security", "coverage", "intent", "rollback"]);
    expect(res.questions.get("many")).toHaveLength(MAX_QUESTIONS);
    // Only one candidate below the gate: it is still asked, up to MIN.
    expect(res.questions.get("few")!.map((q) => q.id)).toEqual(["tests-claim"]);
    expect(res.questions.has("clean")).toBe(false);
    expect(ASK_MIN).toBe(0.5);
    expect(MIN_QUESTIONS).toBe(2);
    expect(JSON.stringify(state)).not.toContain("clean");
  });

  test("without a key, the first candidates in bank order stand, with a warning; a failing model too", async () => {
    const r = await review();
    const high = { ...r, verdict: { ...r.verdict, tier: "high" as const }, cards: [card({ id: "many" })] };
    const noKey = await pickQuestions(high, { modelSpec: "openai:gpt-6-luna", env: {} });
    expect(noKey.warning).toContain("OPENAI_API_KEY");
    expect(noKey.questions.get("many")!.map((q) => q.id)).toEqual(["intent", "error-path", "rollback"]);
    const broken = new Experimental_DecisionMockModelV4({
      supportedQuestionTypes: ["boolean"],
      doDecide: async () => {
        throw new Error("boom");
      },
    });
    const failed = await pickQuestions(high, { modelSpec: "mock:q", resolveModel: () => ({ ok: true, model: broken }) });
    expect(failed.warning).toContain("boom");
    expect(failed.questions.get("many")).toHaveLength(3);
  });

  test("cards with an answered question are left alone; answer() sets only the named question", async () => {
    const r = await review();
    const answered = card({ id: "done", questions: [{ id: "intent", text: "x", answer: "yes" }, { id: "rollback", text: "y" }] });
    const res = await pickQuestions({ ...r, cards: [answered] }, { modelSpec: "openai:gpt-6-luna", env: {} });
    expect(res.questions.size).toBe(0);
    expect(res.warning).toBeUndefined();
    expect(answer(answered, "rollback", "unsure").questions).toEqual([{ id: "intent", text: "x", answer: "yes" }, { id: "rollback", text: "y", answer: "unsure" }]);
  });
});

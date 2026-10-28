import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import { buildCards, untouchedAreas } from "../src/cards/build.ts";
import { parseDiff } from "../src/core/diff.ts";
import { LocalSession } from "../src/core/session.ts";
import type { ReviewEvent } from "../src/core/store.ts";
import type { ChangeSet, Finding, Review } from "../src/core/types.ts";
import { DEFAULT_CONFIG, validateConfig } from "../src/dispatch/config.ts";
import { parseDispatchOutput } from "../src/dispatch/parse.ts";
import { DispatchRunner } from "../src/dispatch/runner.ts";
import { classify, evaluate } from "../src/policy/evaluate.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { verdictQuestionId } from "../src/rank/model.ts";
import { buildVerifyPrompt, VERDICTS_CONTRACT } from "../src/verify/prompt.ts";
import { duplicates, judgeVerdicts, parseVerdicts, sameFinding, VERDICT_MIN, visibleFindings } from "../src/verify/verify.ts";

const PROPOSER = `${import.meta.dir}/../fixtures/fake-dispatcher.sh`;
const VERIFIER = `${import.meta.dir}/../fixtures/fake-verifier.sh`;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "lookout-verify-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function changeSet(): Promise<ChangeSet> {
  const files = parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/result-errors.diff`).text());
  return { target: "HEAD~1..HEAD", base: "a", head: "b", files, intent: { title: "Return Result everywhere", body: "Expected failures are returned, not thrown." } };
}
function review(cs: ChangeSet): Review {
  const classification = classify(cs, DEFAULT_POLICY);
  return { changeSet: cs, classification, verdict: evaluate(classification, DEFAULT_POLICY), cards: buildCards(cs, DEFAULT_POLICY), untouched: untouchedAreas(cs, DEFAULT_POLICY), claims: [], door: { computed: "two-way", signals: [] }, radius: { areas: [] }, dispatches: [], rankedBy: "rules" };
}
const finding = (id: string, title: string, extra: Partial<Finding> = {}): Finding => ({ id, severity: "p1", title, body: "", dispatcher: "fake", status: "proposed", preExisting: false, ...extra });
const fence = (json: string) => `chatter\n\`\`\`json\n${json}\n\`\`\`\n`;

describe("pre-existing", () => {
  test("an anchor on a context line marks the finding pre-existing; on an added line it does not", async () => {
    const cs = await changeSet();
    const hunk = cs.files[2]!.hunks[0]!;
    const context = hunk.lines.find((l) => l.kind === "context" && l.newLine !== undefined)!;
    const added = hunk.lines.find((l) => l.kind === "add")!;
    const out = parseDispatchOutput(fence(JSON.stringify({ findings: [{ severity: "p1", title: "old", path: hunk.path, line: context.newLine }, { severity: "p1", title: "new", path: hunk.path, line: added.newLine }] })), { dispatcher: "x", dispatchId: "d1", changeSet: cs });
    expect(out.findings.map((f) => [f.title, f.preExisting, f.status])).toEqual([
      ["old", true, "proposed"],
      ["new", false, "proposed"],
    ]);
  });
});

describe("dedupe", () => {
  test("same anchor and half the title words → duplicate; a different line or an unrelated title is not", () => {
    const a = finding("d1-1", "token compared with == not timingSafeEqual", { anchor: { path: "auth.ts", line: 51 } });
    expect(sameFinding(a, finding("d2-1", "Token is compared using == instead of timingSafeEqual", { anchor: { path: "auth.ts", line: 51 } }))).toBe(true);
    expect(sameFinding(a, finding("d2-2", "token compared with == not timingSafeEqual", { anchor: { path: "auth.ts", line: 52 } }))).toBe(false);
    expect(sameFinding(a, finding("d2-3", "missing null check on refresh result", { anchor: { path: "auth.ts", line: 51 } }))).toBe(false);
    expect(sameFinding(finding("x", "Unanchored thing"), finding("y", "unanchored thing"))).toBe(true);
  });

  test("duplicates maps each repeat to the earliest kept finding, within the run and against earlier runs", () => {
    const earlier = [finding("d1-1", "swallows the final error", { anchor: { path: "a.ts", line: 3 } }), finding("d1-2", "dup of something", { verifierNote: "duplicate of d0-9" })];
    const incoming = [
      finding("d2-1", "final error is swallowed", { anchor: { path: "a.ts", line: 3 } }),
      finding("d2-2", "new finding", { anchor: { path: "a.ts", line: 9 } }),
      finding("d2-3", "a new finding here", { anchor: { path: "a.ts", line: 9 } }),
      finding("d2-4", "dup of something"),
    ];
    const d = duplicates(incoming, earlier);
    expect([...d]).toEqual([
      ["d2-1", "d1-1"],
      ["d2-3", "d2-2"],
    ]);
  });
});

describe("parseVerdicts", () => {
  const ids = ["d1-1", "d1-2", "d1-3"];
  test("confirm / reject / unsure with notes; evidence and reason keys are accepted", () => {
    const r = parseVerdicts(fence('{"verdicts": [{"id": "d1-1", "verdict": "Confirmed", "evidence": "reachable"}, {"id": "d1-2", "verdict": "rejected", "reason": "validated upstream"}, {"id": "d1-3", "verdict": "unsure"}]}'), ids);
    expect(r.verdicts).toEqual([
      { findingId: "d1-1", verdict: "confirmed", note: "reachable" },
      { findingId: "d1-2", verdict: "rejected", note: "validated upstream" },
      { findingId: "d1-3", verdict: "unsure" },
    ]);
    expect(r.notes).toEqual([]);
    expect(r.freeform).toBe("chatter");
  });

  test("confirmed without evidence or rejected without a reason → unsure; unknown ids, repeats and bad verdicts are noted; missing ids stay proposed", () => {
    const r = parseVerdicts(fence('{"verdicts": [{"id": "d1-1", "verdict": "confirmed"}, {"id": "d1-2", "verdict": "rejected", "note": ""}, {"id": "d1-2", "verdict": "unsure"}, {"id": "d9-9", "verdict": "confirmed"}, {"id": "d1-3", "verdict": "maybe"}]}'), ids);
    expect(r.verdicts.map((v) => [v.findingId, v.verdict])).toEqual([
      ["d1-1", "unsure"],
      ["d1-2", "unsure"],
      ["d1-3", "unsure"],
    ]);
    expect(r.verdicts[0]!.note).toContain("no evidence");
    expect(r.notes).toEqual([
      "verdict 1 (d1-1): confirmed without evidence; using unsure",
      "verdict 2 (d1-2): rejected without a reason; using unsure",
      "verdict 3 skipped: a second verdict for d1-2",
      'verdict 4 skipped: "id" is not one of the findings asked about',
      'verdict 5 (d1-3): verdict "maybe" is not confirmed/rejected/unsure; using unsure',
    ]);
  });

  test("malformed or missing block → no verdicts, a note, everything stays proposed", () => {
    expect(parseVerdicts("I gave up.", ids)).toEqual({ verdicts: [], freeform: "I gave up.", notes: ["no ```json verdicts block in output"] });
    const bad = parseVerdicts(fence('{"verdicts": [{"id": '), ids);
    expect(bad.verdicts).toEqual([]);
    expect(bad.notes[0]).toMatch(/not valid JSON/);
    expect(parseVerdicts(fence('{"findings": []}'), ids).notes).toEqual(['last ```json block has no "verdicts" array']);
  });

  test("the fake verifier's modes parse as intended", async () => {
    const cs = await changeSet();
    const card = buildCards(cs, DEFAULT_POLICY)[0]!;
    const findings = [finding("d1-1", "a"), finding("d1-2", "b"), finding("d1-3", "c")];
    const promptFile = join(tmp(), "prompt.md");
    await Bun.write(promptFile, buildVerifyPrompt({ changeSet: cs, card, findings, repo: "/repo" }));
    const run = async (mode: string) => parseVerdicts(await new Response(Bun.spawn(["sh", VERIFIER, promptFile, mode], { stdout: "pipe" }).stdout).text(), findings.map((f) => f.id));
    expect((await run("confirm")).verdicts.map((v) => v.verdict)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect((await run("reject")).verdicts.map((v) => v.verdict)).toEqual(["rejected", "rejected", "rejected"]);
    expect((await run("unsure")).verdicts.map((v) => v.verdict)).toEqual(["unsure", "unsure", "unsure"]);
    const mixed = await run("mixed");
    expect(mixed.verdicts.map((v) => v.verdict)).toEqual(["confirmed", "unsure", "unsure"]);
    expect(mixed.notes).toHaveLength(2);
    expect((await run("malformed")).verdicts).toEqual([]);
    expect((await run("silent")).notes).toEqual(["no ```json verdicts block in output"]);
  });
});

describe("verify prompt", () => {
  test("lists each finding with id, severity, anchor and pre-existing; carries the card diff and the contract", async () => {
    const cs = await changeSet();
    const card = buildCards(cs, DEFAULT_POLICY)[0]!;
    const p = buildVerifyPrompt({ changeSet: cs, card, findings: [finding("d1-1", "Swallowed", { anchor: { path: "x.ts", line: 4 }, preExisting: true }), finding("d1-2", "Other", { severity: "p0" })], repo: "/repo" });
    expect(p).toContain("- d1-1 [P1] Swallowed (x.ts:4, a context line the change did not touch)");
    expect(p).toContain("- d1-2 [P0] Other\n");
    expect(p).toContain(`"${card.title}"`);
    expect(p).toContain("Title: Return Result everywhere");
    expect(p).toContain("```diff");
    expect(p).toContain(VERDICTS_CONTRACT);
  });
});

describe("judgeVerdicts", () => {
  test("a well-argued verdict stands with its confidence; a weak one becomes unsure with the gate in the note; unsure is never scored", async () => {
    const cs = await changeSet();
    const card = buildCards(cs, DEFAULT_POLICY)[0]!;
    const findings = [finding("d1-1", "a"), finding("d1-2", "b"), finding("d1-3", "c")];
    const verdicts = [
      { findingId: "d1-1", verdict: "confirmed" as const, note: "reachable from main" },
      { findingId: "d1-2", verdict: "rejected" as const, note: "nope" },
      { findingId: "d1-3", verdict: "unsure" as const },
    ];
    const asked: string[] = [];
    const model = new Experimental_DecisionMockModelV4({
      supportedQuestionTypes: ["boolean"],
      doDecide: async ({ questions }) => {
        asked.push(...Object.keys(questions));
        return { answers: { [verdictQuestionId("d1-1")]: { type: "boolean", probability: 0.93 }, [verdictQuestionId("d1-2")]: { type: "boolean", probability: 0.31 } }, warnings: [] };
      },
    });
    const res = await judgeVerdicts(cs, card, findings, verdicts, "fake", { modelSpec: "mock:x", resolveModel: () => ({ ok: true, model }) });
    expect(res.warning).toBeUndefined();
    expect(asked.sort()).toEqual([verdictQuestionId("d1-1"), verdictQuestionId("d1-2")]);
    expect(res.patches.get("d1-1")).toEqual({ status: "confirmed", verifiedBy: "fake", verifierNote: "reachable from main", confidence: 0.93 });
    expect(res.patches.get("d1-2")).toMatchObject({ status: "unsure", confidence: 0.31, verifierNote: "rejected by fake at 31%: nope" });
    expect(res.patches.get("d1-3")).toEqual({ status: "unsure", verifiedBy: "fake" });
    expect(VERDICT_MIN).toBe(0.7);
  });

  test("no key or a failing model → the verifier's word stands, with a warning", async () => {
    const cs = await changeSet();
    const card = buildCards(cs, DEFAULT_POLICY)[0]!;
    const findings = [finding("d1-1", "a")];
    const verdicts = [{ findingId: "d1-1", verdict: "confirmed" as const, note: "yes" }];
    const noKey = await judgeVerdicts(cs, card, findings, verdicts, "fake", { modelSpec: "openai:gpt-6-luna", env: {} });
    expect(noKey.warning).toContain("OPENAI_API_KEY");
    expect(noKey.patches.get("d1-1")).toEqual({ status: "confirmed", verifiedBy: "fake", verifierNote: "yes" });
    const broken = new Experimental_DecisionMockModelV4({
      supportedQuestionTypes: ["boolean"],
      doDecide: async () => {
        throw new Error("boom");
      },
    });
    const failed = await judgeVerdicts(cs, card, findings, verdicts, "fake", { modelSpec: "mock:x", resolveModel: () => ({ ok: true, model: broken }) });
    expect(failed.warning).toContain("boom");
    expect(failed.patches.get("d1-1")!.status).toBe("confirmed");
  });
});

describe("visibleFindings", () => {
  test("default hides rejected and unsure p2; --all shows everything", () => {
    const all = [finding("1", "a", { status: "confirmed" }), finding("2", "b", { status: "proposed" }), finding("3", "c", { status: "unsure" }), finding("4", "d", { status: "unsure", severity: "p2" }), finding("5", "e", { status: "rejected" })];
    expect(visibleFindings(all, false).map((f) => f.id)).toEqual(["1", "2", "3"]);
    expect(visibleFindings(all, true)).toHaveLength(5);
  });
});

describe("config [verify]", () => {
  test("verify.dispatcher must name a dispatcher", () => {
    const ok = validateConfig({ dispatch: { pi: { cmd: "pi {prompt_file}" }, claude: { cmd: "claude {prompt}" } }, verify: { dispatcher: "claude" } }, "c");
    expect(ok.ok && ok.value.verifier).toBe("claude");
    const bad = validateConfig({ verify: { dispatcher: "nope" } }, "c");
    expect(!bad.ok && bad.error).toContain("verify.dispatcher must name a [dispatch.<name>] (have: pi)");
    const key = validateConfig({ verify: { agent: "pi" } }, "c");
    expect(!key.ok && key.error).toContain('unknown key "verify.agent"');
  });
});

describe("LocalSession propose → verify", () => {
  const config = (verifierMode: string) => ({
    ...DEFAULT_CONFIG,
    dispatchers: [
      { name: "propose", cmd: `sh ${PROPOSER} {prompt_file}` },
      { name: "verify", cmd: `sh ${VERIFIER} {prompt_file} ${verifierMode}` },
    ],
    verifier: "verify",
  });

  async function run(verifierMode: string, presses = 1) {
    const cs = await changeSet();
    const cfg = config(verifierMode);
    const repo = tmp();
    const session = new LocalSession({ config: cfg, changeSet: cs, env: {}, runner: (store) => new DispatchRunner(store, { repo, config: cfg }) });
    await session.ready();
    const events: ReviewEvent[] = [];
    session.subscribe((e) => events.push(e));
    const card = session.snapshot().cards[0]!;
    for (let k = 0; k < presses; k++) {
      expect((await session.command({ type: "dispatchCard", cardId: card.id })).ok).toBe(true);
      await session.settled();
    }
    return { session, events, card, review: session.snapshot() };
  }

  test("a runs the proposer, then the verifier on its findings; confirmed lands as a finding.updated patch", async () => {
    const { review, events, card } = await run("confirm");
    expect(review.dispatches.map((d) => [d.role, d.status, d.cardId])).toEqual([
      ["proposer", "done", card.id],
      ["verifier", "done", card.id],
    ]);
    const [proposal, verification] = review.dispatches;
    expect(verification!.verifies).toEqual(proposal!.findings.map((f) => f.id));
    expect(verification!.verdicts).toHaveLength(1);
    expect(proposal!.findings[0]).toMatchObject({ status: "confirmed", verifiedBy: "verify", verifierNote: expect.stringContaining("evidence:") });
    // Without a key the verdict is not scored; the verifier's word stands and the warning says so.
    expect(proposal!.findings[0]!.confidence).toBeUndefined();
    expect(events.filter((e) => e.type === "dispatch.started")).toHaveLength(2);
    expect(events.find((e) => e.type === "finding.updated")).toMatchObject({ type: "finding.updated", dispatchId: proposal!.id, id: proposal!.findings[0]!.id, patch: { status: "confirmed" } });
    expect(events.find((e) => e.type === "warning")).toMatchObject({ text: expect.stringContaining("Verdicts not scored") });
  });

  test("rejected and unsure verdicts, and a malformed verifier, each leave the right status", async () => {
    expect((await run("reject")).review.dispatches[0]!.findings[0]!.status).toBe("rejected");
    expect((await run("unsure")).review.dispatches[0]!.findings[0]!.status).toBe("unsure");
    const malformed = (await run("malformed")).review;
    expect(malformed.dispatches[0]!.findings[0]!.status).toBe("proposed");
    expect(malformed.dispatches[1]!.freeform).toContain("lookout: last ```json verdicts block is not valid JSON");
  });

  test("pressing a again drops the repeat as a duplicate and skips the verifier", async () => {
    const { review } = await run("confirm", 2);
    expect(review.dispatches.map((d) => d.role)).toEqual(["proposer", "verifier", "proposer"]);
    const first = review.dispatches[0]!.findings[0]!;
    expect(review.dispatches[2]!.findings[0]).toMatchObject({ status: "rejected", verifierNote: `duplicate of ${first.id}` });
    expect(first.status).toBe("confirmed");
  });

  test("answerQuestion records the answer and patches the card; unknown ids fail softly", async () => {
    const cs = await changeSet();
    const session = new LocalSession({ config: DEFAULT_CONFIG, changeSet: cs, env: {} });
    await session.ready();
    const card = session.snapshot().cards.find((c) => c.questions.length > 0)!;
    expect(card).toBeDefined();
    const events: ReviewEvent[] = [];
    session.subscribe((e) => events.push(e));
    expect((await session.command({ type: "answerQuestion", cardId: card.id, questionId: "nope", answer: "yes" })).ok).toBe(false);
    expect((await session.command({ type: "answerQuestion", cardId: card.id, questionId: card.questions[0]!.id, answer: "no" })).ok).toBe(true);
    const after = session.snapshot().cards.find((c) => c.id === card.id)!;
    expect(after.questions[0]!.answer).toBe("no");
    expect(events).toEqual([{ type: "card.updated", id: card.id, patch: { questions: after.questions } }]);
  });
});

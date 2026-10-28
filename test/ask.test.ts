import { describe, expect, test } from "bun:test";
import { ask, askPrompt } from "../src/ask/ask.ts";
import { buildCards } from "../src/cards/build.ts";
import { mapBlocks } from "../src/core/blocks.ts";
import { parseDiff } from "../src/core/diff.ts";
import { LocalSession, type ReviewEvent } from "../src/core/session.ts";
import type { ChangeSet, Review } from "../src/core/types.ts";
import { DEFAULT_CONFIG } from "../src/dispatch/config.ts";
import { classify, evaluate } from "../src/policy/evaluate.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { RankCache } from "../src/rank/cache.ts";
import { applyRules } from "../src/rank/rules.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const diff = (path: string, body: string[]) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${body.filter((l) => !l.startsWith("+")).length} +1,${body.filter((l) => !l.startsWith("-")).length} @@`, ...body].join("\n") + "\n";
const text = diff("src/retry.ts", [" a", "-retry(1);", "+retry(3);", " b"]) + diff("src/route.ts", [" x", "-return 500;", "+return 503;", " y"]);
const cs: ChangeSet = mapBlocks(applyRules({ target: "t", base: "", head: "", files: parseDiff(text), intent: { title: "Retry token refresh", body: "" } }), ({ block }) => ({ ...block, kind: "behavior" }));
const review = (): Review => {
  const classification = classify(cs, DEFAULT_POLICY);
  const cards = buildCards(cs, DEFAULT_POLICY).map((c, k) => ({ ...c, title: `Card ${k + 1}`, paragraph: `Paragraph ${k + 1}.` }));
  return { changeSet: cs, classification, verdict: evaluate(classification, DEFAULT_POLICY), cards, untouched: [], claims: [], door: { computed: "two-way", signals: [] }, radius: { areas: [] }, dispatches: [], rankedBy: "rules+mock", evidence: false, exchanges: [] };
};

describe("ask", () => {
  test("a card question is grounded in that card's edits only; a change question gets every card's summary and edits", () => {
    const r = review();
    const retry = r.cards.find((c) => c.files.includes("src/retry.ts"))!;
    const one = askPrompt(r, "why 3?", retry);
    expect(one.prompt).toContain("retry(3)");
    expect(one.prompt).not.toContain("return 503");
    expect(one.prompt).toContain(`"${retry.title}"`);
    const all = askPrompt(r, "what changes for callers?");
    expect(all.prompt).toContain("retry(3)");
    expect(all.prompt).toContain("return 503");
    expect(all.prompt).toContain("1. Card 1 — Paragraph 1.");
    expect(all.prompt).toContain("Retry token refresh");
  });

  test("the answer is gated: under 0.7 it is kept but unverified; a failed write is an error; an empty answer is an error", async () => {
    const r = review();
    const good = await ask(r, "q", undefined, { modelSpec: "mock:w", write: async () => "Three attempts.", check: async () => 0.9 });
    expect(good).toEqual({ ok: true, value: { text: "Three attempts.", check: 0.9 } });
    const weak = await ask(r, "q", undefined, { modelSpec: "mock:w", write: async () => "Maybe.", check: async () => 0.3 });
    expect(weak).toEqual({ ok: true, value: { text: "Maybe.", check: 0.3, unverified: true } });
    const ungated = await ask(r, "q", undefined, { modelSpec: "mock:w", write: async () => "Plain.", check: async () => Promise.reject(new Error("down")) });
    expect(ungated).toEqual({ ok: true, value: { text: "Plain." } });
    expect((await ask(r, "q", undefined, { modelSpec: "mock:w", write: async () => Promise.reject(new Error("boom")) })).ok).toBe(false);
    expect((await ask(r, "q", undefined, { modelSpec: "mock:w", write: async () => "  " })).ok).toBe(false);
  });

  test("session: ask adds a pending exchange at once, patches the answer when it lands, and rejects an empty or unknown-card question", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookout-ask-"));
    const session = new LocalSession({
      config: DEFAULT_CONFIG,
      changeSet: cs,
      cache: new RankCache(dir),
      rank: async (ruled) => ({ changeSet: mapBlocks(ruled, ({ block }) => ({ ...block, kind: "behavior" as const })), rankedBy: "rules+mock" }),
      write: async (prompt) => (prompt.includes("Question:") ? "Because the old code retried once." : "TITLE: Card\nPARAGRAPH: Text."),
      check: async () => 0.95,
    });
    const events: ReviewEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.ready();
    expect(await session.command({ type: "ask", text: "   " })).toMatchObject({ ok: false });
    expect(await session.command({ type: "ask", text: "why?", cardId: "nope" })).toMatchObject({ ok: false });
    const card = session.snapshot().cards[0]!;
    const answered = new Promise<void>((resolve) => session.subscribe((e) => e.type === "exchange.updated" && resolve()));
    expect(await session.command({ type: "ask", text: "why 3?", cardId: card.id })).toEqual({ ok: true, value: undefined });
    expect(session.snapshot().exchanges).toMatchObject([{ question: "why 3?", cardId: card.id, status: "pending" }]);
    await answered;
    expect(session.snapshot().exchanges[0]).toMatchObject({ status: "answered", answer: "Because the old code retried once.", check: 0.95 });
    expect(events.filter((e) => e.type === "exchange.added")).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("session: progress events run ranking → writing and clear on done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookout-progress-"));
    const session = new LocalSession({
      config: DEFAULT_CONFIG,
      changeSet: cs,
      cache: new RankCache(dir),
      rank: async (ruled, opts) => {
        // The real ranker reports after its first await; the TUI subscribes right after construction and reads the rest from the snapshot.
        await Promise.resolve();
        opts.onProgress?.(0, 1);
        opts.onProgress?.(1, 1);
        return { changeSet: mapBlocks(ruled, ({ block }) => ({ ...block, kind: "behavior" as const })), rankedBy: "rules+mock" };
      },
      write: async () => "TITLE: Card\nPARAGRAPH: Text.",
    });
    const seen: (string | undefined)[] = [];
    session.subscribe((e) => e.type === "progress" && seen.push(e.progress ? `${e.progress.phase} ${e.progress.done}/${e.progress.total}` : undefined));
    await session.ready();
    expect(seen).toEqual(["ranking 0/1", "ranking 1/1", "writing 0/2", "writing 1/2", "writing 2/2", undefined]);
    expect(session.snapshot().progress).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

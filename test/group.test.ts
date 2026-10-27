import { describe, expect, test } from "bun:test";
import { buildCards } from "../src/cards/build.ts";
import { changedIdentifiers, groupBlocks, mechanicalText } from "../src/cards/group.ts";
import { parseProse, prosePrompt, writeCards } from "../src/cards/write.ts";
import { allBlocks, mapBlocks } from "../src/core/blocks.ts";
import { parseDiff } from "../src/core/diff.ts";
import { LocalSession } from "../src/core/session.ts";
import type { ReviewEvent } from "../src/core/store.ts";
import type { BlockKind, ChangeSet } from "../src/core/types.ts";
import { DEFAULT_CONFIG } from "../src/dispatch/config.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { RankCache } from "../src/rank/cache.ts";
import { applyRules } from "../src/rank/rules.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const diff = (path: string, header: string, body: string[]) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, header, ...body].join("\n") + "\n";
const cs = (text: string, kinds: (BlockKind | undefined)[]): ChangeSet => {
  let k = 0;
  return mapBlocks(applyRules({ target: "t", base: "", head: "", files: parseDiff(text) }), ({ block }) => {
    const kind = kinds[k++];
    return kind ? { ...block, kind } : block;
  });
};

describe("groupBlocks", () => {
  test("blocks sharing a changed identifier merge within a kind; a different kind stays apart", () => {
    const text =
      diff("src/a.ts", "@@ -1,3 +1,3 @@", [" x", "-const budget = 1;", "+const budgetPeriod = 1;", " y"]) +
      diff("src/b.ts", "@@ -1,3 +1,3 @@", [" x", "-render(a);", "+render(a, budgetPeriod);", " y"]) +
      diff("src/c.test.ts", "@@ -1,3 +1,3 @@", [" x", "-expect(1);", "+expect(budgetPeriod);", " y"]);
    const groups = groupBlocks(allBlocks(cs(text, ["behavior", "behavior", "test"])));
    expect(groups.map((g) => g.refs.length).sort()).toEqual([1, 2]);
    expect(groups.find((g) => g.refs.length === 2)!.kind).toBe("behavior");
  });

  test("an orphan edit (no identifiers) joins the previous block of its hunk", () => {
    const text = diff("src/a.ts", "@@ -1,8 +1,8 @@", [" a", "-const foo = () => {", "+function foo() {", " b", " c", " d", " e", "-};", "+}"]);
    const groups = groupBlocks(allBlocks(cs(text, ["typing-refactor", "typing-refactor"])));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.refs).toHaveLength(2);
  });

  test("mechanical kinds group per file regardless of identifiers; title and paragraph are deterministic", () => {
    const text = diff("src/a.tsx", "@@ -1,9 +1,9 @@", [" a", "-const A: React.FC = () => 1;", "+function A() { return 1 }", " b", " c", " d", " e", " f", "-const B: React.FC = () => 2;", "+function B() { return 2 }"]);
    const groups = groupBlocks(allBlocks(cs(text, ["typing-refactor", "typing-refactor"])), { neighbourLines: 0 });
    expect(groups).toHaveLength(1);
    const t = mechanicalText(groups[0]!);
    expect(t.title).toBe("Typing refactor in a.tsx");
    expect(t.paragraph).toContain("2 edits");
    expect(t.paragraph).toContain("runtime behaviour is unchanged");
  });

  test("same kind, same file, within a few lines merges; far apart with no shared identifiers does not", () => {
    const near = diff("src/a.ts", "@@ -1,6 +1,6 @@", [" a", "-one();", "+uno();", " b", "-two();", "+dos();"]);
    expect(groupBlocks(allBlocks(cs(near, ["behavior", "behavior"])))).toHaveLength(1);
    const far = diff("src/a.ts", "@@ -1,3 +1,3 @@", [" a", "-one();", "+uno();", " b"]) .replace("@@ -1,3 +1,3 @@", "@@ -1,3 +1,3 @@") + diff("src/a.ts", "@@ -100,3 +100,3 @@", [" z", "-two();", "+dos();", " w"]);
    expect(groupBlocks(allBlocks(cs(far, ["behavior", "behavior"])))).toHaveLength(2);
  });

  test("changedIdentifiers ignores keywords and noise", () => {
    const [ref] = allBlocks(cs(diff("a.ts", "@@ -1 +1 @@", ["-const value = React.useMemo(() => budgetPeriod, []);", "+const value = React.useMemo(() => showBudget, []);"]), ["behavior"]));
    expect([...changedIdentifiers(ref!)].sort()).toEqual(["budgetPeriod", "showBudget"]);
  });
});

describe("buildCards with kinds", () => {
  test("mechanical cards carry deterministic prose and blockKind; behaviour cards have a placeholder title and no paragraph", () => {
    const text = diff("src/a.tsx", "@@ -1,3 +1,3 @@", [" a", "-const A: React.FC = () => 1;", "+function A() { return 1 }", " b"]) + diff("src/b.ts", "@@ -1,3 +1,3 @@", [" a", "-retry(1);", "+retry(3);", " b"]);
    const cards = buildCards(cs(text, ["typing-refactor", "behavior"]), DEFAULT_POLICY);
    const mech = cards.find((c) => c.mechanical)!;
    expect(mech.blockKind).toBe("typing-refactor");
    expect(mech.paragraph).toContain("runtime behaviour is unchanged");
    const beh = cards.find((c) => !c.mechanical)!;
    expect(beh.blockKind).toBe("behavior");
    expect(beh.paragraph).toBeUndefined();
    expect(beh.title).toContain("src/b.ts");
  });
  test("without kinds (rules-only) the per-file stand-in is used", () => {
    const text = diff("src/a.ts", "@@ -1,3 +1,3 @@", [" a", "-x();", "+y();", " b"]) + diff("src/a.ts", "@@ -50,3 +50,3 @@", [" a", "-p();", "+q();", " b"]);
    const cards = buildCards(cs(text, [undefined, undefined]), DEFAULT_POLICY);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.title).toBe("src/a.ts");
  });
});

describe("writer", () => {
  test("parseProse reads the labelled format and tolerates an unlabelled two-line reply", () => {
    expect(parseProse("TITLE: Add retry\nPARAGRAPH: Wraps refresh in a retry.\nSecond sentence.")).toEqual({ title: "Add retry", paragraph: "Wraps refresh in a retry. Second sentence." });
    expect(parseProse("**Add retry**\nWraps refresh in a retry.")).toEqual({ title: "Add retry", paragraph: "Wraps refresh in a retry." });
    expect(parseProse("just one line")).toBeUndefined();
  });

  test("prompt contains only the card's edits", () => {
    const text = diff("src/a.ts", "@@ -1,3 +1,3 @@", [" a", "-alpha();", "+beta();", " b"]) + diff("src/z.ts", "@@ -1,3 +1,3 @@", [" a", "-gamma();", "+delta();", " b"]);
    const set = cs(text, ["behavior", "behavior"]);
    const cards = buildCards(set, DEFAULT_POLICY);
    expect(cards).toHaveLength(2);
    const p = prosePrompt(set, cards.find((c) => c.title.includes("src/a.ts"))!);
    expect(p).toContain("beta()");
    expect(p).not.toContain("delta()");
  });

  test("writeCards skips mechanical and fixed cards, writes the rest in parallel, caches, and reports a failure as a warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookout-write-"));
    const text = diff("src/a.tsx", "@@ -1,3 +1,3 @@", [" a", "-const A: React.FC = () => 1;", "+function A() { return 1 }", " b"]) + diff("src/b.ts", "@@ -1,3 +1,3 @@", [" a", "-retry(1);", "+retry(3);", " b"]) + diff("src/c.ts", "@@ -1,3 +1,3 @@", [" a", "-boom(1);", "+boom(3);", " b"]);
    const set = cs(text, ["typing-refactor", "behavior", "behavior"]);
    const cards = buildCards(set, DEFAULT_POLICY);
    const prompts: string[] = [];
    const write = async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.includes("boom")) throw new Error("rate limited");
      return "TITLE: Retry three times\nPARAGRAPH: `retry` is now called with 3 instead of 1.";
    };
    const landed: string[] = [];
    const res = await writeCards(set, cards, { modelSpec: "mock:w", cache: new RankCache(dir), write }, (id) => landed.push(id));
    expect(prompts).toHaveLength(2); // not the mechanical card
    expect(landed).toHaveLength(1);
    expect(res.warning).toContain("rate limited");
    // second run: cached, no call for the one that succeeded
    const again: string[] = [];
    await writeCards(set, cards, { modelSpec: "mock:w", cache: new RankCache(dir), write: async (p) => { again.push(p); throw new Error("x"); } }, () => {});
    expect(again).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("LocalSession prose", () => {
  test("after model ranking, titles and paragraphs arrive as card.updated patches before done", async () => {
    const text = diff("src/b.ts", "@@ -1,3 +1,3 @@", [" a", "-retry(1);", "+retry(3);", " b"]);
    const base: ChangeSet = { target: "t", base: "", head: "", files: parseDiff(text) };
    const session = new LocalSession({
      config: DEFAULT_CONFIG,
      changeSet: base,
      rank: async (ruled) => ({ changeSet: mapBlocks(ruled, ({ block }) => ({ ...block, kind: "behavior" as const })), rankedBy: "rules+mock" }),
      write: async () => "TITLE: Retry three times\nPARAGRAPH: `retry` is now called with 3.",
    });
    const events: ReviewEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.ready();
    const prose = events.filter((e) => e.type === "card.updated" && "paragraph" in (e as { patch: object }).patch);
    expect(prose).toHaveLength(1);
    expect(events.at(-1)!.type).toBe("done");
    expect(session.snapshot().cards[0]!.title).toBe("Retry three times");
  });
});

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { render } from "ink-testing-library";
import { buildCards, untouchedAreas } from "../src/cards/build.ts";
import { isMechanical, isOrphan } from "../src/cards/group.ts";
import { allBlocks } from "../src/core/blocks.ts";
import type { Review } from "../src/core/types.ts";
import { classify, evaluate } from "../src/policy/evaluate.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { App } from "../src/tui/App.tsx";
import { FixtureSession } from "../stories/fixture-session.ts";

/**
 * Properties that must hold for every saved review, whatever PR it came from. Fixtures span a
 * 1-file CSS fix, a 2-file null-handling fix, a 9-file routing change, a 16-file backend change
 * and three UI features, so a rule that fits one PR and breaks another fails here.
 */
const names: string[] = [];
for await (const f of new Glob("*.json").scan(`${import.meta.dir}/../fixtures/reviews`)) names.push(f.replace(/\.json$/, ""));
const load = (name: string): Promise<Review> => Bun.file(`${import.meta.dir}/../fixtures/reviews/${name}.json`).json();
const ANSI = /\x1b\[[0-9;]*m/g;

describe.each(names)("fixture %s", (name) => {
  test("every block is in exactly one card; rebuilding from the change set reproduces the card set", async () => {
    const review = await load(name);
    const blocks = allBlocks(review.changeSet).map((r) => r.block.id);
    const inCards = review.cards.flatMap((c) => c.blockIds);
    expect(inCards.length).toBe(blocks.length);
    expect(new Set(inCards).size).toBe(blocks.length);
    const rebuilt = buildCards(review.changeSet, DEFAULT_POLICY);
    expect(rebuilt.map((c) => c.id).sort()).toEqual(review.cards.map((c) => c.id).sort());
  });

  test("mechanical cards contain only mechanical kinds and have deterministic prose; non-mechanical cards never mix kinds with mechanical ones", async () => {
    const review = await load(name);
    const refs = allBlocks(review.changeSet);
    const kindOf = new Map(refs.map((r) => [r.block.id, r.block.kind]));
    const orphans = new Set(refs.filter(isOrphan).map((r) => r.block.id));
    for (const c of review.cards) {
      if (c.fixed) continue;
      // Orphans (a lone brace) sit with their neighbour whatever the model called them.
      const kinds = new Set(c.blockIds.filter((id) => !orphans.has(id)).map((id) => kindOf.get(id)));
      if (c.mechanical) {
        expect([...kinds].every((k) => isMechanical(k))).toBe(true);
        expect(c.paragraph).toMatch(/unchanged|without changing/);
        expect(kinds.size).toBe(1);
      } else expect([...kinds].some((k) => isMechanical(k)) && [...kinds].some((k) => !isMechanical(k))).toBe(false);
    }
  });

  test("the clean card, if present, is last, grey, and holds exactly the inert blocks", async () => {
    const review = await load(name);
    const inert = allBlocks(review.changeSet).filter((r) => r.block.attention === "inert").map((r) => r.block.id).sort();
    const clean = review.cards.find((c) => c.fixed === "clean");
    if (inert.length === 0) return expect(clean).toBeUndefined();
    expect(review.cards.at(-1)).toBe(clean);
    expect(clean!.color).toBe("grey");
    expect([...clean!.blockIds].sort()).toEqual(inert);
  });

  test("cards are ordered riskiest first; an amber or red card implies at least one required human", async () => {
    const review = await load(name);
    const order = ["red", "amber", "green", "grey"];
    const colors = review.cards.map((c) => order.indexOf(c.color));
    expect(colors).toEqual([...colors].sort((a, b) => a - b));
    if (review.cards.some((c) => c.color === "red" || c.color === "amber")) expect(review.verdict.requiredHumans).toBeGreaterThanOrEqual(1);
    const classification = classify(review.changeSet, DEFAULT_POLICY);
    expect(evaluate(classification, DEFAULT_POLICY)).toEqual(review.verdict);
    expect(untouchedAreas(review.changeSet, DEFAULT_POLICY)).toEqual(review.untouched);
  });

  test("titles are distinct across cards and paragraphs are at most four sentences", async () => {
    const review = await load(name);
    const titles = review.cards.filter((c) => !c.fixed).map((c) => c.title.toLowerCase().replace(/[^a-z]/g, ""));
    expect(new Set(titles).size).toBe(titles.length);
    for (const c of review.cards) if (c.paragraph && !c.mechanical) expect(c.paragraph.split(/(?<=[.!?])\s+(?=[A-Z`])/).length).toBeLessThanOrEqual(4);
  });

  test.each([
    [80, 24],
    [140, 45],
  ])("renders the stack and the first expanded card at %dx%d within bounds", async (columns, rows) => {
    const session = new FixtureSession(await load(name), { dispatchMs: 0 });
    const app = render(<App session={session} dispatchable size={{ columns, rows }} frame={0} throttleMs={0} />);
    await new Promise((r) => setTimeout(r, 30));
    const check = () => {
      const lines = (app.lastFrame() ?? "").split("\n").map((l) => l.replace(ANSI, ""));
      expect(lines.length).toBe(rows - 1);
      expect(Math.max(...lines.map((l) => Bun.stringWidth(l)))).toBeLessThanOrEqual(columns);
      return lines;
    };
    expect(check()[0]).toMatch(/LOW|MEDIUM|HIGH/);
    app.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    check();
    app.stdin.write("G");
    await new Promise((r) => setTimeout(r, 30));
    check();
    app.unmount();
    session.dispose();
  });
});

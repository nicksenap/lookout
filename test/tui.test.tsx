import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, windowLines } from "../src/tui/App.tsx";
import type { Line } from "../src/tui/Card.tsx";
import { fit, wrap } from "../src/tui/Card.tsx";
import { FixtureSession, loadReview } from "../stories/fixture-session.ts";

/** Frame → lines with ANSI stripped; the frame is the whole fixed-height screen. */
const ANSI = /\x1b\[[0-9;]*m/g;
const lines = (frame: string | undefined) => (frame ?? "").split("\n").map((l) => l.replace(ANSI, ""));
const widest = (ls: string[]) => Math.max(...ls.map((l) => Bun.stringWidth(l)));
type Rendered = { lastFrame: () => string | undefined };
/**
 * Wait on the signal, not on time: the frame changing is the signal that a key was handled and
 * Ink painted. Polls `lastFrame()` until it differs from `before` (or, with no `before`, until
 * a frame exists), capped so a key that is meant to change nothing still returns. The spinner
 * frame is injected and the throttle is 0, so every state change paints exactly one frame.
 */
const painted = async (app: Rendered, before?: string, capMs = 2000) => {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    await new Promise((r) => setTimeout(r, 5));
    const now = app.lastFrame();
    if (before === undefined ? now !== undefined : now !== before) return;
  }
};
/**
 * Send keys one at a time, each waiting for its frame (a key that changes nothing waits out the
 * cap), then one more macrotask so Ink re-registers `useInput` with the new closure before the
 * next key: a key delivered to the old closure would see the previous selection.
 */
const press = async (app: Rendered & { stdin: { write: (s: string) => void } }, ...keys: string[]) => {
  for (const k of keys) {
    const before = app.lastFrame();
    app.stdin.write(k);
    await painted(app, before, 300);
    await new Promise((r) => setTimeout(r, 0));
  }
};
/** Resolves when the session emits `type`; the caller then waits for the frame it expects with `shows`. */
const until = (session: FixtureSession, type: string) =>
  new Promise<void>((resolve) => {
    const off = session.subscribe((e) => {
      if (e.type !== type) return;
      off();
      resolve();
    });
  });
/** Wait for a frame containing `text` (the signal that an async event has been painted), capped. */
const shows = async (app: Rendered, text: string, capMs = 2000) => {
  const start = Date.now();
  while (Date.now() - start < capMs && !lines(app.lastFrame()).some((l) => l.includes(text))) await new Promise((r) => setTimeout(r, 5));
};
/** Settle after a render with no key: one short wait is enough since nothing else changes the frame. */
const tick = () => new Promise((r) => setTimeout(r, 30));

const sessions: FixtureSession[] = [];
afterEach(() => sessions.splice(0).forEach((s) => s.dispose()));

async function mount(name: string, columns: number, rows: number) {
  const session = new FixtureSession(await loadReview(name), { dispatchMs: 0 });
  sessions.push(session);
  const app = render(<App session={session} size={{ columns, rows }} frame={0} throttleMs={0} />);
  await painted(app);
  await tick();
  return { app, session, screen: () => lines(app.lastFrame()) };
}

describe.each([
  [80, 24],
  [120, 40],
  [200, 60],
])("stack at %dx%d", (columns, rows) => {
  test("fixed height, no line wider than the terminal, header has the verdict, cards have bars", async () => {
    const { screen } = await mount("review-a", columns, rows);
    const s = screen();
    expect(s.length).toBe(rows - 1);
    expect(widest(s)).toBeLessThanOrEqual(columns);
    expect(s[0]).toMatch(/MEDIUM · 1 human · \d+ cards/);
    expect(s.filter((l) => l.startsWith("┃")).length).toBeGreaterThan(3);
    expect(s.at(-1)).toContain("j/k card");
  });

  test("j moves the selection; enter expands to a diff with hunk headers; esc returns", async () => {
    const { app, screen } = await mount("review-a", columns, rows);
    const before = screen().join("\n");
    await press(app, "j");
    expect(screen().join("\n")).not.toBe(before);
    await press(app, "\r");
    const expanded = screen();
    expect(expanded.some((l) => l.includes("@@"))).toBe(true);
    expect(widest(expanded)).toBeLessThanOrEqual(columns);
    expect(expanded.at(-1)).toContain("esc back");
    await press(app, "\x1b");
    expect(screen().some((l) => l.includes("@@"))).toBe(false);
  });

  test("? overlays a help popup on the stack: keys page, tab to the glossary, j scrolls by entry, esc restores the frame", async () => {
    const { app, screen } = await mount("review-b", columns, rows);
    const before = screen();
    await press(app, "?");
    const popup = screen();
    expect(popup.length).toBe(before.length);
    expect(popup.some((l) => l.includes("expand the card"))).toBe(true);
    const top = popup.findIndex((l) => l.includes("┌─") && l.includes("keys") && l.includes("glossary"));
    expect(top).toBeGreaterThan(0);
    // An overlay: the header and the rows beside the box are still the stack's own text.
    expect(popup[0]).toBe(before[0]);
    expect(popup[top]!.startsWith(before[top]!.slice(0, 1))).toBe(true);
    expect(widest(popup)).toBeLessThanOrEqual(columns);
    await press(app, "\t");
    const glossary = screen();
    expect(glossary.some((l) => l.includes("│ Card "))).toBe(true);
    expect(glossary.some((l) => l.includes("One logical change"))).toBe(true);
    expect(glossary.some((l) => l.includes("expand the card"))).toBe(false);
    await press(app, "j");
    const scrolled = screen();
    // The first visible body row is an entry title, never the middle of a definition.
    const firstBody = scrolled.findIndex((l) => l.includes("┌─")) + 1;
    expect(scrolled[firstBody]!).toMatch(/│ [A-Za-z-]/);
    expect(scrolled.some((l) => l.includes("│ Card "))).toBe(false);
    await press(app, "\x1b");
    expect(screen()).toEqual(before);
  });
});

describe("stack contents", () => {
  test("cards are riskiest first and the untouched line closes the stack", async () => {
    const { screen } = await mount("review-a", 120, 50);
    const s = screen();
    const badges = s.filter((l) => /^┃ (RED|AMBER|GREEN|GREY)/.test(l)).map((l) => l.split(/\s+/)[1]);
    const order = ["RED", "AMBER", "GREEN", "GREY"];
    expect([...badges]).toEqual([...badges].sort((a, b) => order.indexOf(a!) - order.indexOf(b!)));
    expect(s.some((l) => l.includes("UNTOUCHED") && l.includes("auth"))).toBe(true);
  });

  test("a card's paragraph replaces its summary line and wraps to the width", async () => {
    const { app, session, screen } = await mount("review-c", 60, 30);
    const card = session.snapshot().cards[0]!;
    {
      const before = app.lastFrame();

      session.setParagraph(card.id, "Adds a conversation tick rail so a reader can jump between messages. ".repeat(3));

      await painted(app, before);
    }
    const s = screen();
    expect(s.some((l) => l.includes("Adds a conversation tick rail"))).toBe(true);
    expect(widest(s)).toBeLessThanOrEqual(60);
    void app;
  });

  test("the header shows the model; claim glyphs, questions and findings never render; one-way shows on its card", async () => {
    const review = await loadReview("review-c");
    const session = new FixtureSession({ ...review, rankedBy: "rules+openai:gpt-6-luna" }, { dispatchMs: 0 });
    sessions.push(session);
    const app = render(<App session={session} size={{ columns: 110, rows: 32 }} frame={0} throttleMs={0} />);
    await painted(app);
    await tick();
    const s = lines(app.lastFrame());
    expect(s[0]).toContain("gpt-6-luna");
    expect(s[0]).not.toContain("claim");
    expect(s.some((l) => l.includes("✗ contradicted") || l.includes("☐ ") || l.includes("P1 "))).toBe(false);
    expect(s.at(-1)).not.toContain("c claims");
    expect(s.at(-1)).not.toContain("review card");
    await press(app, "c");
    expect(lines(app.lastFrame())).toEqual(s);
  });

  test("one card in a tiny terminal still renders within bounds", async () => {
    const { screen } = await mount("review-c", 40, 10);
    const s = screen();
    expect(s.length).toBe(9);
    expect(widest(s)).toBeLessThanOrEqual(40);
  });
});

describe("ask and progress", () => {
  test("a opens a composer box above the keys about the selected card; typing, backspace and enter send it; the answer lands under the card", async () => {
    const { app, session, screen } = await mount("review-c", 100, 30);
    const rows = screen().length;
    await press(app, "a");
    let s = screen();
    expect(s.length).toBe(rows);
    expect(s.some((l) => l.startsWith("┌") && l.includes("ask · card 1"))).toBe(true);
    expect(s.some((l) => l.includes("Ask about this card…"))).toBe(true);
    expect(s.at(-1)).toContain("j/k card");
    await press(app, "why 3x?", "\x7f", "?");
    s = screen();
    expect(s.some((l) => l.startsWith("│ why 3x?▏"))).toBe(true);
    const landed = until(session, "exchange.updated");
    await press(app, "\r");
    expect(screen().some((l) => l.startsWith("┌"))).toBe(false);
    await landed;
    await shows(app, "Fixture answer");
    s = screen();
    const q = s.findIndex((l) => l.includes("› why 3x?"));
    expect(q).toBeGreaterThan(0);
    expect(s[q + 1]).toContain("Fixture answer");
    expect(session.snapshot().exchanges[0]!.cardId).toBe(session.snapshot().cards[0]!.id);
  });

  test("tab flips the scope to the whole change; the lane sits above the cards; an unverified answer says so; esc closes; ↑ recalls the earlier question", async () => {
    const review = await loadReview("review-c");
    const session = new FixtureSession(review, { dispatchMs: 0, unverified: true });
    sessions.push(session);
    const app = render(<App session={session} size={{ columns: 100, rows: 30 }} frame={0} throttleMs={0} />);
    await painted(app);
    await tick();
    await press(app, "a", "\t");
    expect(lines(app.lastFrame()).some((l) => l.includes("ask · the whole change"))).toBe(true);
    await press(app, "\x1b");
    expect(lines(app.lastFrame()).some((l) => l.startsWith("┌"))).toBe(false);
    expect(session.snapshot().exchanges).toHaveLength(0);
    await press(app, "a", "\t", "safe?");
    const landed = until(session, "exchange.updated");
    await press(app, "\r");
    await landed;
    await shows(app, "answer unverified");
    const s = lines(app.lastFrame());
    const q = s.findIndex((l) => l.includes("› safe?"));
    const firstCard = s.findIndex((l) => /^[┃█] (RED|AMBER|GREEN)/.test(l));
    expect(q).toBeGreaterThan(0);
    expect(q).toBeLessThan(firstCard);
    expect(s[q + 1]).toContain("answer unverified");
    expect(session.snapshot().exchanges[0]!.cardId).toBeUndefined();
    await press(app, "a", "\x1b[A");
    expect(lines(app.lastFrame()).some((l) => l.startsWith("│ safe?▏"))).toBe(true);
    app.stdin.write("\x1b");
  });

  test("composer editing: cursor keys, ctrl-w, ctrl-u, pasted newlines become spaces, long text wraps to at most three rows that follow the cursor", async () => {
    const { app, screen } = await mount("review-c", 60, 30);
    await press(app, "a", "one two three", "\x17");
    expect(screen().some((l) => l.startsWith("│ one two ▏"))).toBe(true);
    await press(app, "\x1b[D", "\x1b[D", "X");
    expect(screen().some((l) => l.startsWith("│ one twX▏o "))).toBe(true);
    await press(app, "\x15", "a\nb");
    expect(screen().some((l) => l.startsWith("│ a b▏o "))).toBe(true);
    await press(app, "\x01", "word ".repeat(40));
    const s = screen();
    const body = s.filter((l) => l.startsWith("│ "));
    expect(body.length).toBe(3);
    expect(body.some((l) => l.includes("▏a b"))).toBe(true);
    expect(widest(s)).toBeLessThanOrEqual(60);
    app.stdin.write("\x1b");
  });

  test("progress shows as a bar under the header while the pipeline runs and takes one row from the body; it disappears on clear", async () => {
    const { app, session, screen } = await mount("review-c", 100, 30);
    const before = screen();
    {
      const before = app.lastFrame();

      session.setProgress({ phase: "writing", done: 3, total: 10 });

      await painted(app, before);
    }
    const s = screen();
    expect(s.length).toBe(before.length);
    expect(s[1]).toContain("▰▰▰▱▱▱▱▱▱▱");
    expect(s[1]).toContain("writing 3/10");
    {
      const before = app.lastFrame();

      session.setProgress(undefined);

      await painted(app, before);
    }
    expect(screen()[1]).not.toContain("▰");
    void app;
  });
});

describe("search", () => {
  test("/ in the stack jumps the selection to the first matching card as you type, highlights the match, n/N cycle, esc clears", async () => {
    const { app, session, screen } = await mount("review-a", 120, 50);
    const cards = session.snapshot().cards;
    const target = cards.findIndex((c) => c.color === "green");
    const word = cards[target]!.title.split(" ").find((w) => w.length > 4)!;
    await press(app, "/");
    expect(screen().at(-1)).toMatch(/^ \/▏/);
    await press(app, word.toLowerCase());
    const s = screen();
    const selectedRow = s.findIndex((l) => l.startsWith("█ "));
    expect(s.slice(selectedRow, selectedRow + 3).some((l) => l.includes(word))).toBe(true);
    expect(s.at(-1)).toContain(`/${word.toLowerCase()}`);
    expect(s.at(-1)).toMatch(/\d+ match/);
    await press(app, "\r");
    expect(screen().at(-1)).toContain("n/N next/prev");
    await press(app, "\x1b");
    expect(screen().at(-1)).toContain("j/k card");
  });

  test("/ in the expanded card scrolls the diff to the first matching row; the footer counts rows", async () => {
    const { app, session, screen } = await mount("review-c", 100, 30);
    await press(app, "\r");
    const file = session.snapshot().changeSet.files[0]!.path.split("/").pop()!;
    await press(app, "/", file.slice(0, 5));
    const s = screen();
    expect(s.at(-1)).toMatch(/match/);
    expect(s.some((l) => l.includes(file.slice(0, 5)))).toBe(true);
    await press(app, "\x1b");
    expect(screen().at(-1)).toContain("esc back");
    await press(app, "\x1b");
    expect(screen().at(-1)).toContain("j/k card");
  });

  test("/ in the help popup finds a glossary term", async () => {
    const { app, screen } = await mount("review-c", 100, 24);
    await press(app, "?");
    await press(app, "\t");
    await press(app, "/");
    await press(app, "scope");
    const s = screen();
    const firstBody = s.findIndex((l) => l.includes("┌─")) + 1;
    expect(s[firstBody]).toContain("│ Scope");
    expect(s.some((l) => l.includes("/scope▏"))).toBe(true);
    app.stdin.write("\x1b");
    app.stdin.write("\x1b");
  });
});

describe("vim keys", () => {
  test("gg / G / ge jump to the edges; } and { jump between hot cards; ] and [ between colour bands; o toggles expanded", async () => {
    const { app, session, screen } = await mount("review-a", 120, 50);
    const colours = session.snapshot().cards.map((c) => c.color);
    const selectedIndex = () => screen().findIndex((l) => l.startsWith("█ ")); // first row of the selected card
    await press(app, "G");
    const lastRow = selectedIndex();
    await press(app, "g", "g");
    expect(selectedIndex()).toBeLessThan(lastRow);
    await press(app, "g", "e");
    expect(selectedIndex()).toBe(lastRow);
    await press(app, "g", "g");
    await press(app, "]");
    const band = screen()[selectedIndex()]!.split(/\s+/)[1];
    expect(band).toBe(colours.find((c) => c !== colours[0])!.toUpperCase());
    await press(app, "}");
    expect(screen()[selectedIndex()]!.split(/\s+/)[1]).toBe(band); // no hotter card below amber
    await press(app, "{");
    expect(screen()[selectedIndex()]!.split(/\s+/)[1]).toBe("RED");
    await press(app, "o");
    expect(screen().some((l) => l.startsWith("diff ·"))).toBe(true);
    await press(app, "o");
    expect(screen().some((l) => l.startsWith("diff ·"))).toBe(false);
    void app;
  });
});

describe("text helpers", () => {
  test("fit never exceeds the width, including wide characters", () => {
    for (const w of [0, 1, 5, 12]) {
      expect(Bun.stringWidth(fit("日本語のテキストです", w))).toBeLessThanOrEqual(w);
      expect(Bun.stringWidth(fit("plain ascii text here", w))).toBeLessThanOrEqual(w);
    }
    expect(fit("short", 10)).toBe("short");
  });
  test("wrap breaks on words and hard-cuts words longer than the width", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrap("abcdefghijkl", 5)).toEqual(["abcd…"]);
    expect(wrap("a\nb", 10)).toEqual(["a", "b"]);
  });
  test("windowLines keeps the selected card visible and moves minimally", () => {
    const ls: Line[] = [];
    for (let c = 0; c < 10; c++) for (let k = 0; k < 4; k++) ls.push({ segments: [], card: c });
    expect(windowLines(ls, 0, 10, 0)).toBe(0);
    expect(windowLines(ls, 3, 10, 0)).toBe(6); // card 3 spans 12..15 → top so its last line is visible
    expect(windowLines(ls, 3, 10, 6)).toBe(6); // no movement when already visible
    expect(windowLines(ls, 9, 10, 6)).toBe(30);
    expect(windowLines(ls, 0, 10, 30)).toBe(0);
  });
});

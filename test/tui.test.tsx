import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, windowLines } from "../src/tui/App.tsx";
import { fit, wrap } from "../src/tui/Card.tsx";
import type { Line } from "../src/tui/Card.tsx";
import { FixtureSession, loadReview } from "../stories/fixture-session.ts";

/** Frame → lines with ANSI stripped; the frame is the whole fixed-height screen. */
const ANSI = /\x1b\[[0-9;]*m/g;
const lines = (frame: string | undefined) => (frame ?? "").split("\n").map((l) => l.replace(ANSI, ""));
const widest = (ls: string[]) => Math.max(...ls.map((l) => Bun.stringWidth(l)));
/** Let React commit and Ink paint one frame. The spinner frame is injected and the throttle is 0, so one tick is one frame. */
const tick = () => new Promise((r) => setTimeout(r, 30));
/** Wait on the signal, not on time: resolves when the session emits `type`, then paints a frame. */
const until = (session: FixtureSession, type: string) =>
  new Promise<void>((resolve) => {
    const off = session.subscribe((e) => {
      if (e.type !== type) return;
      off();
      void tick().then(() => resolve());
    });
  });

const sessions: FixtureSession[] = [];
afterEach(() => sessions.splice(0).forEach((s) => s.dispose()));

async function mount(name: string, columns: number, rows: number) {
  const session = new FixtureSession(await loadReview(name), { dispatchMs: 0 });
  sessions.push(session);
  const app = render(<App session={session} size={{ columns, rows }} frame={0} throttleMs={0} />);
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
    app.stdin.write("j");
    await tick();
    expect(screen().join("\n")).not.toBe(before);
    app.stdin.write("\r");
    await tick();
    const expanded = screen();
    expect(expanded.some((l) => l.includes("@@"))).toBe(true);
    expect(widest(expanded)).toBeLessThanOrEqual(columns);
    expect(expanded.at(-1)).toContain("esc back");
    app.stdin.write("\x1b");
    await tick();
    expect(screen().some((l) => l.includes("@@"))).toBe(false);
  });

  test("? shows the key list and esc closes it", async () => {
    const { app, screen } = await mount("review-b", columns, rows);
    app.stdin.write("?");
    await tick();
    expect(screen().some((l) => l.includes("expand the card"))).toBe(true);
    app.stdin.write("\x1b");
    await tick();
    expect(screen().some((l) => l.includes("expand the card"))).toBe(false);
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
    session.setParagraph(card.id, "Adds a conversation tick rail so a reader can jump between messages. ".repeat(3));
    await tick();
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
    await tick();
    const s = lines(app.lastFrame());
    expect(s[0]).toContain("gpt-6-luna");
    expect(s[0]).not.toContain("claim");
    expect(s.some((l) => l.includes("✗ contradicted") || l.includes("☐ ") || l.includes("P1 "))).toBe(false);
    expect(s.at(-1)).not.toContain("c claims");
    expect(s.at(-1)).not.toContain("review card");
    app.stdin.write("c");
    await tick();
    expect(lines(app.lastFrame())).toEqual(s);
  });



  test("one card in a tiny terminal still renders within bounds", async () => {
    const { screen } = await mount("review-c", 40, 10);
    const s = screen();
    expect(s.length).toBe(9);
    expect(widest(s)).toBeLessThanOrEqual(40);
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

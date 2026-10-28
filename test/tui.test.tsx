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

async function mount(name: string, columns: number, rows: number, opts: { dispatchable?: boolean } = {}) {
  const session = new FixtureSession(await loadReview(name), { dispatchMs: 0, dispatchable: opts.dispatchable });
  sessions.push(session);
  const app = render(<App session={session} dispatchable={opts.dispatchable ?? true} size={{ columns, rows }} frame={0} throttleMs={0} />);
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
    expect(screen().some((l) => l.includes("review this card"))).toBe(true);
    app.stdin.write("\x1b");
    await tick();
    expect(screen().some((l) => l.includes("review this card"))).toBe(false);
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

  test("a reviews the selected card: proposer then verifier; the finding lands as ✓✓ with the verifier's note in the expanded view", async () => {
    const { app, session, screen } = await mount("review-b", 100, 40);
    const verified = until(session, "finding.updated");
    app.stdin.write("a");
    await verified;
    const s = screen();
    expect(s.some((l) => l.includes("P1 ✓✓ ") && l.includes("swallowed"))).toBe(true);
    expect(s.some((l) => l.includes("1 finding"))).toBe(true);
    app.stdin.write("\r");
    await tick();
    const e = screen();
    expect(e.some((l) => l.startsWith("findings (1)"))).toBe(true);
    expect(e.some((l) => l.includes("by fixture · verified by fixture 92%"))).toBe(true);
    expect(e.some((l) => l.includes("retry() returns the last caught error"))).toBe(true);
    expect(e.some((l) => l.includes("fixture · verifier · done"))).toBe(true);
  });

  test("questions show as boxes on the card; in the expanded view y answers the first open one and n the next", async () => {
    const { app, screen } = await mount("review-b", 100, 40);
    expect(screen().filter((l) => l.includes("☐ ")).length).toBe(2);
    app.stdin.write("\r");
    await tick();
    expect(screen().some((l) => l.startsWith("questions (2)"))).toBe(true);
    expect(screen().at(-1)).toContain("y/n/u answer");
    app.stdin.write("y");
    await tick();
    app.stdin.write("n");
    await tick();
    const e = screen();
    expect(e.some((l) => l.includes("☑ yes") && l.includes("what the PR says"))).toBe(true);
    expect(e.some((l) => l.includes("☒ no") && l.includes("failure path"))).toBe(true);
    app.stdin.write("u");
    await tick();
    expect(screen().at(-1)).toContain("no open question on this card");
  });

  test("without --evidence the header shows the model instead of claims, c is a notice, and no claim glyphs render", async () => {
    const review = await loadReview("review-c");
    const session = new FixtureSession({ ...review, evidence: false, rankedBy: "rules+openai:gpt-6-luna" }, { dispatchMs: 0 });
    sessions.push(session);
    const app = render(<App session={session} dispatchable={false} size={{ columns: 110, rows: 32 }} frame={0} throttleMs={0} />);
    await tick();
    const s = lines(app.lastFrame());
    expect(s[0]).toContain("gpt-6-luna");
    expect(s[0]).not.toContain("claim");
    expect(s.some((l) => l.includes("✗ contradicted"))).toBe(false);
    expect(s.at(-1)).not.toContain("c claims");
    app.stdin.write("c");
    await tick();
    expect(lines(app.lastFrame()).at(-1)).toContain("claims need --evidence");
  });

  test("claims: a contradicted claim shows on its card and in the header; c opens the claims view with door and radius; esc returns", async () => {
    const { app, screen } = await mount("review-c", 110, 32);
    const s = screen();
    expect(s[0]).toContain("1 claim ✗");
    expect(s.some((l) => l.includes("2 claims ✗"))).toBe(true);
    expect(s.some((l) => l.includes("✗ contradicted 88%") && l.includes("Shell variables"))).toBe(true);
    expect(s.some((l) => l.includes("tests touched"))).toBe(true);
    expect(s.some((l) => l.includes("covers card 1"))).toBe(true);
    expect(s.at(-1)).toContain("c claims");
    app.stdin.write("c");
    await tick();
    const c = screen();
    expect(c.some((l) => l.startsWith("claims (4)"))).toBe(true);
    expect(c.some((l) => l.includes("∅ not in diff") && l.includes("PATH"))).toBe(true);
    expect(c.some((l) => l.includes("diff says two-way") && l.includes("author says two-way"))).toBe(true);
    expect(c.some((l) => l.startsWith("radius") && l.includes("2 importers") && l.includes('"minimal"'))).toBe(true);
    expect(widest(c)).toBeLessThanOrEqual(110);
    app.stdin.write("\x1b");
    await tick();
    expect(screen().some((l) => l.startsWith("claims (4)"))).toBe(false);
    app.stdin.write("\r");
    await tick();
    const e = screen();
    expect(e.some((l) => l.startsWith("claims (2)"))).toBe(true);
    expect(e.some((l) => l.startsWith("tests  touched by Test user environment"))).toBe(true);
  });

  test("a without dispatchers shows a notice in the footer, not a crash", async () => {
    const { app, screen } = await mount("review-b", 100, 30, { dispatchable: false });
    app.stdin.write("a");
    await tick();
    expect(screen().at(-1)).toContain("no dispatchers configured");
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

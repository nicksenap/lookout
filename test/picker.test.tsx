import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { PrSummary } from "../src/core/types.ts";
import { matches, Picker, pickerLines } from "../src/tui/Picker.tsx";

const pr = (number: number, title: string, extra: Partial<PrSummary> = {}): PrSummary => ({
  number,
  title,
  author: "ann",
  branch: `feat/${number}`,
  draft: false,
  files: 3,
  additions: 40,
  deletions: 5,
  checks: "pass",
  review: "none",
  requested: false,
  updatedAt: "2026-10-28T00:00:00Z",
  target: `org/repo#${number}`,
  ...extra,
});
const prs = [
  pr(826, "replace multi-select", { requested: true, review: "required" }),
  pr(827, "portals illustration", { checks: "fail" }),
  pr(822, "align query keys", { author: "dpk", draft: true, checks: "pending" }),
];
const ANSI = /\x1b\[[0-9;]*m/g;
const lines = (frame: string | undefined) => (frame ?? "").replace(ANSI, "").split("\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait for the frame to change after a key (the signal that Ink handled and painted it), capped for keys that change nothing. */
const press = async (app: { lastFrame: () => string | undefined; stdin: { write: (s: string) => void } }, ...keys: string[]) => {
  for (const k of keys) {
    const before = app.lastFrame();
    app.stdin.write(k);
    const start = Date.now();
    while (Date.now() - start < 300 && app.lastFrame() === before) await sleep(5);
    await sleep(0);
  }
};
const settle = async (app: { lastFrame: () => string | undefined }) => {
  const start = Date.now();
  while (Date.now() - start < 2000 && app.lastFrame() === undefined) await sleep(5);
  await sleep(20);
};

describe("picker", () => {
  test("rows carry number, check glyph, title, and the right-hand facts; a requested PR says so", () => {
    const [header, first, second] = pickerLines("org/repo", prs, 0, "", 110);
    expect(header!.segments.map((s) => s.text).join("")).toContain("org/repo · open pull requests");
    const row = first!.segments.map((s) => s.text).join("");
    expect(row).toContain("#826");
    expect(row).toContain("✓ replace multi-select");
    expect(row).toContain("for you · needs review · 3 files +40/−5 · ann");
    expect(second!.segments.map((s) => s.text).join("")).toContain("✗ portals illustration");
  });

  test("matches filters by number, title, author or branch, case-insensitively", () => {
    expect(prs.filter((p) => matches(p, "822")).map((p) => p.number)).toEqual([822]);
    expect(prs.filter((p) => matches(p, "Query")).map((p) => p.number)).toEqual([822]);
    expect(prs.filter((p) => matches(p, "dpk")).map((p) => p.number)).toEqual([822]);
    expect(prs.filter((p) => matches(p, "feat/827")).map((p) => p.number)).toEqual([827]);
    expect(prs.filter((p) => matches(p, "")).length).toBe(3);
  });

  test("j/k move, typing filters, enter picks the highlighted PR; esc clears the filter, then leaves with nothing", async () => {
    const got: { pr?: PrSummary; called: boolean } = { called: false };
    const onPick = (p: PrSummary | undefined) => Object.assign(got, { pr: p, called: true });
    const app = render(<Picker repo="org/repo" prs={prs} onPick={onPick} size={{ columns: 100, rows: 12 }} />);
    await settle(app);
    expect(lines(app.lastFrame())[1]).toMatch(/^█ #826/);
    await press(app, "j");
    expect(lines(app.lastFrame())[2]).toMatch(/^█ #827/);
    await press(app, "quer");
    const filtered = lines(app.lastFrame());
    expect(filtered[0]).toContain("/quer");
    expect(filtered.filter((l) => /^[█┃] #/.test(l)).length).toBe(1);
    expect(filtered[1]).toMatch(/^█ #822/);
    await press(app, "\r");
    expect(got.pr?.target).toBe("org/repo#822");

    Object.assign(got, { pr: undefined, called: false });
    const second = render(<Picker repo="org/repo" prs={prs} onPick={onPick} size={{ columns: 100, rows: 12 }} />);
    await settle(second);
    await press(second, "zzz");
    expect(lines(second.lastFrame()).some((l) => l.includes('nothing matches "zzz"'))).toBe(true);
    await press(second, "\x1b");
    expect(lines(second.lastFrame())[0]).toContain("3 PRs");
    await press(second, "\x1b");
    expect(got.called).toBe(true);
    expect(got.pr).toBeUndefined();
  });
});

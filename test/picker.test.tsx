import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { PrSummary } from "../src/core/types.ts";
import { matches, Picker, pickerLines } from "../src/tui/Picker.tsx";

const pr = (number: number, title: string, extra: Partial<PrSummary> = {}): PrSummary => ({ number, title, author: "ann", branch: `feat/${number}`, draft: false, files: 3, additions: 40, deletions: 5, checks: "pass", review: "none", requested: false, updatedAt: "2026-10-28T00:00:00Z", target: `org/repo#${number}`, ...extra });
const prs = [pr(826, "replace multi-select", { requested: true, review: "required" }), pr(827, "portals illustration", { checks: "fail" }), pr(822, "align query keys", { author: "dpk", draft: true, checks: "pending" })];
const ANSI = /\x1b\[[0-9;]*m/g;
const lines = (frame: string | undefined) => (frame ?? "").replace(ANSI, "").split("\n");
const tick = () => new Promise((r) => setTimeout(r, 20));

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
    await tick();
    expect(lines(app.lastFrame())[1]).toMatch(/^█ #826/);
    app.stdin.write("j");
    await tick();
    expect(lines(app.lastFrame())[2]).toMatch(/^█ #827/);
    app.stdin.write("quer");
    await tick();
    const filtered = lines(app.lastFrame());
    expect(filtered[0]).toContain("/quer");
    expect(filtered.filter((l) => /^[█┃] #/.test(l)).length).toBe(1);
    expect(filtered[1]).toMatch(/^█ #822/);
    app.stdin.write("\r");
    await tick();
    expect(got.pr?.target).toBe("org/repo#822");

    Object.assign(got, { pr: undefined, called: false });
    const second = render(<Picker repo="org/repo" prs={prs} onPick={onPick} size={{ columns: 100, rows: 12 }} />);
    await tick();
    second.stdin.write("zzz");
    await tick();
    expect(lines(second.lastFrame()).some((l) => l.includes('nothing matches "zzz"'))).toBe(true);
    second.stdin.write("\x1b");
    await tick();
    expect(lines(second.lastFrame())[0]).toContain("3 PRs");
    second.stdin.write("\x1b");
    await tick();
    expect(got.called).toBe(true);
    expect(got.pr).toBeUndefined();
  });
});

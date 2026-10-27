import { describe, expect, test } from "bun:test";
import { parseDiff, unquoteGitPath } from "../src/core/diff.ts";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/../fixtures/${name}`).text();

describe("parseDiff edge-cases.diff (real git output)", async () => {
  const files = parseDiff(await fixture("edge-cases.diff"));
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

  test("file count matches git diff --stat (10 files)", () => {
    expect(files.length).toBe(10);
  });

  test("added file", () => {
    const f = byPath["added.go"]!;
    expect(f.status).toBe("added");
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0]!.lines).toEqual([{ kind: "add", text: "brand new", newLine: 1 }]);
    expect(f.hunks[0]!.oldStart).toBe(0);
    expect(f.hunks[0]!.oldLines).toBe(0);
    expect(f.hunks[0]!.newLines).toBe(1);
  });

  test("deleted file uses old path", () => {
    const f = byPath["del.md"]!;
    expect(f.status).toBe("deleted");
    expect(f.hunks[0]!.lines).toEqual([{ kind: "del", text: "gone", oldLine: 1 }]);
  });

  test("no newline at EOF on both sides", () => {
    const lines = byPath["eof.txt"]!.hunks[0]!.lines;
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.noNewlineAtEof)).toBe(true);
  });

  test("no newline at EOF on the new side only", () => {
    const lines = byPath["keep.txt"]!.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual(["context", "del", "add", "context", "add"]);
    expect(lines[4]).toEqual({ kind: "add", text: "line4", newLine: 4, noNewlineAtEof: true });
    expect(lines[3]!.noNewlineAtEof).toBeUndefined();
  });

  test("binary modified and binary added", () => {
    expect(byPath["img.png"]).toMatchObject({ status: "modified", binary: true, hunks: [] });
    expect(byPath["newbin.dat"]).toMatchObject({ status: "added", binary: true, hunks: [] });
  });

  test("rename with edit", () => {
    const f = byPath["new_name.ts"]!;
    expect(f.status).toBe("renamed");
    expect(f.oldPath).toBe("old_name.ts");
    const h = f.hunks[0]!;
    expect(h.header).toBe("@@ -5,6 +5,6 @@ d");
    expect(h.lines.find((l) => l.kind === "add")).toEqual({ kind: "add", text: "H", newLine: 8 });
    expect(h.lines.find((l) => l.kind === "del")).toEqual({ kind: "del", text: "h", oldLine: 8 });
  });

  test("mode-only change has no hunks", () => {
    expect(byPath["script.sh"]).toMatchObject({ status: "modified", binary: false, hunks: [] });
  });

  test("path with space (trailing tab in ---/+++)", () => {
    expect(byPath["with space.txt"]!.hunks).toHaveLength(1);
  });

  test("C-quoted unicode path", () => {
    expect(byPath["ünï.txt"]!.hunks[0]!.lines.map((l) => l.text)).toEqual(["u", "u2"]);
  });

  test("hunk ids are stable and distinct", () => {
    const ids = files.flatMap((f) => f.hunks.map((h) => h.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(parseDiff("")).toEqual([]);
  });
});

describe("parseDiff sample fixtures", () => {
  test("result-errors: 14 files, 39 hunks, line counts match headers", async () => {
    const files = parseDiff(await fixture("result-errors.diff"));
    expect(files).toHaveLength(14);
    const hunks = files.flatMap((f) => f.hunks);
    expect(hunks).toHaveLength(39);
    for (const h of hunks) {
      expect(h.lines.filter((l) => l.kind !== "add").length).toBe(h.oldLines);
      expect(h.lines.filter((l) => l.kind !== "del").length).toBe(h.newLines);
    }
    const adds = hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add").length;
    const dels = hunks.flatMap((h) => h.lines).filter((l) => l.kind === "del").length;
    expect([adds, dels]).toEqual([212, 171]);
  });

  test("scaffold: 6 added files, one hunk each, every line an addition", async () => {
    const files = parseDiff(await fixture("scaffold.diff"));
    expect(files).toHaveLength(6);
    expect(files.every((f) => f.status === "added" && f.hunks.length === 1)).toBe(true);
    expect(files.flatMap((f) => f.hunks[0]!.lines).every((l) => l.kind === "add")).toBe(true);
  });

  test("parsing is deterministic (same ids)", async () => {
    const text = await fixture("result-errors.diff");
    const a = parseDiff(text).flatMap((f) => f.hunks.map((h) => h.id));
    const b = parseDiff(text).flatMap((f) => f.hunks.map((h) => h.id));
    expect(a).toEqual(b);
  });
});

describe("unquoteGitPath", () => {
  test("octal escapes and simple escapes", () => {
    expect(unquoteGitPath('"a/\\303\\274.txt"')).toBe("a/ü.txt");
    expect(unquoteGitPath('"tab\\there"')).toBe("tab\there");
    expect(unquoteGitPath("plain")).toBe("plain");
  });
});

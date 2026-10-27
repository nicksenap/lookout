import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RULE_CASES } from "../fixtures/rule-cases.ts";
import { parseDiff } from "../src/core/diff.ts";
import type { FileChange } from "../src/core/types.ts";
import { applyRules, globToRegExp, languageOf, pathLabels } from "../src/rank/rules.ts";
import { DIFF_FLAGS } from "../src/sources/git.ts";

const dir = mkdtempSync(join(tmpdir(), "lookout-rules-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
};
const put = (p: string, s: string) => {
  mkdirSync(dirname(join(dir, p)), { recursive: true });
  writeFileSync(join(dir, p), s);
};

git("init", "-q");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
for (const c of RULE_CASES) if (c.before !== "") put(c.path, c.before);
git("add", "-A");
git("commit", "-qm", "before");
for (const c of RULE_CASES) put(c.path, c.after);
git("add", "-A");
const files = applyRules({ target: "t", base: "", head: "", files: parseDiff(git("diff", ...DIFF_FLAGS, "--cached", "HEAD")) }).files;
const byPath = new Map<string, FileChange>(files.map((f) => [f.path, f]));

describe("rule cases (real git hunks)", () => {
  test("at least 30 cases, each producing a hunk", () => {
    expect(RULE_CASES.length).toBeGreaterThanOrEqual(30);
    for (const c of RULE_CASES) expect(byPath.get(c.path)?.hunks.length ?? 0).toBeGreaterThan(0);
  });

  for (const c of RULE_CASES) {
    test(c.name, () => {
      for (const h of byPath.get(c.path)!.hunks) {
        expect({ path: c.path, attention: h.attention }).toEqual({ path: c.path, attention: c.attention });
        for (const l of c.labels ?? []) expect(h.labels).toContain(l);
        for (const l of c.notLabels ?? []) expect(h.labels).not.toContain(l);
      }
    });
  }
});

describe("path rules", () => {
  test("globs", () => {
    expect(globToRegExp("**/dist/**").test("packages/a/dist/x.js")).toBe(true);
    expect(globToRegExp("*.{test,spec}.*").test("a/b/c.test.tsx")).toBe(true);
    expect(globToRegExp(".github/workflows/**").test("x/.github/workflows/a.yml")).toBe(false);
  });
  test("labels", () => {
    expect(pathLabels("apps/webserver/src/security-headers.test.ts").sort()).toEqual(["sensitive", "test"]);
    expect(pathLabels("packages/ui/README.md")).toEqual(["docs"]);
    expect(pathLabels("src/authorName.ts")).toEqual([]);
    expect(pathLabels("src/authToken.ts")).toEqual(["sensitive"]);
  });
  test("languages", () => {
    expect(languageOf("a.tsx")).toBe("jsx");
    expect(languageOf("a.yaml")).toBeUndefined();
  });
});

describe("sample fixture labels", () => {
  test("parser: test file labelled test, nothing inert", async () => {
    const text = await Bun.file(`${import.meta.dir}/../fixtures/parser.diff`).text();
    const ranked = applyRules({ target: "t", base: "", head: "", files: parseDiff(text) });
    const testFile = ranked.files.find((f) => f.path.endsWith(".test.ts"))!;
    expect(testFile.hunks.every((h) => h.labels.includes("test"))).toBe(true);
    expect(ranked.files.flatMap((f) => f.hunks).filter((h) => h.attention === "inert")).toEqual([]);
  });
});

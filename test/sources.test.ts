import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRange, loadWorktree } from "../src/sources/git.ts";
import { parsePrRef } from "../src/sources/github.ts";
import { resolveTarget } from "../src/sources/resolve.ts";
import type { Result } from "../src/core/result.ts";
import { loadUserEnv } from "../src/cli/env.ts";
/** Unwrap a Result in tests; a failure is a test failure with the message. */
function must<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(String(r.error));
  return r.value;
}


let dir: string;
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const write = (p: string, s: string) => writeFileSync(join(dir, p), s);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lookout-git-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  write("a.ts", "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  write("b.ts", "export const b = 2;\n");
  write("a.ts", "export const a = 3;\n");
  git("add", "-A");
  git("commit", "-qm", "feature");
  git("checkout", "-q", "main");
  write("c.ts", "export const c = 4;\n");
  git("add", "-A");
  git("commit", "-qm", "main moves");
  git("checkout", "-q", "feature");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("git source", () => {
  test("worktree vs HEAD includes staged and unstaged", async () => {
    write("a.ts", "export const a = 5;\n");
    write("b.ts", "export const b = 6;\n");
    git("add", "b.ts");
    const cs = must(await loadWorktree(dir));
    expect(cs.files.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
    expect(cs.head).toBe("worktree");
    git("checkout", "-q", "--", ".");
    git("reset", "-q", "--hard");
  });

  test("A..B compares the two tips", async () => {
    const cs = must(await loadRange("main..feature", dir));
    // main has c.ts that feature lacks, so two-dot shows it as deleted.
    expect(cs.files.map((f) => `${f.status}:${f.path}`).sort()).toEqual(["added:b.ts", "deleted:c.ts", "modified:a.ts"]);
  });

  test("A...B diffs from the merge-base", async () => {
    const cs = must(await loadRange("main...feature", dir));
    expect(cs.files.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
    expect(cs.base).toBe(git("merge-base", "main", "feature"));
  });

  test("main.. defaults the right side to HEAD", async () => {
    const cs = must(await loadRange("main..", dir));
    expect(cs.head).toBe(git("rev-parse", "HEAD"));
    expect(cs.files).toHaveLength(3);
  });
});

describe("resolveTarget", () => {
  test("forms", () => {
    expect(must(resolveTarget(undefined))).toEqual({ kind: "worktree" });
    expect(must(resolveTarget("main.."))).toEqual({ kind: "range", range: "main.." });
    expect(must(resolveTarget("a...b"))).toEqual({ kind: "range", range: "a...b" });
    expect(must(resolveTarget("https://github.com/o/r/pull/12/files"))).toMatchObject({ kind: "pr", owner: "o", repo: "r", number: 12 });
    expect(must(resolveTarget("o/r#7"))).toMatchObject({ kind: "pr", owner: "o", repo: "r", number: 7 });
    const bad = resolveTarget("main");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/Unrecognised target/);
  });

  test("parsePrRef rejects non-PR URLs", () => {
    expect(parsePrRef("https://github.com/o/r/issues/1")).toBeUndefined();
  });
});

describe("user env file", () => {
  test("loads KEY=value lines into an env without overriding existing values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookout-env-"));
    const p = join(dir, ".env");
    writeFileSync(p, `# comment\nOPENAI_API_KEY="sk-file"\nexport OTHER=plain\nbad line\n`);
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-shell" };
    loadUserEnv(p, env);
    expect(env.OPENAI_API_KEY).toBe("sk-shell");
    expect(env.OTHER).toBe("plain");
    loadUserEnv(join(dir, "missing"), env); // no throw
    rmSync(dir, { recursive: true, force: true });
  });
});

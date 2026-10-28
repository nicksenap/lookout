import { parseDiff } from "../core/diff.ts";
import { ok, type Result } from "../core/result.ts";
import type { ChangeSet } from "../core/types.ts";
import { run } from "./exec.ts";

/** Flags that pin git's diff output to the format parseDiff expects regardless of user config. */
export const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", "--src-prefix=a/", "--dst-prefix=b/"];

const trimmed = (r: Result<string>): Result<string> => (r.ok ? ok(r.value.trim()) : r);

export async function repoRoot(cwd: string = process.cwd()): Promise<Result<string>> {
  return trimmed(await run(["git", "rev-parse", "--show-toplevel"], cwd));
}

async function revParse(rev: string, cwd: string): Promise<Result<string>> {
  return trimmed(await run(["git", "rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], cwd));
}

/** True when the working tree has staged or unstaged changes against HEAD (untracked files do not count). */
export async function worktreeDirty(cwd: string = process.cwd()): Promise<Result<boolean>> {
  const res = await run(["git", "status", "--porcelain", "--untracked-files=no"], cwd);
  return res.ok ? ok(res.value.trim() !== "") : res;
}

/** Working tree (staged + unstaged) vs HEAD. */
export async function loadWorktree(cwd: string = process.cwd()): Promise<Result<ChangeSet>> {
  const head = await revParse("HEAD", cwd);
  if (!head.ok) return head;
  const text = await run(["git", "diff", ...DIFF_FLAGS, "HEAD", "--"], cwd);
  if (!text.ok) return text;
  return ok({ target: "worktree", base: head.value, head: "worktree", files: parseDiff(text.value) });
}

/** `A..B` (B defaults to HEAD) or `A...B` (diff from merge-base). */
export async function loadRange(range: string, cwd: string = process.cwd()): Promise<Result<ChangeSet>> {
  const threeDot = range.includes("...");
  const [left, right] = range.split(threeDot ? "..." : "..");
  const a = left || "HEAD";
  const b = right || "HEAD";
  const head = await revParse(b, cwd);
  if (!head.ok) return head;
  const base = threeDot ? trimmed(await run(["git", "merge-base", a, b], cwd)) : await revParse(a, cwd);
  if (!base.ok) return base;
  const text = await run(["git", "diff", ...DIFF_FLAGS, base.value, head.value, "--"], cwd);
  if (!text.ok) return text;
  return ok({ target: range, base: base.value, head: head.value, files: parseDiff(text.value) });
}

import { err, ok, type Result } from "../core/result.ts";
import type { ChangeSet } from "../core/types.ts";
import { loadRange, loadWorktree } from "./git.ts";
import { loadPullRequest, parsePrRef } from "./github.ts";

export type SourceSpec =
  | { kind: "worktree" }
  | { kind: "range"; range: string }
  | { kind: "pr"; owner: string; repo: string; number: number; target: string };

export function resolveTarget(arg: string | undefined): Result<SourceSpec> {
  if (arg === undefined) return ok({ kind: "worktree" });
  const pr = parsePrRef(arg);
  if (pr) return ok({ kind: "pr", ...pr, target: arg });
  if (arg.includes("..")) return ok({ kind: "range", range: arg });
  return err(
    `Unrecognised target "${arg}". Use: (nothing) for working tree vs HEAD, A..B / A...B / main.. for a range, or a PR URL / owner/repo#N.`,
  );
}

export function loadChangeSet(spec: SourceSpec, cwd: string = process.cwd()): Promise<Result<ChangeSet>> {
  switch (spec.kind) {
    case "worktree":
      return loadWorktree(cwd);
    case "range":
      return loadRange(spec.range, cwd);
    case "pr":
      return loadPullRequest(spec, spec.target);
  }
}

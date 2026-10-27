import { ok, type Result } from "../core/result.ts";
import type { ChangeSet, Radius } from "../core/types.ts";
import { run } from "../sources/exec.ts";
import { stemOf } from "./tests.ts";

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Files in the repo that import a changed source file and are not themselves part of the change.
 * One `git grep` over tracked files; stems (not full paths) so relative and aliased imports both
 * match. Read-only. `ok([])` when nothing imports the files or none is importable source.
 */
export async function findImporters(changeSet: ChangeSet, repo: string): Promise<Result<{ importers: string[]; warning?: string }>> {
  const changed = new Set(changeSet.files.flatMap((f) => [f.path, f.oldPath]).filter((p): p is string => p !== undefined));
  const stems = [...new Set([...changed].filter((p) => SOURCE.test(p)).map(stemOf))].filter((s) => s.length > 2).slice(0, 60);
  if (stems.length === 0) return ok({ importers: [] });
  // A PR reviewed from a stale checkout: files the change edits are not in the tree, so importers would be missing.
  const present = await run(["git", "ls-files", "--", ...changeSet.files.filter((f) => f.status !== "added").map((f) => f.path)], repo);
  if (!present.ok) return present;
  const missing = changeSet.files.filter((f) => f.status !== "added").length - present.value.split("\n").filter(Boolean).length;
  const warning = missing > 0 ? `${missing} changed file${missing === 1 ? " is" : "s are"} not in this checkout; importers may be incomplete` : undefined;
  const done = (importers: string[]) => ok(warning ? { importers, warning } : { importers });
  const alt = stems.map(escape).join("|");
  const jsLike = `(from|import|require\\()[[:space:]]*\\(?[[:space:]]*['"][^'"]*/(${alt})(\\.[a-z]+)?['"]`;
  const python = `^[[:space:]]*(from|import)[[:space:]]+[A-Za-z0-9_.]*(^|\\.)(${alt})([[:space:]]|$|\\.)`;
  const res = await run(["git", "grep", "-l", "-I", "-E", "-e", jsLike, "-e", python, "--", "."], repo);
  // git grep exits 1 when nothing matches; that is an answer, not a failure.
  if (!res.ok) return /\(exit 1\)/.test(res.error) ? done([]) : res;
  return done(
    res.value
      .split("\n")
      .filter((p) => p !== "" && !changed.has(p) && SOURCE.test(p))
      .sort(),
  );
}

export function initialRadius(areas: string[], author: string | undefined): Radius {
  const radius: Radius = { areas };
  if (author) radius.author = author;
  return radius;
}

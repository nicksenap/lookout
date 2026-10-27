import { parseDiff } from "../core/diff.ts";
import { attempt, err, ok, type Result } from "../core/result.ts";
import type { ChangeSet } from "../core/types.ts";
import { run } from "./exec.ts";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

const URL_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const SHORT_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

export function parsePrRef(arg: string): PrRef | undefined {
  const m = URL_RE.exec(arg) ?? SHORT_RE.exec(arg);
  if (!m) return undefined;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

interface PrView {
  title: string;
  body: string;
  baseRefOid: string;
  headRefOid: string;
}

/** Read-only PR load through `gh` (uses gh's own auth). */
export async function loadPullRequest(ref: PrRef, target: string): Promise<Result<ChangeSet>> {
  const repo = `${ref.owner}/${ref.repo}`;
  const n = String(ref.number);
  const [text, viewJson] = await Promise.all([
    run(["gh", "pr", "diff", n, "--repo", repo, "--color", "never"]),
    run(["gh", "pr", "view", n, "--repo", repo, "--json", "title,body,baseRefOid,headRefOid"]),
  ]);
  if (!text.ok) return text;
  if (!viewJson.ok) return viewJson;
  const view = attempt(() => JSON.parse(viewJson.value) as PrView);
  if (!view.ok) return err(`gh pr view returned invalid JSON: ${view.error}`);
  return ok({
    target,
    base: view.value.baseRefOid,
    head: view.value.headRefOid,
    files: parseDiff(text.value),
    intent: { title: view.value.title, body: view.value.body ?? "" },
  });
}

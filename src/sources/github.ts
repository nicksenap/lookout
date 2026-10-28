import { parseDiff } from "../core/diff.ts";
import { attempt, err, ok, type Result } from "../core/result.ts";
import type { ChangeSet, PrSummary } from "../core/types.ts";
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

interface PrListRow {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  isDraft: boolean;
  changedFiles: number;
  additions: number;
  deletions: number;
  reviewDecision: string;
  updatedAt: string;
  statusCheckRollup: { conclusion?: string; status?: string; state?: string }[] | null;
}

/**
 * Open PRs of the repo `cwd` belongs to, newest first, with the ones awaiting your review on top.
 * Read-only, through `gh`. Fails when `gh` is missing, not logged in, or the directory has no GitHub remote.
 */
export async function listOpenPullRequests(cwd: string = process.cwd(), limit = 40): Promise<Result<{ repo: string; prs: PrSummary[] }>> {
  const [repoJson, listJson, statusJson] = await Promise.all([
    run(["gh", "repo", "view", "--json", "nameWithOwner"], cwd),
    run(["gh", "pr", "list", "--state", "open", "--limit", String(limit), "--json", "number,title,author,headRefName,isDraft,changedFiles,additions,deletions,reviewDecision,updatedAt,statusCheckRollup"], cwd),
    // `--json` names fields of each PR; the needsReview bucket is addressed in jq.
    run(["gh", "pr", "status", "--json", "number", "--jq", "[.needsReview[].number]"], cwd),
  ]);
  if (!repoJson.ok) return repoJson;
  if (!listJson.ok) return listJson;
  const repo = attempt(() => (JSON.parse(repoJson.value) as { nameWithOwner: string }).nameWithOwner);
  if (!repo.ok) return err(`gh repo view returned invalid JSON: ${repo.error}`);
  const rows = attempt(() => JSON.parse(listJson.value) as PrListRow[]);
  if (!rows.ok) return err(`gh pr list returned invalid JSON: ${rows.error}`);
  // `gh pr status` fails outside a checkout of the repo; the picker still works, just without the "for you" ordering.
  const requestedList = statusJson.ok ? attempt(() => JSON.parse(statusJson.value) as number[]) : undefined;
  const requested = new Set(requestedList?.ok ? requestedList.value : []);
  const prs = rows.value
    .map((r): PrSummary => ({
      number: r.number,
      title: r.title,
      author: r.author?.login ?? "?",
      branch: r.headRefName,
      draft: r.isDraft,
      files: r.changedFiles,
      additions: r.additions,
      deletions: r.deletions,
      checks: checksOf(r.statusCheckRollup),
      review: r.reviewDecision === "APPROVED" ? "approved" : r.reviewDecision === "CHANGES_REQUESTED" ? "changes" : r.reviewDecision === "REVIEW_REQUIRED" ? "required" : "none",
      requested: requested.has(r.number),
      updatedAt: r.updatedAt,
      target: `${repo.value}#${r.number}`,
    }))
    .sort((a, b) => Number(b.requested) - Number(a.requested) || b.updatedAt.localeCompare(a.updatedAt));
  return ok({ repo: repo.value, prs });
}

function checksOf(rollup: PrListRow["statusCheckRollup"]): PrSummary["checks"] {
  if (!rollup || rollup.length === 0) return "none";
  const states = rollup.map((c) => (c.conclusion ?? c.state ?? c.status ?? "").toUpperCase());
  if (states.some((s) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(s))) return "fail";
  if (states.some((s) => ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"].includes(s))) return "pending";
  return "pass";
}

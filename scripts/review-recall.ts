// Step 27: of the places a human reviewer stopped, how many did lookout point at? Read-only against <repo-dir>.
// Usage: bun scripts/review-recall.ts <repo-dir> [--prs N | --pr A,B,C] [--json]
// For merged PRs with human inline review comments, runs the real pipeline, maps each comment's path:line
// to a block and its card, and counts it `pointed` when the card is amber/red or carries a verified risk line.
// One comment per review thread (the first human one); bots are skipped, file-level comments count as unmapped.
// Inputs (change set + comments) are cached under ~/.cache/lookout/recall, model calls in RankCache, so a
// re-run after a rule change recomputes the cards without refetching or re-asking the model.
// Comment text stays on this machine: only the first 100 chars of a missed comment are printed.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadUserEnv } from "../src/cli/env.ts";
import { LocalSession } from "../src/core/session.ts";
import type { CardColor, ChangeSet, DiffLine, EditBlock, Review } from "../src/core/types.ts";
import { loadConfig } from "../src/dispatch/config.ts";
import { DEFAULT_CACHE_DIR } from "../src/rank/cache.ts";
import { run } from "../src/sources/exec.ts";
import { loadPullRequest } from "../src/sources/github.ts";

export interface CommentAnchor {
  path: string;
  /** Absent for a file-level comment. */
  line?: number;
  side: "old" | "new";
}

interface ReviewComment extends CommentAnchor {
  body: string;
}

interface Cached {
  comments: ReviewComment[];
  changeSet?: ChangeSet;
}

interface Mapped {
  on: "edit" | "context";
  card: string;
  color: CardColor;
  top3: boolean;
}
/** One review comment, scored. Only a missed one carries text: its first 100 chars. */
type Scored = CommentAnchor &
  ({ status: "unmapped" } | (Mapped & { status: "pointed" }) | (Mapped & { status: "missed"; excerpt: string }));

const BOTS = new Set(["copilot-pull-request-reviewer", "github-actions", "dependabot"]);
const CACHE_DIR = join(DEFAULT_CACHE_DIR, "recall");

/**
 * The block a review comment points at: the block holding its line, or on a context line the nearest
 * block of the same hunk (ties go to the earlier one). `undefined` for a file-level comment or a line
 * outside every hunk.
 */
export function mapComment(changeSet: ChangeSet, anchor: CommentAnchor): { blockId: string; on: "edit" | "context" } | undefined {
  if (anchor.line === undefined) return undefined;
  const lineOf = (l: DiffLine) => (anchor.side === "new" ? l.newLine : l.oldLine);
  const file = changeSet.files.find((f) => f.path === anchor.path || f.oldPath === anchor.path);
  const hit = file?.hunks.map((hunk) => ({ hunk, at: hunk.lines.findIndex((l) => lineOf(l) === anchor.line) })).find((h) => h.at >= 0);
  if (!hit) return undefined;
  const distance = (b: EditBlock) => (hit.at < b.from ? b.from - hit.at : Math.max(0, hit.at - b.to + 1));
  const nearest = hit.hunk.blocks.reduce<EditBlock | undefined>((best, b) => (!best || distance(b) < distance(best) ? b : best), undefined);
  return nearest && { blockId: nearest.id, on: distance(nearest) === 0 ? "edit" : "context" };
}

async function main() {
  const args = process.argv.slice(2);
  const repoDir = args[0];
  if (!repoDir || repoDir.startsWith("-"))
    throw new Error("usage: bun scripts/review-recall.ts <repo-dir> [--prs N | --pr A,B,C] [--json]");
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const json = args.includes("--json");
  loadUserEnv();
  const config = loadConfig(undefined, repoDir);
  if (!config.ok) throw new Error(config.error);
  const gh = async (cmd: string[]) => {
    const res = await run(["gh", ...cmd], repoDir);
    if (!res.ok) throw new Error(res.error);
    return res.value;
  };
  const repo = (await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])).trim();
  const [owner, name] = repo.split("/") as [string, string];

  const load = async (n: number): Promise<Cached> => {
    const file = Bun.file(join(CACHE_DIR, `${owner}-${name}-${n}.json`));
    if (await file.exists()) return (await file.json()) as Cached;
    const comments = humanComments(await gh(["api", `repos/${repo}/pulls/${n}/comments`, "--paginate", "--jq", COMMENT_JQ]));
    const changeSet = comments.length ? await loadPullRequest({ owner, repo: name, number: n }, `${repo}#${n}`) : undefined;
    if (changeSet && !changeSet.ok) throw new Error(changeSet.error);
    const cached = { comments, ...(changeSet?.ok ? { changeSet: changeSet.value } : {}) };
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    await Bun.write(file, JSON.stringify(cached));
    return cached;
  };

  const explicit = flag("--pr")?.split(",").map(Number);
  const wanted = explicit?.length ?? Number(flag("--prs") ?? 10);
  // Scan newest merged first and stop at `wanted` PRs that have human inline comments.
  const candidates =
    explicit ??
    (
      JSON.parse(
        await gh(["pr", "list", "--repo", repo, "--state", "merged", "--limit", String(wanted * 6), "--json", "number,mergedAt"]),
      ) as { number: number; mergedAt: string }[]
    )
      .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
      .map((p) => p.number);
  const rows: ReturnType<typeof scorePr>[] = [];
  for (const n of candidates) {
    if (rows.length >= wanted) break;
    const cached = await load(n);
    if (!cached.changeSet || cached.comments.length === 0) continue;
    const session = new LocalSession({ config: config.value, changeSet: cached.changeSet, repo: repoDir });
    await session.ready();
    const review = session.snapshot();
    if (review.warning) console.error(`#${n}: ${review.warning}`);
    rows.push(scorePr(n, review, cached.comments));
    if (!json) console.error(`#${n} done (${rows.length}/${wanted})`);
  }
  if (rows.length < wanted)
    console.error(`only ${rows.length} of ${wanted} PRs had human inline comments among ${candidates.length} scanned`);
  const summary = summarise(rows);
  if (json) console.log(JSON.stringify({ repo, prs: rows, summary }, null, 2));
  else printTable(rows, summary);
}

// One JSON object per comment, only the fields the score needs.
const COMMENT_JQ =
  ".[] | {id, reply: .in_reply_to_id, path, line, original_line, side, subject_type, login: .user.login, type: .user.type, body}";

/** Validate gh's NDJSON once here; keep the first human comment of each thread. */
function humanComments(ndjson: string): ReviewComment[] {
  const seen = new Set<number>();
  return ndjson
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((c) => {
      const login = String(c.login ?? "");
      if (c.type === "Bot" || login.endsWith("[bot]") || BOTS.has(login) || typeof c.path !== "string") return false;
      const thread = Number(c.reply ?? c.id);
      if (seen.has(thread)) return false;
      seen.add(thread);
      return true;
    })
    .map((c) => {
      // Outdated comments have no `line`; `original_line` numbers an older commit and may land a few lines off.
      const line = c.subject_type === "file" ? undefined : (c.line ?? c.original_line);
      return {
        path: c.path as string,
        side: c.side === "LEFT" ? "old" : "new",
        body: String(c.body ?? ""),
        ...(typeof line === "number" ? { line } : {}),
      };
    });
}

function scorePr(number: number, review: Review, comments: ReviewComment[]) {
  const results = comments.map((c): Scored => {
    const mapped = mapComment(review.changeSet, c);
    const index = mapped ? review.cards.findIndex((card) => card.blockIds.includes(mapped.blockId)) : -1;
    const card = review.cards[index];
    const anchor = { path: c.path, line: c.line, side: c.side };
    if (!mapped || !card) return { ...anchor, status: "unmapped" };
    const pointed = card.color === "amber" || card.color === "red" || (card.risk !== undefined && !card.riskUnverified);
    const hit = { ...anchor, on: mapped.on, card: card.title, color: card.color, top3: index < 3 };
    return pointed
      ? { ...hit, status: "pointed" }
      : { ...hit, status: "missed", excerpt: c.body.replace(/\s+/g, " ").trim().slice(0, 100) };
  });
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return {
    number,
    cards: review.cards.length,
    comments: results.length,
    mapped: results.length - count("unmapped"),
    pointed: count("pointed"),
    missed: count("missed"),
    unmapped: count("unmapped"),
    top3: results.filter((r) => r.status !== "unmapped" && r.top3).length,
    results,
  };
}

function summarise(rows: ReturnType<typeof scorePr>[]) {
  const sum = (k: "comments" | "mapped" | "pointed" | "missed" | "unmapped" | "top3") => rows.reduce((s, r) => s + r[k], 0);
  const ratio = (a: number, b: number) => (b ? Number((a / b).toFixed(2)) : null);
  return {
    prs: rows.length,
    comments: sum("comments"),
    mapped: sum("mapped"),
    pointed: sum("pointed"),
    missed: sum("missed"),
    unmapped: sum("unmapped"),
    /** pointed / mapped */
    recall: ratio(sum("pointed"), sum("mapped")),
    /** Mapped comments whose card was among the first three. */
    top3Share: ratio(sum("top3"), sum("mapped")),
  };
}

function printTable(rows: ReturnType<typeof scorePr>[], summary: ReturnType<typeof summarise>) {
  const cols = ["cards", "comments", "mapped", "pointed", "missed", "unmapped", "top3"] as const;
  console.log(["PR".padEnd(7), ...cols.map((c) => c.padStart(9))].join(""));
  for (const r of rows) {
    console.log([`#${r.number}`.padEnd(7), ...cols.map((c) => String(r[c]).padStart(9))].join(""));
    for (const m of r.results) if (m.status === "missed") console.log(`         missed [${m.color}] ${m.card} — ${m.excerpt}`);
  }
  console.log(
    `\nrecall ${summary.pointed}/${summary.mapped} = ${summary.recall ?? "-"}, top-3 share ${summary.top3Share ?? "-"}, unmapped ${summary.unmapped} (${summary.prs} PRs, ${summary.comments} comments)`,
  );
}

// Last, so every module-level constant above is initialised before main reads it.
if (import.meta.main) await main();

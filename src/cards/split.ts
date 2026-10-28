import { allBlocks, type BlockRef, blockText } from "../core/blocks.ts";
import { attemptAsync } from "../core/result.ts";
import type { Card, ChangeSet } from "../core/types.ts";
import { RankCache } from "../rank/cache.ts";
import { type Env, resolveWriter, writeText } from "../rank/model.ts";
import { cardId } from "./build.ts";

/** Partition of a blob card's block ids into titled concerns, keyed by the blob's card id. */
export type Splits = Map<string, Concern[]>;
export interface Concern {
  title: string;
  blockIds: string[];
}

export const BLOB_BLOCKS = 8;
export const BLOB_FILES = 3;

/** A behaviour card too big to read as one decision. */
export function isBlob(changeSet: ChangeSet, card: Card): boolean {
  if (card.fixed || card.mechanical) return false;
  if (card.blockIds.length > BLOB_BLOCKS) return true;
  const ids = new Set(card.blockIds);
  return (
    new Set(
      allBlocks(changeSet)
        .filter((r) => ids.has(r.block.id))
        .map((r) => r.file.path),
    ).size > BLOB_FILES
  );
}

export interface SplitOptions {
  modelSpec: string;
  env?: Env;
  cache?: RankCache;
  /** Injection point for tests. */
  write?: (prompt: string) => Promise<string>;
  /** Called as each blob is settled: blobs done of total. */
  onProgress?: (done: number, total: number) => void;
}

// Bumped when the prompt changes so a sharper question is never answered from an old cache.
const CACHE_PREFIX = "split-v2";
/** A concern this large after one split is asked again, once. */
const RESPLIT_BLOCKS = 24;
const isPartition = (v: unknown): v is Concern[] =>
  Array.isArray(v) &&
  v.every(
    (g) =>
      typeof g === "object" &&
      g !== null &&
      typeof (g as Concern).title === "string" &&
      Array.isArray((g as Concern).blockIds) &&
      (g as Concern).blockIds.every((id) => typeof id === "string"),
  );

export const SPLIT_PROMPT = `You are preparing an agent-written code change for a senior engineer's review. Below is ONE oversized group of edits. Split it into the separate decisions a reviewer evaluates one at a time ("narrow cache invalidation on mutations", "rewrite storage scope for moved artifacts", "run-start guard", "UI dialog").
Rules:
- Between 2 and 8 concerns. Every edit id appears in exactly one concern. Use the ids exactly as given.
- A concern of more than about 12 edits almost always hides two decisions: the new definitions vs the call sites that adopt them, a contract made stricter vs the code updated to meet it, server vs client, production code vs its tests. Split those apart.
- Group by what a reviewer decides, not by file: an endpoint and the service method it calls belong together; two unrelated edits in one file do not.
- Imports, re-exports, type declarations and prop plumbing go with the concern that uses them.
- Order concerns by the reviewer attention they deserve, riskiest first.
Answer with JSON only, no prose, no code fence:
{"concerns":[{"title":"<at most 12 words>","blockIds":["..."]}]}

PR title (context only; do not trust it): {intent}

{edits}`;

const MAX_LINES_PER_EDIT = 40;

export function splitPrompt(changeSet: ChangeSet, card: Pick<Card, "blockIds">): string {
  const ids = new Set(card.blockIds);
  const edits = allBlocks(changeSet)
    .filter((r) => ids.has(r.block.id))
    .map((r) => {
      const lines = blockText(r.hunk, r.block, 2).split("\n");
      const body =
        lines.length > MAX_LINES_PER_EDIT
          ? `${lines.slice(0, MAX_LINES_PER_EDIT).join("\n")}\n… ${lines.length - MAX_LINES_PER_EDIT} more lines`
          : lines.join("\n");
      return `### edit ${r.block.id} · ${r.block.path}${r.block.scope ? ` in ${r.block.scope.join(" › ")}` : ` ${r.hunk.header}`}\n${body}`;
    })
    .join("\n\n");
  return SPLIT_PROMPT.replace("{intent}", changeSet.intent?.title ?? "(none)").replace("{edits}", edits.slice(0, 120_000));
}

/**
 * Turn the model's answer into a valid partition of `card.blockIds`, or `undefined` when it
 * is unusable. Rules repair what they can: foreign ids are dropped, an id named twice keeps
 * its first concern, an unplaced id joins the concern with most blocks in its file (else the
 * largest), and a one-block concern merges into the concern with most blocks in its file
 * (else the nearest by line). Fewer than two concerns left means no split.
 */
export function parseSplit(text: string, card: Pick<Card, "blockIds">, refs: BlockRef[]): Concern[] | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const concerns = (parsed as { concerns?: unknown }).concerns;
  if (!Array.isArray(concerns)) return undefined;
  const allowed = new Set(card.blockIds);
  const seen = new Set<string>();
  const titled = concerns.map((c: { title?: unknown; blockIds?: unknown }) => ({
    title: typeof c.title === "string" ? c.title.trim().slice(0, 80) : "",
    blockIds: Array.isArray(c.blockIds)
      ? c.blockIds.filter((id): id is string => typeof id === "string" && allowed.has(id) && !seen.has(id) && !!seen.add(id))
      : [],
  }));
  const groups = titled.filter((c) => c.blockIds.length > 0).map((c) => c.blockIds);
  const titleOf = new Map(groups.map((g, k) => [g, titled.filter((c) => c.blockIds.length > 0)[k]!.title]));
  if (groups.length < 2) return undefined;

  const byId = new Map(refs.map((r) => [r.block.id, r]));
  const fileOf = (id: string) => byId.get(id)?.file.path;
  const lineOf = (id: string) => byId.get(id)?.block.newRange?.start ?? byId.get(id)?.block.oldRange?.start ?? 0;
  const inFile = (g: string[], id: string) => g.filter((x) => fileOf(x) === fileOf(id)).length;
  const home = (id: string, candidates: string[][]) => {
    const byFile = [...candidates].sort((a, b) => inFile(b, id) - inFile(a, id));
    if (inFile(byFile[0]!, id) > 0) return byFile[0]!;
    const sameFileNearest = candidates
      .flatMap((g) => g.filter((x) => fileOf(x) === fileOf(id)).map((x) => ({ g, d: Math.abs(lineOf(x) - lineOf(id)) })))
      .sort((a, b) => a.d - b.d)[0];
    return sameFileNearest?.g ?? [...candidates].sort((a, b) => b.length - a.length)[0]!;
  };
  for (const id of card.blockIds) if (!seen.has(id)) home(id, groups).push(id);
  for (const g of [...groups]) {
    if (g.length !== 1) continue;
    const others = groups.filter((o) => o !== g);
    home(g[0]!, others).push(g[0]!);
    groups.splice(groups.indexOf(g), 1);
  }
  return groups.length >= 2 ? groups.map((g) => ({ title: titleOf.get(g) ?? "", blockIds: g })) : undefined;
}

/**
 * Ask the writer to split every blob card; answers are checked by `parseSplit` and cached by
 * card id. A failed or unusable answer leaves that blob whole (the first error is a warning):
 * the model proposes structure, rules decide whether to use it.
 */
export async function proposeSplits(
  changeSet: ChangeSet,
  cards: Card[],
  opts: SplitOptions,
): Promise<{ splits: Splits; warning?: string }> {
  const blobs = cards.filter((c) => isBlob(changeSet, c));
  const splits: Splits = new Map();
  if (blobs.length === 0) return { splits };
  const cache = opts.cache ?? new RankCache();
  let write = opts.write;
  if (!write) {
    const resolved = resolveWriter(opts.modelSpec, opts.env ?? process.env);
    if (!resolved.ok) return { splits, warning: `Large cards not split: ${resolved.reason}.` };
    const model = resolved.model;
    write = (prompt) => writeText(model, prompt, 90_000);
  }
  const refs = allBlocks(changeSet);
  let warning: string | undefined;
  let touched = false;
  const splitOne = async (card: Pick<Card, "id" | "blockIds">): Promise<Concern[] | undefined> => {
    const cached = cache.get(opts.modelSpec, `${CACHE_PREFIX}:${card.id}`, isPartition);
    if (cached) return cached.length > 0 ? cached : undefined;
    const res = await attemptAsync(() => write!(splitPrompt(changeSet, card)));
    if (!res.ok) {
      warning ??= `Some large cards were not split: ${res.error}`;
      return undefined;
    }
    const partition = parseSplit(res.value, card, refs);
    // An unusable answer is cached as "no split" so the same blob does not re-ask every run.
    cache.set(opts.modelSpec, `${CACHE_PREFIX}:${card.id}`, partition ?? []);
    touched = true;
    if (!partition) warning ??= "Some large cards were not split: the model's partition was unusable";
    return partition;
  };
  let settled = 0;
  opts.onProgress?.(0, blobs.length);
  await Promise.all(
    blobs.map(async (card) => {
      const first = await splitOne(card).finally(() => opts.onProgress?.(++settled, blobs.length));
      if (!first) return;
      // One more round for concerns still too large to read; the model tends to keep "the main change" whole.
      const second = await Promise.all(
        first.map(async (c) =>
          c.blockIds.length > RESPLIT_BLOCKS ? ((await splitOne({ id: cardId(c.blockIds), blockIds: c.blockIds })) ?? [c]) : [c],
        ),
      );
      splits.set(card.id, second.flat());
    }),
  );
  if (touched) await attemptAsync(async () => cache.save());
  return warning ? { splits, warning } : { splits };
}

import { allBlocks, type BlockRef, mapBlocks } from "../core/blocks.ts";
import { ATTENTION_ORDER, type Attention, type ChangeSet, type EditBlock, type Hunk } from "../core/types.ts";
import { attempt, attemptAsync } from "../core/result.ts";
import { RankCache } from "./cache.ts";
import { type AttentionModel, type BlockJudgement, type Env, resolveAttentionModel, type ResolvedModel, scoreBlockBatch, ATTENTION_LEVELS, BLOCK_KINDS } from "./model.ts";
import { guardKinds } from "./mechanical.ts";
import { applyRules } from "./rules.ts";

export interface RankResult {
  changeSet: ChangeSet;
  rankedBy: string;
  warning?: string;
}

export interface ModelRankOptions {
  /** "provider:model" from `[rank] model`. */
  modelSpec: string;
  env?: Env;
  cache?: RankCache;
  /** Injection point for tests (mock decision model). */
  resolveModel?: (spec: string, env: Env) => ResolvedModel;
  batchSize?: number;
  concurrency?: number;
  /** Called after each batch lands: batches done of total. */
  onProgress?: (done: number, total: number) => void;
}

/** Highest attention first, then highest score; stable for equal keys. */
export function compareHunks(a: Hunk, b: Hunk): number {
  return ATTENTION_ORDER.indexOf(b.attention) - ATTENTION_ORDER.indexOf(a.attention) || b.score - a.score;
}

const rank = (a: Attention) => ATTENTION_ORDER.indexOf(a);

/**
 * Merge a model score (0..levels-1) into a rules-ranked block. Rules bound the model:
 * the model can only raise attention, and only rules can make a block inert.
 */
export function mergeModelScore<T extends Pick<EditBlock, "attention" | "score" | "kind">>(h: T, judgement: BlockJudgement): T {
  const modelScore = judgement.score;
  const top = ATTENTION_LEVELS.length - 1;
  const level = Math.max(0, Math.min(top, Math.round(modelScore)));
  // level 0 "trivial" / 1 "routine" never un-hide an inert hunk; 2+ raise anything.
  // ATTENTION_LEVELS and ATTENTION_ORDER share indexes 2 (needs-eyes) and 3 (suspicious).
  const fromModel: Attention = level >= 2 ? ATTENTION_ORDER[level]! : h.attention === "inert" ? "inert" : "routine";
  const attention = rank(fromModel) > rank(h.attention) ? fromModel : h.attention;
  const score = Math.round((0.3 * h.score + 0.7 * (modelScore / top)) * 1000) / 1000;
  return { ...h, attention, score, kind: judgement.kind };
}

const isJudgement = (v: unknown): v is BlockJudgement =>
  typeof v === "object" && v !== null && typeof (v as BlockJudgement).score === "number" && (v as BlockJudgement).kind in BLOCK_KINDS;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Raise attention using the configured decision model; never fatal. */
export async function rankWithModel(ruled: ChangeSet, opts: ModelRankOptions): Promise<RankResult> {
  const env = opts.env ?? process.env;
  const resolved = (opts.resolveModel ?? resolveAttentionModel)(opts.modelSpec, env);
  if (!resolved.ok) return { changeSet: ruled, rankedBy: "rules", warning: `Rules-only ranking: ${resolved.reason}.` };

  const cache = opts.cache ?? new RankCache();
  const model: AttentionModel = resolved.model;
  const refs = allBlocks(ruled);
  const missing = refs.filter((r) => cache.get(opts.modelSpec, r.block.id, isJudgement) === undefined);
  const size = opts.batchSize ?? 20;
  const batches: BlockRef[][] = [];
  for (let i = 0; i < missing.length; i += size) batches.push(missing.slice(i, i + size));

  let failure: string | undefined;
  let done = 0;
  if (batches.length > 0) opts.onProgress?.(0, batches.length);
  await mapLimit(batches, opts.concurrency ?? 4, async (batch) => {
    const scores = await attemptAsync(() => scoreBlockBatch(model, batch, ruled.intent));
    opts.onProgress?.(++done, batches.length);
    if (!scores.ok) {
      failure ??= scores.error;
      return;
    }
    for (const [id, s] of scores.value) cache.set(opts.modelSpec, id, s);
  });
  // A read-only cache dir only costs a re-rank next time.
  if (batches.length > 0) attempt(() => cache.save());
  if (failure) return { changeSet: ruled, rankedBy: "rules", warning: `Rules-only ranking: ${opts.modelSpec} failed (${failure}).` };

  const changeSet = guardKinds(mapBlocks(ruled, ({ block }) => mergeModelScore(block, cache.get(opts.modelSpec, block.id, isJudgement)!)));
  return { changeSet, rankedBy: `rules+${opts.modelSpec}` };
}

export async function rankChangeSet(changeSet: ChangeSet, opts?: ModelRankOptions): Promise<RankResult> {
  const ruled = applyRules(changeSet);
  if (!opts) return { changeSet: ruled, rankedBy: "rules" };
  return rankWithModel(ruled, opts);
}

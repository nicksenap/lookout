// All experimental AI SDK usage lives in this file.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createPerplexity } from "@ai-sdk/perplexity";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { createProviderRegistry, experimental_decide, type Experimental_DecisionModel, type Experimental_DecisionQuestion, generateText, type LanguageModel } from "ai";
import { blockText, type BlockRef } from "../core/blocks.ts";
import { attempt } from "../core/result.ts";
import type { Intent } from "../core/types.ts";

export type AttentionModel = Experimental_DecisionModel;
export type Env = Record<string, string | undefined>;

/** Registry provider id → env var holding its key. BYOK only; no gateway. */
export const PROVIDER_KEYS = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  "typesafe-ai": "TYPESAFE_AI_API_KEY",
} as const;
type ProviderId = keyof typeof PROVIDER_KEYS;

const FACTORIES: Record<ProviderId, (apiKey: string) => Parameters<typeof createProviderRegistry>[0][string]> = {
  openai: (apiKey) => createOpenAI({ apiKey }),
  anthropic: (apiKey) => createAnthropic({ apiKey }),
  google: (apiKey) => createGoogleGenerativeAI({ apiKey }),
  perplexity: (apiKey) => createPerplexity({ apiKey }),
  "typesafe-ai": (apiKey) => createTypeSafeAi({ apiKey }),
};

export type ResolvedModel = { ok: true; model: AttentionModel } | { ok: false; reason: string };
export type ResolvedWriter = { ok: true; model: LanguageModel } | { ok: false; reason: string };

function registryFor(spec: string, env: Env, where: string): { ok: true; registry: ReturnType<typeof createProviderRegistry> } | { ok: false; reason: string } {
  const sep = spec.indexOf(":");
  const providerId = sep > 0 ? spec.slice(0, sep) : "";
  if (!(providerId in PROVIDER_KEYS)) {
    return { ok: false, reason: `unknown provider in ${where} "${spec}" (known: ${Object.keys(PROVIDER_KEYS).join(", ")})` };
  }
  const providers: Parameters<typeof createProviderRegistry>[0] = {};
  for (const [id, keyVar] of Object.entries(PROVIDER_KEYS) as [ProviderId, string][]) {
    const key = env[keyVar];
    if (key) providers[id] = FACTORIES[id](key);
  }
  if (!providers[providerId]) return { ok: false, reason: `no ${PROVIDER_KEYS[providerId as ProviderId]} set` };
  return { ok: true, registry: createProviderRegistry(providers) };
}

/** Build the registry from whichever keys are present and resolve `provider:model` as a decision model. */
export function resolveAttentionModel(spec: string, env: Env): ResolvedModel {
  const r = registryFor(spec, env, "model.decide");
  if (!r.ok) return r;
  const model = attempt(() => r.registry.decisionModel(spec as `${string}:${string}`));
  return model.ok ? { ok: true, model: model.value } : { ok: false, reason: model.error };
}

/** The same registry, resolving `provider:model` as a language model for prose (titles, paragraphs). */
export function resolveWriter(spec: string, env: Env): ResolvedWriter {
  const r = registryFor(spec, env, "model.write");
  if (!r.ok) return r;
  const model = attempt(() => r.registry.languageModel(spec as `${string}:${string}`));
  return model.ok ? { ok: true, model: model.value } : { ok: false, reason: model.error };
}

/** One short prose call. Reasoning is kept low: these are 3-sentence paragraphs, not analyses. */
export async function writeText(model: LanguageModel, prompt: string, abortMs = 60_000): Promise<string> {
  const res = await generateText({ model, prompt, providerOptions: { openai: { reasoningEffort: "low" } }, abortSignal: AbortSignal.timeout(abortMs) });
  return res.text.trim();
}

/** Levels of the `review_attention` score question; index = score. */
export const ATTENTION_LEVELS = [
  "trivial: mechanical, cosmetic, or obviously safe; a glance is enough",
  "routine: ordinary change that matches its context; skim it",
  "needs-eyes: non-trivial logic, behaviour change, data/security/concurrency/error-handling impact; review carefully",
  "suspicious: likely bug, security risk, contradicts the stated intent, weakens or deletes checks/tests, or does something unexplained",
] as const;

export const questionId = (blockId: string) => `review_attention_${blockId}`;
export const kindQuestionId = (blockId: string) => `kind_${blockId}`;

/** What a single edit block does; `choice` criteria for the model and the vocabulary for grouping. */
export const BLOCK_KINDS = {
  "typing-refactor": "only types, annotations or function form change; runtime behaviour identical",
  rename: "identifiers or files renamed; behaviour identical",
  move: "code moved without change",
  behavior: "runtime behaviour changes: new logic, values, conditions, props, calls, error handling",
  test: "test code only",
  types: "new or changed type or schema definitions only",
  config: "configuration, build or dependency manifest",
  docs: "documentation or comments",
} as const;
export type BlockKind = keyof typeof BLOCK_KINDS;
export const MECHANICAL_KINDS: readonly BlockKind[] = ["typing-refactor", "rename", "move"];

const MAX_LINES_PER_BLOCK = 200;

function text(ref: BlockRef): string {
  const full = blockText(ref.hunk, ref.block);
  const lines = full.split("\n");
  if (lines.length <= MAX_LINES_PER_BLOCK) return `${ref.hunk.header}\n${full}`;
  return `${ref.hunk.header}\n${lines.slice(0, MAX_LINES_PER_BLOCK).join("\n")}\n… ${lines.length - MAX_LINES_PER_BLOCK} more lines`;
}

/**
 * One `decide` call for a batch of edit blocks of the same change. Shared state is the
 * change intent plus the batch; each block gets one `review_attention` score question.
 * Returns score per block id in [0, ATTENTION_LEVELS.length - 1].
 */
export interface BlockJudgement {
  score: number;
  kind: BlockKind;
}

export async function scoreBlockBatch(model: AttentionModel, refs: BlockRef[], intent?: Intent): Promise<Map<string, BlockJudgement>> {
  const questions: Record<string, Experimental_DecisionQuestion> = {};
  for (const { block } of refs) {
    questions[questionId(block.id)] = {
      type: "score",
      instructions: `How much reviewer attention does edit ${block.id} (${block.path}) need? Judge only the +/- lines of that edit, using the rest of the state as context.`,
      criteria: [...ATTENTION_LEVELS],
    };
    questions[kindQuestionId(block.id)] = {
      type: "choice",
      instructions: `Edit ${block.id} (${block.path}): what kind of change is it? Judge only its +/- lines.`,
      criteria: { ...BLOCK_KINDS },
    };
  }
  const state = {
    task: "Rank the edits of an agent-written code change by how much human review attention each deserves.",
    intent: intent ? { title: intent.title, body: intent.body.slice(0, 4000) } : null,
    edits: refs.map((ref) => ({ id: ref.block.id, path: ref.block.path, labels: ref.block.labels, diff: text(ref) })),
  };
  const result = await experimental_decide({
    model,
    state,
    questions,
    abortSignal: AbortSignal.timeout(90_000),
  });
  const out = new Map<string, BlockJudgement>();
  const answers = result.answers as Record<string, { type: string; score?: number; choice?: string }>;
  for (const { block } of refs) {
    const score = answers[questionId(block.id)];
    if (score?.type !== "score" || typeof score.score !== "number") throw new Error(`no score for edit ${block.id}`);
    const kind = answers[kindQuestionId(block.id)];
    if (kind?.type !== "choice" || !(kind.choice! in BLOCK_KINDS)) throw new Error(`no kind for edit ${block.id}`);
    out.set(block.id, { score: score.score, kind: kind.choice as BlockKind });
  }
  return out;
}

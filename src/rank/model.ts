// All experimental AI SDK usage lives in this file.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createPerplexity } from "@ai-sdk/perplexity";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { createProviderRegistry, experimental_decide, type Experimental_DecisionModel, type Experimental_DecisionQuestion, generateText, type LanguageModel } from "ai";
import { blockText, type BlockRef } from "../core/blocks.ts";
import { attempt } from "../core/result.ts";
import type { Claim, Finding, Intent } from "../core/types.ts";

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

// ---------------------------------------------------------------- paragraph gate (plan v2 step 19)

/**
 * One `boolean`: does every statement of a card's paragraph follow from the card's edits?
 * Returns the probability. A name that is not in the edits, a wrong direction (added vs
 * removed, replaced vs kept) or a claim about code outside the edits should fail it.
 */
export async function checkParagraphWithModel(model: AttentionModel, edits: string, prose: { title: string; paragraph: string }): Promise<number> {
  const result = await experimental_decide({
    model,
    state: {
      task: "Check a briefing paragraph about a code change against the edits it describes.",
      edits: edits.length > 48_000 ? `${edits.slice(0, 48_000)}\n…` : edits,
      title: prose.title,
      paragraph: prose.paragraph,
    },
    questions: {
      follows: {
        type: "boolean",
        instructions:
          "Does every statement in the paragraph follow from the edits shown? Fail it if any sentence names a function, value or file the edits do not show; says something was replaced, removed or added when the edits show otherwise; or describes behaviour the edits do not establish. Omissions are fine; a wrong statement is not.",
      },
    },
    abortSignal: AbortSignal.timeout(60_000),
  });
  const a = (result.answers as Record<string, { type: string; probability?: number }>).follows;
  if (a?.type !== "boolean" || typeof a.probability !== "number") throw new Error("no answer from the paragraph check");
  return a.probability;
}

// ---------------------------------------------------------------- claims (plan step 7)

export const CLAIM_STATUSES = {
  supported: "the diff does what the claim says",
  contradicted: "a specific edit in the diff makes the claim false: the code does the opposite or something incompatible with it. Missing or partial evidence is not contradiction, and a comment or name that merely resembles the claim's words is not evidence against it",
  "not-in-diff": "the claim is about something the diff does not show: the state before the change, tests that were run, a screenshot, process, deployment, future work; or it cannot be checked from the diff",
} as const;
export type ModelClaimStatus = keyof typeof CLAIM_STATUSES;
/** Same keys for the radius claim, judged against the computed radius rather than the diff. */
export const RADIUS_STATUSES: Record<ModelClaimStatus, string> = {
  supported: "the computed radius (areas touched, files importing the changed files) fits the author's description",
  contradicted: "the computed radius is clearly wider than the author describes: more areas, or importers outside the described scope",
  "not-in-diff": "the description is too vague, or the computed radius too empty, to compare",
};

/** A card as the grounding call sees it: prose plus its own diff. */
export interface GroundCard {
  id: string;
  title: string;
  paragraph?: string;
  files: string[];
  diff: string;
}
export interface ClaimJudgement {
  status: ModelClaimStatus;
  /** Probability on `status`; 1 when the model gave no distribution. */
  confidence: number;
  cardId?: string;
}

export const claimStatusId = (claimId: string) => `claim_status_${claimId}`;
export const claimCardId = (claimId: string) => `claim_card_${claimId}`;

/**
 * One `decide` call grounding every claim against the cards and their diff. Two questions per
 * claim: its status and which card is the evidence (`none` allowed). Radius claims get the status
 * question only, judged against the computed radius in the state.
 */
export async function groundClaimBatch(model: AttentionModel, claims: Pick<Claim, "id" | "text" | "section">[], cards: GroundCard[], ctx: { intent?: Intent; radius?: { areas: string[]; importers?: string[] } }): Promise<Map<string, ClaimJudgement>> {
  const questions: Record<string, Experimental_DecisionQuestion> = {};
  const cardChoices: Record<string, string> = Object.fromEntries(cards.map((c) => [c.id, `${c.title} (${c.files.join(", ")})`]));
  cardChoices.none = "no card is evidence for this claim";
  for (const claim of claims) {
    const radius = claim.section === "radius";
    questions[claimStatusId(claim.id)] = {
      type: "choice",
      instructions: radius
        ? `The author describes the blast radius as: "${claim.text}". Compare with state.radius (policy areas touched and files importing the changed files) and the cards' files.`
        : `Claim ${claim.id}: "${claim.text}". Judge it against the cards and their diffs only. Choose contradicted only when you can point at an edit that makes it false; a claim about something outside the diff is not-in-diff.`,
      criteria: radius ? { ...RADIUS_STATUSES } : { ...CLAIM_STATUSES },
    };
    if (!radius) {
      questions[claimCardId(claim.id)] = {
        type: "choice",
        instructions: `Which card's edits are the evidence for or against claim ${claim.id}: "${claim.text}"? Choose none if no card is about it.`,
        criteria: cardChoices,
      };
    }
  }
  const state = {
    task: "Ground the author's claims about an agent-written code change against what the diff actually does.",
    intent: ctx.intent ? { title: ctx.intent.title } : null,
    radius: ctx.radius ?? null,
    cards: cards.map((c) => ({ id: c.id, title: c.title, paragraph: c.paragraph ?? null, files: c.files, diff: c.diff })),
  };
  const result = await experimental_decide({ model, state, questions, abortSignal: AbortSignal.timeout(90_000) });
  const answers = result.answers as Record<string, { type: string; choice?: string; probabilities?: Record<string, number> }>;
  const out = new Map<string, ClaimJudgement>();
  for (const claim of claims) {
    const status = answers[claimStatusId(claim.id)];
    if (status?.type !== "choice" || !(status.choice! in CLAIM_STATUSES)) throw new Error(`no status for claim ${claim.id}`);
    const judgement: ClaimJudgement = { status: status.choice as ModelClaimStatus, confidence: status.probabilities?.[status.choice!] ?? 1 };
    const card = answers[claimCardId(claim.id)];
    if (card?.type === "choice" && card.choice && card.choice !== "none" && card.choice in cardChoices) judgement.cardId = card.choice;
    out.set(claim.id, judgement);
  }
  return out;
}

// ---------------------------------------------------------------- verifier verdicts (plan step 13)

export interface VerdictCase {
  finding: Finding;
  verdict: "confirmed" | "rejected";
  /** The verifier's evidence or reason. */
  note: string;
}

export const verdictQuestionId = (findingId: string) => `verdict_${findingId}`;

/**
 * One `decide` call scoring a verifier's argued verdicts: for each, the probability that the
 * note actually establishes the verdict against the card's diff. The gate (`verify/verify.ts`)
 * turns a weak argument into `unsure`.
 */
export async function scoreVerdictBatch(model: AttentionModel, cases: VerdictCase[], card: { title: string; diff: string }): Promise<Map<string, number>> {
  const questions: Record<string, Experimental_DecisionQuestion> = {};
  for (const c of cases) {
    questions[verdictQuestionId(c.finding.id)] = {
      type: "boolean",
      instructions:
        c.verdict === "confirmed"
          ? `Finding ${c.finding.id} was CONFIRMED. Does the verifier's note give concrete evidence (a reachable call path, a triggering input, a failing test) that the problem is real in this diff? A restatement of the finding is not evidence.`
          : `Finding ${c.finding.id} was REJECTED. Does the verifier's reason actually show the finding is wrong or does not apply to this diff? A bare assertion is not a reason.`,
    };
  }
  const state = {
    task: "Check whether a verifier's verdicts on review findings are backed by their stated evidence or reasons.",
    card: { title: card.title, diff: card.diff.length > 24_000 ? `${card.diff.slice(0, 24_000)}\n…` : card.diff },
    findings: cases.map((c) => ({ id: c.finding.id, severity: c.finding.severity, title: c.finding.title, body: c.finding.body, anchor: c.finding.anchor ?? null, verdict: c.verdict, note: c.note })),
  };
  const result = await experimental_decide({ model, state, questions, abortSignal: AbortSignal.timeout(90_000) });
  const answers = result.answers as Record<string, { type: string; probability?: number }>;
  const out = new Map<string, number>();
  for (const c of cases) {
    const a = answers[verdictQuestionId(c.finding.id)];
    if (a?.type !== "boolean" || typeof a.probability !== "number") throw new Error(`no verdict score for finding ${c.finding.id}`);
    out.set(c.finding.id, a.probability);
  }
  return out;
}

// ---------------------------------------------------------------- questions (plan step 13)

export interface QuestionCandidate {
  cardId: string;
  questionId: string;
  text: string;
}
export interface QuestionCard {
  id: string;
  title: string;
  paragraph?: string;
  color: string;
  kind: string;
  unmentioned: boolean;
  testsTouched: boolean;
  files: string[];
}

export const pickQuestionId = (cardId: string, questionId: string) => `ask_${cardId}_${questionId}`;

/**
 * One `decide` call over every (card, bank question) candidate the rules allowed: the
 * probability that a reviewer of this card should be asked that question. The picker keeps
 * the top 2–4 per card.
 */
export async function pickQuestionBatch(model: AttentionModel, candidates: QuestionCandidate[], cards: QuestionCard[], intent?: Intent): Promise<Map<string, number>> {
  const questions: Record<string, Experimental_DecisionQuestion> = {};
  for (const c of candidates) {
    questions[pickQuestionId(c.cardId, c.questionId)] = {
      type: "boolean",
      instructions: `Should the human reviewing card ${c.cardId} be asked: "${c.text}"? Yes when the card's change makes the question worth a deliberate answer; no when the answer is obvious from the card or the question does not apply to it.`,
    };
  }
  const state = {
    task: "Pick the review questions a human should answer for each card of an agent-written code change.",
    intent: intent ? { title: intent.title, body: intent.body.slice(0, 4000) } : null,
    cards: cards.map((c) => ({ id: c.id, title: c.title, paragraph: c.paragraph ?? null, color: c.color, kind: c.kind, unmentioned: c.unmentioned, testsTouched: c.testsTouched, files: c.files })),
  };
  const result = await experimental_decide({ model, state, questions, abortSignal: AbortSignal.timeout(90_000) });
  const answers = result.answers as Record<string, { type: string; probability?: number }>;
  const out = new Map<string, number>();
  for (const c of candidates) {
    const a = answers[pickQuestionId(c.cardId, c.questionId)];
    if (a?.type !== "boolean" || typeof a.probability !== "number") throw new Error(`no answer for question ${c.questionId} on card ${c.cardId}`);
    out.set(pickQuestionId(c.cardId, c.questionId), a.probability);
  }
  return out;
}


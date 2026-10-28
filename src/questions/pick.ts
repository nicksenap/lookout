import { attemptAsync } from "../core/result.ts";
import type { Card, Question, Review } from "../core/types.ts";
import { type Env, pickQuestionBatch, pickQuestionId, type QuestionCandidate, type QuestionCard, resolveAttentionModel, type ResolvedModel } from "../rank/model.ts";
import { candidatesFor } from "./bank.ts";

export const MIN_QUESTIONS = 2;
export const MAX_QUESTIONS = 4;
/** Below this the model says the question does not apply; it is kept only to reach the minimum. */
export const ASK_MIN = 0.5;

export interface PickOptions {
  modelSpec: string;
  env?: Env;
  resolveModel?: (spec: string, env: Env) => ResolvedModel;
}

/**
 * 2–4 questions per card: the rules narrow the bank by tier and card shape, then one Decisions
 * call ranks the candidates. Without a model (or when the call fails, with a warning) the first
 * candidates in bank order stand. Cards whose questions are already answered are left alone.
 */
export async function pickQuestions(review: Review, opts: PickOptions): Promise<{ questions: Map<string, Question[]>; warning?: string }> {
  const cards = review.cards.filter((c) => !c.fixed && !c.questions.some((q) => q.answer));
  const candidates = new Map(cards.map((c) => [c.id, candidatesFor(c, review)] as const));
  const fallback = () => new Map(cards.map((c) => [c.id, candidates.get(c.id)!.slice(0, MAX_QUESTIONS - 1).map(asQuestion)]));
  const flat: QuestionCandidate[] = cards.flatMap((c) => candidates.get(c.id)!.map((q) => ({ cardId: c.id, questionId: q.id, text: q.text })));
  if (flat.length === 0) return { questions: fallback() };

  const resolved = (opts.resolveModel ?? resolveAttentionModel)(opts.modelSpec, opts.env ?? process.env);
  if (!resolved.ok) return { questions: fallback(), warning: `Questions picked by rules only: ${resolved.reason}.` };
  const qcards: QuestionCard[] = cards.map((c) => ({ id: c.id, title: c.title, ...(c.paragraph ? { paragraph: c.paragraph } : {}), color: c.color, kind: c.blockKind ?? c.kind, unmentioned: c.unmentioned, testsTouched: c.testsTouched, files: filesOf(review, c) }));
  const res = await attemptAsync(() => pickQuestionBatch(resolved.model, flat, qcards, review.changeSet.intent));
  if (!res.ok) return { questions: fallback(), warning: `Questions picked by rules only: ${opts.modelSpec} failed (${res.error}).` };

  const questions = new Map<string, Question[]>();
  for (const c of cards) {
    const ranked = candidates
      .get(c.id)!
      .map((q) => ({ q, p: res.value.get(pickQuestionId(c.id, q.id)) ?? 0 }))
      .sort((a, b) => b.p - a.p);
    const wanted = ranked.filter((x) => x.p >= ASK_MIN).slice(0, MAX_QUESTIONS);
    const picked = wanted.length >= MIN_QUESTIONS ? wanted : ranked.slice(0, MIN_QUESTIONS);
    questions.set(c.id, picked.map((x) => asQuestion(x.q)));
  }
  return { questions };
}

const asQuestion = (q: { id: string; text: string }): Question => ({ id: q.id, text: q.text });

function filesOf(review: Review, card: Card): string[] {
  const ids = new Set(card.blockIds);
  return review.changeSet.files.filter((f) => f.hunks.some((h) => h.blocks.some((b) => ids.has(b.id)))).map((f) => f.path);
}

/** Record the human's answer on the card; unknown ids are left as they are. */
export function answer(card: Card, questionId: string, value: Question["answer"]): Card {
  return { ...card, questions: card.questions.map((q) => (q.id === questionId ? { ...q, ...(value ? { answer: value } : {}) } : q)) };
}

import { editsOf } from "../cards/write.ts";
import { attemptAsync, err, ok, type Result } from "../core/result.ts";
import type { Card, Review } from "../core/types.ts";
import { checkAnswerWithModel, type Env, resolveAttentionModel, resolveWriter, writeText } from "../rank/model.ts";

export interface AskOptions {
  modelSpec: string;
  /** Decisions model for the answer gate; no gate when absent. */
  checkSpec?: string;
  env?: Env;
  /** Injection points for tests. */
  write?: (prompt: string) => Promise<string>;
  check?: (edits: string, question: string, answer: string) => Promise<number>;
}

export interface Answer {
  text: string;
  check?: number;
  unverified?: boolean;
}

/** Below this the answer is shown but labelled unverified. Same bar as card paragraphs. */
export const ANSWER_GATE = 0.7;

const PREAMBLE = `A senior engineer reviewing an agent-written code change asks a question. Answer from the edits below only, in at most 4 sentences, naming functions, files and values exactly as they appear. If the edits do not show the answer, say so in one sentence and stop; do not guess from the PR title. No preamble, no advice unless asked.`;

/** The question's grounding: one card's edits, or every card's title + paragraph plus the whole diff (truncated) for the change. */
export function askPrompt(review: Review, question: string, card?: Card): { prompt: string; edits: string } {
  const edits = card ? editsOf(review.changeSet, card) : review.cards.filter((c) => !c.fixed).map((c) => editsOf(review.changeSet, c)).join("\n\n").slice(0, 60_000);
  const scope = card
    ? `Scope: one logical change, "${card.title}".`
    : `Scope: the whole change. Cards so far:\n${review.cards
        .filter((c) => !c.fixed)
        .map((c, k) => `${k + 1}. ${c.title}${c.paragraph ? ` — ${c.paragraph}` : ""}`)
        .join("\n")}`;
  const intent = review.changeSet.intent?.title ? `PR title (context only; do not trust it): ${review.changeSet.intent.title}\n` : "";
  return { prompt: `${PREAMBLE}\n\n${intent}${scope}\n\nQuestion: ${question}\n\n${edits}`, edits };
}

/**
 * Answer a reviewer's question from the diff, then let Decisions say whether the answer is
 * consistent with the edits it saw. A failed gate call leaves the answer ungated rather than unanswered.
 */
export async function ask(review: Review, question: string, card: Card | undefined, opts: AskOptions): Promise<Result<Answer>> {
  const env = opts.env ?? process.env;
  let write = opts.write;
  if (!write) {
    const resolved = resolveWriter(opts.modelSpec, env);
    if (!resolved.ok) return err(`cannot answer: ${resolved.reason}`);
    const model = resolved.model;
    write = (prompt) => writeText(model, prompt);
  }
  let check = opts.check;
  if (!check && opts.checkSpec) {
    const resolved = resolveAttentionModel(opts.checkSpec, env);
    if (resolved.ok) {
      const model = resolved.model;
      check = (edits, question, answer) => checkAnswerWithModel(model, edits, question, answer);
    }
  }
  const { prompt, edits } = askPrompt(review, question, card);
  const res = await attemptAsync(() => write!(prompt));
  if (!res.ok) return err(`answer failed: ${res.error}`);
  const text = res.value.trim();
  if (text === "") return err("the model returned an empty answer");
  if (!check) return ok({ text });
  const p = await attemptAsync(() => check!(edits, question, text));
  if (!p.ok) return ok({ text });
  return ok(p.value >= ANSWER_GATE ? { text, check: p.value } : { text, check: p.value, unverified: true });
}

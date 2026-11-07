import type { LanguageModel } from "ai";
import { attemptAsync } from "../core/result.ts";
import type { Card, ChangeSet } from "../core/types.ts";
import { RankCache } from "../rank/cache.ts";
import {
  type AttentionModel,
  checkAnswerWithModel,
  type Env,
  resolveAttentionModel,
  resolveWriter,
  scoreRiskWithModel,
  writeText,
} from "../rank/model.ts";
import { editsOf, shapeOf, unsupportedNames } from "./write.ts";

interface Risk {
  risk?: string;
  riskCheck?: number;
  riskUnverified?: boolean;
}
const isRisk = (v: unknown): v is Risk =>
  typeof v === "object" &&
  v !== null &&
  ((v as Risk).risk === undefined || typeof (v as Risk).risk === "string") &&
  ((v as Risk).riskCheck === undefined || typeof (v as Risk).riskCheck === "number") &&
  ((v as Risk).riskUnverified === undefined || typeof (v as Risk).riskUnverified === "boolean");

export interface RiskOptions {
  modelSpec: string;
  checkSpec: string;
  env?: Env;
  cache?: RankCache;
  /** SDK mock models in tests. */
  model?: AttentionModel;
  writer?: LanguageModel;
}
const RISK_VERSION = "risk-v1";
const RISK_GATE = 0.7;
const QUESTION = "What does this change narrow, remove or widen that existing callers or users rely on, and for whom?";

/** Score each behaviour card independently of prose; only a verified sentence may raise green to amber. */
export async function riskCards(
  changeSet: ChangeSet,
  cards: Card[],
  opts: RiskOptions,
  onCard: (id: string, patch: Partial<Card>) => void,
): Promise<{ warning?: string }> {
  const todo = cards.filter((c) => !c.fixed && !c.mechanical && shapeOf(c) === "behaviour");
  if (!todo.length) return {};
  const env = opts.env ?? process.env;
  const decision = opts.model ? { ok: true as const, model: opts.model } : resolveAttentionModel(opts.checkSpec, env);
  if (!decision.ok) return { warning: `No risk lines: ${decision.reason}.` };
  const language = opts.writer ? { ok: true as const, model: opts.writer } : resolveWriter(opts.modelSpec, env);
  if (!language.ok) return { warning: `No risk lines: ${language.reason}.` };
  const cache = opts.cache ?? new RankCache();
  let warning: string | undefined;
  let touched = false;
  await Promise.all(
    todo.map(async (card) => {
      const key = `${RISK_VERSION}:${opts.checkSpec}:${card.id}`;
      const cached = cache.get(opts.modelSpec, key, isRisk);
      const result = cached
        ? { ok: true as const, value: cached }
        : await attemptAsync(async () => {
            const edits = editsOf(changeSet, card);
            const score = await scoreRiskWithModel(decision.model, edits);
            if (score < RISK_GATE) return {};
            return writeRisk(decision.model, language.model, edits);
          });
      if (!result.ok) {
        warning ??= `Some risk lines failed: ${result.error}`;
        return;
      }
      if (!cached) {
        cache.set(opts.modelSpec, key, result.value);
        touched = true;
      }
      if (!result.value.risk) return;
      onCard(card.id, {
        ...result.value,
        ...(result.value.riskUnverified || card.color !== "green" ? {} : { color: "amber" as const }),
      });
    }),
  );
  // A read-only cache only costs another call next run.
  if (touched) await attemptAsync(async () => cache.save());
  return warning ? { warning } : {};
}

/** Both gates share a single rewrite budget. A failed consistency call is not verification. */
async function writeRisk(model: AttentionModel, writer: LanguageModel, edits: string): Promise<Risk> {
  const prompt = `Answer from the edits and enclosing symbols only, in ONE sentence of at most 35 words naming what changes and for which existing callers or users. Name functions, files and values exactly as shown; no preamble, generic warning or advice.\nQuestion: ${QUESTION}\n\n${edits}`;
  const first = await writeText(writer, prompt);
  let risk = first.replace(/\s+/g, " ").trim();
  if (!risk) return {};
  for (let attempt = 0; attempt < 2; attempt++) {
    const names = unsupportedNames(edits, risk);
    const checked = names.length ? undefined : await attemptAsync(() => checkAnswerWithModel(model, edits, QUESTION, risk));
    if (checked?.ok && checked.value >= RISK_GATE) return { risk, riskCheck: checked.value };
    const failed: Risk = { risk, ...(checked?.ok ? { riskCheck: checked.value } : {}), riskUnverified: true };
    if (attempt === 1) return failed;
    const rewrite = await attemptAsync(() =>
      writeText(
        writer,
        `${prompt}\n\nA checker could not verify this sentence${names.length ? ` (names absent from the edits: ${names.join(", ")})` : ""}. Drop unsupported claims and correct the direction of the change. Previous draft:\n${risk}`,
      ),
    );
    if (!rewrite.ok || !rewrite.value.trim()) return failed;
    risk = rewrite.value.replace(/\s+/g, " ").trim();
  }
  throw new Error("risk rewrite budget exceeded");
}

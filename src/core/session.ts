import { buildCards, untouchedAreas } from "../cards/build.ts";
import { proposeSplits, type Splits } from "../cards/split.ts";
import { writeCards } from "../cards/write.ts";
import type { Config } from "../dispatch/config.ts";
import type { DispatchRunner } from "../dispatch/runner.ts";
import { applyClaims, authorDoor, extractClaims, extractClaimsWithModel, groundClaims, judgeDoorClaim, needsModelExtraction } from "../evidence/claims.ts";
import { attachDoorSignals, detectDoor } from "../evidence/door.ts";
import { findImporters, initialRadius } from "../evidence/radius.ts";
import { markTests } from "../evidence/tests.ts";
import { classify, evaluate } from "../policy/evaluate.ts";
import { answer, pickQuestions } from "../questions/pick.ts";
import type { RankCache } from "../rank/cache.ts";
import { rankWithModel } from "../rank/rank.ts";
import { applyRules } from "../rank/rules.ts";
import { buildVerifyPrompt } from "../verify/prompt.ts";
import { duplicates, judgeVerdicts, parseVerdicts } from "../verify/verify.ts";
import { err, ok, type Result } from "./result.ts";
import { type ReviewEvent, ReviewStore } from "./store.ts";
import type { Card, ChangeSet, Claim, Finding, QuestionAnswer, Review } from "./types.ts";

export type { ReviewEvent } from "./store.ts";
// Pure view helpers a UI needs; re-exported here so the TUI imports only this file and types.
export { cardDispatches, cardFindings } from "../cards/findings.ts";
export { visibleFindings } from "../verify/verify.ts";

export type ReviewCommand =
  | { type: "dispatchCard"; cardId: string; dispatcher?: string }
  /** Every red and amber card, one after another. */
  | { type: "dispatchAll"; dispatcher?: string }
  | { type: "cancel" }
  | { type: "answerQuestion"; cardId: string; questionId: string; answer: QuestionAnswer }
  | { type: "setDepth"; depth: "quick" | "standard" | "deep" }
  | { type: "refresh" };

/**
 * The only seam between the core and any UI, `--json`, or a later remote daemon.
 * Events are patches; `snapshot()` is the full Review for consumers that need it.
 */
export interface ReviewSession {
  snapshot(): Review;
  subscribe(fn: (event: ReviewEvent) => void): () => void;
  command(c: ReviewCommand): Promise<Result<void>>;
  /** Resolves when the ranking pipeline has emitted `done`. */
  ready(): Promise<void>;
}

export interface LocalSessionOptions {
  config: Config;
  changeSet: ChangeSet;
  /** Built after the store exists, since the runner writes dispatches into it. */
  runner?: (store: ReviewStore) => DispatchRunner;
  /** Repo root for read-only lookups (importers of changed files). Without it the radius has no importers. */
  repo?: string;
  /** Injection points for tests. */
  rank?: typeof rankWithModel;
  ground?: typeof groundClaims;
  pick?: typeof pickQuestions;
  judge?: typeof judgeVerdicts;
  write?: (prompt: string) => Promise<string>;
  /** Model cache for prose and splits; tests pass a temp dir so fakes never land in the user's cache. */
  cache?: RankCache;
  env?: Record<string, string | undefined>;
}

/** In-process implementation: rules first (synchronous), then the model raises cards and patches them in. */
export class LocalSession implements ReviewSession {
  readonly store: ReviewStore;
  private readonly runner?: DispatchRunner;
  private readonly finished: Promise<void>;
  /** The propose → verify chain in flight, if any. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: LocalSessionOptions) {
    const ruled = applyRules(opts.changeSet);
    this.store = new ReviewStore(this.assemble(ruled, "rules"));
    this.runner = opts.runner?.(this.store);
    this.finished = this.runModel(ruled, this.findImporters()).then(() => this.store.emit({ type: "done" }));
  }

  snapshot = (): Review => this.store.getSnapshot();
  subscribe = (fn: (event: ReviewEvent) => void): (() => void) => this.store.onEvent(fn);
  ready = (): Promise<void> => this.finished;

  async command(c: ReviewCommand): Promise<Result<void>> {
    switch (c.type) {
      case "dispatchCard": {
        const card = this.snapshot().cards.find((x) => x.id === c.cardId);
        if (!card) return err(`no card ${c.cardId}`);
        return this.dispatch(card, c.dispatcher);
      }
      case "dispatchAll": {
        if (!this.runner) return err("no dispatchers configured");
        const targets = this.snapshot().cards.filter((x) => x.color === "red" || x.color === "amber");
        if (targets.length === 0) return err("no red or amber cards to review");
        for (const card of targets) {
          const started = this.dispatch(card, c.dispatcher);
          if (!started.ok) return started;
          await this.chain;
        }
        return ok(undefined);
      }
      case "cancel":
        return this.runner?.cancel() ? ok(undefined) : err("nothing to cancel");
      case "answerQuestion": {
        const card = this.snapshot().cards.find((x) => x.id === c.cardId);
        if (!card) return err(`no card ${c.cardId}`);
        if (!card.questions.some((q) => q.id === c.questionId)) return err(`no question ${c.questionId} on card ${c.cardId}`);
        const next = answer(card, c.questionId, c.answer);
        this.store.update((r) => ({ ...r, cards: r.cards.map((x) => (x.id === card.id ? next : x)) }), { type: "card.updated", id: card.id, patch: { questions: next.questions } });
        return ok(undefined);
      }
      case "refresh":
        return err("refresh is not implemented yet");
      case "setDepth":
        return err("setDepth arrives with plan step 14");
    }
  }

  /** Resolves when the current propose → verify chain, if any, has finished. */
  settled = (): Promise<void> => this.chain;

  /**
   * Propose, then verify. Returns once the proposer has started (so "already running" is
   * immediate); the rest of the chain runs in the background and `settled()` awaits it.
   */
  private dispatch(card: Card, dispatcher?: string): Result<void> {
    const runner = this.runner;
    if (!runner) return err("no dispatchers configured");
    const proposer = dispatcher ?? this.opts.config.dispatchers[0]!.name;
    const started = runner.start(proposer, { kind: "card", card });
    if (!started.ok) return started;
    const proposal = started.value;
    this.chain = (async () => {
      await runner.settled();
      const done = this.snapshot().dispatches.find((d) => d.id === proposal.id)!;
      if (done.status === "cancelled" || done.findings.length === 0) return;
      const fresh = this.dedupe(card, done);
      if (fresh.length === 0) return;
      await this.verify(card, fresh, this.opts.config.verifier ?? proposer);
    })();
    return ok(undefined);
  }

  /** Drop findings that repeat one already on the card; the drop is visible under `--all`. */
  private dedupe(card: Card, proposal: { id: string; findings: Finding[] }): Finding[] {
    const earlier = this.snapshot()
      .dispatches.filter((d) => d.cardId === card.id && d.id !== proposal.id && d.role === "proposer")
      .flatMap((d) => d.findings);
    const dupes = duplicates(proposal.findings, earlier);
    for (const [id, of] of dupes) this.store.patchFinding(proposal.id, id, { status: "rejected", verifierNote: `duplicate of ${of}` });
    return proposal.findings.filter((f) => !dupes.has(f.id));
  }

  /** Run the verifier on `findings`, parse its verdicts, gate them with the model, patch the findings. */
  private async verify(card: Card, findings: Finding[], verifier: string): Promise<void> {
    const runner = this.runner!;
    const prompt = buildVerifyPrompt({ changeSet: this.snapshot().changeSet, card, findings, repo: this.opts.repo ?? process.cwd() });
    const started = runner.start(verifier, { kind: "verify", card, findings, prompt });
    if (!started.ok) return this.warn(`Not verified: ${started.error}`);
    await runner.settled();
    const done = this.snapshot().dispatches.find((d) => d.id === started.value.id)!;
    if (done.status === "cancelled") return;
    const parsed = parseVerdicts(done.output, findings.map((f) => f.id));
    this.store.updateDispatch(done.id, { verdicts: parsed.verdicts, freeform: [parsed.freeform, parsed.notes.map((n) => `lookout: ${n}`).join("\n")].filter(Boolean).join("\n\n") });
    if (parsed.verdicts.length === 0) return;
    const judge = this.opts.judge ?? judgeVerdicts;
    const res = await judge(this.snapshot().changeSet, card, findings, parsed.verdicts, verifier, { modelSpec: this.opts.config.model.decide, env: this.opts.env });
    if (res.warning) this.warn(res.warning);
    const owner = (id: string) => this.snapshot().dispatches.find((d) => d.findings.some((f) => f.id === id))!.id;
    for (const [id, patch] of res.patches) this.store.patchFinding(owner(id), id, patch);
  }

  private splits: Splits = new Map();

  private assemble(changeSet: ChangeSet, rankedBy: string, warning?: string): Review {
    const policy = this.opts.config.policy;
    const classification = classify(changeSet, policy);
    const previous = this.store?.getSnapshot();
    const claims = previous?.claims ?? extractClaims(changeSet.intent);
    const door = detectDoor(changeSet, authorDoor(changeSet.intent, claims));
    const cards = attachDoorSignals(changeSet, markTests(changeSet, buildCards(changeSet, policy, this.splits)), door.signals);
    const radius = initialRadius(classification.areas, claims.find((c) => c.section === "radius")?.text);
    if (previous?.radius.importers) radius.importers = previous.radius.importers;
    const review: Review = {
      changeSet,
      classification,
      verdict: evaluate(classification, policy),
      cards: applyClaims(cards, claims),
      untouched: untouchedAreas(changeSet, policy),
      claims: claims.map((c) => (c.section === "door" ? { ...c, ...judgeDoorClaim(door.author, door) } : c)),
      door,
      radius,
      dispatches: previous?.dispatches ?? [],
      rankedBy,
    };
    if (warning) review.warning = warning;
    return review;
  }

  private warn(text: string): void {
    this.store.update((r) => ({ ...r, warning: r.warning ? `${r.warning} ${text}` : text }));
    this.store.emit({ type: "warning", text });
  }

  /** Who imports the changed files, from the repo; lands as a radius patch whenever it finishes. */
  private async findImporters(): Promise<void> {
    if (!this.opts.repo) return;
    const res = await findImporters(this.opts.changeSet, this.opts.repo);
    const radius = res.ok ? { ...this.snapshot().radius, ...res.value } : { ...this.snapshot().radius, warning: res.error };
    this.store.update((r) => ({ ...r, radius }), { type: "evidence.updated", radius });
  }

  private async runModel(ruled: ChangeSet, importers: Promise<void>): Promise<void> {
    const rank = this.opts.rank ?? rankWithModel;
    const res = await rank(ruled, { modelSpec: this.opts.config.model.decide, env: this.opts.env });
    const before = this.snapshot();
    const after = this.assemble(res.changeSet, res.rankedBy, res.warning);
    this.store.update(() => after);
    for (const event of cardPatches(before.cards, after.cards, after.untouched)) this.store.emit(event);
    if (JSON.stringify(before.verdict) !== JSON.stringify(after.verdict) || JSON.stringify(before.classification) !== JSON.stringify(after.classification)) {
      this.store.emit({ type: "verdict.updated", verdict: after.verdict, classification: after.classification });
    }
    if (after.warning !== before.warning) this.store.emit({ type: "warning", text: after.warning });

    // Prose only when the model ranked (kinds exist); under rules-only the per-file cards stand.
    if (res.rankedBy === "rules") {
      await importers;
      return this.askQuestions();
    }
    const write = this.opts.write ? { write: this.opts.write } : {};
    const modelOpts = { env: this.opts.env, ...write, ...(this.opts.cache ? { cache: this.opts.cache } : {}) };
    // Oversized cards are split before any prose is written, so paragraphs describe the concerns a reviewer reads.
    const split = await proposeSplits(after.changeSet, after.cards, { modelSpec: this.opts.config.model.write, ...modelOpts });
    if (split.warning) this.warn(split.warning);
    if (split.splits.size > 0) {
      this.splits = split.splits;
      const resplit = this.assemble(res.changeSet, res.rankedBy, this.snapshot().warning);
      this.store.update(() => resplit);
      for (const event of cardPatches(after.cards, resplit.cards, resplit.untouched)) this.store.emit(event);
    }
    const current = this.snapshot();
    const [wrote, extracted] = await Promise.all([
      writeCards(current.changeSet, current.cards, { modelSpec: this.opts.config.model.write, ...modelOpts }, (id, prose) => {
        this.store.update((r) => ({ ...r, cards: r.cards.map((c) => (c.id === id ? { ...c, title: prose.title, paragraph: prose.paragraph } : c)) }), { type: "card.updated", id, patch: { title: prose.title, paragraph: prose.paragraph } });
      }),
      needsModelExtraction(current.changeSet.intent, current.claims) ? extractClaimsWithModel(current.changeSet.intent!, { modelSpec: this.opts.config.model.write, ...modelOpts }) : undefined,
    ]);
    if (wrote.warning) this.warn(wrote.warning);
    if (extracted?.warning) this.warn(extracted.warning);
    if (extracted && extracted.claims.length > 0) {
      const claims = [...this.snapshot().claims, ...extracted.claims];
      this.store.update((r) => ({ ...r, claims }), { type: "claims.replaced", claims });
    }
    // The radius claim is judged against importers, so they must have landed first.
    await importers;
    await this.ground();
    await this.askQuestions();
  }

  /** Pick 2–4 questions per card once the evidence (unmentioned, tests touched) is known. */
  private async askQuestions(): Promise<void> {
    const pick = this.opts.pick ?? pickQuestions;
    const res = await pick(this.snapshot(), { modelSpec: this.opts.config.model.decide, env: this.opts.env });
    if (res.warning) this.warn(res.warning);
    for (const [id, questions] of res.questions) {
      if (questions.length === 0) continue;
      this.store.update((r) => ({ ...r, cards: r.cards.map((c) => (c.id === id ? { ...c, questions } : c)) }), { type: "card.updated", id, patch: { questions } });
    }
  }

  /** Ground the claims against the written cards, then point cards at their claims. */
  private async ground(): Promise<void> {
    const current = this.snapshot();
    if (current.claims.length === 0) return;
    const ground = this.opts.ground ?? groundClaims;
    const res = await ground(current.changeSet, current.cards, current.claims, { modelSpec: this.opts.config.model.decide, env: this.opts.env, radius: this.snapshot().radius });
    if (res.warning) this.warn(res.warning);
    const before = this.snapshot();
    const cards = applyClaims(before.cards, res.claims);
    this.store.update((r) => ({ ...r, claims: res.claims, cards }));
    for (const claim of res.claims) {
      const prev = before.claims.find((c) => c.id === claim.id);
      if (JSON.stringify(prev) !== JSON.stringify(claim)) this.store.emit({ type: "claim.updated", id: claim.id, patch: claimPatch(prev, claim) });
    }
    for (const event of cardPatches(before.cards, cards, before.untouched)) this.store.emit(event);
  }
}

function claimPatch(prev: Claim | undefined, next: Claim): Partial<Claim> {
  const patch: Partial<Claim> = {};
  for (const key of Object.keys(next) as (keyof Claim)[]) {
    if (JSON.stringify(prev?.[key]) !== JSON.stringify(next[key])) (patch as Record<string, unknown>)[key] = next[key];
  }
  return patch;
}

/** Events that turn `before` into `after`: per-card field patches when the card set is unchanged, else one replacement. */
export function cardPatches(before: Card[], after: Card[], untouched: string[]): ReviewEvent[] {
  const sameOrder = before.length === after.length && before.every((c, k) => c.id === after[k]!.id);
  if (!sameOrder) return [{ type: "cards.replaced", cards: after, untouched }];
  const events: ReviewEvent[] = [];
  for (const [k, next] of after.entries()) {
    const prev = before[k]!;
    const patch: Partial<Card> = {};
    for (const key of Object.keys(next) as (keyof Card)[]) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) (patch as Record<string, unknown>)[key] = next[key];
    }
    if (Object.keys(patch).length > 0) events.push({ type: "card.updated", id: next.id, patch });
  }
  return events;
}

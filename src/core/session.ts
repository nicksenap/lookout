import { buildCards, untouchedAreas } from "../cards/build.ts";
import { writeCards } from "../cards/write.ts";
import type { Config } from "../dispatch/config.ts";
import type { DispatchRunner } from "../dispatch/runner.ts";
import { classify, evaluate } from "../policy/evaluate.ts";
import { rankWithModel } from "../rank/rank.ts";
import { applyRules } from "../rank/rules.ts";
import { err, ok, type Result } from "./result.ts";
import { type ReviewEvent, ReviewStore } from "./store.ts";
import type { Card, ChangeSet, Review } from "./types.ts";

export type { ReviewEvent } from "./store.ts";
// Pure view helpers a UI needs; re-exported here so the TUI imports only this file and types.
export { cardDispatches, cardFindings } from "../cards/findings.ts";

export type ReviewCommand =
  | { type: "dispatchCard"; cardId: string; dispatcher?: string }
  /** Every red and amber card, one after another. */
  | { type: "dispatchAll"; dispatcher?: string }
  | { type: "cancel" }
  | { type: "answerQuestion"; cardId: string; questionId: string; answer: "yes" | "no" | "unsure" }
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
  /** Injection points for tests. */
  rank?: typeof rankWithModel;
  write?: (prompt: string) => Promise<string>;
  env?: Record<string, string | undefined>;
}

/** In-process implementation: rules first (synchronous), then the model raises cards and patches them in. */
export class LocalSession implements ReviewSession {
  readonly store: ReviewStore;
  private readonly runner?: DispatchRunner;
  private readonly finished: Promise<void>;

  constructor(private readonly opts: LocalSessionOptions) {
    const ruled = applyRules(opts.changeSet);
    this.store = new ReviewStore(this.assemble(ruled, "rules"));
    this.runner = opts.runner?.(this.store);
    this.finished = this.runModel(ruled);
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
        const runner = this.runner;
        if (!runner) return err("no dispatchers configured");
        const targets = this.snapshot().cards.filter((x) => x.color === "red" || x.color === "amber");
        if (targets.length === 0) return err("no red or amber cards to review");
        for (const card of targets) {
          const started = this.dispatch(card, c.dispatcher);
          if (!started.ok) return started;
          await runner.settled();
        }
        return ok(undefined);
      }
      case "cancel":
        return this.runner?.cancel() ? ok(undefined) : err("nothing to cancel");
      case "refresh":
        return err("refresh is not implemented yet");
      case "answerQuestion":
      case "setDepth":
        return err(`${c.type} arrives with plan step ${c.type === "setDepth" ? 14 : 13}`);
    }
  }

  /** Resolves when the current dispatch, if any, has finished. */
  settled = (): Promise<void> => this.runner?.settled() ?? Promise.resolve();

  private dispatch(card: Card, dispatcher?: string): Result<void> {
    const runner = this.runner;
    if (!runner) return err("no dispatchers configured");
    const name = dispatcher ?? this.opts.config.dispatchers[0]!.name;
    const started = runner.start(name, { kind: "card", card });
    return started.ok ? ok(undefined) : started;
  }

  private assemble(changeSet: ChangeSet, rankedBy: string, warning?: string): Review {
    const policy = this.opts.config.policy;
    const classification = classify(changeSet, policy);
    const review: Review = {
      changeSet,
      classification,
      verdict: evaluate(classification, policy),
      cards: buildCards(changeSet, policy),
      untouched: untouchedAreas(changeSet, policy),
      dispatches: this.store?.getSnapshot().dispatches ?? [],
      rankedBy,
    };
    if (warning) review.warning = warning;
    return review;
  }

  private async runModel(ruled: ChangeSet): Promise<void> {
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
    if (res.rankedBy !== "rules") {
      const write = this.opts.write ? { write: this.opts.write } : {};
      const wrote = await writeCards(after.changeSet, after.cards, { modelSpec: this.opts.config.model.write, env: this.opts.env, ...write }, (id, prose) => {
        this.store.update((r) => ({ ...r, cards: r.cards.map((c) => (c.id === id ? { ...c, title: prose.title, paragraph: prose.paragraph } : c)) }), { type: "card.updated", id, patch: { title: prose.title, paragraph: prose.paragraph } });
      });
      if (wrote.warning) {
        this.store.update((r) => ({ ...r, warning: r.warning ? `${r.warning} ${wrote.warning}` : wrote.warning }));
        this.store.emit({ type: "warning", text: wrote.warning });
      }
    }
    this.store.emit({ type: "done" });
  }
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

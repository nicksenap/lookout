import { err, ok, type Result } from "../src/core/result.ts";
import type { ReviewCommand, ReviewEvent, ReviewSession } from "../src/core/session.ts";
import type { Card, Dispatch, Exchange, Finding, Review } from "../src/core/types.ts";

export interface FixtureOptions {
  /** Simulate the pipeline: emit `done` after this many ms (0 = synchronously on first subscribe). */
  pendingMs?: number;
  /** When set, `dispatchCard` streams this fake output over `dispatchMs` and lands one finding. */
  dispatchMs?: number;
  dispatchable?: boolean;
  /** `ask` answers after this many ms (0 = next tick) with a canned sentence; `unverified` marks every answer so. */
  answerMs?: number;
  unverified?: boolean;
}

/**
 * A ReviewSession over a saved Review: the story runner and render tests drive the real App
 * against it without git, models or agents. Commands mutate the Review and emit the same
 * patch events LocalSession would.
 */
export class FixtureSession implements ReviewSession {
  private review: Review;
  private listeners = new Set<(e: ReviewEvent) => void>();
  private seq = 0;
  private doneEmitted = false;
  readonly timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    review: Review,
    private readonly opts: FixtureOptions = {},
  ) {
    this.review = structuredClone(review);
  }

  snapshot = (): Review => this.review;

  subscribe = (fn: (e: ReviewEvent) => void): (() => void) => {
    this.listeners.add(fn);
    if (!this.doneEmitted) {
      this.doneEmitted = true;
      const done = () => this.emit({ type: "done" });
      if (this.opts.pendingMs) this.timers.push(setTimeout(done, this.opts.pendingMs));
      else queueMicrotask(done);
    }
    return () => this.listeners.delete(fn);
  };

  ready = (): Promise<void> => new Promise((r) => this.timers.push(setTimeout(r, this.opts.pendingMs ?? 0)));

  async command(c: ReviewCommand): Promise<Result<void>> {
    switch (c.type) {
      case "ask": {
        if (c.text.trim() === "") return err("ask something");
        const exchange: Exchange = {
          id: `q${++this.seq}`,
          question: c.text.trim(),
          status: "pending",
          ...(c.cardId ? { cardId: c.cardId } : {}),
        };
        this.review = { ...this.review, exchanges: [...this.review.exchanges, exchange] };
        this.emit({ type: "exchange.added", exchange });
        const land = () => {
          const patch: Partial<Exchange> = {
            status: "answered",
            answer: `Fixture answer to "${exchange.question}": the diff changes retry(1) to retry(3).`,
            check: this.opts.unverified ? 0.4 : 0.95,
            ...(this.opts.unverified ? { unverified: true } : {}),
          };
          this.review = { ...this.review, exchanges: this.review.exchanges.map((e) => (e.id === exchange.id ? { ...e, ...patch } : e)) };
          this.emit({ type: "exchange.updated", id: exchange.id, patch });
        };
        this.timers.push(setTimeout(land, this.opts.answerMs ?? 0));
        return ok(undefined);
      }
      case "dispatchCard": {
        if (this.opts.dispatchable === false) return err("no dispatchers configured");
        const card = this.review.cards.find((x) => x.id === c.cardId);
        if (!card) return err(`no card ${c.cardId}`);
        if (this.review.dispatches.some((d) => d.status === "running")) return err("a dispatch is already running (x cancels it)");
        this.fakeDispatch(card);
        return ok(undefined);
      }
      case "dispatchAll":
        return err("not in the fixture");
      case "answerQuestion": {
        const card = this.review.cards.find((x) => x.id === c.cardId);
        if (!card) return err(`no card ${c.cardId}`);
        const questions = card.questions.map((q) => (q.id === c.questionId ? { ...q, answer: c.answer } : q));
        this.review = { ...this.review, cards: this.review.cards.map((x) => (x.id === card.id ? { ...x, questions } : x)) };
        this.emit({ type: "card.updated", id: card.id, patch: { questions } });
        return ok(undefined);
      }
      case "cancel": {
        const running = this.review.dispatches.find((d) => d.status === "running");
        if (!running) return err("nothing to cancel");
        this.finish(running.id, { status: "cancelled", error: "cancelled" });
        return ok(undefined);
      }
      default:
        return err(`${c.type} not in the fixture`);
    }
  }

  /** Show or clear pipeline progress, as the session does between phases. */
  setProgress(progress: Review["progress"]): void {
    const { progress: _, ...rest } = this.review;
    this.review = progress ? { ...rest, progress } : rest;
    this.emit({ type: "progress", ...(progress ? { progress } : {}) });
  }

  /** Write a paragraph onto a card, as the LLM step will. */
  setParagraph(cardId: string, paragraph: string): void {
    this.review = { ...this.review, cards: this.review.cards.map((x) => (x.id === cardId ? { ...x, paragraph } : x)) };
    this.emit({ type: "card.updated", id: cardId, patch: { paragraph } });
  }

  private emit(e: ReviewEvent): void {
    for (const l of this.listeners) l(e);
  }

  private fakeDispatch(card: Card): void {
    const id = `d${++this.seq}`;
    const dispatch: Dispatch = {
      id,
      dispatcher: "fixture",
      role: "proposer",
      scope: "card",
      cardId: card.id,
      cmd: "fixture-agent {prompt_file}",
      status: "running",
      output: "",
      findings: [],
    };
    this.review = { ...this.review, dispatches: [...this.review.dispatches, dispatch] };
    this.emit({ type: "dispatch.started", dispatch });
    const ms = this.opts.dispatchMs ?? 0;
    const chunks = ["Reading the diff…\n", "Tracing callers of the changed function…\n", "Checking the error path…\n"];
    chunks.forEach((chunk, k) => this.timers.push(setTimeout(() => this.append(id, chunk), (ms * (k + 1)) / 4)));
    this.timers.push(
      setTimeout(() => {
        const file = this.review.changeSet.files.find((f) => f.hunks.some((h) => h.blocks.some((b) => card.blockIds.includes(b.id))));
        const block = file?.hunks.flatMap((h) => h.blocks).find((b) => card.blockIds.includes(b.id) && b.newRange);
        const finding: Finding = {
          id: `${id}-f1`,
          severity: "p1",
          title: "error from the retried call is swallowed",
          body: "The final failure returns undefined instead of rethrowing, so callers see a success with no data.",
          dispatcher: "fixture",
          status: "proposed",
          preExisting: false,
        };
        if (file && block?.newRange) finding.anchor = { path: file.path, line: block.newRange.start };
        this.finish(id, { status: "done", findings: [finding] });
        this.fakeVerify(card, id, finding, ms);
      }, ms),
    );
  }

  /** The verifier pass that follows a proposer: confirms the one finding with a note. */
  private fakeVerify(card: Card, proposalId: string, finding: Finding, ms: number): void {
    const id = `d${++this.seq}`;
    const dispatch: Dispatch = {
      id,
      dispatcher: "fixture",
      role: "verifier",
      scope: "card",
      cardId: card.id,
      cmd: "fixture-agent {prompt_file}",
      status: "running",
      output: "",
      findings: [],
      verifies: [finding.id],
    };
    this.review = { ...this.review, dispatches: [...this.review.dispatches, dispatch] };
    this.emit({ type: "dispatch.started", dispatch });
    this.timers.push(setTimeout(() => this.append(id, "Tracing the retry loop…\n"), ms / 2));
    this.timers.push(
      setTimeout(() => {
        const note = "retry() returns the last caught error's `undefined` result on line +3; the two callers never check for it";
        this.finish(id, { status: "done", verdicts: [{ findingId: finding.id, verdict: "confirmed", note }] });
        const patch: Partial<Finding> = { status: "confirmed", verifiedBy: "fixture", verifierNote: note, confidence: 0.92 };
        this.review = {
          ...this.review,
          dispatches: this.review.dispatches.map((d) =>
            d.id === proposalId ? { ...d, findings: d.findings.map((f) => (f.id === finding.id ? { ...f, ...patch } : f)) } : d,
          ),
        };
        this.emit({ type: "finding.updated", dispatchId: proposalId, id: finding.id, patch });
      }, ms),
    );
  }

  private append(id: string, chunk: string): void {
    const d = this.review.dispatches.find((x) => x.id === id);
    if (d?.status !== "running") return;
    this.review = { ...this.review, dispatches: this.review.dispatches.map((x) => (x.id === id ? { ...x, output: x.output + chunk } : x)) };
    this.emit({ type: "dispatch.output", id, chunk });
  }

  private finish(id: string, patch: Partial<Dispatch>): void {
    this.review = { ...this.review, dispatches: this.review.dispatches.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
    this.emit({ type: "dispatch.finished", dispatch: this.review.dispatches.find((x) => x.id === id)! });
  }

  dispose(): void {
    this.timers.forEach(clearTimeout);
  }
}

export const loadReview = (name: string): Promise<Review> => Bun.file(`${import.meta.dir}/../fixtures/reviews/${name}.json`).json();

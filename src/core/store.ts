import type { Card, Claim, Classification, Dispatch, Door, Exchange, Finding, Progress, Radius, Review, Verdict } from "./types.ts";

/** Patches, not snapshots: a 40-card review streaming paragraphs never re-sends the whole Review. */
export type ReviewEvent =
  | { type: "cards.replaced"; cards: Card[]; untouched: string[] }
  | { type: "card.updated"; id: string; patch: Partial<Card> }
  | { type: "verdict.updated"; verdict: Verdict; classification: Classification }
  | { type: "dispatch.started"; dispatch: Dispatch }
  | { type: "dispatch.output"; id: string; chunk: string }
  | { type: "dispatch.finished"; dispatch: Dispatch }
  /** A finding's status changed: dedupe, a verifier's verdict, or the confidence gate. */
  | { type: "finding.updated"; dispatchId: string; id: string; patch: Partial<Finding> }
  | { type: "warning"; text?: string }
  /** The claim list changed (model extraction landed) or one claim was grounded. */
  | { type: "claims.replaced"; claims: Claim[] }
  | { type: "claim.updated"; id: string; patch: Partial<Claim> }
  | { type: "evidence.updated"; door?: Door; radius?: Radius }
  /** A reviewer asked; then the answer (or failure) landed. */
  | { type: "exchange.added"; exchange: Exchange }
  | { type: "exchange.updated"; id: string; patch: Partial<Exchange> }
  /** Pipeline progress for a bar; `undefined` clears it. */
  | { type: "progress"; progress?: Progress }
  /** The ranking pipeline has finished (with or without the model). */
  | { type: "done" };

type Listener = () => void;
type EventListener = (event: ReviewEvent) => void;

/**
 * Plain, UI-agnostic Review state. Snapshots are immutable: every change replaces
 * the Review object so `useSyncExternalStore` and `--json` see consistent state.
 */
export class ReviewStore {
  private review: Review;
  private listeners = new Set<Listener>();
  private eventListeners = new Set<EventListener>();

  constructor(review: Review) {
    this.review = review;
  }

  getSnapshot = (): Review => this.review;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private set(review: Review, event?: ReviewEvent): void {
    this.review = review;
    if (event) for (const l of this.eventListeners) l(event);
    for (const l of this.listeners) l();
  }

  update(fn: (review: Review) => Review, event?: ReviewEvent): void {
    this.set(fn(this.review), event);
  }

  emit(event: ReviewEvent): void {
    this.set(this.review, event);
  }

  startDispatch(dispatch: Dispatch): void {
    this.set({ ...this.review, dispatches: [...this.review.dispatches, dispatch] }, { type: "dispatch.started", dispatch });
  }

  appendOutput(id: string, chunk: string): void {
    this.set(this.patchDispatch(id, (d) => ({ ...d, output: d.output + chunk })), { type: "dispatch.output", id, chunk });
  }

  finishDispatch(id: string, patch: Partial<Dispatch>): void {
    const review = this.patchDispatch(id, (d) => ({ ...d, ...patch }));
    const dispatch = review.dispatches.find((d) => d.id === id)!;
    this.set(review, { type: "dispatch.finished", dispatch });
  }

  patchFinding(dispatchId: string, findingId: string, patch: Partial<Finding>): void {
    this.set(
      this.patchDispatch(dispatchId, (d) => ({ ...d, findings: d.findings.map((f) => (f.id === findingId ? { ...f, ...patch } : f)) })),
      { type: "finding.updated", dispatchId, id: findingId, patch },
    );
  }

  /** Attach parsed verdicts or notes to a finished dispatch; no event, `dispatch.finished` already fired. */
  updateDispatch(id: string, patch: Partial<Dispatch>): void {
    this.set(this.patchDispatch(id, (d) => ({ ...d, ...patch })));
  }

  private patchDispatch(id: string, fn: (d: Dispatch) => Dispatch): Review {
    return { ...this.review, dispatches: this.review.dispatches.map((d) => (d.id === id ? fn(d) : d)) };
  }
}

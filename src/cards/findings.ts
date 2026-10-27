import type { Card, Dispatch, Finding, Review } from "../core/types.ts";

/** Whether a finding's anchor lies on a new-side line of one of the card's blocks. */
function anchoredIn(review: Review, card: Card, finding: Finding): boolean {
  if (!finding.anchor) return false;
  const ids = new Set(card.blockIds);
  return review.changeSet.files.some(
    (f) => f.path === finding.anchor!.path && f.hunks.some((h) => h.blocks.some((b) => ids.has(b.id) && b.newRange !== undefined && finding.anchor!.line >= b.newRange.start && finding.anchor!.line <= b.newRange.end)),
  );
}

/** Findings that belong to a card: anchored in its blocks, or unanchored from a dispatch of this card. */
export function cardFindings(review: Review, card: Card): Finding[] {
  return review.dispatches.flatMap((d) => d.findings.filter((f) => anchoredIn(review, card, f) || (!f.anchor && d.cardId === card.id)));
}

/** Dispatches that targeted this card, newest first. */
export function cardDispatches(review: Review, card: Card): Dispatch[] {
  return review.dispatches.filter((d) => d.cardId === card.id).reverse();
}

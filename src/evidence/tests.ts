import type { Card, ChangeSet } from "../core/types.ts";

/** Test associations are decided by card grouping, before splitting; evidence only reads them. */
export function markTests(_changeSet: ChangeSet, cards: Card[]): Card[] {
  return cards.map((card) => {
    if (card.fixed) return { ...card, testsTouched: false };
    if (card.kind === "test" || card.blockKind === "test") return { ...card, testsTouched: false, covers: card.covers ?? [] };
    return card;
  });
}

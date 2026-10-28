// Rebuild the cards of every saved Review in fixtures/reviews/ from its change set with the current
// pipeline (kind guard + grouping). Paragraphs survive for cards whose id (block set) is unchanged;
// a card with a new block set loses its prose until a model run rewrites it. No network.
// Usage: bun scripts/refresh-fixtures.ts
import { Glob } from "bun";
import { buildCards } from "../src/cards/build.ts";
import type { Review } from "../src/core/types.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { guardKinds } from "../src/rank/mechanical.ts";

const dir = `${import.meta.dir}/../fixtures/reviews`;
for await (const f of new Glob("*.json").scan(dir)) {
  const review = (await Bun.file(`${dir}/${f}`).json()) as Review;
  const changeSet = guardKinds(review.changeSet);
  const previous = new Map(review.cards.map((c) => [c.id, c]));
  const rebuilt = buildCards(changeSet, DEFAULT_POLICY);
  // Evidence that pointed at an old card follows the new card holding most of its blocks.
  const overlap = (a: string[], b: string[]) => a.filter((id) => b.includes(id)).length;
  const successor = (oldId: string) =>
    rebuilt.reduce((best, c) =>
      overlap(c.blockIds, previous.get(oldId)!.blockIds) > overlap(best.blockIds, previous.get(oldId)!.blockIds) ? c : best,
    ).id;
  const cards = rebuilt.map((c) => {
    const exact = previous.get(c.id);
    const nearest = review.cards
      .filter((o) => !o.fixed)
      .sort((a, b) => overlap(b.blockIds, c.blockIds) - overlap(a.blockIds, c.blockIds))[0];
    const from = exact ?? nearest;
    const inherited = from ? { claimIds: from.claimIds, testsTouched: from.testsTouched, questions: from.questions } : {};
    const covers = from?.covers?.map(successor).filter((id) => !rebuilt.find((x) => x.id === id)!.kind.startsWith("test"));
    return {
      ...c,
      ...inherited,
      ...(covers?.length ? { covers: [...new Set(covers)] } : {}),
      ...(exact ? { title: exact.title, paragraph: exact.paragraph } : {}),
    };
  });
  const claims = review.claims.map((cl) => (cl.cardId && previous.has(cl.cardId) ? { ...cl, cardId: successor(cl.cardId) } : cl));
  const kept = cards.filter((c) => previous.has(c.id)).length;
  // Saved fixtures carry claims and questions, so they are evidence runs.
  await Bun.write(
    `${dir}/${f}`,
    `${JSON.stringify({ ...review, changeSet, cards, claims, evidence: true, exchanges: review.exchanges ?? [] }, null, 2)}\n`,
  );
  console.log(`${f}: ${review.cards.length} → ${cards.length} cards, ${kept} kept their prose`);
}

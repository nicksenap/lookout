import { allBlocks, blockLines } from "../core/blocks.ts";
import type { Card, ChangeSet } from "../core/types.ts";

const TEST_MARKERS = /(\.|_|-)?(test|tests|spec|specs)$|^test_|^tests?[-_]/i;
const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** `src/foo/bar.test.ts` → `bar`; `src/foo/index.ts` → `foo`; `test_bar.py` → `bar`. */
export function stemOf(path: string): string {
  const base = baseOf(path).replace(/\.[^.]+$/, "");
  const stem = base.replace(/\.(test|spec|stories|story|d)$/i, "").replace(TEST_MARKERS, "");
  if (/^(index|mod|__init__|main)$/i.test(stem)) return baseOf(dirOf(path)) || stem;
  return stem;
}

const isTestCard = (c: Card) => !c.fixed && (c.kind === "test" || c.blockKind === "test");

/**
 * Mark each non-test card as `testsTouched` when a test card in the same change exercises one
 * of its files: same directory, matching name stem, or an import of the file in the test's
 * edits. Test cards get `covers`, the cards they exercise. Deterministic; a test that already
 * imported the file and only adds a case is matched by stem or directory, not by import.
 */
export function markTests(changeSet: ChangeSet, cards: Card[]): Card[] {
  const refs = allBlocks(changeSet);
  const filesOf = (c: Card) => {
    const ids = new Set(c.blockIds);
    return [...new Set(refs.filter((r) => ids.has(r.block.id)).map((r) => r.block.path))];
  };
  const tests = cards.filter(isTestCard).map((card) => {
    const ids = new Set(card.blockIds);
    const added = refs
      .filter((r) => ids.has(r.block.id))
      .flatMap((r) => blockLines(r.hunk, r.block))
      .filter((l) => l.kind === "add")
      .map((l) => l.text)
      .join("\n");
    return { card, files: filesOf(card), added };
  });
  const code = cards.filter((c) => !c.fixed && !isTestCard(c)).map((card) => ({ card, files: filesOf(card) }));

  const exercises = (t: (typeof tests)[number], file: string): boolean => {
    const stem = stemOf(file);
    return (
      t.files.some((tf) => tf !== file && (dirOf(tf) === dirOf(file) || stemOf(tf) === stem)) ||
      new RegExp(`(?:^|[/'"\`])${escapeRegExp(stem)}(?:\\.[a-z]+)?['"\`]`, "m").test(t.added)
    );
  };
  const covers = new Map(tests.map((t) => [t.card.id, code.filter((c) => c.files.some((f) => exercises(t, f))).map((c) => c.card.id)]));

  return cards.map((card) => {
    if (card.fixed) return { ...card, testsTouched: false };
    if (isTestCard(card)) return { ...card, testsTouched: false, covers: covers.get(card.id) ?? [] };
    return { ...card, testsTouched: [...covers.values()].some((ids) => ids.includes(card.id)) };
  });
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

import { allBlocks, blockLines } from "../core/blocks.ts";
import type { Card, ChangeSet } from "../core/types.ts";
import { changedIdentifiers, identifiers } from "./group.ts";

/** Mechanical body coverage, independent of the evidence layer's grounded claims. */
export function markMentions(changeSet: ChangeSet, cards: Card[]): Card[] {
  const body = changeSet.intent?.body ?? "";
  if (!body.trim()) return cards.map((card) => ({ ...card, mentioned: true }));
  const tokens = body.split(/\s+/).map((token) => token.replace(/^[`(]+|[`).,;:!?]+$/g, ""));
  const paths = new Set(
    changeSet.files
      .filter((file) => tokens.some((token) => token.includes("/") && (file.path === token || file.path.endsWith(`/${token}`))))
      .map((file) => file.path),
  );
  const names = new Set(
    [...body.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g)].flatMap((match) =>
      [...identifiers(match[1] ?? match[2]!)].map(normalizeIdentifier),
    ),
  );
  const byBlock = new Map(
    allBlocks(changeSet).map((ref) => {
      const changed = changedIdentifiers(ref);
      // A punctuation-only doc edit has no changed names; its added line's generic words would match unrelated bodies.
      const docs =
        changed.size === 0
          ? changed
          : new Set([
              ...changed,
              ...identifiers(
                blockLines(ref.hunk, ref.block)
                  .filter((line) => line.kind === "add")
                  .map((line) => line.text)
                  .join("\n"),
              ),
            ]);
      return [ref.block.id, { changed, docs }];
    }),
  );
  return cards.map((card) => ({
    ...card,
    mentioned:
      card.fixed === "clean" ||
      card.mechanical === true ||
      card.kind === "test" ||
      card.blockKind === "test" ||
      card.files.some((path) => paths.has(path)) ||
      card.blockIds.some((id) =>
        [...((card.kind === "docs" || card.blockKind === "docs" ? byBlock.get(id)?.docs : byBlock.get(id)?.changed) ?? [])].some((name) =>
          names.has(normalizeIdentifier(name)),
        ),
      ),
  }));
}

const normalizeIdentifier = (name: string): string => name.replace(/_/g, "").toLowerCase();

import type { Radius } from "../core/types.ts";

/**
 * Blast radius is the policy areas the change touches plus the author's one-word description.
 * Importers of changed files were computed here once, by file stem; in a monorepo where every
 * package has its own `query-keys.ts` that listed 32–235 false importers per PR and flipped a
 * true author claim to contradicted, so the list is gone until a real import resolver exists.
 */
export function initialRadius(areas: string[], author: string | undefined): Radius {
  const radius: Radius = { areas };
  if (author) radius.author = author;
  return radius;
}

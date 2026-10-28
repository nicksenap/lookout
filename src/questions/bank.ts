import type { Card, Review, Tier } from "../core/types.ts";

/**
 * One yes/no prompt for the human. `tiers` is where it is worth asking at all; `applies` is the
 * rule filter per card. Decisions (or, without a model, bank order) picks 2–4 of the survivors.
 */
export interface BankQuestion {
  id: string;
  text: string;
  tiers: Tier[];
  applies: (card: Card, review: Review) => boolean;
}

const behaviour = (card: Card) =>
  !card.mechanical && (card.blockKind ? card.blockKind === "behavior" : card.kind === "logic" || card.kind === "additive");
const notMechanical = (card: Card) => !card.mechanical && card.kind !== "docs" && card.blockKind !== "docs";
const isTest = (card: Card) => card.kind === "test" || card.blockKind === "test";
const config = (card: Card) => card.kind === "config" || card.kind === "deps" || card.kind === "ci" || card.blockKind === "config";

/** Start: 12 questions (PLAN "defaults to revisit with data"). Order is the fallback priority. */
export const BANK: readonly BankQuestion[] = [
  {
    id: "intent",
    text: "Does this change do what the PR says, and nothing the PR leaves out?",
    tiers: ["low", "medium", "high"],
    applies: (c) => notMechanical(c) && !isTest(c),
  },
  {
    id: "error-path",
    text: "Is the failure path of the new logic handled and tested?",
    tiers: ["medium", "high"],
    applies: (c) => behaviour(c) && !c.testsTouched,
  },
  {
    id: "tests-claim",
    text: "Do the tests exercise the behaviour the card describes, not just the happy path?",
    tiers: ["low", "medium", "high"],
    applies: (c) => isTest(c),
  },
  {
    id: "rollback",
    text: "Could this be reverted cleanly if it misbehaves in production?",
    tiers: ["medium", "high"],
    applies: (c) => behaviour(c) || (c.doorSignals?.length ?? 0) > 0,
  },
  {
    id: "sensitive",
    text: "Is the sensitive-area code still correct for every caller, not just the one the PR had in mind?",
    tiers: ["medium", "high"],
    applies: (c) => c.areas.length > 0 && notMechanical(c),
  },
  {
    id: "pattern",
    text: "Does this set a pattern others will copy, and is it the pattern you want?",
    tiers: ["medium", "high"],
    applies: (c) => behaviour(c) && c.blockIds.length >= 3,
  },
  {
    id: "unmentioned",
    text: "Should this change have been in the PR description, or should it be a separate PR?",
    tiers: ["low", "medium", "high"],
    applies: (c) => c.unmentioned,
  },
  {
    id: "coverage",
    text: "Is the untested path here one you are comfortable shipping without a test?",
    tiers: ["medium", "high"],
    applies: (c) => behaviour(c) && !c.testsTouched && !isTest(c),
  },
  {
    id: "one-way",
    text: "Is the one-way signal here (migration, destructive write, removed contract) deliberate and announced?",
    tiers: ["medium", "high"],
    applies: (c) => (c.doorSignals?.length ?? 0) > 0,
  },
  {
    id: "config-blast",
    text: "Which environments does this configuration change reach, and is each of them intended?",
    tiers: ["medium", "high"],
    applies: (c) => config(c),
  },
  {
    id: "rename-complete",
    text: "Is the rename or move complete: no stale references in docs, config or other repos?",
    tiers: ["low", "medium", "high"],
    applies: (c) => c.mechanical === true,
  },
  {
    id: "security",
    text: "Could any new input reach this code unvalidated (user data, headers, env, files)?",
    tiers: ["high"],
    applies: (c) => behaviour(c),
  },
];

/** Bank questions the rules allow for this card at this tier, in bank order. */
export function candidatesFor(card: Card, review: Review): BankQuestion[] {
  if (card.fixed) return [];
  return BANK.filter((q) => q.tiers.includes(review.verdict.tier) && q.applies(card, review));
}

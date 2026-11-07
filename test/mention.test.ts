import { expect, test } from "bun:test";
import { buildCards } from "../src/cards/build.ts";
import { markMentions } from "../src/cards/mention.ts";
import { parseDiff } from "../src/core/diff.ts";
import type { ChangeSet } from "../src/core/types.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { applyRules } from "../src/rank/rules.ts";

const changeSet = (body?: string): ChangeSet =>
  applyRules({
    target: "body mentions",
    base: "a",
    head: "b",
    ...(body === undefined ? {} : { intent: { title: "Body mentions", body } }),
    files: parseDiff(
      `${[
        "diff --git a/src/cards/build.ts b/src/cards/build.ts",
        "--- a/src/cards/build.ts",
        "+++ b/src/cards/build.ts",
        "@@ -1 +1 @@",
        "-export const oldCards = assemble();",
        "+export const newCards = assemble();",
        "diff --git a/src/dispatch/build.ts b/src/dispatch/build.ts",
        "--- a/src/dispatch/build.ts",
        "+++ b/src/dispatch/build.ts",
        "@@ -1 +1 @@",
        "-export const oldRunner = dispatch();",
        "+export const newRunner = dispatch();",
      ].join("\n")}\n`,
    ),
  });

test("paths match whole suffixes after stripping backticks, parentheses and trailing punctuation", () => {
  const cs = changeSet("Changed (`cards/build.ts`), but not other/build.ts or ispatch/build.ts.");
  const cards = markMentions(cs, buildCards(cs, DEFAULT_POLICY));
  expect(cards.map((c) => [c.files[0], c.mentioned])).toEqual([
    ["src/cards/build.ts", true],
    ["src/dispatch/build.ts", false],
  ]);
});

test("backticked changed identifiers match, but plain prose and unchanged identifiers do not", () => {
  const cs = changeSet("Uses `newCards`; newRunner and `dispatch` are not changed identifier mentions.");
  expect(markMentions(cs, buildCards(cs, DEFAULT_POLICY)).map((c) => c.mentioned)).toEqual([true, false]);
});

test("identifiers in fenced diff sketches and dotted code references count as mentions", () => {
  const cs = changeSet("```diff\n+ newCards\n```\n`module.newRunner`");
  expect(markMentions(cs, buildCards(cs, DEFAULT_POLICY)).map((c) => c.mentioned)).toEqual([true, true]);
});

test("camelCase and snake_case references match the same changed identifier", () => {
  const cs = changeSet("Renamed to `new_cards` and `new_runner`.");
  expect(markMentions(cs, buildCards(cs, DEFAULT_POLICY)).map((c) => c.mentioned)).toEqual([true, true]);
});

test.each([undefined, "", "  \n\t"])("absent or empty body %j leaves every card mentioned", (body) => {
  const cs = changeSet(body);
  expect(markMentions(cs, buildCards(cs, DEFAULT_POLICY)).map((c) => c.mentioned)).toEqual([true, true]);
});

test("mechanical, tests and the clean card are exempt, but docs require body mentions", () => {
  const cs = changeSet("Unrelated prose.");
  const card = buildCards(cs, DEFAULT_POLICY)[0]!;
  const cards = [
    { ...card, mechanical: true },
    { ...card, kind: "docs" as const },
    { ...card, blockKind: "docs" as const },
    { ...card, kind: "test" as const },
    { ...card, blockKind: "test" as const },
    { ...card, fixed: "clean" as const },
    card,
  ];
  expect(markMentions(cs, cards).map((c) => c.mentioned)).toEqual([true, false, false, true, true, true, false]);
});

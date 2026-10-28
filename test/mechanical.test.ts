import { describe, expect, test } from "bun:test";
import { allBlocks, mapBlocks } from "../src/core/blocks.ts";
import { parseDiff } from "../src/core/diff.ts";
import type { BlockKind, ChangeSet } from "../src/core/types.ts";
import { guardKinds, stripTypes } from "../src/rank/mechanical.ts";
import { applyRules } from "../src/rank/rules.ts";

const diff = (path: string, body: string[]) => {
  const olds = body.filter((l) => !l.startsWith("+")).length;
  const news = body.filter((l) => !l.startsWith("-")).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${olds} +1,${news} @@`, ...body].join("\n") + "\n";
};
const cs = (text: string, kinds: BlockKind[]): ChangeSet => {
  let k = 0;
  return mapBlocks(applyRules({ target: "t", base: "", head: "", files: parseDiff(text) }), ({ block }) => ({ ...block, kind: kinds[k++]! }));
};
const kinds = (c: ChangeSet) => allBlocks(c).map((r) => [r.block.kind, r.block.suggestedKind]);

describe("guardKinds: rules confirm the model's mechanical labels", () => {
  test("a consistent identifier substitution stays a rename; a reordered key shape does not", () => {
    const pure = cs(diff("a.ts", [" x", "-  queryKey: dependencies(ws, id),", "+  queryKey: dependenciesByField(ws, id),", " y"]), ["rename"]);
    expect(kinds(guardKinds(pure))).toEqual([["rename", undefined]]);
    const reordered = cs(diff("a.ts", [" x", "-  key: [...ws, id, 'dependencies'],", "+  key: [...ws, 'dependencies', id],", " y"]), ["rename"]);
    expect(kinds(guardKinds(reordered))).toEqual([["behavior", "rename"]]);
    const literal = cs(diff("a.ts", [" x", "-  retries(3);", "+  retries(5);", " y"]), ["rename"]);
    expect(kinds(guardKinds(literal))).toEqual([["behavior", "rename"]]);
  });

  test("a rename onto a name whose body this change edits is behaviour; onto a renamed declaration it is not", () => {
    const newTree =
      diff("keys.ts", [" export const fieldsQueryKeys = {", "-  all: ['fields'],", "+  all: ['workspace', 'fields'],", " };"]) +
      diff("use.ts", [" x", "-  key: fieldKeys.all,", "+  key: fieldsQueryKeys.all,", " y"]);
    expect(kinds(guardKinds(cs(newTree, ["behavior", "rename"])))).toEqual([["behavior", undefined], ["behavior", "rename"]]);
    const renamedDecl = diff("keys.ts", [" x", "-export const fieldKeys = {", "+export const fieldsQueryKeys = {", " y"]) + diff("use.ts", [" x", "-  key: fieldKeys.all,", "+  key: fieldsQueryKeys.all,", " y"]);
    expect(kinds(guardKinds(cs(renamedDecl, ["rename", "rename"])))).toEqual([["rename", undefined], ["rename", undefined]]);
  });

  test("typing refactor: annotations only; narrowing, a new return type or a new constant are behaviour", () => {
    const annotate = cs(diff("a.ts", [" x", "-export function f(h, score) {", "+export function f<T extends Pick<Block, 'score'>>(h: T, score: number): T {", " y"]), ["typing-refactor"]);
    expect(kinds(guardKinds(annotate))).toEqual([["typing-refactor", undefined]]);
    const narrowed = cs(diff("a.ts", [" x", "-  accountId: string | undefined,", "+  accountId: string,", " y"]), ["typing-refactor"]);
    expect(kinds(guardKinds(narrowed))).toEqual([["behavior", "typing-refactor"]]);
    const returns = cs(diff("a.ts", [" x", "-async function load(): Promise<ChangeSet> {", "+async function load(): Promise<Result<ChangeSet>> {", " y"]), ["typing-refactor"]);
    expect(kinds(guardKinds(returns))).toEqual([["behavior", "typing-refactor"]]);
    const constant = cs(diff("a.py", [" x", "+_STALE_MOVE_AFTER = timedelta(minutes=5)", " y"]), ["typing-refactor"]);
    expect(kinds(guardKinds(constant))).toEqual([["behavior", "typing-refactor"]]);
    const iface = cs(diff("a.ts", [" x", "+export interface Args {", "+  ids: string[];", "+  limit?: number;", "+}", " y"]), ["typing-refactor"]);
    expect(kinds(guardKinds(iface))).toEqual([["typing-refactor", undefined]]);
  });

  test("a reflowed import list is mechanical whatever the label; a move must reappear verbatim", () => {
    const reflow = cs(diff("a.py", [" x", "-from acp.store import A, B", "+from acp.store import (", "+    A,", "+    B,", "+    C,", "+)", " y"]), ["typing-refactor"]);
    expect(kinds(guardKinds(reflow))).toEqual([["typing-refactor", undefined]]);
    const moved = diff("a.ts", [" x", "-const limit = 200;", " y"]) + diff("b.ts", [" x", "+const limit = 200;", " y"]);
    expect(kinds(guardKinds(cs(moved, ["move", "move"])))).toEqual([["move", undefined], ["move", undefined]]);
    const notMoved = diff("a.ts", [" x", "-const limit = 200;", " y"]) + diff("b.ts", [" x", "+const limit = 300;", " y"]);
    expect(kinds(guardKinds(cs(notMoved, ["move", "move"])))).toEqual([["behavior", "move"], ["behavior", "move"]]);
  });

  test("stripTypes leaves the runtime statement", () => {
    expect(stripTypes("const x: Record<string, number> = f(a as Foo, b!)")).toBe("const x = f(a, b)");
    expect(stripTypes("import type { A } from './a'")).toBe("import { A } from './a'");
    expect(stripTypes("def run(self, task_id: str, *, expected: str | None = None) -> bool:")).toBe("def run(self, task_id, *, expected = None) :");
  });
});

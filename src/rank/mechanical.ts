import { blockLines, mapBlocks } from "../core/blocks.ts";
import type { BlockKind, ChangeSet, DiffLine, EditBlock, Hunk } from "../core/types.ts";

/**
 * Rules confirm the model's non-behaviour kinds. The model may call an edit a `rename`, a
 * `typing-refactor`, a `move`, `docs` or `types`; it keeps that kind only when the text proves it, otherwise
 * the edit is `behavior` and the model's label survives as `suggestedKind`. Measured on three
 * production PRs where every "behaviour is unchanged" card hid a value change: a cache-key
 * shape swap labelled rename, a 5-minute timeout constant labelled typing refactor.
 */
export interface Elsewhere {
  added: Set<string>;
  removed: Set<string>;
  /**
   * Names declared in a hunk that also changes behaviour: new declarations, and existing
   * ones whose body this change edits (the declaring line is context or the hunk header).
   */
  touchedDecls: Set<string>;
  /**
   * Names whose declaration is itself a pure rename (`-const foo = {` / `+const bar = {`).
   * A rename to any other touched name binds callers to code this change edits, which is
   * behaviour: `fieldKeys.x(id)` → `fieldsQueryKeys.x(id)` where `fieldsQueryKeys` gets a new tree.
   */
  renamedDecls?: Set<string>;
}

export function confirmMechanical(hunk: Hunk, block: EditBlock, kind: BlockKind, elsewhere: Elsewhere): boolean {
  const lines = blockLines(hunk, block).filter((l) => l.text.trim() !== "");
  const del = lines.filter((l) => l.kind === "del").map((l) => l.text);
  const add = lines.filter((l) => l.kind === "add").map((l) => l.text);
  // Imports and comments cannot change what runs; a reviewer accepts them as mechanical however the model labelled them.
  if (block.labels.includes("comment-only") || [...del, ...add].every(isImport)) return true;
  // Lines are compared as one text so a reflowed signature or import list still matches.
  const oldText = del.join("\n");
  const newText = add.join("\n");
  switch (kind) {
    case "rename": {
      const map = new Map<string, string>();
      if (del.length === 0 || add.length === 0 || !sameTokensModuloIdentifiers(oldText, newText, map)) return false;
      return [...map.values()].every((n) => !elsewhere.touchedDecls.has(n) || elsewhere.renamedDecls?.has(n));
    }
    case "typing-refactor":
      if (del.length === 0 || add.length === 0) return typeOnly(del.length ? del : add);
      // Narrowing a type (`string | undefined` → `string`, `x?:` → `x:`) or declaring another return type changes the contract callers meet.
      return (
        squash(stripTypes(oldText)) === squash(stripTypes(newText)) && !narrows(oldText, newText) && !returnTypeChanged(oldText, newText)
      );
    case "move":
      return (
        (del.length > 0 && del.every((d) => elsewhere.added.has(squash(d)))) ||
        (add.length > 0 && add.every((a) => elsewhere.removed.has(squash(a))))
      );
    // A contiguous run that deletes a member and adds a doc comment above its replacement is one block;
    // the model sees mostly prose and says `docs`. Only all-comment edits (or documentation files) are docs,
    // and only type-only edits are `types`; anything else is behaviour, so the deletion lands on a real card.
    case "docs":
      return (
        /\.(md|mdx|rst|txt|adoc)$/i.test(block.path) ||
        [...del, ...add].every((l) => /^\s*(\/\/|\/\*|\*|#|"""|\x27\x27\x27|<!--)/.test(l) || /^\s*\*\/\s*$/.test(l))
      );
    case "types":
      return (
        typeOnly([...del, ...add]) ||
        [...del, ...add].every(
          (l) =>
            isImport(l) ||
            /^\s*(export\s+)?(type|interface)\b/.test(l) ||
            /^\s*(readonly\s+)?[A-Za-z_$][\w$]*\??:\s*[^=()]+[;,]?\s*$/.test(l) ||
            /^\s*[}\]|,;]*\s*$/.test(l),
        )
      );
    default:
      return true;
  }
}

export const isImport = (line: string) =>
  /^\s*(import\b|from\s+\S+\s+import\b|export\s+(type\s+)?\{[^}]*\}\s*from\b|\}\s*from\s+['"]|[A-Za-z_$][\w$]*,?\s*$|\)\s*$|\{\s*$)/.test(
    line,
  );

/** Apply the guard to every block of a ranked change set: unconfirmed mechanical kinds become `behavior`. */
export function guardKinds(changeSet: ChangeSet): ChangeSet {
  const hunks = changeSet.files.flatMap((f) => f.hunks);
  const elsewhere = lineSets(hunks);
  // Pass 1: declarations that are themselves pure renames; pass 2 lets callers follow those names.
  const renamedDecls = new Set(
    hunks.flatMap((hunk) =>
      hunk.blocks
        .filter((b) => b.kind === "rename" && confirmMechanical(hunk, b, "rename", elsewhere))
        .flatMap((b) =>
          declarations(
            blockLines(hunk, b)
              .filter((l) => l.kind === "add")
              .map((l) => l.text),
          ),
        ),
    ),
  );
  elsewhere.renamedDecls = renamedDecls;
  return mapBlocks(changeSet, ({ hunk, block }) => {
    if (block.kind === undefined || confirmMechanical(hunk, block, block.kind, elsewhere)) return block;
    return { ...block, kind: "behavior", suggestedKind: block.kind };
  });
}

/** Added and removed line texts across a whole change, for the `move` check. */
export function lineSets(hunks: Hunk[]): Elsewhere {
  const texts = (kind: DiffLine["kind"]) =>
    hunks.flatMap((h) => h.lines.filter((l) => l.kind === kind && l.text.trim() !== "").map((l) => l.text));
  const behavioural = hunks.filter((h) =>
    h.blocks.some((b) => b.kind !== undefined && !["rename", "typing-refactor", "move", "docs", "test"].includes(b.kind)),
  );
  const touched = behavioural.flatMap((h) => [
    h.header.replace(/^@@[^@]*@@\s*/, ""),
    ...h.lines.filter((l) => l.kind !== "del").map((l) => l.text),
  ]);
  return {
    added: new Set(texts("add").map(squash)),
    removed: new Set(texts("del").map(squash)),
    touchedDecls: new Set(declarations(touched)),
  };
}

const DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|def|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
/** An object or class member that is a function: `dependenciesByField: (ws, id) =>`, `async run(` */
const MEMBER =
  /^\s*(?:readonly\s+|static\s+|async\s+|public\s+|private\s+)*([A-Za-z_$][\w$]*)\s*(?::\s*(?:async\s+)?\(|\(|=\s*(?:async\s+)?\()/;
const declarations = (lines: string[]) =>
  lines.map((l) => DECLARATION.exec(l)?.[1] ?? MEMBER.exec(l)?.[1]).filter((n): n is string => n !== undefined && !KEYWORDS.has(n));
const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "return",
  "await",
  "catch",
  "function",
  "const",
  "let",
  "var",
  "new",
  "typeof",
  "else",
  "do",
  "try",
  "import",
  "export",
  "default",
  "case",
  "throw",
  "yield",
  "delete",
  "void",
  "with",
  "elif",
  "def",
  "print",
  "assert",
  "raise",
]);

// A function that declares a different return type returns something different; the body change sits elsewhere.
const RETURN_TYPE = /\)\s*(?::|->)\s*([^={;]+?)(?=\s*(?:=>|\{|;|:|$))/m;
const returnTypeChanged = (oldLine: string, newLine: string) => {
  const a = RETURN_TYPE.exec(oldLine)?.[1];
  const b = RETURN_TYPE.exec(newLine)?.[1];
  return a !== undefined && b !== undefined && squash(a) !== squash(b);
};

const LOOSE = /\?\s*:|\?\s*[,)]|\|\s*undefined\b|\|\s*null\b|\bOptional\[|\|\s*None\b/g;
const narrows = (oldLine: string, newLine: string) => (oldLine.match(LOOSE)?.length ?? 0) > (newLine.match(LOOSE)?.length ?? 0);

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

const TOKEN = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|=>|[^\sA-Za-z_$\d]/g;
const isIdentifier = (t: string) => /^[A-Za-z_$]/.test(t);

/**
 * Two lines are the same statement modulo a consistent, one-to-one identifier substitution:
 * every other token (punctuation, literals, keywords in effect) matches in order. The
 * mapping accumulates across lines so `a → b` on one line and `a → c` on the next fail.
 */
function sameTokensModuloIdentifiers(oldLine: string, newLine: string, map: Map<string, string>): boolean {
  const a = oldLine.match(TOKEN) ?? [];
  const b = newLine.match(TOKEN) ?? [];
  if (a.length !== b.length) return false;
  const reverse = new Map([...map].map(([k, v]) => [v, k]));
  return a.every((t, k) => {
    const u = b[k]!;
    if (t === u) return true;
    if (!isIdentifier(t) || !isIdentifier(u)) return false;
    const seen = map.get(t);
    if (seen !== undefined) return seen === u;
    if (reverse.has(u)) return false;
    map.set(t, u);
    reverse.set(u, t);
    return true;
  });
}

/** Remove what TypeScript (and Python annotations) add on top of the runtime statement. */
export function stripTypes(line: string): string {
  return line
    .replace(/\bimport\s+type\b/g, "import")
    .replace(/\bexport\s+type\s*\{/g, "export {")
    .replace(/\b(?:readonly|public|private|protected|override|declare|abstract)\s+/g, "")
    .replace(/\bas\s+const\b/g, "")
    .replace(/\s+(?:as|satisfies)\s+[A-Za-z_$][\w$.]*(?:<[^<>]*>)?(?:\[\])*/g, "")
    .replace(/<[^<>()=]*(?:<[^<>]*>[^<>()=]*)*>(?=\s*[(\s=,;:)\]}>]|$)/g, "")
    .replace(/\)\s*:\s*[^={;]+?(?=\s*(?:=>|\{|;|$))/g, ")")
    .replace(/->\s*[^:]+(?=:)/g, "")
    .replace(/([A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*(?![:/])[^=,;)]+?(?=\s*(?:[=,;)]|$))/g, "$1")
    .replace(/([A-Za-z_$][\w$]*)!/g, "$1")
    .replace(/\?(?=[.[(])/g, "");
}

/** A block that only adds or only removes passes as typing when it is a type declaration or type imports. */
function typeOnly(lines: string[]): boolean {
  const first = lines[0]!.trim();
  if (lines.every((l) => /^\s*import\s+type\b/.test(l))) return true;
  return (
    /^(export\s+)?(declare\s+)?(type|interface)\b/.test(first) &&
    lines.slice(1).every((l) => !/\b(return|await|throw|console|new\s+\w+\s*\(|=\s*[^=>])/.test(l))
  );
}

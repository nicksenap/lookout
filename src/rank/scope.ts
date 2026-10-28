import type { ChangeSet, EditBlock, FileChange } from "../core/types.ts";
import { attemptAsync, ok, type Result } from "../core/result.ts";
import { run } from "../sources/exec.ts";

/**
 * The declarations and object keys that enclose a block's first changed line, outermost first:
 * `DEPLOYMENTS › stage › servedTools › "web"`. The hunk header names only the
 * outermost one, and a diff cannot show the key three lines above the hunk, yet that key is
 * usually the fact a reviewer needs ("which environment is this?"). Rules only: a line opens a
 * scope when it ends with `{`, `[` or `(` (or `:` in Python) and is less indented than the
 * target; its name is the identifier or string key before the opener.
 */
export function enclosingPath(source: string, line: number): string[] {
  const lines = source.split("\n");
  const at = lines[line - 1];
  if (at === undefined) return [];
  const indentOf = (s: string) => s.match(/^[ \t]*/)![0].replace(/\t/g, "    ").length;
  let indent = indentOf(at);
  const path: string[] = [];
  for (let k = line - 2; k >= 0 && indent > 0; k--) {
    const text = lines[k]!;
    if (text.trim() === "") continue;
    const i = indentOf(text);
    if (i >= indent) continue;
    indent = i;
    // A multi-line signature (`export const X: Partial<` … `> = {`, `function f(` … `) {`) puts the opener
    // lines below its name: walk up through same-indent lines until one names the scope.
    let name = scopeName(text);
    for (let j = k - 1; name === undefined && j >= 0 && OPENER.test(text) && !isClosedStatement(lines[j]!) && indentOf(lines[j]!) >= i; j--) {
      name = indentOf(lines[j]!) === i ? scopeName(lines[j]!, true) : undefined;
    }
    if (name) path.unshift(name);
  }
  return path;
}

/** A line that ends a statement, so a signature cannot continue above it. */
const isClosedStatement = (text: string) => /[;}]\s*$/.test(text) || text.trim() === "" || /^\s*(\/\/|\*|\/\*|#)/.test(text);

const OPENER = /[{[(]\s*(?:\/\/.*|#.*)?$|:\s*(?:#.*)?$/;

function scopeName(text: string, partOfSignature = false): string | undefined {
  if (!partOfSignature && !OPENER.test(text)) return undefined;
  const t = text.trim();
  const def = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|def|type|interface|enum|describe|test|it)\s*\(?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))/.exec(t);
  if (def) return def[1] ?? def[2] ?? def[3];
  const key = /^(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z_$][\w$.]*))\s*(?:\??:|=)/.exec(t);
  if (key) return key[1] ?? key[2] ?? key[3] ?? key[4];
  const call = /^(?:return\s+)?([A-Za-z_$][\w$.]*)\s*\(/.exec(t);
  if (call && !/^(if|for|while|switch|with|catch|elif)$/.test(call[1]!)) return call[1];
  return undefined;
}

/** Read `path` at the change's head: a local commit, the working tree, or a PR head through `gh`. */
export async function readAtHead(changeSet: ChangeSet, file: FileChange, repo: string | undefined): Promise<Result<string>> {
  if (changeSet.head === "worktree") {
    const text = await attemptAsync(() => Bun.file(`${repo ?? process.cwd()}/${file.path}`).text());
    return text.ok ? ok(text.value) : text;
  }
  const local = repo ? await run(["git", "show", `${changeSet.head}:${file.path}`], repo) : undefined;
  if (local?.ok) return local;
  const m = /^([\w.-]+)\/([\w.-]+)#\d+$/.exec(changeSet.target) ?? /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\//.exec(changeSet.target);
  if (!m) return local ?? ok("");
  // The PR head may not be in any local checkout; gh fetches the blob read-only.
  const res = await run(["gh", "api", `repos/${m[1]}/${m[2]}/contents/${file.path}?ref=${changeSet.head}`, "-H", "Accept: application/vnd.github.raw+json"]);
  return res.ok ? res : local ?? res;
}

/**
 * Attach `scope` to every live block whose file can be read at head. One read per file; a file
 * that cannot be read leaves its blocks without a scope rather than failing the review.
 */
export async function attachScopes(changeSet: ChangeSet, repo: string | undefined): Promise<ChangeSet> {
  const files = await Promise.all(
    changeSet.files.map(async (file) => {
      const live = file.hunks.some((h) => h.blocks.some((b) => b.attention !== "inert" && b.newRange));
      if (!live || file.status === "deleted" || file.binary) return file;
      const text = await readAtHead(changeSet, file, repo);
      if (!text.ok || text.value === "") return file;
      return {
        ...file,
        hunks: file.hunks.map((h) => ({
          ...h,
          blocks: h.blocks.map((b): EditBlock => {
            if (!b.newRange || b.attention === "inert") return b;
            const scope = enclosingPath(text.value, b.newRange.start);
            return scope.length ? { ...b, scope } : b;
          }),
        })),
      };
    }),
  );
  return { ...changeSet, files };
}

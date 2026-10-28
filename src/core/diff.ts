import { splitHunk } from "./blocks.ts";
import type { DiffLine, FileChange } from "./types.ts";

/** Unquote a git C-style quoted path ("a/\303\251 x") or return it unchanged. */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      for (const b of new TextEncoder().encode(ch)) bytes.push(b);
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(path: string): string {
  const p = unquoteGitPath(path.replace(/\t.*$/, ""));
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

/** Split the `diff --git a/X b/Y` remainder into old/new paths. */
function parseDiffGitPaths(rest: string): [string, string] {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+(.+)$/.exec(rest);
    if (m) return [stripPrefix(m[1]!), stripPrefix(m[2]!)];
  }
  // Symmetric case "a/P b/P" — exact split even when P contains " b/".
  const n = (rest.length - 5) / 2;
  if (Number.isInteger(n) && rest.startsWith("a/") && rest.slice(n + 2, n + 5) === " b/" && rest.slice(2, n + 2) === rest.slice(n + 5)) {
    const p = rest.slice(2, n + 2);
    return [p, p];
  }
  const idx = rest.lastIndexOf(" b/");
  if (idx > 0) return [stripPrefix(rest.slice(0, idx)), stripPrefix(rest.slice(idx + 1))];
  return [rest, rest];
}

export function hunkId(path: string, header: string, lines: DiffLine[]): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(path);
  h.update("\0");
  h.update(header);
  for (const l of lines) h.update(`\0${l.kind[0]}${l.text}`);
  return h.digest("hex").slice(0, 12);
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse `git diff` / `gh pr diff` unified output (git extended format). */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pass over git's line grammar; splitting it would spread the state machine over helpers
export function parseDiff(text: string): FileChange[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const files: FileChange[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith("diff --git ")) {
      i++;
      continue;
    }
    let [oldPath, newPath] = parseDiffGitPaths(line.slice("diff --git ".length));
    let status: FileChange["status"] = "modified";
    let binary = false;
    let renamed = false;
    i++;

    // Extended headers.
    while (i < lines.length && !lines[i]!.startsWith("diff --git ") && !lines[i]!.startsWith("@@ ")) {
      const h = lines[i]!;
      if (h.startsWith("new file mode")) status = "added";
      else if (h.startsWith("deleted file mode")) status = "deleted";
      else if (h.startsWith("rename from ")) {
        oldPath = unquoteGitPath(h.slice(12));
        renamed = true;
      } else if (h.startsWith("rename to ")) {
        newPath = unquoteGitPath(h.slice(10));
        renamed = true;
      } else if (h.startsWith("Binary files ") || h === "GIT binary patch") binary = true;
      else if (h.startsWith("--- ")) {
        const p = stripPrefix(h.slice(4));
        if (p === "/dev/null") status = "added";
        else oldPath = p;
      } else if (h.startsWith("+++ ")) {
        const p = stripPrefix(h.slice(4));
        if (p === "/dev/null") status = "deleted";
        else newPath = p;
      }
      i++;
    }
    if (renamed && status === "modified") status = "renamed";
    const path = status === "deleted" ? oldPath : newPath;
    const file: FileChange = { path, status, binary, hunks: [] };
    if (status === "renamed") file.oldPath = oldPath;

    while (i < lines.length && lines[i]!.startsWith("@@ ")) {
      const header = lines[i]!;
      const m = HUNK_RE.exec(header);
      if (!m) throw new Error(`Malformed hunk header in ${path}: ${header}`);
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      i++;
      const body: DiffLine[] = [];
      let oldLeft = oldLines;
      let newLeft = newLines;
      let oldNo = oldStart;
      let newNo = newStart;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i]!.startsWith("\\"))) {
        const l = lines[i]!;
        const tag = l[0];
        if (tag === "\\") {
          const prev = body[body.length - 1];
          if (prev) prev.noNewlineAtEof = true;
        } else if (tag === "+") {
          body.push({ kind: "add", text: l.slice(1), newLine: newNo++ });
          newLeft--;
        } else if (tag === "-") {
          body.push({ kind: "del", text: l.slice(1), oldLine: oldNo++ });
          oldLeft--;
        } else if (tag === " " || l === "") {
          body.push({ kind: "context", text: l.slice(1), oldLine: oldNo++, newLine: newNo++ });
          oldLeft--;
          newLeft--;
        } else {
          throw new Error(`Unexpected line in hunk ${path} ${header}: ${l.slice(0, 80)}`);
        }
        i++;
      }
      const id = hunkId(path, header, body);
      file.hunks.push({
        id,
        path,
        header,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: body,
        blocks: splitHunk({ id, path, lines: body }),
        labels: [],
        attention: "routine",
        score: 0,
      });
    }
    files.push(file);
  }
  return files;
}

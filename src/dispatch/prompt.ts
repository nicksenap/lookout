import type { Card, ChangeSet, FileChange, Hunk } from "../core/types.ts";

export type DispatchScope = { kind: "hunk"; hunk: Hunk } | { kind: "card"; card: Card } | { kind: "change" };

/** The hunks (grouped by file) that hold a card's blocks, in file order. */
export function cardHunks(changeSet: ChangeSet, card: Card): { file: FileChange; hunks: Hunk[] }[] {
  const ids = new Set(card.blockIds);
  return changeSet.files
    .map((file) => ({ file, hunks: file.hunks.filter((h) => h.blocks.some((b) => ids.has(b.id))) }))
    .filter((f) => f.hunks.length > 0);
}

export const FINDINGS_CONTRACT = `End your reply with exactly one fenced \`\`\`json block, and nothing after it, of this shape:

\`\`\`json
{"findings": [{"severity": "p1", "title": "short summary", "body": "why it matters and what to change", "path": "path/in/repo.ts", "line": 123}]}
\`\`\`

severity: "p0" must fix before merge, "p1" should fix, "p2" minor.
path/line: a line of the NEW version of the file that appears in the diff above; omit both if the finding is not about one line.
Use {"findings": []} when nothing is worth reporting.`;

export const DEFAULT_PROMPT = `You are reviewing an agent-written code change in the git repository at {repo}.

Scope: {scope}
{intent}
Review the diff below. Look for bugs, security problems, behaviour that contradicts the stated intent, missing error handling, and tests that do not test what they claim. You may read other files for context. Do not modify any files.

\`\`\`diff
{diff}
\`\`\`

{contract}
`;

/** Render parsed hunks back to unified diff text (the slice the agent reviews). */
export function renderDiff(files: { file: FileChange; hunks: Hunk[] }[]): string {
  const out: string[] = [];
  for (const { file, hunks } of files) {
    const oldPath = file.status === "added" ? "/dev/null" : `a/${file.oldPath ?? file.path}`;
    const newPath = file.status === "deleted" ? "/dev/null" : `b/${file.path}`;
    out.push(`diff --git a/${file.oldPath ?? file.path} b/${file.path}`);
    if (file.binary) {
      out.push(`Binary file ${file.path} ${file.status}`);
      continue;
    }
    if (hunks.length === 0) {
      out.push(`(${file.status}, no content change)`);
      continue;
    }
    out.push(`--- ${oldPath}`, `+++ ${newPath}`);
    for (const h of hunks) {
      out.push(h.header);
      for (const l of h.lines) {
        out.push((l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text);
        if (l.noNewlineAtEof) out.push("\\ No newline at end of file");
      }
    }
  }
  return out.join("\n");
}

export function diffSlice(changeSet: ChangeSet, scope: DispatchScope): string {
  if (scope.kind === "change") return renderDiff(changeSet.files.map((file) => ({ file, hunks: file.hunks })));
  if (scope.kind === "card") return renderDiff(cardHunks(changeSet, scope.card));
  const file = changeSet.files.find((f) => f.path === scope.hunk.path)!;
  return renderDiff([{ file, hunks: [scope.hunk] }]);
}

export function describeScope(changeSet: ChangeSet, scope: DispatchScope): string {
  if (scope.kind === "change") return `the whole change ${changeSet.target} (${changeSet.files.length} files)`;
  if (scope.kind === "card") {
    const files = cardHunks(changeSet, scope.card);
    return `one logical change of ${changeSet.target}: "${scope.card.title}" (${scope.card.blockIds.length} edits in ${files.length} file${files.length === 1 ? "" : "s"}; ${scope.card.color}, ${scope.card.kind}${scope.card.areas.length ? `; areas: ${scope.card.areas.join(", ")}` : ""}). Review only the + and - lines of these hunks.`;
  }
  const h = scope.hunk;
  const end = h.newStart + Math.max(0, h.newLines - 1);
  return `one hunk of ${changeSet.target}: ${h.path} lines ${h.newStart}-${end} (rules/model attention: ${h.attention}${h.labels.length ? `; ${h.labels.join(", ")}` : ""})`;
}

/** Single-pass `{name}` substitution; values are inserted verbatim and never re-scanned. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => (name in values ? values[name]! : m));
}

export function buildPrompt(opts: { changeSet: ChangeSet; scope: DispatchScope; repo: string; template?: string }): string {
  const template = opts.template ?? DEFAULT_PROMPT; // placeholders were validated with the config
  const intent = opts.changeSet.intent;
  return fillTemplate(template, {
    repo: opts.repo,
    scope: describeScope(opts.changeSet, opts.scope),
    intent: intent ? `\nStated intent (PR):\nTitle: ${intent.title}\n${intent.body.trim() ? `Body:\n${intent.body.trim()}\n` : ""}` : "",
    diff: diffSlice(opts.changeSet, opts.scope),
    contract: FINDINGS_CONTRACT,
  });
}

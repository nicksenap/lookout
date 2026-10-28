import type { Card, ChangeSet, Finding } from "../core/types.ts";
import { diffSlice, fillTemplate } from "../dispatch/prompt.ts";

export const VERDICTS_CONTRACT = `End your reply with exactly one fenced \`\`\`json block, and nothing after it, of this shape:

\`\`\`json
{"verdicts": [{"id": "d1-1", "verdict": "confirmed", "note": "evidence: the reachability argument, repro or test that shows the problem is real"}, {"id": "d1-2", "verdict": "rejected", "note": "reason: why the finding is wrong or does not apply"}]}
\`\`\`

verdict: "confirmed" only with concrete evidence in the note (which call reaches the line, which input triggers it, which test fails); "rejected" only with a reason; "unsure" when you could not settle it.
Give exactly one verdict per finding id listed above.`;

export const DEFAULT_VERIFY_PROMPT = `You are verifying findings another reviewer raised about an agent-written code change in the git repository at {repo}.

Scope: {scope}
{intent}
Findings to verify:
{findings}

For each finding, try to refute it: read the surrounding code, trace callers and inputs, check whether a test already covers it. Confirm it only when you can show the problem is real; reject it when you can show it is not. Do not propose new findings. Do not modify any files.

\`\`\`diff
{diff}
\`\`\`

{contract}
`;

/** The findings as the verifier sees them: id, severity, title, body, anchor. */
export function describeFindings(findings: Finding[]): string {
  return findings
    .map((f) => {
      const where = f.anchor
        ? ` (${f.anchor.path}:${f.anchor.line}${f.preExisting ? ", a context line the change did not touch" : ""})`
        : "";
      return `- ${f.id} [${f.severity.toUpperCase()}] ${f.title}${where}\n  ${f.body.trim() || "(no body)"}`;
    })
    .join("\n");
}

export function buildVerifyPrompt(opts: {
  changeSet: ChangeSet;
  card: Card;
  findings: Finding[];
  repo: string;
  template?: string;
}): string {
  const intent = opts.changeSet.intent;
  return fillTemplate(opts.template ?? DEFAULT_VERIFY_PROMPT, {
    repo: opts.repo,
    scope: `one logical change of ${opts.changeSet.target}: "${opts.card.title}" (${opts.card.blockIds.length} edits; ${opts.card.color}, ${opts.card.kind})`,
    intent: intent ? `\nStated intent (PR):\nTitle: ${intent.title}\n${intent.body.trim() ? `Body:\n${intent.body.trim()}\n` : ""}` : "",
    findings: describeFindings(opts.findings),
    diff: diffSlice(opts.changeSet, { kind: "card", card: opts.card }),
    contract: VERDICTS_CONTRACT,
  });
}

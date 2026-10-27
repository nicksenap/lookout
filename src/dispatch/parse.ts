import type { ChangeSet, Finding, Severity } from "../core/types.ts";
import { attempt } from "../core/result.ts";

export interface ParsedOutput {
  findings: Finding[];
  /** Everything except the findings block, for display as plain text. */
  freeform: string;
  /** Problems with the findings block or individual findings. */
  notes: string[];
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

interface Fence {
  info: string;
  start: number; // line index of the opening fence
  end: number; // line index of the closing fence (exclusive end if unterminated)
  body: string;
}

/** Fenced code blocks in order. An unterminated final fence runs to end of output. */
function fences(lines: string[]): Fence[] {
  const out: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,})\s*([\w-]*)/.exec(lines[i]!);
    if (!open) continue;
    const ticks = open[1]!;
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${ticks}\\s*$`).test(lines[j]!)) j++;
    out.push({ info: open[2]!.toLowerCase(), start: i, end: j, body: lines.slice(i + 1, j).join("\n") });
    i = j;
  }
  return out;
}

/** True when `line` (new-side numbering) of `path` falls inside a hunk of the change. */
export function lineInDiff(changeSet: ChangeSet, path: string, line: number): boolean {
  const file = changeSet.files.find((f) => f.path === path);
  if (!file) return false;
  return file.hunks.some((h) => h.lines.some((l) => l.newLine === line));
}

const SEVERITIES: Severity[] = ["p0", "p1", "p2"];

/**
 * Parse a dispatcher's output: the last fenced ```json block holds findings
 * (`{"findings": [...]}` or a bare array). Anchors outside the diff are dropped.
 */
export function parseDispatchOutput(rawOutput: string, opts: { dispatcher: string; dispatchId: string; changeSet: ChangeSet }): ParsedOutput {
  const output = stripAnsi(rawOutput);
  const lines = output.split("\n");
  const block = fences(lines).filter((f) => f.info === "json").at(-1);
  if (!block) return { findings: [], freeform: output.trim(), notes: ["no ```json findings block in output"] };

  const freeform = [...lines.slice(0, block.start), ...lines.slice(block.end + 1)].join("\n").trim();
  const data = attempt((): unknown => JSON.parse(block.body));
  if (!data.ok) return { findings: [], freeform: output.trim(), notes: [`last \`\`\`json block is not valid JSON (${data.error})`] };
  const list = Array.isArray(data.value) ? data.value : (data.value as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) return { findings: [], freeform: output.trim(), notes: ['last ```json block has no "findings" array'] };

  const notes: string[] = [];
  const findings: Finding[] = [];
  list.forEach((item: unknown, k) => {
    const f = item as Record<string, unknown> | null;
    if (!f || typeof f !== "object" || typeof f.title !== "string" || f.title.trim() === "") {
      notes.push(`finding ${k + 1} skipped: needs a "title" string`);
      return;
    }
    let severity = typeof f.severity === "string" ? (f.severity.toLowerCase() as Severity) : undefined;
    if (!severity || !SEVERITIES.includes(severity)) {
      notes.push(`finding ${k + 1}: severity ${JSON.stringify(f.severity)} is not p0/p1/p2; using p2`);
      severity = "p2";
    }
    const finding: Finding = {
      id: `${opts.dispatchId}-${k + 1}`,
      severity,
      title: f.title.trim(),
      body: typeof f.body === "string" ? f.body : "",
      dispatcher: opts.dispatcher,
    };
    if (typeof f.path === "string" && typeof f.line === "number") {
      if (lineInDiff(opts.changeSet, f.path, f.line)) finding.anchor = { path: f.path, line: f.line };
      else notes.push(`finding ${k + 1}: ${f.path}:${f.line} is outside the diff; shown unanchored`);
    }
    findings.push(finding);
  });
  return { findings, freeform, notes };
}

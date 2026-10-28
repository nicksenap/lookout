import { attempt } from "../core/result.ts";
import type { ChangeSet, Finding, Severity } from "../core/types.ts";

export interface ParsedOutput {
  findings: Finding[];
  /** Everything except the findings block, for display as plain text. */
  freeform: string;
  /** Problems with the findings block or individual findings. */
  notes: string[];
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

export interface Fence {
  info: string;
  start: number; // line index of the opening fence
  end: number; // line index of the closing fence (exclusive end if unterminated)
  body: string;
}

/** Fenced code blocks in order. An unterminated final fence runs to end of output. */
export function fences(lines: string[]): Fence[] {
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
  return lineKind(changeSet, path, line) !== undefined;
}

/** The kind of the diff line at `path:line` (new-side numbering); undefined outside every hunk. */
export function lineKind(changeSet: ChangeSet, path: string, line: number): "context" | "add" | undefined {
  const file = changeSet.files.find((f) => f.path === path);
  const found = file?.hunks.flatMap((h) => h.lines).find((l) => l.newLine === line);
  return found?.kind === "add" ? "add" : found?.kind === "context" ? "context" : undefined;
}

/**
 * The last fenced ```json block of an agent's output, parsed. The rest is `freeform`.
 * Agents print ANSI and chatter; only the final fence is the contract.
 */
export function lastJsonBlock(rawOutput: string): { data: unknown; freeform: string } | { error: string; freeform: string } {
  const output = stripAnsi(rawOutput);
  const lines = output.split("\n");
  const block = fences(lines)
    .filter((f) => f.info === "json")
    .at(-1);
  if (!block) return { error: "no ```json block in output", freeform: output.trim() };
  const freeform = [...lines.slice(0, block.start), ...lines.slice(block.end + 1)].join("\n").trim();
  const data = attempt((): unknown => JSON.parse(block.body));
  if (!data.ok) return { error: `last \`\`\`json block is not valid JSON (${data.error})`, freeform: output.trim() };
  return { data: data.value, freeform };
}

const SEVERITIES: Severity[] = ["p0", "p1", "p2"];

/**
 * Parse a proposer's output: the last fenced ```json block holds findings
 * (`{"findings": [...]}` or a bare array). Anchors outside the diff are dropped; an anchor on
 * a context line marks the finding pre-existing.
 */
export function parseDispatchOutput(
  rawOutput: string,
  opts: { dispatcher: string; dispatchId: string; changeSet: ChangeSet },
): ParsedOutput {
  const block = lastJsonBlock(rawOutput);
  if ("error" in block)
    return { findings: [], freeform: block.freeform, notes: [block.error.replace("```json block", "```json findings block")] };
  const list = Array.isArray(block.data) ? block.data : (block.data as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list))
    return { findings: [], freeform: stripAnsi(rawOutput).trim(), notes: ['last ```json block has no "findings" array'] };

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
      status: "proposed",
      preExisting: false,
    };
    if (typeof f.path === "string" && typeof f.line === "number") {
      const kind = lineKind(opts.changeSet, f.path, f.line);
      if (kind) finding.anchor = { path: f.path, line: f.line };
      else notes.push(`finding ${k + 1}: ${f.path}:${f.line} is outside the diff; shown unanchored`);
      if (kind === "context") finding.preExisting = true;
    }
    findings.push(finding);
  });
  return { findings, freeform: block.freeform, notes };
}

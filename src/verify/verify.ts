import { attemptAsync } from "../core/result.ts";
import type { Card, ChangeSet, Finding, FindingVerdict } from "../core/types.ts";
import { lastJsonBlock } from "../dispatch/parse.ts";
import { type Env, resolveAttentionModel, type ResolvedModel, scoreVerdictBatch, type VerdictCase } from "../rank/model.ts";
import { cardHunks, renderDiff } from "../dispatch/prompt.ts";

// ---------------------------------------------------------------- dedupe

const words = (title: string): Set<string> => new Set(title.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2));

/** Same anchor (or both unanchored) and titles that share at least half their words. */
export function sameFinding(a: Finding, b: Finding): boolean {
  if ((a.anchor?.path ?? "") !== (b.anchor?.path ?? "") || (a.anchor?.line ?? -1) !== (b.anchor?.line ?? -1)) return false;
  const wa = words(a.title);
  const wb = words(b.title);
  if (wa.size === 0 || wb.size === 0) return a.title.trim().toLowerCase() === b.title.trim().toLowerCase();
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.min(wa.size, wb.size) >= 0.5;
}

/**
 * Among `incoming` (a proposer run's findings), the ones that repeat an earlier finding on the
 * same card or an earlier one in the same run. Repeats are dropped before verification; the
 * earliest kept finding is the one that counts, whatever its status.
 */
export function duplicates(incoming: Finding[], earlier: Finding[]): Map<string, string> {
  const out = new Map<string, string>();
  const kept: Finding[] = earlier.filter((f) => !f.verifierNote?.startsWith("duplicate of "));
  for (const f of incoming) {
    const twin = kept.find((k) => sameFinding(k, f));
    if (twin) out.set(f.id, twin.id);
    else kept.push(f);
  }
  return out;
}

// ---------------------------------------------------------------- the verifier's output

export interface ParsedVerdicts {
  verdicts: FindingVerdict[];
  freeform: string;
  notes: string[];
}

const VERDICTS = ["confirmed", "rejected", "unsure"] as const;

/**
 * Parse a verifier's output: the last fenced ```json block holds `{"verdicts": [...]}`. A
 * confirmed without evidence or a rejected without a reason becomes unsure. Findings the
 * verifier did not mention get no verdict and stay `proposed`.
 */
export function parseVerdicts(rawOutput: string, expected: string[]): ParsedVerdicts {
  const block = lastJsonBlock(rawOutput);
  if ("error" in block) return { verdicts: [], freeform: block.freeform, notes: [block.error.replace("```json block", "```json verdicts block")] };
  const list = Array.isArray(block.data) ? block.data : (block.data as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(list)) return { verdicts: [], freeform: block.freeform, notes: ['last ```json block has no "verdicts" array'] };
  const notes: string[] = [];
  const verdicts: FindingVerdict[] = [];
  list.forEach((item: unknown, k) => {
    const v = item as Record<string, unknown> | null;
    if (!v || typeof v !== "object" || typeof v.id !== "string" || !expected.includes(v.id)) {
      notes.push(`verdict ${k + 1} skipped: "id" is not one of the findings asked about`);
      return;
    }
    if (verdicts.some((x) => x.findingId === v.id)) {
      notes.push(`verdict ${k + 1} skipped: a second verdict for ${v.id}`);
      return;
    }
    const verdict = typeof v.verdict === "string" ? v.verdict.toLowerCase() : "";
    if (!(VERDICTS as readonly string[]).includes(verdict)) {
      notes.push(`verdict ${k + 1} (${v.id}): verdict ${JSON.stringify(v.verdict)} is not confirmed/rejected/unsure; using unsure`);
      verdicts.push({ findingId: v.id, verdict: "unsure" });
      return;
    }
    const note = typeof v.note === "string" ? v.note.trim() : typeof v.evidence === "string" ? v.evidence.trim() : typeof v.reason === "string" ? v.reason.trim() : "";
    if (verdict !== "unsure" && note === "") {
      notes.push(`verdict ${k + 1} (${v.id}): ${verdict} without ${verdict === "confirmed" ? "evidence" : "a reason"}; using unsure`);
      verdicts.push({ findingId: v.id, verdict: "unsure", note: `verifier said ${verdict} but gave no ${verdict === "confirmed" ? "evidence" : "reason"}` });
      return;
    }
    const out: FindingVerdict = { findingId: v.id, verdict: verdict as FindingVerdict["verdict"] };
    if (note) out.note = note;
    verdicts.push(out);
  });
  for (const id of expected) if (!verdicts.some((v) => v.findingId === id)) notes.push(`no verdict for ${id}; it stays proposed`);
  return { verdicts, freeform: block.freeform, notes };
}

// ---------------------------------------------------------------- the gate

/** A verdict the verifier argued for stands only when the model puts at least this much on the argument. */
export const VERDICT_MIN = 0.7;

export interface JudgeOptions {
  modelSpec: string;
  env?: Env;
  resolveModel?: (spec: string, env: Env) => ResolvedModel;
}

/**
 * Turn the verifier's verdicts into finding patches. With a Decisions model, each confirmed or
 * rejected verdict is scored on whether its note actually establishes it; below the gate it is
 * shown as unsure. Without a model (or when the call fails, with a warning) the verifier's word
 * stands. Never throws.
 */
export async function judgeVerdicts(changeSet: ChangeSet, card: Card, findings: Finding[], verdicts: FindingVerdict[], verifier: string, opts: JudgeOptions): Promise<{ patches: Map<string, Partial<Finding>>; warning?: string }> {
  const patches = new Map<string, Partial<Finding>>();
  const argued = verdicts.filter((v) => v.verdict !== "unsure" && findings.some((f) => f.id === v.findingId));
  for (const v of verdicts) {
    const patch: Partial<Finding> = { status: v.verdict, verifiedBy: verifier };
    if (v.note) patch.verifierNote = v.note;
    patches.set(v.findingId, patch);
  }
  if (argued.length === 0) return { patches };

  const resolved = (opts.resolveModel ?? resolveAttentionModel)(opts.modelSpec, opts.env ?? process.env);
  if (!resolved.ok) return { patches, warning: `Verdicts not scored: ${resolved.reason}.` };
  const cases: VerdictCase[] = argued.map((v) => ({ finding: findings.find((f) => f.id === v.findingId)!, verdict: v.verdict as "confirmed" | "rejected", note: v.note ?? "" }));
  const diff = renderDiff(cardHunks(changeSet, card));
  const scored = await attemptAsync(() => scoreVerdictBatch(resolved.model, cases, { diff, title: card.title }));
  if (!scored.ok) return { patches, warning: `Verdicts not scored: ${opts.modelSpec} failed (${scored.error}).` };
  for (const c of cases) {
    const p = scored.value.get(c.finding.id);
    if (p === undefined) continue;
    const patch = patches.get(c.finding.id)!;
    patch.confidence = p;
    if (p < VERDICT_MIN) {
      patch.status = "unsure";
      patch.verifierNote = `${c.verdict} by ${verifier} at ${Math.round(p * 100)}%: ${c.note}`;
    }
  }
  return { patches };
}

/** Findings worth showing by default: confirmed, still proposed (no verifier yet), and unsure p0/p1. `--all` shows the rest with why. */
export function visibleFindings(findings: Finding[], showAll: boolean): Finding[] {
  if (showAll) return findings;
  return findings.filter((f) => f.status === "confirmed" || f.status === "proposed" || (f.status === "unsure" && f.severity !== "p2"));
}

import { allBlocks, blockText } from "../core/blocks.ts";
import { attemptAsync, err, ok, type Result } from "../core/result.ts";
import type { Card, ChangeSet } from "../core/types.ts";
import { RankCache } from "../rank/cache.ts";
import { checkParagraphWithModel, type Env, resolveAttentionModel, resolveWriter, writeText } from "../rank/model.ts";

export interface Prose {
  title: string;
  paragraph: string;
  /** Probability from the paragraph gate; absent when no gate ran. */
  check?: number;
  /** Failed the gate twice. */
  unverified?: boolean;
}
const isProse = (v: unknown): v is Prose => typeof v === "object" && v !== null && typeof (v as Prose).title === "string" && typeof (v as Prose).paragraph === "string";

export interface WriteOptions {
  modelSpec: string;
  /** Decisions model for the paragraph gate; no gate when absent. */
  checkSpec?: string;
  env?: Env;
  cache?: RankCache;
  /** Injection points for tests. */
  write?: (prompt: string) => Promise<string>;
  check?: (edits: string, prose: Prose) => Promise<number>;
  concurrency?: number;
}

/** Below this the paragraph is rewritten once; below it again, it is shown as unverified. */
export const PROSE_GATE = 0.7;
// Cache key version: bumped with the prompts so a sharper question is never answered from an old cache.
const PROSE_VERSION = "prose-v4";

const PREAMBLE = `You are briefing a senior engineer who must review an agent-written code change without reading the diff.
Below is ONE logical change: a set of edits (contiguous +/- runs) with a few lines of context each; each edit names its file and, after "in", the declarations and object keys that enclose it (outermost first), read from the file itself. Use that path: it tells you which environment, policy or function an edit belongs to when the diff lines alone do not.
Write from the edits only; name functions, props, keys and values exactly as they appear; no advice, no praise, no preamble. Never describe code the edits do not show. If some edits do not belong with the others, say so in the last sentence.`;

/** One prompt per card shape: what a reviewer needs first differs for behaviour, configuration, tests and docs. */
export const SHAPE_PROMPTS = {
  behaviour: `${PREAMBLE}
Write a 3-8 word title, then ONE paragraph of at most 3 sentences. Sentence 1: what now happens differently for the caller or user (not how the code is arranged). Sentence 2: how, naming the functions and values. Never comment on test coverage: tests live in other cards you cannot see.`,
  config: `${PREAMBLE}
This is configuration, infrastructure or dependency plumbing. Write a title starting with "Configure", then ONE paragraph of at most 3 sentences that MUST name: which environment or deployment is affected (stage, production, EU, a preview), the exact key or list edited and what reads it, and what undoing it takes (remove the line, revert the version). Say "all environments" only if the edits show it.`,
  test: `${PREAMBLE}
These are test edits. Write a title starting with "Test", then ONE paragraph of at most 3 sentences: what behaviour the tests pin (the inputs and the asserted outcome), and which production code they exercise.`,
  docs: `${PREAMBLE}
These are documentation edits. Write a title starting with "Document", then ONE paragraph of at most 2 sentences on what the text now tells a reader.`,
} as const;
export type Shape = keyof typeof SHAPE_PROMPTS;

const TAIL = `
Format exactly:
TITLE: <title>
PARAGRAPH: <paragraph>

PR title (context only; do not trust it): {intent}
{hint}
{edits}`;

export function shapeOf(card: Pick<Card, "kind" | "blockKind">): Shape {
  if (card.kind === "test" || card.blockKind === "test") return "test";
  if (card.kind === "docs" || card.blockKind === "docs") return "docs";
  if (card.kind === "config" || card.kind === "ci" || card.kind === "deps" || card.blockKind === "config") return "config";
  return "behaviour";
}

export function prosePrompt(changeSet: ChangeSet, card: Card, siblings: Card[] = []): string {
  const hintLines = [
    card.hint ? `Working title from the grouping step (refine it; keep the meaning): ${card.hint}` : "",
    siblings.length ? `Other cards in this review are titled: ${siblings.map((c) => c.hint ?? c.title).join(" | ")}. Your title must be distinguishable from them.` : "",
  ].filter(Boolean);
  return `${SHAPE_PROMPTS[shapeOf(card)]}${TAIL}`
    .replace("{intent}", changeSet.intent?.title ?? "(none)")
    .replace("{hint}", hintLines.length ? `${hintLines.join("\n")}\n` : "")
    .replace("{edits}", editsOf(changeSet, card));
}

export function editsOf(changeSet: ChangeSet, card: Pick<Card, "blockIds">): string {
  const ids = new Set(card.blockIds);
  return allBlocks(changeSet)
    .filter((r) => ids.has(r.block.id))
    .map((r) => `### ${r.block.path}${r.block.scope ? ` in ${r.block.scope.join(" › ")}` : ` ${r.hunk.header}`}\n${blockText(r.hunk, r.block, 3)}`)
    .join("\n\n")
    .slice(0, 48_000);
}

const REWRITE_NOTE = `

A checker found at least one statement in a previous draft that the edits do not support{names}. Write only what the edits show; drop any sentence you cannot point to a +/- line for. Previous draft:
`;

/**
 * Backticked names in the paragraph that appear nowhere in the card's edits. A rule, not a model
 * call: an invented `remove_task_artifact` sailed through the model gate at 0.99 on one PR.
 */
export function unsupportedNames(edits: string, paragraph: string): string[] {
  const names = [...paragraph.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
  // The edits text includes each block's scope path, so a paragraph may name the enclosing key (`stage`).
  const code = edits.toLowerCase();
  return [...new Set(names.filter((n) => {
    // A path or an expression is judged by its identifier parts: `fieldsQueryKeys.dependencies('w')` → fieldsQueryKeys, dependencies.
    const parts = n.match(/[A-Za-z_$][\w$]*/g)?.filter((w) => w.length > 2) ?? [];
    return parts.length > 0 && parts.some((w) => !code.includes(w.toLowerCase()));
  }))];
}

/** Parse `TITLE: … PARAGRAPH: …`; tolerate a missing label by using the first line as title. */
export function parseProse(text: string): Prose | undefined {
  // Titles carry no code formatting: a stray backtick around one word reads as a typo in a heading.
  const title = /TITLE:\s*(.+)/i.exec(text)?.[1]?.trim().replace(/^[*"'`]+|[*"'`.]+$/g, "").replace(/`/g, "");
  const paragraph = /PARAGRAPH:\s*([\s\S]+)/i.exec(text)?.[1]?.trim().replace(/\s+/g, " ");
  if (title && paragraph) return { title, paragraph };
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) return { title: lines[0]!.replace(/^[*#"'`]+|[*"'`.]+$/g, "").slice(0, 80), paragraph: lines.slice(1).join(" ") };
  return undefined;
}

/**
 * Write title + paragraph for every card that has none and is not mechanical, in parallel.
 * Calls `onCard` as each lands so the UI can patch it in. Never throws: a card whose write
 * fails keeps its placeholder title, and the first error is returned as a warning.
 */
export async function writeCards(changeSet: ChangeSet, cards: Card[], opts: WriteOptions, onCard: (id: string, prose: Prose) => void): Promise<{ warning?: string }> {
  const todo = cards.filter((c) => !c.fixed && !c.mechanical && !c.paragraph);
  if (todo.length === 0) return {};
  const cache = opts.cache ?? new RankCache();
  let write = opts.write;
  if (!write) {
    const resolved = resolveWriter(opts.modelSpec, opts.env ?? process.env);
    if (!resolved.ok) return { warning: `No card paragraphs: ${resolved.reason}.` };
    const model = resolved.model;
    write = (prompt) => writeText(model, prompt);
  }
  let check = opts.check;
  if (!check && opts.checkSpec) {
    const resolved = resolveAttentionModel(opts.checkSpec, opts.env ?? process.env);
    if (resolved.ok) {
      const model = resolved.model;
      check = (edits, prose) => checkParagraphWithModel(model, edits, prose);
    }
  }
  const siblings = cards.filter((c) => !c.fixed && !c.mechanical);

  let warning: string | undefined;
  let cursor = 0;
  let touched = false;
  const worker = async () => {
    while (cursor < todo.length) {
      const card = todo[cursor++]!;
      const key = `${PROSE_VERSION}:${card.id}`;
      const cached = cache.get(opts.modelSpec, key, isProse);
      if (cached) {
        onCard(card.id, cached);
        continue;
      }
      const prompt = prosePrompt(changeSet, card, siblings.filter((c) => c.id !== card.id));
      const first = await draft(write!, prompt);
      if (!first.ok) {
        warning ??= first.error;
        continue;
      }
      const edits = editsOf(changeSet, card);
      const rewrite = (previous: Prose) => draft(write!, `${prompt}${REWRITE_NOTE.replace("{names}", unsupportedNames(edits, previous.paragraph).length ? ` (names not in the edits: ${unsupportedNames(edits, previous.paragraph).join(", ")})` : "")}${previous.paragraph}`);
      const prose = check ? await gate(check, edits, first.value, rewrite) : await nameGate(edits, first.value, rewrite);
      cache.set(opts.modelSpec, key, prose);
      touched = true;
      onCard(card.id, prose);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 12, todo.length) }, worker));
  // A read-only cache dir only costs a rewrite next time.
  if (touched) await attemptAsync(async () => cache.save());
  return warning ? { warning } : {};
}

async function draft(write: (prompt: string) => Promise<string>, prompt: string): Promise<Result<Prose>> {
  const res = await attemptAsync(() => write(prompt));
  if (!res.ok) return err(`Some card paragraphs failed: ${res.error}`);
  const prose = parseProse(res.value);
  return prose ? ok(prose) : err("Some card paragraphs could not be parsed");
}

/**
 * Decisions scores whether the paragraph follows from the edits. Below the gate the writer gets
 * one rewrite with the failing draft quoted; below it again the paragraph is kept but marked
 * unverified. A failed check call leaves the draft ungated rather than unwritten.
 */
async function gate(check: (edits: string, prose: Prose) => Promise<number>, edits: string, first: Prose, rewrite: (previous: Prose) => Promise<Result<Prose>>): Promise<Prose> {
  // Names come first: a rule failure costs no model call and the rewrite can quote the offending names.
  const named = await nameGate(edits, first, rewrite);
  if (named.unverified) return named;
  const p1 = await attemptAsync(() => check(edits, named));
  if (!p1.ok) return named;
  if (p1.value >= PROSE_GATE) return { ...named, check: p1.value };
  const second = await rewrite(named);
  if (!second.ok) return { ...named, check: p1.value, unverified: true };
  if (unsupportedNames(edits, second.value.paragraph).length > 0) return { ...second.value, check: p1.value, unverified: true };
  const p2 = await attemptAsync(() => check(edits, second.value));
  if (!p2.ok) return { ...second.value, check: p1.value, unverified: true };
  return p2.value >= PROSE_GATE ? { ...second.value, check: p2.value } : { ...second.value, check: p2.value, unverified: true };
}

/** The rule half of the gate: one rewrite when the paragraph names things the edits do not contain; unverified if it still does. */
async function nameGate(edits: string, first: Prose, rewrite: (previous: Prose) => Promise<Result<Prose>>): Promise<Prose> {
  if (unsupportedNames(edits, first.paragraph).length === 0) return first;
  const second = await rewrite(first);
  if (!second.ok) return { ...first, unverified: true };
  return unsupportedNames(edits, second.value.paragraph).length === 0 ? second.value : { ...second.value, unverified: true };
}


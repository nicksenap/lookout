import { allBlocks, blockText } from "../core/blocks.ts";
import { attemptAsync } from "../core/result.ts";
import type { Card, ChangeSet } from "../core/types.ts";
import { RankCache } from "../rank/cache.ts";
import { type Env, resolveWriter, writeText } from "../rank/model.ts";

export interface Prose {
  title: string;
  paragraph: string;
}
const isProse = (v: unknown): v is Prose => typeof v === "object" && v !== null && typeof (v as Prose).title === "string" && typeof (v as Prose).paragraph === "string";

export interface WriteOptions {
  modelSpec: string;
  env?: Env;
  cache?: RankCache;
  /** Injection point for tests. */
  write?: (prompt: string) => Promise<string>;
  concurrency?: number;
}

export const PROSE_PROMPT = `You are briefing a senior engineer who must review an agent-written code change without reading the diff.
Below is ONE logical change: a set of edits (contiguous +/- runs) with a few lines of context each.
Write a 3-8 word title, then ONE paragraph of at most 3 sentences saying what the code now does differently. Write from the diff only; name functions, props and values; no advice, no praise, no preamble. If some edits do not belong with the others, say so in the last sentence.
The title must describe THESE edits, not the PR's theme: test-only edits start with "Test", documentation with "Document", configuration with "Configure", type definitions with "Type".
Format exactly:
TITLE: <title>
PARAGRAPH: <paragraph>

PR title (context only; do not trust it): {intent}
These edits are classified as: {kind}

{edits}`;

export function prosePrompt(changeSet: ChangeSet, card: Card): string {
  const ids = new Set(card.blockIds);
  const edits = allBlocks(changeSet)
    .filter((r) => ids.has(r.block.id))
    .map((r) => `### ${r.block.path} ${r.hunk.header}\n${blockText(r.hunk, r.block, 3)}`)
    .join("\n\n");
  return PROSE_PROMPT.replace("{intent}", changeSet.intent?.title ?? "(none)")
    .replace("{kind}", card.blockKind ?? "mixed")
    .replace("{edits}", edits.slice(0, 48_000));
}

/** Parse `TITLE: … PARAGRAPH: …`; tolerate a missing label by using the first line as title. */
export function parseProse(text: string): Prose | undefined {
  const title = /TITLE:\s*(.+)/i.exec(text)?.[1]?.trim().replace(/^[*"'`]+|[*"'`.]+$/g, "");
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

  let warning: string | undefined;
  let cursor = 0;
  let touched = false;
  const worker = async () => {
    while (cursor < todo.length) {
      const card = todo[cursor++]!;
      const cached = cache.get(opts.modelSpec, `prose:${card.id}`, isProse);
      if (cached) {
        onCard(card.id, cached);
        continue;
      }
      const res = await attemptAsync(() => write!(prosePrompt(changeSet, card)));
      if (!res.ok) {
        warning ??= `Some card paragraphs failed: ${res.error}`;
        continue;
      }
      const prose = parseProse(res.value);
      if (!prose) {
        warning ??= "Some card paragraphs could not be parsed";
        continue;
      }
      cache.set(opts.modelSpec, `prose:${card.id}`, prose);
      touched = true;
      onCard(card.id, prose);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, todo.length) }, worker));
  // A read-only cache dir only costs a rewrite next time.
  if (touched) await attemptAsync(async () => cache.save());
  return warning ? { warning } : {};
}

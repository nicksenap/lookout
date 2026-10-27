import { ATTENTION_ORDER, type Attention, type ChangeSet, type DiffLine, type EditBlock, type FileChange, type Hunk } from "./types.ts";

export function blockId(path: string, lines: DiffLine[], position: string): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(path);
  h.update("\0");
  h.update(position);
  for (const l of lines) h.update(`\0${l.kind[0]}${l.text}`);
  return h.digest("hex").slice(0, 12);
}

/** Split a hunk's lines into contiguous runs of changed lines. Pure structure: labels and attention are unset. */
export function splitHunk(hunk: Pick<Hunk, "id" | "path" | "lines">): EditBlock[] {
  const blocks: EditBlock[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind === "context") {
      i++;
      continue;
    }
    const from = i;
    while (i < lines.length && lines[i]!.kind !== "context") i++;
    const run = lines.slice(from, i);
    const olds = run.filter((l) => l.oldLine !== undefined).map((l) => l.oldLine!);
    const news = run.filter((l) => l.newLine !== undefined).map((l) => l.newLine!);
    const block: EditBlock = {
      id: blockId(hunk.path, run, `${olds[0] ?? "-"}:${news[0] ?? "-"}`),
      hunkId: hunk.id,
      path: hunk.path,
      from,
      to: i,
      labels: [],
      attention: "routine",
      score: 0,
    };
    if (olds.length) block.oldRange = { start: olds[0]!, end: olds[olds.length - 1]! };
    if (news.length) block.newRange = { start: news[0]!, end: news[news.length - 1]! };
    blocks.push(block);
  }
  return blocks;
}

export const blockLines = (hunk: Hunk, block: EditBlock): DiffLine[] => hunk.lines.slice(block.from, block.to);

/**
 * The hunk's text on each side with every *other* block neutralised (shown as its new
 * side on both sides), so a comparison of old vs new reflects only this block while the
 * lexer still sees the whole hunk's context (open strings, block comments).
 */
export function isolateBlock(hunk: Hunk, block: EditBlock): { oldText: string; newText: string } {
  const oldSide: string[] = [];
  const newSide: string[] = [];
  hunk.lines.forEach((l, k) => {
    const inside = k >= block.from && k < block.to;
    if (l.kind === "context" || (!inside && l.kind === "add")) {
      oldSide.push(l.text);
      newSide.push(l.text);
    } else if (inside && l.kind === "del") oldSide.push(l.text);
    else if (inside && l.kind === "add") newSide.push(l.text);
    // a `del` outside the block is dropped from both sides
  });
  return { oldText: oldSide.join("\n"), newText: newSide.join("\n") };
}

/** The block's lines with up to `context` unchanged lines on each side, rendered as a diff. */
export function blockText(hunk: Hunk, block: EditBlock, context = 3): string {
  const from = Math.max(0, block.from - context);
  const to = Math.min(hunk.lines.length, block.to + context);
  return hunk.lines
    .slice(from, to)
    .map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text)
    .join("\n");
}

const rank = (a: Attention) => ATTENTION_ORDER.indexOf(a);

const CONTENT_LABELS = ["whitespace-only", "comment-only"];

/** Recompute a hunk's labels, attention and score from its blocks. */
export function deriveHunk(hunk: Hunk): Hunk {
  if (hunk.blocks.length === 0) return hunk;
  const labels: string[] = [];
  for (const b of hunk.blocks) for (const l of b.labels) if (!CONTENT_LABELS.includes(l) && !labels.includes(l)) labels.push(l);
  const contents = hunk.blocks.map((b) => b.labels.find((l) => CONTENT_LABELS.includes(l)));
  if (contents.every((c) => c !== undefined)) labels.push(contents.includes("comment-only") ? "comment-only" : "whitespace-only");
  let attention: Attention = "inert";
  let score = 0;
  for (const b of hunk.blocks) {
    if (rank(b.attention) > rank(attention)) attention = b.attention;
    score = Math.max(score, b.score);
  }
  return { ...hunk, labels, attention, score };
}

export interface BlockRef {
  file: FileChange;
  hunk: Hunk;
  block: EditBlock;
}

export function allBlocks(changeSet: ChangeSet): BlockRef[] {
  return changeSet.files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.blocks.map((block) => ({ file, hunk, block }))));
}

/** Return the change set with `fn` applied to every block and hunks re-derived. */
export function mapBlocks(changeSet: ChangeSet, fn: (ref: BlockRef) => EditBlock): ChangeSet {
  return {
    ...changeSet,
    files: changeSet.files.map((file) => ({
      ...file,
      hunks: file.hunks.map((hunk) => deriveHunk({ ...hunk, blocks: hunk.blocks.map((block) => fn({ file, hunk, block })) })),
    })),
  };
}

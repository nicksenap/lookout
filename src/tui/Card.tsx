import { Text } from "ink";
import type { Card, Exchange, Hunk, Progress, Review } from "../core/types.ts";
import { COLOR_LABEL, theme } from "./theme.ts";

export interface Segment {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  inverse?: boolean;
}
/** One terminal row. `card` is the stack index it belongs to (undefined for chrome). */
export interface Line {
  segments: Segment[];
  card?: number;
}

export const width = (s: string): number => Bun.stringWidth(s);

/** Cut `s` to at most `w` columns, with an ellipsis when cut. */
export function fit(s: string, w: number): string {
  if (w <= 0) return "";
  if (width(s) <= w) return s;
  let out = "";
  for (const ch of s) {
    if (width(out + ch) > w - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export function wrap(text: string, w: number): string[] {
  if (w <= 0) return [];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line === "") line = fit(word, w);
      else if (width(`${line} ${word}`) <= w) line += ` ${word}`;
      else {
        out.push(line);
        line = fit(word, w);
      }
    }
    out.push(line);
  }
  return out;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Fit a left and right part into `w` columns; the left part yields. */
export function sides(left: Segment[], right: string, w: number, color?: string): Segment[] {
  const leftText = left.map((s) => s.text).join("");
  const rightW = width(right);
  const gap = Math.max(1, w - width(leftText) - rightW);
  if (width(leftText) + 1 + rightW > w) {
    const cut = fit(leftText, Math.max(0, w - rightW - 1));
    return [{ text: cut, color }, { text: " ".repeat(Math.max(1, w - width(cut) - rightW)) }, { text: right, dim: true }];
  }
  return [...left, { text: " ".repeat(gap) }, { text: right, dim: true }];
}

const BAR = "┃";

export interface CardContext {
  review: Review;
  pending: boolean;
  frame: number;
}

export const cardExchanges = (review: Review, card: Card): Exchange[] => review.exchanges.filter((e) => e.cardId === card.id);
export const changeExchanges = (review: Review): Exchange[] => review.exchanges.filter((e) => e.cardId === undefined);

/** A question and its answer (or its state), wrapped; the question is bold so a stripped frame still separates the two. */
export function exchangeLines(e: Exchange, w: number, frame: number, indent = "  "): Segment[][] {
  const inner = Math.max(1, w - indent.length - 2);
  const out: Segment[][] = [[{ text: `${indent}› ` }, { text: fit(e.question, inner), bold: true }]];
  if (e.status === "pending") return [...out, [{ text: `${indent}  ${theme.spinner[frame % theme.spinner.length]} thinking…`, dim: true }]];
  if (e.status === "failed") return [...out, [{ text: `${indent}  ${fit(e.error ?? "no answer", inner)}`, color: theme.card.red }]];
  if (e.unverified) out.push([{ text: `${indent}  answer unverified · check the diff`, color: theme.card.amber }]);
  for (const l of wrap(e.answer ?? "", inner)) out.push([{ text: `${indent}  ${l}`, dim: e.unverified }]);
  return out;
}

/** `▰▰▰▱▱▱▱▱▱▱ writing 3/11 · 4s`: ten cells, the phase, and how long the pipeline has run. */
export function progressLine(p: Progress, elapsedMs: number, w: number): Segment[] {
  const cells = 10;
  const filled = p.total > 0 ? Math.round((p.done / p.total) * cells) : 0;
  const bar = "▰".repeat(filled) + "▱".repeat(cells - filled);
  const label = p.total > 0 ? `${p.phase} ${p.done}/${p.total}` : p.phase;
  return [
    { text: " " },
    { text: bar, color: theme.accent },
    { text: fit(` ${label} · ${Math.round(elapsedMs / 1000)}s`, Math.max(0, w - cells - 2)), dim: true },
  ];
}

export function filesOf(review: Review, card: Card): string[] {
  const ids = new Set(card.blockIds);
  return review.changeSet.files.filter((f) => f.hunks.some((h) => h.blocks.some((b) => ids.has(b.id)))).map((f) => f.path);
}

/** Words on the badge line a stripped frame still reads: a one-way signal, test coverage. */
export function evidenceBadges(review: Review, card: Card): string[] {
  const out: string[] = [];
  if (card.doorSignals?.length) out.push(`one-way · ${card.doorSignals[0]!.kind}`);
  if (card.covers?.length)
    out.push(`covers ${card.covers.map((id) => `card ${review.cards.findIndex((c) => c.id === id) + 1}`).join(", ")}`);
  else if (card.testsTouched) out.push("tests touched");
  return out;
}

/** A card as it appears in the stack: badge line, title, paragraph or summary. */
export function cardLines(card: Card, index: number, selected: boolean, w: number, ctx: CardContext): Line[] {
  const color = theme.card[card.color];
  // The selected card gets a solid bar; others a thin one. Visible without color.
  const bar: Segment = { text: `${selected ? "█" : BAR} `, color, bold: selected };
  const inner = w - 2;
  const row = (segs: Segment[]): Line => ({ segments: [bar, ...segs], card: index });

  const files = filesOf(ctx.review, card);
  const badges = [
    COLOR_LABEL[card.color],
    card.kind,
    ...card.labels.filter((l) => l !== "test" || card.kind !== "test"),
    ...card.areas.map((a) => `${a}/*`),
  ];
  const evidence = card.fixed ? [] : evidenceBadges(ctx.review, card);
  const right = [plural(card.blockIds.length, "edit"), plural(files.length, "file")].join(" · ");
  const badgeSegs: Segment[] = [
    { text: badges[0]!, color, bold: true },
    { text: badges.length > 1 ? `  ${badges.slice(1).join(" · ")}` : "", dim: true },
  ];
  if (evidence.length) badgeSegs.push({ text: `  ${evidence.join(" · ")}`, color: theme.accent });
  const lines: Line[] = [row(sides(badgeSegs, right, inner, color))];

  if (card.fixed === "clean") {
    lines.push(row([{ text: fit(files.join(", "), inner), dim: true }]));
    return lines;
  }

  lines.push(row([{ text: fit(card.title, inner), bold: true }]));
  if (card.paragraph && card.unverified) {
    // The gate failed twice: the text is shown, but dimmed and labelled so nobody reads it as checked.
    lines.push(row([{ text: fit("paragraph unverified · read the diff", inner), color: theme.card.amber }]));
    for (const l of wrap(card.paragraph, inner)) lines.push(row([{ text: l, dim: true }]));
  } else if (card.paragraph) for (const l of wrap(card.paragraph, inner)) lines.push(row([{ text: l }]));
  else {
    const spin = ctx.pending ? `${theme.spinner[ctx.frame % theme.spinner.length]} ` : "";
    const summary = files.length === 1 ? `${card.attention}, score ${card.score.toFixed(2)}` : `${card.attention} · ${files.join(", ")}`;
    lines.push(row([{ text: fit(`${spin}${summary}`, inner), dim: true }]));
  }
  // The stack shows only the latest exchange on a card; the expanded view lists them all.
  const last = cardExchanges(ctx.review, card).at(-1);
  if (last) for (const segs of exchangeLines(last, inner, ctx.frame)) lines.push(row(segs));
  return lines;
}

/** Expanded card: its door signals and test coverage, then the diff of its hunks with other cards' edits faded. */
export function expandedLines(card: Card, w: number, ctx: CardContext): Line[] {
  const color = theme.card[card.color];
  const ids = new Set(card.blockIds);
  const lines: Line[] = [];
  const push = (segs: Segment[]) => lines.push({ segments: segs });

  const asked = cardExchanges(ctx.review, card);
  if (asked.length > 1) {
    push([{ text: `asked (${asked.length})`, color, bold: true }]);
    for (const e of asked.slice(0, -1)) for (const segs of exchangeLines(e, w, ctx.frame)) push(segs);
    push([{ text: "" }]);
  }

  for (const l of evidenceLines(card, w, ctx.review)) push(l);

  push([
    { text: `diff · ${plural(card.blockIds.length, "edit")}`, color, bold: true },
    { text: "   other cards' edits in these hunks are faded", dim: true },
  ]);
  for (const file of ctx.review.changeSet.files) {
    const hunks = file.hunks.filter((h) => h.blocks.some((b) => ids.has(b.id)));
    if (hunks.length === 0) continue;
    push([{ text: fit(file.path, w), color: theme.accent, bold: true }]);
    for (const h of hunks) {
      // The scope path (`DEPLOYMENTS › stage › servedTools › web`) says where the hunk sits better than its header.
      const scope = h.blocks.find((b) => ids.has(b.id) && b.scope)?.scope;
      push([{ text: fit(scope ? `in ${scope.join(" › ")}` : h.header, w), dim: true }]);
      for (const l of hunkRows(h, ids, w)) push(l);
    }
    push([{ text: "" }]);
  }
  return lines;
}

/** Evidence rows of an expanded card: test coverage and door signals. */
export function evidenceLines(card: Card, w: number, review: Review): Segment[][] {
  const out: Segment[][] = [];
  const tests = card.covers
    ? card.covers.length
      ? `tests  covers ${card.covers.map((id) => titleOf(review, id)).join(", ")}`
      : "tests  exercises no other card in this change"
    : card.testsTouched
      ? `tests  touched by ${review.cards
          .filter((c) => c.covers?.includes(card.id))
          .map((c) => c.title)
          .join(", ")}`
      : "tests  none in this change touch these files";
  out.push([{ text: fit(tests, w), color: card.testsTouched || card.covers ? theme.card.green : theme.card.amber }]);
  if (card.doorSignals?.length) {
    out.push([{ text: "door   one-way", color: theme.card.red, bold: true }]);
    for (const s of card.doorSignals)
      out.push([
        { text: `  ${s.kind}  `, color: theme.card.red },
        { text: fit(`${s.text}  ${s.path.split("/").pop()}${s.line ? `:${s.line}` : ""}`, Math.max(0, w - 20)), dim: true },
      ]);
  }
  out.push([{ text: "" }]);
  return out;
}

const titleOf = (review: Review, id: string) => review.cards.find((c) => c.id === id)?.title ?? id;

function hunkRows(h: Hunk, ids: Set<string>, w: number): Segment[][] {
  const owned = new Set<number>();
  for (const b of h.blocks) if (ids.has(b.id)) for (let k = b.from; k < b.to; k++) owned.add(k);
  return h.lines.map((l, k) => {
    const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
    const no = String(l.newLine ?? l.oldLine ?? "").padStart(4);
    const text = fit(`${no} ${sign} ${l.text}`, w);
    if (l.kind === "context") return [{ text, color: theme.context }];
    if (!owned.has(k)) return [{ text, dim: true }];
    return [{ text, color: l.kind === "add" ? theme.add : theme.del }];
  });
}

/** Render one Line as Ink, truncated to `w` columns. */
export function Row({ line, w, selected }: { line: Line; w: number; selected?: boolean }) {
  const total = line.segments.map((s) => s.text).join("");
  const pad = Math.max(0, w - width(total));
  return (
    <Text wrap="truncate-end" backgroundColor={selected ? theme.selectedBg : undefined}>
      {line.segments.map((s, k) => (
        <Text key={k} color={s.color} dimColor={s.dim} bold={s.bold} inverse={s.inverse}>
          {s.text}
        </Text>
      ))}
      {pad > 0 ? <Text>{" ".repeat(pad)}</Text> : null}
    </Text>
  );
}

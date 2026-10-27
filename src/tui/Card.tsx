import { Text } from "ink";
import type { Card, Dispatch, Finding, Hunk, Review } from "../core/types.ts";
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
  return out + "…";
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
  findings: Finding[];
  dispatches: Dispatch[];
  pending: boolean;
  frame: number;
  /** Elapsed ms for a running dispatch, by id. */
  elapsed: (d: Dispatch) => number;
}

export function filesOf(review: Review, card: Card): string[] {
  const ids = new Set(card.blockIds);
  return review.changeSet.files.filter((f) => f.hunks.some((h) => h.blocks.some((b) => ids.has(b.id)))).map((f) => f.path);
}

/** A card as it appears in the stack: badge line, title, paragraph or summary, findings, running review. */
export function cardLines(card: Card, index: number, selected: boolean, w: number, ctx: CardContext): Line[] {
  const color = theme.card[card.color];
  // The selected card gets a solid bar; others a thin one. Visible without color.
  const bar: Segment = { text: `${selected ? "█" : BAR} `, color, bold: selected };
  const inner = w - 2;
  const row = (segs: Segment[]): Line => ({ segments: [bar, ...segs], card: index });

  const files = filesOf(ctx.review, card);
  const badges = [COLOR_LABEL[card.color], card.kind, ...card.labels.filter((l) => l !== "test" || card.kind !== "test"), ...card.areas.map((a) => `${a}/*`)];
  const right = `${plural(card.blockIds.length, "edit")} · ${plural(files.length, "file")}${ctx.findings.length ? ` · ${plural(ctx.findings.length, "finding")}` : ""}`;
  const badgeSegs: Segment[] = [{ text: badges[0]!, color, bold: true }, { text: badges.length > 1 ? `  ${badges.slice(1).join(" · ")}` : "", dim: true }];
  const lines: Line[] = [row(sides(badgeSegs, right, inner, color))];

  if (card.fixed === "clean") {
    lines.push(row([{ text: fit(files.join(", "), inner), dim: true }]));
    return lines;
  }

  lines.push(row([{ text: fit(card.title, inner), bold: true }]));
  if (card.paragraph) for (const l of wrap(card.paragraph, inner)) lines.push(row([{ text: l }]));
  else {
    const spin = ctx.pending ? `${theme.spinner[ctx.frame % theme.spinner.length]} ` : "";
    const summary = files.length === 1 ? `${card.attention}, score ${card.score.toFixed(2)}` : `${card.attention} · ${files.join(", ")}`;
    lines.push(row([{ text: fit(`${spin}${summary}`, inner), dim: true }]));
  }
  for (const f of ctx.findings.slice(0, 4)) lines.push(row(findingLine(f, inner)));
  if (ctx.findings.length > 4) lines.push(row([{ text: `  +${ctx.findings.length - 4} more`, dim: true }]));
  const running = ctx.dispatches.find((d) => d.status === "running");
  if (running) lines.push(row([{ text: `  ${theme.spinner[ctx.frame % theme.spinner.length]} ${running.dispatcher} reviewing… ${clock(ctx.elapsed(running))}`, color: theme.accent }]));
  else {
    const last = ctx.dispatches[0];
    if (last && last.status !== "done") lines.push(row([{ text: `  ${last.dispatcher} ${last.status}${last.error ? `: ${fit(last.error, inner - 20)}` : ""}`, dim: true }]));
    else if (last && ctx.findings.length === 0) lines.push(row([{ text: `  ✓ ${last.dispatcher} found nothing to report`, color: theme.card.green }]));
  }
  return lines;
}

export function findingLine(f: Finding, w: number): Segment[] {
  const where = f.anchor ? `${f.anchor.path.split("/").pop()}:${f.anchor.line}` : "";
  return sides([{ text: "  " }, { text: f.severity.toUpperCase(), color: theme.severity[f.severity], bold: true }, { text: ` ${f.title}` }], where, w);
}

export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Expanded card: findings in full, then the agent's status (its log while running or when it
 * produced no findings), then the diff of its hunks with other cards' edits faded. Review first,
 * diff as the appendix.
 */
export function expandedLines(card: Card, w: number, ctx: CardContext): Line[] {
  const color = theme.card[card.color];
  const ids = new Set(card.blockIds);
  const lines: Line[] = [];
  const push = (segs: Segment[]) => lines.push({ segments: segs });

  if (ctx.findings.length > 0) {
    push([{ text: `findings (${ctx.findings.length})`, color, bold: true }]);
    for (const f of ctx.findings) {
      push(findingLine(f, w));
      for (const l of wrap(f.body, w - 5)) push([{ text: `     ${l}`, dim: true }]);
      push([{ text: `     by ${f.dispatcher}`, dim: true }]);
    }
    push([{ text: "" }]);
  }

  const d = ctx.dispatches[0];
  if (d) {
    const status = d.status === "running" ? `${theme.spinner[ctx.frame % theme.spinner.length]} running ${clock(ctx.elapsed(d))}` : d.status;
    push([{ text: `${d.dispatcher} · ${status}`, color: theme.accent, bold: true }, { text: `  ${fit(d.cmd, Math.max(0, w - 30))}`, dim: true }]);
    const showLog = d.status === "running" || (d.status === "done" && d.findings.length === 0) || d.status === "failed";
    if (showLog) {
      const text = (d.status === "running" ? d.output : d.freeform || d.output || d.error || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      const rows = text.split("\n").filter((l) => l.trim() !== "");
      for (const raw of rows.slice(d.status === "running" ? -12 : -60)) push([{ text: fit(raw.replace(/\r.*$/, ""), w), dim: true }]);
    }
    push([{ text: "" }]);
  }

  push([{ text: `diff · ${plural(card.blockIds.length, "edit")}`, color, bold: true }, { text: "   other cards' edits in these hunks are faded", dim: true }]);
  for (const file of ctx.review.changeSet.files) {
    const hunks = file.hunks.filter((h) => h.blocks.some((b) => ids.has(b.id)));
    if (hunks.length === 0) continue;
    push([{ text: fit(file.path, w), color: theme.accent, bold: true }]);
    for (const h of hunks) {
      push([{ text: fit(h.header, w), dim: true }]);
      for (const l of hunkRows(h, ids, w)) push(l);
    }
    push([{ text: "" }]);
  }
  return lines;
}

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

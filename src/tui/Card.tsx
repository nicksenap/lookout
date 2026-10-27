import { Text } from "ink";
import type { Card, Claim, ClaimStatus, Dispatch, Finding, Hunk, Review } from "../core/types.ts";
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

/** Glyph and word per claim status; both so a stripped frame still reads. */
export const CLAIM_MARK: Record<ClaimStatus, { glyph: string; word: string; color: string }> = {
  supported: { glyph: "✓", word: "supported", color: theme.card.green },
  contradicted: { glyph: "✗", word: "contradicted", color: theme.card.red },
  unclear: { glyph: "~", word: "unclear", color: theme.card.amber },
  "not-in-diff": { glyph: "∅", word: "not in diff", color: theme.dim },
};

export const cardClaims = (review: Review, card: Card): Claim[] => review.claims.filter((c) => card.claimIds.includes(c.id));

/** `2 claims ✗` when one is contradicted, `~` when one is unclear, else `✓`; pending claims show no mark. */
export function claimsBadge(claims: Claim[]): string {
  if (claims.length === 0) return "";
  const statuses = claims.map((c) => c.status);
  const mark = statuses.includes("contradicted") ? " ✗" : statuses.includes("unclear") ? " ~" : statuses.every((s) => s === "supported") ? " ✓" : "";
  return `${plural(claims.length, "claim")}${mark}`;
}

/** Evidence words on the badge line: unmentioned, a one-way signal, test coverage. */
export function evidenceBadges(review: Review, card: Card): string[] {
  const out: string[] = [];
  if (card.unmentioned) out.push("unmentioned");
  if (card.doorSignals?.length) out.push(`one-way · ${card.doorSignals[0]!.kind}`);
  if (card.covers?.length) out.push(`covers ${card.covers.map((id) => `card ${review.cards.findIndex((c) => c.id === id) + 1}`).join(", ")}`);
  else if (card.testsTouched) out.push("tests touched");
  return out;
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
  const claims = cardClaims(ctx.review, card);
  const evidence = card.fixed ? [] : evidenceBadges(ctx.review, card);
  const right = [plural(card.blockIds.length, "edit"), plural(files.length, "file"), ctx.findings.length ? plural(ctx.findings.length, "finding") : "", claimsBadge(claims)].filter(Boolean).join(" · ");
  const badgeSegs: Segment[] = [{ text: badges[0]!, color, bold: true }, { text: badges.length > 1 ? `  ${badges.slice(1).join(" · ")}` : "", dim: true }];
  if (evidence.length) badgeSegs.push({ text: `  ${evidence.join(" · ")}`, color: card.unmentioned ? theme.card.amber : theme.accent });
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
  for (const c of claims.filter((c) => c.status === "contradicted")) lines.push(row(claimLine(c, inner)));
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

/** `  ✗ contradicted  the PR says X`; a claim without a status shows as pending. */
export function claimLine(c: Claim, w: number, right = ""): Segment[] {
  const mark = c.status ? CLAIM_MARK[c.status] : { glyph: "…", word: "pending", color: theme.dim };
  const pct = c.confidence !== undefined && c.confidence < 1 && c.status ? ` ${Math.round(c.confidence * 100)}%` : "";
  return sides([{ text: "  " }, { text: `${mark.glyph} ${mark.word}${pct}`, color: mark.color, bold: c.status === "contradicted" }, { text: `  ${fit(c.text, Math.max(0, w - 24 - right.length))}` }], right, w);
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

  for (const l of evidenceLines(card, w, ctx.review)) push(l);

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

/** Evidence rows of an expanded card: its claims, test coverage and door signals. */
export function evidenceLines(card: Card, w: number, review: Review): Segment[][] {
  const color = theme.card[card.color];
  const out: Segment[][] = [];
  const claims = cardClaims(review, card);
  if (claims.length > 0 || card.unmentioned) {
    out.push([{ text: `claims (${claims.length})`, color, bold: true }, { text: card.unmentioned ? "   unmentioned: no claim in the PR description covers this card" : "", color: theme.card.amber }]);
    for (const c of claims) out.push(claimLine(c, w));
  }
  const tests = card.covers
    ? card.covers.length
      ? `tests  covers ${card.covers.map((id) => titleOf(review, id)).join(", ")}`
      : "tests  exercises no other card in this change"
    : card.testsTouched
      ? `tests  touched by ${review.cards.filter((c) => c.covers?.includes(card.id)).map((c) => c.title).join(", ")}`
      : "tests  none in this change touch these files";
  out.push([{ text: fit(tests, w), color: card.testsTouched || card.covers ? theme.card.green : theme.card.amber }]);
  if (card.doorSignals?.length) {
    out.push([{ text: "door   one-way", color: theme.card.red, bold: true }]);
    for (const s of card.doorSignals) out.push([{ text: `  ${s.kind}  `, color: theme.card.red }, { text: fit(`${s.text}  ${s.path.split("/").pop()}${s.line ? `:${s.line}` : ""}`, Math.max(0, w - 20)), dim: true }]);
  }
  out.push([{ text: "" }]);
  return out;
}

const titleOf = (review: Review, id: string) => review.cards.find((c) => c.id === id)?.title ?? id;

/** The claims view (`c`): every claim with its status and card, then the door and radius rows. */
export function claimsLines(review: Review, w: number): Line[] {
  const lines: Line[] = [];
  const push = (segs: Segment[]) => lines.push({ segments: segs });
  const authored = review.claims.filter((c) => c.section === "summary" || c.section === "evidence");
  push([{ text: `claims (${authored.length})`, color: theme.accent, bold: true }, { text: review.changeSet.intent ? "   from the PR description" : "   no PR description", dim: true }]);
  for (const c of authored) push(claimLine(c, w, c.cardId ? fit(titleOf(review, c.cardId), Math.max(10, Math.floor(w / 3))) : ""));
  const unmentioned = review.cards.filter((c) => c.unmentioned);
  if (unmentioned.length) {
    push([{ text: "" }]);
    push([{ text: `unmentioned (${unmentioned.length})`, color: theme.card.amber, bold: true }, { text: "   cards no claim covers", dim: true }]);
    for (const c of unmentioned) push([{ text: `  card ${review.cards.indexOf(c) + 1}  `, color: theme.card.amber }, { text: fit(c.title, w - 12) }]);
  }
  push([{ text: "" }]);
  const door = review.door;
  const doorColor = door.computed === "one-way" ? theme.card.red : theme.card.green;
  push([{ text: "door", color: theme.accent, bold: true }, { text: `   diff says ${door.computed}`, color: doorColor }, { text: door.author ? `  \u00b7 author says ${door.author}` : "  \u00b7 author did not say", dim: !door.author || door.author === door.computed, color: door.author && door.author !== door.computed ? theme.card.red : undefined }]);
  for (const s of door.signals) push([{ text: `  ${s.kind}  `, color: theme.card.red }, { text: fit(`${s.text}  ${s.path}${s.line ? `:${s.line}` : ""}`, Math.max(0, w - 20)), dim: true }]);
  push([{ text: "" }]);
  const r = review.radius;
  const radiusClaim = review.claims.find((c) => c.section === "radius");
  const importers = r.importers === undefined ? (r.warning ? "importers unknown" : "importers\u2026") : plural(r.importers.length, "importer");
  push([{ text: "radius", color: theme.accent, bold: true }, { text: `   ${r.areas.length ? r.areas.join(", ") : "no sensitive area"} \u00b7 ${importers}` }, { text: r.author ? `  \u00b7 author says "${r.author}"` : "", dim: true }]);
  if (r.warning) push([{ text: `  ${fit(r.warning, w - 2)}`, color: theme.card.amber }]);
  if (radiusClaim?.status) push(claimLine(radiusClaim, w));
  for (const f of (r.importers ?? []).slice(0, 30)) push([{ text: `  ${fit(f, w - 2)}`, dim: true }]);
  if ((r.importers?.length ?? 0) > 30) push([{ text: `  +${r.importers!.length - 30} more`, dim: true }]);
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

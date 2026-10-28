import { fit, type Line, type Segment, width, wrap } from "./Card.tsx";
import { HELP_KEYS } from "./keys.ts";
import { theme } from "./theme.ts";

export interface HelpState {
  page: "keys" | "glossary";
  scroll: number;
  /** `/` inside the popup: a term filter, shown in the bottom border; the scroll lands on the first term that matches. */
  find?: string;
}

/** One glossary entry per term: the term on its own line, the definition wrapped below it. */
export const GLOSSARY: readonly { term: string; text: string }[] = [
  { term: "Card", text: "One logical change, built from edit blocks across any files. The unit you review. Two fixed cards: verified clean (every inert edit) and untouched (sensitive areas the change does not reach)." },
  { term: "Edit block", text: "One contiguous run of added or removed lines. The smallest unit lookout reasons about; a git hunk may hold several." },
  { term: "Colour", text: "A rule, never an opinion. RED: a suspicious edit, behaviour inside a sensitive area, or a one-way edit that needs eyes. AMBER: needs eyes, config/deps/CI, or a one-way signal. GREEN: fine. GREY: verified clean. Tests, renames and docs inside a sensitive area stay green and keep the area badge." },
  { term: "Attention", text: "How much one edit deserves a look: inert, routine, needs-eyes, suspicious. A model may raise it and never lower it; only rules may call an edit inert." },
  { term: "Kind", text: "What an edit does: behavior, typing-refactor, rename, move, test, types, config, docs. The model proposes it; rules confirm the non-behaviour kinds." },
  { term: "Mechanical", text: "A rename, typing or move card whose label rules confirmed: a consistent one-to-one identifier swap, a type-only edit with no narrowing, code that reappears verbatim. Its sentence is a template. Anything rules could not confirm is behaviour." },
  { term: "Area", text: "A named set of sensitive paths from the repo's policy: auth, billing, data, infra, prompts. Floors colour and tier; the untouched card lists the areas the change misses." },
  { term: "Verdict", text: "In the header: the risk tier (low, medium, high) and how many humans must review, with the reasons. Kind defaults, area rules and floors; a rule can stand down for an additive two-way change." },
  { term: "One-way", text: "A door signal in the diff: a migration, destructive SQL, an in-place data write, a removed public export or route, a contract change. Attached to the card that owns the line and raises its colour." },
  { term: "Scope", text: "The declarations and object keys that enclose an edit in the file at head, outermost first: DEPLOYMENTS › stage › servedTools › web. Shown above each hunk in the expanded card." },
  { term: "tests touched · covers", text: "A test card in this change exercises this card's files (same directory, name stem or import). On the test card, covers lists what it exercises." },
  { term: "unverified", text: "A paragraph or answer that failed its check twice: it named something not in the edits, or Decisions put under 70 % on 'every statement follows from the edits'. Shown dimmed. Read the diff." },
  { term: "Exchange", text: "A question you asked with a and its answer, written from that scope's edits only and checked the same way." },
  { term: "Progress", text: "The bar under the header while cards load: ranking, then splitting oversized cards, then writing paragraphs." },
  { term: "--evidence", text: "JSON only for now: the PR description's claims graded against the diff, cards no claim mentions, and review questions." },
];

const MAX_W = 96;

interface HelpRow {
  text: string;
  style?: "heading" | "term";
}

function helpRows(page: HelpState["page"], inner: number): HelpRow[] {
  if (page === "keys") return HELP_KEYS.flatMap((l) => (width(l) <= inner ? [{ text: l, style: /^[A-Z][a-z]+$/.test(l.trim()) ? ("heading" as const) : undefined }] : wrap(l, inner).map((t) => ({ text: t }))));
  return GLOSSARY.flatMap((e, k) => [...(k ? [{ text: "" }] : []), { text: e.term, style: "term" as const }, ...wrap(e.text, inner - 2).map((t) => ({ text: `  ${t}` }))]);
}

/** Scroll to the first row whose text contains `find` (a glossary term first, then any row); unchanged when nothing matches. */
export function findInHelp(help: HelpState, w: number): HelpState {
  const q = (help.find ?? "").trim().toLowerCase();
  if (q === "") return help;
  const inner = Math.max(20, Math.min(w - 4, MAX_W)) - 4;
  const rows = helpRows(help.page, inner);
  const term = rows.findIndex((r) => r.style === "term" && r.text.toLowerCase().includes(q));
  const any = term >= 0 ? term : rows.findIndex((r) => r.text.toLowerCase().includes(q));
  return any >= 0 ? { ...help, scroll: any } : help;
}

/** Scroll by `delta` entries (glossary) or rows (keys), so an entry's title is never cut off at the top. */
export function scrollHelp(help: HelpState, delta: number, w: number): HelpState {
  const inner = Math.max(20, Math.min(w - 4, MAX_W)) - 4;
  const rows = helpRows(help.page, inner);
  const starts = help.page === "glossary" ? rows.map((r, k) => (r.style === "term" ? k : -1)).filter((k) => k >= 0) : rows.map((_, k) => k);
  const at = starts.findIndex((s) => s >= help.scroll);
  const idx = Math.max(0, Math.min(starts.length - 1, (at < 0 ? starts.length - 1 : at) + delta));
  return { ...help, scroll: starts[idx] ?? 0 };
}

/** The popup's rows at their final width, and where it sits: centred, with one body row of margin. */
export function helpBox(help: HelpState, w: number, h: number): { lines: Line[]; left: number; top: number } {
  const boxW = Math.max(20, Math.min(w - 4, MAX_W));
  const inner = boxW - 4;
  const rows = helpRows(help.page, inner);
  const bodyH = Math.max(1, Math.min(rows.length, h - 4));
  const top = Math.max(0, Math.min(help.scroll, rows.length - bodyH));
  const accent = theme.accent;
  const tab = (page: HelpState["page"]): Segment => ({ text: ` ${page} `, color: accent, bold: help.page === page, inverse: help.page === page });
  const head: Segment[] = [{ text: "┌─", color: accent }, tab("keys"), { text: "─", color: accent }, tab("glossary"), { text: "─ tab switches ", color: accent, dim: true }];
  head.push({ text: `${"─".repeat(Math.max(0, boxW - width(head.map((s) => s.text).join("")) - 1))}┐`, color: accent });
  const where = rows.length > bodyH ? ` ${top + 1}–${top + bodyH} of ${rows.length} · j/k scroll ` : "";
  const footText = help.find !== undefined ? ` /${help.find}▏  enter keep · esc clear ` : ` esc closes ${where}· / find `;
  const foot: Segment[] = [{ text: "└", color: accent }, { text: footText, color: accent, dim: true }, { text: `${"─".repeat(Math.max(0, boxW - width(footText) - 2))}┘`, color: accent }];
  const body = rows.slice(top, top + bodyH).map(
    (r): Line => ({
      segments: [
        { text: "│ ", color: accent },
        { text: fit(r.text, inner), bold: r.style !== undefined, color: r.style === "heading" ? accent : undefined },
        { text: " ".repeat(Math.max(0, inner - width(fit(r.text, inner)))) },
        { text: " │", color: accent },
      ],
    }),
  );
  const lines = [{ segments: head }, ...body, { segments: foot }];
  return { lines, left: Math.max(0, Math.floor((w - boxW) / 2)), top: Math.max(0, Math.floor((h - lines.length) / 2)) };
}

/**
 * Paint `box` over `under`: rows outside the box are dimmed, rows inside keep their text left and
 * right of it and show the box in between. Pure segment arithmetic so tests see the same frame.
 */
export function overlay(under: Line[], box: Line[], left: number, top: number, w: number): Line[] {
  const boxW = width(box[0]!.segments.map((s) => s.text).join(""));
  return under.map((line, k) => {
    const row = box[k - top];
    if (!row) return { segments: line.segments.map((s) => ({ ...s, dim: true, bold: false, inverse: false })) };
    const flat = line.segments.map((s) => s.text).join("");
    const padded = flat + " ".repeat(Math.max(0, w - width(flat)));
    const before = cut(padded, 0, left);
    const after = cut(padded, left + boxW, w);
    return { segments: [{ text: before, dim: true }, ...row.segments, { text: after, dim: true }] };
  });
}

/** Columns [from, to) of `s`, by display width. */
function cut(s: string, from: number, to: number): string {
  let col = 0;
  let out = "";
  for (const ch of s) {
    const cw = width(ch);
    if (col >= from && col + cw <= to) out += ch;
    col += cw;
    if (col >= to) break;
  }
  return out;
}

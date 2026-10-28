import type { Key } from "ink";
import { fit, type Line, type Segment, width, wrap } from "./Card.tsx";
import { theme } from "./theme.ts";

/**
 * The ask composer: a bordered box above the key hints, titled with what the question is about.
 * Modelled on opencode's and lazygit's prompts: Enter sends, Esc cancels, Tab flips the scope,
 * ↑/↓ walk earlier questions, ←/→ and Ctrl-A/E move the cursor, Ctrl-W / Ctrl-U delete a word /
 * the line. One line only: terminals disagree on Shift+Enter, Ctrl-J is the same byte as a pasted
 * newline, and a question is a sentence; long text wraps to three rows and scrolls with the cursor.
 */
export interface Composer {
  scope: "card" | "change";
  text: string;
  /** Code-point offset of the cursor into `text`. */
  cursor: number;
  /** Earlier questions, oldest first; `historyAt` is the index being shown, or `history.length` for the draft. */
  history: string[];
  historyAt: number;
  /** The draft that was being typed before ↑ was pressed, restored on ↓ past the newest entry. */
  draft: string;
}

export const openComposer = (scope: Composer["scope"], history: string[]): Composer => ({ scope, text: "", cursor: 0, history, historyAt: history.length, draft: "" });

export type ComposerResult = { composer: Composer } | { send: string; scope: Composer["scope"] } | { close: true };

const chars = (s: string) => [...s];
const splice = (c: Composer, text: string, cursor: number): Composer => ({ ...c, text, cursor: Math.max(0, Math.min(cursor, chars(text).length)) });

export function composerKey(c: Composer, input: string, key: Key): ComposerResult {
  const cs = chars(c.text);
  const before = cs.slice(0, c.cursor).join("");
  const after = cs.slice(c.cursor).join("");
  if (key.escape) return { close: true };
  if (key.return) {
    const text = c.text.replace(/\s+/g, " ").trim();
    return text === "" ? { close: true } : { send: text, scope: c.scope };
  }
  if (key.tab) return { composer: { ...c, scope: c.scope === "card" ? "change" : "card" } };
  if (key.leftArrow) return { composer: { ...c, cursor: Math.max(0, c.cursor - 1) } };
  if (key.rightArrow) return { composer: { ...c, cursor: Math.min(cs.length, c.cursor + 1) } };
  if (key.ctrl && input === "a") return { composer: { ...c, cursor: 0 } };
  if (key.ctrl && input === "e") return { composer: { ...c, cursor: cs.length } };
  if (key.backspace || key.delete || (key.ctrl && input === "h")) return { composer: splice(c, chars(before).slice(0, -1).join("") + after, c.cursor - 1) };
  if (key.ctrl && input === "w") {
    const kept = before.replace(/\S+\s*$/u, "");
    return { composer: splice(c, kept + after, chars(kept).length) };
  }
  if (key.ctrl && input === "u") return { composer: splice(c, after, 0) };
  if (key.upArrow || key.downArrow) {
    if (c.history.length === 0) return { composer: c };
    const at = Math.max(0, Math.min(c.history.length, c.historyAt + (key.upArrow ? -1 : 1)));
    if (at === c.historyAt) return { composer: c };
    const draft = c.historyAt === c.history.length ? c.text : c.draft;
    const text = at === c.history.length ? draft : c.history[at]!;
    return { composer: { ...splice({ ...c, draft }, text, chars(text).length), historyAt: at } };
  }
  if (input && !key.ctrl && !key.meta) {
    // Pasted text arrives as one chunk; its newlines become spaces so a copied sentence stays one question.
    const clean = input.replace(/\r?\n/g, " ");
    return { composer: splice(c, before + clean + after, c.cursor + chars(clean).length) };
  }
  return { composer: c };
}

const MAX_BODY_ROWS = 3;

/** Rows of the composer box: title, up to three wrapped text rows with the cursor, and the key hints. */
export function composerLines(c: Composer, about: string, w: number): Line[] {
  const inner = Math.max(8, w - 4);
  const title = ` ask · ${c.scope === "card" ? about : "the whole change"} `;
  const hints = ` enter send · tab ${c.scope === "card" ? "→ whole change" : "→ this card"} · ↑↓ earlier · ctrl-w/u delete · esc `;
  const frame = (left: string, label: string, right: string, color: string): Line => ({ segments: [{ text: left, color }, { text: fit(label, inner), color, bold: left === "┌" }, { text: "─".repeat(Math.max(0, inner - width(fit(label, inner)))), color }, { text: right, color }] });
  const body: Line[] = [];
  if (c.text === "") body.push({ segments: [{ text: "│ ", color: theme.accent }, { text: "▏", color: theme.accent }, { text: fit(c.scope === "card" ? "Ask about this card… (tab: the whole change)" : "Ask about the whole change… (tab: this card)", inner - 1), dim: true }, { text: " │", color: theme.accent }] });
  else {
    // The cursor is a marker character so wrapping keeps it with its word; it is drawn as a thin bar.
    const cs = chars(c.text);
    const marked = [...cs.slice(0, c.cursor), "\u0000", ...cs.slice(c.cursor)].join("");
    const rows = wrap(marked, inner);
    const cursorRow = Math.max(0, rows.findIndex((r) => r.includes("\u0000")));
    const first = Math.max(0, Math.min(cursorRow - MAX_BODY_ROWS + 1, rows.length - MAX_BODY_ROWS));
    for (const row of rows.slice(first, first + MAX_BODY_ROWS)) {
      const [pre, post] = row.split("\u0000");
      const segs: Segment[] = [{ text: "│ ", color: theme.accent }, { text: pre ?? "" }];
      if (post !== undefined) segs.push({ text: "▏", color: theme.accent }, { text: post });
      const used = width(segs.map((s) => s.text).join(""));
      segs.push({ text: " ".repeat(Math.max(0, w - used - 2)) }, { text: " │", color: theme.accent });
      body.push({ segments: segs });
    }
  }
  return [frame("┌", title, "┐", theme.accent), ...body, frame("└", hints, "┘", theme.accent)];
}

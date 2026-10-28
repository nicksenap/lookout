import type { Key } from "ink";
import type { Line, Segment } from "./Card.tsx";
import { theme } from "./theme.ts";

/** `/` search: the query being typed (`open`) or committed (`active`); `hits` are row indexes that match. */
export interface Search {
  query: string;
  /** True while the bar accepts keys; enter commits, esc clears. */
  open: boolean;
}

export const openSearch = (previous?: Search): Search => ({ query: previous?.query ?? "", open: true });

export type SearchResult = { search: Search } | { close: true } | { commit: Search };

/** Keys while the search bar is open. Enter keeps the query and hands keys back; esc clears it. */
export function searchKey(s: Search, input: string, key: Key): SearchResult {
  if (key.escape) return { close: true };
  if (key.return) return s.query.trim() === "" ? { close: true } : { commit: { query: s.query, open: false } };
  if (key.backspace || key.delete) return { search: { ...s, query: [...s.query].slice(0, -1).join("") } };
  if (key.ctrl && input === "u") return { search: { ...s, query: "" } };
  if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow)
    return { search: { ...s, query: s.query + input.replace(/\r?\n/g, " ") } };
  return { search: s };
}

const text = (line: Line) => line.segments.map((s) => s.text).join("");

/** Row indexes whose text contains the query, case-insensitively. An empty query matches nothing. */
export function searchHits(lines: Line[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  return lines.flatMap((l, k) => (text(l).toLowerCase().includes(q) ? [k] : []));
}

/** The next hit after `from` in `direction`, wrapping; undefined without hits. */
export function nextHit(hits: number[], from: number, direction: 1 | -1): number | undefined {
  if (hits.length === 0) return undefined;
  const after = direction > 0 ? hits.find((h) => h > from) : [...hits].reverse().find((h) => h < from);
  return after ?? (direction > 0 ? hits[0] : hits[hits.length - 1]);
}

/** Split a row's segments so every occurrence of `query` is its own inverse segment. */
export function highlight(line: Line, query: string): Line {
  const q = query.trim().toLowerCase();
  if (q === "") return line;
  const segments: Segment[] = [];
  for (const seg of line.segments) {
    const lower = seg.text.toLowerCase();
    let at = 0;
    for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
      if (i > at) segments.push({ ...seg, text: seg.text.slice(at, i) });
      segments.push({ ...seg, text: seg.text.slice(i, i + q.length), inverse: true, color: theme.accent, dim: false });
      at = i + q.length;
    }
    if (at < seg.text.length) segments.push({ ...seg, text: seg.text.slice(at) });
  }
  return { ...line, segments };
}

/** Footer segments for the bar: the query with a cursor while open, `/query  3/12` when committed. */
export function searchFooter(s: Search, hits: number, at: number | undefined): Segment[] {
  if (s.open)
    return [
      { text: " /", color: theme.accent, bold: true },
      { text: s.query },
      { text: "▏", color: theme.accent },
      {
        text: hits ? `  ${hits} match${hits === 1 ? "" : "es"}` : s.query ? "  no match" : "  type to search · enter keep · esc clear",
        dim: true,
      },
    ];
  const where = at === undefined ? `${hits} match${hits === 1 ? "" : "es"}` : `${at + 1}/${hits}`;
  return [
    { text: ` /${s.query}`, color: theme.accent },
    { text: `  ${where}`, dim: true },
    { text: "  n/N next/prev · esc clear", dim: true },
  ];
}

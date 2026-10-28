import { Box, useApp, useInput } from "ink";
import { useRef, useState } from "react";
import type { PrSummary } from "../core/types.ts";
import { fit, type Line, plural, Row, type Segment, sides, width } from "./Card.tsx";
import { runFullscreen } from "./screen.ts";
import { theme } from "./theme.ts";

export interface PickerProps {
  repo: string;
  prs: PrSummary[];
  onPick: (pr: PrSummary | undefined) => void;
  /** Fixed size for tests; otherwise the terminal's. */
  size?: { columns: number; rows: number };
}

const CHECK: Record<PrSummary["checks"], { glyph: string; color?: string }> = {
  pass: { glyph: "✓", color: theme.card.green },
  fail: { glyph: "✗", color: theme.card.red },
  pending: { glyph: "…", color: theme.card.amber },
  none: { glyph: " " },
};
const REVIEW: Record<PrSummary["review"], string> = { approved: "approved", changes: "changes requested", required: "needs review", none: "" };

/** Rows of the picker: a header, then one row per PR that matches the filter. `selected` is the index into `shown`. */
export function pickerLines(repo: string, shown: PrSummary[], selected: number, filter: string, w: number): Line[] {
  const header: Line = { segments: sides([{ text: " " }, { text: `${repo} · open pull requests`, bold: true }], filter ? `/${filter.trimStart()}▏` : plural(shown.length, "PR"), w, theme.accent) };
  const rows = shown.map((pr, k): Line => {
    const on = k === selected;
    const bar: Segment = { text: `${on ? "█" : "┃"} `, color: pr.requested ? theme.accent : theme.faint, bold: on };
    const num = `#${pr.number}`.padEnd(6);
    const check = CHECK[pr.checks];
    const right = [pr.requested ? "for you" : "", REVIEW[pr.review], pr.draft ? "draft" : "", `${plural(pr.files, "file")} +${pr.additions}/−${pr.deletions}`, pr.author].filter(Boolean).join(" · ");
    const titleW = Math.max(10, w - 2 - num.length - 2 - width(right) - 3);
    return { segments: [bar, { text: num, dim: !on }, { text: `${check.glyph} `, color: check.color }, { text: fit(pr.title, titleW), bold: on }, { text: " ".repeat(Math.max(1, w - 2 - num.length - 2 - width(fit(pr.title, titleW)) - width(right) - 1)) }, { text: right, dim: true }], card: k };
  });
  if (rows.length === 0) rows.push({ segments: [{ text: filter ? `  nothing matches "${filter}"` : "  no open pull requests", dim: true }] });
  return [header, ...rows];
}

export function matches(pr: PrSummary, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (f === "") return true;
  return [`#${pr.number}`, String(pr.number), pr.title, pr.author, pr.branch].some((s) => s.toLowerCase().includes(f));
}

/**
 * Pick an open PR to review. `j/k` move, `enter` picks, typing filters by number, title, author or
 * branch, `esc` clears the filter then quits, `q` quits. PRs awaiting your review come first and
 * carry the accent bar.
 */
export function Picker({ repo, prs, onPick, size }: PickerProps) {
  const { exit } = useApp();
  const w = size?.columns ?? process.stdout.columns ?? 80;
  const h = size?.rows ?? process.stdout.rows ?? 24;
  const [filter, setFilterState] = useState("");
  const [selected, setSelectedState] = useState(0);
  const state = useRef({ filter: "", selected: 0 });
  const set = (filter: string, selected: number) => {
    state.current = { filter, selected };
    setFilterState(filter);
    setSelectedState(selected);
  };
  const shown = prs.filter((pr) => matches(pr, filter));
  const sel = Math.max(0, Math.min(selected, shown.length - 1));

  // Single keys are commands while the filter is empty (j/k/q/g/G); anything else, including a pasted chunk, is filter text.
  useInput((input, key) => {
    const { filter: f, selected: s } = state.current;
    const visible = prs.filter((pr) => matches(pr, f));
    const cur = Math.max(0, Math.min(s, visible.length - 1));
    if (key.return) {
      onPick(visible[cur]);
      return exit();
    }
    if (key.escape) {
      if (f !== "") return set("", 0);
      onPick(undefined);
      return exit();
    }
    if (key.downArrow || (key.ctrl && input === "n") || (f === "" && input === "j")) return set(f, Math.min(visible.length - 1, cur + 1));
    if (key.upArrow || (key.ctrl && input === "p") || (f === "" && input === "k")) return set(f, Math.max(0, cur - 1));
    if (f === "" && input === "q") {
      onPick(undefined);
      return exit();
    }
    if (f === "" && input === "G") return set(f, visible.length - 1);
    if (f === "" && input === "g") return set(f, 0);
    // `/` opens the filter explicitly, as in a pager; typing does the same without it.
    if (f === "" && input === "/") return set(" ", 0);
    if (key.backspace || key.delete) return set([...f].slice(0, -1).join(""), 0);
    if (input && !key.ctrl && !key.meta) return set(f + input, 0);
  });

  const lines = pickerLines(repo, shown, sel, filter, w);
  const bodyH = Math.max(1, h - 3);
  const top = Math.max(0, Math.min(sel - Math.floor(bodyH / 2), lines.length - 1 - bodyH));
  const body = [lines[0]!, ...lines.slice(1 + top, 1 + top + bodyH)];
  const hint = filter ? "enter review · ↑/↓ move · esc clear" : "j/k move · enter review · / or type to filter · q quit";
  return (
    <Box flexDirection="column" width={w} height={h - 1}>
      {body.map((l, k) => (
        <Row key={k} line={l} w={w} selected={l.card === sel} />
      ))}
      {Array.from({ length: Math.max(0, bodyH + 1 - body.length) }, (_, k) => (
        <Row key={`pad${k}`} line={{ segments: [{ text: "" }] }} w={w} />
      ))}
      <Row line={{ segments: [{ text: ` ${fit(hint, w - 1)}`, dim: true }] }} w={w} />
    </Box>
  );
}

/** Run the picker full-screen; resolves with the chosen PR, or undefined when the user left. */
export async function runPicker(repo: string, prs: PrSummary[]): Promise<PrSummary | undefined> {
  let picked: PrSummary | undefined;
  await runFullscreen(<Picker repo={repo} prs={prs} onPick={(pr) => (picked = pr)} />);
  return picked;
}

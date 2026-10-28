import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewSession } from "../core/session.ts";
import type { Card, Review } from "../core/types.ts";
import { type CardContext, cardLines, changeExchanges, exchangeLines, expandedLines, fit, type Line, plural, progressLine, Row, type Segment, sides, width, wrap } from "./Card.tsx";
import { type Composer, composerKey, composerLines, openComposer } from "./Composer.tsx";
import { HELP_GLOSSARY, HELP_KEYS, keyAction, keyHelp, type Mode } from "./keys.ts";
import { theme } from "./theme.ts";

export interface Size {
  columns: number;
  rows: number;
}

export interface AppProps {
  session: ReviewSession;
  /** Fixed size for tests; otherwise follows the terminal. */
  size?: Size;
  /** Fixed spinner frame for tests. */
  frame?: number;
  /** Render throttle while events stream; 0 in tests so a frame follows each event. */
  throttleMs?: number;
}

/** Re-render at most ~10/s while events stream; immediately when idle. */
function useReview(session: ReviewSession, throttleMs: number): { review: Review; pending: boolean } {
  const [state, setState] = useState(() => ({ review: session.snapshot(), pending: true }));
  const pending = useRef(true);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      setState({ review: session.snapshot(), pending: pending.current });
    };
    const off = session.subscribe((e) => {
      if (e.type === "done") pending.current = false;
      if (!timer) timer = setTimeout(flush, throttleMs);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [session, throttleMs]);
  return state;
}

function useSize(override?: Size): Size {
  const { stdout } = useStdout();
  const read = () => override ?? { columns: stdout.columns || 80, rows: stdout.rows || 24 };
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (override) return;
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout, override]);
  return size;
}

function useFrame(active: boolean, override?: number): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active || override !== undefined) return;
    const t = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(t);
  }, [active, override]);
  return override ?? frame;
}

/** The visible slice of `lines` keeping the selected card fully visible when it fits, else its top. */
export function windowLines(lines: Line[], selected: number, height: number, prevTop: number): number {
  const first = lines.findIndex((l) => l.card === selected);
  if (first < 0) return Math.max(0, Math.min(prevTop, lines.length - height));
  let last = first;
  while (last + 1 < lines.length && lines[last + 1]!.card === selected) last++;
  let top = prevTop;
  if (first < top) top = first;
  if (last >= top + height) top = Math.min(first, last - height + 1);
  return Math.max(0, Math.min(top, Math.max(0, lines.length - height)));
}

export function App({ session, size: sizeOverride, frame: frameOverride, throttleMs = 100 }: AppProps) {
  const { exit } = useApp();
  const { review, pending } = useReview(session, throttleMs);
  const size = useSize(sizeOverride);
  const frame = useFrame(pending, frameOverride);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("stack");
  /** The help popup: which page and how far it is scrolled. */
  const [help, setHelp] = useState<{ page: "keys" | "glossary"; scroll: number }>();
  /** A pending vim prefix (`g`), kept across key events. */
  const prefix = useRef<string | undefined>(undefined);
  const [scroll, setScroll] = useState(0);
  const [top, setTop] = useState(0);
  /** The ask composer, while open. A ref mirrors it because several keys can arrive in one tick. */
  const [asking, setAskingState] = useState<Composer>();
  const askingRef = useRef(asking);
  const setAsking = (next: Composer | undefined) => {
    askingRef.current = next;
    setAskingState(next);
  };
  const openedAt = useRef(Date.now());

  const cards = review.cards;
  const sel = Math.max(0, Math.min(selected, cards.length - 1));
  const card: Card | undefined = cards[sel];
  const w = size.columns;
  const about = card ? `card ${sel + 1}` : "the change";
  const composer = asking ? composerLines(asking, about, w) : [];
  // Header, footer, one row spare for Ink, the progress row while the pipeline runs, and the composer while asking.
  const bodyH = Math.max(3, size.rows - 1 - 2 - (review.progress ? 1 : 0) - composer.length);

  const ctx: CardContext = { review, pending, frame };

  const stackLines = useMemo(() => {
    const out: Line[] = [];
    // Questions about the whole change sit above the cards, in the accent colour, like a conversation lane.
    const about = changeExchanges(review);
    if (about.length > 0) {
      for (const e of about) for (const segs of exchangeLines(e, w - 2, frame, "")) out.push({ segments: [{ text: "┃ ", color: theme.accent }, ...segs] });
      out.push({ segments: [{ text: "" }] });
    }
    cards.forEach((c, k) => {
      out.push(...cardLines(c, k, k === sel, w, ctx));
      out.push({ segments: [{ text: "" }], card: k });
    });
    if (review.untouched.length > 0) out.push({ segments: [{ text: "┃ ", color: theme.faint }, { text: "UNTOUCHED", color: theme.faint, bold: true }, { text: `  ${fit(review.untouched.join(" · "), w - 13)}`, dim: true }] });
    if (cards.length === 0) out.push({ segments: [{ text: "No edits in this change.", dim: true }] });
    return out;
  }, [review, sel, w, frame, pending]);

  const bodyLines = useMemo(
    () => (mode === "expanded" && card ? [...cardLines(card, sel, true, w, ctx), { segments: [{ text: "" }] }, ...expandedLines(card, w, ctx)] : stackLines),
    [mode, card, stackLines, w, frame],
  );
  const windowTop = mode === "stack" ? windowLines(bodyLines, sel, bodyH, top) : Math.max(0, Math.min(scroll, bodyLines.length - bodyH));
  useEffect(() => {
    if (mode === "stack" && windowTop !== top) setTop(windowTop);
  }, [windowTop, mode, top]);
  const visible = bodyLines.slice(windowTop, windowTop + bodyH);

  const send = (scope: "card" | "change", text: string) => {
    const cardId = scope === "card" && card && card.fixed !== "clean" ? card.id : undefined;
    void session.command({ type: "ask", text, ...(cardId ? { cardId } : {}) });
  };

  useInput((input, key) => {
    if (help) {
      if (key.escape || input === "?" || input === "q" || key.return) return setHelp(undefined);
      if (key.tab || input === "h" || input === "l" || key.leftArrow || key.rightArrow) return setHelp({ page: help.page === "keys" ? "glossary" : "keys", scroll: 0 });
      if (input === "j" || key.downArrow) return setHelp({ ...help, scroll: help.scroll + 1 });
      if (input === "k" || key.upArrow) return setHelp({ ...help, scroll: Math.max(0, help.scroll - 1) });
      return;
    }
    const open = askingRef.current;
    if (open) {
      const result = composerKey(open, input, key);
      if ("composer" in result) return setAsking(result.composer);
      if ("send" in result) send(result.scope, result.send);
      return setAsking(undefined);
    }
    const next = keyAction(input, key, prefix.current);
    prefix.current = next.pending;
    const action = next.action;
    if (!action) return;
    switch (action.type) {
      case "quit":
        return exit();
      case "help":
        return setHelp({ page: "keys", scroll: 0 });
      case "toggle":
        if (mode === "expanded") return setMode("stack");
        if (card && card.fixed !== "clean") {
          setScroll(0);
          setMode("expanded");
        }
        return;
      case "jump": {
        // Bands are runs of one colour in the (already sorted) stack; hot cards are red or amber.
        const hot = (c: Card) => c.color === "red" || c.color === "amber";
        const matches = (k: number) => (action.what === "hot" ? hot(cards[k]!) : cards[k]!.color !== cards[sel]!.color);
        let k = sel + action.delta;
        while (k >= 0 && k < cards.length && !matches(k)) k += action.delta;
        if (action.what === "band" && k >= 0 && k < cards.length && action.delta < 0) while (k > 0 && cards[k - 1]!.color === cards[k]!.color) k--;
        if (k >= 0 && k < cards.length) setSelected(k);
        return;
      }
      case "ask":
        return setAsking(openComposer(card && card.fixed !== "clean" ? "card" : "change", review.exchanges.map((e) => e.question)));
      case "expand":
        if (card && card.fixed !== "clean") {
          setScroll(0);
          setMode("expanded");
        }
        return;
      case "back":
        return setMode("stack");
      case "move":
      case "page":
      case "edge": {
        if (mode !== "stack") {
          const step = action.type === "move" ? action.delta : action.type === "page" ? Math.round(action.delta * (bodyH - 1)) : 0;
          const to = action.type === "edge" ? (action.to === "top" ? 0 : bodyLines.length) : scroll + step;
          return setScroll(Math.max(0, Math.min(to, Math.max(0, bodyLines.length - bodyH))));
        }
        const step = action.type === "move" ? action.delta : action.type === "page" ? Math.round(action.delta * 3) || Math.sign(action.delta) : 0;
        const to = action.type === "edge" ? (action.to === "top" ? 0 : cards.length - 1) : sel + step;
        return setSelected(Math.max(0, Math.min(to, cards.length - 1)));
      }
    }
  });

  const v = review.verdict;
  const title = review.changeSet.intent?.title ? `${review.changeSet.target} · ${review.changeSet.intent.title}` : review.changeSet.target;
  // Model name without its provider, and how long the pipeline has run; the stack is readable while that counter still moves.
  const model = review.rankedBy.replace(/^rules\+?/, "").split(":").pop();
  const headerRight = [
    v.tier.toUpperCase(),
    plural(v.requiredHumans, "human"),
    plural(cards.length, "card"),
    review.door.computed === "one-way" ? "one-way" : "",
    model ? model : "rules only",
    pending ? `${theme.spinner[frame % theme.spinner.length]} ${Math.round((Date.now() - openedAt.current) / 1000)}s` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const header: Line = { segments: sides([{ text: " " }, { text: fit(title, Math.max(10, w - headerRight.length - 4)), bold: true }], headerRight, w, theme.tier[v.tier]) };
  const footerText = review.warning ?? keyHelp(mode).map((h) => `${h.keys} ${h.label}`).join("  ·  ");
  const footer: Line = { segments: [{ text: " " }, { text: fit(footerText, w - 1), color: review.warning ? theme.card.amber : undefined, dim: !review.warning }] };

  return (
    <Box flexDirection="column" width={w} height={size.rows - 1}>
      <Row line={header} w={w} />
      {review.progress ? <Row line={{ segments: progressLine(review.progress, Date.now() - openedAt.current, w) }} w={w} /> : null}
      <Box flexDirection="column" height={bodyH}>
        {help
          ? helpLines(help, w, bodyH).map((l, k) => <Row key={k} line={l} w={w} />)
          : visible.map((l, k) => <Row key={k} line={l} w={w} selected={mode === "stack" && l.card === sel && l.segments.length > 1} />)}
        {!help && visible.length < bodyH ? Array.from({ length: bodyH - visible.length }, (_, k) => <Text key={`pad${k}`}> </Text>) : null}
      </Box>
      {composer.map((l, k) => (
        <Row key={`ask${k}`} line={l} w={w} />
      ))}
      <Row line={footer} w={w} />
    </Box>
  );
}

/**
 * The help popup: a bordered box centred in the body with two pages, keys and glossary, a tab
 * strip in the top border and a scroll hint in the bottom one. Drawn as plain rows so the same
 * code paints it in tests.
 */
function helpLines(help: { page: "keys" | "glossary"; scroll: number }, w: number, h: number): Line[] {
  const boxW = Math.min(w - 2, 104);
  const inner = boxW - 4;
  const left = Math.max(0, Math.floor((w - boxW) / 2));
  const pad = " ".repeat(left);
  const source = help.page === "keys" ? HELP_KEYS : HELP_GLOSSARY;
  // Rows keep their column spacing; only a row wider than the box wraps.
  const rows = source.flatMap((l) => (width(l) <= inner ? [l] : wrap(l, inner)));
  const bodyH = Math.max(1, Math.min(rows.length, h - 2));
  const top = Math.max(0, Math.min(help.scroll, rows.length - bodyH));
  const tabs = (page: "keys" | "glossary"): Segment => ({ text: ` ${page === "keys" ? "keys" : "glossary"} `, color: theme.accent, bold: help.page === page, inverse: help.page === page });
  const title: Segment[] = [{ text: `${pad}┌─`, color: theme.accent }, tabs("keys"), { text: "─", color: theme.accent }, tabs("glossary"), { text: "─ tab switches ", color: theme.accent, dim: true }];
  const titleW = width(title.map((s) => s.text).join(""));
  title.push({ text: "─".repeat(Math.max(0, left + boxW - titleW - 1)) + "┐", color: theme.accent });
  const more = rows.length > bodyH ? ` ${top + 1}–${top + bodyH} of ${rows.length} · j/k ` : "";
  const bottom = ` esc closes ${more}`;
  const foot: Segment[] = [{ text: `${pad}└`, color: theme.accent }, { text: bottom, color: theme.accent, dim: true }, { text: "─".repeat(Math.max(0, boxW - width(bottom) - 2)) + "┘", color: theme.accent }];
  const body = rows.slice(top, top + bodyH).map((r): Line => {
    const heading = /^[A-Z][a-z]+$/.test(r.trim()) && help.page === "keys";
    return { segments: [{ text: `${pad}│ `, color: theme.accent }, { text: r, bold: heading, color: heading ? theme.accent : undefined }, { text: " ".repeat(Math.max(0, inner - width(r))) }, { text: " │", color: theme.accent }] };
  });
  return [{ segments: title }, ...body, { segments: foot }];
}

const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
const LEAVE_ALT = "\x1b[?25h\x1b[?1049l";

/** Run the stack in the alternate screen; the terminal is restored on quit, signals and crashes. */
export async function runTui(session: ReviewSession, onExit: () => Promise<void>): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("the TUI needs a terminal; use --json for non-interactive output");
  process.stdout.write(ENTER_ALT);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write(LEAVE_ALT);
  };
  process.once("exit", restore);
  const onSignal = () => {
    instance.unmount();
    restore();
    process.exit(130);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  // No incrementalRendering: with a frame shorter than the terminal Ink 6.8's incremental
  // writer drifts one row per frame. Full redraws are wrapped in synchronized output on TTYs.
  const instance = render(<App session={session} />, { exitOnCtrlC: true, patchConsole: true });
  try {
    await instance.waitUntilExit();
  } finally {
    instance.cleanup();
    restore();
    await onExit();
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  }
}

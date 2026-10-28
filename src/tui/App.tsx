import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewSession } from "../core/session.ts";
import type { Card, Review } from "../core/types.ts";
import { type CardContext, cardLines, expandedLines, fit, type Line, plural, Row, sides } from "./Card.tsx";
import { HELP_LINES, keyAction, keyHelp, type Mode } from "./keys.ts";
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
  const [help, setHelp] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [top, setTop] = useState(0);
  const openedAt = useRef(Date.now());

  const cards = review.cards;
  const sel = Math.max(0, Math.min(selected, cards.length - 1));
  const card: Card | undefined = cards[sel];
  const w = size.columns;
  const bodyH = Math.max(3, size.rows - 1 - 2); // header, footer; one row spare for Ink

  const ctx: CardContext = { review, pending, frame };

  const stackLines = useMemo(() => {
    const out: Line[] = [];
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

  useInput((input, key) => {
    if (help) {
      if (key.escape || input === "?" || input === "q" || key.return) setHelp(false);
      return;
    }
    const action = keyAction(input, key);
    if (!action) return;
    switch (action.type) {
      case "quit":
        return exit();
      case "help":
        return setHelp(true);
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
          const step = action.type === "move" ? action.delta : action.type === "page" ? action.delta * (bodyH - 1) : 0;
          const to = action.type === "edge" ? (action.to === "top" ? 0 : bodyLines.length) : scroll + step;
          return setScroll(Math.max(0, Math.min(to, Math.max(0, bodyLines.length - bodyH))));
        }
        const step = action.type === "move" ? action.delta : action.type === "page" ? action.delta * 3 : 0;
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
      <Box flexDirection="column" height={bodyH}>
        {help
          ? HELP_LINES.slice(0, bodyH).map((l, k) => <Row key={k} line={{ segments: [{ text: ` ${fit(l, w - 1)}` }] }} w={w} />)
          : visible.map((l, k) => <Row key={k} line={l} w={w} selected={mode === "stack" && l.card === sel && l.segments.length > 1} />)}
        {!help && visible.length < bodyH ? Array.from({ length: bodyH - visible.length }, (_, k) => <Text key={`pad${k}`}> </Text>) : null}
      </Box>
      <Row line={footer} w={w} />
    </Box>
  );
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

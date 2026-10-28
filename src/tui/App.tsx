import { Box, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewSession } from "../core/session.ts";
import type { Card, Review } from "../core/types.ts";
import {
  type CardContext,
  cardLines,
  changeExchanges,
  exchangeLines,
  expandedLines,
  fit,
  type Line,
  plural,
  progressLine,
  Row,
  sides,
} from "./Card.tsx";
import { type Composer, composerKey, composerLines, openComposer } from "./Composer.tsx";
import { type HelpState, helpBox, helpKey, overlay } from "./Help.tsx";
import { jumpTarget, keyAction, keyHelp, type Mode } from "./keys.ts";
import { highlight, nextHit, openSearch, type Search, searchFooter, searchHits, searchKey } from "./Search.tsx";
import { runFullscreen } from "./screen.ts";
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
    // `read` is rebuilt every render; the effect only needs to re-subscribe when the stream or the override changes.
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
  const [help, setHelpState] = useState<HelpState>();
  const helpRef = useRef(help);
  const setHelp = (next: HelpState | undefined) => {
    helpRef.current = next;
    setHelpState(next);
  };
  /** A pending vim prefix (`g`), kept across key events. */
  const prefix = useRef<string | undefined>(undefined);
  const [scroll, setScroll] = useState(0);
  const [top, setTop] = useState(0);
  /** `/` search: typing or committed. Mirrored in a ref like the composer. */
  const [search, setSearchState] = useState<Search>();
  const searchRef = useRef(search);
  const setSearch = (next: Search | undefined) => {
    searchRef.current = next;
    setSearchState(next);
  };
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
      for (const e of about)
        for (const segs of exchangeLines(e, w - 2, frame, "")) out.push({ segments: [{ text: "┃ ", color: theme.accent }, ...segs] });
      out.push({ segments: [{ text: "" }] });
    }
    cards.forEach((c, k) => {
      out.push(...cardLines(c, k, k === sel, w, ctx));
      out.push({ segments: [{ text: "" }], card: k });
    });
    if (review.untouched.length > 0)
      out.push({
        segments: [
          { text: "┃ ", color: theme.faint },
          { text: "UNTOUCHED", color: theme.faint, bold: true },
          { text: `  ${fit(review.untouched.join(" · "), w - 13)}`, dim: true },
        ],
      });
    if (cards.length === 0) out.push({ segments: [{ text: "No edits in this change.", dim: true }] });
    return out;
    // Everything the rows read is derived from these; `ctx` and `cards` are themselves derived from `review`.
  }, [review, sel, w, frame, pending]);

  const bodyLines = useMemo(
    () =>
      mode === "expanded" && card
        ? [...cardLines(card, sel, true, w, ctx), { segments: [{ text: "" }] }, ...expandedLines(card, w, ctx)]
        : stackLines,
    [mode, card, stackLines, w, sel, ctx],
  );
  const hits = search ? searchHits(bodyLines, search.query) : [];
  // In the stack a hit is a card; the selection follows the search. In the expanded view hits are rows and the scroll follows.
  const hitCards = [...new Set(hits.map((h) => bodyLines[h]!.card).filter((c): c is number => c !== undefined))];
  const windowTop = mode === "stack" ? windowLines(bodyLines, sel, bodyH, top) : Math.max(0, Math.min(scroll, bodyLines.length - bodyH));
  useEffect(() => {
    if (mode === "stack" && windowTop !== top) setTop(windowTop);
  }, [windowTop, mode, top]);
  const visible = bodyLines.slice(windowTop, windowTop + bodyH).map((l) => (search ? highlight(l, search.query) : l));
  /** Live search: the selection (or scroll) lands on the first match as the query grows. */
  const followSearch = (query: string) => {
    const live = searchHits(bodyLines, query);
    if (live.length === 0) return;
    if (mode === "stack") {
      const c = bodyLines[live[0]!]!.card;
      if (c !== undefined) setSelected(c);
    } else setScroll(Math.max(0, Math.min(live[0]!, Math.max(0, bodyLines.length - bodyH))));
  };
  const jumpToHit = (direction: 1 | -1) => {
    if (mode === "stack") {
      const to = nextHit(
        hitCards.sort((a, b) => a - b),
        sel,
        direction,
      );
      if (to !== undefined) setSelected(to);
      return;
    }
    const to = nextHit(hits, direction > 0 ? scroll : scroll, direction);
    if (to !== undefined) setScroll(Math.max(0, Math.min(to, Math.max(0, bodyLines.length - bodyH))));
  };

  const send = (scope: "card" | "change", text: string) => {
    const cardId = scope === "card" && card && card.fixed !== "clean" ? card.id : undefined;
    void session.command({ type: "ask", text, ...(cardId ? { cardId } : {}) });
  };

  useInput((input, key) => {
    const shown = helpRef.current;
    if (shown) return setHelp(helpKey(shown, input, key, w));
    const open = askingRef.current;
    if (open) {
      const result = composerKey(open, input, key);
      if ("composer" in result) return setAsking(result.composer);
      if ("send" in result) send(result.scope, result.send);
      return setAsking(undefined);
    }
    const typing = searchRef.current;
    if (typing?.open) {
      const result = searchKey(typing, input, key);
      if ("close" in result) return setSearch(undefined);
      if ("commit" in result) return setSearch(result.commit);
      setSearch(result.search);
      return followSearch(result.search.query);
    }
    // A committed search: esc clears it before anything else sees the key.
    if (typing && key.escape) return setSearch(undefined);
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
        const to = jumpTarget(
          cards.map((c) => c.color),
          sel,
          action.delta,
          action.what,
        );
        if (to !== undefined) setSelected(to);
        return;
      }
      case "search":
        return setSearch(openSearch(searchRef.current));
      case "hit":
        return jumpToHit(action.delta);
      case "ask":
        return setAsking(
          openComposer(
            card && card.fixed !== "clean" ? "card" : "change",
            review.exchanges.map((e) => e.question),
          ),
        );
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
        const step =
          action.type === "move" ? action.delta : action.type === "page" ? Math.round(action.delta * 3) || Math.sign(action.delta) : 0;
        const to = action.type === "edge" ? (action.to === "top" ? 0 : cards.length - 1) : sel + step;
        return setSelected(Math.max(0, Math.min(to, cards.length - 1)));
      }
    }
  });

  // The body is always bodyH rows; the help popup is painted over them rather than replacing them.
  const padded: Line[] = [
    ...visible,
    ...Array.from({ length: Math.max(0, bodyH - visible.length) }, (): Line => ({ segments: [{ text: "" }] })),
  ];
  const body = help ? (({ lines, left, top }) => overlay(padded, lines, left, top, w))(helpBox(help, w, bodyH)) : padded;

  const v = review.verdict;
  const title = review.changeSet.intent?.title ? `${review.changeSet.target} · ${review.changeSet.intent.title}` : review.changeSet.target;
  // Model name without its provider, and how long the pipeline has run; the stack is readable while that counter still moves.
  const model = review.rankedBy
    .replace(/^rules\+?/, "")
    .split(":")
    .pop();
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
  const header: Line = {
    segments: sides(
      [{ text: " " }, { text: fit(title, Math.max(10, w - headerRight.length - 4)), bold: true }],
      headerRight,
      w,
      theme.tier[v.tier],
    ),
  };
  const footerText =
    review.warning ??
    keyHelp(mode)
      .map((h) => `${h.keys} ${h.label}`)
      .join("  ·  ");
  const hitAt = search && !search.open ? (mode === "stack" ? hitCards.indexOf(sel) : hits.findIndex((h) => h >= windowTop)) : -1;
  const footer: Line = search
    ? { segments: searchFooter(search, mode === "stack" ? hitCards.length : hits.length, hitAt >= 0 ? hitAt : undefined) }
    : {
        segments: [
          { text: " " },
          { text: fit(footerText, w - 1), color: review.warning ? theme.card.amber : undefined, dim: !review.warning },
        ],
      };

  return (
    <Box flexDirection="column" width={w} height={size.rows - 1}>
      <Row line={header} w={w} />
      {review.progress ? <Row line={{ segments: progressLine(review.progress, Date.now() - openedAt.current, w) }} w={w} /> : null}
      <Box flexDirection="column" height={bodyH}>
        {body.map((l, k) => (
          <Row key={k} line={l} w={w} selected={!help && mode === "stack" && l.card === sel && l.segments.length > 1} />
        ))}
      </Box>
      {composer.map((l, k) => (
        <Row key={`ask${k}`} line={l} w={w} />
      ))}
      <Row line={footer} w={w} />
    </Box>
  );
}

/** Run the stack full-screen; `onExit` runs after the terminal is restored. */
export async function runTui(session: ReviewSession, onExit: () => Promise<void>): Promise<void> {
  try {
    await runFullscreen(<App session={session} />);
  } finally {
    await onExit();
  }
}

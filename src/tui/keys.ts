import type { Key } from "ink";

export type Mode = "stack" | "expanded";

export type Action =
  | { type: "move"; delta: 1 | -1 }
  /** `delta` in pages: ±1 a full page, ±0.5 half (ctrl-d/u). */
  | { type: "page"; delta: number }
  | { type: "edge"; to: "top" | "bottom" }
  /** Jump to the next/previous card of a different colour band (`]`/`[`), or the next/previous red or amber card (`}`/`{`). */
  | { type: "jump"; delta: 1 | -1; what: "band" | "hot" }
  | { type: "expand" }
  | { type: "back" }
  | { type: "toggle" }
  | { type: "ask" }
  | { type: "search" }
  /** `n` / `N`: next or previous search hit. */
  | { type: "hit"; delta: 1 | -1 }
  | { type: "help" }
  | { type: "quit" };

/**
 * Vim and helix keys where they fit a list: j/k, J/K and ctrl-d/u for pages, gg/G, [ ] and { } to jump,
 * l/h or enter/esc in and out, o or space to toggle, / n N search as in every pager. `g` is a prefix
 * (gg = top, ge = end as in helix); the caller keeps the pending prefix between calls. `a` asks.
 */
export function keyAction(input: string, key: Key, pending?: string): { action?: Action; pending?: string } {
  if (pending === "g") {
    if (input === "g") return { action: { type: "edge", to: "top" } };
    if (input === "e") return { action: { type: "edge", to: "bottom" } };
    return {};
  }
  if (input === "g") return { pending: "g" };
  const a = (action: Action) => ({ action });
  if (input === "j" || key.downArrow || (key.ctrl && input === "n")) return a({ type: "move", delta: 1 });
  if (input === "k" || key.upArrow || (key.ctrl && input === "p")) return a({ type: "move", delta: -1 });
  if (input === "J" || key.pageDown || (key.ctrl && input === "f")) return a({ type: "page", delta: 1 });
  if (input === "K" || key.pageUp || (key.ctrl && input === "b")) return a({ type: "page", delta: -1 });
  if (key.ctrl && input === "d") return a({ type: "page", delta: 0.5 });
  if (key.ctrl && input === "u") return a({ type: "page", delta: -0.5 });
  if (input === "G" || key.end) return a({ type: "edge", to: "bottom" });
  if (key.home) return a({ type: "edge", to: "top" });
  if (input === "]") return a({ type: "jump", delta: 1, what: "band" });
  if (input === "[") return a({ type: "jump", delta: -1, what: "band" });
  if (input === "}") return a({ type: "jump", delta: 1, what: "hot" });
  if (input === "{") return a({ type: "jump", delta: -1, what: "hot" });
  if (key.return || input === "l" || key.rightArrow) return a({ type: "expand" });
  if (key.escape || input === "h" || key.leftArrow) return a({ type: "back" });
  if (input === "o" || input === " ") return a({ type: "toggle" });
  if (input === "a") return a({ type: "ask" });
  if (input === "/") return a({ type: "search" });
  if (input === "n") return a({ type: "hit", delta: 1 });
  if (input === "N") return a({ type: "hit", delta: -1 });
  if (input === "?") return a({ type: "help" });
  if (input === "q") return a({ type: "quit" });
  return {};
}

/**
 * Where `]`/`[` (next colour band) or `}`/`{` (next red or amber card) land from `sel` in a stack
 * already sorted by colour; `undefined` when there is nothing further that way.
 */
export function jumpTarget(colors: string[], sel: number, delta: 1 | -1, what: "band" | "hot"): number | undefined {
  const hot = (c: string) => c === "red" || c === "amber";
  const matches = (k: number) => (what === "hot" ? hot(colors[k]!) : colors[k] !== colors[sel]);
  let k = sel + delta;
  while (k >= 0 && k < colors.length && !matches(k)) k += delta;
  if (k < 0 || k >= colors.length) return undefined;
  // Going up into a band lands on its first card, so repeated `[` walks band by band.
  if (what === "band" && delta < 0) while (k > 0 && colors[k - 1] === colors[k]) k--;
  return k;
}

export interface KeyHelp {
  keys: string;
  label: string;
}

export function keyHelp(mode: Mode): KeyHelp[] {
  const nav =
    mode === "stack"
      ? [
          { keys: "j/k", label: "card" },
          { keys: "enter", label: "expand" },
          { keys: "{/}", label: "next hot" },
        ]
      : [
          { keys: "j/k", label: "scroll" },
          { keys: "ctrl-d/u", label: "half page" },
          { keys: "esc", label: "back" },
        ];
  return [...nav, { keys: "/", label: "search" }, { keys: "a", label: "ask" }, { keys: "?", label: "help" }, { keys: "q", label: "quit" }];
}

/** The help popup: a keys page and a glossary page; `tab` switches, `j/k` scroll. */
export const HELP_KEYS: readonly string[] = [
  "Move",
  "  j/k  ↓/↑  ctrl-n/p   next / previous card · scroll when expanded",
  "  J/K  ctrl-f/b        page down / up            ctrl-d/u   half page",
  "  gg / G  (ge)         first / last card",
  "  ] / [                next / previous colour band (red → amber → green)",
  "  } / {                next / previous red or amber card",
  "",
  "Open",
  "  enter  l  →          expand the card: scope, tests, door signals, then its diff",
  "  o  space             toggle expanded / stack",
  "  esc  h  ←            back to the stack",
  "",
  "Search",
  "  /                    search the stack (titles, paragraphs, files) or the expanded card's diff",
  "    enter / esc        keep the query / clear it      n / N   next / previous match",
  "  Matches are highlighted; the footer counts them.",
  "",
  "Ask",
  "  a                    a box opens above the keys, about the selected card",
  "    tab                switch between this card and the whole change",
  "    enter / esc        send / close        ↑/↓  earlier questions",
  "    ←/→  ctrl-a/e      move the cursor     ctrl-w/u  delete word / line",
  "  Answers are written from the diff and checked; an unverified answer says so.",
  "",
  "  ?                    this help · tab for the glossary",
  "  q                    quit",
];

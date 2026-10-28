import type { Key } from "ink";

export type Mode = "stack" | "expanded";

export type Action =
  | { type: "move"; delta: 1 | -1 }
  | { type: "page"; delta: 1 | -1 }
  | { type: "edge"; to: "top" | "bottom" }
  | { type: "expand" }
  | { type: "back" }
  | { type: "ask" }
  | { type: "help" }
  | { type: "quit" };

export function keyAction(input: string, key: Key): Action | undefined {
  if (input === "j" || key.downArrow) return { type: "move", delta: 1 };
  if (input === "k" || key.upArrow) return { type: "move", delta: -1 };
  if (input === "J" || key.pageDown || input === " ") return { type: "page", delta: 1 };
  if (input === "K" || key.pageUp) return { type: "page", delta: -1 };
  if (input === "g" || key.home) return { type: "edge", to: "top" };
  if (input === "G" || key.end) return { type: "edge", to: "bottom" };
  if (key.return || input === "l" || key.rightArrow) return { type: "expand" };
  if (key.escape || input === "h" || key.leftArrow) return { type: "back" };
  if (input === "/") return { type: "ask" };
  if (input === "?") return { type: "help" };
  if (input === "q") return { type: "quit" };
  return undefined;
}

export interface KeyHelp {
  keys: string;
  label: string;
}

export function keyHelp(mode: Mode): KeyHelp[] {
  const nav = mode === "stack" ? [{ keys: "j/k", label: "card" }, { keys: "enter", label: "expand" }] : [{ keys: "j/k", label: "scroll" }, { keys: "J/K", label: "page" }, { keys: "esc", label: "back" }];
  return [...nav, { keys: "/", label: "ask" }, { keys: "?", label: "keys" }, { keys: "q", label: "quit" }];
}

export const HELP_LINES: readonly string[] = [
  "j/k ↓/↑      move between cards · scroll when expanded",
  "J/K space    page",
  "g/G          first / last",
  "enter l →    expand the card: its door signals and its diff",
  "esc h ←      back to the stack",
  "/            ask about the selected card; press / again on an empty line to ask about the whole change",
  "             enter sends, esc cancels; answers come from the diff and are checked, unverified ones say so",
  "?            this list",
  "q            quit",
];

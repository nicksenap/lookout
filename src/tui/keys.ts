import type { Key } from "ink";

export type Mode = "stack" | "expanded" | "claims";

export type Action =
  | { type: "move"; delta: 1 | -1 }
  | { type: "page"; delta: 1 | -1 }
  | { type: "edge"; to: "top" | "bottom" }
  | { type: "expand" }
  | { type: "back" }
  | { type: "claims" }
  | { type: "review" }
  | { type: "reviewAll" }
  | { type: "cancel" }
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
  if (input === "a") return { type: "review" };
  if (input === "c") return { type: "claims" };
  if (input === "A") return { type: "reviewAll" };
  if (input === "x") return { type: "cancel" };
  if (input === "?") return { type: "help" };
  if (input === "q") return { type: "quit" };
  return undefined;
}

export interface KeyHelp {
  keys: string;
  label: string;
}

export function keyHelp(mode: Mode, running: boolean, dispatchable: boolean, claims = false): KeyHelp[] {
  const out: KeyHelp[] = [];
  if (mode === "stack") {
    out.push({ keys: "j/k", label: "card" }, { keys: "enter", label: "expand" });
    if (dispatchable) out.push({ keys: "a", label: "review card" }, { keys: "A", label: "review all" });
    if (claims) out.push({ keys: "c", label: "claims" });
  } else if (mode === "claims") out.push({ keys: "j/k", label: "scroll" }, { keys: "esc", label: "back" });
  else {
    out.push({ keys: "j/k", label: "scroll" }, { keys: "J/K", label: "page" }, { keys: "esc", label: "back" });
    if (dispatchable) out.push({ keys: "a", label: "review card" });
  }
  if (running) out.push({ keys: "x", label: "cancel" });
  out.push({ keys: "?", label: "keys" }, { keys: "q", label: "quit" });
  return out;
}

export const HELP_LINES: readonly string[] = [
  "j/k ↓/↑      move between cards · scroll when expanded",
  "J/K space    page",
  "g/G          first / last",
  "enter l →    expand the card: its diff, findings, agent log",
  "esc h ←      back to the stack",
  "c            claims: the PR description against the diff, door and blast radius",
  "a            review this card with the default agent (proposer)",
  "A            review every red and amber card, one after another",
  "x            cancel the running review",
  "?            this list",
  "q            quit",
];

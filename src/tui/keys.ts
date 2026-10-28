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
  | { type: "help" }
  | { type: "quit" };

/**
 * Vim and helix keys where they fit a list: j/k, J/K and ctrl-d/u for pages, gg/G, [ ] and { } to jump,
 * l/h or enter/esc in and out, o or space to toggle. `g` is a prefix (gg = top, ge = end as in helix);
 * the caller keeps the pending prefix between calls. `a` asks: `/` is left for search, as in every pager.
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
  if (input === "?") return a({ type: "help" });
  if (input === "q") return a({ type: "quit" });
  return {};
}

export interface KeyHelp {
  keys: string;
  label: string;
}

export function keyHelp(mode: Mode): KeyHelp[] {
  const nav = mode === "stack" ? [{ keys: "j/k", label: "card" }, { keys: "enter", label: "expand" }, { keys: "{/}", label: "next hot" }] : [{ keys: "j/k", label: "scroll" }, { keys: "ctrl-d/u", label: "half page" }, { keys: "esc", label: "back" }];
  return [...nav, { keys: "a", label: "ask" }, { keys: "?", label: "help" }, { keys: "q", label: "quit" }];
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

export const HELP_GLOSSARY: readonly string[] = [
  "Card           one logical change, from edit blocks across any files; the unit you review.",
  "               Two fixed cards: verified clean (every inert edit) and untouched (sensitive areas not reached).",
  "Edit block     one contiguous run of +/- lines; the smallest unit lookout reasons about.",
  "Colour         a rule, never an opinion.  RED: suspicious, or behaviour inside a sensitive area, or a one-way",
  "               edit that needs eyes.  AMBER: needs eyes, config/deps/CI, or a one-way signal.  GREEN: fine.",
  "               GREY: verified clean.  Tests, renames and docs inside an area stay green and keep the badge.",
  "Attention      per edit: inert · routine · needs-eyes · suspicious.  A model may raise it, never lower it.",
  "Kind           what an edit does: behavior, typing-refactor, rename, move, test, types, config, docs.",
  "Mechanical     a rename / typing / move card whose label rules confirmed (one-to-one identifier swap,",
  "               type-only edit, verbatim move).  Its sentence is a template; anything else is behaviour.",
  "Area           a named set of sensitive paths from the repo's policy (auth, billing, data, infra, prompts).",
  "Verdict        header: risk tier (low · medium · high) and how many humans must review, with reasons.",
  "One-way        a door signal in the diff: migration, destructive SQL, in-place data write, removed public",
  "               export or route, contract change.  Attached to the card that owns the line; raises its colour.",
  "Scope          the declarations and keys enclosing an edit at head: DEPLOYMENTS › stage › servedTools.",
  "tests touched  a test card in this change exercises this card's files (same dir, name stem or import).",
  "covers         on a test card: the cards it exercises.",
  "unverified     the paragraph (or an answer) failed its check twice: a name not in the edits, or Decisions",
  "               put under 70 % on 'every statement follows from the edits'.  Shown dimmed; read the diff.",
  "Exchange       a question you asked (a) and its answer, written from that scope's edits only.",
  "Progress       the bar under the header while cards load: ranking → splitting → writing.",
  "--evidence     JSON-only for now: PR claims graded against the diff, unmentioned cards, review questions.",
];

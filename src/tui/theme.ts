import type { CardColor, Severity, Tier } from "../core/types.ts";

/** Semantic tokens; choose by role, not by the color's current look. */
export const theme = {
  card: { red: "#ff5f5f", amber: "#ffb000", green: "#5fd75f", grey: "#6c6c6c" } satisfies Record<CardColor, string>,
  tier: { low: "#5fd75f", medium: "#ffb000", high: "#ff5f5f" } satisfies Record<Tier, string>,
  severity: { p0: "#ff5f5f", p1: "#ffb000", p2: "#87afff" } satisfies Record<Severity, string>,
  accent: "#87afff",
  text: "#e4e4e4",
  dim: "#8a8a8a",
  faint: "#585858",
  add: "#5fd75f",
  del: "#ff5f5f",
  context: "#8a8a8a",
  selectedBg: "#1c1c1c",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const;

export const COLOR_LABEL: Record<CardColor, string> = { red: "RED", amber: "AMBER", green: "GREEN", grey: "GREY" };

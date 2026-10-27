export type Attention = "inert" | "routine" | "needs-eyes" | "suspicious";
export const ATTENTION_ORDER: readonly Attention[] = ["inert", "routine", "needs-eyes", "suspicious"];

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
  oldLine?: number;
  newLine?: number;
  /** "\ No newline at end of file" followed this line. */
  noNewlineAtEof?: boolean;
}

export interface Hunk {
  id: string;
  path: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /** Contiguous runs of changed lines; the unit lookout judges. Derived from `lines`. */
  blocks: EditBlock[];
  /** Derived from `blocks`: union of path labels, content label only if every block has one. */
  labels: string[];
  /** Derived from `blocks`: the highest attention and score among them. */
  attention: Attention;
  score: number;
}

/**
 * One contiguous run of added and/or removed lines inside a hunk. A git hunk fuses
 * edits that are within a few lines of each other; edit blocks undo that.
 */
export interface EditBlock {
  id: string;
  hunkId: string;
  path: string;
  /** Index range into the hunk's `lines`, `from` inclusive, `to` exclusive. */
  from: number;
  to: number;
  /** Line ranges on each side, inclusive; `undefined` when the block has no lines on that side. */
  oldRange?: { start: number; end: number };
  newRange?: { start: number; end: number };
  labels: string[];
  attention: Attention;
  score: number;
  /** What the edit does, from the model's kind question; absent under rules-only ranking. */
  kind?: BlockKind;
}

export type BlockKind = "typing-refactor" | "rename" | "move" | "behavior" | "test" | "types" | "config" | "docs";

export interface FileChange {
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
}

export interface Intent {
  title: string;
  body: string;
}

export interface ChangeSet {
  target: string;
  base: string;
  head: string;
  files: FileChange[];
  intent?: Intent;
}

export type Severity = "p0" | "p1" | "p2";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  body: string;
  anchor?: { path: string; line: number };
  dispatcher: string;
}

export type DispatchStatus = "running" | "done" | "failed" | "cancelled";

export interface Dispatch {
  id: string;
  dispatcher: string;
  scope: "hunk" | "card" | "change";
  /** Hunk id when scope is "hunk". */
  hunkId?: string;
  /** Card id when scope is "card". */
  cardId?: string;
  cmd: string;
  status: DispatchStatus;
  output: string;
  findings: Finding[];
  /** Output that is not a findings block (freeform text, parse errors). */
  freeform?: string;
  error?: string;
}

// ---------------------------------------------------------------- cards

/** A card's risk: red needs a human, amber is worth a look, green is fine, grey is verified clean. */
export type CardColor = "red" | "amber" | "green" | "grey";
export const COLOR_ORDER: readonly CardColor[] = ["grey", "green", "amber", "red"];

/** One logical change, made of edit blocks from any files. The unit a human reviews. */
export interface Card {
  id: string;
  title: string;
  color: CardColor;
  kind: ChangeKind;
  /** Policy areas touched by this card's blocks. */
  areas: string[];
  /** Union of block labels (test, docs, sensitive, …), without the content labels. */
  labels: string[];
  blockIds: string[];
  /** Highest attention and score among the card's blocks. */
  attention: Attention;
  score: number;
  /** Written by the writer model from this card's blocks, or by a template for mechanical cards; absent until then. */
  paragraph?: string;
  /** The kind every block in the card shares (from the model), when they do. */
  blockKind?: BlockKind;
  /** Types/renames/moves only: titled and described deterministically, no model call. */
  mechanical?: boolean;
  /** The fixed card that collects every inert block. */
  fixed?: "clean";
}

export interface Review {
  changeSet: ChangeSet;
  classification: Classification;
  verdict: Verdict;
  /** Riskiest first; the "clean" card last. Every block is in exactly one card. */
  cards: Card[];
  /** Policy areas no file of the change touches. */
  untouched: string[];
  dispatches: Dispatch[];
  rankedBy: string; // "rules" | `rules+${model}`
  warning?: string;
}

// ---------------------------------------------------------------- change-level

export type ChangeKind = "docs" | "test" | "deps" | "ci" | "config" | "additive" | "logic";

/** What the whole change is, derived from its blocks (rules now, model later). */
export interface Classification {
  kind: ChangeKind;
  /** Named sensitive areas (from policy) touched by any non-inert block. */
  areas: string[];
  /** Highest attention among blocks. */
  maxAttention: Attention;
  /** Blocks whose path matched the built-in sensitive-word heuristic, by path. */
  sensitivePaths: string[];
  counts: { files: number; blocks: number; inert: number };
}

export type Tier = "low" | "medium" | "high";
export const TIER_ORDER: readonly Tier[] = ["low", "medium", "high"];

export interface Verdict {
  tier: Tier;
  requiredHumans: 0 | 1 | 2;
  /** One line per rule or floor that contributed, most severe first. */
  reasons: string[];
}

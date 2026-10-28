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
  /** The model's mechanical label when rules could not confirm it and `kind` fell back to `behavior`. */
  suggestedKind?: BlockKind;
  /** Declarations and object keys enclosing the first changed line at head, outermost first (rank/scope.ts). */
  scope?: string[];
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

/** Starts `proposed`; a verifier makes it `confirmed` (with evidence), `rejected` (with a reason) or `unsure`. */
export type FindingStatus = "proposed" | "confirmed" | "rejected" | "unsure";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  body: string;
  anchor?: { path: string; line: number };
  dispatcher: string;
  status: FindingStatus;
  /** Anchored to a context line: about code the change did not touch. */
  preExisting: boolean;
  /** The verifier's evidence (confirmed) or reason (rejected); `duplicate of …` when dedupe dropped it. */
  verifierNote?: string;
  /** Which dispatcher verified it. */
  verifiedBy?: string;
  /** Decisions' probability that the verifier's argument holds; absent when no model scored it. */
  confidence?: number;
}

/** What a verifier said about one finding, as parsed from its output. */
export interface FindingVerdict {
  findingId: string;
  verdict: "confirmed" | "rejected" | "unsure";
  /** Evidence for confirmed, reason for rejected or unsure. */
  note?: string;
}

export type DispatchStatus = "running" | "done" | "failed" | "cancelled";
export type DispatchRole = "proposer" | "verifier";

export interface Dispatch {
  id: string;
  dispatcher: string;
  role: DispatchRole;
  scope: "hunk" | "card" | "change";
  /** Hunk id when scope is "hunk". */
  hunkId?: string;
  /** Card id when scope is "card". */
  cardId?: string;
  cmd: string;
  status: DispatchStatus;
  output: string;
  /** Proposer dispatches only; a verifier patches the findings of the proposer dispatches it checked. */
  findings: Finding[];
  /** Verifier dispatches only: the finding ids it was asked about and what it said. */
  verifies?: string[];
  verdicts?: FindingVerdict[];
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
  /** Paths of the card's blocks, in diff order; derived, for readers of the JSON. */
  files: string[];
  /** Highest attention and score among the card's blocks. */
  attention: Attention;
  score: number;
  /** Written by the writer model from this card's blocks, or by a template for mechanical cards; absent until then. */
  paragraph?: string;
  /** The kind every block in the card shares (from the model), when they do. */
  blockKind?: BlockKind;
  /** Types/renames/moves only: titled and described deterministically, no model call. */
  mechanical?: boolean;
  /** Working title from the split step, when the card is one concern of a larger group; the writer refines it. */
  hint?: string;
  /** Decisions' probability that every sentence of the paragraph follows from the card's edits; set after the gate ran. */
  proseCheck?: number;
  /** The paragraph failed the gate twice: shown dimmed and labelled, not trusted. */
  unverified?: boolean;
  /** The fixed card that collects every inert block. */
  fixed?: "clean";
  // ---- evidence (plan step 12)
  /** Claims whose evidence choice landed on this card. */
  claimIds: string[];
  /** The author made claims, none of them points here, and the card needs eyes or more. */
  unmentioned: boolean;
  /** A test card in this change exercises this card's files (same dir, name stem or import). Test cards: false. */
  testsTouched: boolean;
  /** Test cards only: the non-test cards whose files they exercise. */
  covers?: string[];
  /** One-way door signals found in this card's edits. */
  doorSignals?: DoorSignal[];
  // ---- questions (plan step 13)
  /** 2–4 yes/no prompts for the human, picked from the tier bank once the evidence has landed. */
  questions: Question[];
}

export type QuestionAnswer = "yes" | "no" | "unsure";
export interface Question {
  /** The bank entry's id; stable across runs so answers could be kept later. */
  id: string;
  text: string;
  answer?: QuestionAnswer;
}

// ---------------------------------------------------------------- evidence

/**
 * One checkable statement the author makes. `status` is absent until grounded. `unclear` is the
 * confidence gate: a `contradicted` under 0.7 or any answer under 0.4 is shown as unclear, not red.
 */
export type ClaimStatus = "supported" | "contradicted" | "not-in-diff" | "unclear";
export type ClaimSection = "summary" | "evidence" | "door" | "radius";
export interface Claim {
  id: string;
  text: string;
  section: ClaimSection;
  status?: ClaimStatus;
  /** Probability the model put on the chosen status (1 for rule-derived statuses). */
  confidence?: number;
  /** The card the evidence points to, when the model picked one. */
  cardId?: string;
}

export type DoorKind = "one-way" | "two-way";
/** A reason the change is hard to undo, anchored to a line when it comes from the diff. */
export interface DoorSignal {
  kind: "migration" | "destructive-sql" | "data-write" | "removed-export" | "removed-route" | "contract";
  path: string;
  line?: number;
  /** Which side `line` numbers: removed-* signals point at old lines, writes at new ones. */
  side?: "old" | "new";
  /** A one-line reason a reviewer can read, not the code. */
  text: string;
}
export interface Door {
  /** What the author wrote, when the body says one-way/two-way (or reversible/irreversible). */
  author?: DoorKind;
  /** One-way when any signal exists. Rules only. */
  computed: DoorKind;
  signals: DoorSignal[];
}

export interface Radius {
  /** The author's word from a `Blast Radius:` line, when present. */
  author?: string;
  /** Policy areas touched by non-inert blocks (same as the classification). */
  areas: string[];
  /** Kept for saved reviews written before importers were removed; never set now. */
  importers?: string[];
  warning?: string;
}

/** A free question from the reviewer about one card or the whole change, and the model's grounded answer. */
export interface Exchange {
  id: string;
  /** Absent: the question is about the whole change. */
  cardId?: string;
  question: string;
  answer?: string;
  status: "pending" | "answered" | "failed";
  /** Decisions' probability that the answer follows from the edits it was given; below the gate it is shown unverified. */
  check?: number;
  unverified?: boolean;
  error?: string;
}

/** Where the pipeline is, for a progress bar: items done of total in the current phase. */
export interface Progress {
  phase: "ranking" | "splitting" | "writing";
  done: number;
  total: number;
}

/** One row of the PR picker (sources/github.ts fills it; the TUI only reads it). */
export interface PrSummary {
  number: number;
  title: string;
  author: string;
  branch: string;
  draft: boolean;
  files: number;
  additions: number;
  deletions: number;
  /** `pass`, `fail`, `pending` or `none` from the status rollup. */
  checks: "pass" | "fail" | "pending" | "none";
  /** GitHub's review decision: approved, changes requested, review required, or none. */
  review: "approved" | "changes" | "required" | "none";
  /** Open PRs you are asked to review come first. */
  requested: boolean;
  updatedAt: string;
  /** `owner/repo#N`, the target lookout accepts. */
  target: string;
}

export interface Review {
  changeSet: ChangeSet;
  classification: Classification;
  verdict: Verdict;
  /** Riskiest first; the "clean" card last. Every block is in exactly one card. */
  cards: Card[];
  /** Policy areas no file of the change touches. */
  untouched: string[];
  claims: Claim[];
  door: Door;
  radius: Radius;
  dispatches: Dispatch[];
  rankedBy: string; // "rules" | `rules+${model}`
  /** `--evidence`: claims, grounding, unmentioned, questions and agent dispatch were run. Off by default. */
  evidence: boolean;
  /** Reviewer questions answered from the diff, newest last. */
  exchanges: Exchange[];
  /** Present while the pipeline runs; removed on done. */
  progress?: Progress;
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
  /** The diff shows a one-way door signal (migration, data write, removed export or route, contract). */
  oneWay: boolean;
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

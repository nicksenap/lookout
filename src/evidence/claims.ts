import { allBlocks, blockText } from "../core/blocks.ts";
import { attemptAsync } from "../core/result.ts";
import {
  ATTENTION_ORDER,
  type Card,
  type ChangeSet,
  type Claim,
  type ClaimSection,
  type ClaimStatus,
  type Door,
  type DoorKind,
  type Intent,
  type Radius,
} from "../core/types.ts";
import { RankCache } from "../rank/cache.ts";
import {
  type ClaimJudgement,
  type Env,
  type GroundCard,
  groundClaimBatch,
  type ModelClaimStatus,
  type ResolvedModel,
  resolveAttentionModel,
  resolveWriter,
  writeText,
} from "../rank/model.ts";

/**
 * Claims are the author's `- ` bullets, one claim each, tagged by the section they sit under.
 * A `/pr` body's `Door:` and `Blast Radius:` lines become one claim each. Measured: splitting
 * bullets takes 0.4 ms where LLM extraction took 18 s, so the model is only asked when a body
 * has prose and no bullets at all (`needsModelExtraction`).
 */
export function extractClaims(intent: Intent | undefined): Claim[] {
  if (!intent?.body.trim()) return [];
  const claims: Claim[] = [];
  const seen = new Set<string>();
  const add = (text: string, section: ClaimSection) => {
    const clean = cleanBullet(text);
    const labelled = section === "door" || section === "radius";
    if (!clean || isPathOnly(clean) || (!labelled && clean.split(/\s+/).length < 2)) return;
    const id = claimId(clean);
    if (seen.has(id)) return;
    seen.add(id);
    claims.push({ id, text: clean, section });
  };

  let section: ClaimSection = "summary";
  let current: { text: string; section: ClaimSection; joinParagraphs?: boolean } | undefined;
  const flush = () => {
    if (current) add(current.text, current.section);
    current = undefined;
  };
  for (const line of bodyLines(intent.body)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      section = sectionOf(heading[1]!);
      continue;
    }
    // `**Door:** two-way` and `**Blast Radius:** chat cards`; the template's optional paragraph below each joins it.
    const labelled = /^\s*(?:[-*+]\s+)?\*{0,2}(door|blast radius)\*{0,2}\s*:\*{0,2}\s*(.+)$/i.exec(line);
    if (labelled) {
      flush();
      current = { text: labelled[2]!, section: labelled[1]!.toLowerCase() === "door" ? "door" : "radius", joinParagraphs: true };
      continue;
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      current = { text: bullet[1]!, section };
      continue;
    }
    if (line.trim() === "") {
      if (!current?.joinParagraphs) flush();
    } else if (current) current.text += ` ${line.trim()}`;
  }
  flush();
  return claims;
}

/** The author's door word, from a door claim or anywhere in the body. */
export function authorDoor(intent: Intent | undefined, claims: Claim[]): DoorKind | undefined {
  const doorClaim = claims.find((c) => c.section === "door");
  const m = doorClaim
    ? /\b(one|two)[- ]way\b|\b(irreversible|reversible)\b/i.exec(doorClaim.text)
    : /\b(one|two)[- ]way\b/i.exec(intent?.body ?? "");
  if (!m) return undefined;
  return m[1]?.toLowerCase() === "one" || m[2]?.toLowerCase() === "irreversible" ? "one-way" : "two-way";
}

/**
 * The summary has no bullets to split but says something: prose, or a `/pr` diagram or diff sketch
 * in a fence. Evidence bullets do not count; they rarely describe the change itself.
 */
export function needsModelExtraction(intent: Intent | undefined, claims: Claim[]): boolean {
  if (!intent?.body) return false;
  if (claims.some((c) => c.section === "summary")) return false;
  return summarySection(intent.body).replace(/\s+/g, " ").trim().length >= 40;
}

/** The body up to the first heading that is not a summary (Evidence, Merge Danger, …), fences included. */
export function summarySection(body: string): string {
  const out: string[] = [];
  for (const line of body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && sectionOf(heading[1]!) !== "summary") break;
    if (heading) continue;
    if (/^\s*\*{0,2}(door|blast radius)\*{0,2}\s*:/i.test(line)) continue;
    out.push(line.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/<img[^>]*>/gi, ""));
  }
  return out.join("\n");
}

export const CLAIMS_PROMPT = `Below is the author's summary of a code change. List the checkable statements it makes about what THIS change does to the code or its behaviour: one per line, starting with "- ", at most 8, in the author's words where possible. A diagram, tree or diff sketch describes behaviour too: turn each changed line into a statement (what it was, what it is now). Leave out motivation, links, plans, instructions to reviewers and anything not about the change itself. If there are none, output exactly "- none".

Title: {title}

{body}`;

export const claimsPrompt = (intent: Intent): string =>
  CLAIMS_PROMPT.replace("{title}", intent.title).replace("{body}", summarySection(intent.body).slice(0, 12_000));

/** Claims from the model's bullet list; the same splitter as for authored bullets. */
export function parseClaimList(text: string): Claim[] {
  return extractClaims({ title: "", body: text }).filter((c) => c.text.toLowerCase() !== "none");
}

export interface ExtractOptions {
  modelSpec: string;
  env?: Env;
  write?: (prompt: string) => Promise<string>;
}

/** Ask the writer for claims when a body has prose but no bullets. Never throws. */
export async function extractClaimsWithModel(intent: Intent, opts: ExtractOptions): Promise<{ claims: Claim[]; warning?: string }> {
  let write = opts.write;
  if (!write) {
    const resolved = resolveWriter(opts.modelSpec, opts.env ?? process.env);
    if (!resolved.ok) return { claims: [], warning: `No claims: ${resolved.reason}.` };
    const model = resolved.model;
    write = (prompt) => writeText(model, prompt);
  }
  const res = await attemptAsync(() => write!(claimsPrompt(intent)));
  if (!res.ok) return { claims: [], warning: `Claim extraction failed: ${res.error}` };
  return { claims: parseClaimList(res.value) };
}

// ---------------------------------------------------------------- grounding

/** Below this the answer is noise, whatever it says. */
export const ANSWER_MIN = 0.4;
/** A red ✗ needs this much: in the experiment the headline claim got `contradicted` at 0.5 while true. */
export const CONTRADICTED_MIN = 0.7;

export function gateStatus(status: ModelClaimStatus, confidence: number): ClaimStatus {
  if (confidence < ANSWER_MIN) return "unclear";
  if (status === "contradicted" && confidence < CONTRADICTED_MIN) return "unclear";
  return status;
}

/** Rules, not the model, judge a door claim: author's word against the diff's one-way signals. */
export function judgeDoorClaim(author: DoorKind | undefined, door: Door): Pick<Claim, "status" | "confidence"> {
  if (!author) return { status: "unclear", confidence: 0 };
  if (author === door.computed) return { status: "supported", confidence: 1 };
  // Author says one-way, rules found no signal: the author may know something the diff does not show.
  if (author === "one-way") return { status: "unclear", confidence: 0.5 };
  return { status: "contradicted", confidence: 1 };
}

export interface GroundOptions {
  modelSpec: string;
  env?: Env;
  cache?: RankCache;
  resolveModel?: (spec: string, env: Env) => ResolvedModel;
  radius?: Radius;
}

const isJudgement = (v: unknown): v is ClaimJudgement =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as ClaimJudgement).confidence === "number" &&
  typeof (v as ClaimJudgement).status === "string";

/**
 * Ground every claim that still has no status, in one Decisions call, cached by claim id and
 * card set. Door claims are never sent (rules judged them). Never throws: a failed call leaves
 * the claims ungrounded and returns a warning.
 */
export async function groundClaims(
  changeSet: ChangeSet,
  cards: Card[],
  claims: Claim[],
  opts: GroundOptions,
): Promise<{ claims: Claim[]; warning?: string }> {
  const todo = claims.filter((c) => c.status === undefined && c.section !== "door");
  if (todo.length === 0) return { claims };
  const env = opts.env ?? process.env;
  const resolved = (opts.resolveModel ?? resolveAttentionModel)(opts.modelSpec, env);
  if (!resolved.ok) return { claims, warning: `Claims not grounded: ${resolved.reason}.` };

  const live = cards.filter((c) => !c.fixed);
  const cache = opts.cache ?? new RankCache();
  const setKey = live
    .map((c) => c.id)
    .sort()
    .join(",");
  // The key carries the prompt version: a sharper question must not be answered from an older cache.
  const key = (c: Claim) => `ground-v2:${c.id}:${setKey}`;
  const judged = new Map<string, ClaimJudgement>();
  for (const c of todo) {
    const hit = cache.get(opts.modelSpec, key(c), isJudgement);
    if (hit) judged.set(c.id, hit);
  }
  const missing = todo.filter((c) => !judged.has(c.id));
  if (missing.length > 0) {
    const radius = opts.radius
      ? { areas: opts.radius.areas, ...(opts.radius.importers ? { importers: opts.radius.importers } : {}) }
      : undefined;
    const res = await attemptAsync(() =>
      groundClaimBatch(resolved.model, missing, groundCards(changeSet, live), {
        ...(changeSet.intent ? { intent: changeSet.intent } : {}),
        ...(radius ? { radius } : {}),
      }),
    );
    if (!res.ok) return { claims, warning: `Claims not grounded: ${opts.modelSpec} failed (${res.error}).` };
    for (const [id, j] of res.value) {
      judged.set(id, j);
      cache.set(opts.modelSpec, key(todo.find((c) => c.id === id)!), j);
    }
    await attemptAsync(async () => cache.save());
  }
  return {
    claims: claims.map((c) => {
      const j = judged.get(c.id);
      if (!j) return c;
      const next: Claim = { ...c, status: gateStatus(j.status, j.confidence), confidence: j.confidence };
      if (j.cardId && j.status !== "not-in-diff") next.cardId = j.cardId;
      return next;
    }),
  };
}

/** Enough for a 60-file rename to be read in full; the big cards are the ones absence claims are about. */
const MAX_DIFF_PER_CARD = 24_000;

function groundCards(changeSet: ChangeSet, cards: Card[]): GroundCard[] {
  const refs = allBlocks(changeSet);
  return cards.map((card) => {
    const ids = new Set(card.blockIds);
    const own = refs.filter((r) => ids.has(r.block.id));
    const diff = own.map((r) => `### ${r.block.path} ${r.hunk.header}\n${blockText(r.hunk, r.block, 2)}`).join("\n\n");
    const gc: GroundCard = {
      id: card.id,
      title: card.title,
      files: [...new Set(own.map((r) => r.block.path))],
      diff: diff.length > MAX_DIFF_PER_CARD ? `${diff.slice(0, MAX_DIFF_PER_CARD)}\n…` : diff,
    };
    if (card.paragraph) gc.paragraph = card.paragraph;
    return gc;
  });
}

const rank = (a: Card["attention"]) => ATTENTION_ORDER.indexOf(a);

/** Point cards at their claims; a card no claim points to, at needs-eyes or above, is unmentioned. */
export function applyClaims(cards: Card[], claims: Claim[]): Card[] {
  // Only once grounding has landed: before that every card would be "unmentioned" for a few seconds.
  const grounded = claims.some((c) => (c.section === "summary" || c.section === "evidence") && c.status !== undefined);
  return cards.map((card) => {
    const claimIds = claims.filter((c) => c.cardId === card.id).map((c) => c.id);
    const unmentioned = grounded && !card.fixed && !card.mechanical && claimIds.length === 0 && rank(card.attention) >= rank("needs-eyes");
    return { ...card, claimIds, unmentioned };
  });
}

// ---------------------------------------------------------------- helpers

export function claimId(text: string): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(text.toLowerCase().replace(/\s+/g, " ").trim());
  return h.digest("hex").slice(0, 12);
}

/** Lines of the body with fenced code, HTML comments and images removed. */
function bodyLines(body: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(raw.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/<img[^>]*>/gi, ""));
  }
  return out;
}

function sectionOf(heading: string): ClaimSection {
  const h = heading.toLowerCase();
  if (/evidence|test|verif|proof|how .*(checked|tested)/.test(h)) return "evidence";
  return "summary";
}

/**
 * Strip markdown emphasis, checkboxes, links and trailing punctuation from a bullet. A `/pr`
 * evidence bullet `Before: … After: …` keeps only the after part: the before is the old state,
 * which the diff only shows as removed lines.
 */
function cleanBullet(text: string): string {
  return text
    .replace(/^\**before:?\**\s*[\s\S]*?\**after:?\**\s*/i, "After the change: ")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:]+$/, "");
}

const isPathOnly = (text: string): boolean => /^`?[\w@./-]+\.[A-Za-z0-9]+`?$/.test(text) || /^`[^`]+`$/.test(text);

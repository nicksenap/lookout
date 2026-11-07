import { allBlocks, type BlockRef } from "../core/blocks.ts";
import { ATTENTION_ORDER, type Attention, type Card, type CardColor, type ChangeSet, COLOR_ORDER } from "../core/types.ts";
import { areasOf, kindOf } from "../policy/evaluate.ts";
import type { Policy } from "../policy/schema.ts";
import {
  changedIdentifiers,
  type Group,
  groupBlocks,
  isLockfileOnly,
  isMechanical,
  joinTests,
  lockfileText,
  markTestGroups,
  mechanicalText,
} from "./group.ts";
import type { Splits } from "./split.ts";

const rank = (a: Attention) => ATTENTION_ORDER.indexOf(a);
const CONTENT_LABELS = ["whitespace-only", "comment-only"];

/**
 * Group live (non-inert) blocks into cards. With model kinds available, blocks are grouped
 * into logical changes (cards/group.ts) and mechanical groups get deterministic prose; under
 * rules-only ranking (no kinds) the stand-in is one card per file. Inert blocks all go to the
 * fixed "clean" card. Every block lands in exactly one card.
 *
 * `splits` are model-proposed, rule-checked partitions of oversized groups (cards/split.ts),
 * keyed by the card id the whole group would have had; a group with a split becomes one card
 * per concern. Building stays deterministic given the same splits.
 */
export function buildCards(changeSet: ChangeSet, policy: Policy, splits: Splits = new Map()): Card[] {
  const refs = allBlocks(changeSet);
  const live = refs.filter((r) => r.block.attention !== "inert");
  const inert = refs.filter((r) => r.block.attention === "inert");

  const haveKinds = live.length > 0 && live.every((r) => r.block.kind !== undefined);
  const groups: Group[] = haveKinds
    ? joinTests(groupBlocks(live).flatMap((group) => applySplit(group, splits)))
    : [...live.reduce((m, r) => m.set(r.file.path, [...(m.get(r.file.path) ?? []), r]), new Map<string, BlockRef[]>())].map(([, refs]) => ({
        refs,
        topIdentifiers: [],
      }));
  const cards = haveKinds
    ? groups.map((g) => {
        const card = makeCard(cardId(g.refs.map((r) => r.block.id)), g.hint ?? titleFor(g.refs, g.topIdentifiers), g.refs, policy);
        if (g.kind) card.blockKind = g.kind;
        if (g.hint) card.hint = g.hint;
        if (isMechanical(g.kind) && !isLockfileOnly(card)) {
          const text = mechanicalText(g);
          card.title = text.title;
          card.paragraph = text.paragraph;
          card.mechanical = true;
        }
        // The floor depends on the kind the model gave the group, so it is set once that is known.
        card.color = colorFloor(card);
        return card;
      })
    : groups.map((group) => makeCard(cardId(group.refs.map((ref) => ref.block.id)), group.refs[0]!.file.path, group.refs, policy));
  const marked = markTestGroups(groups, cards);
  marked.sort(compareCards);

  if (inert.length > 0)
    marked.push({
      ...makeCard("clean", `verified clean · ${inert.length} edit${inert.length === 1 ? "" : "s"}`, inert, policy),
      color: "grey",
      fixed: "clean",
    });
  return marked;
}

/** Replace a group by its concerns when a split exists for it; every block keeps exactly one home. */
function applySplit(group: Group, splits: Splits): Group[] {
  const partition = splits.get(cardId(group.refs.map((r) => r.block.id)));
  if (!partition || group.kind === "test") return [group];
  const byId = new Map(group.refs.map((r) => [r.block.id, r]));
  return partition.map((concern) => {
    const refs = concern.blockIds.map((id) => byId.get(id)).filter((r): r is BlockRef => r !== undefined);
    const counts = new Map<string, number>();
    for (const r of refs) for (const w of changedIdentifiers(r)) counts.set(w, (counts.get(w) ?? 0) + 1);
    const topIdentifiers = [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4)
      .map(([w]) => w);
    const split: Group = { refs, topIdentifiers, hint: concern.title || undefined };
    return group.kind ? { ...split, kind: group.kind } : split;
  });
}

/** Placeholder title until the writer names the card: the file, or the files, it touches. */
function titleFor(group: BlockRef[], topIdentifiers: string[]): string {
  const files = [...new Set(group.map((r) => r.file.path))];
  const where = files.length === 1 ? files[0]! : `${files[0]!.split("/").pop()} +${files.length - 1} more`;
  return topIdentifiers.length ? `${where} · ${topIdentifiers.slice(0, 2).join(", ")}` : where;
}

export function cardId(blockIds: string[]): string {
  const h = new Bun.CryptoHasher("sha1");
  for (const id of [...blockIds].sort()) h.update(`${id}\0`);
  return h.digest("hex").slice(0, 12);
}

function makeCard(id: string, title: string, group: BlockRef[], policy: Policy): Card {
  const labels = [...new Set(group.flatMap((r) => r.block.labels))].filter((l) => !CONTENT_LABELS.includes(l)).sort();
  const areas = [...new Set(group.flatMap((r) => areasOf(policy, r.block.path)))].sort();
  const kind = kindOf(
    group.map((r) => ({
      path: r.block.path,
      labels: r.block.labels,
      hasDeletions: r.hunk.lines.slice(r.block.from, r.block.to).some((l) => l.kind === "del") && r.file.status !== "added",
    })),
  );
  const attention = group.reduce<Attention>((top, r) => (rank(r.block.attention) > rank(top) ? r.block.attention : top), "inert");
  const score = Math.max(0, ...group.map((r) => r.block.score));
  const card: Card = {
    id,
    title,
    color: "grey",
    kind,
    areas,
    labels,
    blockIds: group.map((r) => r.block.id),
    files: [...new Set(group.map((r) => r.block.path))],
    attention,
    score,
    claimIds: [],
    unmentioned: false,
    mentioned: true,
    testsTouched: false,
    questions: [],
  };
  if (isLockfileOnly(card)) Object.assign(card, lockfileText(card));
  card.color = colorFloor(card);
  return card;
}

/**
 * Rule-derived color floor. Rules set the floor; the model may only raise attention,
 * never lower it; and only rules may call a card grey.
 *
 * A sensitive area makes routine behaviour amber and needs-eyes behaviour red. Tests,
 * mechanical edits and docs inside `auth/` stay green (the area badge still shows);
 * config plumbing there is amber. The tier floors in `policy/evaluate.ts` are untouched:
 * a touched area still means more humans.
 */
export function colorFloor(
  card: Pick<Card, "attention" | "areas" | "labels" | "kind"> & Partial<Pick<Card, "blockKind" | "mechanical" | "files">>,
): CardColor {
  if (card.attention === "inert") return "grey";
  if (isLockfileOnly(card)) return "green";
  if (card.attention === "suspicious") return "red";
  const sensitive = card.areas.length > 0 || card.labels.includes("sensitive");
  const test = card.kind === "test" || card.blockKind === "test";
  const docs = card.kind === "docs" || card.blockKind === "docs";
  const config = card.kind === "deps" || card.kind === "config" || card.kind === "ci";
  const plumbing = config || card.blockKind === "config";
  if (sensitive && !test && !docs && !plumbing && !card.mechanical) return card.attention === "needs-eyes" ? "red" : "amber";
  if (sensitive && plumbing) return "amber";
  if (card.attention === "needs-eyes" && !test && !docs && !card.mechanical) return "amber";
  if (config) return "amber";
  return "green";
}

/**
 * Riskiest first: colour, then attention, then behaviour before mechanical and docs,
 * then configuration switches, then the larger card (more to decide), then score;
 * stable for equal keys.
 */
export function compareCards(a: Card, b: Card): number {
  const skim = (c: Card) => (isLockfileOnly(c) || c.mechanical || c.kind === "docs" || c.blockKind === "docs" ? 1 : 0);
  // Rules know lockfiles better than the model's score; keep attention in JSON, but sort them as routine skim material.
  const attention = (c: Card) => rank(isLockfileOnly(c) ? "routine" : c.attention);
  // A configuration switch decides whether the rest ships; it reads first at equal colour, attention and skim.
  const toggle = (c: Card) => (c.kind === "config" || c.kind === "ci" || c.kind === "deps" ? 0 : 1);
  return (
    COLOR_ORDER.indexOf(b.color) - COLOR_ORDER.indexOf(a.color) ||
    Number(Boolean(b.risk)) - Number(Boolean(a.risk)) ||
    attention(b) - attention(a) ||
    skim(a) - skim(b) ||
    toggle(a) - toggle(b) ||
    b.blockIds.length - a.blockIds.length ||
    b.score - a.score
  );
}

/** Policy areas that no file of the change touches at all. */
export function untouchedAreas(changeSet: ChangeSet, policy: Policy): string[] {
  const touched = new Set(changeSet.files.flatMap((f) => areasOf(policy, f.path)));
  return Object.keys(policy.areas)
    .filter((a) => !touched.has(a))
    .sort();
}

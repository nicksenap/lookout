import { type BlockRef, blockLines } from "../core/blocks.ts";
import type { BlockKind, Card } from "../core/types.ts";
import { isImport } from "../rank/mechanical.ts";

const MECHANICAL: readonly BlockKind[] = ["typing-refactor", "rename", "move"];
export const isMechanical = (kind: BlockKind | undefined): boolean => kind !== undefined && MECHANICAL.includes(kind);

const KEYWORDS = new Set(
  "const let var function return if else for while do import export from type interface class extends implements new this true false null undefined async await of in as default switch case break continue try catch finally throw typeof instanceof void delete yield static readonly public private protected enum declare namespace module require def self None True False and or not elif lambda with pass raise except func package struct map chan go defer val fun when object data override internal".split(
    " ",
  ),
);
/** Identifiers that are too generic to say what an edit is about. */
const NOISE = new Set(
  "React JSX Element Props string number boolean object any unknown Record Array Promise Error console log length push map filter find some every forEach then catch props children className style key value id name type".split(
    " ",
  ),
);

export function identifiers(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)].map((m) => m[0]).filter((w) => w.length > 2 && !KEYWORDS.has(w) && !NOISE.has(w)),
  );
}

/** Identifiers the edit is about: present on one side only. */
export function changedIdentifiers(r: BlockRef): Set<string> {
  const ls = blockLines(r.hunk, r.block);
  const added = identifiers(
    ls
      .filter((l) => l.kind === "add")
      .map((l) => l.text)
      .join("\n"),
  );
  const removed = identifiers(
    ls
      .filter((l) => l.kind === "del")
      .map((l) => l.text)
      .join("\n"),
  );
  return new Set([...added].filter((w) => !removed.has(w)).concat([...removed].filter((w) => !added.has(w))));
}

/** A punctuation-only edit (a moved brace, a trailing comma): it belongs to whatever it sits next to. */
export const isOrphan = (r: BlockRef): boolean =>
  blockLines(r.hunk, r.block)
    .map((l) => l.text)
    .join("")
    .replace(/[^A-Za-z]/g, "").length < 3;

/**
 * An edit that cannot stand alone as a logical change: imports, re-exports, a lone type or
 * interface, a destructured prop. It belongs to the card that owns its file, whatever kind
 * the model gave it. Measured on three production PRs where these formed cards of their
 * own (a lone request model as a card, "Rename in x.ts" for two `export` lines).
 */
const isCodeDocs = (ref: BlockRef) =>
  !ref.block.labels.includes("docs") && (ref.block.kind === "docs" || ref.block.labels.includes("comment-only"));

export function isFragment(r: BlockRef): boolean {
  if (isCodeDocs(r)) return true;
  const lines = blockLines(r.hunk, r.block)
    .filter((l) => l.kind !== "context" && l.text.trim() !== "")
    .map((l) => l.text);
  if (lines.length === 0) return false;
  if (lines.every((line) => isImport(line) || /^\s*type\s+[A-Za-z_$][\w$]*\s*,?\s*$/.test(line))) return true;
  if (
    lines.every((l) =>
      /^\s*(export\s*\{[^}]*\}\s*;?\s*(from\s+['"][^'"]+['"]\s*;?)?|export\s+\*\s+from\s+['"][^'"]+['"]\s*;?|export\s*\{\s*|\}\s*;?|[A-Za-z_$][\w$]*,?)\s*$/.test(
        l,
      ),
    )
  )
    return true;
  // A whole type/interface declaration, or members of one (`  limit?: number;`), with no runtime statement.
  if (
    /^\s*(export\s+)?(type|interface)\b/.test(lines[0]!) &&
    lines.every((l) => !/[=(]\s*(?!>)|\breturn\b|\bawait\b/.test(l.replace(/=>/g, "").replace(/<[^<>]*>/g, "")))
  )
    return true;
  // One destructured prop, as `onMoveToProject,` inside `({ taskId, onCommit })`.
  return lines.length <= 2 && lines.every((l) => /^\s*[A-Za-z_$][\w$]*\??,?\s*$/.test(l));
}

const isImportLike = (r: BlockRef): boolean =>
  blockLines(r.hunk, r.block)
    .filter((l) => l.kind !== "context" && l.text.trim() !== "")
    .every((l) => isImport(l.text) || /^\s*(type\s+[A-Za-z_$][\w$]*\s*,?\s*$|export\s*\{|\}\s*from\b|export\s+\*)/.test(l.text));

export interface Group {
  refs: BlockRef[];
  /** The kind every member shares, when they do. */
  kind?: BlockKind;
  /** Identifiers most shared across the group, for a deterministic title. */
  topIdentifiers: string[];
  /** Working title from a split, when the group is one concern of a larger one. */
  hint?: string;
}

/**
 * Deterministic grouping of live blocks into logical changes. Kind first: blocks only merge
 * within one kind. Mechanical kinds merge per file. Other blocks merge when they are
 * neighbours in a hunk, or share a changed identifier with another block of the same kind
 * (noise words excluded; `rareShare` < 1 additionally ignores identifiers most same-kind
 * blocks mention). Blocks with no identifiers of their own (a moved brace) join the
 * previous block of their hunk.
 */
const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** `src/foo/bar.test.ts` → `bar`; `src/foo/index.ts` → `foo`; `test_bar.py` → `bar`. */
export function stemOf(path: string): string {
  const base = baseOf(path).replace(/\.[^.]+$/, "");
  const stem = base.replace(/\.(test|spec|stories|story|d)$/i, "").replace(/(\.|_|-)?(test|tests|spec|specs)$|^test_|^tests?[-_]/i, "");
  return /^(index|mod|__init__|main)$/i.test(stem) ? baseOf(dirOf(path)) || stem : stem;
}

export const isTestBlock = (ref: BlockRef) => ref.block.kind === "test" || ref.block.labels.includes("test");

/** Kind and ownership before splitting; tests are kept apart until production concerns are known. */
export function groupBlocks(refs: BlockRef[], opts: { rareShare?: number; neighbourLines?: number } = {}): Group[] {
  return [
    ...groupByOwnership(
      refs.filter((ref) => !isTestBlock(ref)),
      opts,
    ),
    ...groupByOwnership(refs.filter(isTestBlock), opts).map((group) => ({ ...group, kind: "test" as const })),
  ];
}

/** Home tests against final split concerns, not the coarse blob that happened to contain their names. */
export function joinTests(groups: Group[]): Group[] {
  const code = groups.filter((group) => group.kind !== "test");
  const candidates = code.filter((group) => !isMechanical(group.kind) && group.kind !== "docs");
  const names = candidates.map(
    (group) => new Set(group.refs.filter((ref) => !isCodeDocs(ref)).flatMap((ref) => [...changedIdentifiers(ref)])),
  );
  const stems = candidates.map((group) => new Set(group.refs.map((ref) => stemOf(ref.file.path))));
  const remaining = groups
    .filter((group) => group.kind === "test")
    .map((group) => {
      const refs = group.refs.filter((ref) => {
        const added = blockLines(ref.hunk, ref.block)
          .filter((line) => line.kind === "add")
          .map((line) => line.text)
          .join("\n");
        const identifierOwners = candidates.filter((_, index) => exercises(added, names[index]!));
        const owners = identifierOwners.length > 0 ? identifierOwners : candidates.filter((_, index) => exercises(added, stems[index]!));
        if (owners.length !== 1) return true;
        owners[0]!.refs.push(ref);
        return false;
      });
      return { ...group, refs };
    })
    .filter((group) => group.refs.length > 0);
  return [...code, ...remaining];
}

/** Added test lines must name a changed identifier or a complete file stem, not just share a directory. */
function exercises(added: string, names: Set<string>): boolean {
  return [...names].some((name) => new RegExp(`(?:^|[^\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\w$])`, "m").test(added));
}

/** JSON test metadata reads membership after split repair; unresolved test groups cover nothing. */
export function markTestGroups(groups: Group[], cards: Card[]): Card[] {
  const testIds = new Set(groups.flatMap((group) => group.refs.filter(isTestBlock).map((ref) => ref.block.id)));
  return cards.map((card) => {
    const tests = card.blockIds.filter((id) => testIds.has(id));
    const onlyTests = tests.length > 0 && tests.length === card.blockIds.length;
    if (onlyTests) return { ...card, testsTouched: false, covers: [] };
    return { ...card, testsTouched: tests.length > 0 };
  });
}

function groupByOwnership(refs: BlockRef[], opts: { rareShare?: number; neighbourLines?: number }): Group[] {
  const rareShare = opts.rareShare ?? 1;
  const neighbourLines = opts.neighbourLines ?? 8;
  const ids = refs.map(changedIdentifiers);
  const parent = refs.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
  const union = (a: number, b: number) => void (parent[find(a)] = find(b));
  const kindOf = (k: number) => refs[k]!.block.kind;

  // 1. Orphans (punctuation-only edits such as a moved brace) join the nearest earlier block in
  //    the same hunk, else the next, and take no further part: otherwise a lone brace bridges
  //    two unrelated groups.
  // A one-identifier line (a destructured prop, a list entry) is a fragment only when its file
  // has a real edit to own it; otherwise it is the edit, and groups like any other block.
  const candidate = refs.map(isFragment);
  const fragment = refs.map(
    (r, k) => candidate[k] && (isImportLike(r) || refs.some((o, j) => j !== k && !candidate[j] && o.file.path === r.file.path)),
  );
  const orphan = refs.map((r, k) => isOrphan(r) && !fragment[k]);
  refs.forEach((r, k) => {
    if (!orphan[k]) return;
    const prev = refs.findLastIndex((o, j) => j < k && o.hunk.id === r.hunk.id && !orphan[j]);
    const next = refs.findIndex((o, j) => j > k && o.hunk.id === r.hunk.id && !orphan[j]);
    const target = prev >= 0 ? prev : next;
    if (target >= 0) union(k, target);
  });

  // 2. Mechanical kinds: one group per kind across the whole change. A rename or a typing
  //    sweep over sixty files is one thing to review, not sixty.
  refs.forEach((_, i) => {
    if (orphan[i] || fragment[i] || !isMechanical(kindOf(i))) return;
    refs.forEach((_, j) => {
      if (j <= i || orphan[j] || fragment[j] || kindOf(j) !== kindOf(i)) return;
      union(i, j);
    });
  });

  // 3. Same kind, same file, close together.
  refs.forEach((a, i) => {
    if (orphan[i] || fragment[i]) return;
    refs.forEach((b, j) => {
      if (j <= i || orphan[j] || fragment[j] || kindOf(j) !== kindOf(i) || b.file.path !== a.file.path || isMechanical(kindOf(i))) return;
      const aEnd = a.block.newRange?.end ?? a.block.oldRange?.end ?? 0;
      const bStart = b.block.newRange?.start ?? b.block.oldRange?.start ?? 0;
      if (a.hunk.id === b.hunk.id || Math.abs(bStart - aEnd) <= neighbourLines) union(i, j);
    });
  });

  // 4. Same kind, shared changed identifier. Frequency is counted within the kind, so a prop
  //    that a typing refactor also mentions still links the behaviour blocks that introduce it.
  const freq = new Map<string, number>();
  refs.forEach((_, k) => {
    for (const w of ids[k]!) freq.set(`${kindOf(k)}|${w}`, (freq.get(`${kindOf(k)}|${w}`) ?? 0) + 1);
  });
  const sameKindCount = (k: number) => refs.filter((_, j) => kindOf(j) === kindOf(k)).length;
  refs.forEach((_, i) => {
    if (orphan[i] || fragment[i]) return;
    const cap = Math.max(2, Math.floor(sameKindCount(i) * rareShare));
    refs.forEach((_, j) => {
      if (j <= i || orphan[j] || fragment[j] || kindOf(j) !== kindOf(i) || isMechanical(kindOf(i))) return;
      if ([...ids[i]!].some((w) => ids[j]!.has(w) && (freq.get(`${kindOf(i)}|${w}`) ?? 0) <= cap)) union(i, j);
    });
  });

  // 5. Fragments join the owner of their file: the non-mechanical group with most blocks there,
  //    else any group there, else a group elsewhere that mentions one of the fragment's names.
  //    A fragment with no owner stays its own group (a new file that is only a type).
  refs.forEach((r, k) => {
    if (!fragment[k]) return;
    const candidates = refs.map((_, j) => j).filter((j) => j !== k && !fragment[j] && !orphan[j]);
    const weight = (j: number) => refs.filter((o, m) => find(m) === find(j) && o.file.path === r.file.path && !fragment[m]).length;
    const inFile = candidates.filter((j) => refs[j]!.file.path === r.file.path);
    // Across files, prefer code over docs or tests: an import of `fooModule` belongs with the code that registers it, not the README that mentions it.
    const prose = (j: number) => kindOf(j) === "docs" || kindOf(j) === "test";
    const elsewhere = refs.map((_, j) => j).filter((j) => j !== k && !orphan[j] && [...ids[k]!].some((w) => ids[j]!.has(w)));
    const owner =
      inFile.filter((j) => !isMechanical(kindOf(j))).sort((a, b) => weight(b) - weight(a))[0] ??
      inFile.sort((a, b) => weight(b) - weight(a))[0] ??
      elsewhere.find((j) => !prose(j) && !fragment[j]) ??
      elsewhere.find((j) => !prose(j)) ??
      elsewhere[0];
    if (owner === undefined) return;
    if (owner !== undefined) union(k, owner);
  });

  const byRoot = new Map<number, number[]>();
  refs.forEach((_, k) => byRoot.set(find(k), [...(byRoot.get(find(k)) ?? []), k]));
  return [...byRoot.values()].map((members) => {
    const counts = new Map<string, number>();
    for (const k of members) for (const w of ids[k]!) counts.set(w, (counts.get(w) ?? 0) + 1);
    const topIdentifiers = [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4)
      .map(([w]) => w);
    // Orphans and fragments have no say in the group's kind.
    const kinds = new Set(members.filter((k) => !orphan[k] && !fragment[k]).map(kindOf));
    const group: Group = { refs: members.map((k) => refs[k]!), topIdentifiers };
    if (kinds.size === 1 && !kinds.has(undefined)) group.kind = [...kinds][0]!;
    return group;
  });
}

/** Deterministic title and one-line paragraph for a mechanical group; no model needed. */
export function mechanicalText(group: Group): { title: string; paragraph: string } {
  const n = group.refs.length;
  const files = [...new Set(group.refs.map((r) => r.file.path.split("/").pop()!))];
  const where = files.length === 1 ? files[0]! : `across ${files.length} files`;
  const edits = `${n} edit${n === 1 ? "" : "s"}`;
  switch (group.kind) {
    case "typing-refactor":
      return {
        title: files.length === 1 ? `Typing refactor in ${where}` : `Typing refactor ${where}`,
        paragraph: `${edits} change types, annotations or function form only${group.topIdentifiers.length ? ` (${group.topIdentifiers.slice(0, 3).join(", ")})` : ""}; runtime behaviour is unchanged.`,
      };
    case "rename":
      return {
        title: files.length === 1 ? `Rename in ${where}` : `Rename ${where}`,
        paragraph: `${edits} rename identifiers${group.topIdentifiers.length ? ` (${group.topIdentifiers.slice(0, 3).join(", ")})` : ""}; behaviour is unchanged.`,
      };
    case "move":
      return {
        title: files.length === 1 ? `Code moved in ${where}` : `Code moved ${where}`,
        paragraph: `${edits} move code without changing it.`,
      };
    default:
      return { title: group.topIdentifiers.slice(0, 3).join(" · ") || where, paragraph: "" };
  }
}

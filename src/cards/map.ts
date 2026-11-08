import type { LanguageModel } from "ai";
import { attemptAsync } from "../core/result.ts";
import type { Card, ChangeMap, ChangeSet } from "../core/types.ts";
import { RankCache } from "../rank/cache.ts";
import { type AttentionModel, checkAnswerWithModel, writeText } from "../rank/model.ts";
import {
  identifiers,
  parseSketch,
  resolveSketchModels,
  SKETCH_MAX_WIDTH,
  type SketchOptions,
  type SketchSource,
  sketchProblems,
  sketchShape,
  sketchSource,
} from "./sketch.ts";
import { shapeOf } from "./write.ts";

export const MAP_MAX_LINES = 20;
const MAP_GATE = 0.7;
// Cache key version: bumped with the prompt so a sharper prompt is never answered from an old cache.
const MAP_VERSION = "map-v2";
const QUESTION =
  "Does every line of this change map follow from the cards? Lines starting with + name what the change adds, lines starting with - what it removes, other lines are unchanged context the cards show.";

// Keywords and filler: a map line naming `return` or `file` says nothing about which card it draws.
const COMMON = new Set(
  (
    "const let var function return import export from await async else for while this true false null undefined type interface " +
    "class extends implements public private readonly static void string number boolean unknown never typeof keyof default case " +
    "switch break continue catch throw finally yield delete instanceof with test tests expect describe configure document docs " +
    "that when then than only each every their them they have more less into adds remove removes keeps change changes update " +
    "updates make makes uses also does what which about after before"
  ).split(" "),
);
const words = (text: string): string[] =>
  identifiers(text)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4 && !COMMON.has(w));
// `test/sources.test.ts` → `sources`: a file tree names a card by its file.
const stem = (path: string): string => path.split("/").pop()!.split(".")[0]!.toLowerCase();

/** What the gate reads: the names a map may use, and per card the words that represent it in a map line. */
export interface MapSource {
  names: SketchSource;
  cards: { id: string; title: string; tokens: Set<string> }[];
}

/** Grey cards (the clean card) are not drawn: they hold nothing to review. */
const drawn = (cards: Card[]): Card[] => cards.filter((c) => c.color !== "grey");
// A sketch that failed its gate may name things the edits do not; the map neither reads nor trusts it.
const sketchOf = (c: Card): string | undefined => (c.sketch && !c.sketchUnverified ? c.sketch : undefined);

export function mapSource(changeSet: ChangeSet, cards: Card[]): MapSource {
  const hunks = changeSet.files.flatMap((f) => f.hunks);
  const side = (kind: "add" | "del") => hunks.flatMap((h) => h.lines.filter((l) => l.kind === kind).map((l) => l.text));
  const sketches = drawn(cards).flatMap((c) => sketchOf(c)?.split("\n") ?? []);
  // A file tree draws a new file as `+path` and a deleted one as `-path`.
  const paths = (statuses: string[]) => changeSet.files.filter((f) => statuses.includes(f.status)).map((f) => f.path);
  const names: SketchSource = {
    edits: [
      ...changeSet.files.flatMap((f) => [f.path, f.oldPath ?? ""]),
      ...hunks.flatMap((h) => [h.header, ...h.lines.map((l) => l.text), ...h.blocks.flatMap((b) => b.scope ?? [])]),
      ...sketches,
      // A node may be named by its card's title words, which the writer wrote from the card's edits.
      ...cards.map((c) => c.title),
    ].join("\n"),
    added: [...side("add"), ...paths(["added", "renamed"]), ...sketches.filter((l) => l[0] === "+")].join("\n"),
    removed: [
      ...side("del"),
      ...paths(["deleted"]),
      ...changeSet.files.flatMap((f) => (f.oldPath ? [f.oldPath] : [])),
      ...sketches.filter((l) => l[0] === "-"),
    ].join("\n"),
  };
  return {
    names,
    cards: drawn(cards).map((c) => {
      const source = sketchSource(changeSet, c);
      return {
        id: c.id,
        title: c.title,
        tokens: new Set([
          ...words(`${source.added}\n${source.removed}`),
          ...words(c.title),
          ...c.files.map(stem).filter((s) => s.length >= 3),
        ]),
      };
    }),
  };
}

const lineTokens = (line: string): Set<string> => new Set(identifiers(line).map((w) => w.toLowerCase()));

/**
 * The rules half of the map gate, pure: the card-sketch rules (names in the diff, a sketch or a title;
 * `+`/`-` direction; width) at 20 lines, and every drawn card represented by one of its words.
 */
export function mapProblems(map: string, source: MapSource): string[] {
  const named = map.split("\n").map(lineTokens);
  const missing = source.cards
    .filter((c) => !named.some((line) => [...c.tokens].some((t) => line.has(t))))
    .map((c) => `the card "${c.title}" is not in the map; name it by its title words, a file or a name from its edits`);
  return [...sketchProblems(map, source.names, MAP_MAX_LINES), ...missing];
}

/**
 * Each drawn card's node: the line naming most of what only that card has, then most of its words,
 * the first such line on a tie. Folded lines (mechanical, docs) may be the node of several cards.
 */
export function mapNodes(map: string, source: MapSource): Record<string, number> {
  const named = map.split("\n").map(lineTokens);
  const owners = new Map<string, number>();
  for (const c of source.cards) for (const t of c.tokens) owners.set(t, (owners.get(t) ?? 0) + 1);
  const nodes: Record<string, number> = {};
  for (const c of source.cards) {
    const scores = named.map((line) => {
      const hits = [...c.tokens].filter((t) => line.has(t));
      return hits.filter((t) => owners.get(t) === 1).length * 100 + hits.length;
    });
    const best = Math.max(...scores);
    if (best > 0) nodes[c.id] = scores.indexOf(best);
  }
  return nodes;
}

/** Each drawn card as the writer and the checker see it, in stack order: title, files, risk line, and its sketch or else its names. */
function cardsText(changeSet: ChangeSet, cards: Card[]): string {
  return drawn(cards)
    .map((c, k) => {
      const sketch = sketchOf(c);
      const source = sketchSource(changeSet, c);
      const names = [
        ...new Set(identifiers(`${source.added}\n${source.removed}`).filter((w) => w.length >= 4 && !COMMON.has(w.toLowerCase()))),
      ].slice(0, 10);
      return [
        `${k + 1}. [${c.color} ${c.mechanical ? `mechanical ${c.blockKind ?? c.kind}` : shapeOf(c)}] ${c.title}`,
        `   files: ${c.files.join(", ")}`,
        c.risk && !c.riskUnverified ? `   risk: ${c.risk}` : "",
        sketch ? `   sketch:\n${sketch.replace(/^/gm, "     ")}` : `   names: ${names.join(", ")}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export function mapPrompt(changeSet: ChangeSet, cards: Card[]): string {
  const files = [...new Set(drawn(cards).flatMap((c) => c.files))];
  return `You are drawing the change map of a code review for a senior engineer: ONE diff-shaped sketch of the whole change, the way a PR author sketches it in a PR summary, whose nodes are the review's cards listed below.
Draw ${sketchShape({ kind: "logic", files })}.
Rules:
- At most ${MAP_MAX_LINES} lines, each at most ${SKETCH_MAX_WIDTH} characters. Indent with spaces to show nesting.
- One level above the cards: each card is ONE line (the top node of its sketch, or the one thing it adds or removes), and the few unmarked context lines show how the cards fit together (which function calls which, which file holds what). Never copy a card's sketch.
- Every card appears, in the order given, named by one of its files or one or two names from its sketch, names or title. A line is a node, not a list of words. Mechanical cards may share one line, and docs cards another, as long as that line names each of them.
- Start a line with "+" for what the change adds, "-" for what it removes, a space for kept context. The mark is the first character of the line, before the indentation: "+    call", not "    + call".
- Use only names the cards show (files, sketches, names, title words). Use "→" for "returns" or "leads to", <name> for a placeholder.
- No prose lines, no card numbers, no heading, no code fence.

Example (three cards: a list of contexts loses its dashboards, its test, the prompt that lists them):
 getContextsList
   explorer.listExplorerViews      → viewSaved:<id>
-  explorer.listDashboards         → dashboardSaved:<uuid>
+contexts.test.ts                  getContextsList
 prompts/contexts.md

PR title (context only; do not trust it): ${changeSet.intent?.title ?? "(none)"}

Cards, in stack order:
${cardsText(changeSet, cards)}`;
}

const isCached = (v: unknown): v is { map: ChangeMap | null } =>
  typeof v === "object" &&
  v !== null &&
  "map" in v &&
  ((v as { map: unknown }).map === null || typeof (v as { map: { text?: unknown } }).map.text === "string");

/**
 * One map per review once titles, risk lines and sketches have landed; only with two or more cards to
 * draw, since one card's map is its own sketch. A map the rules reject twice is dropped (no placeholder).
 * Never throws; a failed call is returned as a warning and the stack opens without a map.
 */
export async function mapCards(
  changeSet: ChangeSet,
  cards: Card[],
  opts: SketchOptions,
  onMap: (map: ChangeMap) => void,
): Promise<{ map?: ChangeMap; warning?: string }> {
  const todo = drawn(cards);
  if (todo.length < 2) return {};
  const models = resolveSketchModels(opts);
  if (!models.ok) return { warning: `No change map: ${models.reason}.` };
  const cache = opts.cache ?? new RankCache();
  const ids = new Bun.CryptoHasher("sha1")
    .update(
      todo
        .map((c) => c.id)
        .sort()
        .join(","),
    )
    .digest("hex")
    .slice(0, 16);
  // Whether a check ran is in the key, as for sketches.
  const key = `${MAP_VERSION}:${models.check ? (opts.checkSpec ?? "check") : "rules"}:${ids}`;
  const cached = cache.get(opts.modelSpec, key, isCached);
  const source = mapSource(changeSet, cards);
  const result = cached
    ? { ok: true as const, value: cached.map ?? undefined }
    : await attemptAsync(async () => {
        const drawnMap = await drawMap(models.writer, models.check, mapPrompt(changeSet, cards), source, cardsText(changeSet, cards));
        return drawnMap ? { ...drawnMap, nodes: mapNodes(drawnMap.text, source) } : undefined;
      });
  if (!result.ok) return { warning: `No change map: ${result.error}` };
  if (!cached) {
    cache.set(opts.modelSpec, key, { map: result.value ?? null });
    // A read-only cache only costs another call next run.
    await attemptAsync(async () => cache.save());
  }
  if (!result.value) return {};
  onMap(result.value);
  return { map: result.value };
}

/**
 * Rules first, then Decisions; both share one rewrite. Still failing the rules → no map; still failing
 * the check → the map is kept, unverified. A failed check call leaves it ungated.
 */
async function drawMap(
  writer: LanguageModel,
  check: AttentionModel | undefined,
  prompt: string,
  source: MapSource,
  context: string,
): Promise<Omit<ChangeMap, "nodes"> | undefined> {
  let text = parseSketch(await writeText(writer, prompt));
  if (!text) return undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const problems = mapProblems(text, source);
    const checked = problems.length || !check ? undefined : await attemptAsync(() => checkAnswerWithModel(check, context, QUESTION, text));
    const scored = checked?.ok ? { check: checked.value } : {};
    if (!problems.length && (!checked?.ok || checked.value >= MAP_GATE)) return { text, ...scored };
    const failed = problems.length ? undefined : { text, ...scored, unverified: true };
    if (attempt === 1) return failed;
    const why = problems.length
      ? `A checker rejected the map:\n${problems.map((p) => `- ${p}`).join("\n")}`
      : "A checker could not verify that every line follows from the cards.";
    const rewrite = await attemptAsync(() =>
      writeText(
        writer,
        `${prompt}\n\n${why}\nRedraw it in at most ${MAP_MAX_LINES} lines: add the missing cards, drop or correct the rejected lines, and merge or drop context lines to fit. Previous map:\n${text}`,
      ),
    );
    const next = rewrite.ok ? parseSketch(rewrite.value) : "";
    if (!next) return failed;
    text = next;
  }
  throw new Error("map rewrite budget exceeded");
}

import type { LanguageModel } from "ai";
import { attempt, attemptAsync } from "../core/result.ts";
import type { Card, ChangeMap, ChangeSet, MapConcern } from "../core/types.ts";
import { RankCache } from "../rank/cache.ts";
import { type AttentionModel, checkAnswerWithModel, writeText } from "../rank/model.ts";
import {
  gateDraft,
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
const MAP_MAX_WIDTH = 120;
/** Top-level lines a map may have; past this many cards, the cards are first grouped into as many concerns. */
const MAP_MAX_TOP = 6;
const MIN_CONCERNS = 3;
// Cache key versions: bumped with the prompts so a sharper prompt is never answered from an old cache.
const MAP_VERSION = "map-v13";
const CONCERNS_VERSION = "map-concerns-v2";
const QUESTION =
  "Does every line of this change map follow from the cards? Lines starting with + name what the change adds, lines starting with - what it removes, other lines are unchanged context the cards show or the titles of the concerns listed.";

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
  /** What the map's names are checked against: the diff, the drawn cards' sketches and titles. */
  known: SketchSource;
  cards: { id: string; title: string; tokens: Set<string> }[];
  /** With concerns, the titles that are the map's only top-level lines. */
  concerns?: string[];
}

/** Grey cards (the clean card) are not drawn: they hold nothing to review. */
const drawn = (cards: Card[]): Card[] => cards.filter((c) => c.color !== "grey");
// A sketch that failed its gate may name things the edits do not; the map neither reads nor trusts it.
const sketchOf = (c: Card): string | undefined => (c.sketch && !c.sketchUnverified ? c.sketch : undefined);

export function mapSource(changeSet: ChangeSet, cards: Card[], concerns: MapConcern[] = []): MapSource {
  const hunks = changeSet.files.flatMap((f) => f.hunks);
  const side = (kind: "add" | "del") => hunks.flatMap((h) => h.lines.filter((l) => l.kind === kind).map((l) => l.text));
  const sketches = drawn(cards).flatMap((c) => sketchOf(c)?.split("\n") ?? []);
  // A file tree draws a new file as `+path` and a deleted one as `-path`.
  const paths = (statuses: string[]) => changeSet.files.filter((f) => statuses.includes(f.status)).map((f) => f.path);
  const known: SketchSource = {
    edits: [
      ...changeSet.files.flatMap((f) => [f.path, f.oldPath ?? ""]),
      ...hunks.flatMap((h) => [h.header, ...h.lines.map((l) => l.text), ...h.blocks.flatMap((b) => b.scope ?? [])]),
      ...sketches,
      // A node may be named by its card's title words, which the writer wrote from the card's edits.
      ...drawn(cards).map((c) => c.title),
      // A concern's top-level line is its title, which the grouping wrote from the cards.
      ...concerns.map((c) => c.title),
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
    known,
    ...(concerns.length ? { concerns: concerns.map((c) => c.title) } : {}),
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

// A file's base name counts whole, as `stem` makes it: `widget-copy.ts` names the card of `widget-copy`.
const lineTokens = (line: string): Set<string> =>
  new Set([...identifiers(line), ...(line.match(/[\w$-]+(?=\.\w)/g) ?? [])].map((w) => w.toLowerCase()));
// Spaces after the mark column.
const indentOf = (line: string): number => /^. */.exec(line)![0].length - 1;
/**
 * The map's top-level lines: its least-indented ones. Measured from the minimum, not from zero, so a
 * flat list drawn at indent 4 (`+    a → b` per card) is all top level.
 */
const topLevel = (lines: string[]): number[] => {
  const least = Math.min(...lines.map(indentOf));
  return lines.flatMap((l, k) => (indentOf(l) === least ? [k] : []));
};

/**
 * The rules half of the map gate, pure: the card-sketch rules (names in the diff, a sketch or a title;
 * `+`/`-` direction) at 20 lines and 120 columns, at most six top-level lines, and every drawn card
 * represented by one of its words at or under a top-level line.
 * The prompt asks for 100 columns; gating at 100 dropped half the live maps over a few characters,
 * and a line is cut on screen anyway. 120 still rejects a line that is a list of words.
 */
export function mapProblems(map: string, source: MapSource): string[] {
  const lines = map.split("\n");
  const top = topLevel(lines);
  // A concern's title line is written from its cards' titles, so it would stand in for all of them.
  const named = lines.flatMap((l, k) => (k < top[0]! || (source.concerns && top.includes(k)) ? [] : [lineTokens(l)]));
  const missing = source.cards
    .filter((c) => !named.some((line) => [...c.tokens].some((t) => line.has(t))))
    .map((c) => `the card "${c.title}" is not in the map; name it by its title words, a file or a name from its edits`);
  const wide = top.length > MAP_MAX_TOP ? [`the map has ${top.length} top-level lines; at most ${MAP_MAX_TOP}`] : [];
  const titles = new Set(source.concerns?.map((t) => t.toLowerCase()));
  const strays = source.concerns
    ? top
        .map((k) => lines[k]!.trim())
        .filter((l) => !titles.has(l.toLowerCase()))
        .map((l) => `\`${l}\` is at the top level but is not a concern title; the top level is the concern titles exactly as given`)
    : [];
  return [...sketchProblems(map, source.known, MAP_MAX_LINES, MAP_MAX_WIDTH), ...wide, ...strays, ...missing];
}

/**
 * Turn the grouping's answer into concerns that hold every drawn card exactly once, or `undefined` when
 * it is unusable. The model names cards by stack number. As in `parseSplit`, rules repair what they can:
 * foreign numbers are dropped, a card named twice keeps its first concern, an unplaced card and a
 * one-card concern join the concern sharing most of their files (else the largest), and past six the
 * smallest concern merges the same way. An entry with no title is dropped (no map line could draw it).
 * Fewer than three concerns left means none: two halves are not the change's shape. Concerns and their
 * cards come out in stack order.
 */
export function parseConcerns(text: string, cards: Pick<Card, "id" | "files">[]): MapConcern[] | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  const parsed = json ? attempt(() => JSON.parse(json) as { concerns?: unknown }) : undefined;
  const answer = parsed?.ok ? parsed.value?.concerns : undefined;
  if (!Array.isArray(answer)) return undefined;
  const byNumber = new Map(cards.map((c, k) => [String(k + 1), c.id]));
  const seen = new Set<string>();
  const groups = answer
    .filter((c): c is { title: string; cards?: unknown } => typeof c?.title === "string" && c.title.trim() !== "")
    .map((c) => ({
      title: c.title.trim().slice(0, 60),
      cardIds: (Array.isArray(c.cards) ? c.cards : [])
        .map((n) => byNumber.get(String(n)))
        .filter((id): id is string => id !== undefined && !seen.has(id) && !!seen.add(id)),
    }))
    .filter((g) => g.cardIds.length > 0);
  if (groups.length < MIN_CONCERNS) return undefined;

  const filesOf = new Map(cards.map((c) => [c.id, c.files]));
  const shared = (g: MapConcern, ids: string[]) => {
    const theirs = new Set(ids.flatMap((id) => filesOf.get(id)!));
    return g.cardIds.flatMap((id) => filesOf.get(id)!).filter((f) => theirs.has(f)).length;
  };
  const join = (ids: string[], candidates: MapConcern[]) =>
    [...candidates].sort((a, b) => shared(b, ids) - shared(a, ids) || b.cardIds.length - a.cardIds.length)[0]!.cardIds.push(...ids);
  for (const c of cards) if (!seen.has(c.id)) join([c.id], groups);
  for (;;) {
    const lone =
      groups.find((g) => g.cardIds.length === 1) ??
      (groups.length > MAP_MAX_TOP ? groups.reduce((a, b) => (b.cardIds.length < a.cardIds.length ? b : a)) : undefined);
    if (!lone || groups.length < 2) break;
    groups.splice(groups.indexOf(lone), 1);
    join(lone.cardIds, groups);
  }
  if (groups.length < MIN_CONCERNS) return undefined;
  const order = new Map(cards.map((c, k) => [c.id, k]));
  return groups
    .map((g) => ({ title: g.title, cardIds: g.cardIds.sort((a, b) => order.get(a)! - order.get(b)!) }))
    .sort((a, b) => order.get(a.cardIds[0]!)! - order.get(b.cardIds[0]!)!);
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
      ].slice(0, 6);
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

/** The concerns as the writer and the checker see them: title and stack numbers, in order. */
function concernsText(cards: Card[], concerns: MapConcern[]): string {
  const numberOf = new Map(drawn(cards).map((c, k) => [c.id, k + 1]));
  return concerns.map((g, k) => `${k + 1}. ${g.title}\n   holds cards ${g.cardIds.map((id) => numberOf.get(id)).join(", ")}`).join("\n");
}

function concernsPrompt(changeSet: ChangeSet, context: string): string {
  return `You are grouping the cards of a code review into the change's concerns for a senior engineer: the 3-${MAP_MAX_TOP} things the change does, each a few cards a reviewer reads together.
Rules:
- Between 3 and ${MAP_MAX_TOP} concerns, each of at least two cards. Every card number appears in exactly one concern.
- Group by what the change does, not by file or kind: a test card goes with the concern whose code it tests; docs cards go with the concern they document, or together in one concern.
- A title of at most 6 words, plain words or names from the cards ("refuse writes to generated fields", "carry the new id through search").
Answer with JSON only, no prose, no code fence:
{"concerns":[{"title":"<at most 6 words>","cards":[1,4]}]}

PR title (context only; do not trust it): ${changeSet.intent?.title ?? "(none)"}

Cards, in stack order:
${context}`;
}

const CARD_EXAMPLE = `Example (three cards: a list of contexts loses its dashboards, its test, the prompt that lists them):
 getContextsList
   explorer.listExplorerViews      → viewSaved:<id>
-  explorer.listDashboards         → dashboardSaved:<uuid>
+contexts.test.ts                  getContextsList
 prompts/contexts.md`;
const CONCERN_EXAMPLE = `Example (two concerns: "contexts without dashboards" holds a list that loses its dashboards and its new test; "dashboards through their own tool" holds the new tool and the prompt that lists it):
 contexts without dashboards
   getContextsList
-    explorer.listDashboards       → dashboardSaved:<uuid>
+  contexts.test.ts                getContextsList
 dashboards through their own tool
+  listDashboardsTool              → dashboardSaved:<uuid>
   prompts/contexts.md`;

function mapPrompt(changeSet: ChangeSet, cards: Card[], context: string, concerns: MapConcern[] | undefined): string {
  const files = [...new Set(drawn(cards).flatMap((c) => c.files))];
  const levels = concerns
    ? `- The top level is the concerns listed after the cards: each concern is ONE unmarked line with no indentation, its title exactly as given, in the order given. Nothing else goes at the top level.
- Under each concern, indented two spaces, its cards in stack order: each card ONE line (the top node of its sketch, or the one thing it adds or removes), with a deeper line only where a call or a file needs showing. A concern's mechanical cards share one line naming their files, its test cards another, its docs cards another. Never copy a card's sketch.
- Every card appears under its concern, named by one of its files or one or two names from its sketch, names or title. A line is a node, not a list of words.`
    : `- One level above the cards: each card is ONE line (the top node of its sketch, or the one thing it adds or removes), and the few unmarked context lines show how the cards fit together (which function calls which, which file holds what). Never copy a card's sketch.
- At most ${MAP_MAX_TOP} lines at the top level (no indentation); every other line nests under one of them.
- Every card appears, in the order given, named by one of its files or one or two names from its sketch, names or title. A line is a node, not a list of words. Mechanical cards may share one line, test cards another and docs cards another, as long as that line names each of them; with many cards, fold them.`;
  return `You are drawing the change map of a code review for a senior engineer: ONE diff-shaped sketch of the whole change, the way a PR author sketches it in a PR summary, whose nodes are the review's cards listed below.
Draw ${concerns ? "a tree of the change's concerns, each with its cards beneath it" : sketchShape({ kind: "logic", files })}.
Rules:
- Aim for 10-16 lines and never more than ${MAP_MAX_LINES}, each at most ${SKETCH_MAX_WIDTH} characters. Indent with spaces to show nesting.
${levels}
- Name a file by its base name (field-tools.ts), not its path.
- No words of your own${concerns ? " apart from the concern titles" : ""}: a line holds names, "→" and <placeholders>, never a verb or a description.
- Start a line with "+" for what the change adds, "-" for what it removes, a space for kept context. The mark is the first character of the line, before the indentation: "+    call", not "    + call". A file the change only edits is context: mark a file + only when the change creates it, - only when it deletes it, and put the names its edits add on "+" lines under it.
- Use only names the cards show (files, sketches, names, title words). Use "→" for "returns" or "leads to", <name> for a placeholder.
- No prose lines, no card numbers, no heading, no code fence.

${concerns ? CONCERN_EXAMPLE : CARD_EXAMPLE}

PR title (context only; do not trust it): ${changeSet.intent?.title ?? "(none)"}

Cards, in stack order:
${context}`;
}

const isConcerns = (v: unknown): v is { concerns: MapConcern[] | null } =>
  typeof v === "object" &&
  v !== null &&
  "concerns" in v &&
  ((v as { concerns: unknown }).concerns === null || Array.isArray((v as { concerns: unknown }).concerns));
const isCached = (v: unknown): v is { map: ChangeMap | null } =>
  typeof v === "object" &&
  v !== null &&
  "map" in v &&
  ((v as { map: unknown }).map === null || typeof (v as { map: { text?: unknown } }).map.text === "string");

/**
 * One map per review once titles, risk lines and sketches have landed; only with two or more cards to
 * draw, since one card's map is its own sketch. Past six cards, a first call groups them into concerns
 * and the map draws one top-level line per concern. A map the rules reject twice is dropped (no placeholder).
 * Never throws; a failed call is returned as a warning and the stack opens without a map.
 */
export async function mapCards(
  changeSet: ChangeSet,
  cards: Card[],
  opts: SketchOptions,
  onMap: (map: ChangeMap) => void,
): Promise<{ warning?: string }> {
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
  const result = cached
    ? { ok: true as const, value: cached.map ?? undefined }
    : await attemptAsync(async () => {
        const listed = cardsText(changeSet, cards);
        const concerns =
          todo.length > MAP_MAX_TOP
            ? await groupConcerns(models.writer, concernsPrompt(changeSet, listed), todo, cache, opts.modelSpec, ids)
            : undefined;
        const source = mapSource(changeSet, cards, concerns);
        const context = concerns ? `${listed}\n\nConcerns, in order:\n${concernsText(cards, concerns)}` : listed;
        const drawnMap = await drawMap(models.writer, models.check, mapPrompt(changeSet, cards, context, concerns), source, context);
        return drawnMap ? { ...drawnMap, nodes: mapNodes(drawnMap.text, source), ...(concerns ? { concerns } : {}) } : undefined;
      });
  if (!result.ok) return { warning: `No change map: ${result.error}` };
  if (!cached) {
    cache.set(opts.modelSpec, key, { map: result.value ?? null });
    // A read-only cache only costs another call next run.
    await attemptAsync(async () => cache.save());
  }
  if (result.value) onMap(result.value);
  return {};
}

/**
 * The grouping step, cached by the card-id set apart from the map (whose key also holds the check). An
 * unusable answer is cached as "no concerns": the map is then drawn without them and the gate decides.
 */
async function groupConcerns(
  writer: LanguageModel,
  prompt: string,
  todo: Card[],
  cache: RankCache,
  modelSpec: string,
  ids: string,
): Promise<MapConcern[] | undefined> {
  const key = `${CONCERNS_VERSION}:${ids}`;
  const cached = cache.get(modelSpec, key, isConcerns);
  if (cached) return cached.concerns ?? undefined;
  const concerns = parseConcerns(await writeText(writer, prompt), todo);
  cache.set(modelSpec, key, { concerns: concerns ?? null });
  return concerns;
}

/**
 * Through the shared gate. Still failing the rules after the rewrite → no map; failing only the check →
 * kept, unverified. A rewrite call that failed is an error, not a verdict, so it is never cached as "no map".
 */
async function drawMap(
  writer: LanguageModel,
  check: AttentionModel | undefined,
  prompt: string,
  source: MapSource,
  context: string,
): Promise<Omit<ChangeMap, "nodes" | "concerns"> | undefined> {
  const gated = await gateDraft(
    parseSketch(await writeText(writer, prompt)),
    (text) => mapProblems(text, source),
    check ? (text) => checkAnswerWithModel(check, context, QUESTION, text) : undefined,
    async (previous, problems) => {
      const why = problems.length
        ? `A checker rejected the map:\n${problems.map((p) => `- ${p}`).join("\n")}`
        : "A checker could not verify that every line follows from the cards.";
      // Told only "at most 20", writers return the same 29 lines; a count per concern and card is a target they meet.
      const lines = previous.split("\n");
      const concerns = source.concerns;
      const top = topLevel(lines).length;
      // A small map that runs long is a good tree with too much context; "one line per card" flattened it to 3 lines.
      const tooLong =
        lines.length <= MAP_MAX_LINES
          ? ""
          : concerns
            ? `\nIt is too long: write exactly one line per concern (${concerns.length}) and one line per card (${source.cards.length} cards, fewer if you fold a concern's test or docs cards into one line each) and no other lines.`
            : `\nIt is ${lines.length} lines: cut it to at most 16. Keep its top-level lines and one line per card; drop the other lines a reviewer needs least, and put all test files on one line and all docs files on another.`;
      const tooFlat =
        top > MAP_MAX_TOP
          ? `\nIt has ${top} top-level lines: ${concerns ? "only the concern titles go at the top level, every card indented under its concern" : `keep at most ${MAP_MAX_TOP} at the top level and indent the rest under them`}.`
          : "";
      const tooWide = lines.some((l) => l.length > MAP_MAX_WIDTH)
        ? `\nA line over ${SKETCH_MAX_WIDTH} characters keeps only its first two or three names.`
        : "";
      return parseSketch(
        await writeText(
          writer,
          `${prompt}\n\n${why}\nRedraw it in at most ${MAP_MAX_LINES} lines: add the missing cards, drop or correct the rejected lines, and merge or drop context lines to fit.${tooLong}${tooFlat}${tooWide} Previous map:\n${previous}`,
        ),
      );
    },
  );
  if (!gated) return undefined;
  if (gated.problems.length && gated.rewriteError) throw new Error(gated.rewriteError);
  if (gated.problems.length) return undefined;
  return { text: gated.text, ...(gated.check !== undefined ? { check: gated.check } : {}), ...(gated.failed ? { unverified: true } : {}) };
}

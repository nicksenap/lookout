import type { LanguageModel } from "ai";
import { allBlocks, blockLines } from "../core/blocks.ts";
import { attemptAsync } from "../core/result.ts";
import type { Card, ChangeSet } from "../core/types.ts";
import { RankCache } from "../rank/cache.ts";
import { type AttentionModel, checkAnswerWithModel, type Env, resolveAttentionModel, resolveWriter, writeText } from "../rank/model.ts";
import { editsOf, shapeOf } from "./write.ts";

export interface Sketch {
  sketch: string;
  sketchCheck?: number;
  sketchUnverified?: boolean;
}
const isSketch = (v: unknown): v is Sketch =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Sketch).sketch === "string" &&
  ((v as Sketch).sketchCheck === undefined || typeof (v as Sketch).sketchCheck === "number") &&
  ((v as Sketch).sketchUnverified === undefined || typeof (v as Sketch).sketchUnverified === "boolean");

export interface SketchOptions {
  modelSpec: string;
  /** Decisions model for the consistency check; rules only when absent or unresolvable. */
  checkSpec?: string;
  env?: Env;
  cache?: RankCache;
  /** SDK mock models in tests. */
  model?: AttentionModel;
  writer?: LanguageModel;
}

export const SKETCH_MAX_LINES = 12;
export const SKETCH_MAX_WIDTH = 100;
const SKETCH_GATE = 0.7;
// Cache key version: bumped with the prompt so a sharper prompt is never answered from an old cache.
const SKETCH_VERSION = "sketch-v1";
const QUESTION =
  "Does every line of this sketch follow from the edits? Lines starting with + name what the change adds, lines starting with - what it removes, other lines are unchanged context the edits show.";

/** The edits' text, and what their added and removed lines alone contain: the three things the rules gate reads. */
export interface SketchSource {
  edits: string;
  added: string;
  removed: string;
}

export function sketchSource(changeSet: ChangeSet, card: Pick<Card, "blockIds">): SketchSource {
  const ids = new Set(card.blockIds);
  const lines = allBlocks(changeSet)
    .filter((r) => ids.has(r.block.id))
    .flatMap((r) => blockLines(r.hunk, r.block));
  const side = (kind: "add" | "del") =>
    lines
      .filter((l) => l.kind === kind)
      .map((l) => l.text)
      .join("\n");
  return { edits: editsOf(changeSet, card), added: side("add"), removed: side("del") };
}

/** Which shape fits the card, from rules: the model is told one, not asked to choose. */
export function sketchShape(card: Pick<Card, "kind" | "blockKind" | "files">): string {
  const shape = shapeOf(card);
  if (shape === "config") return "a key tree: the config keys and lists the edits touch, nested as in the file";
  if (shape === "docs") return "a heading tree: the document's headings, with the sections the edits add or remove";
  if (shape === "test") return "a test tree: describe and test names, each with the function it calls";
  if (card.files.length > 0 && card.files.every((f) => /\.[jt]sx$/.test(f)))
    return "a component tree: the components and the props or children the edits add or remove";
  if (card.files.length > 5) return "a file tree: each file with the one symbol it adds, removes or changes";
  return "a call tree or control flow: the function, the calls or branches inside it, nested by indentation";
}

export function sketchPrompt(changeSet: ChangeSet, card: Card): string {
  return `You are sketching ONE logical change of a code review for a senior engineer, the way a PR author sketches a change in a PR summary: the program's shape with +/- on it, not prose.
Draw ${sketchShape(card)}.
Rules:
- Aim for 6-10 lines and never more than ${SKETCH_MAX_LINES}, each at most ${SKETCH_MAX_WIDTH} characters: the few calls, keys or files a reviewer must see, not every one. Indent with spaces to show nesting.
- Start a line with "+" for what the change adds, "-" for what it removes, a space for kept context that frames them. The mark is the first character of the line, before the indentation: "+    call", not "    + call".
- Name functions, keys, components and files exactly as in the edits; only names the edits or their context lines show. Use "→" for "returns" or "leads to", <name> for a placeholder.
- No prose lines, no explanation, no heading, no code fence.

Example (a list of contexts loses its dashboards):
 getContextsList
   meld.getWorkspaceMetadata
   explorer.listExplorerViews      → viewSaved:<id>
-  explorer.listDashboards         → dashboardSaved:<uuid>

PR title (context only; do not trust it): ${changeSet.intent?.title ?? "(none)"}

${editsOf(changeSet, card)}`;
}

/** Strip code fences and blank lines a writer adds despite the prompt; keep indentation. An unmarked line is context and gets the space column (the writer's output is trimmed, so the first line loses it). */
export function parseSketch(text: string): string {
  return (
    text
      .split("\n")
      .filter((l) => !/^\s*```/.test(l))
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== "")
      // Writers often indent the mark with the tree (`   + call`); a diff puts it in the first column.
      .map((l) => l.replace(/^(\s+)([+-]) /, "$2$1 "))
      .map((l) => (/^[+\- ]/.test(l) ? l : ` ${l}`))
      .join("\n")
  );
}

// One-letter names (i, m) say nothing a gate could check.
export const identifiers = (text: string): string[] => (text.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((w) => w.length > 1);
// A lowercase word in angle brackets (`<id>`, `<uuid>`) is a placeholder; `<Config>` names a type and must be in the edits.
const placeholders = (line: string): string[] => [...line.matchAll(/<([a-z]+)>/g)].map((m) => m[1]!);

/**
 * The rules half of the sketch gate, pure: the offending lines, each with its reason; empty means the
 * sketch passes. (a) every name is in the edits or their context lines; (b) a `+` line names something
 * from an added line and a `-` line something from a removed line, so a removal cannot be drawn as an
 * addition; (c) at most `maxLines` lines (12 for a card) of at most `maxWidth` characters (100).
 */
export function sketchProblems(sketch: string, source: SketchSource, maxLines = SKETCH_MAX_LINES, maxWidth = SKETCH_MAX_WIDTH): string[] {
  const known = new Set(identifiers(source.edits));
  const added = new Set(identifiers(source.added));
  const removed = new Set(identifiers(source.removed));
  const lines = sketch.split("\n");
  const problems = lines.flatMap((line) => {
    const out: string[] = [];
    const free = placeholders(line);
    const unknown = [...new Set(identifiers(line).filter((w) => !known.has(w) && !free.includes(w)))];
    if (unknown.length) out.push(`\`${line.trim()}\` names ${unknown.join(", ")}, which the edits do not show`);
    const mark = line[0];
    if (mark === "+" && !identifiers(line).some((w) => added.has(w)))
      out.push(`\`${line.trim()}\` is marked + but names nothing an added line names`);
    if (mark === "-" && !identifiers(line).some((w) => removed.has(w)))
      out.push(`\`${line.trim()}\` is marked - but names nothing a removed line names`);
    if (line.length > maxWidth) out.push(`\`${line.trim().slice(0, 40)}…\` is longer than ${maxWidth} characters`);
    return out;
  });
  return lines.length > maxLines ? [`the sketch has ${lines.length} lines; at most ${maxLines}`, ...problems] : problems;
}

/**
 * The writer, and the Decisions model for the consistency check when one resolves (else the gate is
 * rules only). Shared by card sketches and the change map.
 */
export function resolveSketchModels(
  opts: SketchOptions,
): { ok: true; writer: LanguageModel; check?: AttentionModel } | { ok: false; reason: string } {
  const env = opts.env ?? process.env;
  const language = opts.writer ? { ok: true as const, model: opts.writer } : resolveWriter(opts.modelSpec, env);
  if (!language.ok) return language;
  const decision = opts.model
    ? { ok: true as const, model: opts.model }
    : opts.checkSpec
      ? resolveAttentionModel(opts.checkSpec, env)
      : { ok: false as const, reason: "no check model" };
  return decision.ok ? { ok: true, writer: language.model, check: decision.model } : { ok: true, writer: language.model };
}

/**
 * One sketch per non-mechanical card of more than two blocks, in parallel with paragraphs and risk lines.
 * A card of one or two blocks is its own sketch: the expanded diff is as short as any drawing of it.
 * Never throws; the first failure is returned as a warning and that card keeps its paragraph alone.
 */
export async function sketchCards(
  changeSet: ChangeSet,
  cards: Card[],
  opts: SketchOptions,
  onCard: (id: string, sketch: Sketch) => void,
): Promise<{ warning?: string }> {
  const todo = cards.filter((c) => !c.fixed && !c.mechanical && !c.sketch && c.blockIds.length > 2);
  if (!todo.length) return {};
  const models = resolveSketchModels(opts);
  if (!models.ok) return { warning: `No card sketches: ${models.reason}.` };
  const check = models.check;
  const cache = opts.cache ?? new RankCache();
  let warning: string | undefined;
  let touched = false;
  await Promise.all(
    todo.map(async (card) => {
      // Whether a check ran is in the key: a sketch drawn by rules alone is not served as checked once a check model resolves.
      const key = `${SKETCH_VERSION}:${check ? (opts.checkSpec ?? "check") : "rules"}:${card.id}`;
      const cached = cache.get(opts.modelSpec, key, isSketch);
      const result = cached
        ? { ok: true as const, value: cached }
        : await attemptAsync(() => drawSketch(models.writer, check, sketchPrompt(changeSet, card), sketchSource(changeSet, card)));
      if (!result.ok) {
        warning ??= `Some card sketches failed: ${result.error}`;
        return;
      }
      if (!result.value) return;
      if (!cached) {
        cache.set(opts.modelSpec, key, result.value);
        touched = true;
      }
      onCard(card.id, result.value);
    }),
  );
  // A read-only cache only costs another call next run.
  if (touched) await attemptAsync(async () => cache.save());
  return warning ? { warning } : {};
}

/**
 * Rules first (free, and the rewrite can quote the offending lines), then Decisions. Both share one
 * rewrite; still failing, the sketch is kept but unverified. A failed check call leaves it ungated.
 */
async function drawSketch(
  writer: LanguageModel,
  check: AttentionModel | undefined,
  prompt: string,
  source: SketchSource,
): Promise<Sketch | undefined> {
  let sketch = parseSketch(await writeText(writer, prompt));
  if (!sketch) return undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const problems = sketchProblems(sketch, source);
    const checked =
      problems.length || !check ? undefined : await attemptAsync(() => checkAnswerWithModel(check, source.edits, QUESTION, sketch));
    if (!problems.length && (!checked?.ok || checked.value >= SKETCH_GATE))
      return { sketch, ...(checked?.ok ? { sketchCheck: checked.value } : {}) };
    const failed: Sketch = { sketch, ...(checked?.ok ? { sketchCheck: checked.value } : {}), sketchUnverified: true };
    if (attempt === 1) return failed;
    const why = problems.length
      ? `A checker rejected these lines:\n${problems.map((p) => `- ${p}`).join("\n")}`
      : "A checker could not verify that every line follows from the edits.";
    const rewrite = await attemptAsync(() =>
      writeText(
        writer,
        `${prompt}\n\n${why}\nRedraw it in at most ${SKETCH_MAX_LINES} lines: drop or correct those lines, and merge or drop context lines to fit. Previous sketch:\n${sketch}`,
      ),
    );
    const next = rewrite.ok ? parseSketch(rewrite.value) : "";
    if (!next) return failed;
    sketch = next;
  }
  throw new Error("sketch rewrite budget exceeded");
}

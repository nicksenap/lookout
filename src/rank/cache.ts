import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { attempt } from "../core/result.ts";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "lookout");

/** Model attention scores keyed by `${model}|${hunkId}`, persisted as one JSON file. */
export class RankCache {
  private readonly file: string;
  private entries: Record<string, unknown>;

  constructor(private readonly dir: string = DEFAULT_CACHE_DIR) {
    this.file = join(dir, "cache-v2.json"); // v2: values are JSON (judgements, paragraphs), not bare scores
    // A missing or corrupt cache file only costs a re-rank.
    const parsed = attempt((): unknown => JSON.parse(readFileSync(this.file, "utf8")));
    this.entries = parsed.ok && parsed.value && typeof parsed.value === "object" ? (parsed.value as Record<string, unknown>) : {};
  }

  private static key(model: string, id: string): string {
    return `${model}|${id}`;
  }

  /** Any JSON value keyed by model + content id; callers narrow the type. */
  get<T>(model: string, id: string, isT: (v: unknown) => v is T): T | undefined {
    const v = this.entries[RankCache.key(model, id)];
    return isT(v) ? v : undefined;
  }

  set(model: string, id: string, value: unknown): void {
    this.entries[RankCache.key(model, id)] = value;
  }

  save(): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries));
    renameSync(tmp, this.file);
  }
}

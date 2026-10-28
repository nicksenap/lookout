import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { attempt, err, ok, type Result } from "../core/result.ts";
import { DEFAULT_POLICY, type Policy, validatePolicy } from "../policy/schema.ts";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "lookout", "config.toml");
export const DEFAULT_MODEL = "openai:gpt-6-luna";
/** Placeholders allowed in `dispatch.<name>.cmd`. */
export const PLACEHOLDERS = ["prompt", "prompt_file", "repo", "diff_file"] as const;
/** Placeholders allowed in the `prompt` template. */
export const PROMPT_PLACEHOLDERS = ["repo", "scope", "intent", "diff", "contract"] as const;

export interface DispatcherConfig {
  name: string;
  cmd: string;
}

export interface Config {
  /** `decide`: the Decisions model (ranking, kinds, claims). `write`: the language model for titles and paragraphs. */
  model: { decide: string; write: string };
  /** @deprecated alias of model.decide, kept for `[rank] model = …` files. */
  rank: { model: string };
  /** Ordered as written in the file; the first is the default. */
  dispatchers: DispatcherConfig[];
  /** Optional override of the default prompt template. */
  prompt?: string;
  /** Which dispatcher verifies findings; the first dispatcher when unset. */
  verifier?: string;
  policy: Policy;
  /** Where the config came from, for error messages. */
  source: string;
}

export const REPO_CONFIG_NAME = ".lookout.toml";

export const BUILTIN_DISPATCHERS: DispatcherConfig[] = [{ name: "pi", cmd: "pi -p @{prompt_file}" }];

const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `{name}` tokens (identifier names only, so JSON like `{"a": 1}` is left alone). */
export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
}

export function checkPlaceholders(template: string, where: string, allowed: readonly string[]): Result<void> {
  const unknown = placeholdersIn(template).find((name) => !allowed.includes(name));
  if (unknown) return err(`${where}: unknown placeholder {${unknown}}. Allowed: ${allowed.map((p) => `{${p}}`).join(" ")}`);
  return ok(undefined);
}

export const DEFAULT_CONFIG: Config = {
  model: { decide: DEFAULT_MODEL, write: DEFAULT_MODEL },
  rank: { model: DEFAULT_MODEL },
  dispatchers: BUILTIN_DISPATCHERS,
  policy: DEFAULT_POLICY,
  source: "built-in defaults",
};

const MODEL_SPEC = /^[\w.-]+:.+$/;

/**
 * Validate a parsed TOML document layered over `base`: rank, dispatch and prompt replace
 * the base's when present; areas and policy layer (see validatePolicy). Hand-written
 * checks so messages name the exact key.
 */
export function validateConfig(raw: unknown, source: string, base: Config = DEFAULT_CONFIG): Result<Config> {
  if (!isTable(raw)) return err(`${source}: expected a TOML table at top level`);
  const known = new Set(["model", "rank", "dispatch", "prompt", "verify", "areas", "policy"]);
  for (const key of Object.keys(raw))
    if (!known.has(key)) return err(`${source}: unknown key "${key}" (expected model, dispatch, prompt, verify, areas, policy)`);

  let decide = base.model.decide;
  let write = base.model.write;
  if (raw.rank !== undefined) {
    if (!isTable(raw.rank)) return err(`${source}: [rank] must be a table`);
    for (const key of Object.keys(raw.rank)) if (key !== "model") return err(`${source}: unknown key "rank.${key}" (expected rank.model)`);
    if (raw.rank.model !== undefined) {
      if (typeof raw.rank.model !== "string" || !MODEL_SPEC.test(raw.rank.model))
        return err(`${source}: rank.model must be a "provider:model" string, e.g. "${DEFAULT_MODEL}"`);
      decide = raw.rank.model;
      write = raw.rank.model;
    }
  }
  if (raw.model !== undefined) {
    if (!isTable(raw.model)) return err(`${source}: [model] must be a table with decide and/or write`);
    for (const key of Object.keys(raw.model))
      if (key !== "decide" && key !== "write") return err(`${source}: unknown key "model.${key}" (expected decide, write)`);
    for (const key of ["decide", "write"] as const) {
      const v = raw.model[key];
      if (v === undefined) continue;
      if (typeof v !== "string" || !MODEL_SPEC.test(v))
        return err(`${source}: model.${key} must be a "provider:model" string, e.g. "${DEFAULT_MODEL}"`);
      if (key === "decide") decide = v;
      else write = v;
    }
  }
  const model = decide;

  let dispatchers = base.dispatchers;
  if (raw.dispatch !== undefined) {
    if (!isTable(raw.dispatch)) return err(`${source}: [dispatch] must contain [dispatch.<name>] tables`);
    const list: DispatcherConfig[] = [];
    for (const [name, d] of Object.entries(raw.dispatch)) {
      if (!isTable(d)) return err(`${source}: [dispatch.${name}] must be a table with a cmd`);
      for (const key of Object.keys(d)) if (key !== "cmd") return err(`${source}: unknown key "dispatch.${name}.${key}" (expected cmd)`);
      if (typeof d.cmd !== "string" || d.cmd.trim() === "") return err(`${source}: dispatch.${name}.cmd must be a non-empty string`);
      const placeholders = checkPlaceholders(d.cmd, `${source}: dispatch.${name}.cmd`, PLACEHOLDERS);
      if (!placeholders.ok) return placeholders;
      list.push({ name, cmd: d.cmd });
    }
    if (list.length === 0) return err(`${source}: [dispatch] has no dispatchers`);
    dispatchers = list;
  }

  const policy = validatePolicy(raw, source, base.policy);
  if (!policy.ok) return policy;

  const config: Config = { model: { decide, write }, rank: { model }, dispatchers, policy: policy.value, source };
  if (raw.prompt !== undefined) {
    if (typeof raw.prompt !== "string" || raw.prompt.trim() === "") return err(`${source}: prompt must be a non-empty string`);
    const placeholders = checkPlaceholders(raw.prompt, `${source}: prompt`, PROMPT_PLACEHOLDERS);
    if (!placeholders.ok) return placeholders;
    config.prompt = raw.prompt;
  } else if (base.prompt !== undefined) config.prompt = base.prompt;
  if (raw.verify !== undefined) {
    if (!isTable(raw.verify)) return err(`${source}: [verify] must be a table with dispatcher`);
    for (const key of Object.keys(raw.verify))
      if (key !== "dispatcher") return err(`${source}: unknown key "verify.${key}" (expected dispatcher)`);
    const verifier = raw.verify.dispatcher;
    if (verifier !== undefined) {
      if (typeof verifier !== "string" || !dispatchers.some((d) => d.name === verifier))
        return err(`${source}: verify.dispatcher must name a [dispatch.<name>] (have: ${dispatchers.map((d) => d.name).join(", ")})`);
      config.verifier = verifier;
    }
  } else if (base.verifier !== undefined && dispatchers.some((d) => d.name === base.verifier)) config.verifier = base.verifier;
  return ok(config);
}

function loadFile(path: string, base: Config): Result<Config> {
  const raw = attempt((): unknown => Bun.TOML.parse(readFileSync(path, "utf8")));
  if (!raw.ok) return err(`${path}: invalid TOML: ${raw.error}`);
  return validateConfig(raw.value, path, base);
}

/** Global config, then the repo's `.lookout.toml` layered on top when `repoRoot` is given. */
export function loadConfig(path: string = DEFAULT_CONFIG_PATH, repoRoot?: string): Result<Config> {
  const global = existsSync(path) ? loadFile(path, DEFAULT_CONFIG) : ok(DEFAULT_CONFIG);
  if (!global.ok) return global;
  const repoFile = repoRoot ? join(repoRoot, REPO_CONFIG_NAME) : undefined;
  if (!repoFile || !existsSync(repoFile)) return global;
  return loadFile(repoFile, global.value);
}

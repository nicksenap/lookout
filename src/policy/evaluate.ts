import { allBlocks } from "../core/blocks.ts";
import { ATTENTION_ORDER, type Attention, type ChangeKind, type ChangeSet, type Classification, TIER_ORDER, type Tier, type Verdict } from "../core/types.ts";
import { globToRegExp } from "../rank/rules.ts";
import type { Policy } from "./schema.ts";

const rank = (a: Attention) => ATTENTION_ORDER.indexOf(a);
const tierRank = (t: Tier) => TIER_ORDER.indexOf(t);
const maxTier = (a: Tier, b: Tier): Tier => (tierRank(a) >= tierRank(b) ? a : b);

const CONFIG_RE = /(^|\/)(\.env[^/]*|[^/]+\.(toml|ya?ml|json|json5|ini|cfg|conf|properties|env))$/i;
const DEPS_RE = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|build\.gradle(\.kts)?|pom\.xml|Gemfile|composer\.json)$/;

export function areasOf(policy: Policy, path: string): string[] {
  const out: string[] = [];
  for (const [name, globs] of Object.entries(policy.areas)) if (globs.some((g) => globToRegExp(g).test(path))) out.push(name);
  return out;
}

/** Change-level kind from the non-inert blocks. "logic" is the default; narrower kinds need every block to agree. */
export function kindOf(blocks: { path: string; labels: string[]; hasDeletions: boolean }[]): ChangeKind {
  if (blocks.length === 0) return "docs";
  const every = (f: (b: (typeof blocks)[number]) => boolean) => blocks.every(f);
  if (every((b) => b.labels.includes("docs"))) return "docs";
  if (every((b) => b.labels.includes("test"))) return "test";
  if (every((b) => b.labels.includes("lockfile") || DEPS_RE.test(b.path))) return "deps";
  if (every((b) => b.labels.includes("ci"))) return "ci";
  if (every((b) => CONFIG_RE.test(b.path) && !DEPS_RE.test(b.path))) return "config";
  // Additive: nothing removed in non-test code (new files, new functions, new tests). Edits to existing lines are logic.
  if (every((b) => b.labels.includes("test") || b.labels.includes("docs") || !b.hasDeletions)) return "additive";
  return "logic";
}

export function classify(changeSet: ChangeSet, policy: Policy): Classification {
  const refs = allBlocks(changeSet);
  const live = refs.filter((r) => r.block.attention !== "inert");
  const areas = new Set<string>();
  const sensitivePaths = new Set<string>();
  let maxAttention: Attention = "inert";
  for (const r of live) {
    for (const a of areasOf(policy, r.block.path)) areas.add(a);
    if (r.block.labels.includes("sensitive")) sensitivePaths.add(r.block.path);
    if (rank(r.block.attention) > rank(maxAttention)) maxAttention = r.block.attention;
  }
  const kind = kindOf(
    live.map((r) => ({
      path: r.block.path,
      labels: r.block.labels,
      hasDeletions: r.hunk.lines.slice(r.block.from, r.block.to).some((l) => l.kind === "del") && r.file.status !== "added",
    })),
  );
  return {
    kind,
    areas: [...areas].sort(),
    maxAttention,
    sensitivePaths: [...sensitivePaths].sort(),
    counts: { files: changeSet.files.length, blocks: refs.length, inert: refs.length - live.length },
  };
}

/**
 * Tier = max(kind default, every matching rule, floors). Floors are not configurable:
 * a touched area is never low, and a needs-eyes or suspicious block is at least medium
 * (an amber or red card with zero required humans would contradict itself).
 */
export function evaluate(c: Classification, policy: Policy): Verdict {
  const reasons: { tier: Tier; text: string }[] = [];
  let tier: Tier = policy.kinds[c.kind];
  reasons.push({ tier, text: `${c.kind} change → ${tier}` });

  for (const rule of policy.rules) {
    if (rule.area && !c.areas.includes(rule.area)) continue;
    if (rule.kind && c.kind !== rule.kind) continue;
    if (rule.attention && rank(c.maxAttention) < rank(rule.attention)) continue;
    const what = rule.reason ?? [rule.area && `touches ${rule.area}`, rule.kind && `${rule.kind} change`, rule.attention && `a block is ${rule.attention}`].filter(Boolean).join(", ");
    reasons.push({ tier: rule.tier, text: `${what} → ${rule.tier}` });
    tier = maxTier(tier, rule.tier);
  }

  if (c.areas.length > 0 && tier === "low") {
    tier = "medium";
    reasons.push({ tier, text: `touches ${c.areas.join(", ")}: never low` });
  }
  if (rank(c.maxAttention) >= rank("needs-eyes") && tierRank(tier) < tierRank("medium")) {
    tier = "medium";
    reasons.push({ tier, text: `a block ${c.maxAttention === "suspicious" ? "is suspicious" : "needs eyes"}: at least medium` });
  }
  if (c.sensitivePaths.length > 0 && tier === "low") {
    tier = "medium";
    reasons.push({ tier, text: `sensitive path ${c.sensitivePaths[0]}${c.sensitivePaths.length > 1 ? ` (+${c.sensitivePaths.length - 1})` : ""}: never low` });
  }

  reasons.sort((a, b) => tierRank(b.tier) - tierRank(a.tier));
  return { tier, requiredHumans: policy.humans[tier], reasons: reasons.map((r) => r.text) };
}

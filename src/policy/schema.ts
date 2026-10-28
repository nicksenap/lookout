import { err, ok, type Result } from "../core/result.ts";
import type { ChangeKind, Tier } from "../core/types.ts";

/** A rule raises the tier to at least `tier` when every stated condition holds and no `unless` condition does. */
export interface PolicyRule {
  area?: string;
  kind?: ChangeKind;
  /** Any block at or above this attention. */
  attention?: "needs-eyes" | "suspicious";
  tier: Tier;
  reason?: string;
  /**
   * The rule stands down when the change is of this kind and (with `oneWay: false`) shows no
   * one-way signal. Lets `infra → high` skip a reversible additive line while a migration stays high.
   */
  unless?: { kind: ChangeKind; oneWay?: false };
}

export interface Policy {
  /** Area name → path globs (same syntax as rank/rules globs). */
  areas: Record<string, string[]>;
  /** Minimum tier per change kind, before rules and floors. */
  kinds: Record<ChangeKind, Tier>;
  humans: Record<Tier, 0 | 1 | 2>;
  rules: PolicyRule[];
  source: string;
}

export const DEFAULT_AREAS: Record<string, string[]> = {
  auth: [
    "**/auth/**",
    "**/auth*.*",
    "**/authn/**",
    "**/authz/**",
    "**/oauth/**",
    "**/oidc/**",
    "**/sso/**",
    "**/session/**",
    "**/sessions/**",
    "**/*token*",
    "**/*credential*",
    "**/*password*",
    "**/*secret*",
    "**/permission*/**",
    "**/rbac/**",
  ],
  billing: ["**/billing/**", "**/payment/**", "**/payments/**", "**/stripe/**", "**/invoice*/**"],
  // Deliberately narrow: `schema.ts` is a common name for validation code, not a database.
  data: ["**/migration/**", "**/migrations/**", "*.sql", "**/prisma/**", "**/db/schema*", "**/database/**", "**/*.prisma"],
  infra: ["**/terraform/**", "*.tf", "**/k8s/**", "**/helm/**", "Dockerfile*", "**/infra/**", ".github/workflows/**"],
  prompts: ["**/prompts/**", "**/prompt/**", "*.prompt.*", "**/system-prompt*"],
};

export const DEFAULT_KINDS: Record<ChangeKind, Tier> = {
  docs: "low",
  test: "low",
  additive: "low",
  deps: "medium",
  config: "medium",
  ci: "high",
  logic: "medium",
};

export const DEFAULT_HUMANS: Record<Tier, 0 | 1 | 2> = { low: 0, medium: 1, high: 2 };

export const DEFAULT_RULES: PolicyRule[] = [
  { area: "auth", tier: "high", reason: "touches auth" },
  { area: "billing", tier: "high", reason: "touches billing" },
  { area: "data", tier: "high", reason: "touches data schema or migrations" },
  // One reversible additive line in infra (a served-tools entry, a flag) is medium: the floors keep it off low.
  { area: "infra", tier: "high", reason: "touches infra or CI", unless: { kind: "additive", oneWay: false } },
  { area: "prompts", tier: "medium", reason: "touches prompts" },
];

export const DEFAULT_POLICY: Policy = {
  areas: DEFAULT_AREAS,
  kinds: DEFAULT_KINDS,
  humans: DEFAULT_HUMANS,
  rules: DEFAULT_RULES,
  source: "built-in defaults",
};

const KINDS: ChangeKind[] = ["docs", "test", "deps", "ci", "config", "additive", "logic"];
const TIERS: Tier[] = ["low", "medium", "high"];
const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Validate the `areas` and `policy` tables of a parsed TOML document, layered over `base`.
 * `areas` replaces areas by name (an empty list removes one); `policy.rules` replaces the rule list.
 */
export function validatePolicy(raw: Record<string, unknown>, source: string, base: Policy = DEFAULT_POLICY): Result<Policy> {
  const policy: Policy = {
    ...base,
    areas: { ...base.areas },
    kinds: { ...base.kinds },
    humans: { ...base.humans },
    rules: [...base.rules],
    source,
  };

  if (raw.areas !== undefined) {
    if (!isTable(raw.areas)) return err(`${source}: [areas] must be a table of name = [globs]`);
    for (const [name, globs] of Object.entries(raw.areas)) {
      if (!isStringArray(globs)) return err(`${source}: areas.${name} must be an array of glob strings`);
      if (globs.length === 0) delete policy.areas[name];
      else policy.areas[name] = globs;
    }
  }

  if (raw.policy !== undefined) {
    if (!isTable(raw.policy)) return err(`${source}: [policy] must be a table`);
    for (const key of Object.keys(raw.policy)) {
      if (!["kinds", "humans", "rules"].includes(key)) return err(`${source}: unknown key "policy.${key}" (expected kinds, humans, rules)`);
    }
    const p = raw.policy;
    if (p.kinds !== undefined) {
      if (!isTable(p.kinds)) return err(`${source}: [policy.kinds] must be a table`);
      for (const [kind, tier] of Object.entries(p.kinds)) {
        if (!KINDS.includes(kind as ChangeKind)) return err(`${source}: policy.kinds.${kind}: unknown kind (expected ${KINDS.join(", ")})`);
        if (!TIERS.includes(tier as Tier)) return err(`${source}: policy.kinds.${kind} must be one of ${TIERS.join(", ")}`);
        policy.kinds[kind as ChangeKind] = tier as Tier;
      }
    }
    if (p.humans !== undefined) {
      if (!isTable(p.humans)) return err(`${source}: [policy.humans] must be a table`);
      for (const [tier, n] of Object.entries(p.humans)) {
        if (!TIERS.includes(tier as Tier)) return err(`${source}: policy.humans.${tier}: unknown tier`);
        if (n !== 0 && n !== 1 && n !== 2) return err(`${source}: policy.humans.${tier} must be 0, 1 or 2`);
        policy.humans[tier as Tier] = n;
      }
    }
    if (p.rules !== undefined) {
      if (!Array.isArray(p.rules)) return err(`${source}: policy.rules must be an array of [[policy.rules]] tables`);
      const rules: PolicyRule[] = [];
      for (const [k, r] of p.rules.entries()) {
        const where = `${source}: policy.rules[${k}]`;
        if (!isTable(r)) return err(`${where} must be a table`);
        for (const key of Object.keys(r))
          if (!["area", "kind", "attention", "tier", "reason", "unless"].includes(key)) return err(`${where}: unknown key "${key}"`);
        if (!TIERS.includes(r.tier as Tier)) return err(`${where}: tier must be one of ${TIERS.join(", ")}`);
        const rule: PolicyRule = { tier: r.tier as Tier };
        if (r.unless !== undefined) {
          const u = r.unless as { kind?: unknown; oneWay?: unknown };
          if (typeof r.unless !== "object" || r.unless === null || !KINDS.includes(u.kind as ChangeKind))
            return err(`${where}.unless: needs kind = one of ${KINDS.join(", ")}`);
          if (u.oneWay !== undefined && u.oneWay !== false)
            return err(`${where}.unless.oneWay: only false is meaningful (the rule stands down when the diff shows no one-way signal)`);
          rule.unless = u.oneWay === false ? { kind: u.kind as ChangeKind, oneWay: false } : { kind: u.kind as ChangeKind };
        }
        if (r.area !== undefined) {
          if (typeof r.area !== "string" || !(r.area in policy.areas))
            return err(`${where}: area "${String(r.area)}" is not defined in [areas] (known: ${Object.keys(policy.areas).join(", ")})`);
          rule.area = r.area;
        }
        if (r.kind !== undefined) {
          if (!KINDS.includes(r.kind as ChangeKind)) return err(`${where}: unknown kind "${String(r.kind)}"`);
          rule.kind = r.kind as ChangeKind;
        }
        if (r.attention !== undefined) {
          if (r.attention !== "needs-eyes" && r.attention !== "suspicious")
            return err(`${where}: attention must be needs-eyes or suspicious`);
          rule.attention = r.attention;
        }
        if (r.reason !== undefined) {
          if (typeof r.reason !== "string") return err(`${where}: reason must be a string`);
          rule.reason = r.reason;
        }
        if (!rule.area && !rule.kind && !rule.attention) return err(`${where}: needs at least one of area, kind, attention`);
        rules.push(rule);
      }
      policy.rules = rules;
    }
  }
  return ok(policy);
}

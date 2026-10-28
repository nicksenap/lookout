import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/core/diff.ts";
import type { ChangeKind, Classification, Tier } from "../src/core/types.ts";
import type { Result } from "../src/core/result.ts";
import { loadConfig } from "../src/dispatch/config.ts";
import { areasOf, classify, evaluate, kindOf } from "../src/policy/evaluate.ts";
import { DEFAULT_POLICY, validatePolicy } from "../src/policy/schema.ts";
import { applyRules } from "../src/rank/rules.ts";


/** Unwrap a Result in tests; a failure is a test failure with the message. */
function must<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(String(r.error));
  return r.value;
}

const c = (over: Partial<Classification>): Classification => ({ kind: "logic", areas: [], maxAttention: "routine", sensitivePaths: [], oneWay: false, counts: { files: 1, blocks: 1, inert: 0 }, ...over });

describe("evaluate: tier table", () => {
  test("a rule with `unless` stands down for a two-way additive change and holds for a one-way one or a logic change", () => {
    const rules = [{ area: "infra", tier: "high" as const, reason: "touches infra", unless: { kind: "additive" as const, oneWay: false as const } }];
    const policy = { ...DEFAULT_POLICY, rules };
    const additive = evaluate(c({ kind: "additive", areas: ["infra"], maxAttention: "needs-eyes" }), policy);
    expect(additive.tier).toBe("medium");
    expect(additive.reasons.some((r) => r.includes("stands down"))).toBe(true);
    expect(evaluate(c({ kind: "additive", areas: ["infra"], oneWay: true }), policy).tier).toBe("high");
    expect(evaluate(c({ kind: "logic", areas: ["infra"] }), policy).tier).toBe("high");
  });

  test("validatePolicy accepts unless and names bad keys", () => {
    expect(must(validatePolicy({ policy: { rules: [{ area: "infra", tier: "high", unless: { kind: "additive", oneWay: false } }] } }, "t")).rules.at(-1)!.unless).toEqual({ kind: "additive", oneWay: false });
    expect(validatePolicy({ policy: { rules: [{ area: "infra", tier: "high", unless: { kind: "nope" } }] } }, "t").ok).toBe(false);
    expect(validatePolicy({ policy: { rules: [{ area: "infra", tier: "high", unless: { kind: "additive", oneWay: true } }] } }, "t").ok).toBe(false);
  });

  const table: [Partial<Classification>, Tier, 0 | 1 | 2][] = [
    [{ kind: "docs" }, "low", 0],
    [{ kind: "test" }, "low", 0],
    [{ kind: "additive" }, "low", 0],
    [{ kind: "deps" }, "medium", 1],
    [{ kind: "config" }, "medium", 1],
    [{ kind: "logic" }, "medium", 1],
    [{ kind: "ci" }, "high", 2],
    [{ kind: "docs", areas: ["auth"] }, "high", 2],
    [{ kind: "logic", areas: ["prompts"] }, "medium", 1],
    [{ kind: "additive", maxAttention: "suspicious" }, "medium", 1],
    [{ kind: "additive", maxAttention: "needs-eyes" }, "medium", 1],
    [{ kind: "docs", maxAttention: "needs-eyes" }, "medium", 1],
    [{ kind: "logic", maxAttention: "suspicious" }, "medium", 1],
    [{ kind: "docs", sensitivePaths: ["docs/auth.md"] }, "medium", 1],
  ];
  for (const [over, tier, humans] of table) {
    test(`${JSON.stringify(over)} → ${tier}/${humans}`, () => {
      const v = evaluate(c(over), DEFAULT_POLICY);
      expect(v.tier).toBe(tier);
      expect(v.requiredHumans).toBe(humans);
      expect(v.reasons.length).toBeGreaterThan(0);
    });
  }

  test("a touched area can never be low, even with a permissive user policy", () => {
    const policy = validatePolicy({ areas: { own: ["**/own/**"] }, policy: { rules: [] } }, "t");
    if (!policy.ok) throw new Error(policy.error);
    const v = evaluate(c({ kind: "docs", areas: ["own"] }), policy.value);
    expect(v.tier).toBe("medium");
    expect(v.reasons.some((r) => r.includes("never low"))).toBe(true);
  });

  test("reasons are most severe first and name the contributing rule", () => {
    const v = evaluate(c({ kind: "docs", areas: ["auth", "prompts"] }), DEFAULT_POLICY);
    expect(v.reasons[0]).toBe("touches auth → high");
    expect(v.reasons).toContain("docs change → low");
  });

  test("user rule by attention and by kind", () => {
    const policy = validatePolicy({ policy: { rules: [{ attention: "needs-eyes", tier: "high", reason: "we are careful" }, { kind: "deps", tier: "high" }] } }, "t");
    if (!policy.ok) throw new Error(policy.error);
    expect(evaluate(c({ maxAttention: "needs-eyes" }), policy.value).tier).toBe("high");
    expect(evaluate(c({ maxAttention: "routine" }), policy.value).tier).toBe("medium");
    expect(evaluate(c({ kind: "deps" }), policy.value).reasons[0]).toBe("deps change → high");
  });

  test("humans mapping is configurable", () => {
    const policy = validatePolicy({ policy: { humans: { medium: 2 } } }, "t");
    if (!policy.ok) throw new Error(policy.error);
    expect(evaluate(c({}), policy.value).requiredHumans).toBe(2);
  });
});

describe("kindOf", () => {
  const b = (path: string, labels: string[] = [], hasDeletions = false) => ({ path, labels, hasDeletions });
  const cases: [ReturnType<typeof b>[], ChangeKind][] = [
    [[b("README.md", ["docs"])], "docs"],
    [[b("src/a.test.ts", ["test"]), b("src/b.test.ts", ["test"])], "test"],
    [[b("package.json"), b("bun.lock", ["lockfile"])], "deps"],
    [[b(".github/workflows/ci.yml", ["ci"])], "ci"],
    [[b("config/app.yaml"), b(".env.example")], "config"],
    [[b("src/new.ts"), b("src/new.test.ts", ["test"], true)], "additive"],
    [[b("src/a.ts", [], true)], "logic"],
    [[b("src/a.ts"), b("README.md", ["docs"], true)], "additive"],
    [[b("src/a.ts", [], true), b("README.md", ["docs"])], "logic"],
    [[], "docs"],
  ];
  for (const [blocks, kind] of cases) test(`${blocks.map((x) => x.path).join(", ") || "(none)"} → ${kind}`, () => expect(kindOf(blocks)).toBe(kind));
});

describe("areas", () => {
  test("default areas match by glob", () => {
    expect(areasOf(DEFAULT_POLICY, "apps/x/src/auth/refresh.ts")).toEqual(["auth"]);
    expect(areasOf(DEFAULT_POLICY, "db/migrations/0012_add.sql")).toEqual(["data"]);
    expect(areasOf(DEFAULT_POLICY, ".github/workflows/ci.yml")).toEqual(["infra"]);
    expect(areasOf(DEFAULT_POLICY, "src/components/Button.tsx")).toEqual([]);
  });
  test("repo areas replace by name; an empty list removes a default", () => {
    const p = validatePolicy({ areas: { auth: ["services/identity/**"], prompts: [] } }, "t");
    if (!p.ok) throw new Error(p.error);
    expect(areasOf(p.value, "services/identity/login.ts")).toEqual(["auth"]);
    expect(areasOf(p.value, "src/auth/x.ts")).toEqual([]);
    expect(areasOf(p.value, "src/prompts/system.md")).toEqual([]);
  });
});

describe("classify from a real diff", () => {
  test("sample fixture: a test file plus source → logic, no areas, counts filled", async () => {
    const files = parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/result-errors.diff`).text());
    const cs = applyRules({ target: "t", base: "", head: "", files });
    const k = classify(cs, DEFAULT_POLICY);
    expect(k.counts.blocks).toBe(81);
    expect(k.counts.files).toBe(cs.files.length);
    expect(k.kind).toBe("logic");
    expect(k.areas).toEqual([]);
  });
  test("inert blocks do not contribute: a comment-only change under auth/ is docs-kind with no area", () => {
    const diff = ["diff --git a/src/auth/a.ts b/src/auth/a.ts", "--- a/src/auth/a.ts", "+++ b/src/auth/a.ts", "@@ -1,2 +1,2 @@", "-// old comment", "+// new comment", " const a = 1;"].join("\n") + "\n";
    const cs = applyRules({ target: "t", base: "", head: "", files: parseDiff(diff) });
    // auth paths carry the sensitive label, so rules never mark them inert; the block stays live.
    const k = classify(cs, DEFAULT_POLICY);
    expect(k.areas).toEqual(["auth"]);
    expect(evaluate(k, DEFAULT_POLICY).tier).toBe("high");
  });
});

describe("policy schema errors name the key", () => {
  const bad: [Record<string, unknown>, string][] = [
    [{ areas: "x" }, "[areas] must be a table"],
    [{ areas: { auth: "x" } }, "areas.auth must be an array"],
    [{ policy: { nope: 1 } }, 'unknown key "policy.nope"'],
    [{ policy: { kinds: { weird: "low" } } }, "unknown kind"],
    [{ policy: { kinds: { docs: "extreme" } } }, "one of low, medium, high"],
    [{ policy: { humans: { low: 3 } } }, "0, 1 or 2"],
    [{ policy: { rules: [{ tier: "high" }] } }, "at least one of area, kind, attention"],
    [{ policy: { rules: [{ area: "nope", tier: "high" }] } }, 'area "nope" is not defined'],
    [{ policy: { rules: [{ kind: "docs", tier: "huge" }] } }, "tier must be"],
  ];
  for (const [raw, msg] of bad) {
    test(msg, () => {
      const r = validatePolicy(raw, "t");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(msg);
    });
  }
});

describe("config layering", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lookout-policy-"));
  const repo = join(tmp, "repo");
  const g = join(tmp, "global.toml");
  writeFileSync(g, `[rank]\nmodel = "openai:gpt-6-luna"\n\n[dispatch.pi]\ncmd = "pi -p @{prompt_file}"\n\n[areas]\nbilling = ["money/**"]\n`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  writeFileSync(join(repo, ".lookout.toml"), `[areas]\nauth = ["identity/**"]\n\n[[policy.rules]]\narea = "auth"\ntier = "medium"\nreason = "identity is well-tested here"\n\n[policy.humans]\nhigh = 1\n`);
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });

  test("repo .lookout.toml layers over the global file; dispatch/rank come from global", () => {
    const cfg = must(loadConfig(g, repo));
    expect(cfg.dispatchers.map((d) => d.name)).toEqual(["pi"]);
    expect(cfg.policy.source).toContain(".lookout.toml");
    expect(areasOf(cfg.policy, "money/charge.ts")).toEqual(["billing"]); // from global
    expect(areasOf(cfg.policy, "identity/login.ts")).toEqual(["auth"]); // replaced by repo
    expect(areasOf(cfg.policy, "src/auth/x.ts")).toEqual([]);
    expect(cfg.policy.humans.high).toBe(1);
    // Repo rules replace the default rule list.
    expect(cfg.policy.rules).toEqual([{ area: "auth", tier: "medium", reason: "identity is well-tested here" }]);
  });
  test("no repo file → global only; no files → defaults", () => {
    expect(must(loadConfig(g, tmp)).policy.rules).toEqual(DEFAULT_POLICY.rules);
    expect(must(loadConfig(join(tmp, "missing.toml"))).policy).toBe(DEFAULT_POLICY);
  });
  test("a bad repo file names the repo file", () => {
    const bad = join(tmp, "bad");
    Bun.spawnSync(["mkdir", "-p", bad]);
    writeFileSync(join(bad, ".lookout.toml"), `[policy]\nkinds = { docs = "silly" }\n`);
    const r = loadConfig(g, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bad\/\.lookout\.toml: policy\.kinds\.docs/);
    cleanup();
  });
});


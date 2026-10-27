// Step 8 check: tier / humans / kind / areas per commit over the last N non-merge commits (read-only).
// Usage: bun scripts/tier-survey.ts <repo> [n=30]
import { parseDiff } from "../src/core/diff.ts";
import { classify, evaluate } from "../src/policy/evaluate.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";
import { applyRules } from "../src/rank/rules.ts";
import { DIFF_FLAGS } from "../src/sources/git.ts";

const repo = process.argv[2];
const n = Number(process.argv[3] ?? 30);
if (!repo) throw new Error("usage: bun scripts/tier-survey.ts <repo> [n]");
const sh = (args: string[]) => Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", maxBuffer: 1 << 28 }).stdout.toString();

const tally: Record<string, number> = {};
for (const line of sh(["git", "log", `-${n}`, "--no-merges", "--format=%h%x09%s"]).trim().split("\n")) {
  const [sha, subject] = line.split("\t") as [string, string];
  const cs = applyRules({ target: sha, base: "", head: "", files: parseDiff(sh(["git", "diff", ...DIFF_FLAGS, `${sha}^`, sha, "--"])) });
  const k = classify(cs, DEFAULT_POLICY);
  const v = evaluate(k, DEFAULT_POLICY);
  tally[v.tier] = (tally[v.tier] ?? 0) + 1;
  const areas = k.areas.length ? ` areas=${k.areas.join(",")}` : "";
  const sens = k.sensitivePaths.length ? ` sensitive=${k.sensitivePaths.length}` : "";
  console.log(`${v.tier.padEnd(6)} ${v.requiredHumans}h ${k.kind.padEnd(8)} ${k.maxAttention.padEnd(10)} ${String(k.counts.files).padStart(3)}f ${String(k.counts.blocks).padStart(3)}b${areas}${sens}  ${sha} ${subject.slice(0, 60)}`);
  if (v.tier === "high") for (const r of v.reasons) console.log(`         ↳ ${r}`);
}
console.log("\n", tally);

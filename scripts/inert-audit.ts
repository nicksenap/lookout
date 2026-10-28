// Step 3/7 check: list every edit block the rules mark inert over the last N non-merge commits of a repo (read-only).
// Usage: bun scripts/inert-audit.ts <repo> [n=50]
import { parseDiff } from "../src/core/diff.ts";
import { applyRules } from "../src/rank/rules.ts";
import { DIFF_FLAGS } from "../src/sources/git.ts";

const repo = process.argv[2];
const n = Number(process.argv[3] ?? 50);
if (!repo) throw new Error("usage: bun scripts/inert-audit.ts <repo> [n]");
const sh = (args: string[]) => Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", maxBuffer: 1 << 28 }).stdout.toString();

let total = 0;
let inert = 0;
for (const sha of sh(["git", "log", `-${n}`, "--no-merges", "--format=%h"])
  .trim()
  .split("\n")) {
  const files = applyRules({
    target: sha,
    base: "",
    head: "",
    files: parseDiff(sh(["git", "diff", ...DIFF_FLAGS, `${sha}^`, sha, "--"])),
  }).files;
  for (const f of files) {
    for (const h of f.hunks) {
      for (const b of h.blocks) {
        total++;
        if (b.attention !== "inert") continue;
        inert++;
        console.log(`\n=== ${sha} ${f.path} ${h.header} block ${b.from}-${b.to}  [${b.labels.join(", ")}]`);
        for (const l of h.lines.slice(b.from, b.to)) console.log(`${l.kind === "add" ? "+" : "-"}${l.text}`);
      }
    }
  }
}
console.log(`\n${inert} inert of ${total} edit blocks over ${n} commits`);

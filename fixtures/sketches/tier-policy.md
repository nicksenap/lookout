# Tier policy: classify and evaluate every review

review: review-b.json
card: 79e6ab8ad591

File tree: two new policy modules, the config and the CLI wired to them, a survey script.

```diff
+src/policy/schema.ts      DEFAULT_POLICY, validatePolicy
+src/policy/evaluate.ts    classify, evaluate → Verdict
 src/core/types.ts
+  Classification, Tier, Verdict
 src/dispatch/config.ts
-  loadConfig(path)
+  loadConfig(path, repoRoot)       → policy
 src/cli/main.ts
+  judge(cs) → classification, verdict
+scripts/tier-survey.ts    classify, evaluate per commit
```

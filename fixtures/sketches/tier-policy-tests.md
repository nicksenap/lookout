# Test the tier policy

review: review-b.json
card: 1438a0484412

Test tree. Two blocks, so below the writer threshold; kept as a gate target for a test card.

```diff
 describe("config")
-  config(cmd) → { rank, dispatchers, source }
+  config(cmd) → { rank, dispatchers, policy: DEFAULT_POLICY, source }
+describe("evaluate: tier table")
+  evaluate(c(over), DEFAULT_POLICY) → tier, requiredHumans
+describe("kindOf")
+describe("areas")
+describe("classify from a real diff")
+describe("policy schema errors name the key")
+describe("config layering")
+  loadConfig(g, repo) → cfg.policy.source
```

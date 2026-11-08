# Tests unwrap Result from config and git loaders

review: review-a.json
card: cf4e691ac315

Test tree: each loader call is wrapped in `must`; the throw test for an unknown placeholder goes.

```diff
 describe("config")
-  loadConfig(join(tmp, "nope.toml"))
+  must(loadConfig(join(tmp, "nope.toml")))
 describe("expandCommand")
-  expandCommand("x {nope}") → toThrow("unknown placeholder {nope}")
 describe("config layering")
+  must(loadConfig(g, repo))
 describe("git source")
+  must(await loadWorktree(dir))
+  must(await loadRange("main..feature", dir))
```

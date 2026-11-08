# Expected failures return Result instead of throwing

review: review-a.json
card: 27358701b7b5

File tree: each loader's return type, and `main` returning an exit code.

```diff
 src/cli/main.ts
-  main() → Promise<void>
+  main() → Promise<number>
+  fail(message) → number
 src/dispatch/config.ts
-  ConfigError extends Error
+  validateConfig, loadConfig → Result<Config>
 src/sources/exec.ts
+  run(cmd) → Promise<Result<string>>
 src/sources/git.ts
+  loadWorktree, loadRange → Result<ChangeSet>
```

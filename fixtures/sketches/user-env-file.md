# Load API keys from a user env file

review: review-c.json
card: 5b118eb90ad1

Call tree: `main` gains one call; the new function and its test.

```diff
 main
+  loadUserEnv()
   parseArgs(process.argv.slice(2))
   loadConfig(undefined, root)
+loadUserEnv(path = USER_ENV_PATH, env = process.env)
+  existsSync(path)
+  readFileSync(path).split("\n")
+    env[KEY] === undefined → env[KEY] = value
+describe("user env file")
+  loadUserEnv(p, env)
```

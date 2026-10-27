I reviewed the hunk in `src/cli/main.ts`.

The config error path returns before the repo root is used, which silently hides a missing repo-local config from the user.

```json
{"findings": [
  {"severity": "p1", "title": "Config errors hide the repo path", "body": "fail(config.error) is returned before the resolved repo root is reported, so a bad .lookout.toml never names which repo it came from.", "path": "src/cli/main.ts", "line": 50},
  {"severity": "p2", "title": "Outside the diff", "body": "Line 9000 is not in any hunk.", "path": "src/cli/main.ts", "line": 9000},
  {"severity": "p2", "title": "Unknown file", "body": "Not part of this change.", "path": "src/nowhere.ts", "line": 3},
  {"severity": "high", "title": "Bad severity", "body": "Should fall back to p2 with a note."},
  {"title": 42}
]}
```

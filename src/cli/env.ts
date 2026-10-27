import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const USER_ENV_PATH = join(homedir(), ".config", "lookout", ".env");

/**
 * Keys live in ~/.config/lookout/.env (KEY=value lines), so lookout works from any repo
 * without putting secrets in shell dotfiles. Variables already set in the environment win.
 */
export function loadUserEnv(path: string = USER_ENV_PATH, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    if (env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
}

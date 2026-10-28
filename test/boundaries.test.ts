import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Glob } from "bun";

const SRC = `${import.meta.dir}/../src`;
const files = async (dir: string) => {
  const out: string[] = [];
  if (!existsSync(`${SRC}/${dir}`)) return out;
  for await (const f of new Glob("**/*.{ts,tsx}").scan(`${SRC}/${dir}`)) out.push(f);
  return out;
};

test("nothing below tui imports react or ink; experimental_* only in rank/model.ts", async () => {
  const offenders: string[] = [];
  for (const dir of ["core", "sources", "rank", "policy", "cards", "evidence", "dispatch", "verify", "questions", "cli"]) {
    for (const f of await files(dir)) {
      const text = await Bun.file(`${SRC}/${dir}/${f}`).text();
      if (/from\s+["'](react|ink)(\/[^"']*)?["']|import\(\s*["'](react|ink)/.test(text)) offenders.push(`${dir}/${f}`);
      if (!(dir === "rank" && f === "model.ts") && /experimental_|Experimental_/.test(text))
        offenders.push(`${dir}/${f} (experimental_* outside rank/model.ts)`);
    }
  }
  expect(offenders).toEqual([]);
});

test("tui imports only core/session.ts, core/types.ts and its own files", async () => {
  const offenders: string[] = [];
  for (const f of await files("tui")) {
    const text = await Bun.file(`${SRC}/tui/${f}`).text();
    for (const m of text.matchAll(/from\s+["'](\.\.\/[^"']+)["']/g)) {
      const target = m[1]!;
      if (target !== "../core/session.ts" && target !== "../core/types.ts") offenders.push(`tui/${f} → ${target}`);
    }
  }
  expect(offenders).toEqual([]);
});

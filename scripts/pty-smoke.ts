/**
 * PTY smoke: run the real `lookout` in a pseudo-terminal, drive it with keys, and read the screen
 * through a headless terminal emulator. Read-only on the target repo; always ends with `q`; hard timeout.
 * Usage: bun scripts/pty-smoke.ts <repo> <target> [rows cols] [--show]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";

const args = process.argv.slice(2).filter((a) => a !== "--show");
const show = process.argv.includes("--show");
const [repo, target] = args;
if (!repo || !target) {
  console.error("usage: bun scripts/pty-smoke.ts <repo> <target> [rows cols] [--show]");
  process.exit(2);
}
const rows = Number(args[2] ?? 30);
const cols = Number(args[3] ?? 100);
setTimeout(() => {
  console.error("FAIL hard timeout");
  process.exit(1);
}, 90_000).unref();

const term = new Terminal({ cols, rows, allowProposedApi: true });
let raw = "";
// A throwaway HOME keeps ~/.config/lookout (keys, user config) out: rules-only, deterministic, no network.
const home = mkdtempSync(join(tmpdir(), "lookout-smoke-"));
const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "lookout"), target], {
  cwd: repo,
  env: { ...process.env, HOME: home, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GOOGLE_GENERATIVE_AI_API_KEY: "" },
  terminal: {
    cols,
    rows,
    data(_t, chunk) {
      const text = new TextDecoder().decode(chunk);
      raw += text;
      term.write(text);
    },
  },
});

const results: [string, boolean][] = [];
const shots: [string, string][] = [];
const check = (name: string, passed: boolean) => results.push([name, passed]);
const screen = () => Array.from({ length: term.rows }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\n");
const snap = (name: string) => shots.push([name, screen()]);

/** Resolves true once the screen satisfies `ok`, false at the deadline. The screen is the signal, not a sleep. */
async function waitFor(ok: (s: string) => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok(screen())) return true;
    await Bun.sleep(25);
  }
  return ok(screen());
}

/** Ink reads one write as one input, so keys go one per write; a paste goes as one write on purpose. */
async function keys(...ks: string[]) {
  for (const k of ks) {
    proc.terminal!.write(k);
    await Bun.sleep(40);
  }
}

// The stack: card bars with a colour word. Expanded adds a `diff ·` line. The bottom row is a key hint or, rules-only, a warning.
const stack = (s: string) => /^[┃█] +(RED|AMBER|GREEN)\b/m.test(s) && !s.includes("diff ·");

check("stack painted", await waitFor((s) => stack(s) && /LOW|MEDIUM|HIGH/.test(s), 15_000));
snap("stack");
check("alt screen entered", raw.includes("\x1b[?1049h"));

await keys("j", "j", "\r");
check("expanded shows the diff", await waitFor((s) => s.includes("diff ·")));
snap("expanded");
await keys("J", "G", "\x1b");
check("back to stack", await waitFor(stack));

await keys("?");
check("help opens", await waitFor((s) => s.includes("glossary")));
snap("help");
await keys("\x1b");
check("esc closes help", await waitFor((s) => !s.includes("glossary")));

await keys("/", "a", "b", "c");
check("search takes typing", await waitFor((s) => s.includes("/abc")));
await keys("\x7f");
check("backspace deletes", await waitFor((s) => s.includes("/ab▏")));
// Focus reports are terminal replies; ink 8 drops them instead of passing them on as typed text.
await keys("\x1b[I", "\x1b[O");
check("terminal replies are not typed", await waitFor((s) => s.includes("/ab▏") && !s.includes("[I")));
snap("search");
await keys("\x1b");
check("esc closes search", await waitFor((s) => stack(s) && !s.includes("/ab▏")));

await keys("a", "\x1b[200~pasted text\x1b[201~");
check("paste lands in ask as one block", await waitFor((s) => s.includes("pasted text▏")));
await keys("\x08");
check("ctrl-h deletes", await waitFor((s) => s.includes("pasted tex▏")));
snap("ask");
await keys("\x1b");
check("esc closes ask", await waitFor((s) => !s.includes("pasted tex")));

term.resize(80, 24);
proc.terminal!.resize(80, 24);
// A header left over from 100 columns would wrap; repainted at 80 it ends on the mode, right-aligned.
check("repainted after resize", await waitFor((s) => stack(s) && s.split("\n")[0]!.trimEnd().endsWith("rules only")));
snap("resized");

await keys("q");
const exit = await Promise.race([proc.exited, Bun.sleep(3000).then(() => undefined)]);
check("exit 0", exit === 0);
check("alt screen left", raw.includes("\x1b[?1049l"));
check("cursor shown", raw.includes("\x1b[?25h"));
proc.kill();
proc.terminal!.close();

if (show)
  for (const [name, s] of shots)
    console.log(
      `\n##### ${name}\n${s
        .split("\n")
        .filter((l) => l.trim())
        .join("\n")}`,
    );
for (const [name, passed] of results) console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
process.exit(results.every(([, passed]) => passed) ? 0 : 1);

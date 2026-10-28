import { type Instance, render } from "ink";
import type { ReactElement } from "react";

const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
const LEAVE_ALT = "\x1b[?25h\x1b[?1049l";

let depth = 0;
let restored = false;

/**
 * Enter the alternate screen once for the whole process (the picker and the stack run back to
 * back without a flash of the shell in between), and restore the terminal on the last leave,
 * on exit, and on SIGTERM/SIGHUP. Returns the leave function.
 */
export function enterFullscreen(): () => void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("the TUI needs a terminal; use --json for non-interactive output");
  if (depth++ === 0) {
    restored = false;
    process.stdout.write(ENTER_ALT);
    process.once("exit", restore);
    process.once("SIGTERM", onSignal);
    process.once("SIGHUP", onSignal);
  }
  return () => {
    if (--depth === 0) {
      restore();
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
    }
  };
}

function restore(): void {
  if (restored) return;
  restored = true;
  process.stdout.write(LEAVE_ALT);
}

function onSignal(): void {
  restore();
  process.exit(130);
}

/**
 * Render one Ink tree full-screen and wait for it to exit. No incrementalRendering: with a frame
 * shorter than the terminal Ink 6.8's incremental writer drifts one row per frame; full redraws
 * are wrapped in synchronized output on TTYs. A fresh frame is painted first so the previous
 * screen (the picker, say) never bleeds into the next.
 */
export async function runFullscreen(tree: ReactElement): Promise<void> {
  const leave = enterFullscreen();
  process.stdout.write("\x1b[2J\x1b[H");
  let instance: Instance | undefined;
  try {
    instance = render(tree, { exitOnCtrlC: true, patchConsole: true });
    await instance.waitUntilExit();
  } finally {
    instance?.cleanup();
    leave();
  }
}

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { attempt, err, ok, type Result } from "../core/result.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewStore } from "../core/store.ts";
import type { Card, Dispatch, DispatchRole, Finding } from "../core/types.ts";
import { type Config, PLACEHOLDERS } from "./config.ts";
import { parseDispatchOutput } from "./parse.ts";
import { buildPrompt, diffSlice, type DispatchScope, fillTemplate } from "./prompt.ts";

/**
 * What a dispatch does: propose findings over a scope, or verify a card's findings with a
 * prompt built by `verify/`. The runner only records a verifier's raw output; the session
 * parses it, so `dispatch/` never imports `verify/`.
 */
export type DispatchJob = DispatchScope | { kind: "verify"; card: Card; findings: Finding[]; prompt: string };

/** POSIX single-quote a value so it reaches the command as one argument. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Substitute `{prompt}` `{prompt_file}` `{repo}` `{diff_file}` as shell-quoted words. Placeholders were validated with the config. */
export function expandCommand(cmd: string, values: Record<(typeof PLACEHOLDERS)[number], string>): string {
  return fillTemplate(cmd, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, shellQuote(v)])));
}

export interface RunnerOptions {
  repo: string;
  config: Config;
  /** Time between SIGTERM and SIGKILL on cancel. */
  killGraceMs?: number;
}

interface Running {
  id: string;
  proc: ReturnType<typeof Bun.spawn>;
  cancelled: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  finished: Promise<void>;
}

/** Runs one dispatch at a time and streams it into the store. */
export class DispatchRunner {
  private current: Running | undefined;
  private seq = 0;

  constructor(
    private readonly store: ReviewStore,
    private readonly opts: RunnerOptions,
  ) {}

  get running(): boolean {
    return this.current !== undefined;
  }

  /** Resolves when the current dispatch (if any) has finished. */
  async settled(): Promise<void> {
    await this.current?.finished;
  }

  /** Start a dispatch; a running dispatch or an unknown dispatcher is an expected failure. */
  start(dispatcherName: string, job: DispatchJob): Result<Dispatch> {
    if (this.current) return err("a dispatch is already running (x cancels it)");
    const dispatcher = this.opts.config.dispatchers.find((d) => d.name === dispatcherName);
    if (!dispatcher) return err(`unknown dispatcher "${dispatcherName}"`);

    const review = this.store.getSnapshot();
    const id = `d${++this.seq}`;
    const dir = mkdtempSync(join(tmpdir(), "lookout-dispatch-"));
    const promptFile = join(dir, "prompt.md");
    const diffFile = join(dir, "slice.diff");
    const role: DispatchRole = job.kind === "verify" ? "verifier" : "proposer";
    const scope: DispatchScope = job.kind === "verify" ? { kind: "card", card: job.card } : job;
    const prompt = job.kind === "verify" ? job.prompt : buildPrompt({ changeSet: review.changeSet, scope, repo: this.opts.repo, template: this.opts.config.prompt });
    writeFileSync(promptFile, prompt);
    writeFileSync(diffFile, diffSlice(review.changeSet, scope) + "\n");
    const command = expandCommand(dispatcher.cmd, { prompt, prompt_file: promptFile, repo: this.opts.repo, diff_file: diffFile });

    const dispatch: Dispatch = {
      id,
      dispatcher: dispatcher.name,
      role,
      scope: scope.kind,
      // Shown in the UI; the full prompt is left as {prompt} to keep it short.
      cmd: fillTemplate(dispatcher.cmd, { prompt_file: shellQuote(promptFile), repo: shellQuote(this.opts.repo), diff_file: shellQuote(diffFile) }),
      status: "running",
      output: "",
      findings: [],
    };
    if (scope.kind === "hunk") dispatch.hunkId = scope.hunk.id;
    if (scope.kind === "card") dispatch.cardId = scope.card.id;
    if (job.kind === "verify") dispatch.verifies = job.findings.map((f) => f.id);
    this.store.startDispatch(dispatch);

    const spawned = attempt(() =>
      Bun.spawn(["/bin/sh", "-c", command], {
        cwd: this.opts.repo,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true, // own process group, so cancel reaches the agent's children too
      }),
    );
    if (!spawned.ok) {
      rmSync(dir, { recursive: true, force: true });
      this.store.finishDispatch(id, { status: "failed", error: spawned.error });
      return ok(this.store.getSnapshot().dispatches.find((d) => d.id === id)!);
    }
    const proc = spawned.value;

    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) this.store.appendOutput(id, decoder.decode(chunk, { stream: true }));
    };
    const running: Running = { id, proc, cancelled: false, finished: Promise.resolve() };
    running.finished = (async () => {
      const pumps = Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
      const code = await proc.exited;
      // A backgrounded grandchild can keep the pipes open; don't wait on it forever.
      await Promise.race([pumps, Bun.sleep(1000)]);
      if (running.killTimer) clearTimeout(running.killTimer);
      rmSync(dir, { recursive: true, force: true });
      this.current = undefined;
      const output = this.store.getSnapshot().dispatches.find((d) => d.id === id)!.output;
      if (running.cancelled) {
        this.store.finishDispatch(id, { status: "cancelled" });
        return;
      }
      const patch: Partial<Dispatch> = { status: code === 0 ? "done" : "failed" };
      if (code !== 0) patch.error = `exited with code ${code}`;
      if (job.kind !== "verify") {
        const parsed = parseDispatchOutput(output, { dispatcher: dispatcher.name, dispatchId: id, changeSet: this.store.getSnapshot().changeSet });
        patch.findings = parsed.findings;
        patch.freeform = [parsed.freeform, parsed.notes.map((n) => `lookout: ${n}`).join("\n")].filter(Boolean).join("\n\n");
      }
      this.store.finishDispatch(id, patch);
    })();
    this.current = running;
    return ok(dispatch);
  }

  /** Cancel any running dispatch and wait for it to exit (used on quit). */
  async shutdown(): Promise<void> {
    this.cancel();
    await this.settled();
  }

  /** SIGTERM the dispatch's process group, then SIGKILL after the grace period. */
  cancel(): boolean {
    const running = this.current;
    if (!running || running.cancelled) return false;
    running.cancelled = true;
    // The group may already be gone; fall back to the process itself.
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!attempt(() => process.kill(-running.proc.pid, signal)).ok) running.proc.kill(signal);
    };
    signalGroup("SIGTERM");
    running.killTimer = setTimeout(() => signalGroup("SIGKILL"), this.opts.killGraceMs ?? 2000);
    return true;
  }
}

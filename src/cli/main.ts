import pkg from "../../package.json" with { type: "json" };
import { loadUserEnv } from "./env.ts";
import { LocalSession } from "../core/session.ts";
import { loadConfig } from "../dispatch/config.ts";
import { DispatchRunner } from "../dispatch/runner.ts";
import { ok, type Result } from "../core/result.ts";
import { repoRoot, worktreeDirty } from "../sources/git.ts";
import { listOpenPullRequests } from "../sources/github.ts";
import { loadChangeSet, resolveTarget } from "../sources/resolve.ts";

const HELP = `lookout ${pkg.version} — rank hunks that deserve attention, dispatch review agents

Usage:
  lookout                  working tree vs HEAD; with a clean tree in a GitHub repo, pick an open PR
  lookout --pick           pick an open PR of this repo
  lookout A..B | A...B     local range (main.. means main..HEAD)
  lookout <pr-url>         GitHub PR (read-only, via gh)
  lookout owner/repo#N

Options:
  --json        print the Review as JSON instead of opening the card stack
  --evidence    also run the evidence layer (PR claims grounded against the cards,
                unmentioned cards, review questions); visible in --json only
  --version     print version
  --help        this help`;

interface CliArgs {
  json: boolean;
  evidence: boolean;
  pick: boolean;
  target?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, evidence: false, pick: false };
  for (const a of argv) {
    if (a === "--json") args.json = true;
    else if (a === "--pick") args.pick = true;
    else if (a === "--evidence") args.evidence = true;
    else if (a === "--version" || a === "-v") {
      console.log(`lookout ${pkg.version}`);
      process.exit(0);
    } else if (a === "--help" || a === "-h") {
      console.log(HELP);
      process.exit(0);
    } else if (a.startsWith("-")) throw new Error(`Unknown option ${a}. See lookout --help.`);
    else if (args.target !== undefined) throw new Error(`Only one target allowed (got "${args.target}" and "${a}").`);
    else args.target = a;
  }
  return args;
}

/** The one place expected failures become exit codes. Returns the exit code. */
async function main(): Promise<number> {
  loadUserEnv();
  const args = parseArgs(process.argv.slice(2));
  const root = await repoRoot();
  const config = loadConfig(undefined, root.ok ? root.value : undefined);
  if (!config.ok) return fail(config.error);
  const target = await chooseTarget(args, root.ok ? root.value : process.cwd());
  if (!target.ok) return fail(target.error);
  if (target.value === "") return 0;
  const spec = resolveTarget(target.value);
  if (!spec.ok) return fail(spec.error);
  const loaded = await loadChangeSet(spec.value);
  if (!loaded.ok) return fail(loaded.error);
  const repo = root.ok ? root.value : process.cwd();
  let runner: DispatchRunner | undefined;
  const session = new LocalSession({
    config: config.value,
    changeSet: loaded.value,
    repo,
    evidence: args.evidence,
    runner: (store) => (runner = new DispatchRunner(store, { repo, config: config.value })),
  });

  if (args.json || !process.stdout.isTTY) {
    await session.ready();
    const review = session.snapshot();
    if (review.warning) console.error(`lookout: ${review.warning}`);
    process.stdout.write(JSON.stringify(review, null, 2) + "\n");
    return 0;
  }
  const { runTui } = await import("../tui/App.tsx");
  await runTui(session, async () => runner?.shutdown());
  return 0;
}

/**
 * No argument in a terminal: a dirty tree means "review my work"; a clean tree in a GitHub repo
 * means "what should I review", so the picker opens. `--pick` forces it. Resolves `undefined`
 * for the working tree; the caller treats a picker that was left without a choice as "done".
 */
async function chooseTarget(args: CliArgs, cwd: string): Promise<Result<string | undefined>> {
  if (args.target !== undefined) return ok(args.target);
  const worktree: Result<string | undefined> = ok(undefined);
  if (!args.pick) {
    // --json and pipes never prompt; a dirty tree is the thing to review.
    if (args.json || !process.stdin.isTTY || !process.stdout.isTTY) return worktree;
    const dirty = await worktreeDirty(cwd);
    if (!dirty.ok || dirty.value) return worktree;
  }
  const listed = await listOpenPullRequests(cwd);
  // Not a GitHub repo or no gh: fall back to the working tree unless the picker was asked for.
  if (!listed.ok) return args.pick ? listed : worktree;
  const { runPicker } = await import("../tui/Picker.tsx");
  const picked = await runPicker(listed.value.repo, listed.value.prs);
  // "" = the user left without choosing; the caller exits quietly.
  return ok(picked?.target ?? "");
}

function fail(message: string): number {
  console.error(`lookout: ${message}`);
  return 1;
}

// Anything that reaches here is a bug or an unrecognised option, not an expected failure.
main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`lookout: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);

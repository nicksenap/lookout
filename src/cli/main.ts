import pkg from "../../package.json" with { type: "json" };
import { loadUserEnv } from "./env.ts";
import { LocalSession } from "../core/session.ts";
import { loadConfig } from "../dispatch/config.ts";
import { DispatchRunner } from "../dispatch/runner.ts";
import { repoRoot } from "../sources/git.ts";
import { loadChangeSet, resolveTarget } from "../sources/resolve.ts";

const HELP = `lookout ${pkg.version} — rank hunks that deserve attention, dispatch review agents

Usage:
  lookout                  working tree vs HEAD
  lookout A..B | A...B     local range (main.. means main..HEAD)
  lookout <pr-url>         GitHub PR (read-only, via gh)
  lookout owner/repo#N

Options:
  --json        print the Review as JSON instead of opening the card stack
  --all         also show rejected and dropped findings, with why
  --version     print version
  --help        this help`;

interface CliArgs {
  json: boolean;
  all: boolean;
  target?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, all: false };
  for (const a of argv) {
    if (a === "--json") args.json = true;
    else if (a === "--all") args.all = true;
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
  const spec = resolveTarget(args.target);
  if (!spec.ok) return fail(spec.error);
  const loaded = await loadChangeSet(spec.value);
  if (!loaded.ok) return fail(loaded.error);
  const repo = root.ok ? root.value : process.cwd();
  let runner: DispatchRunner | undefined;
  const session = new LocalSession({
    config: config.value,
    changeSet: loaded.value,
    repo,
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
  await runTui(session, { dispatchable: config.value.dispatchers.length > 0, showAll: args.all }, async () => runner?.shutdown());
  return 0;
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

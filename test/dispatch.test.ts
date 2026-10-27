import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/core/diff.ts";
import { ReviewStore } from "../src/core/store.ts";
import type { Review } from "../src/core/types.ts";
import type { Result } from "../src/core/result.ts";
import { BUILTIN_DISPATCHERS, type Config, loadConfig, validateConfig } from "../src/dispatch/config.ts";
import { buildPrompt, FINDINGS_CONTRACT } from "../src/dispatch/prompt.ts";
import { DispatchRunner, expandCommand, shellQuote } from "../src/dispatch/runner.ts";
import { buildCards, untouchedAreas } from "../src/cards/build.ts";
import { classify, evaluate } from "../src/policy/evaluate.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";

const FAKE = `${import.meta.dir}/../fixtures/fake-dispatcher.sh`;
const tmp = mkdtempSync(join(tmpdir(), "lookout-dispatch-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function review(): Promise<Review> {
  const files = parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/result-errors.diff`).text());
  const changeSet = { target: "HEAD~1..HEAD", base: "a", head: "b", files, intent: { title: "Return Result everywhere", body: "Expected failures are returned, not thrown." } };
  const classification = classify(changeSet, DEFAULT_POLICY);
  return { changeSet, classification, verdict: evaluate(classification, DEFAULT_POLICY), cards: buildCards(changeSet, DEFAULT_POLICY), untouched: untouchedAreas(changeSet, DEFAULT_POLICY), claims: [], door: { computed: "two-way", signals: [] }, radius: { areas: [] }, dispatches: [], rankedBy: "rules" };
}

/** Unwrap a Result in tests; a failure is a test failure with the message. */
function must<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(String(r.error));
  return r.value;
}

const config = (cmd: string, extra: Partial<Config> = {}): Config => ({ model: { decide: "openai:gpt-6-luna", write: "openai:gpt-6-luna" }, rank: { model: "openai:gpt-6-luna" }, dispatchers: [{ name: "fake", cmd }], policy: DEFAULT_POLICY, source: "test", ...extra });

describe("config", () => {
  test("missing file → built-in pi dispatcher", () => {
    const c = must(loadConfig(join(tmp, "nope.toml")));
    expect(c.dispatchers).toEqual(BUILTIN_DISPATCHERS);
    expect(c.dispatchers[0]!.cmd).toBe("pi -p @{prompt_file}");
    expect(c.rank.model).toBe("openai:gpt-6-luna");
  });

  test("PLAN.md example parses", () => {
    const p = join(tmp, "config.toml");
    writeFileSync(p, `[rank]\nmodel = "anthropic:claude-haiku-4-5-20251001"\n\n[dispatch.pi]\ncmd = "pi -p @{prompt_file}"\n\n[dispatch.claude]\ncmd = "claude -p {prompt}"\n`);
    const c = must(loadConfig(p));
    expect(c.rank.model).toBe("anthropic:claude-haiku-4-5-20251001");
    expect(c.dispatchers.map((d) => d.name)).toEqual(["pi", "claude"]);
  });

  test("clear errors, returned not thrown", () => {
    const error = (raw: unknown) => {
      const r = validateConfig(raw, "c.toml");
      return r.ok ? "ok" : r.error;
    };
    expect(error({ dispatch: { x: { cmd: "run {promt}" } } })).toBe("c.toml: dispatch.x.cmd: unknown placeholder {promt}. Allowed: {prompt} {prompt_file} {repo} {diff_file}");
    expect(error({ dispatch: { x: { command: "a" } } })).toContain('unknown key "dispatch.x.command"');
    expect(error({ rank: { model: "gpt" } })).toContain("provider:model");
    expect(error({ prompt: "Review {diff} for {target}" })).toContain("c.toml: prompt: unknown placeholder {target}");
    expect(error({ foo: 1 })).toContain('unknown key "foo"');
    const p = join(tmp, "bad.toml");
    writeFileSync(p, "[dispatch.pi\ncmd=1");
    const loaded = loadConfig(p);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/invalid TOML/);
  });

  test("JSON braces in a prompt override are not placeholders", () => {
    expect(must(validateConfig({ prompt: 'Return {"findings": []}. Diff:\n{diff}' }, "c")).prompt).toContain("{diff}");
  });
});

describe("prompt", () => {
  test("default includes scope, diff slice, PR intent and the findings contract", async () => {
    const r = await review();
    const hunk = r.changeSet.files[2]!.hunks[0]!;
    const p = buildPrompt({ changeSet: r.changeSet, scope: { kind: "hunk", hunk }, repo: "/repo" });
    expect(p).toContain("/repo");
    expect(p).toContain(`one hunk of HEAD~1..HEAD: ${hunk.path} lines 1-5`);
    expect(p).toContain("Title: Return Result everywhere");
    expect(p).toContain(hunk.header);
    expect(p).toContain('+import { attempt } from "../core/result.ts";');
    expect(p).toContain(FINDINGS_CONTRACT);
    expect(p).not.toContain(r.changeSet.files[0]!.hunks[0]!.header); // only the slice
  });

  test("change scope covers every file; override template", async () => {
    const r = await review();
    const p = buildPrompt({ changeSet: r.changeSet, scope: { kind: "change" }, repo: "/repo", template: "S={scope}\n{diff}" });
    expect(p.startsWith("S=the whole change HEAD~1..HEAD (14 files)")).toBe(true);
    for (const f of r.changeSet.files) expect(p).toContain(`+++ b/${f.path}`);
  });
});

describe("expandCommand", () => {
  test("values are shell-quoted words", () => {
    expect(expandCommand("claude -p {prompt}", { prompt: "it's $HOME `x`", prompt_file: "", repo: "", diff_file: "" })).toBe(`claude -p ${shellQuote("it's $HOME `x`")}`);
  });
  test("a quoted prompt survives the shell intact", async () => {
    const tricky = `a 'b' "c" $(rm -rf /) \`d\` \\ e\nline2`;
    const proc = Bun.spawn(["/bin/sh", "-c", expandCommand("printf %s {prompt}", { prompt: tricky, prompt_file: "", repo: "", diff_file: "" })], { stdout: "pipe" });
    expect(await new Response(proc.stdout).text()).toBe(tricky);
  });
});

describe("DispatchRunner with a fake dispatcher", () => {
  test("streams output, parses findings anchored to the dispatched hunk", async () => {
    const store = new ReviewStore(await review());
    const hunk = store.getSnapshot().changeSet.files[2]!.hunks[0]!;
    const runner = new DispatchRunner(store, { repo: tmp, config: config(`sh ${FAKE} {prompt_file}`) });
    const events: string[] = [];
    store.onEvent((e) => events.push(e.type));
    runner.start("fake", { kind: "hunk", hunk });
    expect(runner.running).toBe(true);
    const second = runner.start("fake", { kind: "change" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already running");
    await runner.settled();
    const d = store.getSnapshot().dispatches[0]!;
    expect(d.status).toBe("done");
    expect(d.hunkId).toBe(hunk.id);
    expect(d.output).toContain("Reviewing");
    expect(d.findings).toMatchObject([{ severity: "p1", anchor: { path: hunk.path, line: 2 }, dispatcher: "fake" }]);
    expect(d.freeform).toContain("deserves a second look");
    expect(events[0]).toBe("dispatch.started");
    expect(events).toContain("dispatch.output");
    expect(events.at(-1)).toBe("dispatch.finished");
    expect(runner.running).toBe(false);
  });

  test("{diff_file} and {repo} are provided; cwd is the repo", async () => {
    const store = new ReviewStore(await review());
    const runner = new DispatchRunner(store, { repo: tmp, config: config("pwd; test {repo} = \"$(pwd -P)\" || test {repo} = \"$(pwd)\"; head -1 {diff_file}") });
    runner.start("fake", { kind: "change" });
    await runner.settled();
    const d = store.getSnapshot().dispatches[0]!;
    expect(d.status).toBe("done");
    expect(d.output).toContain("diff --git a/");
  });

  test("non-zero exit → failed, findings still parsed", async () => {
    const store = new ReviewStore(await review());
    const runner = new DispatchRunner(store, { repo: tmp, config: config(`sh ${FAKE} {prompt_file} fail`) });
    runner.start("fake", { kind: "hunk", hunk: store.getSnapshot().changeSet.files[2]!.hunks[0]! });
    await runner.settled();
    const d = store.getSnapshot().dispatches[0]!;
    expect(d.status).toBe("failed");
    expect(d.error).toBe("exited with code 3");
    expect(d.findings).toHaveLength(1);
  });

  test("missing command → failed with the shell's message", async () => {
    const store = new ReviewStore(await review());
    const runner = new DispatchRunner(store, { repo: tmp, config: config("definitely-not-a-command-lookout {prompt_file}") });
    runner.start("fake", { kind: "change" });
    await runner.settled();
    const d = store.getSnapshot().dispatches[0]!;
    expect(d.status).toBe("failed");
    expect(d.output).toMatch(/not found/);
  });

  test("x cancels mid-run with SIGTERM; runner is reusable afterwards", async () => {
    const store = new ReviewStore(await review());
    const runner = new DispatchRunner(store, { repo: tmp, config: config(`sh ${FAKE} {prompt_file} slow`) });
    runner.start("fake", { kind: "change" });
    await Bun.sleep(300);
    expect(store.getSnapshot().dispatches[0]!.output).toContain("thinking");
    const t0 = Date.now();
    expect(runner.cancel()).toBe(true);
    await runner.settled();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(store.getSnapshot().dispatches[0]!.status).toBe("cancelled");
    expect(runner.running).toBe(false);
    runner.start("fake", { kind: "change" });
    runner.cancel();
    await runner.settled();
    expect(store.getSnapshot().dispatches.map((d) => d.status)).toEqual(["cancelled", "cancelled"]);
  });

  test("a process ignoring SIGTERM is SIGKILLed after the grace period", async () => {
    const store = new ReviewStore(await review());
    const runner = new DispatchRunner(store, { repo: tmp, config: config(`sh ${FAKE} {prompt_file} stubborn`), killGraceMs: 300 });
    runner.start("fake", { kind: "change" });
    await Bun.sleep(300);
    const t0 = Date.now();
    runner.cancel();
    await runner.settled();
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(2500);
    expect(store.getSnapshot().dispatches[0]!.status).toBe("cancelled");
  });
});

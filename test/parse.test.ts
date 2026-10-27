import { describe, expect, test } from "bun:test";
import { parseDiff } from "../src/core/diff.ts";
import type { ChangeSet } from "../src/core/types.ts";
import { parseDispatchOutput } from "../src/dispatch/parse.ts";

const out = (name: string) => Bun.file(`${import.meta.dir}/../fixtures/dispatch-outputs/${name}`).text();
const changeSet = async (): Promise<ChangeSet> => ({
  target: "t",
  base: "",
  head: "",
  files: parseDiff(await Bun.file(`${import.meta.dir}/../fixtures/result-errors.diff`).text()),
});
const opts = async () => ({ dispatcher: "pi", dispatchId: "d1", changeSet: await changeSet() });

describe("parseDispatchOutput on real pi outputs", () => {
  test("empty findings block among ```text blocks → no findings, prose kept as freeform", async () => {
    const r = parseDispatchOutput(await out("pi-empty-findings-among-text-blocks.md"), await opts());
    expect(r.findings).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.freeform).toContain("Previous flow");
    expect(r.freeform).toContain("safer failure mode");
    expect(r.freeform).not.toContain('"findings": []');
  });

  test("malformed JSON (a fragment) → no findings, whole output freeform, note explains", async () => {
    const text = await out("pi-malformed-json-fragment.md");
    const r = parseDispatchOutput(text, await opts());
    expect(r.findings).toEqual([]);
    expect(r.notes[0]).toMatch(/not valid JSON/);
    expect(r.freeform).toBe(text.trim());
  });

  test("multiple blocks in another contract → last block used, no findings array noted", async () => {
    const r = parseDispatchOutput(await out("pi-multiple-blocks-other-contract.md"), await opts());
    expect(r.findings).toEqual([]);
    expect(r.notes).toEqual(['last ```json block has no "findings" array']);
  });
});

describe("parseDispatchOutput on contract outputs", () => {
  test("anchors inside the diff kept; outside / unknown file → unanchored; bad items noted", async () => {
    const r = parseDispatchOutput(await out("contract-anchored.md"), await opts());
    expect(r.findings.map((f) => [f.title, f.severity, f.anchor?.line ?? null])).toEqual([
      ["Config errors hide the repo path", "p1", 50],
      ["Outside the diff", "p2", null],
      ["Unknown file", "p2", null],
      ["Bad severity", "p2", null],
    ]);
    expect(r.findings[0]!.anchor!.path).toBe("src/cli/main.ts");
    expect(r.findings.every((f) => f.dispatcher === "pi")).toBe(true);
    expect(r.notes).toHaveLength(4);
    expect(r.notes.join("\n")).toContain(":9000 is outside the diff");
    expect(r.notes.join("\n")).toContain("finding 5 skipped");
    expect(r.freeform).toContain("silently hides a missing repo-local config");
  });

  test("multiple blocks → the last one wins", async () => {
    const r = parseDispatchOutput(await out("contract-multiple-blocks-last-wins.md"), await opts());
    expect(r.findings.map((f) => f.title)).toEqual(["final finding"]);
    expect(r.freeform).toContain("draft finding");
  });

  test("bare array, upper-case severity, unterminated final fence", async () => {
    const r = parseDispatchOutput(await out("contract-bare-array-no-trailing-fence.md"), await opts());
    expect(r.findings).toMatchObject([{ severity: "p2", title: "Unclear name" }]);
  });

  test("no json block → freeform only", async () => {
    const r = parseDispatchOutput("All good, nothing to report.", await opts());
    expect(r).toEqual({ findings: [], freeform: "All good, nothing to report.", notes: ["no ```json findings block in output"] });
  });

  test("ANSI colour codes are stripped before parsing", async () => {
    const r = parseDispatchOutput('\x1b[32mdone\x1b[0m\n```json\n{"findings":[{"severity":"p0","title":"x"}]}\n```', await opts());
    expect(r.findings[0]!.severity).toBe("p0");
    expect(r.freeform).toBe("done");
  });
});

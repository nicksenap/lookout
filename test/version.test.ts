import { expect, test } from "bun:test";

test("lookout --version prints the package version", async () => {
  const proc = Bun.spawn(["bun", "bin/lookout", "--version"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(out.trim()).toBe("lookout 0.1.0");
});

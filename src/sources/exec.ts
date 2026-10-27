import { err, ok, type Result } from "../core/result.ts";

/** Run a command and return stdout, or the failure with stderr on non-zero exit. A missing binary is a failure too. */
export async function run(cmd: string[], cwd: string = process.cwd()): Promise<Result<string>> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) return err(`${cmd.join(" ")} failed (exit ${code}): ${stderr.trim() || out.trim()}`);
  return ok(out);
}

/**
 * Expected, recoverable failures are returned, not thrown. A missing API key, a failed
 * model call, `gh` not installed, invalid config, an agent's output that does not parse:
 * all are `Result`s the pipeline degrades past. Programmer errors and impossible states
 * throw. Modules that call throwing libraries convert once, at the call site.
 */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Run a throwing function and return its outcome as a Result with the error's first line as message. */
export function attempt<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (e) {
    return err(message(e));
  }
}

export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(message(e));
  }
}

export const message = (e: unknown): string => (e instanceof Error ? e.message.split("\n")[0]! : String(e));

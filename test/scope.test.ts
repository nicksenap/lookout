import { describe, expect, test } from "bun:test";
import { enclosingPath } from "../src/rank/scope.ts";

const ts = `import x from "y";

export const DEPLOYMENTS: Partial<
	Record<InstanceId, Policy>
> = {
	stage: {
		// a comment
		callers: [],
		servedTools: {
			"web": [
				...PORTAL_TOOLS,
				...EXTRA_TOOLS,
			],
		},
	},
};

/**
 * doc
 */
export function callerEnv(
	config: InstanceConfig,
	callerName: string,
): Record<string, string> {
	const served = [];
	if (
		callerName === "web"
	) {
		throw new Error("x");
	}
	return {};
}

describe("outer", () => {
  test("inner case", () => {
    expect(1).toBe(1);
  });
});
`;

const py = `class TaskService:
    def move_task(self, task_id: str) -> None:
        if task_id:
            self._store.update_item(
                Key={"pk": task_id},
            )

def top_level():
    pass
`;

describe("enclosingPath", () => {
  const line = (src: string, needle: string) => src.split("\n").findIndex((l) => l.includes(needle)) + 1;
  test("object keys and a multi-line declaration, outermost first", () => {
    expect(enclosingPath(ts, line(ts, "...EXTRA_TOOLS"))).toEqual(["DEPLOYMENTS", "stage", "servedTools", "web"]);
  });
  test("a function with a multi-line signature; an `if` is not a scope name", () => {
    expect(enclosingPath(ts, line(ts, 'throw new Error("x")'))).toEqual(["callerEnv"]);
  });
  test("describe/test names from their string argument", () => {
    expect(enclosingPath(ts, line(ts, "expect(1)"))).toEqual(["outer", "inner case"]);
  });
  test("python: class › def › call", () => {
    expect(enclosingPath(py, line(py, 'Key={"pk"'))).toEqual(["TaskService", "move_task", "self._store.update_item"]);
  });
  test("a top-level line has no path; an out-of-range line has none", () => {
    expect(enclosingPath(ts, 1)).toEqual([]);
    expect(enclosingPath(py, line(py, "def top_level"))).toEqual([]);
    expect(enclosingPath(ts, 999)).toEqual([]);
  });
});

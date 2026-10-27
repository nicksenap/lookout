import type { Attention, ChangeSet, EditBlock, FileChange, Hunk } from "../core/types.ts";
import { isolateBlock, mapBlocks } from "../core/blocks.ts";
import { type CodeLang, LANGS, lex, type LexResult, type StartState } from "./lexer.ts";

// ---------------------------------------------------------------- path globs

/** Convert a glob (`**`, `*`, `?`, `{a,b}`) to a regex. Patterns without `/` match the basename. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += `(?:${glob.slice(i + 1, end).split(",").map(escapeRe).join("|")})`;
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp(glob.includes("/") ? `^${re}$` : `(?:^|/)${re}$`);
}
const escapeRe = (s: string) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");

export const PATH_GLOBS: Record<"generated" | "lockfile" | "ci" | "test" | "docs", string[]> = {
  lockfile: [
    "{bun.lock,bun.lockb,package-lock.json,npm-shrinkwrap.json,yarn.lock,pnpm-lock.yaml}",
    "{Cargo.lock,go.sum,poetry.lock,Pipfile.lock,uv.lock,Gemfile.lock,composer.lock,gradle.lockfile}",
  ],
  generated: [
    "*.min.{js,css}", "*.map", "**/dist/**", "**/__generated__/**", "**/generated/**",
    "*.generated.*", "*.gen.*", "*.pb.go", "*_pb2.py", "*_pb2_grpc.py",
  ],
  ci: [
    ".github/workflows/**", ".github/actions/**", ".gitlab-ci.yml", ".circleci/**", ".buildkite/**",
    "Jenkinsfile", "azure-pipelines.yml", "bitbucket-pipelines.yml", ".travis.yml",
  ],
  test: [
    "*.{test,spec}.*", "**/__tests__/**", "**/__mocks__/**", "**/test/**", "**/tests/**", "**/src/test/**",
    "*_test.go", "test_*.py", "*_test.py", "conftest.py", "test-setup.*", "**/testdata/**", "**/fixtures/**",
  ],
  docs: ["*.{md,markdown,mdx,rst,adoc}", "docs/**", "**/docs/**", "LICENSE*", "CHANGELOG*"],
};
const PATH_RES = Object.fromEntries(
  Object.entries(PATH_GLOBS).map(([k, globs]) => [k, globs.map(globToRegExp)]),
) as Record<keyof typeof PATH_GLOBS, RegExp[]>;

/** Path words (split on separators and camelCase) that mark security- or money-relevant code. */
export const SENSITIVE_WORDS = new Set([
  "auth", "authn", "authz", "authentication", "authorization", "oauth", "oidc", "saml", "sso",
  "login", "logout", "signin", "signup", "session", "sessions", "token", "tokens", "jwt",
  "secret", "secrets", "credential", "credentials", "password", "passwords", "passwd",
  "crypto", "encrypt", "encryption", "decrypt", "security", "csp", "cors", "csrf", "xss", "sanitize",
  "permission", "permissions", "rbac", "acl", "iam", "billing", "payment", "payments", "stripe",
  "migration", "migrations", "env", "codeowners", "dockerfile", "terraform", "tf", "infra", "k8s", "helm",
]);

function pathWords(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function pathLabels(path: string): string[] {
  const labels: string[] = [];
  for (const [label, res] of Object.entries(PATH_RES)) if (res.some((r) => r.test(path))) labels.push(label);
  if (pathWords(path).some((w) => SENSITIVE_WORDS.has(w))) labels.push("sensitive");
  return labels;
}

// ---------------------------------------------------------------- languages

export type Lang = CodeLang | "markdown";

export function languageOf(path: string): Lang | undefined {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  switch (ext) {
    case "ts": case "js": case "mjs": case "cjs": case "mts": case "cts":
      return "js";
    case "tsx": case "jsx":
      return "jsx";
    case "py": case "pyi":
      return "python";
    case "go":
      return "go";
    case "kt": case "kts":
      return "kotlin";
    case "md": case "markdown":
      return "markdown";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- content

export type ContentClass = "whitespace-only" | "comment-only";

/** Comments that tools or policy read (`// @tag`, lint/type pragmas, build tags): they count as code. */
const DIRECTIVE_RE =
  /^(?:\/\/|#|\/\*+)\s*(?:@[\w-]+|eslint|prettier-ignore|biome-ignore|istanbul|c8\b|v8\b|jshint|tslint|global\s|noqa|type:|pylint:|mypy:|pyright:|nolint|go:|\+build|export\s|#cgo|#include|webpack|[#@]__PURE__|[#@]__NO_SIDE_EFFECTS__|fmt:|isort:|ktlint|noinspection|NOSONAR|language=|sourceMappingURL|-\*-|!)/i;

/** Normalise a token stream: optional comment removal, collapsed/trimmed newlines. */
function normalise(lex: LexResult, keepComments: boolean, commentsAreCode: boolean): string[] {
  const out: string[] = [];
  const toks = lex.tokens;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.kind === "comment") {
      const directive = commentsAreCode || DIRECTIVE_RE.test(t.text);
      if (directive) out.push(`code:${t.text}`);
      else if (keepComments) out.push(`comment:${t.text.replace(/\s+/g, " ").trim()}`);
      continue;
    }
    if (t.kind === "nl") {
      if (out.length > 0 && out[out.length - 1] !== "nl") out.push("nl");
      continue;
    }
    out.push(`${t.kind}:${t.text}`);
  }
  while (out[out.length - 1] === "nl") out.pop();
  return out;
}

/** JSX text can contain `//` and `/*` literally; only `{/* … *\/}` is surely a comment there. */
function jsxUnsafeComments(lexed: LexResult, text: string): boolean {
  if (!/<\/|\/>/.test(text)) return false;
  const toks = lexed.tokens;
  return toks.some((t, k) => t.kind === "comment" && !(toks[k - 1]?.text === "{" && toks[k + 1]?.text === "}"));
}

function compare(a: LexResult, b: LexResult, commentsAreCode: boolean): ContentClass | undefined {
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((v, k) => v === y[k]);
  if (eq(normalise(a, true, commentsAreCode), normalise(b, true, commentsAreCode))) return "whitespace-only";
  if (eq(normalise(a, false, commentsAreCode), normalise(b, false, commentsAreCode))) return "comment-only";
  return undefined;
}

const looksInsideBlockComment = (text: string) => {
  const first = text.split("\n").find((l) => l.trim() !== "");
  return first !== undefined && /^\s*\*/.test(first);
};

function classifyCode(lang: CodeLang, oldText: string, newText: string): ContentClass | undefined {
  const spec = LANGS[lang];
  const starts: StartState[] = [{ kind: "code" }];
  // The hunk may begin inside a multi-line string; the claim must hold for that reading too.
  for (const d of spec.multilineDelims) if (oldText.includes(d) || newText.includes(d)) starts.push({ kind: "string", delim: d });
  if (spec.blockComment && looksInsideBlockComment(oldText) && looksInsideBlockComment(newText)) starts.push({ kind: "block-comment" });

  const results: (ContentClass | undefined)[] = [];
  for (const start of starts) {
    const a = lex(oldText, lang, start);
    const b = lex(newText, lang, start);
    // A stray `*/` means this reading is impossible, so it can be skipped.
    if (a.unmatchedCloser || b.unmatchedCloser) continue;
    if (a.ambiguous || b.ambiguous) return undefined;
    let commentsAreCode = false;
    if (lang === "jsx" && (jsxUnsafeComments(a, oldText) || jsxUnsafeComments(b, newText))) commentsAreCode = true;
    if (lang === "go" && /import\s+"C"/.test(oldText + newText)) commentsAreCode = true;
    if (/^#!/.test(oldText) || /^#!/.test(newText)) commentsAreCode = true;
    results.push(compare(a, b, commentsAreCode));
  }
  if (results.length === 0 || results.some((r) => r === undefined)) return undefined;
  return results.includes("comment-only") ? "comment-only" : "whitespace-only";
}

/** Markdown: trailing whitespace is ignored unless it is a hard break; blank-line runs collapse. */
function normaliseMarkdown(text: string): string {
  const lines = text.split("\n").map((l) => (/ {2,}$/.test(l) ? `${l.trimEnd()}<br>` : l.trimEnd()));
  const out: string[] = [];
  for (const l of lines) if (!(l === "" && (out.length === 0 || out[out.length - 1] === ""))) out.push(l);
  while (out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

function classifyMarkdown(oldText: string, newText: string): ContentClass | undefined {
  if (normaliseMarkdown(oldText) === normaliseMarkdown(newText)) return "whitespace-only";
  const fence = /^\s*(```|~~~)/m;
  if (fence.test(oldText) || fence.test(newText)) return undefined; // <!-- --> is literal inside code fences
  const balanced = (t: string) => (t.match(/<!--/g)?.length ?? 0) === (t.match(/-->/g)?.length ?? 0);
  if (!balanced(oldText) || !balanced(newText)) return undefined;
  const strip = (t: string) => normaliseMarkdown(t.replace(/<!--[\s\S]*?-->/g, ""));
  return strip(oldText) === strip(newText) ? "comment-only" : undefined;
}

export function classifyContent(path: string, sidesOf: { oldText: string; newText: string }): ContentClass | undefined {
  const lang = languageOf(path);
  if (!lang) return undefined; // unknown language → never inert
  const { oldText, newText } = sidesOf;
  if (oldText === newText) return undefined;
  return lang === "markdown" ? classifyMarkdown(oldText, newText) : classifyCode(lang, oldText, newText);
}

// ---------------------------------------------------------------- block ranking

export interface RuleResult {
  labels: string[];
  attention: Attention;
  score: number;
}

const LABEL_WEIGHTS: Record<string, number> = {
  sensitive: 0.3, ci: 0.2, test: -0.2, docs: -0.3, lockfile: -0.5, generated: -0.5,
};

/** Rank one edit block. Content classification sees the whole hunk for lexer context but only this block's change. */
export function rankBlockByRules(file: FileChange, hunk: Hunk, block: EditBlock): RuleResult {
  const labels = pathLabels(file.path);
  // Creating or deleting a file is itself a change, whatever the block contains.
  const content = file.status === "added" || file.status === "deleted" ? undefined : classifyContent(file.path, isolateBlock(hunk, block));
  if (content) labels.push(content);
  if (file.status !== "modified") labels.push(file.status);

  const changed = block.to - block.from;
  let score = Math.min(1, Math.log2(1 + changed) / 8);
  for (const l of labels) score += LABEL_WEIGHTS[l] ?? 0;
  score = Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;

  const sensitive = labels.includes("sensitive");
  let attention: Attention = "routine";
  if (!sensitive && (content || labels.includes("generated"))) attention = "inert";
  else if (sensitive || labels.includes("ci")) attention = "needs-eyes";
  if (attention === "inert") score = 0;
  return { labels, attention, score };
}

/** Rank a whole hunk as one unit (used when a hunk has no blocks, e.g. tests of legacy fixtures). */
export function rankHunkByRules(file: FileChange, hunk: Hunk): RuleResult {
  const whole: EditBlock = { id: hunk.id, hunkId: hunk.id, path: hunk.path, from: 0, to: hunk.lines.length, labels: [], attention: "routine", score: 0 };
  return rankBlockByRules(file, hunk, whole);
}

export function applyRules(changeSet: ChangeSet): ChangeSet {
  return mapBlocks(changeSet, ({ file, hunk, block }) => ({ ...block, ...rankBlockByRules(file, hunk, block) }));
}

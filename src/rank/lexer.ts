/**
 * Small, conservative lexers for comment-only / whitespace-only hunk detection.
 * Strings are kept verbatim; code is split into words and operators so whitespace
 * between tokens can be ignored. Anything the lexer is unsure of is reported as
 * `ambiguous` so callers never claim a hunk is inert on a guess.
 */

export type CodeLang = "js" | "jsx" | "python" | "go" | "kotlin";

export interface Token {
  kind: "code" | "string" | "comment" | "nl" | "indent";
  text: string;
}

export type StartState = { kind: "code" } | { kind: "string"; delim: string } | { kind: "block-comment" };

export interface LexResult {
  tokens: Token[];
  /** Reason the lexer could not be sure of the token stream. */
  ambiguous?: string;
  /** Saw `*` `/` while in code: the hunk probably started inside a block comment. */
  unmatchedCloser: boolean;
}

interface LangSpec {
  lineComment: string;
  blockComment: boolean;
  nestedBlockComments: boolean;
  /** Delimiters of strings that may span lines (template, raw, triple-quoted). */
  multilineDelims: string[];
  /** Delimiters whose strings allow `${...}` interpolation. */
  templateDelims: string[];
  /** Single-line string quotes. */
  quotes: string[];
  regexLiterals: boolean;
  significantIndent: boolean;
}

export const LANGS: Record<CodeLang, LangSpec> = {
  js: {
    lineComment: "//",
    blockComment: true,
    nestedBlockComments: false,
    multilineDelims: ["`"],
    templateDelims: ["`"],
    quotes: ["'", '"'],
    regexLiterals: true,
    significantIndent: false,
  },
  jsx: {
    lineComment: "//",
    blockComment: true,
    nestedBlockComments: false,
    multilineDelims: ["`"],
    templateDelims: ["`"],
    quotes: ["'", '"'],
    regexLiterals: true,
    significantIndent: false,
  },
  go: {
    lineComment: "//",
    blockComment: true,
    nestedBlockComments: false,
    multilineDelims: ["`"],
    templateDelims: [],
    quotes: ["'", '"'],
    regexLiterals: false,
    significantIndent: false,
  },
  kotlin: {
    lineComment: "//",
    blockComment: true,
    nestedBlockComments: true,
    multilineDelims: ['"""'],
    templateDelims: ['"""', '"'],
    quotes: ["'"],
    regexLiterals: false,
    significantIndent: false,
  },
  python: {
    lineComment: "#",
    blockComment: false,
    nestedBlockComments: false,
    multilineDelims: ['"""', "'''"],
    templateDelims: [],
    quotes: ["'", '"'],
    regexLiterals: false,
    significantIndent: true,
  },
};

const OPERATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
  "::",
  "->",
  ":=",
  "<-",
  "//",
  "!!",
  "?:",
  "..",
];

const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
]);
const WORD_RE = /[A-Za-z0-9_$\u0080-\uffff]/;

type Frame = { kind: "code"; depth: number; interp: boolean } | { kind: "template"; delim: string; buf: string };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one state machine over every token class; a split per state would hide the transitions
export function lex(src: string, lang: CodeLang, start: StartState): LexResult {
  const spec = LANGS[lang];
  const tokens: Token[] = [];
  let ambiguous: string | undefined;
  let unmatchedCloser = false;
  const stack: Frame[] = [{ kind: "code", depth: 0, interp: false }];
  let i = 0;
  let pendingIndent: string | null = null;
  let atLineStart = true;

  const push = (kind: Token["kind"], text: string) => {
    if ((kind === "code" || kind === "string") && pendingIndent !== null) {
      if (spec.significantIndent) tokens.push({ kind: "indent", text: pendingIndent });
      pendingIndent = null;
    }
    tokens.push({ kind, text });
  };
  const lastSignificant = (): Token | undefined => {
    for (let k = tokens.length - 1; k >= 0; k--) {
      const t = tokens[k]!;
      if (t.kind === "code" || t.kind === "string") return t;
    }
    return undefined;
  };

  // Consume a block comment starting at i (i points just past the opener when `opened`).
  const blockComment = (from: number, opened: boolean): number => {
    let j = opened ? from : from + 2;
    let depth = 1;
    while (j < src.length) {
      if (spec.nestedBlockComments && src.startsWith("/*", j)) {
        depth++;
        j += 2;
        continue;
      }
      if (src.startsWith("*/", j)) {
        depth--;
        j += 2;
        if (depth === 0) break;
        continue;
      }
      j++;
    }
    push("comment", src.slice(from, j));
    return j;
  };

  // Consume a string (non-template) starting at i with delimiter `q`.
  const simpleString = (from: number, q: string, opened: boolean): number => {
    let j = opened ? from : from + q.length;
    const multiline = spec.multilineDelims.includes(q);
    const rawNoEscape = lang === "go" && q === "`";
    while (j < src.length) {
      if (!rawNoEscape && src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src.startsWith(q, j)) {
        j += q.length;
        push("string", src.slice(from, j));
        return j;
      }
      if (src[j] === "\n" && !multiline) {
        ambiguous ??= `unterminated string at line ${src.slice(0, j).split("\n").length}`;
        push("string", src.slice(from, j));
        return j;
      }
      j++;
    }
    if (!multiline) ambiguous ??= "unterminated string at end of hunk";
    push("string", src.slice(from, j));
    return j;
  };

  if (start.kind === "block-comment") {
    if (!spec.blockComment) return { tokens, ambiguous: "no block comments in language", unmatchedCloser };
    i = blockComment(0, true);
    atLineStart = false;
  } else if (start.kind === "string") {
    if (spec.templateDelims.includes(start.delim)) stack.push({ kind: "template", delim: start.delim, buf: "" });
    else {
      i = simpleString(0, start.delim, true);
      atLineStart = false;
    }
  }

  while (i < src.length) {
    const frame = stack[stack.length - 1]!;

    if (frame.kind === "template") {
      const c = src[i]!;
      if (c === "\\") {
        frame.buf += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (src.startsWith(frame.delim, i)) {
        // Kotlin: """" closes with the last three quotes.
        push("string", frame.buf + frame.delim);
        stack.pop();
        i += frame.delim.length;
        continue;
      }
      if (src.startsWith("${", i)) {
        push("string", `${frame.buf}\${`);
        frame.buf = "";
        stack.push({ kind: "code", depth: 0, interp: true });
        i += 2;
        continue;
      }
      if (c === "\n" && !spec.multilineDelims.includes(frame.delim)) {
        ambiguous ??= "unterminated template string";
        push("string", frame.buf);
        stack.pop();
        continue;
      }
      frame.buf += c;
      i++;
      continue;
    }

    const c = src[i]!;
    if (c === "\n") {
      push("nl", "\n");
      i++;
      atLineStart = true;
      pendingIndent = null;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      let j = i;
      while (j < src.length && /[ \t\r\f]/.test(src[j]!)) j++;
      if (atLineStart && !frame.interp) pendingIndent = src.slice(i, j);
      i = j;
      continue;
    }
    if (atLineStart) {
      if (!frame.interp) pendingIndent ??= "";
      atLineStart = false;
    }

    if (src.startsWith(spec.lineComment, i)) {
      let j = src.indexOf("\n", i);
      if (j < 0) j = src.length;
      push("comment", src.slice(i, j));
      i = j;
      continue;
    }
    if (spec.blockComment && src.startsWith("/*", i)) {
      i = blockComment(i, false);
      continue;
    }
    if (spec.blockComment && src.startsWith("*/", i)) {
      unmatchedCloser = true;
      push("code", "*/");
      i += 2;
      continue;
    }

    const tmpl = spec.templateDelims.find((d) => src.startsWith(d, i));
    if (tmpl) {
      stack.push({ kind: "template", delim: tmpl, buf: tmpl });
      i += tmpl.length;
      continue;
    }
    const ml = spec.multilineDelims.find((d) => src.startsWith(d, i));
    if (ml) {
      i = simpleString(i, ml, false);
      continue;
    }
    if (spec.quotes.includes(c)) {
      i = simpleString(i, c, false);
      continue;
    }

    if (spec.regexLiterals && c === "/") {
      const prev = lastSignificant();
      // JSX `</tag>` and `/>` are not regex literals.
      const jsxSlash = lang === "jsx" && (prev?.text === "<" || src[i + 1] === ">");
      const regexAllowed =
        !jsxSlash &&
        (!prev ||
          (prev.kind === "code" &&
            (REGEX_KEYWORDS.has(prev.text) || (!WORD_RE.test(prev.text[0]!) && ![")", "]", "}"].includes(prev.text)))));
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < src.length && src[j] !== "\n") {
          const ch = src[j]!;
          if (ch === "\\") {
            j += 2;
            continue;
          }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) {
            closed = true;
            j++;
            break;
          }
          j++;
        }
        if (!closed) ambiguous ??= "unterminated regex literal";
        while (j < src.length && /[a-z]/.test(src[j]!)) j++;
        push("string", src.slice(i, j));
        i = j;
        continue;
      }
    }

    if (frame.interp) {
      if (c === "{") frame.depth++;
      if (c === "}") {
        if (frame.depth === 0) {
          stack.pop();
          const outer = stack[stack.length - 1];
          if (outer?.kind === "template") outer.buf = "}";
          i++;
          continue;
        }
        frame.depth--;
      }
    }

    if (WORD_RE.test(c)) {
      let j = i;
      while (j < src.length && WORD_RE.test(src[j]!)) j++;
      push("code", src.slice(i, j));
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    const text = op ?? c;
    push("code", text);
    i += text.length;
  }

  const top = stack[stack.length - 1]!;
  if (top.kind === "template") {
    push("string", top.buf);
    if (!spec.multilineDelims.includes(top.delim)) ambiguous ??= "unterminated template string";
  }
  return ambiguous === undefined ? { tokens, unmatchedCloser } : { tokens, ambiguous, unmatchedCloser };
}

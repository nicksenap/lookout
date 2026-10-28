// Cyclomatic complexity per function, like gocyclo: 1 + one per branch point (if, for, while, case,
// catch, ?:, &&, ||, ??, ?.). Fails when any function in src/ exceeds the threshold.
// Parsed with oxc (TypeScript 7 ships no JS compiler API). Usage: bun scripts/complexity.ts [--over 50] [--top 15]
//
// The threshold is high on purpose: the honest shape of a lexer state machine, a hand-written
// config validator (AGENTS.md: no zod) or a key table is one long flat chain, and splitting it to
// satisfy a number makes it harder to read. The gate exists to catch growth in logic functions.
// `lex` is allowed up to 80: it is one state machine over every token class.
import { Glob } from "bun";
import { parseSync } from "oxc-parser";

const args = process.argv.slice(2);
const over = Number(args[args.indexOf("--over") + 1] || 50);
const ALLOW: Record<string, number> = { "src/rank/lexer.ts:lex": 80 };
const top = Number(args[args.indexOf("--top") + 1] || 0);

interface Entry {
  file: string;
  name: string;
  line: number;
  complexity: number;
}

type Node = { type: string; start: number; end: number; [key: string]: unknown };
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const BRANCH = new Set(["IfStatement", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "SwitchCase", "CatchClause", "ConditionalExpression"]);
const LOGICAL = new Set(["&&", "||", "??"]);

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && typeof (v as Node).type === "string";
function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (isNode(value)) out.push(value);
    else if (Array.isArray(value)) for (const v of value) if (isNode(v)) out.push(v);
  }
  return out;
}

/** Complexity of one function body; nested functions are counted on their own. */
function complexityOf(fn: Node): number {
  let n = 1;
  const visit = (node: Node) => {
    if (node !== fn && FUNCTIONS.has(node.type)) return;
    if (BRANCH.has(node.type) && !(node.type === "SwitchCase" && node.test === null)) n++;
    if (node.type === "LogicalExpression" && LOGICAL.has(node.operator as string)) n++;
    if ((node.type === "MemberExpression" || node.type === "CallExpression") && node.optional === true) n++;
    for (const c of children(node)) visit(c);
  };
  const body = fn.body as Node | undefined;
  if (body) visit(body);
  return n;
}

function nameOf(fn: Node, parent: Node | undefined): string {
  const id = fn.id as Node | undefined;
  if (id && typeof id.name === "string") return id.name;
  if (parent?.type === "VariableDeclarator" && isNode(parent.id) && typeof parent.id.name === "string") return parent.id.name;
  if ((parent?.type === "Property" || parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition") && isNode(parent.key) && typeof parent.key.name === "string") return parent.key.name;
  if (parent?.type === "CallExpression" && isNode(parent.callee)) {
    const callee = parent.callee;
    const name = typeof callee.name === "string" ? callee.name : isNode(callee.property) && typeof callee.property.name === "string" ? callee.property.name : "call";
    return `${name}(…)`;
  }
  return "(anonymous)";
}

const entries: Entry[] = [];
for await (const file of new Glob("src/**/*.{ts,tsx}").scan(".")) {
  const source = await Bun.file(file).text();
  const parsed = parseSync(file, source);
  if (parsed.errors.length) {
    console.error(`${file}: ${parsed.errors[0]!.message}`);
    process.exit(2);
  }
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
  const walk = (node: Node, parent: Node | undefined) => {
    if (FUNCTIONS.has(node.type)) {
      const c = complexityOf(node);
      const body = node.body as Node | undefined;
      // An arrow with an expression body (`(x) => x + 1`) only counts when it branches.
      if (c > 1 || body?.type === "BlockStatement") entries.push({ file, name: nameOf(node, parent), line: lineAt(node.start), complexity: c });
    }
    for (const c of children(node)) walk(c, node);
  };
  walk(parsed.program as unknown as Node, undefined);
}

entries.sort((a, b) => b.complexity - a.complexity);
if (top > 0) for (const e of entries.slice(0, top)) console.log(`${String(e.complexity).padStart(3)}  ${e.file}:${e.line}  ${e.name}`);
const offenders = entries.filter((e) => e.complexity > (ALLOW[`${e.file}:${e.name}`] ?? over));
if (offenders.length > 0) {
  console.error(`${offenders.length} function${offenders.length === 1 ? "" : "s"} over complexity ${over}:`);
  for (const e of offenders) console.error(`${String(e.complexity).padStart(3)}  ${e.file}:${e.line}  ${e.name}`);
  process.exit(1);
}
if (top === 0) console.log(`complexity: ${entries.length} functions, none over ${over} (max ${entries[0]?.complexity ?? 0})`);

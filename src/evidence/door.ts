import { allBlocks, blockLines, type BlockRef } from "../core/blocks.ts";
import { compareCards } from "../cards/build.ts";
import { type Card, type CardColor, type ChangeSet, COLOR_ORDER, type Door, type DoorKind, type DoorSignal } from "../core/types.ts";

/**
 * One-way door signals the diff shows: a migration, destructive SQL, a write to data, a removed
 * export or route, a changed API contract. Rules only; the author's word is compared, never trusted.
 */
const MIGRATION_PATH = /(^|\/)migrations?\/|\.sql$/i;
const CONTRACT_PATH = /openapi|swagger|\.proto$|\.graphqls?$|\.avsc$|(^|\/)schema\.json$/i;
const DESTRUCTIVE_SQL = /\b(DROP\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE|TYPE)|ALTER\s+TABLE\b.*\bDROP\b|TRUNCATE\b|DELETE\s+FROM)\b|\.(dropTable|dropColumn|dropIndex|removeColumn|renameColumn|renameTable)\s*\(/i;
const SQL_WRITE = /\b(INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|MERGE\s+INTO)\b/i;
/** ORM-style writes are only a signal where the file or line looks like data access; `.update(` alone is everywhere. */
const ORM_WRITE = /\b(prisma|db|knex|drizzle|sequelize|typeorm|mongoose|repo|repository|collection|tx|trx)\w*\.(create|createMany|insert|insertMany|update|updateMany|upsert|delete|deleteMany|destroy|save|bulkWrite|replaceOne|truncate)\s*\(/i;
/** Key-value stores: a conditional update that strips or rewrites attributes is a data write however the client is named. */
const KV_WRITE = /\b(update_item|put_item|delete_item|transact_write_items|batch_write_item|UpdateItemCommand|PutItemCommand|DeleteItemCommand|TransactWriteItemsCommand|BatchWriteItemCommand)\s*\(|\bUpdateExpression\b|\bTransactItems\b/;
const FS_DELETE = /\b(unlinkSync|rmSync|rmdirSync|unlink|rmdir|rimraf)\s*\(/;
const EXPORT_DECL = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
/** A removed export only matters where other code bases can see it: entry points, api/sdk/shared dirs, packages. */
const PUBLIC_PATH = /(^|\/)(index|public[-_]?api|api|sdk|client|exports?)\.[cm]?[jt]sx?$|(^|\/)(api|sdk|public|contracts?|shared|packages\/[^/]+\/src)\//i;
/** A member function of an exported object (`archive: (ws) =>` under `export const fieldsQueryKeys = {`) is public API too. */
const EXPORTED_OBJECT_HEADER = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{/;
const MEMBER_FN = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:\(|function\b)/;
const ROUTE = /\b(?:router|app|server|api|fastify|express)\.(?:get|post|put|patch|delete|del|options|head|all)\s*\(\s*["'`]([^"'`]+)["'`]/;
const ROUTE_DECORATOR = /@(?:Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*["'`]([^"'`]*)["'`]/;

export function doorSignals(changeSet: ChangeSet): DoorSignal[] {
  const refs = allBlocks(changeSet);
  const addedText = refs.flatMap((r) => blockLines(r.hunk, r.block).filter((l) => l.kind === "add").map((l) => l.text)).join("\n");
  const stillExported = (name: string) => new RegExp(`^\\s*export\\b.*\\b${name}\\b`, "m").test(addedText);
  const stillRouted = (path: string) => addedText.includes(path);
  const stillMember = (name: string) => new RegExp(`^\\s*${name}\\s*:`, "m").test(addedText);

  const out: DoorSignal[] = [];
  const seen = new Set<string>();
  const push = (s: DoorSignal) => {
    // One signal per kind per file keeps a 40-statement migration to one row; each removed export or route is its own loss.
    const key = s.kind === "removed-export" || s.kind === "removed-route" ? `${s.kind}|${s.path}|${s.text}` : `${s.kind}|${s.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  for (const r of refs) {
    const path = r.block.path;
    const lines = blockLines(r.hunk, r.block);
    // The exported object a removed member belongs to: named in the hunk header, or opened by an earlier line of the hunk that is not closed yet.
    const enclosingObject = (index: number): string | undefined => {
      const fromHeader = EXPORTED_OBJECT_HEADER.exec(r.hunk.header)?.[1];
      let open: string | undefined;
      for (const [k, l] of r.hunk.lines.entries()) {
        if (k >= index) break;
        if (l.kind === "del") continue;
        const hit = EXPORTED_OBJECT_HEADER.exec(l.text)?.[1];
        if (hit) open = hit;
        else if (/^\};?\s*$/.test(l.text)) open = undefined;
      }
      return open ?? fromHeader;
    };
    if (MIGRATION_PATH.test(path)) push({ kind: "migration", path, text: "migration file changed" });
    if (CONTRACT_PATH.test(path) && lines.some((l) => l.kind === "del")) push({ kind: "contract", path, text: "API contract changed" });
    for (const [offset, l] of lines.entries()) {
      const text = l.text.trim();
      if (l.kind === "add") {
        // Test code deletes fixtures and writes rows on purpose; only production edits are door signals.
        if (r.block.labels.includes("test")) continue;
        if (DESTRUCTIVE_SQL.test(text)) push({ kind: "destructive-sql", path, line: l.newLine, side: "new", text: `destructive SQL: ${text.slice(0, 60)}` });
        else if (KV_WRITE.test(text)) push({ kind: "data-write", path, line: l.newLine, side: "new", text: "updates stored items in place" });
        else if (SQL_WRITE.test(text) || ORM_WRITE.test(text)) push({ kind: "data-write", path, line: l.newLine, side: "new", text: "writes rows" });
        else if (FS_DELETE.test(text)) push({ kind: "data-write", path, line: l.newLine, side: "new", text: "deletes files" });
        continue;
      }
      const exp = PUBLIC_PATH.test(path) ? EXPORT_DECL.exec(l.text) : null;
      if (exp && !stillExported(exp[1]!)) push({ kind: "removed-export", path, line: l.oldLine, side: "old", text: `export ${exp[1]} removed` });
      const object = PUBLIC_PATH.test(path) ? enclosingObject(r.block.from + offset) : undefined;
      const member = object ? MEMBER_FN.exec(l.text)?.[1] : undefined;
      if (object && member && !stillMember(member)) push({ kind: "removed-export", path, line: l.oldLine, side: "old", text: `${object}.${member} removed` });
      const route = ROUTE.exec(l.text) ?? ROUTE_DECORATOR.exec(l.text);
      if (route && !stillRouted(route[1]!)) push({ kind: "removed-route", path, line: l.oldLine, side: "old", text: `route ${route[1]} removed` });
    }
  }
  return out;
}

export function detectDoor(changeSet: ChangeSet, author: DoorKind | undefined): Door {
  const signals = doorSignals(changeSet);
  const door: Door = { computed: signals.length > 0 ? "one-way" : "two-way", signals };
  if (author) door.author = author;
  return door;
}

/**
 * Attach each signal to the card whose block it came from (by path and line, else by path), and
 * let the signal raise the card's colour: a card that rewrites stored data, drops a public export
 * or route, or changes a contract is at least amber, and red when it also needs eyes. Rules only
 * raise here; nothing lowers.
 */
export function attachDoorSignals(changeSet: ChangeSet, cards: Card[], signals: DoorSignal[]): Card[] {
  if (signals.length === 0) return cards.map(({ doorSignals: _, ...c }) => c);
  const refs = allBlocks(changeSet);
  // A removed line is numbered on the old side, an added one on the new; matching both sides put a
  // removed export on whichever block happened to add lines at the same numbers.
  const owner = (s: DoorSignal): BlockRef | undefined =>
    refs.find((r) => r.block.path === s.path && s.line !== undefined && (s.side === "old" ? inRange(r.block.oldRange, s.line) : s.side === "new" ? inRange(r.block.newRange, s.line) : inRange(r.block.newRange, s.line) || inRange(r.block.oldRange, s.line))) ??
    refs.find((r) => r.block.path === s.path);
  return cards.map((card) => {
    const ids = new Set(card.blockIds);
    const own = signals.filter((s) => {
      const ref = owner(s);
      return ref !== undefined && ids.has(ref.block.id);
    });
    const { doorSignals: _, ...rest } = card;
    if (own.length === 0) return rest;
    const floor: CardColor = rest.attention === "needs-eyes" || rest.attention === "suspicious" ? "red" : "amber";
    const color = COLOR_ORDER.indexOf(floor) > COLOR_ORDER.indexOf(rest.color) ? floor : rest.color;
    return { ...rest, color, doorSignals: own };
  }).sort(compareCards);
}

const inRange = (range: { start: number; end: number } | undefined, line: number) => range !== undefined && line >= range.start && line <= range.end;

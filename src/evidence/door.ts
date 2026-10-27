import { allBlocks, blockLines, type BlockRef } from "../core/blocks.ts";
import type { Card, ChangeSet, Door, DoorKind, DoorSignal } from "../core/types.ts";

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
const FS_DELETE = /\b(unlinkSync|rmSync|rmdirSync|unlink|rmdir|rimraf)\s*\(/;
const EXPORT_DECL = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
/** A removed export only matters where other code bases can see it: entry points, api/sdk/shared dirs, packages. */
const PUBLIC_PATH = /(^|\/)(index|public[-_]?api|api|sdk|client|exports?)\.[cm]?[jt]sx?$|(^|\/)(api|sdk|public|contracts?|shared|packages\/[^/]+\/src)\//i;
const ROUTE = /\b(?:router|app|server|api|fastify|express)\.(?:get|post|put|patch|delete|del|options|head|all)\s*\(\s*["'`]([^"'`]+)["'`]/;
const ROUTE_DECORATOR = /@(?:Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*["'`]([^"'`]*)["'`]/;

export function doorSignals(changeSet: ChangeSet): DoorSignal[] {
  const refs = allBlocks(changeSet);
  const addedText = refs.flatMap((r) => blockLines(r.hunk, r.block).filter((l) => l.kind === "add").map((l) => l.text)).join("\n");
  const stillExported = (name: string) => new RegExp(`^\\s*export\\b.*\\b${name}\\b`, "m").test(addedText);
  const stillRouted = (path: string) => addedText.includes(path);

  const out: DoorSignal[] = [];
  const seen = new Set<string>();
  const push = (s: DoorSignal) => {
    // One signal per kind per file keeps a 40-statement migration to one row.
    const key = `${s.kind}|${s.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  for (const r of refs) {
    const path = r.block.path;
    const lines = blockLines(r.hunk, r.block);
    if (MIGRATION_PATH.test(path)) push({ kind: "migration", path, text: "migration file changed" });
    if (CONTRACT_PATH.test(path) && lines.some((l) => l.kind === "del")) push({ kind: "contract", path, text: "API contract changed" });
    for (const l of lines) {
      const text = l.text.trim();
      if (l.kind === "add") {
        // Test code deletes fixtures and writes rows on purpose; only production edits are door signals.
        if (r.block.labels.includes("test")) continue;
        if (DESTRUCTIVE_SQL.test(text)) push({ kind: "destructive-sql", path, line: l.newLine, text });
        else if (SQL_WRITE.test(text) || ORM_WRITE.test(text) || FS_DELETE.test(text)) push({ kind: "data-write", path, line: l.newLine, text });
        continue;
      }
      const exp = PUBLIC_PATH.test(path) ? EXPORT_DECL.exec(l.text) : null;
      if (exp && !stillExported(exp[1]!)) push({ kind: "removed-export", path, line: l.oldLine, text: `export ${exp[1]} removed` });
      const route = ROUTE.exec(l.text) ?? ROUTE_DECORATOR.exec(l.text);
      if (route && !stillRouted(route[1]!)) push({ kind: "removed-route", path, line: l.oldLine, text: `route ${route[1]} removed` });
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

/** Attach each signal to the card whose block it came from (by path and line, else by path). */
export function attachDoorSignals(changeSet: ChangeSet, cards: Card[], signals: DoorSignal[]): Card[] {
  if (signals.length === 0) return cards.map(({ doorSignals: _, ...c }) => c);
  const refs = allBlocks(changeSet);
  const owner = (s: DoorSignal): BlockRef | undefined =>
    refs.find((r) => r.block.path === s.path && s.line !== undefined && (inRange(r.block.newRange, s.line) || inRange(r.block.oldRange, s.line))) ?? refs.find((r) => r.block.path === s.path);
  return cards.map((card) => {
    const ids = new Set(card.blockIds);
    const own = signals.filter((s) => {
      const ref = owner(s);
      return ref !== undefined && ids.has(ref.block.id);
    });
    const { doorSignals: _, ...rest } = card;
    return own.length > 0 ? { ...rest, doorSignals: own } : rest;
  });
}

const inRange = (range: { start: number; end: number } | undefined, line: number) => range !== undefined && line >= range.start && line <= range.end;

import type { ChangeMap } from "../core/types.ts";
import { fit, type Line } from "./Card.tsx";
import { theme } from "./theme.ts";

/**
 * The change map above the stack, at most `rows` rows with the blank row under it. A map longer than
 * that is windowed so the selected card's node stays visible; the node carries `▸`, so a stripped
 * frame shows it too. `+`/`-` lines keep the card sketches' colours.
 */
export function mapPanel(map: ChangeMap, cardId: string | undefined, w: number, rows: number): Line[] {
  const head: Line[] = map.unverified ? [{ segments: [{ text: fit("map unverified · read the cards", w), color: theme.card.amber }] }] : [];
  const all = map.text.split("\n");
  const h = Math.max(1, rows - 1 - head.length);
  const node = cardId === undefined ? undefined : map.nodes[cardId];
  const top = node === undefined || node < h ? 0 : Math.min(node - h + 1, all.length - h);
  const body = all.slice(top, top + h).map(
    (l, k): Line => ({
      segments: [
        { text: top + k === node ? "▸ " : "  ", color: theme.accent, bold: true },
        { text: fit(l, w - 2), color: l[0] === "+" ? theme.add : l[0] === "-" ? theme.del : undefined, dim: map.unverified },
      ],
    }),
  );
  const more = all.length > h ? fit(`  map ${top + 1}–${top + body.length} of ${all.length} · m hides`, w) : "";
  return [...head, ...body, { segments: [{ text: more, dim: true }] }];
}

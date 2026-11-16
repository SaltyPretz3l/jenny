// Follow-ups stay in place (plan 5.5 of docs/plans/PROJECT_BOARD_2026-11-13.md).
//
// When a model changes a drawing it writes the whole block again with the same ids. The engine's layout takes a
// `previous` layout so the nodes both drawings share stay put; this picks the one to start from. The page lists
// the sketch blocks that came earlier in the conversation, nearest first, each with the positions it was drawn
// with when the page still has them. The frame calls `pickPrevious` before it draws.
import { buildScene, layout, prepare, previousLayout, type PreviousLayout } from "./pipeline";

/** An earlier drawing of the conversation: its source, and the positions it was drawn with when they are still known. */
export type EarlierDrawing = { source: string; positions?: PreviousLayout | null };

/** The share of the new drawing's node ids an earlier drawing must hold (the engine's own rule is the same, 0.5). */
const SHARE = 0.5;

/** The node ids a source will be drawn with, and its arrows: those of the checked input, so a repaired block compares as drawn. */
function read(source: unknown): { ids: Set<string>; edges: { from: string; to: string }[] } {
  const prepared = prepare(typeof source === "string" ? source : "");
  const ids = new Set<string>();
  if (prepared.kind !== "scene") return { ids, edges: [] };
  for (const node of prepared.input.nodes ?? []) ids.add(node.id);
  return { ids, edges: prepared.input.edges ?? [] };
}

/** The earlier source laid out once, on its own: no previous of its own, so there is no chain of follow-ups. */
async function freshPositions(source: string): Promise<PreviousLayout | null> {
  const prepared = prepare(source);
  if (prepared.kind !== "scene") return null;
  return previousLayout(await layout(await buildScene(prepared.input)));
}

/**
 * The layout a follow-up starts from, or null. Takes the nearest earlier drawing that shares at least half of the
 * new drawing's node ids (and at least one). Its own positions are returned as they are; without them it is laid
 * out once, fresh. An earlier drawing that cannot be read or laid out is skipped. Never rejects.
 *
 * An earlier drawing is also passed over when the new drawing has a new node with an arrow into a node both have
 * (a step inserted upstream). Measured at the pinned engine: the shared nodes keep their columns, so the new node
 * lands past the node it feeds and its arrow runs backwards. A fresh layout is the better drawing there.
 */
export async function pickPrevious(source: string, earlier: EarlierDrawing[]): Promise<PreviousLayout | null> {
  try {
    const { ids: mine, edges } = read(source);
    if (!mine.size || !Array.isArray(earlier)) return null;
    for (const item of earlier) {
      try {
        if (!item || typeof item.source !== "string") continue;
        const theirs = read(item.source).ids;
        let shared = 0;
        for (const id of theirs) if (mine.has(id)) shared++;
        if (shared < 1 || shared / mine.size < SHARE) continue;
        if (edges.some((edge) => mine.has(edge.from) && !theirs.has(edge.from) && theirs.has(edge.to))) continue;
        const given = item.positions;
        if (given && typeof given === "object") return given;
        const fresh = await freshPositions(item.source);
        if (fresh) return fresh;
      } catch {
        // This one is skipped; the next may do.
      }
    }
    return null;
  } catch {
    return null;
  }
}

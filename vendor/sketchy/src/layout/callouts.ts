import { FONT, SPACING } from "../style/metrics.js";
import type { Point } from "../scene/laid-out.js";
import { lineHeight, measureText } from "./text.js";

export type CalloutRequest = { id: string; text: string; anchor?: Point };

export type PlannedCallout = {
  id: string;
  lines: string[];
  /** Text box relative to the target's top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
  anchor: Point;
  leaderStart: Point;
};

export type Margins = { left: number; right: number; top: number; bottom: number };

export type CalloutPlan = { callouts: PlannedCallout[]; margins: Margins };

/**
 * Places callout labels in two columns beside a target (left and right),
 * ordered by their anchor's height so leader lines never cross each other.
 * Returns the extra room the target needs so the layout keeps it free.
 */
export function planCallouts(
  width: number,
  height: number,
  requests: CalloutRequest[],
): CalloutPlan {
  const margins: Margins = { left: 0, right: 0, top: 0, bottom: 0 };
  if (requests.length === 0) return { callouts: [], margins };

  const measured = requests.map((r) => {
    const anchor = r.anchor ?? { x: width, y: height / 2 };
    const text = measureText(r.text, FONT.label, SPACING.labelMaxTextWidth);
    return { ...r, anchor, ...text };
  });

  const left = measured.filter((m) => m.anchor.x < width / 2);
  const right = measured.filter((m) => m.anchor.x >= width / 2);
  balance(left, right, width);

  const callouts: PlannedCallout[] = [];
  for (const [side, items] of [
    ["left", left],
    ["right", right],
  ] as const) {
    items.sort((a, b) => a.anchor.y - b.anchor.y || a.anchor.x - b.anchor.x);
    const ys = stack(
      items.map((i) => ({ center: i.anchor.y, size: i.height })),
      SPACING.labelSpacing,
    );
    items.forEach((item, i) => {
      const y = ys[i]!;
      const x = side === "left" ? -SPACING.labelGap - item.width : width + SPACING.labelGap;
      const firstLine = y + lineHeight(FONT.label) / 2;
      callouts.push({
        id: item.id,
        lines: item.lines,
        x,
        y,
        width: item.width,
        height: item.height,
        anchor: item.anchor,
        leaderStart: { x: side === "left" ? x + item.width + 6 : x - 6, y: firstLine },
      });
      if (side === "left") margins.left = Math.max(margins.left, -x);
      else margins.right = Math.max(margins.right, x + item.width - width);
      margins.top = Math.max(margins.top, -y);
      margins.bottom = Math.max(margins.bottom, y + item.height - height);
    });
  }
  return { callouts, margins };
}

/** Moves labels from the fuller side to the emptier one, nearest the middle first. */
function balance<T extends { anchor: Point; height: number }>(
  left: T[],
  right: T[],
  width: number,
): void {
  const total = (list: T[]) => list.reduce((sum, i) => sum + i.height, 0);
  const byMiddle = (list: T[]) =>
    [...list].sort((a, b) => Math.abs(a.anchor.x - width / 2) - Math.abs(b.anchor.x - width / 2));
  while (total(left) > total(right) * 2 + 40 && left.length > 1) {
    const move = byMiddle(left)[0]!;
    left.splice(left.indexOf(move), 1);
    right.push(move);
  }
  while (total(right) > total(left) * 2 + 40 && right.length > 1) {
    const move = byMiddle(right)[0]!;
    right.splice(right.indexOf(move), 1);
    left.push(move);
  }
}

/**
 * Positions boxes along one axis as close to their desired centers as
 * possible without overlap. Returns the top coordinate of each box.
 */
export function stack(items: { center: number; size: number }[], gap: number): number[] {
  const tops = items.map((i) => i.center - i.size / 2);
  for (let i = 1; i < tops.length; i++) {
    const minTop = tops[i - 1]! + items[i - 1]!.size + gap;
    if (tops[i]! < minTop) tops[i] = minTop;
  }
  // Pushing down skews the column; recenter it on the anchors' spread.
  if (tops.length > 1) {
    const desired = items.reduce((s, i) => s + i.center, 0) / items.length;
    const actual = tops.reduce((s, t, i) => s + t + items[i]!.size / 2, 0) / tops.length;
    const shift = desired - actual;
    // Shifting up is only safe as far as the first box allows.
    for (let i = 0; i < tops.length; i++) tops[i]! += Math.min(0, shift);
  }
  return tops;
}

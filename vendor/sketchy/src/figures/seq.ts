/**
 * Sequence diagrams: participants across the top, dashed lifelines, numbered
 * messages in time order (self calls loop back), notes over participants.
 * Columns widen until every message label fits between its ends.
 */
import { FIG_FONT, measure, round1, titlePrims } from "./common.js";
import type { FigureLayout, Primitive, SeqSpec } from "./types.js";

const HEAD_H = 42;
const ROW_H = 46;
const NOTE_PAD = 8;
const SELF_W = 34;

export function layoutSeq(spec: SeqSpec, title: string | undefined): FigureLayout {
  const prims: Primitive[] = [];
  const top = titlePrims(title, 0, prims);
  const n = spec.actors.length;
  const index = new Map(spec.actors.map((a, i) => [a.id, i]));
  const boxW = spec.actors.map((a) => Math.max(96, measure(a.label, FIG_FONT.label) + 30));
  // Distance between neighbouring lifelines.
  const gaps = Array.from({ length: Math.max(0, n - 1) }, (_, i) =>
    Math.max(70, (boxW[i]! + boxW[i + 1]!) / 2 + 30),
  );
  const label = (text: string, i: number) => (text ? `${i}. ${text}` : `${i}.`);
  let number = 0;
  const numbered = spec.items.map((it) => (it.t === "msg" ? { it, n: ++number } : { it, n: 0 }));
  // Widen gaps so labels fit: a message spanning k gaps needs its width over them.
  for (let pass = 0; pass < 3; pass++) {
    for (const { it, n: k } of numbered) {
      if (it.t !== "msg") continue;
      const a = index.get(it.from)!;
      const b = index.get(it.to)!;
      if (a === b) continue;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const need = measure(label(it.text, k), FIG_FONT.label - 1) + 34;
      const have = gaps.slice(lo, hi).reduce((s, g) => s + g, 0);
      if (have < need) for (let g = lo; g < hi; g++) gaps[g]! += (need - have) / (hi - lo);
    }
  }
  const xs: number[] = [];
  let x = boxW[0]! / 2;
  for (let i = 0; i < n; i++) {
    xs.push(round1(x));
    x += gaps[i] ?? 0;
  }
  // Self calls and notes at the right edge need room too.
  let right = xs[n - 1]! + boxW[n - 1]! / 2;

  let y = top + HEAD_H + 22;
  const rows: Primitive[] = [];
  for (const { it, n: k } of numbered) {
    if (it.t === "note") {
      const cols = it.over.map((id) => index.get(id)!).sort((a, b) => a - b);
      const lo = xs[cols[0]!]!;
      const hi = xs[cols[cols.length - 1]!]!;
      const width = Math.max(hi - lo + 60, measure(it.text, FIG_FONT.small + 1) + NOTE_PAD * 2);
      const cx = (lo + hi) / 2;
      rows.push({
        t: "rect",
        x: round1(cx - width / 2),
        y: y - 14,
        w: round1(width),
        h: 28,
        fill: "accent",
        stroke: "ink",
        width: 1.2,
      });
      rows.push({
        t: "text",
        x: cx,
        y,
        text: it.text,
        size: FIG_FONT.small + 1,
        anchor: "middle",
        baseline: "middle",
      });
      right = Math.max(right, cx + width / 2);
      y += ROW_H - 4;
      continue;
    }
    const a = xs[index.get(it.from)!]!;
    const b = xs[index.get(it.to)!]!;

    const stroke = it.tone === "accent" ? "red" : "ink";
    const text = label(it.text, k);
    if (a === b) {
      rows.push({
        t: "poly",
        points: [
          [a, y - 6],
          [a + SELF_W, y - 6],
          [a + SELF_W, y + 14],
          [a + 2, y + 14],
        ],
        stroke,
        width: 1.6,
        dashed: it.dashed,
        arrow: "end",
        key: `s${k}`,
      });
      rows.push({
        t: "text",
        x: a + SELF_W + 6,
        y: y + 4,
        text,
        size: FIG_FONT.label - 1,
        baseline: "middle",
        key: `s${k}`,
      });
      right = Math.max(right, a + SELF_W + 10 + measure(text, FIG_FONT.label - 1));
      y += ROW_H + 8;
      continue;
    }
    rows.push({
      t: "line",
      x1: a,
      y1: y,
      x2: b + (b > a ? -2 : 2),
      y2: y,
      stroke,
      width: it.tone === "accent" ? 2.2 : 1.6,
      dashed: it.dashed,
      arrow: "end",
      key: `s${k}`,
    });
    rows.push({
      t: "text",
      x: (a + b) / 2,
      y: y - 4,
      text,
      size: FIG_FONT.label - 1,
      anchor: "middle",
      baseline: "bottom",
      color: it.dashed ? "soft" : "ink",
      key: `s${k}`,
    });
    y += ROW_H;
  }
  const bottom = y - 10;

  spec.actors.forEach((actor, i) => {
    const cx = xs[i]!;
    const w = boxW[i]!;
    prims.push({
      t: "line",
      x1: cx,
      y1: top + HEAD_H,
      x2: cx,
      y2: bottom,
      stroke: "muted",
      dashed: true,
      width: 1.3,
      key: actor.id,
    });
    if (actor.person) {
      prims.push({ t: "circle", cx, cy: top + 7, r: 7, stroke: "ink" });
      prims.push({
        t: "line",
        x1: cx,
        y1: top + 14,
        x2: cx,
        y2: top + 24,
        stroke: "ink",
        width: 1.6,
      });
      prims.push({
        t: "line",
        x1: cx - 9,
        y1: top + 18,
        x2: cx + 9,
        y2: top + 18,
        stroke: "ink",
        width: 1.6,
      });
      prims.push({
        t: "text",
        x: cx,
        y: top + 26,
        text: actor.label,
        size: FIG_FONT.label,
        anchor: "middle",
        baseline: "top",
        weight: 700,
        key: actor.id,
      });
    } else {
      prims.push({
        t: "rect",
        x: round1(cx - w / 2),
        y: top,
        w: round1(w),
        h: HEAD_H - 4,
        fill: "card",
        stroke: "ink",
        width: 1.6,
        key: actor.id,
      });
      prims.push({
        t: "text",
        x: cx,
        y: top + (HEAD_H - 4) / 2,
        text: actor.label,
        size: FIG_FONT.label,
        anchor: "middle",
        baseline: "middle",
        weight: 700,
        key: actor.id,
      });
    }
  });
  prims.push(...rows);
  const leftEdge = Math.min(
    0,
    ...prims.filter((p) => p.t === "rect").map((p) => (p as { x: number }).x),
  );
  const width = right - leftEdge + 6;
  const out = leftEdge < 0 ? prims.map((p) => shiftX(p, -leftEdge)) : prims;
  return { width: Math.ceil(width), height: Math.ceil(bottom + 6), prims: out };
}

function shiftX(p: Primitive, dx: number): Primitive {
  switch (p.t) {
    case "rect":
      return { ...p, x: p.x + dx };
    case "line":
      return { ...p, x1: p.x1 + dx, x2: p.x2 + dx };
    case "poly":
    case "area":
      return { ...p, points: p.points.map(([x, y]) => [x + dx, y] as [number, number]) };
    case "circle":
    case "ellipse":
    case "wedge":
      return { ...p, cx: p.cx + dx };
    case "text":
    case "icon":
      return { ...p, x: p.x + dx };
  }
}

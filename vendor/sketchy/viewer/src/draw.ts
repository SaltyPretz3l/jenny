import rough from "roughjs";
import type { RoughSVG } from "roughjs/bin/svg.js";
import type { Options } from "roughjs/bin/core.js";
import type { Point } from "../../src/scene/laid-out.js";
import { FONT_FAMILY } from "../../src/style/metrics.js";
import { lineTops } from "../../src/layout/text.js";
import { layoutLabel } from "../../src/math/inline.js";
import { INK } from "./palette.js";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Stable seed per element so a scene looks identical on every render. */
export function seedFor(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483647 || 1;
}

export type Pen = {
  rc: RoughSVG;
  base: Options;
};

export function createPen(svg: SVGSVGElement): Pen {
  return {
    rc: rough.svg(svg),
    base: { roughness: 1.05, bowing: 0.9, stroke: INK, strokeWidth: 1.6, preserveVertices: false },
  };
}

export function opts(pen: Pen, id: string, extra: Options = {}): Options {
  return { ...pen.base, seed: seedFor(id), ...extra };
}

export function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | undefined> = {},
  children: Node[] = [],
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) node.setAttribute(key, String(value));
  }
  for (const child of children) node.appendChild(child);
  return node;
}

export type TextOptions = {
  x: number;
  y: number;
  lines: string[];
  size: number;
  color?: string;
  anchor?: "start" | "middle" | "end";
  weight?: number;
  /** Maximum width; the viewer shrinks text that overflows. */
  fit?: number;
};

export const FONT_STACK = `${FONT_FAMILY}, "Comic Sans MS", cursive`;

/**
 * Multi-line text whose first baseline sits one line below `y`. Lines with
 * $math$ are typeset; the result is then a group instead of one text element.
 */
export function text(o: TextOptions): SVGTextElement | SVGGElement {
  const lh = Math.round(o.size * 1.3);
  const tops = lineTops(o.lines, o.size);
  const plain = (lines: { line: string; top: number }[]) => {
    const node = el("text", {
      x: o.x,
      y: o.y,
      "font-family": FONT_STACK,
      "font-size": o.size,
      "font-weight": o.weight,
      fill: o.color ?? INK,
      "text-anchor": o.anchor ?? "start",
      "data-fit": o.fit,
    });
    for (const { line, top } of lines) {
      const span = el("tspan", { x: o.x, y: o.y + top + lh * 0.74 });
      span.textContent = line;
      node.appendChild(span);
    }
    return node;
  };
  const rows = o.lines.map((line, i) => ({ line, top: tops[i]! }));
  if (!o.lines.some((l) => l.includes("$"))) return plain(rows);
  const group = el("g", { class: "rich-text" });
  for (const row of rows) {
    if (!row.line.includes("$")) {
      group.appendChild(plain([row]));
      continue;
    }
    group.appendChild(
      mathLine({
        x: o.x,
        baseline: o.y + row.top + lh * 0.74,
        text: row.line,
        size: o.size,
        color: o.color ?? INK,
        anchor: o.anchor ?? "start",
        weight: o.weight,
      }),
    );
  }
  return group;
}

/** One line of text and typeset formulas, positioned by its baseline. */
export function mathLine(o: {
  x: number;
  baseline: number;
  text: string;
  size: number;
  color: string;
  anchor: "start" | "middle" | "end";
  weight?: number;
}): SVGGElement {
  const { runs, width } = layoutLabel(o.text, o.size);
  const x0 = o.anchor === "middle" ? o.x - width / 2 : o.anchor === "end" ? o.x - width : o.x;
  const g = el("g", { class: "math" });
  const glyph = (x: number, y: number, content: string, size: number) => {
    const t = el("text", {
      x: round2(x),
      y: round2(y),
      "font-family": FONT_STACK,
      "font-size": round2(size),
      "font-weight": o.weight,
      fill: o.color,
    });
    t.textContent = content;
    g.appendChild(t);
  };
  for (const run of runs) {
    if (run.k === "text") {
      if (run.text.trim()) glyph(x0 + run.x, o.baseline, run.text, o.size);
      continue;
    }
    for (const item of run.box.items) {
      const bx = x0 + run.x;
      if (item.k === "glyph") glyph(bx + item.x, o.baseline + item.y, item.text, item.size);
      else if (item.k === "line")
        g.appendChild(
          el("line", {
            x1: round2(bx + item.x1),
            y1: round2(o.baseline + item.y1),
            x2: round2(bx + item.x2),
            y2: round2(o.baseline + item.y2),
            stroke: o.color,
            "stroke-width": item.width,
            "stroke-linecap": "round",
          }),
        );
      else
        g.appendChild(
          el("polyline", {
            points: item.points
              .map(([px, py]) => `${round2(bx + px)},${round2(o.baseline + py)}`)
              .join(" "),
            fill: "none",
            stroke: o.color,
            "stroke-width": item.width,
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
          }),
        );
    }
  }
  return g;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Orthogonal polyline with softened corners, as a path for rough.js. */
export function roundedPath(points: Point[], radius = 10): string {
  if (points.length < 2) return "";
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const r = Math.min(radius, dist(prev, cur) / 2, dist(cur, next) / 2);
    const a = toward(cur, prev, r);
    const b = toward(cur, next, r);
    d += ` L ${a.x} ${a.y} Q ${cur.x} ${cur.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function toward(from: Point, to: Point, length: number): Point {
  const d = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) / d) * length, y: from.y + ((to.y - from.y) / d) * length };
}

/** The two barbs of an open arrowhead pointing from `from` to `tip`. */
export function arrowHead(from: Point, tip: Point, size = 13): [Point, Point, Point] {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const spread = 0.45;
  return [
    { x: tip.x - size * Math.cos(angle - spread), y: tip.y - size * Math.sin(angle - spread) },
    tip,
    { x: tip.x - size * Math.cos(angle + spread), y: tip.y - size * Math.sin(angle + spread) },
  ];
}

export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return `M ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} H ${x + r} Q ${x} ${y + h} ${x} ${y + h - r} V ${y + r} Q ${x} ${y} ${x + r} ${y} Z`;
}

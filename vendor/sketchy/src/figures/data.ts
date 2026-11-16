/**
 * Data structures: arrays with indices and pointers, linked lists, stacks,
 * queues and trees. Steps may replace the contents or move pointers; equal
 * values keep a move id so the viewer can animate swaps and pushes.
 */
import { FIG_FONT, measure, round1, titlePrims } from "./common.js";
import type {
  DataSpec,
  FigureLayout,
  FigureState,
  Primitive,
  TreeNode,
  TreeSpec,
} from "./types.js";

/** "[5, 2, 8]", "5 2 8" or "Ann, Bob Smith" → values. Commas win over spaces. */
export function parseValues(text: string): string[] {
  const inner = text
    .trim()
    .replace(/^\[|\]$/g, "")
    .trim();
  if (!inner) return [];
  return (inner.includes(",") ? inner.split(",") : inner.split(/\s+/))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Tree notation: "8(3(1,6),10(,14))". A value, then its children in
 * parentheses; an empty slot keeps a binary tree's left/right placement.
 */
export function parseTree(text: string): TreeNode | null {
  let pos = 0;
  const src = text.trim();
  const node = (): TreeNode | null => {
    let value = "";
    while (pos < src.length && !"(),".includes(src[pos]!)) value += src[pos++];
    value = value.trim();
    const children: (TreeNode | null)[] = [];
    if (src[pos] === "(") {
      pos++;
      for (;;) {
        children.push(node());
        if (src[pos] === ",") {
          pos++;
          continue;
        }
        if (src[pos] === ")") {
          pos++;
          break;
        }
        throw new Error(`Unbalanced parentheses in tree "${text}".`);
      }
    }
    if (!value) return children.some(Boolean) ? { value: "?", children } : null;
    return { value, children };
  };
  const root = node();
  if (pos < src.length) throw new Error(`Unexpected "${src.slice(pos)}" in tree "${text}".`);
  return root;
}

/** Move ids by value and occurrence: the second "5" stays the second "5". */
function moveIds(id: string, values: string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((v) => {
    const n = (seen.get(v) ?? 0) + 1;
    seen.set(v, n);
    return `${id}:${v}#${n}`;
  });
}

const CELL_H = 44;

export function layoutData(
  id: string,
  spec: DataSpec,
  title: string | undefined,
  state: FigureState,
): FigureLayout {
  const values = state[id] !== undefined ? parseValues(state[id]!) : spec.values;
  const pointers = spec.pointers.map((p) => {
    const raw = state[p.name];
    const at = raw !== undefined && /^-?\d+$/.test(raw.trim()) ? Number(raw) : p.at;
    return { name: p.name, at };
  });
  const prims: Primitive[] = [];
  const top = titlePrims(title, 0, prims);
  const moves = moveIds(id, values);
  const cellW = Math.max(46, ...values.map((v) => measure(v, FIG_FONT.value) + 22));
  const cell = (
    x: number,
    y: number,
    w: number,
    h: number,
    i: number,
    extra: Partial<Primitive> = {},
  ) => {
    prims.push({
      t: "rect",
      x: round1(x),
      y: round1(y),
      w: round1(w),
      h,
      fill: "card",
      stroke: "ink",
      width: 1.6,
      key: `${id}[${i}]`,
      move: moves[i],
      ...extra,
    } as Primitive);
    prims.push({
      t: "text",
      x: round1(x + w / 2),
      y: round1(y + h / 2),
      text: values[i]!,
      size: FIG_FONT.value,
      anchor: "middle",
      baseline: "middle",
      key: `${id}[${i}]`,
      move: moves[i],
    });
  };
  let width = 0;
  let height = 0;

  switch (spec.kind) {
    case "array":
    case "queue": {
      const y = top + (spec.kind === "queue" ? 22 : 0);
      values.forEach((_, i) => {
        cell(i * cellW, y, cellW, CELL_H, i);
        if (spec.kind === "array")
          prims.push({
            t: "text",
            x: round1(i * cellW + cellW / 2),
            y: y + CELL_H + 4,
            text: String(i),
            size: FIG_FONT.small,
            color: "soft",
            anchor: "middle",
            baseline: "top",
          });
      });
      width = Math.max(cellW, values.length * cellW);
      height = y + CELL_H + (spec.kind === "array" ? 20 : 4);
      if (spec.kind === "queue" && values.length) {
        const last = values.length * cellW;
        prims.push({
          t: "text",
          x: cellW / 2,
          y: top + 14,
          text: "front",
          size: FIG_FONT.small,
          color: "blue",
          anchor: "middle",
          baseline: "bottom",
        });
        prims.push({
          t: "text",
          x: last - cellW / 2,
          y: top + 14,
          text: "back",
          size: FIG_FONT.small,
          color: "blue",
          anchor: "middle",
          baseline: "bottom",
        });
        prims.push({
          t: "line",
          x1: -34,
          y1: y + CELL_H / 2,
          x2: -6,
          y2: y + CELL_H / 2,
          stroke: "blue",
          width: 1.6,
          arrow: "end",
        });
        prims.push({
          t: "line",
          x1: last + 6,
          y1: y + CELL_H / 2,
          x2: last + 34,
          y2: y + CELL_H / 2,
          stroke: "blue",
          width: 1.6,
          arrow: "end",
        });
      }
      // Pointers below their cell, stacked when several share one.
      const stacked = new Map<number, number>();
      for (const p of pointers) {
        const k = stacked.get(p.at) ?? 0;
        stacked.set(p.at, k + 1);
        const cx = round1(p.at * cellW + cellW / 2);
        const y0 = height + 4 + k * 34;
        prims.push({
          t: "line",
          x1: cx,
          y1: y0 + 22,
          x2: cx,
          y2: y0,
          stroke: "red",
          width: 1.8,
          arrow: "end",
          move: `${id}:ptr:${p.name}`,
          key: p.name,
        });
        prims.push({
          t: "text",
          x: cx,
          y: y0 + 22,
          text: p.name,
          size: FIG_FONT.label,
          color: "red",
          anchor: "middle",
          baseline: "top",
          weight: 700,
          move: `${id}:ptr:${p.name}`,
          key: p.name,
        });
        height = Math.max(height, y0 + 44);
      }
      break;
    }
    case "list": {
      const gap = 40;
      const ptrW = 22;
      const w = cellW + ptrW;
      prims.push({
        t: "text",
        x: 0,
        y: top,
        text: "head",
        size: FIG_FONT.small,
        color: "blue",
        baseline: "top",
      });
      const y = top + 20;
      values.forEach((_, i) => {
        const x = i * (w + gap);
        cell(x, y, cellW, CELL_H, i);
        prims.push({
          t: "rect",
          x: round1(x + cellW),
          y,
          w: ptrW,
          h: CELL_H,
          fill: "card",
          stroke: "ink",
          width: 1.6,
          key: `${id}[${i}]`,
          move: moves[i],
        });
        prims.push({
          t: "circle",
          cx: round1(x + cellW + ptrW / 2),
          cy: y + CELL_H / 2,
          r: 3,
          fill: "ink",
          stroke: "none",
          move: moves[i],
        });
        const from = x + cellW + ptrW / 2;
        if (i < values.length - 1)
          prims.push({
            t: "line",
            x1: round1(from),
            y1: y + CELL_H / 2,
            x2: round1(x + w + gap - 2),
            y2: y + CELL_H / 2,
            stroke: "ink",
            width: 1.6,
            arrow: "end",
          });
      });
      const end = values.length * (w + gap) - gap;
      if (values.length) {
        prims.push({
          t: "line",
          x1: round1(end - ptrW / 2),
          y1: y + CELL_H / 2,
          x2: end + 28,
          y2: y + CELL_H / 2,
          stroke: "muted",
          width: 1.4,
          arrow: "end",
        });
        prims.push({
          t: "text",
          x: end + 32,
          y: y + CELL_H / 2,
          text: "null",
          size: FIG_FONT.small + 1,
          color: "soft",
          baseline: "middle",
        });
      }
      width = Math.max(w, end + 70);
      height = y + CELL_H + 6;
      for (const p of pointers) {
        const cx = round1(p.at * (w + gap) + cellW / 2);
        prims.push({
          t: "line",
          x1: cx,
          y1: height + 22,
          x2: cx,
          y2: height + 2,
          stroke: "red",
          width: 1.8,
          arrow: "end",
          move: `${id}:ptr:${p.name}`,
          key: p.name,
        });
        prims.push({
          t: "text",
          x: cx,
          y: height + 22,
          text: p.name,
          size: FIG_FONT.label,
          color: "red",
          anchor: "middle",
          baseline: "top",
          weight: 700,
          move: `${id}:ptr:${p.name}`,
          key: p.name,
        });
      }
      if (pointers.length) height += 46;
      break;
    }
    case "stack": {
      const w = Math.max(96, cellW + 30);
      const h = 36;
      const n = values.length;
      const y0 = top + 4;
      // The last value is the top of the stack and sits highest.
      for (let i = n - 1, row = 0; i >= 0; i--, row++) {
        const y = y0 + row * h;
        prims.push({
          t: "rect",
          x: 64,
          y,
          w,
          h,
          fill: i === n - 1 ? "accent" : "card",
          hatch: i === n - 1,
          stroke: "ink",
          width: 1.6,
          key: `${id}[${i}]`,
          move: moves[i],
        });
        prims.push({
          t: "text",
          x: 64 + w / 2,
          y: y + h / 2,
          text: values[i]!,
          size: FIG_FONT.value,
          anchor: "middle",
          baseline: "middle",
          key: `${id}[${i}]`,
          move: moves[i],
        });
      }
      const bottom = y0 + Math.max(1, n) * h + 4;
      prims.push({
        t: "poly",
        points: [
          [58, y0 - 8],
          [58, bottom],
          [64 + w + 6, bottom],
          [64 + w + 6, y0 - 8],
        ],
        stroke: "ink",
        width: 2,
      });
      if (n) {
        prims.push({
          t: "text",
          x: 0,
          y: y0 + h / 2,
          text: "top",
          size: FIG_FONT.small + 1,
          color: "blue",
          baseline: "middle",
        });
        prims.push({
          t: "line",
          x1: 28,
          y1: y0 + h / 2,
          x2: 56,
          y2: y0 + h / 2,
          stroke: "blue",
          width: 1.6,
          arrow: "end",
        });
      }
      width = 64 + w + 10;
      height = bottom + 4;
      break;
    }
  }
  return { width: Math.ceil(width), height: Math.ceil(height), prims: normalize(prims, width) };
}

/** Moves primitives drawn left of 0 (queue arrows) back into the box. */
function normalize(prims: Primitive[], _width: number): Primitive[] {
  const minX = Math.min(0, ...prims.map((p) => (p.t === "line" ? Math.min(p.x1, p.x2) : 0)));
  if (minX >= 0) return prims;
  return prims.map((p) => {
    switch (p.t) {
      case "rect":
        return { ...p, x: p.x - minX };
      case "line":
        return { ...p, x1: p.x1 - minX, x2: p.x2 - minX };
      case "poly":
      case "area":
        return { ...p, points: p.points.map(([x, y]) => [x - minX, y] as [number, number]) };
      case "circle":
      case "ellipse":
      case "wedge":
        return { ...p, cx: p.cx - minX };
      case "text":
      case "icon":
        return { ...p, x: p.x - minX };
    }
  });
}

const NODE_R = 22;
const LEVEL_H = 68;

export function layoutTree(
  id: string,
  spec: TreeSpec,
  title: string | undefined,
  state: FigureState,
): FigureLayout {
  let root = spec.root;
  if (state[id] !== undefined) {
    try {
      root = parseTree(state[id]!);
    } catch {
      // Validated when the scene was built.
    }
  }
  const prims: Primitive[] = [];
  const top = titlePrims(title, 0, prims);
  if (!root) return { width: 60, height: top + 30, prims };
  const r = Math.max(NODE_R, ...collect(root).map((n) => measure(n.value, FIG_FONT.value) / 2 + 9));
  const slot = r * 2 + 16;
  // Leaves (and empty slots) take consecutive columns; parents center over children.
  let next = 0;
  const pos = new Map<TreeNode, { x: number; depth: number }>();
  const place = (node: TreeNode | null, depth: number): number => {
    if (!node) return next++ * slot;
    const kids = node.children;
    if (!kids.length || kids.every((k) => k === null)) {
      const x = next++ * slot;
      pos.set(node, { x, depth });
      return x;
    }
    // A single child of a binary node still leans left or right.
    const padded = kids.length === 1 ? [kids[0]!, null] : kids;
    const xs = padded.map((k) => place(k, depth + 1));
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    pos.set(node, { x, depth });
    return x;
  };
  place(root, 0);
  const minX = Math.min(...[...pos.values()].map((p) => p.x));
  const X = (x: number) => round1(x - minX + r + 2);
  const Y = (d: number) => round1(top + r + 2 + d * LEVEL_H);
  const seen = new Map<string, number>();
  const moveOf = (v: string) => {
    const n = (seen.get(v) ?? 0) + 1;
    seen.set(v, n);
    return `${id}:${v}#${n}`;
  };
  const edges: Primitive[] = [];
  const nodes: Primitive[] = [];
  const walk = (node: TreeNode) => {
    const p = pos.get(node)!;
    const move = moveOf(node.value);
    for (const kid of node.children) {
      if (!kid) continue;
      const q = pos.get(kid)!;
      const dx = X(q.x) - X(p.x);
      const dy = Y(q.depth) - Y(p.depth);
      const len = Math.hypot(dx, dy) || 1;
      edges.push({
        t: "line",
        x1: round1(X(p.x) + (dx / len) * r),
        y1: round1(Y(p.depth) + (dy / len) * r),
        x2: round1(X(q.x) - (dx / len) * r),
        y2: round1(Y(q.depth) - (dy / len) * r),
        stroke: "ink",
        width: 1.6,
        key: `${id}[${kid.value}]`,
      });
      walk(kid);
    }
    nodes.push({
      t: "circle",
      cx: X(p.x),
      cy: Y(p.depth),
      r,
      fill: "card",
      stroke: "ink",
      key: `${id}[${node.value}]`,
      move,
    });
    nodes.push({
      t: "text",
      x: X(p.x),
      y: Y(p.depth),
      text: node.value,
      size: FIG_FONT.value,
      anchor: "middle",
      baseline: "middle",
      key: `${id}[${node.value}]`,
      move,
    });
  };
  walk(root);
  prims.push(...edges, ...nodes);
  const maxDepth = Math.max(...[...pos.values()].map((p) => p.depth));
  const maxX = Math.max(...[...pos.values()].map((p) => X(p.x)));
  return { width: Math.ceil(maxX + r + 4), height: Math.ceil(Y(maxDepth) + r + 4), prims };
}

function collect(node: TreeNode): TreeNode[] {
  return [node, ...node.children.flatMap((c) => (c ? collect(c) : []))];
}

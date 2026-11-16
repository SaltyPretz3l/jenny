import { lineHeight, measureText } from "../layout/text.js";
import { FIG_FONT, SERIES, bounds, measure, shift, titlePrims } from "./common.js";
import type {
  FigureLayout,
  FigureState,
  Ink,
  Primitive,
  TemplateItem,
  TemplateKind,
  TemplateSpec,
} from "./types.js";

/**
 * Layout templates: familiar explanation shapes where Claude only names the
 * contents. Steps can circle an item as "t[2]" and reveal items with "t=2".
 */

export const TEMPLATE_KINDS: TemplateKind[] = [
  "timeline",
  "cycle",
  "pyramid",
  "funnel",
  "venn",
  "matrix",
  "mindmap",
];

export const emptyTemplate = (layout: TemplateKind): TemplateSpec => ({
  kind: "template",
  layout,
  items: [],
  sets: [],
  cols: [],
});

const TONE = /(?:^|\s)!(accent|muted)(?=\s|$)/;

/** One line of a template block; false when the line belongs to the scene instead. */
export function parseTemplateLine(
  spec: TemplateSpec,
  line: string,
  fail: (why: string) => never,
): boolean {
  const at = line.indexOf(" ~ ");
  let main = at < 0 ? line : line.slice(0, at);
  const detail = at < 0 ? undefined : line.slice(at + 3).trim() || undefined;
  const toneMatch = main.match(TONE);
  const tone = toneMatch?.[1] as "accent" | "muted" | undefined;
  if (toneMatch) main = main.replace(TONE, " ");
  main = main.trim();
  const base: Pick<TemplateItem, "detail" | "tone"> = {
    ...(detail ? { detail } : {}),
    ...(tone ? { tone } : {}),
  };
  const columns = main.split("|").map((part) => part.trim());
  switch (spec.layout) {
    case "timeline":
      spec.items.push(
        columns.length > 1
          ? { label: columns.slice(1).join(" | "), when: columns[0], ...base }
          : { label: main, ...base },
      );
      return true;
    case "venn": {
      const set = main.match(/^set\s+([A-Za-z0-9_-]+)\s+(.+)$/);
      if (set) {
        spec.sets.push({ id: set[1]!, label: set[2]! });
        return true;
      }
      if (columns.length < 2) return fail("expected: <set>[,<set>] | <text>, or set <id> <label>");
      spec.items.push({
        label: columns.slice(1).join(" | "),
        sets: columns[0]!
          .split(/[,&+]/)
          .map((s) => s.trim())
          .filter(Boolean),
        ...base,
      });
      return true;
    }
    case "matrix": {
      const head = main.match(/^cols?\s+(.+)$/);
      if (head) {
        spec.cols = head[1]!.split(/\s*[|,]\s*/).filter(Boolean);
        return true;
      }
      if (columns.length < 2) return fail("expected: <row label> | <cell> | <cell>");
      spec.items.push({ label: columns[0]!, cells: columns.slice(1), ...base });
      return true;
    }
    case "mindmap": {
      const dashes = main.match(/^(-+)\s*(.+)$/);
      spec.items.push({
        label: dashes ? dashes[2]! : main,
        depth: dashes ? dashes[1]!.length : spec.items.length ? 1 : 0,
        ...base,
      });
      return true;
    }
    default:
      spec.items.push({ label: main, ...base });
      return true;
  }
}

type Out = { prims: Primitive[]; item: (index: number) => Pick<Primitive, "key" | "move"> };

const LABEL = FIG_FONT.label;
const SMALL = FIG_FONT.small + 1;

function textBlock(
  out: Primitive[],
  mark: Pick<Primitive, "key" | "move">,
  x: number,
  y: number,
  text: string,
  size: number,
  maxWidth: number,
  style: { color?: Ink; weight?: number; anchor?: "start" | "middle" | "end" } = {},
): number {
  const { lines } = measureText(text, size, maxWidth);
  lines.forEach((line, i) =>
    out.push({
      t: "text",
      x,
      y: y + i * lineHeight(size),
      text: line,
      size,
      baseline: "top",
      anchor: style.anchor ?? "middle",
      color: style.color,
      weight: style.weight,
      ...mark,
    }),
  );
  return lines.length * lineHeight(size);
}

const heightOf = (text: string, size: number, maxWidth: number) =>
  measureText(text, size, maxWidth).lines.length * lineHeight(size);

function timeline(spec: TemplateSpec, { prims, item }: Out): void {
  const cardWidth = 190;
  const slot = 130;
  const blockHeight = (it: TemplateItem) =>
    (it.when ? lineHeight(FIG_FONT.value) + 2 : 0) +
    heightOf(it.label, LABEL, cardWidth) +
    (it.detail ? heightOf(it.detail, SMALL, cardWidth) + 2 : 0);
  const stem = 26;
  const above = Math.max(0, ...spec.items.filter((_, i) => i % 2 === 0).map(blockHeight));
  const axis = above + stem;
  const width = slot * spec.items.length + 50;
  prims.push({ t: "line", x1: -30, y1: axis, x2: width, y2: axis, width: 2, arrow: "end" });
  spec.items.forEach((it, i) => {
    const x = 40 + i * slot;
    const up = i % 2 === 0;
    const mark = item(i);
    const h = blockHeight(it);
    prims.push({
      t: "line",
      x1: x,
      y1: axis,
      x2: x,
      y2: up ? axis - stem + 4 : axis + stem - 4,
      stroke: "soft",
      width: 1.2,
      ...mark,
    });
    prims.push({
      t: "circle",
      cx: x,
      cy: axis,
      r: 6,
      fill: it.tone === "accent" ? "accent" : "card",
      ...mark,
    });
    let y = up ? axis - stem - h : axis + stem;
    if (it.when) {
      prims.push({
        t: "text",
        x,
        y,
        text: it.when,
        size: FIG_FONT.value,
        baseline: "top",
        anchor: "middle",
        weight: 700,
        ...mark,
      });
      y += lineHeight(FIG_FONT.value) + 2;
    }
    y += textBlock(prims, mark, x, y, it.label, LABEL, cardWidth, {
      color: it.tone === "muted" ? "muted" : undefined,
    });
    if (it.detail) textBlock(prims, mark, x, y + 2, it.detail, SMALL, cardWidth, { color: "soft" });
  });
}

function cycle(spec: TemplateSpec, { prims, item }: Out): void {
  const n = spec.items.length;
  const boxWidth = 150;
  const radius = Math.max(135, (n * (boxWidth + 26)) / (2 * Math.PI));
  const sizes = spec.items.map((it) => ({
    h:
      heightOf(it.label, LABEL, boxWidth - 18) +
      (it.detail ? heightOf(it.detail, SMALL, boxWidth - 18) + 2 : 0) +
      20,
  }));
  const angle = (i: number) => (i / n) * Math.PI * 2 - Math.PI / 2;
  // How far along the circle a box reaches, so arrows start and end at its edge.
  const reach = (i: number) => {
    const a = angle(i);
    const halfW = boxWidth / 2;
    const halfH = sizes[i]!.h / 2;
    const extent = Math.abs(Math.sin(a)) * halfW + Math.abs(Math.cos(a)) * halfH;
    return (extent + 10) / radius;
  };
  spec.items.forEach((_, i) => {
    const from = angle(i) + reach(i);
    const to = angle(i + 1) - reach((i + 1) % n);
    if (to <= from) return;
    const steps = Math.max(5, Math.ceil(((to - from) * radius) / 10));
    prims.push({
      t: "poly",
      points: Array.from({ length: steps + 1 }, (_, k) => {
        const a = from + ((to - from) * k) / steps;
        return [Math.cos(a) * radius, Math.sin(a) * radius] as [number, number];
      }),
      width: 2,
      arrow: "end",
      rough: 0.5,
      ...item(i),
    });
  });
  spec.items.forEach((it, i) => {
    const mark = item(i);
    const cx = Math.cos(angle(i)) * radius;
    const cy = Math.sin(angle(i)) * radius;
    const h = sizes[i]!.h;
    prims.push({
      t: "rect",
      x: cx - boxWidth / 2,
      y: cy - h / 2,
      w: boxWidth,
      h,
      fill: it.tone === "accent" ? "accent" : "card",
      ...mark,
    });
    const used = textBlock(prims, mark, cx, cy - h / 2 + 10, it.label, LABEL, boxWidth - 18, {
      color: it.tone === "muted" ? "muted" : undefined,
    });
    if (it.detail)
      textBlock(prims, mark, cx, cy - h / 2 + 12 + used, it.detail, SMALL, boxWidth - 18, {
        color: "soft",
      });
  });
}

function stacked(spec: TemplateSpec, { prims, item }: Out, inverted: boolean): void {
  const n = spec.items.length;
  const width = Math.max(380, 110 * n);
  const rowHeight = 62;
  const gap = 5;
  const half = (row: number) => {
    // Rows never close to a point, so the narrowest still holds a word.
    const share = (row + 0.5) / (n + 0.5);
    return ((inverted ? 1 - share + 0.5 / (n + 0.5) : share) * width) / 2;
  };
  spec.items.forEach((it, i) => {
    const mark = item(i);
    const y = i * (rowHeight + gap);
    const top = half(i);
    const bottom = half(i + 1);
    prims.push({
      t: "poly",
      points: [
        [-top, y],
        [top, y],
        [bottom, y + rowHeight],
        [-bottom, y + rowHeight],
      ],
      closed: true,
      fill:
        it.tone === "accent" ? "accent" : it.tone === "muted" ? "grid" : SERIES[i % SERIES.length],
      rough: 1,
      width: 1.6,
      ...mark,
    });
    const room = Math.max(70, 2 * Math.min(top, bottom) - 16);
    const h = heightOf(it.label, LABEL, room);
    textBlock(prims, mark, 0, y + (rowHeight - h) / 2, it.label, LABEL, room, { weight: 700 });
    if (it.detail) {
      const edge = (top + bottom) / 2;
      const textX = width / 2 + 42;
      const midY = y + rowHeight / 2;
      prims.push({
        t: "line",
        x1: edge + 4,
        y1: midY,
        x2: textX - 6,
        y2: midY,
        stroke: "soft",
        width: 1,
        ...mark,
      });
      const dh = heightOf(it.detail, SMALL, 190);
      textBlock(prims, mark, textX, midY - dh / 2, it.detail, SMALL, 190, {
        anchor: "start",
        color: "soft",
      });
    }
  });
}

function venn(spec: TemplateSpec, { prims, item }: Out): void {
  const r = 135;
  const d = r * 1.15;
  const three = spec.sets.length === 3;
  const centers: [number, number][] = three
    ? [
        [-d / 2, -d * 0.29],
        [d / 2, -d * 0.29],
        [0, d * 0.58],
      ]
    : [
        [-d / 2, 0],
        [d / 2, 0],
      ];
  spec.sets.forEach((set, i) => {
    const [cx, cy] = centers[i]!;
    prims.push({
      t: "area",
      points: Array.from({ length: 60 }, (_, k) => {
        const a = (k / 60) * Math.PI * 2;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as [number, number];
      }),
      fill: SERIES[i % SERIES.length]!,
      opacity: 0.35,
    });
    prims.push({ t: "ellipse", cx, cy, rx: r, ry: r, width: 1.8 });
    const below = three && i === 2;
    prims.push({
      t: "text",
      x: cx + (three ? (i === 2 ? 0 : i ? 60 : -60) : i ? 40 : -40),
      y: below ? cy + r + 8 : cy - r - 8,
      text: set.label,
      size: FIG_FONT.value,
      weight: 700,
      anchor: "middle",
      baseline: below ? "top" : "bottom",
    });
  });

  /** Moves a region's text away from the circles it is not part of. */
  const regionCenter = (members: number[]): [number, number] => {
    const mx = members.reduce((sum, m) => sum + centers[m]![0], 0) / members.length;
    const my = members.reduce((sum, m) => sum + centers[m]![1], 0) / members.length;
    if (members.length === spec.sets.length) return [mx, my];
    const all: [number, number] = [
      centers.reduce((sum, c) => sum + c[0], 0) / centers.length,
      centers.reduce((sum, c) => sum + c[1], 0) / centers.length,
    ];
    const dx = mx - all[0];
    const dy = my - all[1];
    const length = Math.hypot(dx, dy) || 1;
    const push = members.length === 1 ? (three ? 48 : 66) : 34;
    return [mx + (dx / length) * push, my + (dy / length) * push];
  };

  const regions = new Map<string, number[]>();
  spec.items.forEach((it, i) => {
    const members = (it.sets ?? []).map((id) => spec.sets.findIndex((s) => s.id === id)).sort();
    const key = members.join(",");
    regions.set(key, [...(regions.get(key) ?? []), i]);
  });
  for (const [key, indexes] of regions) {
    const members = key.split(",").map(Number);
    const [cx, cy] = regionCenter(members);
    const room = members.length === 1 ? 112 : three && members.length === 2 ? 66 : 84;
    const total = indexes.reduce(
      (sum, i) => sum + heightOf(spec.items[i]!.label, SMALL, room) + 3,
      0,
    );
    let y = cy - total / 2;
    for (const i of indexes) {
      const it = spec.items[i]!;
      y +=
        textBlock(prims, item(i), cx, y, it.label, SMALL, room, {
          weight: it.tone === "accent" ? 700 : undefined,
          color: it.tone === "muted" ? "muted" : undefined,
        }) + 3;
    }
  }
}

function matrix(spec: TemplateSpec, { prims, item }: Out): void {
  const columnCount = Math.max(
    spec.cols.length,
    1 + Math.max(0, ...spec.items.map((it) => it.cells?.length ?? 0)),
  );
  const maxWidth = 170;
  const pad = 12;
  // A header row may leave out the corner above the row labels.
  const hasCorner = spec.cols.length === columnCount;
  const header = hasCorner ? spec.cols : ["", ...spec.cols];
  const cellsOf = (it: TemplateItem) => [it.label, ...(it.cells ?? [])];
  const widths = Array.from(
    { length: columnCount },
    (_, c) =>
      Math.max(
        70,
        ...[
          ...(spec.cols.length ? [header[c] ?? ""] : []),
          ...spec.items.map((it) => cellsOf(it)[c] ?? ""),
        ].map((text) => Math.min(maxWidth, measure(text, LABEL))),
      ) +
      pad * 2,
  );
  const xs = widths.reduce<number[]>((list, w) => [...list, list[list.length - 1]! + w], [0]);
  const total = xs[columnCount]!;
  const rowH = (cells: string[]) =>
    Math.max(...cells.map((text, c) => heightOf(text || " ", LABEL, widths[c]! - pad * 2))) +
    pad * 2 -
    4;
  let y = 0;
  if (spec.cols.length) {
    const h = rowH(header);
    header.forEach((text, c) => {
      if (text)
        textBlock(
          prims,
          {},
          xs[c]! + widths[c]! / 2,
          y + pad - 2,
          text,
          LABEL,
          widths[c]! - pad * 2,
          { weight: 700 },
        );
    });
    y += h;
  }
  const lines: number[] = [y];
  spec.items.forEach((it, i) => {
    const mark = item(i);
    const cells = cellsOf(it);
    const h = rowH(cells);
    if (it.tone === "accent")
      prims.push({ t: "rect", x: 0, y, w: total, h, fill: "accent", stroke: "none", ...mark });
    cells.forEach((text, c) => {
      if (c >= columnCount) return;
      textBlock(
        prims,
        mark,
        xs[c]! + widths[c]! / 2,
        y + pad - 2,
        text,
        LABEL,
        widths[c]! - pad * 2,
        {
          weight: c === 0 ? 700 : undefined,
          color: it.tone === "muted" ? "muted" : undefined,
        },
      );
    });
    y += h;
    lines.push(y);
  });
  prims.push({ t: "rect", x: 0, y: 0, w: total, h: y, width: 1.8 });
  for (const lineY of lines.slice(0, -1))
    prims.push({ t: "line", x1: 0, y1: lineY, x2: total, y2: lineY, stroke: "soft", width: 1.2 });
  for (const x of xs.slice(1, -1))
    prims.push({ t: "line", x1: x, y1: 0, x2: x, y2: y, stroke: "soft", width: 1.2 });
}

type Branch = { index: number; item: TemplateItem; children: Branch[]; height: number };

function mindmap(spec: TemplateSpec, { prims, item }: Out): void {
  const rootItem = spec.items[0]!;
  const root: Branch = { index: 0, item: rootItem, children: [], height: 0 };
  const stack: Branch[] = [root];
  spec.items.slice(1).forEach((it, offset) => {
    const depth = Math.max(1, it.depth ?? 1);
    const node: Branch = { index: offset + 1, item: it, children: [], height: 0 };
    while (stack.length > depth) stack.pop();
    stack[stack.length - 1]!.children.push(node);
    stack.push(node);
  });
  const rowGap = 12;
  const measureBranch = (b: Branch): number => {
    const own = lineHeight(LABEL) + (b.item.detail ? lineHeight(SMALL) : 0) + rowGap;
    const below = b.children.reduce((sum, c) => sum + measureBranch(c), 0);
    b.height = Math.max(own, below);
    return b.height;
  };
  root.children.forEach(measureBranch);
  const rx = Math.max(70, measure(rootItem.label, FIG_FONT.value) / 2 + 26);
  const ry = 38;
  const curve = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    stroke: Ink,
    width: number,
  ): [number, number][] => {
    void stroke;
    void width;
    const mid = (x1 + x2) / 2;
    return Array.from({ length: 19 }, (_, k) => {
      const t = k / 18;
      const u = 1 - t;
      return [
        u * u * u * x1 + 3 * u * u * t * mid + 3 * u * t * t * mid + t * t * t * x2,
        u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2,
      ] as [number, number];
    });
  };
  const place = (
    b: Branch,
    side: 1 | -1,
    fromX: number,
    fromY: number,
    top: number,
    color: Ink,
    depth: number,
  ) => {
    const y = top + b.height / 2;
    const x = fromX + side * (depth === 1 ? 62 : 44);
    const mark = item(b.index);
    const width = measure(b.item.label, LABEL);
    const lineWidth = depth === 1 ? 3 : 2;
    prims.push({
      t: "poly",
      points: curve(fromX, fromY, x, y, color, lineWidth),
      stroke: color,
      width: lineWidth,
      rough: 0.5,
      ...mark,
    });
    const endX = x + side * (width + 8);
    prims.push({
      t: "poly",
      points: [
        [x, y],
        [endX, y],
      ],
      stroke: color,
      width: lineWidth,
      rough: 0.6,
      ...mark,
    });
    prims.push({
      t: "text",
      x: x + side * 4,
      y: y - 3,
      text: b.item.label,
      size: LABEL,
      baseline: "bottom",
      anchor: side > 0 ? "start" : "end",
      weight: b.item.tone === "accent" ? 700 : undefined,
      color: b.item.tone === "muted" ? "muted" : undefined,
      ...mark,
    });
    if (b.item.detail)
      prims.push({
        t: "text",
        x: x + side * 4,
        y: y + 2,
        text: b.item.detail,
        size: SMALL - 1,
        baseline: "top",
        anchor: side > 0 ? "start" : "end",
        color: "soft",
        ...mark,
      });
    let childTop = top + (b.height - b.children.reduce((sum, c) => sum + c.height, 0)) / 2;
    for (const child of b.children) {
      place(child, side, endX, y, childTop, color, depth + 1);
      childTop += child.height;
    }
  };
  const sides: Branch[][] = [[], []];
  // Fills the shorter side next, so the two halves balance.
  const heights = [0, 0];
  root.children.forEach((child) => {
    const side = heights[0]! <= heights[1]! ? 0 : 1;
    sides[side]!.push(child);
    heights[side]! += child.height;
  });
  sides.forEach((list, s) => {
    const side = s === 0 ? 1 : -1;
    let top = -heights[s]! / 2;
    list.forEach((child, i) => {
      place(
        child,
        side as 1 | -1,
        side * rx * 0.85,
        0,
        top,
        SERIES[(i * 2 + s) % SERIES.length]!,
        1,
      );
      top += child.height;
    });
  });
  const rootMark = item(0);
  prims.push({
    t: "ellipse",
    cx: 0,
    cy: 0,
    rx,
    ry,
    fill: rootItem.tone === "muted" ? "card" : "accent",
    width: 2,
    ...rootMark,
  });
  prims.push({
    t: "text",
    x: 0,
    y: 0,
    text: rootItem.label,
    size: FIG_FONT.value,
    weight: 700,
    anchor: "middle",
    baseline: "middle",
    ...rootMark,
  });
}

export function layoutTemplate(
  id: string,
  spec: TemplateSpec,
  title: string | undefined,
  state: FigureState,
): FigureLayout {
  const prims: Primitive[] = [];
  const out: Out = {
    prims,
    item: (index) => ({ key: `${id}[${index + 1}]`, move: `${id}-${index}` }),
  };
  switch (spec.layout) {
    case "timeline":
      timeline(spec, out);
      break;
    case "cycle":
      cycle(spec, out);
      break;
    case "pyramid":
      stacked(spec, out, false);
      break;
    case "funnel":
      stacked(spec, out, true);
      break;
    case "venn":
      venn(spec, out);
      break;
    case "matrix":
      matrix(spec, out);
      break;
    case "mindmap":
      mindmap(spec, out);
      break;
  }
  const titleOut: Primitive[] = [];
  const titleHeight = titlePrims(title, 0, titleOut);
  // Sized for every item, so revealing items never changes the figure's box.
  const box = bounds(prims);
  const stage = /^\d+$/.test(state[id] ?? "") ? Number(state[id]) : undefined;
  const visible =
    stage === undefined
      ? prims
      : prims.filter((p) => {
          const index = p.key ? Number(/\[(\d+)\]$/.exec(p.key)?.[1]) : 0;
          return index <= stage;
        });
  const titleWidth = title ? measure(title, FIG_FONT.title) : 0;
  return {
    width: Math.ceil(Math.max(box.w, titleWidth)),
    height: Math.ceil(box.h + titleHeight),
    prims: [...titleOut, ...shift(visible, -box.x, titleHeight - box.y)],
  };
}

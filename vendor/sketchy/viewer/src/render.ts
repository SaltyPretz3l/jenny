import type {
  LaidOutEdge,
  LaidOutGroup,
  LaidOutImage,
  LaidOutLabel,
  LaidOutNode,
  LaidOutPart,
  LaidOutScene,
  LaidOutWire,
} from "../../src/scene/laid-out.js";
import { FONT, SPACING } from "../../src/style/metrics.js";
import { WATERMARK } from "./excalidraw.js";
import { FigureView } from "./figures.js";
import {
  arrowHead,
  createPen,
  el,
  opts,
  roundedPath,
  roundedRectPath,
  text,
  type Pen,
} from "./draw.js";
import {
  ANNOTATION,
  CARD,
  GROUP_FILL,
  INK,
  INK_SOFT,
  MUTED,
  PAPER,
  WIRE,
  toneFill,
  toneStroke,
  toneText,
} from "./palette.js";

export type RenderedScene = {
  svg: SVGSVGElement;
  /** Element groups by scene id, for hover, click and step highlighting. */
  elements: Map<string, SVGGElement>;
  overlay: SVGGElement;
  pen: Pen;
  /** Figures repaint themselves for steps and sliders. */
  figures: Map<string, FigureView>;
  /** The step on show; undefined for the whole scene. */
  step?: number;
};

export function renderScene(scene: LaidOutScene, fontCss: string): RenderedScene {
  const svg = el("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: `0 0 ${scene.width} ${scene.height}`,
    width: scene.width,
    height: scene.height,
    class: "sketch",
    role: "img",
    "aria-label": scene.title?.lines.join(" ") ?? "Sketchy drawing",
  });
  const style = el("style");
  style.textContent = fontCss;
  svg.appendChild(el("defs", {}, [style]));
  svg.appendChild(
    el("rect", { x: 0, y: 0, width: scene.width, height: scene.height, fill: PAPER }),
  );

  const pen = createPen(svg);
  const elements = new Map<string, SVGGElement>();
  const layer = (name: string) => svg.appendChild(el("g", { class: `layer-${name}` }));
  const groupsLayer = layer("groups");
  const edgesLayer = layer("edges");
  const nodesLayer = layer("nodes");
  const wiresLayer = layer("wires");
  const labelsLayer = layer("labels");
  const overlay = layer("overlay");

  const add = (parent: SVGGElement, id: string, kind: string, build: (g: SVGGElement) => void) => {
    const g = el("g", { "data-id": id, "data-kind": kind, class: "element" });
    build(g);
    parent.appendChild(g);
    elements.set(id, g);
  };

  if (scene.title) drawTitle(svg, scene);

  for (const group of scene.groups)
    add(groupsLayer, group.id, "group", (g) => drawGroup(g, pen, group));
  for (const edge of scene.edges) add(edgesLayer, edge.id, "edge", (g) => drawEdge(g, pen, edge));
  for (const node of scene.nodes) add(nodesLayer, node.id, "node", (g) => drawNode(g, pen, node));
  for (const part of scene.parts) add(nodesLayer, part.id, "part", (g) => drawPart(g, pen, part));
  for (const image of scene.images)
    add(nodesLayer, image.id, "image", (g) => drawImage(g, pen, image));
  const figures = new Map<string, FigureView>();
  for (const fig of scene.figures ?? [])
    add(nodesLayer, fig.id, "figure", (g) => figures.set(fig.id, new FigureView(fig, g, pen)));
  for (const wire of scene.wires) add(wiresLayer, wire.id, "wire", (g) => drawWire(g, pen, wire));
  for (const label of scene.labels)
    add(labelsLayer, label.id, "label", (g) => drawLabel(g, pen, label));
  drawWatermark(svg, scene);

  return { svg, elements, overlay, pen, figures };
}

/**
 * A faint signature in the bottom margin, kept in exports. Hosts often show
 * wide drawings at about 60 %, so it is sized to stay readable there.
 */
function drawWatermark(svg: SVGSVGElement, scene: LaidOutScene): void {
  const mark = text({
    x: scene.width - 14,
    y: scene.height - 26,
    lines: [WATERMARK],
    size: 18,
    color: INK,
    anchor: "end",
  });
  mark.setAttribute("class", "watermark");
  mark.setAttribute("opacity", "0.38");
  mark.setAttribute("pointer-events", "none");
  svg.appendChild(mark);
}

function drawTitle(svg: SVGSVGElement, scene: LaidOutScene): void {
  const title = scene.title!;
  const g = el("g", { class: "title" });
  g.appendChild(
    text({ x: title.x, y: title.y, lines: title.lines, size: FONT.title, weight: 700 }),
  );
  if (scene.subtitle) {
    const s = scene.subtitle;
    g.appendChild(text({ x: s.x, y: s.y, lines: s.lines, size: FONT.subtitle, color: INK_SOFT }));
  }
  svg.appendChild(g);
}

function drawGroup(g: SVGGElement, pen: Pen, group: LaidOutGroup): void {
  g.appendChild(
    pen.rc.path(
      roundedRectPath(group.x, group.y, group.width, group.height, 14),
      opts(pen, group.id, {
        fill: GROUP_FILL,
        fillStyle: "solid",
        stroke: MUTED,
        strokeWidth: 1.4,
        strokeLineDash: [9, 7],
        roughness: 0.8,
      }),
    ),
  );
  g.appendChild(
    text({
      x: group.x + SPACING.groupPadding,
      y: group.y + 7,
      lines: [group.label],
      size: FONT.group,
      weight: 700,
      color: INK_SOFT,
      fit: group.width - SPACING.groupPadding * 2,
    }),
  );
}

function drawNode(g: SVGGElement, pen: Pen, node: LaidOutNode): void {
  const { x, y, width: w, height: h } = node;
  const shape = node.shape ?? "box";
  const o = opts(pen, node.id, {
    fill: toneFill(node.tone),
    fillStyle: node.tone === "accent" ? "hachure" : "solid",
    hachureGap: 5,
    fillWeight: 1.6,
    stroke: toneStroke(node.tone),
    strokeWidth: node.tone === "accent" ? 2.2 : 1.6,
  });
  if (node.link) g.classList.add("clickable");
  if (node.tone === "accent" && shape !== "text" && shape !== "person") {
    // Hachure alone leaves gaps; a white base keeps edges from showing through.
    g.appendChild(
      pen.rc.rectangle(x + 3, y + 3, w - 6, h - 6, {
        ...o,
        fill: CARD,
        fillStyle: "solid",
        stroke: "none",
      }),
    );
  }

  let textTop = y + SPACING.nodePaddingY;
  let textHeight = h - SPACING.nodePaddingY * 2;
  switch (shape) {
    case "box":
      g.appendChild(pen.rc.rectangle(x, y, w, h, o));
      break;
    case "rounded":
      g.appendChild(pen.rc.path(roundedRectPath(x, y, w, h, Math.min(18, h / 2)), o));
      break;
    case "circle":
      g.appendChild(pen.rc.ellipse(x + w / 2, y + h / 2, w, h, o));
      break;
    case "note": {
      const f = 14;
      g.appendChild(
        pen.rc.polygon(
          [
            [x, y],
            [x + w - f, y],
            [x + w, y + f],
            [x + w, y + h],
            [x, y + h],
          ],
          o,
        ),
      );
      g.appendChild(
        pen.rc.linearPath(
          [
            [x + w - f, y],
            [x + w - f, y + f],
            [x + w, y + f],
          ],
          { ...o, fill: undefined },
        ),
      );
      break;
    }
    case "cylinder": {
      const ry = 10;
      const body = `M ${x} ${y + ry} L ${x} ${y + h - ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry} L ${x + w} ${y + ry}`;
      g.appendChild(pen.rc.path(`${body} Z`, { ...o, stroke: "none" }));
      g.appendChild(pen.rc.path(body, { ...o, fill: undefined }));
      g.appendChild(pen.rc.ellipse(x + w / 2, y + ry, w, ry * 2, o));
      textTop += ry * 1.4;
      textHeight -= ry * 1.4;
      break;
    }
    case "person": {
      const cx = x + w / 2;
      const so = { ...o, fill: undefined, strokeWidth: 1.8 };
      g.appendChild(pen.rc.circle(cx, y + 11, 20, { ...so, fill: CARD, fillStyle: "solid" }));
      g.appendChild(pen.rc.line(cx, y + 21, cx, y + 42, so));
      g.appendChild(pen.rc.line(cx - 15, y + 29, cx + 15, y + 29, so));
      g.appendChild(pen.rc.line(cx, y + 42, cx - 12, y + 58, so));
      g.appendChild(pen.rc.line(cx, y + 42, cx + 12, y + 58, so));
      textTop = y + 62;
      textHeight = h - 62;
      break;
    }
    case "text":
      textTop = y + 2;
      textHeight = h - 4;
      break;
  }

  if (node.iconData) {
    const size = SPACING.iconSize;
    const icon = node.iconData;
    const iconG = el("g", {
      transform: `translate(${x + w / 2 - size / 2} ${textTop}) scale(${size / icon.width} ${size / icon.height})`,
      color: toneText(node.tone),
      fill: "currentColor",
      class: "icon",
    });
    // Icon bodies come from the bundled Iconify sets, not from user input.
    iconG.innerHTML = icon.body;
    g.appendChild(iconG);
    textTop += size + 6;
    textHeight -= size + 6;
  }

  const lh = Math.round(FONT.node * 1.3);
  const blockHeight = node.lines.length * lh;
  g.appendChild(
    text({
      x: x + w / 2,
      y: textTop + Math.max(0, (textHeight - blockHeight) / 2),
      lines: node.lines,
      size: FONT.node,
      color: toneText(node.tone),
      anchor: "middle",
      weight: node.tone === "accent" ? 700 : undefined,
      fit: shape === "text" ? undefined : w - 12,
    }),
  );
}

function drawEdge(g: SVGGElement, pen: Pen, edge: LaidOutEdge): void {
  if (edge.points.length < 2) return;
  const stroke = toneStroke(edge.tone);
  const strokeWidth = edge.tone === "accent" ? 2.4 : 1.6;
  const o = opts(pen, edge.id, {
    stroke,
    strokeWidth,
    roughness: 0.9,
    strokeLineDash: edge.style === "dashed" ? [8, 6] : undefined,
  });
  g.appendChild(pen.rc.path(roundedPath(edge.points), o));
  const pts = edge.points;
  const head = (from: (typeof pts)[number], tip: (typeof pts)[number]) =>
    g.appendChild(
      pen.rc.linearPath(
        arrowHead(from, tip).map((p) => [p.x, p.y]),
        { ...o, strokeLineDash: undefined },
      ),
    );
  head(pts[pts.length - 2]!, pts[pts.length - 1]!);
  if (edge.bidirectional) head(pts[1]!, pts[0]!);
  // Invisible wide stroke so thin edges are easy to hover.
  g.appendChild(
    el("path", {
      d: roundedPath(edge.points),
      stroke: "transparent",
      "stroke-width": 12,
      fill: "none",
    }),
  );

  if (edge.labelBox) {
    const b = edge.labelBox;
    g.appendChild(
      el("rect", {
        x: b.x - 3,
        y: b.y,
        width: b.width + 6,
        height: b.height,
        rx: 4,
        fill: PAPER,
        opacity: 0.92,
      }),
    );
    g.appendChild(
      text({
        x: b.x + b.width / 2,
        y: b.y,
        lines: b.lines,
        size: FONT.edge,
        color: INK_SOFT,
        anchor: "middle",
      }),
    );
  }
}

function drawPart(g: SVGGElement, pen: Pen, part: LaidOutPart): void {
  const doc = new DOMParser().parseFromString(part.svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName === "svg") {
    prefixIds(root, `${part.id}-`);
    root.setAttribute("x", String(part.x));
    root.setAttribute("y", String(part.y));
    root.setAttribute("width", String(part.width));
    root.setAttribute("height", String(part.height));
    root.setAttribute("overflow", "visible");
    g.appendChild(document.importNode(root, true));
  }
  for (const pin of part.pins) {
    const hit = el("circle", {
      cx: part.x + pin.x,
      cy: part.y + pin.y,
      r: 4,
      fill: "transparent",
      class: "pin",
      "data-pin": pin.name,
      "data-signals": pin.signals.join(", "),
    });
    g.appendChild(hit);
  }
  if (part.captionBox) {
    const c = part.captionBox;
    g.appendChild(
      text({
        x: c.x + c.width / 2,
        y: c.y,
        lines: c.lines,
        size: FONT.caption,
        anchor: "middle",
        color: INK,
      }),
    );
  }
  void pen;
}

/** wokwi SVGs reuse ids like "led-body"; several parts in one document must not clash. */
function prefixIds(root: Element, prefix: string): void {
  const ids = new Set<string>();
  root.querySelectorAll("[id]").forEach((node) => {
    ids.add(node.id);
    node.id = prefix + node.id;
  });
  if (ids.size === 0) return;
  root.querySelectorAll("*").forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      if (attr.name === "id") continue;
      let value = attr.value;
      if (value.includes("#")) {
        value = value.replace(/url\(#([^)]+)\)/g, (m, id: string) =>
          ids.has(id) ? `url(#${prefix}${id})` : m,
        );
        if ((attr.name === "href" || attr.name === "xlink:href") && ids.has(value.slice(1))) {
          value = `#${prefix}${value.slice(1)}`;
        }
      }
      if (value !== attr.value) node.setAttribute(attr.name, value);
    }
  });
}

function drawWire(g: SVGGElement, pen: Pen, wire: LaidOutWire): void {
  if (wire.points.length < 2) return;
  const color = WIRE[wire.color ?? "green"];
  const d = roundedPath(wire.points, 8);
  if (wire.color === "white") {
    g.appendChild(
      pen.rc.path(
        d,
        opts(pen, `${wire.id}-outline`, { stroke: INK_SOFT, strokeWidth: 4.6, roughness: 0.4 }),
      ),
    );
  }
  g.appendChild(
    pen.rc.path(
      d,
      opts(pen, wire.id, { stroke: color, strokeWidth: 3, roughness: 0.45, bowing: 0.4 }),
    ),
  );
  for (const end of [wire.points[0]!, wire.points[wire.points.length - 1]!]) {
    g.appendChild(
      el("circle", { cx: end.x, cy: end.y, r: 3.2, fill: color, stroke: INK, "stroke-width": 0.8 }),
    );
  }
  g.appendChild(el("path", { d, stroke: "transparent", "stroke-width": 12, fill: "none" }));
}

function drawLabel(g: SVGGElement, pen: Pen, label: LaidOutLabel): void {
  const leftSide = label.leaderStart.x > label.x + label.width / 2;
  // A light halo keeps the leader readable where it crosses photos or parts.
  g.appendChild(
    el("line", {
      x1: label.leaderStart.x,
      y1: label.leaderStart.y,
      x2: label.anchorPoint.x,
      y2: label.anchorPoint.y,
      stroke: CARD,
      "stroke-width": 4,
      "stroke-linecap": "round",
      opacity: 0.75,
    }),
  );
  g.appendChild(
    pen.rc.line(
      label.leaderStart.x,
      label.leaderStart.y,
      label.anchorPoint.x,
      label.anchorPoint.y,
      opts(pen, label.id, {
        stroke: ANNOTATION,
        strokeWidth: 1.3,
        roughness: 0.7,
      }),
    ),
  );
  g.appendChild(
    el("circle", {
      cx: label.anchorPoint.x,
      cy: label.anchorPoint.y,
      r: 3.8,
      fill: ANNOTATION,
      stroke: CARD,
      "stroke-width": 1.5,
    }),
  );
  g.appendChild(
    text({
      x: leftSide ? label.x + label.width : label.x,
      y: label.y,
      lines: label.lines,
      size: FONT.label,
      color: ANNOTATION,
      anchor: leftSide ? "end" : "start",
    }),
  );
}

function drawImage(g: SVGGElement, pen: Pen, image: LaidOutImage): void {
  g.appendChild(
    el("image", {
      href: image.src,
      x: image.x,
      y: image.y,
      width: image.width,
      height: image.height,
      preserveAspectRatio: "none",
    }),
  );
  g.appendChild(
    pen.rc.rectangle(
      image.x - 3,
      image.y - 3,
      image.width + 6,
      image.height + 6,
      opts(pen, image.id, { roughness: 0.8 }),
    ),
  );
  if (image.captionBox) {
    const c = image.captionBox;
    g.appendChild(text({ x: c.x, y: c.y, lines: c.lines, size: FONT.caption }));
  }
  const a = image.attributionBox;
  const credit = text({ x: a.x, y: a.y, lines: a.lines, size: FONT.attribution, color: INK_SOFT });
  credit.classList.add("attribution");
  credit.setAttribute("data-href", image.attribution.sourceUrl);
  g.appendChild(credit);
}

/** Shrinks text that renders wider than the layout estimated. */
export function fitText(svg: SVGSVGElement): void {
  svg.querySelectorAll<SVGTextElement>("text[data-fit]").forEach((node) => {
    const max = Number(node.getAttribute("data-fit"));
    const width = node.getBBox().width;
    if (max > 0 && width > max) {
      const size = Number(node.getAttribute("font-size"));
      node.setAttribute("font-size", String(Math.max(10, Math.floor((size * max) / width))));
    }
  });
}

export { CARD, INK };

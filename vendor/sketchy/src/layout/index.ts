import { createRequire } from "node:module";
import type { ElkExtendedEdge, ElkNode, ElkPort } from "elkjs/lib/elk-api.js";
import { resolveIcon } from "../icons.js";
import type { PartIndex } from "../parts/index.js";
import { partMeta } from "../parts/metadata.js";
import type {
  LaidOutEdge,
  LaidOutGroup,
  LaidOutImage,
  LaidOutLabel,
  LaidOutNode,
  LaidOutPart,
  LaidOutScene,
  LaidOutWire,
  Point,
  TextBox,
} from "../scene/laid-out.js";
import type { Scene, SceneNode } from "../scene/types.js";
import { FONT, SPACING } from "../style/metrics.js";
import { layoutFigure, stateAt, stateNames } from "../figures/index.js";
import type { FigureLayout } from "../figures/types.js";
import { planCallouts, type CalloutPlan } from "./callouts.js";
import { editorLink, type Editor } from "./links.js";
import { lineHeight, measureText } from "./text.js";

// elkjs is CommonJS whose typings describe an ES default export.
const ELK = createRequire(import.meta.url)(
  "elkjs/lib/elk.bundled.js",
) as typeof import("elkjs/lib/elk-api.js").default;
const elk = new ELK();

const IMAGE_MAX_WIDTH = 560;
const IMAGE_MAX_HEIGHT = 420;

export type LayoutOptions = {
  editor?: Editor;
  /** Extra ELK options for the root graph, e.g. for tuning experiments. */
  elk?: Record<string, string>;
  /** The previous drawing of a follow-up; elements it shares keep their order and places. */
  previous?: PreviousLayout;
};

/** Where the elements of an earlier drawing ended up, by id. */
export type PreviousLayout = {
  direction: "right" | "down";
  positions: Record<string, Point>;
};

/** Geometry of an element framed by callouts and an optional caption. */
type Frame = {
  bodyWidth: number;
  bodyHeight: number;
  offsetX: number;
  offsetY: number;
  outerWidth: number;
  outerHeight: number;
  plan: CalloutPlan;
  caption?: { lines: string[]; width: number; height: number };
  captionAbove?: boolean;
  extra?: { lines: string[]; width: number; height: number; font: number };
};

/**
 * Turns a scene into concrete geometry. ELK's layered algorithm places
 * nodes, groups, parts and images and routes edges and wires orthogonally;
 * callout labels are planned around their target before ELK runs, so the
 * room they need is part of the target's size and nothing can overlap them.
 */
export async function layoutScene(
  scene: Scene,
  parts: PartIndex,
  options: LayoutOptions = {},
): Promise<LaidOutScene> {
  const frames = new Map<string, Frame>();
  const nodeSizes = new Map<string, { width: number; height: number; lines: string[] }>();
  const figures = layoutFigures(scene);

  for (const node of scene.nodes) {
    const measured = measureNode(node);
    const labels = scene.labels.filter((l) => l.target === node.id);
    if (labels.length) {
      frames.set(
        node.id,
        frame(
          measured.width,
          measured.height,
          planCallouts(
            measured.width,
            measured.height,
            labels.map((l) => ({ id: l.id, text: l.text })),
          ),
        ),
      );
    }
    nodeSizes.set(node.id, measured);
  }

  for (const part of scene.parts) {
    const detail = parts.detail(part.type)!;
    const pins = new Map(detail.pinList.map((p) => [p.name, p]));
    const requests = scene.labels
      .filter((l) => l.target === part.id)
      .map((l) => {
        const pin = l.anchor ? pins.get(l.anchor) : undefined;
        return { id: l.id, text: l.text, anchor: pin ? { x: pin.x, y: pin.y } : undefined };
      });
    const caption = measureText(
      part.label ?? detail.title,
      FONT.caption,
      Math.max(detail.width, 140),
    );
    // Wires leaving through the bottom would cross a caption placed there.
    const wiredSides = new Set(
      scene.wires
        .flatMap((w) => [w.from, w.to])
        .filter((end) => end.part === part.id)
        .map((end) => pinSide(pins.get(end.pin)!, detail.width, detail.height)),
    );
    const above = wiredSides.has("SOUTH") && !wiredSides.has("NORTH");
    frames.set(
      part.id,
      frame(
        detail.width,
        detail.height,
        planCallouts(detail.width, detail.height, requests),
        caption,
        undefined,
        above,
      ),
    );
  }

  for (const image of scene.images) {
    const scale = Math.min(1, IMAGE_MAX_WIDTH / image.width, IMAGE_MAX_HEIGHT / image.height);
    const w = Math.round(image.width * scale);
    const h = Math.round(image.height * scale);
    const requests = scene.labels
      .filter((l) => l.target === image.id)
      .map((l) => {
        const region = l.anchor ? image.regions[l.anchor] : undefined;
        const anchor = region
          ? { x: (region.x + region.width / 2) * scale, y: (region.y + region.height / 2) * scale }
          : undefined;
        return { id: l.id, text: l.text, anchor };
      });
    const caption = image.caption ? measureText(image.caption, FONT.caption, w) : undefined;
    const credit = measureText(attributionText(image.attribution), FONT.attribution, w);
    frames.set(
      image.id,
      frame(w, h, planCallouts(w, h, requests), caption, { ...credit, font: FONT.attribution }),
    );
  }

  // A drawing that asks for another flow is not laid out from the old one.
  const sameFlow = !scene.direction || scene.direction === options.previous?.direction;
  const hints = options.previous && sameFlow ? followUpHints(scene, options.previous) : undefined;
  const run = async (direction: "right" | "down") => {
    const graph = buildGraph(scene, parts, frames, nodeSizes, direction, hints, figures);
    Object.assign(graph.layoutOptions!, options.elk);
    return elk.layout(graph);
  };
  let result: ElkNode;
  if (hints) {
    // A follow-up keeps the earlier flow so nothing turns around.
    result = await run(scene.direction ?? options.previous!.direction);
  } else if (scene.direction) {
    result = await run(scene.direction);
  } else {
    // Try both flows and keep the one that stays larger in a chat-sized view.
    const [right, down] = await Promise.all([run("right"), run("down")]);
    result = readability(down) > readability(right) * 1.15 ? down : right;
  }

  return collect(scene, parts, result, frames, nodeSizes, options, figures);
}

type FigureFit = {
  width: number;
  height: number;
  base: FigureLayout;
  steps?: (FigureLayout | null)[];
};

/**
 * Lays out every figure in each state the steps put it in; the box fits the
 * largest, so stepping through never moves the rest of the drawing.
 */
function layoutFigures(scene: Scene): Map<string, FigureFit> {
  const out = new Map<string, FigureFit>();
  for (const fig of scene.figures) {
    if (fig.spec.kind === "draw") {
      // Resolved here so the laid-out scene carries them to the viewer.
      for (const shape of fig.spec.shapes) {
        if (shape.geo.g === "icon") shape.geo.data ??= resolveIcon(shape.geo.icon);
      }
    }
    const base = layoutFigure(fig, {});
    const names = new Set(stateNames(fig));
    const touched = scene.steps.some((s) => Object.keys(s.set ?? {}).some((k) => names.has(k)));
    let width = base.width;
    let height = base.height;
    let steps: (FigureLayout | null)[] | undefined;
    if (touched) {
      steps = scene.steps.map((_, i) => {
        const state = stateAt(scene.steps, i);
        if (!Object.keys(state).some((k) => names.has(k))) return null;
        const l = layoutFigure(fig, state);
        width = Math.max(width, l.width);
        height = Math.max(height, l.height);
        return l;
      });
    }
    out.set(fig.id, { width, height, base, ...(steps ? { steps } : {}) });
  }
  return out;
}

/** Elements shared with the previous drawing must make up at least this share. */
const FOLLOW_UP_SHARE = 0.5;

/**
 * Positions for every node and part of a follow-up drawing: shared elements
 * where they were, new ones one step past a known neighbour along the flow.
 * Undefined when the scene is a different drawing rather than a follow-up.
 */
function followUpHints(scene: Scene, previous: PreviousLayout): Map<string, Point> | undefined {
  const ids = [
    ...scene.nodes.map((n) => n.id),
    ...scene.parts.map((p) => p.id),
    ...scene.figures.map((f) => f.id),
  ];
  const known = ids.filter((id) => previous.positions[id]);
  if (!ids.length || known.length / ids.length < FOLLOW_UP_SHARE) return undefined;
  const hints = new Map<string, Point>(known.map((id) => [id, previous.positions[id]!]));
  for (const g of scene.groups)
    if (previous.positions[g.id]) hints.set(g.id, previous.positions[g.id]!);
  const step = 220;
  const along = (p: Point, d: number): Point =>
    previous.direction === "down" ? { x: p.x, y: p.y + d * step } : { x: p.x + d * step, y: p.y };
  const links = [
    ...scene.edges.map((e) => [e.from, e.to] as const),
    ...scene.wires.map((w) => [w.from.part, w.to.part] as const),
  ];
  // New elements chained to each other resolve over a few passes.
  for (let pass = 0; pass < ids.length; pass++) {
    let placed = false;
    for (const id of ids) {
      if (hints.has(id)) continue;
      const from = links.find(([a, b]) => b === id && hints.has(a));
      const to = links.find(([a, b]) => a === id && hints.has(b));
      if (from) hints.set(id, along(hints.get(from[0])!, 1));
      else if (to) hints.set(id, along(hints.get(to[1])!, -1));
      else continue;
      placed = true;
    }
    if (!placed) break;
  }
  // Unconnected new elements go after everything else.
  const far = Math.max(
    ...[...hints.values()].map((p) => (previous.direction === "down" ? p.y : p.x)),
  );
  for (const id of ids)
    if (!hints.has(id))
      hints.set(id, along(previous.direction === "down" ? { x: 0, y: far } : { x: far, y: 0 }, 1));
  return hints;
}

/**
 * Orders each container's children across the flow by their earlier position,
 * so ELK's model order keeps them in the same sequence within a layer.
 */
function sortByHints(
  containers: Iterable<ElkNode>,
  hints: Map<string, Point>,
  direction: "right" | "down",
): void {
  const across = (id: string) => {
    const p = hints.get(id);
    return p ? (direction === "down" ? p.x : p.y) : Number.POSITIVE_INFINITY;
  };
  for (const c of containers) c.children?.sort((a, b) => across(a.id) - across(b.id));
}

/** Positions of a drawing's nodes and parts, for laying out a follow-up. */
export function previousLayout(laidOut: LaidOutScene): PreviousLayout {
  const positions: Record<string, Point> = {};
  for (const n of laidOut.nodes) positions[n.id] = { x: n.x, y: n.y };
  for (const p of laidOut.parts) positions[p.id] = { x: p.x, y: p.y };
  for (const g of laidOut.groups) positions[g.id] = { x: g.x, y: g.y };
  for (const f of laidOut.figures ?? []) positions[f.id] = { x: f.x, y: f.y };
  return { direction: laidOut.direction ?? "right", positions };
}

function measureNode(node: SceneNode): { width: number; height: number; lines: string[] } {
  const shape = node.shape ?? "box";
  const text = measureText(node.label, FONT.node, SPACING.nodeMaxTextWidth);
  const iconHeight = node.icon ? SPACING.iconSize + 6 : 0;
  if (shape === "text") {
    return { width: text.width + 8, height: text.height + 4, lines: text.lines };
  }
  if (shape === "person") {
    return { width: Math.max(70, text.width + 8), height: 64 + text.height, lines: text.lines };
  }
  let width = Math.max(SPACING.nodeMinWidth, text.width + SPACING.nodePaddingX * 2);
  let height = Math.max(SPACING.nodeMinHeight, text.height + iconHeight + SPACING.nodePaddingY * 2);
  if (shape === "circle") {
    const d = Math.ceil(Math.hypot(text.width, text.height + iconHeight) + 24);
    width = height = Math.max(d, 80);
  } else if (shape === "cylinder") {
    height += 22;
  } else if (shape === "note") {
    width += 12;
  }
  return { width: Math.ceil(width), height: Math.ceil(height), lines: text.lines };
}

function frame(
  bodyWidth: number,
  bodyHeight: number,
  plan: CalloutPlan,
  caption?: { lines: string[]; width: number; height: number },
  extra?: Frame["extra"],
  captionAbove = false,
): Frame {
  const { margins } = plan;
  const captionSpace = caption ? caption.height + 8 : 0;
  const below = (captionAbove ? 0 : captionSpace) + (extra ? extra.height + 6 : 0);
  const top = Math.max(margins.top, captionAbove ? captionSpace : 0);
  const contentWidth = Math.max(bodyWidth, caption?.width ?? 0, extra?.width ?? 0);
  const sidePad = (contentWidth - bodyWidth) / 2;
  const left = Math.max(margins.left, sidePad);
  const right = Math.max(margins.right, sidePad);
  return {
    bodyWidth,
    bodyHeight,
    offsetX: left,
    offsetY: top,
    outerWidth: Math.ceil(left + bodyWidth + right),
    outerHeight: Math.ceil(top + Math.max(bodyHeight + below, bodyHeight + margins.bottom)),
    plan,
    caption,
    captionAbove,
    extra,
  };
}

type PortInfo = { elkId: string; boundary: Point; pin: Point };

function buildGraph(
  scene: Scene,
  parts: PartIndex,
  frames: Map<string, Frame>,
  nodeSizes: Map<string, { width: number; height: number }>,
  direction: "right" | "down",
  hints?: Map<string, Point>,
  figures: Map<string, FigureFit> = new Map(),
): ElkNode {
  const containers = new Map<string, ElkNode>();
  const root: ElkNode = {
    id: "__root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction === "down" ? "DOWN" : "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.json.edgeCoords": "ROOT",
      "elk.json.shapeCoords": "ROOT",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.spacing.nodeNode": "44",
      "elk.spacing.edgeNode": "22",
      "elk.spacing.edgeEdge": "14",
      "elk.spacing.edgeLabel": "6",
      "elk.spacing.componentComponent": "60",
      "elk.edgeLabels.placement": "CENTER",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
    },
    children: [],
    edges: [],
  };
  containers.set("__root", root);
  if (hints) {
    // Interactive strategies read layers and order from the given positions.
    // Interactive crossing minimization rejects groups, so the order within a
    // layer comes from the model order instead (see sortByHints), kept by
    // turning crossing minimization off below.
    Object.assign(root.layoutOptions!, {
      "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
      "elk.layered.layering.strategy": "INTERACTIVE",
    });
  }
  // ELK reads child positions relative to their group.
  const at = (id: string, group?: string) => {
    const p = hints?.get(id);
    if (!p) return {};
    const g = group ? hints?.get(group) : undefined;
    return g ? { x: p.x - g.x, y: p.y - g.y } : { x: p.x, y: p.y };
  };

  // Groups may reference parents declared later, so create them first.
  for (const group of scene.groups) {
    const label = measureText(group.label, FONT.group, 260);
    containers.set(group.id, {
      id: group.id,
      ...at(group.id, group.parent),
      children: [],
      layoutOptions: {
        "elk.padding": `[top=${SPACING.groupHeader + (label.lines.length - 1) * lineHeight(FONT.group)},left=${SPACING.groupPadding},bottom=${SPACING.groupPadding},right=${SPACING.groupPadding}]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${label.width + SPACING.groupPadding * 2}, 60)`,
      },
    });
  }
  for (const group of scene.groups) {
    containers.get(group.parent ?? "__root")!.children!.push(containers.get(group.id)!);
  }
  const container = (group?: string) => containers.get(group ?? "__root")!;

  for (const node of scene.nodes) {
    const f = frames.get(node.id);
    const size = nodeSizes.get(node.id)!;
    container(node.group).children!.push({
      id: node.id,
      width: f?.outerWidth ?? size.width,
      height: f?.outerHeight ?? size.height,
      ...at(node.id, node.group),
    });
  }

  const ports = portsForWires(scene, parts, frames);
  for (const part of scene.parts) {
    const f = frames.get(part.id)!;
    container(part.group).children!.push({
      id: part.id,
      width: f.outerWidth,
      height: f.outerHeight,
      ...at(part.id, part.group),
      ports: [...ports.values()]
        .filter((p) => p.part === part.id)
        .map<ElkPort>((p) => ({
          id: p.info.elkId,
          x: p.info.boundary.x,
          y: p.info.boundary.y,
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": p.side },
        })),
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    });
  }

  for (const image of scene.images) {
    const f = frames.get(image.id)!;
    root.children!.push({ id: image.id, width: f.outerWidth, height: f.outerHeight });
  }
  for (const fig of scene.figures) {
    const size = figures.get(fig.id)!;
    container(fig.group).children!.push({
      id: fig.id,
      width: size.width,
      height: size.height,
      ...at(fig.id, fig.group),
    });
  }
  if (hints) {
    sortByHints(containers.values(), hints, direction);
    // Each group lays out its own children; it needs the strategies too.
    for (const c of containers.values())
      Object.assign((c.layoutOptions ??= {}), {
        "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
        "elk.layered.layering.strategy": "INTERACTIVE",
        // New edges, a back-edge most of all, must not reshuffle a layer the
        // reader already knows; the earlier drawing settled its crossings.
        "elk.layered.crossingMinimization.strategy": "NONE",
      });
  }

  for (const edge of scene.edges) {
    const label = edge.label ? measureText(edge.label, FONT.edge, 160) : undefined;
    root.edges!.push({
      id: edge.id,
      sources: [edge.from],
      targets: [edge.to],
      labels: label ? [{ text: edge.label!, width: label.width + 8, height: label.height }] : [],
    });
  }
  for (const wire of scene.wires) {
    root.edges!.push({
      id: wire.id,
      sources: [ports.get(`${wire.from.part}.${wire.from.pin}`)!.info.elkId],
      targets: [ports.get(`${wire.to.part}.${wire.to.pin}`)!.info.elkId],
    });
  }
  return root;
}

type Side = "WEST" | "EAST" | "NORTH" | "SOUTH";

/** The body edge a pin is closest to; wires leave the part on that side. */
function pinSide(pin: Point, width: number, height: number): Side {
  const distances: [Side, number][] = [
    ["WEST", pin.x],
    ["EAST", width - pin.x],
    ["NORTH", pin.y],
    ["SOUTH", height - pin.y],
  ];
  return distances.sort((a, b) => a[1] - b[1])[0]![0];
}

type PartPort = { part: string; side: string; info: PortInfo };

/** One port per wired pin, on the frame side closest to the pin. */
function portsForWires(
  scene: Scene,
  parts: PartIndex,
  frames: Map<string, Frame>,
): Map<string, PartPort> {
  const ports = new Map<string, PartPort>();
  for (const wire of scene.wires) {
    for (const end of [wire.from, wire.to]) {
      const key = `${end.part}.${end.pin}`;
      if (ports.has(key)) continue;
      const part = scene.parts.find((p) => p.id === end.part)!;
      const pin = parts.resolvePin(part.type, end.pin)!;
      const f = frames.get(part.id)!;
      const px = f.offsetX + pin.x;
      const py = f.offsetY + pin.y;
      const side = pinSide(pin, f.bodyWidth, f.bodyHeight);
      const boundary =
        side === "WEST"
          ? { x: 0, y: py }
          : side === "EAST"
            ? { x: f.outerWidth, y: py }
            : side === "NORTH"
              ? { x: px, y: 0 }
              : { x: px, y: f.outerHeight };
      ports.set(key, {
        part: part.id,
        side,
        info: { elkId: `${part.id}::${end.pin}`, boundary, pin: { x: px, y: py } },
      });
    }
  }
  return ports;
}

function collect(
  scene: Scene,
  parts: PartIndex,
  result: ElkNode,
  frames: Map<string, Frame>,
  nodeSizes: Map<string, { width: number; height: number; lines: string[] }>,
  options: LayoutOptions,
  figureFits: Map<string, FigureFit> = new Map(),
): LaidOutScene {
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const visit = (n: ElkNode) => {
    for (const child of n.children ?? []) {
      boxes.set(child.id, {
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: child.width ?? 0,
        height: child.height ?? 0,
      });
      visit(child);
    }
  };
  visit(result);

  const { margin } = SPACING;
  let headerHeight = 0;
  let title: TextBox | undefined;
  let subtitle: TextBox | undefined;
  if (scene.title) {
    const t = measureText(scene.title, FONT.title, 900);
    title = { x: margin, y: margin, width: t.width, height: t.height, lines: t.lines };
    headerHeight = t.height + 8;
  }
  if (scene.subtitle) {
    const s = measureText(scene.subtitle, FONT.subtitle, 900);
    subtitle = {
      x: margin,
      y: margin + headerHeight,
      width: s.width,
      height: s.height,
      lines: s.lines,
    };
    headerHeight += s.height + 4;
  }
  if (headerHeight) headerHeight += 18;
  const dx = margin;
  const dy = margin + headerHeight;
  const at = (p: Point): Point => ({ x: round(p.x + dx), y: round(p.y + dy) });

  const labels: LaidOutLabel[] = [];
  const place = (id: string, f: Frame | undefined) => {
    const box = boxes.get(id)!;
    const bodyX = box.x + (f?.offsetX ?? 0);
    const bodyY = box.y + (f?.offsetY ?? 0);
    for (const c of f?.plan.callouts ?? []) {
      const label = scene.labels.find((l) => l.id === c.id)!;
      labels.push({
        ...label,
        ...at({ x: bodyX + c.x, y: bodyY + c.y }),
        width: c.width,
        height: c.height,
        lines: c.lines,
        anchorPoint: at({ x: bodyX + c.anchor.x, y: bodyY + c.anchor.y }),
        leaderStart: at({ x: bodyX + c.leaderStart.x, y: bodyY + c.leaderStart.y }),
      });
    }
    return { ...at({ x: bodyX, y: bodyY }), box };
  };

  const groups: LaidOutGroup[] = scene.groups.map((g) => {
    const b = boxes.get(g.id)!;
    return { ...g, ...at(b), width: round(b.width), height: round(b.height) };
  });

  const nodes: LaidOutNode[] = scene.nodes.map((n) => {
    const size = nodeSizes.get(n.id)!;
    const f = frames.get(n.id);
    const { x, y } = place(n.id, f);
    const link = n.file ? editorLink(n.file, n.line, options.editor) : undefined;
    const iconData = n.icon ? resolveIcon(n.icon) : undefined;
    return {
      ...n,
      x,
      y,
      width: size.width,
      height: size.height,
      lines: size.lines,
      ...(iconData ? { iconData } : {}),
      ...(link ? { link } : {}),
    };
  });

  const partsOut: LaidOutPart[] = scene.parts.map((p) => {
    const f = frames.get(p.id)!;
    const { x, y } = place(p.id, f);
    const detail = parts.detail(p.type)!;
    const captionBox = f.caption
      ? {
          x: round(x + f.bodyWidth / 2 - f.caption.width / 2),
          y: round(f.captionAbove ? y - 8 - f.caption.height : y + f.bodyHeight + 8),
          width: f.caption.width,
          height: f.caption.height,
          lines: f.caption.lines,
        }
      : undefined;
    return {
      ...p,
      x,
      y,
      width: f.bodyWidth,
      height: f.bodyHeight,
      title: partMeta(p.type).title,
      svg: parts.svg(p.type, p.props),
      pins: detail.pinList,
      ...(captionBox ? { captionBox } : {}),
    };
  });

  const images: LaidOutImage[] = scene.images.map((img) => {
    const f = frames.get(img.id)!;
    const { x, y } = place(img.id, f);
    let below = y + f.bodyHeight + 8;
    let captionBox: TextBox | undefined;
    if (f.caption) {
      captionBox = {
        x,
        y: round(below),
        width: f.caption.width,
        height: f.caption.height,
        lines: f.caption.lines,
      };
      below += f.caption.height + 6;
    }
    return {
      ...img,
      x,
      y,
      width: f.bodyWidth,
      height: f.bodyHeight,
      scale: f.bodyWidth / img.width,
      ...(captionBox ? { captionBox } : {}),
      attributionBox: {
        x,
        y: round(below),
        width: f.extra!.width,
        height: f.extra!.height,
        lines: f.extra!.lines,
      },
    };
  });

  const edgeById = new Map((result.edges ?? []).map((e) => [e.id, e]));
  const edges: LaidOutEdge[] = scene.edges.map((e) => {
    const elkEdge = edgeById.get(e.id)!;
    const label = elkEdge.labels?.[0];
    const measured = e.label ? measureText(e.label, FONT.edge, 160) : undefined;
    return {
      ...e,
      points: sectionPoints(elkEdge).map(at),
      ...(label && measured
        ? {
            labelBox: {
              ...at({ x: (label.x ?? 0) + 4, y: label.y ?? 0 }),
              width: measured.width,
              height: measured.height,
              lines: measured.lines,
            },
          }
        : {}),
    };
  });

  const portLookup = portsForWires(scene, parts, frames);
  const wires: LaidOutWire[] = scene.wires.map((w) => {
    const points = sectionPoints(edgeById.get(w.id)!);
    const from = portLookup.get(`${w.from.part}.${w.from.pin}`)!;
    const to = portLookup.get(`${w.to.part}.${w.to.pin}`)!;
    const fromBox = boxes.get(w.from.part)!;
    const toBox = boxes.get(w.to.part)!;
    // ELK ends wires on the frame edge; extend them to the actual pin.
    const start = { x: fromBox.x + from.info.pin.x, y: fromBox.y + from.info.pin.y };
    const end = { x: toBox.x + to.info.pin.x, y: toBox.y + to.info.pin.y };
    return { ...w, points: simplify([start, ...points, end]).map(at) };
  });

  const right = Math.max(
    (result.width ?? 0) + dx,
    (title?.x ?? 0) + (title?.width ?? 0),
    (subtitle?.x ?? 0) + (subtitle?.width ?? 0),
  );
  return {
    kind: "scene",
    direction: result.layoutOptions?.["elk.direction"] === "DOWN" ? "down" : "right",
    width: Math.ceil(right + margin),
    height: Math.ceil((result.height ?? 0) + dy + margin),
    ...(title ? { title } : {}),
    ...(subtitle ? { subtitle } : {}),
    groups,
    nodes,
    edges,
    parts: partsOut,
    wires,
    labels,
    images,
    figures: scene.figures.map((fig) => {
      const b = boxes.get(fig.id)!;
      const fit = figureFits.get(fig.id)!;
      return {
        ...fig,
        ...at(b),
        width: round(b.width),
        height: round(b.height),
        prims: fit.base.prims,
        ...(fit.steps ? { stepPrims: fit.steps.map((l) => l?.prims ?? null) } : {}),
      };
    }),
    steps: scene.steps,
  };
}

/** Scale at which a layout fits a typical chat viewport (about 720 × 480). */
function readability(graph: ElkNode): number {
  return Math.min(720 / (graph.width ?? 1), 480 / (graph.height ?? 1));
}

function sectionPoints(edge: ElkExtendedEdge): Point[] {
  const section = edge.sections?.[0];
  if (!section) return [];
  return [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
}

/** Drops zero-length and collinear points left by joining segments. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    const prev = out[out.length - 2];
    if (prev && last && collinear(prev, last, p)) out.pop();
    out.push(p);
  }
  return out;
}

function collinear(a: Point, b: Point, c: Point): boolean {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < 0.5;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function attributionText(a: {
  title: string;
  author: string;
  license: string;
  provider: string;
}): string {
  return `Photo: "${a.title}" by ${a.author}, ${a.license}, via ${a.provider}`;
}

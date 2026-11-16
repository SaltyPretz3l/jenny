import type { LaidOutNode, LaidOutScene, Point, Rect, TextBox } from "../../src/scene/laid-out.js";
import { FONT } from "../../src/style/metrics.js";
import { MARK_STYLE, type Mark } from "./annotate.js";
import { seedFor } from "./draw.js";
import {
  ANNOTATION,
  CARD,
  GROUP_FILL,
  INK,
  INK_SOFT,
  MARKER,
  MUTED,
  PAPER,
  WIRE,
  toneStroke,
  toneText,
} from "./palette.js";

/**
 * Converts a laid-out scene into an Excalidraw file (.excalidraw), so a drawing
 * can be edited further on excalidraw.com or in the Excalidraw editors.
 * Positions come straight from the layout; parts, icons and photos become
 * embedded images.
 */

type Element = Record<string, unknown> & { id: string; type: string };
type BinaryFile = { id: string; mimeType: string; dataURL: string; created: number };

/** Excalifont, Excalidraw's handwriting font. */
const HAND = 5;
const LINE_HEIGHT = 1.25;
export const WATERMARK = "sketchy";

export function toExcalidraw(scene: LaidOutScene, now = Date.now(), marks: Mark[] = []): string {
  const elements: Element[] = [];
  const files: Record<string, BinaryFile> = {};
  const byId = new Map<string, Element>();

  const base = (id: string, type: string, rect: Rect, extra: Record<string, unknown> = {}) => {
    const element: Element = {
      id,
      type,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      angle: 0,
      strokeColor: INK,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: seedFor(id),
      version: 1,
      versionNonce: seedFor(`${id}#`),
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
      ...extra,
    };
    elements.push(element);
    byId.set(id, element);
    return element;
  };

  const text = (
    id: string,
    lines: string[],
    at: Rect,
    size: number,
    extra: Record<string, unknown> = {},
  ) => {
    const value = lines.join("\n");
    return base(id, "text", at, {
      strokeColor: INK,
      text: value,
      originalText: value,
      fontSize: size,
      fontFamily: HAND,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      autoResize: true,
      lineHeight: LINE_HEIGHT,
      ...extra,
    });
  };
  const boxText = (id: string, box: TextBox, size: number, extra: Record<string, unknown> = {}) =>
    text(id, box.lines, { ...box, height: box.lines.length * size * LINE_HEIGHT }, size, extra);

  /** Text bound to a shape, so it moves and wraps with it. */
  const bind = (container: Element, lines: string[], color: string) => {
    const id = `${container.id}-text`;
    const height = lines.length * FONT.node * LINE_HEIGHT;
    text(
      id,
      lines,
      {
        x: (container.x as number) + 8,
        y: (container.y as number) + ((container.height as number) - height) / 2,
        width: (container.width as number) - 16,
        height,
      },
      FONT.node,
      {
        strokeColor: color,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: container.id,
      },
    );
    attach(container, { type: "text", id });
  };

  const image = (id: string, rect: Rect, mimeType: string, dataURL: string, extra = {}) => {
    const fileId = `file-${id}`;
    files[fileId] = { id: fileId, mimeType, dataURL, created: now };
    return base(id, "image", rect, {
      fileId,
      status: "saved",
      scale: [1, 1],
      strokeColor: "transparent",
      ...extra,
    });
  };

  const line = (
    id: string,
    type: "line" | "arrow",
    points: Point[],
    extra: Record<string, unknown> = {},
  ) => {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const origin = points[0]!;
    return base(
      id,
      type,
      {
        x: origin.x,
        y: origin.y,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      },
      {
        points: points.map((p) => [p.x - origin.x, p.y - origin.y]),
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: type === "arrow" ? "arrow" : null,
        ...extra,
      },
    );
  };

  if (scene.title) boxText("title", scene.title, FONT.title);
  if (scene.subtitle) boxText("subtitle", scene.subtitle, FONT.subtitle, { strokeColor: INK_SOFT });

  for (const group of scene.groups) {
    const groupIds = [`${group.id}-group`];
    base(group.id, "rectangle", group, {
      strokeColor: MUTED,
      backgroundColor: GROUP_FILL,
      strokeWidth: 1,
      strokeStyle: "dashed",
      roundness: { type: 3 },
      groupIds,
    });
    text(
      `${group.id}-label`,
      [group.label],
      { x: group.x + 18, y: group.y + 7, width: group.width - 36, height: FONT.group * 1.25 },
      FONT.group,
      { strokeColor: INK_SOFT, groupIds },
    );
  }

  for (const node of scene.nodes) addNode(node);

  for (const edge of scene.edges) {
    if (edge.points.length < 2) continue;
    const arrow = line(edge.id, "arrow", edge.points, {
      strokeColor: toneStroke(edge.tone),
      strokeWidth: edge.tone === "accent" ? 4 : 2,
      strokeStyle: edge.style === "dashed" ? "dashed" : "solid",
      startArrowhead: edge.bidirectional ? "arrow" : null,
      startBinding: binding(edge.from),
      endBinding: binding(edge.to),
    });
    for (const end of [edge.from, edge.to]) {
      const target = byId.get(end);
      if (target) attach(target, { type: "arrow", id: arrow.id });
    }
    if (edge.labelBox)
      boxText(`${edge.id}-label`, edge.labelBox, FONT.edge, {
        strokeColor: INK_SOFT,
        textAlign: "center",
      });
  }

  for (const part of scene.parts) {
    image(part.id, part, "image/svg+xml", svgDataUrl(part.svg));
    if (part.captionBox)
      boxText(`${part.id}-caption`, part.captionBox, FONT.caption, { textAlign: "center" });
  }

  for (const wire of scene.wires) {
    if (wire.points.length < 2) continue;
    line(wire.id, "line", wire.points, {
      strokeColor: WIRE[wire.color ?? "green"],
      strokeWidth: 2,
      roughness: 0,
    });
  }

  for (const img of scene.images) {
    const mime = /^data:([^;,]+)/.exec(img.src)?.[1] ?? "image/jpeg";
    image(img.id, img, mime, img.src);
    if (img.captionBox) boxText(`${img.id}-caption`, img.captionBox, FONT.caption);
    // Photos are licensed; the credit travels with them.
    boxText(`${img.id}-credit`, img.attributionBox, FONT.attribution, {
      strokeColor: INK_SOFT,
      link: img.attribution.sourceUrl,
    });
  }

  for (const label of scene.labels) {
    const leftSide = label.leaderStart.x > label.x + label.width / 2;
    line(`${label.id}-leader`, "line", [label.leaderStart, label.anchorPoint], {
      strokeColor: ANNOTATION,
      strokeWidth: 1,
    });
    base(
      `${label.id}-dot`,
      "ellipse",
      { x: label.anchorPoint.x - 4, y: label.anchorPoint.y - 4, width: 8, height: 8 },
      { strokeColor: ANNOTATION, backgroundColor: ANNOTATION, strokeWidth: 1, roughness: 0 },
    );
    boxText(label.id, label, FONT.label, {
      strokeColor: ANNOTATION,
      textAlign: leftSide ? "right" : "left",
    });
  }

  // The user's own marks from drawing mode, as freehand strokes and notes.
  marks.forEach((mark, i) => {
    const id = `mark-${i + 1}`;
    if (mark.kind === "text") {
      text(
        id,
        [mark.text],
        { x: mark.x, y: mark.y, width: mark.text.length * 9, height: MARK_STYLE.text.size * 1.25 },
        MARK_STYLE.text.size,
        { strokeColor: MARK_STYLE.text.color },
      );
      return;
    }
    const style = MARK_STYLE[mark.kind];
    line(id, "line", mark.points, {
      type: "freedraw",
      strokeColor: style.color,
      strokeWidth: mark.kind === "marker" ? 4 : 2,
      opacity: Math.round(style.opacity * 100),
      endArrowhead: null,
      pressures: [],
      simulatePressure: true,
    });
  });

  text(
    "sketchy-watermark",
    [WATERMARK],
    { x: scene.width - 92, y: scene.height - 26, width: 78, height: 22 },
    18,
    { opacity: 40, link: "https://sketchy.davidkubus.dev" },
  );

  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "https://sketchy.davidkubus.dev",
      elements,
      appState: { viewBackgroundColor: PAPER, gridSize: null },
      files,
    },
    null,
    2,
  );

  function binding(id: string) {
    return byId.has(id) ? { elementId: id, focus: 0, gap: 4 } : null;
  }

  function addNode(node: LaidOutNode): void {
    const shape = node.shape ?? "box";
    const accent = node.tone === "accent";
    const style = {
      strokeColor: toneStroke(node.tone),
      backgroundColor: accent ? MARKER : CARD,
      fillStyle: accent ? "hachure" : "solid",
      strokeWidth: accent ? 4 : 2,
      link: node.link ?? null,
    };
    const color = toneText(node.tone);
    let container: Element | undefined;
    let textTop = node.y + 12;

    switch (shape) {
      case "box":
      case "note":
        container = base(node.id, "rectangle", node, style);
        break;
      case "rounded":
      case "cylinder":
        container = base(node.id, "rectangle", node, { ...style, roundness: { type: 3 } });
        break;
      case "circle":
        container = base(node.id, "ellipse", node, style);
        break;
      case "person": {
        const cx = node.x + node.width / 2;
        const groupIds = [`${node.id}-figure`];
        const stroke = { strokeColor: style.strokeColor, groupIds };
        base(
          node.id,
          "ellipse",
          { x: cx - 10, y: node.y + 1, width: 20, height: 20 },
          { ...stroke, backgroundColor: CARD },
        );
        const limb = (name: string, points: Point[]) =>
          line(`${node.id}-${name}`, "line", points, stroke);
        limb("body", [
          { x: cx, y: node.y + 21 },
          { x: cx, y: node.y + 42 },
        ]);
        limb("arms", [
          { x: cx - 15, y: node.y + 29 },
          { x: cx + 15, y: node.y + 29 },
        ]);
        limb("legs", [
          { x: cx - 12, y: node.y + 58 },
          { x: cx, y: node.y + 42 },
          { x: cx + 12, y: node.y + 58 },
        ]);
        textTop = node.y + 62;
        break;
      }
      case "text":
        textTop = node.y + 2;
        break;
    }

    if (node.iconData) {
      const size = 26;
      const icon = node.iconData;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width} ${icon.height}" width="${size}" height="${size}" color="${color}" fill="currentColor">${icon.body}</svg>`;
      image(
        `${node.id}-icon`,
        { x: node.x + node.width / 2 - size / 2, y: textTop, width: size, height: size },
        "image/svg+xml",
        svgDataUrl(svg),
      );
      textTop += size + 6;
      // An icon pushes the label down, so it can no longer sit centered in the shape.
      container = undefined;
    }

    if (container && shape !== "cylinder") return bind(container, node.lines, color);
    const height = node.lines.length * FONT.node * LINE_HEIGHT;
    const bottom = node.y + node.height - (shape === "text" ? 2 : 12);
    text(
      `${node.id}-text`,
      node.lines,
      {
        x: node.x + 6,
        y: Math.max(textTop, textTop + (bottom - textTop - height) / 2),
        width: node.width - 12,
        height,
      },
      FONT.node,
      { strokeColor: color, textAlign: "center" },
    );
  }
}

function attach(element: Element, ref: { type: string; id: string }): void {
  element.boundElements = [...((element.boundElements as unknown[] | null) ?? []), ref];
}

function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

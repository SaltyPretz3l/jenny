import type { LaidOutScene, Point, Rect } from "../../src/scene/laid-out.js";
import { el, text } from "./draw.js";
import { HIGHLIGHT, MARKER } from "./palette.js";

/**
 * Drawing mode: the user marks up a drawing with a red pen, a highlighter and
 * notes. Marks live in scene coordinates in their own layer, so exports carry
 * them and the AI can be told which elements they touch.
 */

export type Stroke = { kind: "pen" | "marker"; points: Point[] };
export type Note = { kind: "text"; x: number; y: number; text: string };
export type Mark = Stroke | Note;
export type Tool = "pen" | "marker" | "text" | "eraser";

export const MARK_STYLE = {
  pen: { color: HIGHLIGHT, width: 2.6, opacity: 1 },
  marker: { color: MARKER, width: 16, opacity: 0.6 },
  text: { color: HIGHLIGHT, size: 18 },
} as const;

export type Annotator = {
  readonly marks: Mark[];
  tool: Tool;
  undo(): void;
  clear(): void;
  /** Called after every change, e.g. to update buttons. */
  onChange?: () => void;
};

export function createAnnotator(svg: SVGSVGElement, frame: HTMLElement): Annotator {
  const layer = el("g", { class: "layer-annotations" });
  svg.appendChild(layer);
  const marks: Mark[] = [];
  const nodes = new Map<Mark, SVGElement>();

  const annotator: Annotator = {
    marks,
    tool: "pen",
    undo() {
      const last = marks.pop();
      if (last) nodes.get(last)?.remove();
      annotator.onChange?.();
    },
    clear() {
      marks.length = 0;
      layer.replaceChildren();
      annotator.onChange?.();
    },
  };

  const add = (mark: Mark, node: SVGElement) => {
    node.classList.add("mark");
    marks.push(mark);
    nodes.set(mark, node);
    layer.appendChild(node);
    annotator.onChange?.();
  };
  const remove = (node: Element) => {
    const mark = [...nodes].find(([, n]) => n === node)?.[0];
    if (!mark) return;
    marks.splice(marks.indexOf(mark), 1);
    nodes.delete(mark);
    node.remove();
    annotator.onChange?.();
  };

  const toScene = (event: PointerEvent): Point => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: event.offsetX, y: event.offsetY };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
  };

  // Keeps the stroke going when the pointer leaves the drawing; not every pointer can be captured.
  const capture = (event: PointerEvent) => {
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      // Drawing still works inside the drawing.
    }
  };

  let stroke: { mark: Stroke; path: SVGPathElement } | undefined;

  svg.addEventListener("pointerdown", (event) => {
    if (!frame.classList.contains("drawing") || event.button !== 0) return;
    event.preventDefault();
    const tool = annotator.tool;
    if (tool === "eraser") {
      capture(event);
      erase(event);
    } else if (tool === "text") {
      placeNote(event);
    } else {
      capture(event);
      const mark: Stroke = { kind: tool, points: [toScene(event)] };
      const style = MARK_STYLE[tool];
      const path = el("path", {
        d: strokePath(mark.points),
        fill: "none",
        stroke: style.color,
        "stroke-width": style.width,
        "stroke-opacity": style.opacity,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      });
      if (tool === "marker") path.setAttribute("style", "mix-blend-mode: multiply");
      layer.appendChild(path);
      stroke = { mark, path };
    }
  });
  svg.addEventListener("pointermove", (event) => {
    if (!frame.classList.contains("drawing")) return;
    if (annotator.tool === "eraser" && event.buttons & 1) return erase(event);
    if (!stroke) return;
    const p = toScene(event);
    const last = stroke.mark.points[stroke.mark.points.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
    stroke.mark.points.push(p);
    stroke.path.setAttribute("d", strokePath(stroke.mark.points));
  });
  const finish = () => {
    if (!stroke) return;
    const { mark, path } = stroke;
    stroke = undefined;
    path.remove();
    add(mark, path);
    path.setAttribute("d", strokePath(mark.points));
  };
  svg.addEventListener("pointerup", finish);
  svg.addEventListener("pointercancel", finish);

  function erase(event: PointerEvent): void {
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest(".mark");
    if (hit && layer.contains(hit)) remove(hit);
  }

  function placeNote(event: PointerEvent): void {
    frame.querySelector(".note-input")?.remove();
    const at = toScene(event);
    const box = frame.getBoundingClientRect();
    const input = document.createElement("input");
    input.className = "note-input";
    input.placeholder = "Note…";
    input.style.left = `${event.clientX - box.left}px`;
    input.style.top = `${event.clientY - box.top - 14}px`;
    frame.appendChild(input);
    // Focus after the pointerdown, or the browser moves focus back to the drawing.
    setTimeout(() => input.focus());
    let done = false;
    const commit = (keep: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.remove();
      if (!keep || !value) return;
      const mark: Note = {
        kind: "text",
        x: at.x,
        y: at.y - MARK_STYLE.text.size * 0.9,
        text: value,
      };
      add(
        mark,
        text({
          x: mark.x,
          y: mark.y,
          lines: [value],
          size: MARK_STYLE.text.size,
          color: MARK_STYLE.text.color,
        }),
      );
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
  }

  return annotator;
}

/** A smooth path through the sampled points; a single tap becomes a dot. */
export function strokePath(points: Point[]): string {
  const [first, ...rest] = points;
  if (!first) return "";
  if (rest.length === 0) return `M ${first.x} ${first.y} l 0.01 0`;
  let d = `M ${first.x} ${first.y}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const p = rest[i]!;
    const next = rest[i + 1]!;
    d += ` Q ${p.x} ${p.y} ${(p.x + next.x) / 2} ${(p.y + next.y) / 2}`;
  }
  const last = rest[rest.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

/**
 * Plain-language summary of the marks for the AI: which elements were
 * circled or highlighted, and which notes sit next to which element.
 */
export function describeMarks(scene: LaidOutScene, marks: Mark[]): string {
  const targets = sceneTargets(scene);
  const marked = new Set<string>();
  const notes: string[] = [];
  for (const mark of marks) {
    if (mark.kind === "text") {
      const near = nearest(targets, { x: mark.x, y: mark.y });
      notes.push(near ? `"${mark.text}" (next to ${near.name})` : `"${mark.text}"`);
      continue;
    }
    const box = bounds(mark.points);
    const hits = targets.filter((t) => overlaps(box, t.rect));
    // A stroke around a whole area means the area, not every box in it.
    const inner = hits.filter((t) => t.kind !== "group");
    for (const t of inner.length ? inner : hits) marked.add(t.name);
  }
  const lines: string[] = [];
  if (marked.size) lines.push(`Marked: ${[...marked].join(", ")}.`);
  if (notes.length) lines.push(`Notes: ${notes.join("; ")}.`);
  return lines.join("\n");
}

type Target = { name: string; kind: string; rect: Rect };

function sceneTargets(scene: LaidOutScene): Target[] {
  return [
    ...scene.nodes.map((n) => ({ name: n.label, kind: "node", rect: n as Rect })),
    ...scene.parts.map((p) => ({ name: p.label ?? p.title, kind: "part", rect: p as Rect })),
    ...scene.images.map((i) => ({
      name: i.caption ?? "the photo",
      kind: "image",
      rect: i as Rect,
    })),
    ...scene.labels.map((l) => ({ name: l.text, kind: "label", rect: l as Rect })),
    ...scene.groups.map((g) => ({ name: g.label, kind: "group", rect: g as Rect })),
  ];
}

function nearest(targets: Target[], p: Point): Target | undefined {
  let best: Target | undefined;
  let bestDistance = 160;
  for (const t of targets) {
    if (t.kind === "group") continue;
    const dx = Math.max(t.rect.x - p.x, 0, p.x - (t.rect.x + t.rect.width));
    const dy = Math.max(t.rect.y - p.y, 0, p.y - (t.rect.y + t.rect.height));
    const d = Math.hypot(dx, dy);
    if (d < bestDistance) [best, bestDistance] = [t, d];
  }
  return best;
}

function bounds(points: Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

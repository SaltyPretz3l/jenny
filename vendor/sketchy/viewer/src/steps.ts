import { bounds } from "../../src/figures/common.js";
import { layoutFigure, stateAt, stateNames } from "../../src/figures/index.js";
import type { LaidOutScene, Rect } from "../../src/scene/laid-out.js";
import { opts, roundedPath } from "./draw.js";
import { HIGHLIGHT } from "./palette.js";
import type { RenderedScene } from "./render.js";

/**
 * Applies one step: elements that matter stay sharp and get circled in red
 * pen, everything else fades. `undefined` shows the whole scene.
 */
export function applyStep(
  scene: LaidOutScene,
  rendered: RenderedScene,
  index: number | undefined,
  animate = false,
): void {
  rendered.step = index;
  // Figures show the values the steps so far assigned.
  const state = stateAt(scene.steps, index);
  rendered.figures.forEach((view) => view.setState(state, animate));
  drawHighlights(scene, rendered, index);
}

/** Dims and circles for one step; also redrawn when a slider moves what is circled. */
export function drawHighlights(
  scene: LaidOutScene,
  rendered: RenderedScene,
  index: number | undefined,
): void {
  const { elements, overlay, pen } = rendered;
  overlay.replaceChildren();
  if (index === undefined) {
    elements.forEach((g) => g.classList.remove("dim"));
    return;
  }
  const step = scene.steps[index];
  if (!step) return;
  const active = activeIds(scene, step.highlight);
  elements.forEach((g, id) => g.classList.toggle("dim", !active.has(id)));

  const explicit = new Set(step.highlight);
  const pad = 7;
  const circle = (id: string, r: Rect) =>
    overlay.appendChild(
      pen.rc.rectangle(
        r.x - pad,
        r.y - pad,
        r.width + pad * 2,
        r.height + pad * 2,
        opts(pen, `hl-${id}-${index}`, {
          stroke: HIGHLIGHT,
          strokeWidth: 2.4,
          roughness: 1.6,
          bowing: 2,
        }),
      ),
    );
  for (const n of scene.nodes) if (explicit.has(n.id)) circle(n.id, n);
  for (const p of scene.parts) if (explicit.has(p.id)) circle(p.id, p);
  for (const i of scene.images) if (explicit.has(i.id)) circle(i.id, i);
  for (const g of scene.groups) if (explicit.has(g.id)) circle(g.id, g);
  for (const f of scene.figures ?? []) {
    if (explicit.has(f.id)) {
      circle(f.id, f);
      continue;
    }
    // Figure parts ("a[2]", a pointer name) are circled where they are drawn now.
    const view = rendered.figures.get(f.id);
    if (!view) continue;
    // Where they end up: a slider may still be gliding there, or the reader is dragging one.
    const prims = layoutFigure(view.fig, view.state, view.live).prims;
    const keys = new Set(prims.map((p) => p.key).filter((k): k is string => !!k));
    for (const key of step.highlight) {
      if (!keys.has(key)) continue;
      const b = bounds(prims.filter((p) => p.key === key));
      circle(`${f.id}-${key}`, { x: f.x + b.x, y: f.y + b.y, width: b.w, height: b.h });
    }
  }
  for (const e of [...scene.edges, ...scene.wires]) {
    if (!active.has(e.id) || e.points.length < 2) continue;
    overlay.appendChild(
      pen.rc.path(
        roundedPath(e.points),
        opts(pen, `hl-${e.id}-${index}`, {
          stroke: HIGHLIGHT,
          strokeWidth: 2.6,
          roughness: 0.9,
        }),
      ),
    );
  }
}

/**
 * Explicit ids plus what belongs to them: edges between two highlighted
 * elements, labels on highlighted targets, and enclosing groups.
 */
export function activeIds(scene: LaidOutScene, highlight: string[]): Set<string> {
  const active = new Set(highlight);
  // A highlighted figure part or pointer keeps its figure in focus.
  for (const f of scene.figures ?? []) {
    const names = stateNames(f).slice(1);
    if (highlight.some((h) => h.startsWith(`${f.id}[`) || names.includes(h))) active.add(f.id);
  }
  for (const e of scene.edges) if (active.has(e.from) && active.has(e.to)) active.add(e.id);
  for (const w of scene.wires)
    if (active.has(w.from.part) && active.has(w.to.part)) active.add(w.id);
  for (const e of scene.edges) {
    if (highlight.includes(e.id)) {
      active.add(e.from);
      active.add(e.to);
    }
  }
  for (const l of scene.labels) if (active.has(l.target)) active.add(l.id);
  const parentOf = new Map<string, string | undefined>([
    ...scene.nodes.map((n) => [n.id, n.group] as const),
    ...scene.parts.map((p) => [p.id, p.group] as const),
    ...scene.groups.map((g) => [g.id, g.parent] as const),
  ]);
  for (const id of [...active]) {
    let parent = parentOf.get(id);
    while (parent) {
      active.add(parent);
      parent = parentOf.get(parent);
    }
  }
  return active;
}

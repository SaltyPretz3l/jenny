import type { DrawShape, DrawSpec, SceneFigure } from "../figures/types.js";
import { SceneError } from "./builder.js";
import { parseCompact, type CompactScene } from "./compact.js";

/**
 * Follow-up changes without resending the scene. A patch is written in the
 * compact syntax: a line for an element that exists replaces it, a new one is
 * added, and "remove <id>" takes one out together with what depends on it.
 *
 *   core Nucleus !accent
 *   a -> b now dashed
 *   remove cache
 *   remove a -> b
 *   remove atom[e2]
 *   remove atom[3]      (the third shape, for one without a name)
 *   remove steps
 *   draw atom
 *   circle e2 90,50 3 fill=red
 */
export function applyPatch(base: CompactScene, source: string): CompactScene {
  const removals: string[] = [];
  const kept = source.split("\n").filter((line) => {
    const m = line.trim().match(/^remove\s+(.+)$/);
    if (m) removals.push(m[1]!.trim());
    return !m;
  });
  const patch = parseCompact(kept.join("\n"));
  const scene = structuredClone(base);
  for (const target of removals) remove(scene, target);
  merge(scene, patch);
  return scene;
}

const edgeKey = (edge: { from: string; to: string }) => `${edge.from}->${edge.to}`;

/** Adds or replaces by key, keeping the order elements already have. */
function upsert<T>(list: T[], items: T[], key: (item: T) => string): void {
  for (const item of items) {
    const at = list.findIndex((existing) => key(existing) === key(item));
    if (at >= 0) list[at] = item;
    else list.push(item);
  }
}

function merge(scene: CompactScene, patch: CompactScene): void {
  if (patch.title !== undefined) scene.title = patch.title;
  if (patch.subtitle !== undefined) scene.subtitle = patch.subtitle;
  if (patch.direction !== undefined) scene.direction = patch.direction;
  upsert(scene.groups, patch.groups, (g) => g.id);
  upsert(scene.nodes, patch.nodes, (n) => n.id);
  upsert(scene.edges, patch.edges, edgeKey);
  upsert(scene.labels, patch.labels, (l) => `${l.target}.${l.anchor ?? ""}`);
  upsert(scene.parts, patch.parts, (p) => p.id);
  upsert(scene.wires, patch.wires, edgeKey);
  for (const image of patch.images) if (!scene.images.includes(image)) scene.images.push(image);
  for (const figure of patch.figures) {
    const at = scene.figures.findIndex((f) => f.id === figure.id);
    if (at < 0) scene.figures.push(figure);
    else scene.figures[at] = mergeFigure(scene.figures[at]!, figure);
  }
  // Steps tell one story, so new ones replace the whole walkthrough.
  if (patch.steps.length) scene.steps = patch.steps;
}

/** A drawing is edited shape by shape; other figures are replaced whole. */
function mergeFigure(old: SceneFigure, next: SceneFigure): SceneFigure {
  const merged = {
    ...next,
    ...(next.title === undefined && old.title !== undefined ? { title: old.title } : {}),
    ...(next.group === undefined && old.group !== undefined ? { group: old.group } : {}),
  };
  if (old.spec.kind !== "draw" || next.spec.kind !== "draw") return merged;
  const spec: DrawSpec = {
    ...old.spec,
    shapes: [...old.spec.shapes],
    sliders: [...old.spec.sliders],
  };
  // "draw atom" without a size parses as the default 100x100: that keeps the old size.
  if (next.spec.width !== 100 || next.spec.height !== 100) {
    spec.width = next.spec.width;
    spec.height = next.spec.height;
  }
  const sameText = (a: DrawShape, b: DrawShape) =>
    !a.name && !b.name && a.geo.g === "text" && b.geo.g === "text" && a.geo.text === b.geo.text;
  for (const shape of next.spec.shapes) {
    // Named shapes are replaced by name; unnamed text with the same words is moved.
    const at = shape.name
      ? spec.shapes.findIndex((s) => s.name === shape.name)
      : spec.shapes.findIndex((s) => sameText(s, shape));
    if (at >= 0) spec.shapes[at] = shape;
    else spec.shapes.push(shape);
  }
  upsert(spec.sliders, next.spec.sliders, (s) => s.name);
  return { ...merged, spec };
}

function remove(scene: CompactScene, target: string): void {
  if (target === "steps") {
    scene.steps = [];
    return;
  }
  const edge = target.match(/^(\S+)\s*(?:<->|-->|->)\s*(\S+)$/);
  if (edge) {
    const key = `${edge[1]}->${edge[2]}`;
    const count = scene.edges.length + scene.wires.length;
    scene.edges = scene.edges.filter((e) => edgeKey(e) !== key);
    scene.wires = scene.wires.filter((w) => edgeKey(w) !== key);
    if (scene.edges.length + scene.wires.length === count)
      throw new SceneError(`There is no arrow "${target}" to remove.`);
    dropFromSteps(scene, (id) => id === key);
    return;
  }
  const shape = target.match(/^([A-Za-z0-9_-]+)\[([^\]]+)\]$/);
  if (shape) {
    const figure = scene.figures.find((f) => f.id === shape[1]);
    if (!figure || figure.spec.kind !== "draw")
      throw new SceneError(`"${shape[1]}" is no drawing with shapes to remove.`);
    const before = figure.spec.shapes.length;
    figure.spec.shapes = figure.spec.shapes.filter((s) => s.name !== shape[2]);
    // Unnamed shapes go by their place in the drawing, counted from 1.
    const index = Number(shape[2]);
    if (
      figure.spec.shapes.length === before &&
      Number.isInteger(index) &&
      index >= 1 &&
      index <= before
    )
      figure.spec.shapes.splice(index - 1, 1);
    if (figure.spec.shapes.length === before)
      throw new SceneError(`Drawing "${shape[1]}" has no shape "${shape[2]}".`);
    dropFromSteps(scene, (id) => id === target);
    return;
  }
  const count =
    [scene.nodes, scene.groups, scene.parts, scene.figures].reduce(
      (sum, list) => sum + list.length,
      0,
    ) + scene.images.length;
  scene.nodes = scene.nodes.filter((n) => n.id !== target);
  scene.parts = scene.parts.filter((p) => p.id !== target);
  scene.figures = scene.figures.filter((f) => f.id !== target);
  scene.images = scene.images.filter((i) => i !== target);
  scene.groups = scene.groups.filter((g) => g.id !== target);
  const left =
    [scene.nodes, scene.groups, scene.parts, scene.figures].reduce(
      (sum, list) => sum + list.length,
      0,
    ) + scene.images.length;
  if (left === count) throw new SceneError(`There is nothing called "${target}" to remove.`);
  // What hung on it goes too; members of a removed group simply lose the group.
  scene.edges = scene.edges.filter((e) => e.from !== target && e.to !== target);
  const pinOf = (ref: string) => ref.split(".")[0];
  scene.wires = scene.wires.filter((w) => pinOf(w.from) !== target && pinOf(w.to) !== target);
  scene.labels = scene.labels.filter((l) => l.target !== target);
  for (const node of scene.nodes) if (node.group === target) delete node.group;
  for (const group of scene.groups) if (group.parent === target) delete group.parent;
  for (const figure of scene.figures) if (figure.group === target) delete figure.group;
  const edges = new RegExp(`(^|->)${target.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(->|$)`);
  dropFromSteps(scene, (id) => edges.test(id) || id.startsWith(`${target}[`));
  for (const step of scene.steps) {
    if (step.set && target in step.set) delete step.set[target];
  }
}

function dropFromSteps(scene: CompactScene, gone: (id: string) => boolean): void {
  for (const step of scene.steps) step.highlight = step.highlight.filter((id) => !gone(id));
}

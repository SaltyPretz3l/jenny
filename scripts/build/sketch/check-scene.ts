// The scene side of the checking layer: rules on the parsed input object, after upstream's parser and before
// its builder. The builder is strict (one bad reference fails the drawing), so everything it would refuse for a
// mistake plan 5.4 lists is dropped, repaired or reported here, working on plain data only.
import { SceneBuilder } from "@sketchy/src/scene/builder.js";
import type { CompactScene } from "@sketchy/src/scene/compact.js";
import type { SketchInput } from "@sketchy/src/scene/fill.js";
import { stateNames } from "@sketchy/src/figures/index.js";
import type { SceneFigure, TreeNode } from "@sketchy/src/figures/types.js";
import { hasIcon } from "./replace/icons";
import type { Sink } from "./check";
import { locator, type ElementKind, type Locate, type WorkLine } from "./check-source";

export type SceneCheck = {
  input: SketchInput;
  /** Elements that stay in the drawing: groups, nodes, figures, arrows, labels and steps. */
  kept: number;
  /** What the node bound counts: nodes, groups, and each figure with its parts. */
  nodes: number;
  /** Groups, nodes and figures: with none of them there is nothing to draw. */
  drawable: number;
};

/** The builder's own id rule (vendor/sketchy/src/scene/builder.ts ID_PATTERN); the parser accepts more. */
const BUILDER_ID = /^[A-Za-z][\w-]{0,63}$/;
const PLAIN_ID = /^[A-Za-z][\w-]*$/;
const FIGURE_PART = /^([A-Za-z][\w-]*)\[([^\]]+)\]$/;
/** A node whose label starts with an arrow is an arrow line the parser could not read (`a -> b: text`). */
const BROKEN_ARROW = /^(?:<->|-->|->)(?:\s|$)/;
const SHAPES = new Set(["box", "rounded", "circle", "cylinder", "note", "person", "text"]);
const PROSE_WORDS = 8;

type Entry<T> = { value: T; index: number };
type Pool = [id: string, lower: string][];

const entries = <T>(list: T[]): Entry<T>[] => list.map((value, index) => ({ value, index }));
const poolOf = (ids: Iterable<string>): Pool => [...ids].map((id) => [id, id.toLowerCase()]);

/** One edit (a letter changed, added or missing) apart. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

function nearMatch(a: string, b: string): boolean {
  if (a === b) return true; // the same letters in another case
  if (a === `${b}s` || b === `${a}s` || a === `${b}es` || b === `${a}es`) return true; // plural or singular
  return a.length >= 4 && b.length >= 4 && oneEditApart(a, b); // one character apart, in ids of four or more
}

/** The one declared id `id` is a near match for, or undefined when none or more than one is. */
function nearId(id: string, pool: Pool): string | undefined {
  const lower = id.toLowerCase();
  let hit: string | undefined;
  for (const [declared, declaredLower] of pool) {
    if (!nearMatch(lower, declaredLower)) continue;
    if (hit !== undefined) return undefined;
    hit = declared;
  }
  return hit;
}

/** The label of a node line read with `in <id>` as text: what the model wrote when no such group exists. */
function labelWithGroupText(line: string): string | undefined {
  const at = line.indexOf(" ~ ");
  const main = at < 0 ? line : line.slice(0, at);
  const m = /^[A-Za-z0-9_-]+\s+(.+)$/.exec(main);
  if (!m) return undefined;
  const words = m[1]!.split(/\s+/).filter(
    (t) => !(t.startsWith("@") && t.length > 1)
      && !(/^\(\w+\)$/.test(t) && SHAPES.has(t.slice(1, -1)))
      && t !== "!accent" && t !== "!muted" && !t.startsWith("file="),
  );
  return words.join(" ") || undefined;
}

function treeSize(root: TreeNode | null): number {
  let count = 0;
  const stack: (TreeNode | null)[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    count++;
    for (const child of node.children) stack.push(child);
  }
  return count;
}

/** A figure counts as one node plus its parts, so a long sequence or a big chart cannot slip past the bound. */
function figureWeight(figure: SceneFigure): number {
  const s = figure.spec;
  switch (s.kind) {
    case "plot": return 1 + s.fns.length + s.curves.length + s.points.length + s.areas.length + s.vlines.length + s.hlines.length + s.arrows.length;
    case "chart": return 1 + s.rows.length;
    case "seq": return 1 + s.actors.length + s.items.length;
    case "array": case "list": case "stack": case "queue": return 1 + s.values.length;
    case "tree": return 1 + treeSize(s.root);
    case "draw": return 1 + s.shapes.length;
    case "template": return 1 + s.items.length;
    case "map": return 1 + s.countries.length + s.places.length + s.routes.length;
    default: return 1;
  }
}

export function checkScene(scene: CompactScene, work: WorkLine[], sink: Sink): SceneCheck {
  // Where an element came from costs a few parses, so it is only looked up when a rule has something to report.
  let locate: Locate | undefined;
  const workIndex = (kind: ElementKind, index: number): number | undefined => (locate ??= locator(work))(kind, index);
  const report = (code: Parameters<Sink["add"]>[0], kind: ElementKind, index: number, extra: { id?: string; to?: string; text?: string } = {}): void => {
    const at = workIndex(kind, index);
    const line = at === undefined ? null : work[at]!;
    sink.add(code, line && line.src, { text: line ? line.text : undefined, ...extra });
  };

  // ---- ids: what the builder would refuse, and duplicates (the first one wins, in source order)
  let groups = entries(scene.groups);
  let nodes = entries(scene.nodes);
  let figures = entries(scene.figures);
  const holders = [
    ...groups.map((entry) => ({ kind: "groups" as const, entry, unreadable: false })),
    ...nodes.map((entry) => ({ kind: "nodes" as const, entry, unreadable: BROKEN_ARROW.test(entry.value.label) })),
    ...figures.map((entry) => ({ kind: "figures" as const, entry, unreadable: false })),
  ];
  const distinctIds = new Set(holders.map((h) => h.entry.value.id));
  if (distinctIds.size !== holders.length) {
    const order = new Map(holders.map((h) => [h, workIndex(h.kind, h.entry.index) ?? Infinity]));
    holders.sort((a, b) => order.get(a)! - order.get(b)!);
  }
  const taken = new Set<string>();
  const gone = new Set<object>();
  for (const { kind, entry, unreadable } of holders) {
    const id = entry.value.id;
    if (unreadable || !BUILDER_ID.test(id)) {
      report("removed_line", kind, entry.index, { id });
    } else if (taken.has(id)) {
      report("duplicate_id", kind, entry.index, { id });
    } else {
      taken.add(id);
      continue;
    }
    gone.add(entry);
    sink.dropped++;
  }
  groups = groups.filter((e) => !gone.has(e));
  nodes = nodes.filter((e) => !gone.has(e));
  figures = figures.filter((e) => !gone.has(e));

  // ---- groups: a parent that is no group goes back into the label; parents come before their children
  const groupIds = new Set(groups.map((e) => e.value.id));
  const toText = (g: CompactScene["groups"][number]): void => {
    g.label = `${g.label} in ${g.parent}`;
    delete g.parent;
  };
  for (const { value: g } of groups) if (g.parent !== undefined && (!groupIds.has(g.parent) || g.parent === g.id)) toText(g);
  const ordered: Entry<CompactScene["groups"][number]>[] = [];
  const placed = new Set<string>();
  for (let waiting = groups; waiting.length;) {
    const next: typeof waiting = [];
    for (const e of waiting) {
      if (e.value.parent === undefined || placed.has(e.value.parent)) {
        ordered.push(e);
        placed.add(e.value.id);
      } else {
        next.push(e);
      }
    }
    if (next.length === waiting.length) toText(next[0]!.value); // a loop of groups: one of them is only text
    waiting = next;
  }

  // ---- nodes: `in X` with no group X is label text; an unknown icon goes; prose is flagged
  for (const e of nodes) {
    const n = e.value;
    if (n.group !== undefined && !groupIds.has(n.group)) {
      const at = workIndex("nodes", e.index);
      n.label = (at === undefined ? undefined : labelWithGroupText(work[at]!.text)) ?? `${n.label} in ${n.group}`;
      delete n.group;
    }
    if (n.icon !== undefined && !hasIcon(n.icon)) delete n.icon;
    const label = n.label.trim();
    if (label.split(/\s+/).length > PROSE_WORDS || /[:.]$/.test(label)) {
      report("prose_node", "nodes", e.index, { id: n.id, text: label });
      sink.flagged++;
    }
  }

  // ---- figures: a group that does not exist is dropped; the builder says which ones cannot be drawn
  const trial = new SceneBuilder(undefined as never);
  trial.reset();
  for (const e of ordered) trial.addGroup(e.value);
  for (const e of nodes) trial.addNode(e.value);
  const figuresKept: Entry<SceneFigure>[] = [];
  for (const e of figures) {
    if (e.value.group !== undefined && !groupIds.has(e.value.group)) delete e.value.group;
    try {
      trial.addFigure(e.value);
      figuresKept.push(e);
    } catch {
      report("figure_dropped", "figures", e.index, { id: e.value.id });
      sink.dropped++;
    }
  }

  // ---- references: arrows, labels and steps name declared ids, or are re-pointed, or are dropped
  const nodeIds = new Set(nodes.map((e) => e.value.id));
  const connectable = new Set([...groupIds, ...nodeIds, ...figuresKept.map((e) => e.value.id)]);
  const connectablePool = poolOf(connectable);
  const nodePool = poolOf(nodeIds);
  // Every id the builder will know, so a step can name an arrow (`a->b`) or a label (`label-a`).
  const known = new Set(connectable);
  const claim = (base: string): void => {
    let id = base;
    for (let n = 2; known.has(id); n++) id = `${base}#${n}`;
    known.add(id);
  };

  const edges: CompactScene["edges"] = [];
  scene.edges.forEach((edge, index) => {
    const moved: [string, string][] = [];
    const unknown: string[] = [];
    const resolve = (end: string): string => {
      if (connectable.has(end)) return end;
      const hit = nearId(end, connectablePool);
      if (hit === undefined) unknown.push(end);
      else moved.push([end, hit]);
      return hit ?? end;
    };
    const from = resolve(edge.from);
    const to = resolve(edge.to);
    if (unknown.length) {
      report("missing_id", "edges", index, { id: unknown[0] });
      sink.dropped++;
      return;
    }
    for (const [id, hit] of moved) report("repointed_id", "edges", index, { id, to: hit });
    edge.from = from;
    edge.to = to;
    claim(`${from}->${to}`);
    edges.push(edge);
  });

  const labels: CompactScene["labels"] = [];
  scene.labels.forEach((label, index) => {
    let target = label.target;
    if (!nodeIds.has(target)) {
      const hit = nearId(target, nodePool);
      if (hit === undefined) {
        report("missing_id", "labels", index, { id: target });
        sink.dropped++;
        return;
      }
      report("repointed_id", "labels", index, { id: target, to: hit });
      target = hit;
    }
    label.target = target;
    delete label.anchor; // only photo regions and part pins take an anchor; the builder refuses one on a node
    claim(`label-${target}`);
    labels.push(label);
  });

  const figureById = new Map(figuresKept.map((e) => [e.value.id, e.value]));
  const pointerNames = new Set(figuresKept.flatMap((e) => stateNames(e.value).slice(1)));
  const assignable = new Set(figuresKept.flatMap((e) => stateNames(e.value)));
  // The builder's own test for a step id (SceneBuilder.addStep): an id, a part of a figure, or a pointer name.
  const stepKnows = (id: string): boolean => {
    if (known.has(id)) return true;
    const part = FIGURE_PART.exec(id);
    const owner = part ? figureById.get(part[1]!) : undefined;
    if (owner && owner.spec.kind === "draw") return owner.spec.shapes.some((shape) => shape.name === part![2]);
    if (owner && owner.spec.kind === "template") {
      const number = Number(part![2]);
      return Number.isInteger(number) && number >= 1 && number <= owner.spec.items.length;
    }
    return owner !== undefined || pointerNames.has(id);
  };
  scene.steps.forEach((step, index) => {
    const highlight: string[] = [];
    for (const id of step.highlight) {
      if (stepKnows(id)) {
        highlight.push(id);
        continue;
      }
      const hit = PLAIN_ID.test(id) ? nearId(id, connectablePool) : undefined;
      if (hit === undefined) {
        report("missing_id", "steps", index, { id });
      } else {
        report("repointed_id", "steps", index, { id, to: hit });
        highlight.push(hit);
      }
    }
    step.highlight = highlight;
    if (step.set) {
      const set: Record<string, string> = {};
      for (const [name, value] of Object.entries(step.set)) {
        if (assignable.has(name)) set[name] = value;
        else report("missing_id", "steps", index, { id: name });
      }
      if (Object.keys(set).length) step.set = set;
      else delete step.set;
    }
  });

  const input: SketchInput = {};
  if (scene.title !== undefined) input.title = scene.title;
  if (scene.subtitle !== undefined) input.subtitle = scene.subtitle;
  if (scene.direction !== undefined) input.direction = scene.direction;
  input.groups = ordered.map((e) => e.value);
  input.nodes = nodes.map((e) => e.value);
  input.figures = figuresKept.map((e) => e.value);
  input.edges = edges;
  input.labels = labels;
  input.steps = scene.steps;

  const drawable = input.groups.length + input.nodes.length + input.figures.length;
  return {
    input,
    kept: drawable + edges.length + labels.length + scene.steps.length,
    nodes: input.groups.length + input.nodes.length + figuresKept.reduce((sum, e) => sum + figureWeight(e.value), 0),
    drawable,
  };
}

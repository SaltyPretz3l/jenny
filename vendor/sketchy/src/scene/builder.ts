import type { PartIndex } from "../parts/index.js";
import { resolveIcon } from "../icons.js";
import { evaluate, ExprError } from "../figures/expr.js";
import { parseTree, parseValues } from "../figures/data.js";
import { validatePlot } from "../figures/plot.js";
import { stateNames } from "../figures/index.js";
import type { FigureState, SceneFigure } from "../figures/types.js";
import {
  emptyScene,
  type Direction,
  type NodeShape,
  type PinRef,
  type Scene,
  type SceneImage,
  type Tone,
  type WireColor,
} from "./types.js";

/** A validation failure that is reported back to Claude verbatim. */
export class SceneError extends Error {}

const ID_PATTERN = /^[A-Za-z][\w-]{0,63}$/;

export type NodeInput = {
  id: string;
  label: string;
  description?: string;
  file?: string;
  line?: number;
  group?: string;
  icon?: string;
  shape?: NodeShape;
  tone?: Tone;
};

export type EdgeInput = {
  from: string;
  to: string;
  label?: string;
  style?: "solid" | "dashed";
  tone?: Tone;
  bidirectional?: boolean;
};

export type PartInput = {
  id: string;
  type: string;
  label?: string;
  props?: Record<string, string>;
  group?: string;
};

export type WireInput = { from: string; to: string; color?: WireColor; label?: string };

export type LabelInput = { target: string; text: string; anchor?: string };

export type StepInput = {
  title: string;
  text?: string;
  highlight: string[];
  set?: FigureState;
};

export type GroupInput = { id: string; label: string; parent?: string; description?: string };

/**
 * Accumulates a scene from tool calls and enforces its invariants: unique
 * ids, valid references and known parts and pins. Positions never enter here.
 */
export class SceneBuilder {
  scene: Scene = emptyScene();

  constructor(private readonly parts: PartIndex) {}

  reset(meta: { title?: string; subtitle?: string; direction?: Direction } = {}): void {
    this.scene = emptyScene();
    this.stateOwners.clear();
    this.setMeta(meta);
  }

  setMeta(meta: { title?: string; subtitle?: string; direction?: Direction }): void {
    if (meta.title !== undefined) this.scene.title = meta.title;
    if (meta.subtitle !== undefined) this.scene.subtitle = meta.subtitle;
    if (meta.direction !== undefined) this.scene.direction = meta.direction;
  }

  addGroup(input: GroupInput): void {
    this.claimId(input.id);
    if (input.parent !== undefined) this.requireGroup(input.parent);
    this.scene.groups.push({ ...input });
  }

  addNode(input: NodeInput): void {
    this.claimId(input.id);
    if (input.group !== undefined) this.requireGroup(input.group);
    if (input.icon !== undefined && !resolveIcon(input.icon)) {
      throw new SceneError(
        `Unknown icon "${input.icon}". Use a Lucide name like "lucide:database" or a Simple Icons name like "simple-icons:react".`,
      );
    }
    if (input.line !== undefined && input.file === undefined) {
      throw new SceneError(`Node "${input.id}" has a line but no file.`);
    }
    this.scene.nodes.push(stripUndefined({ ...input }));
  }

  addEdge(input: EdgeInput): string {
    for (const end of [input.from, input.to]) {
      if (!this.isConnectable(end)) {
        throw new SceneError(
          `There is no node, group, part or image "${end}". Add it before connecting it.`,
        );
      }
    }
    const id = this.uniqueId(`${input.from}->${input.to}`);
    this.scene.edges.push(stripUndefined({ id, ...input }));
    return id;
  }

  addPart(input: PartInput): void {
    this.claimId(input.id);
    if (!this.parts.has(input.type)) {
      const suggestions = this.parts.search(input.type, 5).map((p) => p.type);
      throw new SceneError(
        `Unknown part type "${input.type}".` +
          (suggestions.length
            ? ` Did you mean: ${suggestions.join(", ")}?`
            : " Use search_parts to find one."),
      );
    }
    if (input.group !== undefined) this.requireGroup(input.group);
    this.scene.parts.push(stripUndefined({ ...input }));
  }

  connect(input: WireInput): string {
    const from = this.resolvePinRef(input.from);
    const to = this.resolvePinRef(input.to);
    const id = this.uniqueId(`${from.part}.${from.pin}->${to.part}.${to.pin}`);
    this.scene.wires.push(stripUndefined({ id, from, to, color: input.color, label: input.label }));
    return id;
  }

  addLabel(input: LabelInput): string {
    const part = this.scene.parts.find((p) => p.id === input.target);
    const image = this.scene.images.find((i) => i.id === input.target);
    const node = this.scene.nodes.find((n) => n.id === input.target);
    if (!part && !image && !node) {
      throw new SceneError(`There is no part, image or node "${input.target}" to label.`);
    }
    let anchor = input.anchor;
    if (anchor !== undefined && part) {
      const pin = this.parts.resolvePin(part.type, anchor);
      if (!pin) throw new SceneError(this.unknownPinMessage(part.id, part.type, anchor));
      anchor = pin.name;
    }
    if (anchor !== undefined && image && !image.regions[anchor]) {
      const known = Object.keys(image.regions);
      throw new SceneError(
        `Image "${image.id}" has no region "${anchor}".` +
          (known.length ? ` Known regions: ${known.join(", ")}.` : " Run locate first."),
      );
    }
    if (anchor !== undefined && node) {
      throw new SceneError("Node labels cannot have an anchor.");
    }
    const id = this.uniqueId(`label-${input.target}${anchor ? `-${anchor}` : ""}`);
    this.scene.labels.push(stripUndefined({ id, target: input.target, anchor, text: input.text }));
    return id;
  }

  addImage(image: SceneImage): void {
    this.claimId(image.id);
    this.scene.images.push(image);
  }

  updateImageRegions(id: string, regions: SceneImage["regions"]): boolean {
    const image = this.scene.images.find((i) => i.id === id);
    if (!image) return false;
    Object.assign(image.regions, regions);
    return true;
  }

  addFigure(input: SceneFigure): void {
    this.claimId(input.id);
    if (input.group !== undefined) this.requireGroup(input.group);
    const s = input.spec;
    try {
      if (s.kind === "plot") {
        if (!s.fns.length && !s.curves.length && !s.points.length && !s.arrows.length)
          throw new SceneError(
            `Plot "${input.id}" has nothing to draw. Add fn, curve, point or arrow lines.`,
          );
        for (const sl of s.sliders) {
          if (!/^[A-Za-z]\w*$/.test(sl.name) || ["x", "t", "e", "pi"].includes(sl.name))
            throw new SceneError(
              `Slider name "${sl.name}" is not allowed; use a letter like a, k or w.`,
            );
          if (!(sl.max > sl.min)) throw new SceneError(`Slider "${sl.name}" needs min < max.`);
        }
        validatePlot(s);
      }
      if (s.kind === "chart" && !s.rows.length)
        throw new SceneError(`Chart "${input.id}" has no data rows. Add lines like "Q1 12".`);
      if (s.kind === "template") {
        if (!s.items.length)
          throw new SceneError(
            `The ${s.layout} "${input.id}" has no entries. Add one line per entry.`,
          );
        if (s.layout === "cycle" && s.items.length < 2)
          throw new SceneError(`Cycle "${input.id}" needs at least two entries.`);
        if (s.layout === "venn") {
          if (s.sets.length < 2 || s.sets.length > 3)
            throw new SceneError(`Venn "${input.id}" needs two or three "set <id> <label>" lines.`);
          for (const item of s.items)
            for (const set of item.sets ?? [])
              if (!s.sets.some((x) => x.id === set))
                throw new SceneError(`Venn "${input.id}" has no set "${set}".`);
        }
      }
      if (s.kind === "draw") {
        if (!s.shapes.length)
          throw new SceneError(`Drawing "${input.id}" is empty. Add lines like "circle 50,50 20".`);
        for (const slider of s.sliders) {
          if (["x", "t", "e", "pi"].includes(slider.name))
            throw new SceneError(
              `Slider name "${slider.name}" is not allowed; use a letter like a, k or w.`,
            );
          if (!(slider.max > slider.min))
            throw new SceneError(`Slider "${slider.name}" needs min < max.`);
        }
        for (const shape of s.shapes) {
          if (!shape.along) continue;
          const path = shape.along.path;
          if (!s.shapes.some((other) => other.name === path && !other.along))
            throw new SceneError(`Drawing "${input.id}" has no shape "${path}" to move along.`);
        }
        const names = new Set<string>();
        for (const shape of s.shapes) {
          if (!shape.name) continue;
          if (names.has(shape.name))
            throw new SceneError(
              `Drawing "${input.id}" uses the shape name "${shape.name}" twice.`,
            );
          names.add(shape.name);
        }
      }
      if (s.kind === "seq") {
        if (!s.items.length) throw new SceneError(`Sequence "${input.id}" has no messages.`);
        const known = new Set(s.actors.map((a) => a.id));
        for (const it of s.items) {
          const ends = it.t === "msg" ? [it.from, it.to] : it.over;
          for (const e of ends)
            if (!known.has(e))
              throw new SceneError(`Sequence "${input.id}" has no participant "${e}".`);
        }
      }
      if (["array", "list", "stack", "queue"].includes(s.kind) && "pointers" in s) {
        for (const p of s.pointers) this.claimStateName(p.name, input.id);
      }
    } catch (error) {
      if (error instanceof ExprError)
        throw new SceneError(`Figure "${input.id}": ${error.message}`);
      throw error;
    }
    this.scene.figures.push(input);
  }

  addStep(input: StepInput): number {
    const known = this.allIds();
    const figures = new Map(this.scene.figures.map((f) => [f.id, f]));
    const missing = input.highlight.filter((id) => {
      if (known.has(id)) return false;
      // Figure parts: a[2], tree[14], seq[3]; pointer names highlight their arrow.
      const part = /^([A-Za-z][\w-]*)\[([^\]]+)\]$/.exec(id);
      const owner = part && figures.get(part[1]!);
      if (owner && owner.spec.kind === "draw")
        return !owner.spec.shapes.some((shape) => shape.name === part![2]);
      if (owner && owner.spec.kind === "template") {
        const number = Number(part![2]);
        return !(Number.isInteger(number) && number >= 1 && number <= owner.spec.items.length);
      }
      if (owner) return false;
      return !this.scene.figures.some((f) => stateNames(f).slice(1).includes(id));
    });
    if (missing.length) {
      throw new SceneError(
        `Cannot highlight unknown ids: ${missing.join(", ")}. Edge ids look like "from->to", figure parts like "a[2]".`,
      );
    }
    for (const [name, value] of Object.entries(input.set ?? {})) this.checkAssignment(name, value);
    this.scene.steps.push(stripUndefined({ ...input }));
    return this.scene.steps.length;
  }

  /** A step assignment must name a slider, data structure or pointer and fit it. */
  private checkAssignment(name: string, value: string): void {
    for (const f of this.scene.figures) {
      const s = f.spec;
      if (s.kind === "template" && f.id === name) {
        if (!/^\d+$/.test(value.trim()))
          throw new SceneError(
            `Step sets ${name}=${value}; use the number of entries to show, like ${name}=2.`,
          );
        return;
      }
      if (s.kind === "plot" || s.kind === "draw") {
        const slider = s.sliders.find((x) => x.name === name);
        if (!slider && s.kind === "draw" && f.id === name) {
          if (!/^\d+$/.test(value.trim()))
            throw new SceneError(
              `Step sets ${name}=${value}; a drawing's stage is a whole number like ${name}=2.`,
            );
          return;
        }
        if (!slider) continue;
        let v: number;
        try {
          v = evaluate(value);
        } catch {
          throw new SceneError(`Step sets ${name}=${value}, but a slider value must be a number.`);
        }
        if (v < slider.min || v > slider.max)
          throw new SceneError(
            `Step sets ${name}=${value}, outside the slider range ${slider.min}..${slider.max}.`,
          );
        return;
      }
      if (s.kind === "tree" && f.id === name) {
        try {
          parseTree(value);
        } catch (e) {
          throw new SceneError(`Step sets ${name}: ${(e as Error).message}`);
        }
        return;
      }
      if ("pointers" in s) {
        if (f.id === name) {
          parseValues(value);
          return;
        }
        if (s.pointers.some((p) => p.name === name)) {
          if (!/^-?\d+$/.test(value.trim()))
            throw new SceneError(
              `Step sets pointer ${name}=${value}; use an index like ${name}=2.`,
            );
          return;
        }
      }
    }
    throw new SceneError(
      `Step sets "${name}", which is no slider, data structure, pointer or drawing. Assignments look like a=2 (slider), arr=1,2,3 (values), i=2 (pointer) or pic=2 (stage of a drawing).`,
    );
  }

  private readonly stateOwners = new Map<string, string>();

  private claimStateName(name: string, figure: string): void {
    if (this.allIds().has(name) || this.stateOwners.has(name))
      throw new SceneError(`Pointer name "${name}" in "${figure}" is already used; pick another.`);
    this.stateOwners.set(name, figure);
  }

  /** Ids of every addressable element, including generated edge ids. */
  allIds(): Set<string> {
    const s = this.scene;
    return new Set([
      ...s.nodes.map((x) => x.id),
      ...s.groups.map((x) => x.id),
      ...s.parts.map((x) => x.id),
      ...s.images.map((x) => x.id),
      ...s.edges.map((x) => x.id),
      ...s.wires.map((x) => x.id),
      ...s.labels.map((x) => x.id),
      ...s.figures.map((x) => x.id),
    ]);
  }

  isEmpty(): boolean {
    const s = this.scene;
    return (
      s.nodes.length + s.parts.length + s.images.length + s.groups.length + s.figures.length === 0
    );
  }

  private resolvePinRef(ref: string): PinRef {
    const dot = ref.indexOf(".");
    if (dot <= 0) {
      throw new SceneError(`"${ref}" is not a pin reference. Use "partId.pin", e.g. "uno.D13".`);
    }
    const partId = ref.slice(0, dot);
    const pinName = ref.slice(dot + 1);
    const part = this.scene.parts.find((p) => p.id === partId);
    if (!part)
      throw new SceneError(`There is no part "${partId}". Place it with place_part first.`);
    const pin = this.parts.resolvePin(part.type, pinName);
    if (!pin) throw new SceneError(this.unknownPinMessage(partId, part.type, pinName));
    return { part: partId, pin: pin.name };
  }

  private unknownPinMessage(partId: string, type: string, pin: string): string {
    const names = this.parts.pins(type).map((p) => p.name);
    return `Part "${partId}" (${type}) has no pin "${pin}". Pins: ${names.join(", ")}.`;
  }

  private isConnectable(id: string): boolean {
    const s = this.scene;
    return [s.nodes, s.groups, s.parts, s.images, s.figures].some((list) =>
      list.some((x) => x.id === id),
    );
  }

  private requireGroup(id: string): void {
    if (!this.scene.groups.some((g) => g.id === id)) {
      throw new SceneError(`There is no group "${id}". Add it with add_group first.`);
    }
  }

  private claimId(id: string): void {
    if (!ID_PATTERN.test(id)) {
      throw new SceneError(
        `Invalid id "${id}". Use letters, digits, "_" or "-", starting with a letter (no dots).`,
      );
    }
    if (this.allIds().has(id)) throw new SceneError(`The id "${id}" is already used.`);
  }

  private uniqueId(base: string): string {
    const ids = this.allIds();
    if (!ids.has(base)) return base;
    let n = 2;
    while (ids.has(`${base}#${n}`)) n++;
    return `${base}#${n}`;
  }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

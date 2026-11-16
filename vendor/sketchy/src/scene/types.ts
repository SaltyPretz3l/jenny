import type { FigureState, SceneFigure } from "../figures/types.js";

/**
 * A scene describes *what* to draw, never *where*.
 * Positions and sizes are computed by the layout engine, so every element
 * here is pure structure that Claude can fill through tools.
 */

/** Emphasis levels; the renderer maps them to the fixed palette. */
export type Tone = "default" | "accent" | "muted";

export type NodeShape = "box" | "rounded" | "circle" | "cylinder" | "note" | "person" | "text";

export type Direction = "right" | "down";

export type SceneNode = {
  id: string;
  label: string;
  description?: string;
  /** Absolute path of a source file; makes the node clickable. */
  file?: string;
  line?: number;
  group?: string;
  /** Iconify name, e.g. "lucide:database" or "simple-icons:react". */
  icon?: string;
  shape?: NodeShape;
  tone?: Tone;
};

export type SceneEdge = {
  id: string;
  from: string;
  to: string;
  label?: string;
  style?: "solid" | "dashed";
  tone?: Tone;
  bidirectional?: boolean;
};

export type SceneGroup = {
  id: string;
  label: string;
  parent?: string;
  description?: string;
};

export type ScenePart = {
  id: string;
  /** Catalog type, e.g. "arduino-uno" or "led". */
  type: string;
  label?: string;
  /** Visual variant, e.g. { color: "red" } for an LED. */
  props?: Record<string, string>;
  group?: string;
};

export type PinRef = { part: string; pin: string };

export type WireColor =
  "red" | "black" | "blue" | "green" | "yellow" | "orange" | "purple" | "gray" | "white";

export type SceneWire = {
  id: string;
  from: PinRef;
  to: PinRef;
  color?: WireColor;
  label?: string;
};

export type SceneLabel = {
  id: string;
  /** Id of a part, image or node. */
  target: string;
  /** Pin name of a part or region name of an image. */
  anchor?: string;
  text: string;
};

export type Region = { x: number; y: number; width: number; height: number };

export type Attribution = {
  title: string;
  author: string;
  license: string;
  licenseUrl?: string;
  sourceUrl: string;
  provider: string;
};

export type SceneImage = {
  id: string;
  /** Data URL, so the viewer never needs network access. */
  src: string;
  width: number;
  height: number;
  caption?: string;
  attribution: Attribution;
  /** Named regions in image pixels, usually found by grounding. */
  regions: Record<string, Region>;
};

export type SceneStep = {
  title: string;
  text?: string;
  /** Ids of any scene elements to emphasize in this step; figure parts as "a[2]". */
  highlight: string[];
  /** Slider values, data structure contents and pointer positions this step sets. */
  set?: FigureState;
};

export type Scene = {
  title?: string;
  subtitle?: string;
  /** Main flow direction; when unset the layout picks the more readable one. */
  direction?: Direction;
  nodes: SceneNode[];
  edges: SceneEdge[];
  groups: SceneGroup[];
  parts: ScenePart[];
  wires: SceneWire[];
  labels: SceneLabel[];
  images: SceneImage[];
  figures: SceneFigure[];
  steps: SceneStep[];
};

export function emptyScene(): Scene {
  return {
    nodes: [],
    edges: [],
    groups: [],
    parts: [],
    wires: [],
    labels: [],
    images: [],
    figures: [],
    steps: [],
  };
}

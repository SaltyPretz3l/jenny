import type {
  SceneEdge,
  SceneGroup,
  SceneImage,
  SceneLabel,
  SceneNode,
  ScenePart,
  SceneStep,
  SceneWire,
} from "./types.js";

import type { Primitive, SceneFigure } from "../figures/types.js";

/**
 * A scene after layout: every element carries concrete geometry in
 * scene pixels. Produced by the server, consumed by the viewer.
 */

export type Point = { x: number; y: number };

export type Rect = { x: number; y: number; width: number; height: number };

export type TextBox = Rect & { lines: string[] };

export type IconData = { body: string; width: number; height: number };

export type LaidOutNode = SceneNode &
  Rect & {
    lines: string[];
    iconData?: IconData;
    /** Editor deep link built from `file` and `line`. */
    link?: string;
  };

export type LaidOutGroup = SceneGroup & Rect;

export type LaidOutEdge = SceneEdge & {
  points: Point[];
  labelBox?: TextBox;
};

export type PlacedPin = { name: string; x: number; y: number; signals: string[] };

export type LaidOutPart = ScenePart &
  Rect & {
    title: string;
    svg: string;
    /** Pin positions relative to the part's top-left corner. */
    pins: PlacedPin[];
    captionBox?: TextBox;
  };

export type LaidOutWire = SceneWire & { points: Point[] };

export type LaidOutLabel = SceneLabel &
  TextBox & {
    anchorPoint: Point;
    /** Point on the text box where the leader line starts. */
    leaderStart: Point;
  };

export type LaidOutImage = SceneImage &
  Rect & {
    /** Display pixels per image pixel. */
    scale: number;
    captionBox?: TextBox;
    attributionBox: TextBox;
  };

export type LaidOutFigure = SceneFigure &
  Rect & {
    /** The figure as the overview shows it, for renderers that cannot lay figures out. */
    prims: Primitive[];
    /** Per step, when the step changes the figure: its primitives then. */
    stepPrims?: (Primitive[] | null)[];
  };

export type LaidOutScene = {
  kind: "scene";
  /** The flow the layout used; a follow-up keeps it. */
  direction?: "right" | "down";
  width: number;
  height: number;
  title?: TextBox;
  subtitle?: TextBox;
  groups: LaidOutGroup[];
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  parts: LaidOutPart[];
  wires: LaidOutWire[];
  labels: LaidOutLabel[];
  images: LaidOutImage[];
  figures: LaidOutFigure[];
  steps: SceneStep[];
};

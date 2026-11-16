/**
 * Figures are self-contained drawings placed in a scene like a node: function
 * plots, charts, sequence diagrams and data structures. Claude writes their
 * content (expressions, numbers, messages, values); Sketchy lays them out.
 *
 * Every figure lays itself out into drawing primitives in figure-local
 * pixels. The viewer, the PNG renderer and the terminal all paint the same
 * primitives, each in its own medium.
 */

/** Semantic colors; each surface maps them to its palette. */
export type Ink =
  | "ink"
  | "soft"
  | "muted"
  | "grid"
  | "card"
  | "accent"
  | "blue"
  | "red"
  | "s0"
  | "s1"
  | "s2"
  | "s3"
  | "s4"
  | "s5";

type Common = {
  /** Step highlights address primitives by key, e.g. "a[2]" or "s[3]". */
  key?: string;
  /** Primitives sharing a move id travel together when a step changes the figure. */
  move?: string;
};

export type Primitive = Common &
  (
    | {
        t: "rect";
        x: number;
        y: number;
        w: number;
        h: number;
        stroke?: Ink | "none";
        fill?: Ink;
        /** Hachure for marker fills, solid otherwise. */
        hatch?: boolean;
        radius?: number;
        dashed?: boolean;
        width?: number;
      }
    | {
        t: "line";
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        stroke?: Ink;
        dashed?: boolean;
        width?: number;
        /** Arrowheads at the end or both ends. */
        arrow?: "end" | "both";
      }
    | {
        t: "poly";
        points: [number, number][];
        stroke?: Ink;
        width?: number;
        dashed?: boolean;
        /** A wide translucent marker stroke under the line. */
        marker?: boolean;
        arrow?: "end" | "both";
        /** Joins the last point to the first. */
        closed?: boolean;
        fill?: Ink;
        hatch?: boolean;
        /** Hand wobble; dense curves need less than a few straight strokes. */
        rough?: number;
      }
    | {
        t: "area";
        points: [number, number][];
        fill: Ink;
        hatch?: boolean;
        opacity?: number;
      }
    | { t: "circle"; cx: number; cy: number; r: number; stroke?: Ink | "none"; fill?: Ink }
    | {
        t: "ellipse";
        cx: number;
        cy: number;
        rx: number;
        ry: number;
        stroke?: Ink;
        fill?: Ink;
        hatch?: boolean;
        dashed?: boolean;
        width?: number;
      }
    | {
        t: "wedge";
        cx: number;
        cy: number;
        r: number;
        /** Radians, clockwise from 12 o'clock. */
        from: number;
        to: number;
        fill: Ink;
      }
    | {
        t: "icon";
        x: number;
        y: number;
        size: number;
        /** Iconify SVG body and its viewBox size. */
        body: string;
        vw: number;
        vh: number;
        color?: Ink;
      }
    | {
        t: "text";
        x: number;
        y: number;
        text: string;
        size: number;
        color?: Ink;
        anchor?: "start" | "middle" | "end";
        /** Where `y` sits on the text: its top, middle or baseline. */
        baseline?: "top" | "middle" | "bottom";
        weight?: number;
      }
  );

export type Range = { min: string; max: string };

export type Slider = {
  name: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  /** Driven by steps only, without a control for the reader. */
  hidden?: boolean;
};

export type PlotSpec = {
  kind: "plot";
  x?: Range;
  y?: Range;
  xLabel?: string;
  yLabel?: string;
  /** Equal units on both axes (circles stay round). */
  equal?: boolean;
  fns: { expr: string; label?: string; tone?: "accent" | "muted"; dashed?: boolean }[];
  curves: {
    x: string;
    y: string;
    from: string;
    to: string;
    label?: string;
    tone?: "accent" | "muted";
  }[];
  points: { x: string; y: string; label?: string; tone?: "accent" | "muted" }[];
  sliders: Slider[];
  areas: { expr: string; from: string; to: string; label?: string }[];
  vlines: { at: string; label?: string }[];
  hlines: { at: string; label?: string }[];
  arrows: { x1: string; y1: string; x2: string; y2: string; label?: string; tone?: "accent" }[];
};

export type ChartType = "bar" | "hbar" | "line" | "area" | "pie" | "scatter";

export type ChartSpec = {
  kind: "chart";
  type: ChartType;
  series: string[];
  rows: { label: string; values: number[]; tone?: "accent" | "muted" }[];
  xLabel?: string;
  yLabel?: string;
  unit?: string;
};

export type SeqSpec = {
  kind: "seq";
  actors: { id: string; label: string; person?: boolean }[];
  items: (
    | { t: "msg"; from: string; to: string; text: string; dashed?: boolean; tone?: "accent" }
    | { t: "note"; over: string[]; text: string }
  )[];
};

export type DataKind = "array" | "list" | "stack" | "queue";

export type DataSpec = {
  kind: DataKind;
  values: string[];
  pointers: { name: string; at: number }[];
};

export type TreeNode = { value: string; children: (TreeNode | null)[] };

export type TreeSpec = { kind: "tree"; root: TreeNode | null };

export type MarkKind = "angle" | "measure" | "brace" | "axes" | "grid";

/** Numbers here are expressions over the drawing's sliders, as text. */
export type DrawGeometry =
  | { g: "ellipse"; cx: string; cy: string; rx: string; ry: string }
  | { g: "rect"; x: string; y: string; w: string; h: string }
  | { g: "path"; points: [string, string][]; closed: boolean; smooth: boolean }
  /** Degrees, 0 pointing right, counter-clockwise. */
  | { g: "arc"; cx: string; cy: string; r: string; from: string; to: string }
  | { g: "text"; x: string; y: string; text: string }
  /** A ready-made thing from the library; x,y is its centre. */
  | {
      g: "object";
      type: string;
      x: string;
      y: string;
      size: string;
      rotate?: string;
      flip?: boolean;
    }
  /**
   * Geometry helpers: angle (vertex in the middle), measure (dimension line),
   * brace, axes (origin, width, height) and grid (top left, width, height).
   */
  | {
      g: "mark";
      mark: MarkKind;
      points: [string, string][];
      size?: string;
      step?: string;
      names?: [string, string];
    }
  /** Resolved by the layout, because the viewer has no icon sets. */
  | {
      g: "icon";
      x: string;
      y: string;
      size: string;
      icon: string;
      data?: { body: string; width: number; height: number };
    };

export type DrawShape = {
  /** Lets steps highlight the shape as "figure[name]". */
  name?: string;
  /** Placed by Sketchy, clear of the other shapes and labels. */
  label?: string;
  /** The shape appears once a step has set the figure to this stage. */
  stage?: number;
  /** Rides on a named shape's outline; `at` runs from 0 to 1. */
  along?: { path: string; at: string };
  /** Shifts the whole shape by this offset, usually driven by a slider. */
  move?: { dx: string; dy: string };
  tone?: "accent" | "muted";
  stroke?: Ink;
  fill?: Ink;
  hatch?: boolean;
  dashed?: boolean;
  width?: number;
  size?: number;
  arrow?: "end" | "both";
  geo: DrawGeometry;
};

/** A free drawing; shape coordinates are in canvas units, y pointing down. */
export type DrawSpec = {
  kind: "draw";
  width: number;
  height: number;
  shapes: DrawShape[];
  sliders: Slider[];
};

export type TemplateKind =
  "timeline" | "cycle" | "pyramid" | "funnel" | "venn" | "matrix" | "mindmap";

export type TemplateItem = {
  label: string;
  detail?: string;
  tone?: "accent" | "muted";
  /** Timeline: the date or period. */
  when?: string;
  /** Mind map: distance from the centre. */
  depth?: number;
  /** Venn: the sets this entry belongs to. */
  sets?: string[];
  /** Matrix: the cells after the row label. */
  cells?: string[];
};

/** A familiar explanation shape; only its contents are given. */
export type TemplateSpec = {
  kind: "template";
  layout: TemplateKind;
  items: TemplateItem[];
  sets: { id: string; label: string }[];
  cols: string[];
};

/** A structural formula, written in SMILES; Sketchy works out the 2D layout. */
export type MoleculeSpec = {
  kind: "molecule";
  smiles: string;
  /** Every atom written out with its hydrogens, not just the skeleton. */
  full?: boolean;
};

/** A map of the world or one region, with countries coloured and places marked. */
export type MapSpec = {
  kind: "map";
  region: string;
  countries: { name: string; fill?: Ink; hatch?: boolean; label?: string }[];
  places: { name?: string; lat: number; lon: number; label?: string; tone?: "accent" | "muted" }[];
  routes: {
    from: [number, number];
    to: [number, number];
    label?: string;
    dashed?: boolean;
    name?: string;
  }[];
};

export type FigureSpec =
  | PlotSpec
  | ChartSpec
  | SeqSpec
  | DataSpec
  | TreeSpec
  | DrawSpec
  | TemplateSpec
  | MoleculeSpec
  | MapSpec;

export type SceneFigure = {
  id: string;
  title?: string;
  group?: string;
  tone?: "accent" | "muted";
  spec: FigureSpec;
};

/**
 * Values steps assign: slider values, data structure contents and pointer
 * positions, by name. Raw text; each figure reads what concerns it.
 */
export type FigureState = Record<string, string>;

export type FigureLayout = { width: number; height: number; prims: Primitive[] };

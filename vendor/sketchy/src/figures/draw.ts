import { FIG_FONT, bounds, measure, round1, shift, titlePrims } from "./common.js";
import { compile, evaluate, ExprError, isReservedName, splitTop, type Env } from "./expr.js";
import { OBJECTS } from "./objects.js";
import { sliderEnv } from "./plot.js";
import type {
  DrawGeometry,
  DrawShape,
  DrawSpec,
  FigureLayout,
  FigureState,
  Ink,
  MarkKind,
  Primitive,
} from "./types.js";

/**
 * Free drawing: shapes on a small canvas of their own, for what boxes and
 * arrows cannot show (atoms, forces, cells, geometry, a bike). Coordinates
 * are local to the canvas and may be expressions over the drawing's sliders.
 * Where the drawing sits in the scene and where its labels go is still
 * decided here.
 *
 *   draw atom 100x100: A helium atom
 *   slider a 0..360 = 0 hidden
 *   circle orbit 50,50 38 --dashed
 *   circle core 50,50 9 fill=accent ~ Nucleus
 *   circle e 50+38*cos(a*pi/180),50-38*sin(a*pi/180) 3 fill=blue ~ Electron
 *   object person 20,80 30 ~ Observer
 *   repeat i=0..7: circle 50+45*cos(i*pi/4),50+45*sin(i*pi/4) 1
 */

/** Length of the canvas' longer side, in pixels. */
const CANVAS_PX = 520;
const LABEL_SIZE = FIG_FONT.label;
const MAX_REPEAT = 300;

const COLORS: Record<string, Ink> = {
  black: "ink",
  ink: "ink",
  gray: "muted",
  grey: "muted",
  white: "card",
  accent: "accent",
  yellow: "s0",
  blue: "s1",
  red: "s2",
  green: "s3",
  purple: "s4",
  orange: "s5",
};

const KINDS = new Set([
  "circle",
  "ellipse",
  "rect",
  "line",
  "arrow",
  "curve",
  "shape",
  "blob",
  "arc",
  "text",
  "object",
  "icon",
  "angle",
  "measure",
  "brace",
  "axes",
  "grid",
]);

const MARK_USAGE: Record<MarkKind, string> = {
  angle: "angle [name] <x>,<y> <corner x>,<y> <x>,<y> [radius]   (the corner in the middle)",
  measure: "measure [name] <x>,<y> <x>,<y> [offset]",
  brace: "brace [name] <x>,<y> <x>,<y> [depth]",
  axes: "axes [name] <origin x>,<y> <width> <height> [ticks=10] [~ x name | y name]",
  grid: "grid [name] <x>,<y> <width> <height> [step]   (x,y is the top left corner)",
};

export const OBJECT_NAMES = Object.keys(OBJECTS);

export const emptyDraw = (width: number, height: number): DrawSpec => ({
  kind: "draw",
  width,
  height,
  shapes: [],
  sliders: [],
});

type Token = { text: string; end: number };

/** Splits on spaces outside parentheses; "50, 40" and "( 1, 2 )" stay one token. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let depth = 0;
  const flush = (end: number) => {
    if (current) tokens.push({ text: current, end });
    current = "";
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (/\s/.test(c) && depth <= 0) {
      const next = source.slice(i).trimStart()[0];
      if (current.endsWith(",") || next === ",") continue;
      flush(i);
      continue;
    }
    current += c;
  }
  flush(source.length);
  return tokens;
}

function pointParts(token: string): [string, string] | undefined {
  let parts = splitTop(token);
  if (parts.length !== 2 && token.startsWith("(") && token.endsWith(")"))
    parts = splitTop(token.slice(1, -1));
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : undefined;
}

const OPTION = /^(fill|hatch|color|width|size|stage|rotate|along|move|ticks|step)=(.+)$/;
const FLAGS = new Set(["--dashed", "dashed", "arrow", "both", "flip", "!accent", "!muted"]);

/** Puts loop values in for the bare loop variable of a coordinate. */
function bindVariables(text: string, vars: Env | Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(vars))
    out = out.replace(new RegExp(`(?<![A-Za-z_])${name}(?![A-Za-z_0-9(])`, "g"), `(${value})`);
  return out;
}

/**
 * "let B = 84-12*a" names a sub-expression for the lines after it. It is put
 * in where it is used, so it follows sliders like any coordinate.
 */
const lets = new WeakMap<DrawSpec, Record<string, string>>();
const letsOf = (spec: DrawSpec): Record<string, string> => {
  let found = lets.get(spec);
  if (!found) lets.set(spec, (found = {}));
  return found;
};

/** One line inside a draw block; false when the line does not belong to it. */
export function parseDrawLine(
  spec: DrawSpec,
  rawLine: string,
  fail: (why: string) => never,
  vars: Env = {},
): boolean {
  // {i+1} works anywhere, labels and names included.
  const line = rawLine.replace(/\{([^{}]+)\}/g, (whole, source: string) => {
    if (!Object.keys(vars).length) return whole;
    try {
      return String(round1(evaluate(source, vars)));
    } catch {
      return whole;
    }
  });
  const head = line.split(/\s+/)[0] ?? "";
  if (head === "repeat") {
    const m = line.match(/^repeat\s+([A-Za-z]\w*)\s*(?:=|\s)\s*(-?\d+)\.\.(-?\d+)\s*:\s*(.+)$/);
    if (!m) return fail("expected: repeat i=0..5: <shape line>");
    const [from, to] = [Number(m[2]), Number(m[3])];
    if (Math.abs(to - from) >= MAX_REPEAT)
      return fail(`a repeat can run at most ${MAX_REPEAT} times`);
    const direction = to >= from ? 1 : -1;
    for (let v = from; direction > 0 ? v <= to : v >= to; v += direction) {
      // The body keeps its own braces until this loop's value is known.
      const body = rawLine.slice(rawLine.indexOf(":") + 1).trim();
      if (!parseDrawLine(spec, body, fail, { ...vars, [m[1]!]: v }))
        return fail("a repeat needs a shape line after the colon");
    }
    return true;
  }
  if (head === "let") {
    const m = line.match(/^let\s+([A-Za-z_]\w*)\s*=\s*(.+)$/);
    if (!m) return fail("expected: let <name> = <expression>, e.g. let w = 84-12*a");
    const [, name, body] = m as unknown as [string, string, string];
    if (isReservedName(name) || spec.sliders.some((s) => s.name === name))
      return fail(`"${name}" is already a slider, function or constant; pick another name`);
    const source = bindVariables(bindVariables(body, vars), letsOf(spec));
    try {
      compile(
        source,
        spec.sliders.map((s) => s.name),
      );
    } catch (error) {
      if (error instanceof ExprError) return fail(`let ${name}: ${error.message}`);
      throw error;
    }
    letsOf(spec)[name] = source;
    return true;
  }
  if (head === "slider") {
    const m = line.match(
      /^slider\s+([A-Za-z]\w*)\s+(\S+?)\.\.(\S+?)(?:\s*=\s*(\S+?))?(\s+hidden)?$/,
    );
    if (!m) return fail("expected: slider <name> <min>..<max> [= <value>] [hidden]");
    const value = (text: string) => {
      try {
        return evaluate(text);
      } catch (error) {
        return fail((error as Error).message);
      }
    };
    const min = value(m[2]!);
    spec.sliders.push({
      name: m[1]!,
      min,
      max: value(m[3]!),
      value: m[4] !== undefined ? value(m[4]) : min,
      ...(m[5] ? { hidden: true } : {}),
    });
    return true;
  }

  const separator = line.indexOf(" ~ ");
  const main = separator < 0 ? line : line.slice(0, separator);
  const label = separator < 0 ? undefined : line.slice(separator + 3).trim() || undefined;
  const tokens = tokenize(main);
  const kind = tokens[0]?.text ?? "";
  if (!KINDS.has(kind)) return false;

  const expr = (text: string, what: string): string => {
    const source = bindVariables(bindVariables(text, vars), letsOf(spec));
    try {
      compile(
        source,
        spec.sliders.map((s) => s.name),
      );
      return source;
    } catch (error) {
      if (error instanceof ExprError) return fail(`${what}: ${error.message}`);
      throw error;
    }
  };
  const point = (text: string): [string, string] => {
    const parts = pointParts(text);
    if (!parts) return fail(`"${text}" is not a point; write x,y`);
    return [expr(parts[0], "x"), expr(parts[1], "y")];
  };

  let rest = tokens.slice(1);
  let objectType: string | undefined;
  if (kind === "object") {
    objectType = rest[0]?.text;
    if (!objectType || !OBJECTS[objectType])
      return fail(`unknown object "${objectType ?? ""}"; use ${OBJECT_NAMES.join(", ")}`);
    rest = rest.slice(1);
  }
  let name: string | undefined;
  const first = rest[0]?.text;
  if (first && /^[A-Za-z_][\w-]*$/.test(first) && !OPTION.test(first) && !FLAGS.has(first)) {
    const named =
      kind === "text" || kind === "icon" ? !!rest[1] && !!pointParts(rest[1].text) : true;
    if (named) {
      name = first;
      rest = rest.slice(1);
    }
  }

  const shape: Omit<DrawShape, "geo"> = {};
  if (name) shape.name = name;
  if (label) shape.label = label;
  let rotate: string | undefined;
  let flip = false;
  let step: string | undefined;
  const constant = (value: string, what: string): number => {
    try {
      return evaluate(bindVariables(bindVariables(value, vars), letsOf(spec)));
    } catch (error) {
      return fail(`${what}: ${(error as Error).message}`);
    }
  };
  const applyOption = (key: string, value: string) => {
    switch (key) {
      case "stage":
        if (!/^\d+$/.test(value)) fail("stage must be a whole number");
        shape.stage = Number(value);
        return;
      case "width":
        shape.width = constant(value, "width");
        return;
      case "size":
        shape.size = constant(value, "size");
        return;
      case "rotate":
        rotate = expr(value, "rotate");
        return;
      case "ticks":
      case "step":
        step = expr(value, key);
        return;
      case "along": {
        const m = value.match(/^([A-Za-z_][\w-]*)@(.+)$/);
        if (!m) return fail("expected: along=<path name>@<position from 0 to 1>");
        shape.along = { path: m[1]!, at: expr(m[2]!, "along") };
        return;
      }
      case "move": {
        const parts = pointParts(value);
        if (!parts) return fail("expected: move=<dx>,<dy>, e.g. move=40*t,0");
        shape.move = { dx: expr(parts[0], "move"), dy: expr(parts[1], "move") };
        return;
      }
    }
    const ink = COLORS[value];
    if (!ink) return fail(`unknown color "${value}"; use ${Object.keys(COLORS).join(", ")}`);
    if (key === "color") shape.stroke = ink;
    else {
      shape.fill = ink;
      if (key === "hatch") shape.hatch = true;
    }
  };

  if (kind === "text") {
    const at = rest[0];
    if (!at || !pointParts(at.text)) return fail("expected: text [name] <x>,<y> <words>");
    const [x, y] = point(at.text);
    const words = main
      .slice(at.end)
      .trim()
      .split(/\s+/)
      .filter((word) => {
        const option = word.match(/^(size|stage|color|move|along)=(.+)$/);
        if (option) {
          applyOption(option[1]!, option[2]!);
          return false;
        }
        if (word === "!accent" || word === "!muted") {
          shape.tone = word.slice(1) as "accent" | "muted";
          return false;
        }
        return true;
      });
    if (!words.length) return fail("expected: text [name] <x>,<y> <words>");
    delete shape.label;
    spec.shapes.push({ ...shape, geo: { g: "text", x, y, text: words.join(" ") } });
    return true;
  }

  const geometry: string[] = [];
  for (const token of rest) {
    const option = token.text.match(OPTION);
    if (option) applyOption(option[1]!, option[2]!);
    else if (token.text === "--dashed" || token.text === "dashed") shape.dashed = true;
    else if (token.text === "arrow") shape.arrow = shape.arrow ?? "end";
    else if (token.text === "both") shape.arrow = "both";
    else if (token.text === "flip") flip = true;
    else if (token.text === "!accent" || token.text === "!muted")
      shape.tone = token.text.slice(1) as "accent" | "muted";
    else geometry.push(token.text);
  }

  const need = (count: number, usage: string) => {
    if (geometry.length !== count) fail(`expected: ${usage}`);
  };
  switch (kind) {
    case "object": {
      if (geometry.length < 1 || geometry.length > 2)
        return fail("expected: object <type> [name] <x>,<y> [size]");
      const [x, y] = point(geometry[0]!);
      spec.shapes.push({
        ...shape,
        geo: {
          g: "object",
          type: objectType!,
          x,
          y,
          size: geometry[1] !== undefined ? expr(geometry[1], "size") : "20",
          ...(rotate ? { rotate } : {}),
          ...(flip ? { flip } : {}),
        },
      });
      return true;
    }
    case "icon": {
      const at = geometry.findIndex((token) => pointParts(token));
      const others = geometry.filter((_, index) => index !== at);
      const iconName = others.find((token) => !/^[\d.]+$/.test(token));
      if (at < 0 || !iconName) return fail("expected: icon [name] <x>,<y> <lucide name> [size]");
      const [x, y] = point(geometry[at]!);
      spec.shapes.push({
        ...shape,
        geo: {
          g: "icon",
          x,
          y,
          size: others.find((token) => /^[\d.]+$/.test(token)) ?? "16",
          icon: iconName.includes(":") ? iconName : `lucide:${iconName}`,
        },
      });
      return true;
    }
    case "circle": {
      need(2, "circle [name] <x>,<y> <radius>");
      const [cx, cy] = point(geometry[0]!);
      const r = expr(geometry[1]!, "radius");
      spec.shapes.push({ ...shape, geo: { g: "ellipse", cx, cy, rx: r, ry: r } });
      return true;
    }
    case "ellipse": {
      need(3, "ellipse [name] <x>,<y> <rx> <ry>");
      const [cx, cy] = point(geometry[0]!);
      spec.shapes.push({
        ...shape,
        geo: { g: "ellipse", cx, cy, rx: expr(geometry[1]!, "rx"), ry: expr(geometry[2]!, "ry") },
      });
      return true;
    }
    case "rect": {
      // "rect 10,10 30,20" is a natural way to write the size too.
      const pair = geometry[1] ? pointParts(geometry[1]) : undefined;
      if (geometry.length === 2 && pair) geometry.splice(1, 1, ...pair);
      need(3, "rect [name] <x>,<y> <width> <height>   (x,y is the top left corner)");
      const [x, y] = point(geometry[0]!);
      spec.shapes.push({
        ...shape,
        geo: { g: "rect", x, y, w: expr(geometry[1]!, "width"), h: expr(geometry[2]!, "height") },
      });
      return true;
    }
    case "angle":
    case "measure":
    case "brace":
    case "axes":
    case "grid": {
      const usage = MARK_USAGE[kind];
      const corners = kind === "angle" ? 3 : kind === "measure" || kind === "brace" ? 2 : 1;
      const sizes = kind === "axes" || kind === "grid" ? 2 : 0;
      const optional = kind === "grid" ? 1 : sizes ? 0 : 1;
      const count = geometry.length - corners - sizes;
      if (count < 0 || count > optional || geometry.slice(0, corners).some((t) => !pointParts(t)))
        return fail(`expected: ${usage}`);
      const points = geometry.slice(0, corners).map(point);
      if (sizes)
        points.push([expr(geometry[corners]!, "width"), expr(geometry[corners + 1]!, "height")]);
      const extra = geometry[corners + sizes];
      const geo: DrawGeometry = { g: "mark", mark: kind, points };
      if (kind === "grid") {
        if (extra) step = expr(extra, "step");
      } else if (extra)
        geo.size = expr(extra, kind === "angle" ? "radius" : kind === "brace" ? "depth" : "offset");
      if (step) geo.step = step;
      // Axes name their ends instead of carrying one placed label.
      if (kind === "axes" && shape.label) {
        const [x, y] = shape.label.split("|").map((s) => s.trim());
        geo.names = [x ?? "", y ?? ""];
        delete shape.label;
      }
      spec.shapes.push({ ...shape, geo });
      return true;
    }
    case "arc": {
      need(4, "arc [name] <x>,<y> <radius> <from°> <to°>");
      const [cx, cy] = point(geometry[0]!);
      spec.shapes.push({
        ...shape,
        geo: {
          g: "arc",
          cx,
          cy,
          r: expr(geometry[1]!, "radius"),
          from: expr(geometry[2]!, "from"),
          to: expr(geometry[3]!, "to"),
        },
      });
      return true;
    }
    default: {
      const closed = kind === "shape" || kind === "blob";
      if (geometry.length < (closed ? 3 : 2))
        return fail(`${kind} needs at least ${closed ? 3 : 2} points, each written x,y`);
      if (kind === "arrow" && !shape.arrow) shape.arrow = "end";
      spec.shapes.push({
        ...shape,
        geo: {
          g: "path",
          points: geometry.map(point),
          closed,
          smooth: kind === "curve" || kind === "blob",
        },
      });
      return true;
    }
  }
}

type Pt = [number, number];
type Box = { x: number; y: number; w: number; h: number };

/** Geometry with its expressions worked out, in canvas units. */
type Solved =
  | { g: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { g: "rect"; x: number; y: number; w: number; h: number }
  | { g: "path"; points: Pt[]; closed: boolean; smooth: boolean }
  | { g: "arc"; cx: number; cy: number; r: number; from: number; to: number };

/** A Catmull-Rom spline through the points, sampled into a dense polyline. */
function spline(points: Pt[], closed: boolean): Pt[] {
  const n = points.length;
  const at = (i: number) =>
    closed ? points[(i + n) % n]! : points[Math.max(0, Math.min(n - 1, i))]!;
  const out: Pt[] = [];
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let k = 0; k < 14; k++) {
      const t = k / 14;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b +
          (c - a) * t +
          (2 * a - 5 * b + 4 * c - d) * t * t +
          (3 * b - a - 3 * c + d) * t * t * t);
      out.push([round1(f(p0[0], p1[0], p2[0], p3[0])), round1(f(p0[1], p1[1], p2[1], p3[1]))]);
    }
  }
  if (!closed) out.push(points[n - 1]!);
  return out;
}

/** Points every few pixels along a polyline, to tell what a label would cross. */
function densify(points: Pt[], closed: boolean): Pt[] {
  const out: Pt[] = [];
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
    for (let k = 0; k < steps; k++)
      out.push([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]);
  }
  if (closed && points.length) out.push(points[0]!);
  if (!closed && points.length) out.push(points[points.length - 1]!);
  return out;
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const steps = Math.max(24, Math.ceil(Math.max(rx, ry) / 2));
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as Pt;
  });
}

function arcPoints(cx: number, cy: number, r: number, from: number, to: number): Pt[] {
  const steps = Math.max(6, Math.ceil(Math.abs(to - from) / 6));
  const toRad = Math.PI / 180;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = (from + ((to - from) * i) / steps) * toRad;
    return [cx + Math.cos(a) * r, cy - Math.sin(a) * r] as Pt;
  });
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

type Drawn = {
  prims: Primitive[];
  outline: Pt[];
  closed: boolean;
  /** What the label is placed around. */
  around: Box;
  /** Other spots an open line may carry its label. */
  alternatives: Box[];
};

type Style = Omit<DrawShape, "geo">;

function drawSolved(geo: Solved, shape: Style, scale: number): Drawn {
  const muted = shape.tone === "muted";
  const stroke: Ink = shape.stroke ?? (muted ? "muted" : "ink");
  const dashed = shape.dashed || undefined;
  const width = shape.width;
  const fill = shape.fill ?? (shape.tone === "accent" ? ("accent" as const) : undefined);
  const hatch = shape.hatch || undefined;
  switch (geo.g) {
    case "ellipse": {
      const [cx, cy, rx, ry] = [geo.cx * scale, geo.cy * scale, geo.rx * scale, geo.ry * scale];
      return {
        prims: [{ t: "ellipse", cx, cy, rx, ry, stroke, fill, hatch, dashed, width }],
        outline: densify(ellipsePoints(cx, cy, rx, ry), true),
        closed: true,
        around: { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 },
        alternatives: [],
      };
    }
    case "rect": {
      const [x, y, w, h] = [geo.x * scale, geo.y * scale, geo.w * scale, geo.h * scale];
      const corners: Pt[] = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
      return {
        prims: [{ t: "rect", x, y, w, h, stroke, fill, hatch, dashed, width }],
        outline: densify(corners, true),
        closed: true,
        around: { x, y, w, h },
        alternatives: [],
      };
    }
    case "arc":
    case "path": {
      let points: Pt[];
      const closed = geo.g === "path" && geo.closed;
      if (geo.g === "arc") {
        points = arcPoints(geo.cx * scale, geo.cy * scale, geo.r * scale, geo.from, geo.to).map(
          ([x, y]) => [round1(x), round1(y)] as Pt,
        );
      } else {
        const scaled = geo.points.map(([x, y]) => [x * scale, y * scale] as Pt);
        points = geo.smooth ? spline(scaled, geo.closed) : scaled;
      }
      const smooth = geo.g === "arc" || geo.smooth;
      const prim: Primitive = {
        t: "poly",
        points,
        stroke,
        dashed,
        width: width ?? 1.8,
        closed: closed || undefined,
        fill: closed ? fill : undefined,
        hatch: closed ? hatch : undefined,
        arrow: shape.arrow,
        marker: shape.tone === "accent" && !closed ? true : undefined,
        rough: smooth || points.length > 16 ? 0.5 : 1,
      };
      const outline = densify(points, closed);
      if (closed)
        return { prims: [prim], outline, closed, around: bounds([prim]), alternatives: [] };
      const spot = (p: Pt): Box => ({ x: p[0] - 2, y: p[1] - 2, w: 4, h: 4 });
      return {
        prims: [prim],
        outline,
        closed,
        around: spot(outline[Math.floor(outline.length / 2)]!),
        alternatives: [spot(points[0]!), spot(points[points.length - 1]!)],
      };
    }
  }
}

/** Object parts are parsed once from their text. */
const parsedObjects = new Map<string, DrawShape[]>();

function objectParts(type: string): DrawShape[] {
  let parts = parsedObjects.get(type);
  if (!parts) {
    const spec = emptyDraw(100, 100);
    for (const line of OBJECTS[type] ?? [])
      parseDrawLine(spec, line, (why) => {
        throw new Error(`Object "${type}": ${why}`);
      });
    parts = spec.shapes;
    parsedObjects.set(type, parts);
  }
  return parts;
}

const num = (source: string, env: Env): number => {
  try {
    const value = compile(source, Object.keys(env))(env);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
};

/** A shape's geometry in plain numbers, or undefined for text, objects and icons. */
function solve(shape: DrawShape, env: Env): Solved | undefined {
  const g = shape.geo;
  const n = (source: string) => num(source, env);
  switch (g.g) {
    case "ellipse":
      return { g: "ellipse", cx: n(g.cx), cy: n(g.cy), rx: n(g.rx), ry: n(g.ry) };
    case "rect":
      return { g: "rect", x: n(g.x), y: n(g.y), w: n(g.w), h: n(g.h) };
    case "path":
      return {
        g: "path",
        points: g.points.map(([x, y]) => [n(x), n(y)]),
        closed: g.closed,
        smooth: g.smooth,
      };
    case "arc":
      return { g: "arc", cx: n(g.cx), cy: n(g.cy), r: n(g.r), from: n(g.from), to: n(g.to) };
    default:
      return undefined;
  }
}

/** Moves a part of an object onto the canvas; turned parts become polylines. */
function placePart(
  geo: Solved,
  at: { x: number; y: number; k: number; degrees: number; flip: boolean },
): Solved {
  const { x, y, k, degrees, flip } = at;
  if (!degrees && !flip) {
    switch (geo.g) {
      case "ellipse":
        return { ...geo, cx: x + geo.cx * k, cy: y + geo.cy * k, rx: geo.rx * k, ry: geo.ry * k };
      case "rect":
        return { ...geo, x: x + geo.x * k, y: y + geo.y * k, w: geo.w * k, h: geo.h * k };
      case "arc":
        return { ...geo, cx: x + geo.cx * k, cy: y + geo.cy * k, r: geo.r * k };
      case "path":
        return { ...geo, points: geo.points.map(([px, py]) => [x + px * k, y + py * k] as Pt) };
    }
  }
  const a = (degrees * Math.PI) / 180;
  const map = ([px, py]: Pt): Pt => {
    const fx = (flip ? -px : px) * k;
    const fy = py * k;
    return [x + fx * Math.cos(a) - fy * Math.sin(a), y + fx * Math.sin(a) + fy * Math.cos(a)];
  };
  switch (geo.g) {
    case "ellipse":
      return {
        g: "path",
        points: ellipsePoints(geo.cx, geo.cy, geo.rx, geo.ry).map(map),
        closed: true,
        smooth: false,
      };
    case "rect":
      return {
        g: "path",
        points: (
          [
            [geo.x, geo.y],
            [geo.x + geo.w, geo.y],
            [geo.x + geo.w, geo.y + geo.h],
            [geo.x, geo.y + geo.h],
          ] as Pt[]
        ).map(map),
        closed: true,
        smooth: false,
      };
    case "arc":
      return {
        g: "path",
        points: arcPoints(geo.cx, geo.cy, geo.r, geo.from, geo.to).map(map),
        closed: false,
        smooth: false,
      };
    case "path":
      return { ...geo, points: geo.points.map(map) };
  }
}

/** Angle arcs, dimension lines, braces, axes and grids, in canvas pixels. */
function drawMark(
  g: Extract<DrawShape["geo"], { g: "mark" }>,
  shape: DrawShape,
  env: Env,
  scale: number,
): Drawn {
  const n = (source: string) => num(source, env);
  const pts = g.points.map(([x, y]) => [n(x), n(y)] as Pt);
  const ink: Ink =
    shape.stroke ?? (shape.tone === "muted" ? "muted" : shape.tone === "accent" ? "accent" : "ink");
  const width = shape.width ?? 1.6;
  const prims: Primitive[] = [];
  const outline: Pt[] = [];
  const px = ([x, y]: Pt): Pt => [x * scale, y * scale];
  const line = (a: Pt, b: Pt, extra: Partial<Extract<Primitive, { t: "line" }>> = {}) => {
    const [p, q] = [px(a), px(b)];
    prims.push({
      t: "line",
      x1: p[0],
      y1: p[1],
      x2: q[0],
      y2: q[1],
      stroke: ink,
      width,
      dashed: shape.dashed || undefined,
      ...extra,
    });
    outline.push(...densify([p, q], false));
  };
  const curve = (points: Pt[], smooth: boolean) => {
    const scaled = points.map(px);
    const drawnPoints = smooth ? spline(scaled, false) : scaled;
    prims.push({
      t: "poly",
      points: drawnPoints,
      stroke: ink,
      width,
      rough: 0.5,
      dashed: shape.dashed || undefined,
    });
    outline.push(...densify(drawnPoints, false));
  };
  const spotAt = ([x, y]: Pt, w = 4, h = 4): Box => ({
    x: x * scale - w / 2,
    y: y * scale - h / 2,
    w,
    h,
  });
  const unit = (a: Pt, b: Pt): Pt => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  };
  const text = (
    x: number,
    y: number,
    words: string,
    anchor: "start" | "end",
    baseline: "top" | "middle",
  ) =>
    prims.push({
      t: "text",
      x: x * scale,
      y: y * scale,
      text: words,
      size: LABEL_SIZE,
      anchor,
      baseline,
      color: ink === "accent" ? "accent" : "ink",
    });

  switch (g.mark) {
    case "angle": {
      const [a, corner, c] = pts as [Pt, Pt, Pt];
      const r = g.size ? n(g.size) : 8;
      // Degrees counter-clockwise from the right, as arc uses them; the canvas runs y down.
      const deg = (p: Pt) => (Math.atan2(-(p[1] - corner[1]), p[0] - corner[0]) * 180) / Math.PI;
      const from = deg(a);
      const sweep = ((deg(c) - from + 540) % 360) - 180;
      if (Math.abs(Math.abs(sweep) - 90) < 1) {
        // A right angle gets the little square.
        const [ua, uc] = [unit(corner, a), unit(corner, c)];
        const s = r * 0.7;
        curve(
          [
            [corner[0] + ua[0] * s, corner[1] + ua[1] * s],
            [corner[0] + (ua[0] + uc[0]) * s, corner[1] + (ua[1] + uc[1]) * s],
            [corner[0] + uc[0] * s, corner[1] + uc[1] * s],
          ],
          false,
        );
      } else curve(arcPoints(corner[0], corner[1], r, from, from + sweep), false);
      // The label sits inside the angle, on its bisector.
      const mid = ((from + sweep / 2) * Math.PI) / 180;
      const label = shape.label
        ? { w: measure(shape.label, LABEL_SIZE) + 12, h: LABEL_SIZE * 1.3 + 8 }
        : { w: 4, h: 4 };
      const reach = r * scale + Math.max(label.w, label.h) / 2;
      const at: Pt = [
        corner[0] + (Math.cos(mid) * reach) / scale,
        corner[1] - (Math.sin(mid) * reach) / scale,
      ];
      return {
        prims,
        outline,
        closed: !!shape.label,
        around: spotAt(at, label.w, label.h),
        alternatives: [],
      };
    }
    case "measure": {
      const [a, b] = pts as [Pt, Pt];
      const offset = g.size ? n(g.size) : 0;
      const u = unit(a, b);
      const side: Pt = [-u[1], u[0]];
      const shifted = (p: Pt, k: number): Pt => [p[0] + side[0] * k, p[1] + side[1] * k];
      if (offset) {
        const dir = Math.sign(offset);
        line(shifted(a, dir), shifted(a, offset + dir * 2), { stroke: "muted", width: 1 });
        line(shifted(b, dir), shifted(b, offset + dir * 2), { stroke: "muted", width: 1 });
      }
      line(shifted(a, offset), shifted(b, offset), { arrow: "both" });
      const middle = shifted([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], offset);
      return { prims, outline, closed: false, around: spotAt(middle), alternatives: [] };
    }
    case "brace": {
      const [a, b] = pts as [Pt, Pt];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const depth = g.size ? n(g.size) : Math.min(6, length * 0.12);
      const u = unit(a, b);
      const side: Pt = [-u[1], u[0]];
      const at = (along: number, out: number): Pt => [
        a[0] + u[0] * length * along + side[0] * depth * out,
        a[1] + u[1] * length * along + side[1] * depth * out,
      ];
      // A small gap keeps the brace off the line it measures.
      const g0 = 0.35;
      curve(
        [
          at(0, g0),
          at(0.06, g0 + 0.45),
          at(0.25, g0 + 0.5),
          at(0.44, g0 + 0.55),
          at(0.5, g0 + 1),
          at(0.56, g0 + 0.55),
          at(0.75, g0 + 0.5),
          at(0.94, g0 + 0.45),
          at(1, g0),
        ],
        true,
      );
      return { prims, outline, closed: false, around: spotAt(at(0.5, g0 + 1.6)), alternatives: [] };
    }
    case "axes": {
      const [origin, [w, h]] = pts as [Pt, Pt];
      line(origin, [origin[0] + w, origin[1]], { arrow: "end" });
      line(origin, [origin[0], origin[1] - h], { arrow: "end" });
      const step = g.step ? n(g.step) : 0;
      if (step > 0) {
        const tick = 1.4;
        for (let k = step; k < w - step * 0.4 && k / step < 100; k += step)
          line([origin[0] + k, origin[1] - tick], [origin[0] + k, origin[1] + tick], { width: 1 });
        for (let k = step; k < h - step * 0.4 && k / step < 100; k += step)
          line([origin[0] - tick, origin[1] - k], [origin[0] + tick, origin[1] - k], { width: 1 });
      }
      if (g.names?.[0]) text(origin[0] + w, origin[1] + 2.5, g.names[0], "end", "top");
      if (g.names?.[1]) text(origin[0] + 3, origin[1] - h + 1, g.names[1], "start", "middle");
      return {
        prims,
        outline,
        closed: false,
        around: spotAt([origin[0] + w / 2, origin[1]]),
        alternatives: [],
      };
    }
    case "grid": {
      const [corner, [w, h]] = pts as [Pt, Pt];
      const step = g.step ? n(g.step) : 10;
      const lines = (count: number, at: (k: number) => [Pt, Pt]) => {
        for (let k = 0; k <= count && k <= 200; k++) {
          const [p, q] = at(k).map(px) as [Pt, Pt];
          prims.push({
            t: "line",
            x1: p[0],
            y1: p[1],
            x2: q[0],
            y2: q[1],
            stroke: shape.stroke ?? "grid",
            width: 0.8,
          });
        }
      };
      if (step > 0) {
        lines(Math.floor(w / step + 1e-9), (k) => [
          [corner[0] + k * step, corner[1]],
          [corner[0] + k * step, corner[1] + h],
        ]);
        lines(Math.floor(h / step + 1e-9), (k) => [
          [corner[0], corner[1] + k * step],
          [corner[0] + w, corner[1] + k * step],
        ]);
      }
      // A grid is background: labels may sit on it.
      return {
        prims,
        outline: [],
        closed: false,
        around: { ...spotAt(corner), w: w * scale, h: h * scale },
        alternatives: [],
      };
    }
  }
}

function drawShape(shape: DrawShape, env: Env, scale: number): Drawn | undefined {
  const g = shape.geo;
  if (g.g === "text") return undefined;
  if (g.g === "mark") return drawMark(g, shape, env, scale);
  if (g.g === "icon") {
    if (!g.data) return undefined;
    const size = num(g.size, env) * scale;
    const [x, y] = [num(g.x, env) * scale - size / 2, num(g.y, env) * scale - size / 2];
    const prim: Primitive = {
      t: "icon",
      x,
      y,
      size,
      body: g.data.body,
      vw: g.data.width,
      vh: g.data.height,
      color: shape.stroke,
    };
    const corners: Pt[] = [
      [x, y],
      [x + size, y],
      [x + size, y + size],
      [x, y + size],
    ];
    return {
      prims: [prim],
      outline: densify(corners, true),
      closed: false,
      around: { x, y, w: size, h: size },
      alternatives: [],
    };
  }
  if (g.g === "object") {
    const at = {
      x: num(g.x, env),
      y: num(g.y, env),
      k: num(g.size, env) / 100,
      degrees: g.rotate ? num(g.rotate, env) : 0,
      flip: !!g.flip,
    };
    const prims: Primitive[] = [];
    const outline: Pt[] = [];
    for (const part of objectParts(g.type)) {
      const solved = solve(part, {});
      if (!solved) continue;
      const style: Style = {
        ...part,
        stroke: shape.stroke ?? part.stroke,
        // A chosen fill recolors the parts that have one.
        fill: part.fill && shape.fill ? shape.fill : part.fill,
        hatch: part.fill ? shape.hatch || part.hatch : undefined,
        dashed: shape.dashed || part.dashed,
        tone: shape.tone === "muted" ? "muted" : undefined,
      };
      const drawn = drawSolved(placePart(solved, at), style, scale);
      prims.push(...drawn.prims);
      outline.push(...drawn.outline);
    }
    return { prims, outline, closed: false, around: bounds(prims), alternatives: [] };
  }
  const solved = solve(shape, env);
  return solved && drawSolved(solved, shape, scale);
}

/** The point a fraction of the way along a polyline. */
function pointAlong(outline: Pt[], fraction: number): Pt {
  if (outline.length < 2) return outline[0] ?? [0, 0];
  const lengths = outline
    .slice(1)
    .map((p, i) => Math.hypot(p[0] - outline[i]![0], p[1] - outline[i]![1]));
  let remaining = lengths.reduce((a, b) => a + b, 0) * Math.max(0, Math.min(1, fraction));
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]! || i === lengths.length - 1) {
      const t = lengths[i]! ? Math.min(1, remaining / lengths[i]!) : 0;
      const [a, b] = [outline[i]!, outline[i + 1]!];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= lengths[i]!;
  }
  return outline[outline.length - 1]!;
}

/** Every shape on the canvas for these slider values. */
function drawAll(spec: DrawSpec, env: Env, scale: number): (Drawn | undefined)[] {
  const drawn = spec.shapes.map((shape) => drawShape(shape, env, scale));
  const offset = (i: number, dx: number, dy: number) => {
    const d = drawn[i]!;
    drawn[i] = {
      ...d,
      prims: shift(d.prims, dx, dy),
      outline: d.outline.map(([x, y]) => [x + dx, y + dy] as Pt),
      around: { ...d.around, x: d.around.x + dx, y: d.around.y + dy },
    };
  };
  // A moved shape is still one rigid piece, so its strokes keep their hand-drawn look.
  spec.shapes.forEach((shape, i) => {
    if (shape.move && drawn[i])
      offset(i, num(shape.move.dx, env) * scale, num(shape.move.dy, env) * scale);
  });
  const paths = new Map<string, Pt[]>();
  spec.shapes.forEach((shape, i) => {
    if (shape.name && !shape.along && drawn[i]) paths.set(shape.name, drawn[i]!.outline);
  });
  spec.shapes.forEach((shape, i) => {
    const d = drawn[i];
    const outline = shape.along && paths.get(shape.along.path);
    if (!d || !shape.along || !outline) return;
    const [dx, dy] = pointAlong(outline, num(shape.along.at, env));
    offset(i, dx, dy);
  });
  return drawn;
}

type Leader = [number, number, number, number];

/** Where a label goes: inside its shape if it fits, else the free spot beside it. */
function placeLabel(
  size: { w: number; h: number },
  drawn: Drawn,
  taken: Box[],
  outline: Pt[],
  canvas: { w: number; h: number },
): { box: Box; leader?: Leader } {
  type Candidate = { box: Box; leader?: Leader; rank: number };
  const candidates: Candidate[] = [];
  const b = drawn.around;
  if (drawn.closed && size.w + 10 < b.w && size.h + 6 < b.h)
    candidates.push({
      box: { x: b.x + (b.w - size.w) / 2, y: b.y + (b.h - size.h) / 2, ...size },
      rank: 0,
    });
  [b, ...drawn.alternatives].forEach((a, spot) => {
    [8, 34].forEach((gap, ring) => {
      const midX = a.x + a.w / 2;
      const midY = a.y + a.h / 2;
      const sides: [Box, Leader][] = [
        [
          { x: a.x + a.w + gap, y: midY - size.h / 2, ...size },
          [a.x + a.w + gap - 3, midY, a.x + a.w + 2, midY],
        ],
        [
          { x: a.x - gap - size.w, y: midY - size.h / 2, ...size },
          [a.x - gap + 3, midY, a.x - 2, midY],
        ],
        [
          { x: midX - size.w / 2, y: a.y - gap - size.h, ...size },
          [midX, a.y - gap + 2, midX, a.y - 2],
        ],
        [
          { x: midX - size.w / 2, y: a.y + a.h + gap, ...size },
          [midX, a.y + a.h + gap - 2, midX, a.y + a.h + 2],
        ],
      ];
      sides.forEach(([box, leader], side) => {
        const rank = 1 + side * 0.1 + spot * 2 + ring * 4;
        candidates.push(ring ? { box, leader, rank } : { box, rank });
      });
    });
  });
  const cost = (c: Candidate) => {
    const { box } = c;
    let total = c.rank;
    for (const other of taken) if (overlaps(box, other)) total += 1000;
    for (const [x, y] of outline)
      if (x > box.x - 3 && x < box.x + box.w + 3 && y > box.y - 3 && y < box.y + box.h + 3)
        total += 6;
    // The figure can grow, so leaving the canvas is cheaper than crossing a line.
    const outside =
      Math.max(0, -box.x) +
      Math.max(0, -box.y) +
      Math.max(0, box.x + box.w - canvas.w) +
      Math.max(0, box.y + box.h - canvas.h);
    total += outside * 0.15;
    return total;
  };
  return candidates.reduce((best, c) => (cost(c) < cost(best) ? c : best));
}

export function layoutDraw(
  id: string,
  spec: DrawSpec,
  title: string | undefined,
  state: FigureState,
  live?: Env,
): FigureLayout {
  const { placed, restShapes, labels, canvas } = composeDraw(id, spec, state, live);
  const stage = /^\d+$/.test(state[id] ?? "") ? Number(state[id]) : undefined;
  const titleOut: Primitive[] = [];
  const titleHeight = titlePrims(title, 0, titleOut);
  // With sliders the box is measured at rest and over the whole canvas, so the
  // figure stays put while things glide; labels were placed at rest anyway.
  let box = bounds(placed.map((p) => p.prim));
  if (spec.sliders.length) {
    box = bounds([...restShapes, ...labels.map((l) => l.prim)]);
    const right = Math.max(box.x + box.w, canvas.w);
    const bottom = Math.max(box.y + box.h, canvas.h);
    const x = Math.min(box.x, 0);
    const y = Math.min(box.y, 0);
    box = { x, y, w: right - x, h: bottom - y };
  }
  const titleWidth = title ? measure(title, FIG_FONT.title) : 0;
  const visible = placed
    .filter((p) => stage === undefined || (spec.shapes[p.index]!.stage ?? 0) <= stage)
    .map((p) => p.prim);
  return {
    width: Math.ceil(Math.max(box.w, titleWidth)),
    height: Math.ceil(box.h + titleHeight),
    prims: [...titleOut, ...shift(visible, -box.x, titleHeight - box.y)],
  };
}

/** What a reader would trip over, for the model to fix: text on text, shapes off the canvas. */
export function drawIssues(
  id: string,
  spec: DrawSpec,
  states: { state: FigureState; when: string }[],
): string[] {
  const issues = new Set<string>();
  const describe = (index: number) => {
    const shape = spec.shapes[index]!;
    const kind =
      shape.geo.g === "mark" ? shape.geo.mark : shape.geo.g === "path" ? "line" : shape.geo.g;
    if (shape.name) return `${id}[${shape.name}]`;
    // Unnamed shapes go by number, which edit_sketch can remove: "remove p[3]".
    const ref = `${id}[${index + 1}]`;
    if (shape.geo.g === "text") return `text "${shape.geo.text}" (${ref})`;
    return shape.label ? `${kind} "${shape.label}" (${ref})` : `the ${kind} ${ref}`;
  };
  for (const { state, when } of states) {
    const { placed, canvas } = composeDraw(id, spec, state);
    const stage = /^\d+$/.test(state[id] ?? "") ? Number(state[id]) : undefined;
    const visible = placed.filter(
      (p) => stage === undefined || (spec.shapes[p.index]!.stage ?? 0) <= stage,
    );
    const texts = visible
      .filter((p) => p.prim.t === "text")
      .map((p) => ({ text: (p.prim as { text: string }).text, box: bounds([p.prim]) }));
    for (let i = 0; i < texts.length; i++)
      for (let j = i + 1; j < texts.length; j++) {
        const [a, b] = [texts[i]!.box, texts[j]!.box];
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (w > 0 && h > 0 && w * h > 0.3 * Math.min(a.w * a.h, b.w * b.h))
          issues.add(`"${texts[i]!.text}" and "${texts[j]!.text}" overlap ${when}`);
      }
    // Labels may grow the figure; shapes drawn past the canvas usually are a slip.
    const slack = Math.max(canvas.w, canvas.h) * 0.03;
    const byShape = new Map<number, Primitive[]>();
    for (const p of visible) {
      const shape = spec.shapes[p.index]!;
      const isLabel =
        p.prim.t === "text" &&
        shape.geo.g !== "text" &&
        (p.prim as { text: string }).text === shape.label;
      if (isLabel || (p.prim.t === "line" && p.prim.stroke === "soft")) continue;
      byShape.set(p.index, [...(byShape.get(p.index) ?? []), p.prim]);
    }
    for (const [index, prims] of byShape) {
      const b = bounds(prims);
      if (
        b.x < -slack ||
        b.y < -slack ||
        b.x + b.w > canvas.w + slack ||
        b.y + b.h > canvas.h + slack
      )
        issues.add(
          `${describe(index)} reaches past the ${spec.width}x${spec.height} canvas ${when}`,
        );
    }
  }
  return [...issues];
}

function composeDraw(id: string, spec: DrawSpec, state: FigureState, live?: Env) {
  const scale = CANVAS_PX / Math.max(spec.width, spec.height);
  const canvas = { w: spec.width * scale, h: spec.height * scale };
  const env = sliderEnv(spec, state, live);
  const restEnv = sliderEnv(spec, {});
  const drawn = drawAll(spec, env, scale);
  // Labels are placed once, for the sliders' start values, and then ride along:
  // otherwise they would hop between spots while a slider moves.
  const rest = spec.sliders.length ? drawAll(spec, restEnv, scale) : drawn;
  const outline = rest.flatMap((d) => d?.outline ?? []);

  const textPrim = (shape: DrawShape, values: Env): Primitive | undefined => {
    if (shape.geo.g !== "text") return undefined;
    const [dx, dy] = shape.move ? [num(shape.move.dx, values), num(shape.move.dy, values)] : [0, 0];
    return {
      t: "text",
      x: (num(shape.geo.x, values) + dx) * scale,
      y: (num(shape.geo.y, values) + dy) * scale,
      text: shape.geo.text,
      size: shape.size ?? LABEL_SIZE,
      anchor: "middle",
      baseline: "middle",
      color: shape.stroke ?? (shape.tone === "muted" ? "muted" : "ink"),
      weight: shape.tone === "accent" ? 700 : undefined,
    };
  };

  // Text placed by hand comes first, so labels keep clear of it.
  const taken: Box[] = [];
  for (const shape of spec.shapes) {
    const prim = textPrim(shape, restEnv);
    if (prim) taken.push(bounds([prim]));
  }

  type Entry = { prim: Primitive; index: number };
  const shapes: Entry[] = [];
  const restShapes: Primitive[] = [];
  const labels: Entry[] = [];
  spec.shapes.forEach((shape, index) => {
    const text = textPrim(shape, env);
    if (text) {
      shapes.push({ prim: text, index });
      restShapes.push(textPrim(shape, restEnv)!);
    }
    const now = drawn[index];
    const before = rest[index];
    if (!now || !before) return;
    for (const prim of now.prims) shapes.push({ prim, index });
    restShapes.push(...before.prims);
    if (!shape.label) return;
    const size = { w: measure(shape.label, LABEL_SIZE), h: LABEL_SIZE * 1.3 };
    const { box, leader } = placeLabel(size, before, taken, outline, canvas);
    taken.push(box);
    const dx = now.around.x + now.around.w / 2 - (before.around.x + before.around.w / 2);
    const dy = now.around.y + now.around.h / 2 - (before.around.y + before.around.h / 2);
    if (leader)
      labels.push({
        prim: {
          t: "line",
          x1: leader[0] + dx,
          y1: leader[1] + dy,
          x2: leader[2] + dx,
          y2: leader[3] + dy,
          stroke: "soft",
          width: 1,
        },
        index,
      });
    labels.push({
      prim: {
        t: "text",
        x: box.x + dx,
        y: box.y + dy,
        text: shape.label,
        size: LABEL_SIZE,
        baseline: "top",
        color: "ink",
      },
      index,
    });
  });

  // Labels go last so no later shape paints over them.
  const placed = [...shapes, ...labels].map(({ prim, index }) => {
    const name = spec.shapes[index]!.name;
    return {
      index,
      prim: {
        ...prim,
        move: `${id}-${index}`,
        ...(name ? { key: `${id}[${name}]` } : {}),
      } as Primitive,
    };
  });
  return { placed, restShapes, labels, canvas };
}

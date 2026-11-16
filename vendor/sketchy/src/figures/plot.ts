/**
 * Function plots: axes with round ticks, sampled curves broken at jumps and
 * asymptotes, parametric curves, shaded areas, points, guide lines, vectors
 * and slider values. Everything is in figure-local pixels.
 */
import { compile, evaluate, ExprError, type Env } from "./expr.js";
import {
  FIG_FONT,
  SERIES,
  fmt,
  measure,
  niceTicks,
  piTicks,
  round1,
  titlePrims,
} from "./common.js";
import type { FigureLayout, FigureState, Ink, PlotSpec, Primitive } from "./types.js";

const BODY_W = 440;
const BODY_H = 300;
const PAD = { left: 46, right: 18, top: 14, bottom: 30 };
const SAMPLES = 260;

/** Slider values: defaults, then step assignments, then live overrides. */
export function sliderEnv(spec: Pick<PlotSpec, "sliders">, state: FigureState, live?: Env): Env {
  const env: Env = {};
  for (const s of spec.sliders) {
    let v = s.value;
    const assigned = state[s.name];
    if (assigned !== undefined) {
      try {
        v = evaluate(assigned);
      } catch {
        // Validated when the scene was built; keep the default otherwise.
      }
    }
    env[s.name] = clamp(live?.[s.name] ?? v, s.min, s.max);
  }
  return env;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Names an expression in a plot may use. */
export function plotNames(spec: PlotSpec, extra: string[] = []): string[] {
  return [...spec.sliders.map((s) => s.name), ...extra];
}

/** Checks every expression once, so errors reach Claude instead of the viewer. */
export function validatePlot(spec: PlotSpec): void {
  const names = plotNames(spec);
  const fail = (what: string, error: unknown): never => {
    throw new ExprError(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const check = (src: string, what: string, extra: string[] = []) => {
    try {
      compile(src, [...names, ...extra]);
    } catch (e) {
      fail(what, e);
    }
  };
  for (const r of [spec.x, spec.y]) if (r) (check(r.min, "range"), check(r.max, "range"));
  for (const f of spec.fns) check(f.expr, "fn", ["x"]);
  for (const c of spec.curves) {
    check(c.x, "curve", ["t"]);
    check(c.y, "curve", ["t"]);
    check(c.from, "curve range");
    check(c.to, "curve range");
  }
  for (const p of spec.points) (check(p.x, "point"), check(p.y, "point"));
  for (const a of spec.areas) {
    check(a.expr, "area", ["x"]);
    check(a.from, "area");
    check(a.to, "area");
  }
  for (const l of [...spec.vlines, ...spec.hlines]) check(l.at, "line");
  for (const a of spec.arrows) for (const v of [a.x1, a.y1, a.x2, a.y2]) check(v, "arrow");
}

type Seg = [number, number][];

function sample(fn: (x: number) => number, x0: number, x1: number): Seg[] {
  const out: Seg[] = [];
  let seg: Seg = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const x = x0 + ((x1 - x0) * i) / SAMPLES;
    const y = fn(x);
    if (Number.isFinite(y)) seg.push([x, y]);
    else if (seg.length) {
      out.push(seg);
      seg = [];
    }
  }
  if (seg.length) out.push(seg);
  return out;
}

/** A y range that shows the curves without letting a pole flatten everything. */
function autoY(segments: Seg[], extra: number[]): [number, number] {
  const ys = [...segments.flat().map(([, y]) => y), ...extra].sort((a, b) => a - b);
  if (!ys.length) return [-1, 1];
  const lo = ys[Math.floor(ys.length * 0.02)]!;
  const hi = ys[Math.ceil(ys.length * 0.98) - 1]!;
  let min = Math.min(lo, ...extra);
  let max = Math.max(hi, ...extra);
  if (max - min < 1e-9) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.12;
  min -= pad;
  max += pad;
  // Keep the x axis in view when it is close.
  if (min > 0 && min < (max - min) * 0.35) min = 0;
  if (max < 0 && -max < (max - min) * 0.35) max = 0;
  return [min, max];
}

export function layoutPlot(
  spec: PlotSpec,
  title: string | undefined,
  state: FigureState,
  live?: Env,
): FigureLayout {
  const env = sliderEnv(spec, state, live);
  const num = (src: string, fallback: number, extra: Env = {}) => {
    try {
      const v = compile(src, [...Object.keys(env), ...Object.keys(extra)])({ ...env, ...extra });
      return Number.isFinite(v) ? v : fallback;
    } catch {
      return fallback;
    }
  };
  const x0 = spec.x ? num(spec.x.min, -5) : -5;
  const x1 = spec.x ? num(spec.x.max, 5) : 5;
  const [xmin, xmax] = x1 > x0 ? [x0, x1] : [-5, 5];

  const fns = spec.fns.map((f) => {
    const c = safe(() => compile(f.expr, [...Object.keys(env), "x"]));
    return { ...f, segs: c ? sample((x) => c({ ...env, x }), xmin, xmax) : [] };
  });
  const curves = spec.curves.map((cv) => {
    const cx = safe(() => compile(cv.x, [...Object.keys(env), "t"]));
    const cy = safe(() => compile(cv.y, [...Object.keys(env), "t"]));
    const t0 = num(cv.from, 0);
    const t1 = num(cv.to, Math.PI * 2);
    const pts: Seg = [];
    if (cx && cy)
      for (let i = 0; i <= SAMPLES; i++) {
        const t = t0 + ((t1 - t0) * i) / SAMPLES;
        const px = cx({ ...env, t });
        const py = cy({ ...env, t });
        if (Number.isFinite(px) && Number.isFinite(py)) pts.push([px, py]);
      }
    return { ...cv, pts };
  });
  const points = spec.points.map((p) => ({ ...p, px: num(p.x, NaN), py: num(p.y, NaN) }));
  const arrows = spec.arrows.map((a) => ({
    ...a,
    v: [num(a.x1, 0), num(a.y1, 0), num(a.x2, 0), num(a.y2, 0)] as const,
  }));

  let ymin: number;
  let ymax: number;
  if (spec.y) {
    ymin = num(spec.y.min, -5);
    ymax = num(spec.y.max, 5);
    if (!(ymax > ymin)) [ymin, ymax] = [-5, 5];
  } else {
    const extra = [
      ...points.flatMap((p) => (Number.isFinite(p.py) ? [p.py] : [])),
      ...curves.flatMap((c) => c.pts.map(([, y]) => y)),
      ...arrows.flatMap((a) => [a.v[1], a.v[3]]),
      ...spec.hlines.map((h) => num(h.at, 0)),
    ];
    [ymin, ymax] = autoY(
      fns.flatMap((f) => f.segs),
      extra,
    );
  }

  const prims: Primitive[] = [];
  const top = titlePrims(title, BODY_W, prims);
  let w = BODY_W - PAD.left - PAD.right;
  let h = BODY_H - PAD.top - PAD.bottom;
  if (spec.equal) {
    // Same pixels per unit on both axes: shrink the longer side.
    const unit = Math.min(w / (xmax - xmin), h / (ymax - ymin));
    w = unit * (xmax - xmin);
    h = unit * (ymax - ymin);
  }
  const left = PAD.left;
  const ox = left;
  const oy = top + PAD.top;
  const X = (x: number) => round1(ox + ((x - xmin) / (xmax - xmin)) * w);
  const Y = (y: number) => round1(oy + h - ((y - ymin) / (ymax - ymin)) * h);
  const inY = (y: number) => y >= ymin - (ymax - ymin) * 0.02 && y <= ymax + (ymax - ymin) * 0.02;

  // Grid and ticks.
  const xt =
    piTicks(xmin, xmax) ?? niceTicks(xmin, xmax, 7).map((v) => ({ value: v, label: fmt(v) }));
  const yt = niceTicks(ymin, ymax, 6).map((v) => ({ value: v, label: fmt(v) }));
  const axisY = ymin <= 0 && ymax >= 0 ? Y(0) : oy + h;
  const axisX = xmin <= 0 && xmax >= 0 ? X(0) : ox;
  for (const t of xt) {
    if (t.value < xmin || t.value > xmax) continue;
    prims.push({
      t: "line",
      x1: X(t.value),
      y1: oy,
      x2: X(t.value),
      y2: oy + h,
      stroke: "grid",
      width: 0.8,
    });
    if (Math.abs(X(t.value) - axisX) > 2 || axisX === ox)
      prims.push({
        t: "text",
        x: X(t.value),
        y: Math.min(axisY + 5, oy + h + 5),
        text: t.label,
        size: FIG_FONT.small,
        color: "soft",
        anchor: "middle",
        baseline: "top",
      });
  }
  for (const t of yt) {
    if (t.value < ymin || t.value > ymax) continue;
    prims.push({
      t: "line",
      x1: ox,
      y1: Y(t.value),
      x2: ox + w,
      y2: Y(t.value),
      stroke: "grid",
      width: 0.8,
    });
    if (Math.abs(Y(t.value) - axisY) > 2 || axisY === oy + h)
      prims.push({
        t: "text",
        x: Math.max(axisX - 6, ox - 6),
        y: Y(t.value),
        text: t.label,
        size: FIG_FONT.small,
        color: "soft",
        anchor: "end",
        baseline: "middle",
      });
  }
  // Axes with arrowheads at the positive ends.
  prims.push({
    t: "line",
    x1: ox,
    y1: axisY,
    x2: ox + w + 8,
    y2: axisY,
    stroke: "ink",
    width: 1.5,
    arrow: "end",
  });
  prims.push({
    t: "line",
    x1: axisX,
    y1: oy + h,
    x2: axisX,
    y2: oy - 8,
    stroke: "ink",
    width: 1.5,
    arrow: "end",
  });
  prims.push({
    t: "text",
    x: ox + w + 10,
    y: axisY + 4,
    text: spec.xLabel ?? "x",
    size: FIG_FONT.label,
    color: "soft",
    anchor: "end",
    baseline: "top",
  });
  prims.push({
    t: "text",
    x: axisX + 8,
    y: oy - 10,
    text: spec.yLabel ?? "y",
    size: FIG_FONT.label,
    color: "soft",
    baseline: "top",
  });

  // Shaded areas under curves.
  for (const a of spec.areas) {
    const c = safe(() => compile(a.expr, [...Object.keys(env), "x"]));
    if (!c) continue;
    const from = Math.max(xmin, num(a.from, xmin));
    const to = Math.min(xmax, num(a.to, xmax));
    if (!(to > from)) continue;
    const base = clamp(0, ymin, ymax);
    const pts: [number, number][] = [[X(from), Y(base)]];
    for (let i = 0; i <= 120; i++) {
      const x = from + ((to - from) * i) / 120;
      const y = c({ ...env, x });
      pts.push([X(x), Y(clamp(Number.isFinite(y) ? y : base, ymin, ymax))]);
    }
    pts.push([X(to), Y(base)]);
    prims.push({ t: "area", points: pts, fill: "s1", hatch: true, opacity: 0.55 });
    if (a.label) {
      const mid = (from + to) / 2;
      const y = c({ ...env, x: mid });
      prims.push({
        t: "text",
        x: X(mid),
        y: Y((clamp(y, ymin, ymax) + base) / 2),
        text: a.label,
        size: FIG_FONT.label,
        anchor: "middle",
        baseline: "middle",
      });
    }
  }

  // Guide lines.
  for (const v of spec.vlines) {
    const x = num(v.at, NaN);
    if (!(x >= xmin && x <= xmax)) continue;
    prims.push({
      t: "line",
      x1: X(x),
      y1: oy,
      x2: X(x),
      y2: oy + h,
      stroke: "soft",
      dashed: true,
      width: 1.3,
    });
    if (v.label)
      prims.push({
        t: "text",
        x: X(x) + 5,
        y: oy + 2,
        text: v.label,
        size: FIG_FONT.small,
        color: "soft",
        baseline: "top",
      });
  }
  for (const l of spec.hlines) {
    const y = num(l.at, NaN);
    if (!(y >= ymin && y <= ymax)) continue;
    prims.push({
      t: "line",
      x1: ox,
      y1: Y(y),
      x2: ox + w,
      y2: Y(y),
      stroke: "soft",
      dashed: true,
      width: 1.3,
    });
    if (l.label)
      prims.push({
        t: "text",
        x: ox + w - 2,
        y: Y(y) - 3,
        text: l.label,
        size: FIG_FONT.small,
        color: "soft",
        anchor: "end",
        baseline: "bottom",
      });
  }

  // Curves: a jump larger than the view breaks the line (poles, tan).
  const labels: { x: number; y: number; text: string; color: Ink }[] = [];
  const colorFor = (i: number, tone?: string): Ink =>
    tone === "muted" ? "muted" : i === 0 ? "ink" : SERIES[(i - 1) % SERIES.length]!;
  const pushCurve = (
    pts: Seg,
    color: Ink,
    tone: string | undefined,
    dashed: boolean | undefined,
    key: string,
  ) => {
    let run: [number, number][] = [];
    const flush = () => {
      if (run.length > 1)
        prims.push({
          t: "poly",
          points: run,
          stroke: color,
          width: tone === "accent" ? 2.6 : 2,
          dashed,
          marker: tone === "accent",
          key,
        });
      run = [];
    };
    let prev: [number, number] | undefined;
    for (const [x, y] of pts) {
      const jump = prev && Math.abs(y - prev[1]) > (ymax - ymin) * 1.5;
      if (jump) flush();
      if (inY(y)) run.push([X(x), Y(y)]);
      else {
        if (run.length) run.push([X(x), Y(clamp(y, ymin, ymax))]);
        flush();
      }
      prev = [x, y];
    }
    flush();
  };
  let series = 0;
  fns.forEach((f, i) => {
    const color = colorFor(series++, f.tone);
    for (const seg of f.segs) pushCurve(seg, color, f.tone, f.dashed, `fn${i}`);
    const last = [...f.segs.flat()].reverse().find(([, y]) => inY(y));
    if (f.label && last) labels.push({ x: X(last[0]), y: Y(last[1]), text: f.label, color });
  });
  curves.forEach((c, i) => {
    const color = colorFor(series++, c.tone);
    pushCurve(c.pts, color, c.tone, false, `curve${i}`);
    const at = c.pts[Math.floor(c.pts.length * 0.15)];
    if (c.label && at) labels.push({ x: X(at[0]), y: Y(at[1]), text: c.label, color });
  });

  // Vectors.
  arrows.forEach((a, i) => {
    const [ax, ay, bx, by] = a.v;
    prims.push({
      t: "line",
      x1: X(ax),
      y1: Y(ay),
      x2: X(bx),
      y2: Y(by),
      stroke: a.tone === "accent" ? "red" : "blue",
      width: 2.4,
      arrow: "end",
      key: `arrow${i}`,
    });
    if (a.label)
      prims.push({
        t: "text",
        x: (X(ax) + X(bx)) / 2 + 6,
        y: (Y(ay) + Y(by)) / 2 - 4,
        text: a.label,
        size: FIG_FONT.label,
        color: a.tone === "accent" ? "red" : "blue",
        baseline: "bottom",
      });
  });

  // Points.
  points.forEach((p, i) => {
    if (!Number.isFinite(p.px) || !Number.isFinite(p.py)) return;
    if (p.px < xmin || p.px > xmax || !inY(p.py)) return;
    const accent = p.tone === "accent";
    prims.push({
      t: "circle",
      cx: X(p.px),
      cy: Y(p.py),
      r: accent ? 6 : 4.5,
      fill: accent ? "accent" : "ink",
      stroke: "ink",
      key: `p${i}`,
    });
    if (p.label)
      prims.push({
        t: "text",
        x: X(p.px) + 9,
        y: Y(p.py) - 4,
        text: p.label,
        size: FIG_FONT.label,
        baseline: "bottom",
        weight: accent ? 700 : undefined,
      });
  });

  // Curve labels, nudged apart vertically and kept inside the plot.
  labels.sort((a, b) => a.y - b.y);
  let lastY = -Infinity;
  for (const l of labels) {
    const y = Math.max(l.y, lastY + 18);
    lastY = y;
    const width = measure(l.text, FIG_FONT.label);
    const x = Math.min(l.x, ox + w - width - 4);
    prims.push({
      t: "text",
      x: Math.max(ox + 4, x),
      y: clamp(y - 6, oy + 2, oy + h - 2),
      text: l.text,
      size: FIG_FONT.label,
      color: l.color,
      baseline: "bottom",
      weight: 700,
    });
  }

  // Slider values, so a still picture says which case it shows.
  if (spec.sliders.length) {
    const text = spec.sliders.map((s) => `${s.name} = ${fmtValue(env[s.name]!)}`).join("   ");
    prims.push({
      t: "text",
      x: ox + 8,
      y: oy + 4,
      text,
      size: FIG_FONT.label,
      color: "blue",
      baseline: "top",
      key: "sliders",
    });
  }

  return { width: BODY_W, height: top + BODY_H, prims };
}

export function fmtValue(v: number): string {
  return String(Number(v.toFixed(Math.abs(v) >= 100 ? 0 : 2)));
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

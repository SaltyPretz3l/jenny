/**
 * Hand-drawn charts from inline numbers: bars (vertical or horizontal),
 * lines, areas, scatter plots and pies, with a legend for several series.
 */
import {
  FIG_FONT,
  SERIES,
  fmt,
  measure,
  niceTicks,
  round1,
  shift as offset,
  titlePrims,
} from "./common.js";
import type { ChartSpec, FigureLayout, Ink, Primitive } from "./types.js";

const PLOT_H = 220;

export function layoutChart(spec: ChartSpec, title: string | undefined): FigureLayout {
  const prims: Primitive[] = [];
  const top = titlePrims(title, 0, prims);
  const body =
    spec.type === "pie"
      ? pie(spec)
      : spec.type === "hbar"
        ? hbar(spec)
        : spec.type === "scatter"
          ? scatter(spec)
          : columns(spec);
  const legend =
    spec.series.length > 1 && spec.type !== "pie" ? legendPrims(spec.series) : undefined;
  let y = top;
  if (legend) {
    prims.push(...offset(legend.prims, 0, y));
    y += legend.height + 6;
  }
  prims.push(...offset(body.prims, 0, y));
  const titleWidth = title ? measure(title, FIG_FONT.title) : 0;
  return {
    width: Math.ceil(Math.max(body.width, legend?.width ?? 0, titleWidth)),
    height: Math.ceil(y + body.height),
    prims,
  };
}

type Part = { prims: Primitive[]; width: number; height: number };

const colorOf = (series: number, tone?: string): Ink =>
  tone === "accent" ? "accent" : tone === "muted" ? "muted" : SERIES[series % SERIES.length]!;

function legendPrims(series: string[]): Part {
  const prims: Primitive[] = [];
  let x = 0;
  series.forEach((name, i) => {
    prims.push({
      t: "rect",
      x,
      y: 3,
      w: 14,
      h: 14,
      fill: SERIES[i % SERIES.length]!,
      hatch: true,
      stroke: "ink",
      width: 1,
    });
    prims.push({
      t: "text",
      x: x + 20,
      y: 10,
      text: name,
      size: FIG_FONT.small + 1,
      baseline: "middle",
    });
    x += 20 + measure(name, FIG_FONT.small + 1) + 18;
  });
  return { prims, width: x, height: 20 };
}

function valueRange(spec: ChartSpec): [number, number] {
  const values = spec.rows.flatMap((r) => r.values).filter(Number.isFinite);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  return max > min ? [min, max] : [0, 1];
}

/** Vertical bars, lines and areas over categories. */
function columns(spec: ChartSpec): Part {
  const prims: Primitive[] = [];
  const [lo, hi] = valueRange(spec);
  const ticks = niceTicks(lo, hi, 5);
  const vmin = Math.min(lo, ticks[0]!);
  const vmax = Math.max(hi, ticks[ticks.length - 1]!);
  const tickW = Math.max(...ticks.map((t) => measure(fmt(t), FIG_FONT.small)));
  const left = tickW + 12 + (spec.yLabel ? 22 : 0);
  const n = spec.rows.length;
  const m = Math.max(1, spec.series.length, ...spec.rows.map((r) => r.values.length));
  const labelW = Math.max(40, ...spec.rows.map((r) => measure(r.label, FIG_FONT.small + 1) + 10));
  const bars = spec.type === "bar";
  const slot = Math.max(bars ? m * 24 + 18 : 46, Math.min(labelW, 110));
  const plotW = slot * n;
  const Y = (v: number) => round1(PLOT_H - ((v - vmin) / (vmax - vmin)) * PLOT_H);
  for (const t of ticks) {
    prims.push({
      t: "line",
      x1: left,
      y1: Y(t),
      x2: left + plotW,
      y2: Y(t),
      stroke: "grid",
      width: 0.8,
    });
    prims.push({
      t: "text",
      x: left - 6,
      y: Y(t),
      text: fmt(t),
      size: FIG_FONT.small,
      color: "soft",
      anchor: "end",
      baseline: "middle",
    });
  }
  prims.push({
    t: "line",
    x1: left,
    y1: Y(0),
    x2: left + plotW + 6,
    y2: Y(0),
    stroke: "ink",
    width: 1.5,
  });
  prims.push({ t: "line", x1: left, y1: PLOT_H, x2: left, y2: -6, stroke: "ink", width: 1.5 });
  if (spec.yLabel)
    prims.push({
      t: "text",
      x: 0,
      y: -4,
      text: spec.yLabel,
      size: FIG_FONT.small,
      color: "soft",
      baseline: "bottom",
    });

  // Category labels wrap to two lines rather than overlapping.
  let labelRows = 1;
  spec.rows.forEach((r, i) => {
    const cx = left + slot * (i + 0.5);
    const lines = splitLabel(r.label, slot - 6);
    labelRows = Math.max(labelRows, lines.length);
    lines.forEach((line, k) =>
      prims.push({
        t: "text",
        x: cx,
        y: PLOT_H + 6 + k * 16,
        text: line,
        size: FIG_FONT.small + 1,
        anchor: "middle",
        baseline: "top",
        weight: r.tone === "accent" ? 700 : undefined,
        key: `row${i}`,
      }),
    );
  });

  if (bars) {
    const barW = Math.min(36, (slot - 14) / m);
    spec.rows.forEach((r, i) => {
      r.values.forEach((v, s) => {
        if (!Number.isFinite(v)) return;
        const x = left + slot * i + (slot - barW * m) / 2 + barW * s;
        const y = Math.min(Y(v), Y(0));
        const h = Math.max(1, Math.abs(Y(v) - Y(0)));
        prims.push({
          t: "rect",
          x: round1(x + 2),
          y,
          w: round1(barW - 4),
          h: round1(h),
          fill: colorOf(m > 1 ? s : 0, r.tone),
          hatch: true,
          stroke: r.tone === "muted" ? "muted" : "ink",
          width: r.tone === "accent" ? 2.2 : 1.4,
          key: `row${i}`,
        });
        prims.push({
          t: "text",
          x: round1(x + barW / 2),
          y: v >= 0 ? y - 3 : y + h + 3,
          text: fmt(v) + (spec.unit ?? ""),
          size: FIG_FONT.small,
          color: "soft",
          anchor: "middle",
          baseline: v >= 0 ? "bottom" : "top",
        });
      });
    });
  } else {
    for (let s = 0; s < m; s++) {
      const pts: [number, number][] = [];
      spec.rows.forEach((r, i) => {
        const v = r.values[s];
        if (v !== undefined && Number.isFinite(v))
          pts.push([round1(left + slot * (i + 0.5)), Y(v)]);
      });
      if (pts.length < 1) continue;
      const color = colorOf(m > 1 ? s : 1);
      if (spec.type === "area" && pts.length > 1)
        prims.push({
          t: "area",
          points: [
            [pts[0]![0], Y(Math.max(vmin, 0))],
            ...pts,
            [pts[pts.length - 1]![0], Y(Math.max(vmin, 0))],
          ],
          fill: color,
          hatch: true,
          opacity: 0.6,
        });
      if (pts.length > 1)
        prims.push({ t: "poly", points: pts, stroke: m > 1 ? color : "ink", width: 2.2 });
      pts.forEach(([x, y], i) => {
        const tone = spec.rows[i]?.tone;
        prims.push({
          t: "circle",
          cx: x,
          cy: y,
          r: tone === "accent" ? 6 : 4,
          fill: tone === "accent" ? "accent" : m > 1 ? color : "ink",
          stroke: "ink",
          key: `row${i}`,
        });
        if (m === 1)
          prims.push({
            t: "text",
            x,
            y: y - 8,
            text: fmt(spec.rows[i]!.values[0]!) + (spec.unit ?? ""),
            size: FIG_FONT.small,
            color: "soft",
            anchor: "middle",
            baseline: "bottom",
          });
      });
    }
  }
  if (spec.xLabel)
    prims.push({
      t: "text",
      x: left + plotW,
      y: PLOT_H + 8 + labelRows * 16,
      text: spec.xLabel,
      size: FIG_FONT.small,
      color: "soft",
      anchor: "end",
      baseline: "top",
    });
  const height = PLOT_H + 12 + labelRows * 16 + (spec.xLabel ? 18 : 0);
  return { prims: offset(prims, 0, 10), width: left + plotW + 10, height: height + 10 };
}

function splitLabel(label: string, width: number): string[] {
  if (measure(label, FIG_FONT.small + 1) <= width || !label.includes(" ")) return [label];
  const words = label.split(" ");
  let best = [label];
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    if (Math.max(measure(a, FIG_FONT.small + 1), measure(b, FIG_FONT.small + 1)) <= width + 20)
      return [a, b];
    best = [a, b];
  }
  return best;
}

/** Horizontal bars, for long category names. */
function hbar(spec: ChartSpec): Part {
  const prims: Primitive[] = [];
  const [lo, hi] = valueRange(spec);
  const ticks = niceTicks(lo, hi, 5);
  const vmin = Math.min(lo, ticks[0]!);
  const vmax = Math.max(hi, ticks[ticks.length - 1]!);
  const m = Math.max(1, spec.series.length, ...spec.rows.map((r) => r.values.length));
  const labelW = Math.max(...spec.rows.map((r) => measure(r.label, FIG_FONT.label))) + 12;
  const plotW = 300;
  const rowH = m * 18 + 14;
  const X = (v: number) => round1(labelW + ((v - vmin) / (vmax - vmin)) * plotW);
  const H = rowH * spec.rows.length;
  for (const t of ticks) {
    prims.push({ t: "line", x1: X(t), y1: 0, x2: X(t), y2: H, stroke: "grid", width: 0.8 });
    prims.push({
      t: "text",
      x: X(t),
      y: H + 5,
      text: fmt(t),
      size: FIG_FONT.small,
      color: "soft",
      anchor: "middle",
      baseline: "top",
    });
  }
  prims.push({ t: "line", x1: X(0), y1: -4, x2: X(0), y2: H, stroke: "ink", width: 1.5 });
  spec.rows.forEach((r, i) => {
    const y0 = i * rowH;
    prims.push({
      t: "text",
      x: labelW - 10,
      y: y0 + rowH / 2,
      text: r.label,
      size: FIG_FONT.label,
      anchor: "end",
      baseline: "middle",
      weight: r.tone === "accent" ? 700 : undefined,
      key: `row${i}`,
    });
    r.values.forEach((v, s) => {
      if (!Number.isFinite(v)) return;
      const y = y0 + 7 + s * 18;
      const x = Math.min(X(v), X(0));
      const w = Math.max(1, Math.abs(X(v) - X(0)));
      prims.push({
        t: "rect",
        x,
        y,
        w: round1(w),
        h: 15,
        fill: colorOf(m > 1 ? s : 0, r.tone),
        hatch: true,
        stroke: "ink",
        width: r.tone === "accent" ? 2.2 : 1.3,
        key: `row${i}`,
      });
      prims.push({
        t: "text",
        x: v >= 0 ? x + w + 5 : x - 5,
        y: y + 8,
        text: fmt(v) + (spec.unit ?? ""),
        size: FIG_FONT.small,
        color: "soft",
        anchor: v >= 0 ? "start" : "end",
        baseline: "middle",
      });
    });
  });
  if (spec.xLabel)
    prims.push({
      t: "text",
      x: labelW + plotW,
      y: H + 24,
      text: spec.xLabel,
      size: FIG_FONT.small,
      color: "soft",
      anchor: "end",
      baseline: "top",
    });
  return {
    prims: offset(prims, 0, 6),
    width: labelW + plotW + 50,
    height: H + (spec.xLabel ? 50 : 30),
  };
}

/** x/y pairs: each row's first two values; its label names the dot. */
function scatter(spec: ChartSpec): Part {
  const prims: Primitive[] = [];
  const pts = spec.rows.filter((r) => r.values.length >= 2);
  const xs = pts.map((r) => r.values[0]!);
  const ys = pts.map((r) => r.values[1]!);
  const span = (v: number[]): [number, number] => {
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    const pad = (hi - lo || 1) * 0.1;
    return [lo - pad, hi + pad];
  };
  const [x0, x1] = span(xs.length ? xs : [0, 1]);
  const [y0, y1] = span(ys.length ? ys : [0, 1]);
  const xt = niceTicks(x0, x1, 6);
  const yt = niceTicks(y0, y1, 5);
  const left = Math.max(...yt.map((t) => measure(fmt(t), FIG_FONT.small))) + 12;
  const W = 340;
  const X = (v: number) => round1(left + ((v - x0) / (x1 - x0)) * W);
  const Y = (v: number) => round1(PLOT_H - ((v - y0) / (y1 - y0)) * PLOT_H);
  for (const t of xt) {
    if (t < x0 || t > x1) continue;
    prims.push({ t: "line", x1: X(t), y1: 0, x2: X(t), y2: PLOT_H, stroke: "grid", width: 0.8 });
    prims.push({
      t: "text",
      x: X(t),
      y: PLOT_H + 5,
      text: fmt(t),
      size: FIG_FONT.small,
      color: "soft",
      anchor: "middle",
      baseline: "top",
    });
  }
  for (const t of yt) {
    if (t < y0 || t > y1) continue;
    prims.push({
      t: "line",
      x1: left,
      y1: Y(t),
      x2: left + W,
      y2: Y(t),
      stroke: "grid",
      width: 0.8,
    });
    prims.push({
      t: "text",
      x: left - 6,
      y: Y(t),
      text: fmt(t),
      size: FIG_FONT.small,
      color: "soft",
      anchor: "end",
      baseline: "middle",
    });
  }
  prims.push({
    t: "line",
    x1: left,
    y1: PLOT_H,
    x2: left + W + 6,
    y2: PLOT_H,
    stroke: "ink",
    width: 1.5,
    arrow: "end",
  });
  prims.push({
    t: "line",
    x1: left,
    y1: PLOT_H,
    x2: left,
    y2: -6,
    stroke: "ink",
    width: 1.5,
    arrow: "end",
  });
  pts.forEach((r, i) => {
    const cx = X(r.values[0]!);
    const cy = Y(r.values[1]!);
    const accent = r.tone === "accent";
    prims.push({
      t: "circle",
      cx,
      cy,
      r: accent ? 6.5 : 5,
      fill: accent ? "accent" : "s1",
      stroke: "ink",
      key: `row${i}`,
    });
    if (r.label && !/^[-\d.]+$/.test(r.label))
      prims.push({
        t: "text",
        x: cx + 8,
        y: cy - 3,
        text: r.label,
        size: FIG_FONT.small + 1,
        baseline: "bottom",
        weight: accent ? 700 : undefined,
      });
  });
  if (spec.xLabel)
    prims.push({
      t: "text",
      x: left + W,
      y: PLOT_H + 22,
      text: spec.xLabel,
      size: FIG_FONT.small,
      color: "soft",
      anchor: "end",
      baseline: "top",
    });
  if (spec.yLabel)
    prims.push({
      t: "text",
      x: left + 8,
      y: -6,
      text: spec.yLabel,
      size: FIG_FONT.small,
      color: "soft",
      baseline: "top",
    });
  return {
    prims: offset(prims, 0, 10),
    width: left + W + 20,
    height: PLOT_H + (spec.xLabel ? 46 : 30) + 10,
  };
}

function pie(spec: ChartSpec): Part {
  const prims: Primitive[] = [];
  const rows = spec.rows.filter((r) => (r.values[0] ?? 0) > 0);
  const total = rows.reduce((s, r) => s + r.values[0]!, 0) || 1;
  const R = 105;
  const labelW = Math.max(60, ...rows.map((r) => measure(`${r.label} 100%`, FIG_FONT.small + 1)));
  const cx = labelW + 30 + R;
  const cy = R + 24;
  let a = 0;
  rows.forEach((r, i) => {
    const share = r.values[0]! / total;
    const from = a;
    const to = a + share * Math.PI * 2;
    a = to;
    prims.push({
      t: "wedge",
      cx,
      cy,
      r: r.tone === "accent" ? R + 8 : R,
      from,
      to,
      fill: r.tone === "accent" ? "accent" : SERIES[i % SERIES.length]!,
      key: `row${i}`,
    });
    const mid = (from + to) / 2;
    const lx = cx + Math.sin(mid) * (R + 18);
    const ly = cy - Math.cos(mid) * (R + 18);
    const right = Math.sin(mid) >= 0;
    prims.push({
      t: "line",
      x1: cx + Math.sin(mid) * (R - 10),
      y1: cy - Math.cos(mid) * (R - 10),
      x2: lx,
      y2: ly,
      stroke: "soft",
      width: 1,
    });
    prims.push({
      t: "text",
      x: lx + (right ? 4 : -4),
      y: ly,
      text: `${r.label} ${Math.round(share * 100)}%`,
      size: FIG_FONT.small + 1,
      anchor: right ? "start" : "end",
      baseline: "middle",
      weight: r.tone === "accent" ? 700 : undefined,
    });
  });
  return { prims, width: cx + R + labelW + 30, height: cy + R + 28 };
}

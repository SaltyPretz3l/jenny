import { textWidth } from "../layout/text.js";
import { labelWidth } from "../math/inline.js";
import type { Ink, Primitive } from "./types.js";

export const FIG_FONT = { title: 18, label: 15, small: 12, value: 16 } as const;

/** Width of a label that may contain $math$. */
export function measure(text: string, size: number): number {
  return text.includes("$") ? labelWidth(text, size) : textWidth(text, size);
}

/** Series colors in order; the first series is ink-free so it reads as data. */
export const SERIES: Ink[] = ["s0", "s1", "s2", "s3", "s4", "s5"];

/** About `count` round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 6): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks;
}

/** Ticks on multiples of π when the range is a few π wide. */
export function piTicks(min: number, max: number): { value: number; label: string }[] | undefined {
  const span = max - min;
  if (span < Math.PI * 0.9 || span > Math.PI * 12) return undefined;
  const step = span > Math.PI * 5 ? Math.PI : Math.PI / 2;
  const ticks: { value: number; label: string }[] = [];
  for (let k = Math.ceil(min / step); k * step <= max + 1e-9; k++) {
    const halves = step === Math.PI ? k * 2 : k;
    ticks.push({ value: k * step, label: piLabel(halves) });
  }
  return ticks;
}

function piLabel(halves: number): string {
  if (halves === 0) return "0";
  const sign = halves < 0 ? "−" : "";
  const h = Math.abs(halves);
  if (h % 2 === 0) return `${sign}${h / 2 === 1 ? "" : h / 2}π`;
  return `${sign}${h === 1 ? "" : h}π/2`;
}

/** Short number labels: 1.5, 20, 1.2k, 3M, 0.25. */
export function fmt(value: number): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1e6) return `${sign}${trim(abs / 1e6)}M`;
  if (abs >= 1e4) return `${sign}${trim(abs / 1e3)}k`;
  return `${sign}${trim(abs)}`;
}

function trim(n: number): string {
  return String(Number(n.toPrecision(3)));
}

/** A figure's title on top; returns the height it takes. */
export function titlePrims(title: string | undefined, width: number, out: Primitive[]): number {
  if (!title) return 0;
  out.push({
    t: "text",
    x: 0,
    y: 0,
    text: title,
    size: FIG_FONT.title,
    weight: 700,
    baseline: "top",
  });
  void width;
  return Math.round(FIG_FONT.title * 1.3) + 10;
}

/** Moves primitives by (dx, dy). */
export function shift(prims: Primitive[], dx: number, dy: number): Primitive[] {
  return prims.map((p) => {
    switch (p.t) {
      case "rect":
        return { ...p, x: p.x + dx, y: p.y + dy };
      case "line":
        return { ...p, x1: p.x1 + dx, y1: p.y1 + dy, x2: p.x2 + dx, y2: p.y2 + dy };
      case "poly":
      case "area":
        return { ...p, points: p.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
      case "circle":
      case "ellipse":
      case "wedge":
        return { ...p, cx: p.cx + dx, cy: p.cy + dy };
      case "text":
      case "icon":
        return { ...p, x: p.x + dx, y: p.y + dy };
    }
  });
}

/** Bounding box of primitives (text estimated). */
export function bounds(prims: Primitive[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const p of prims) {
    switch (p.t) {
      case "rect":
        add(p.x, p.y);
        add(p.x + p.w, p.y + p.h);
        break;
      case "line":
        add(p.x1, p.y1);
        add(p.x2, p.y2);
        break;
      case "poly":
      case "area":
        for (const [x, y] of p.points) add(x, y);
        break;
      case "circle":
      case "wedge":
        add(p.cx - p.r, p.cy - p.r);
        add(p.cx + p.r, p.cy + p.r);
        break;
      case "icon":
        add(p.x, p.y);
        add(p.x + p.size, p.y + p.size);
        break;
      case "ellipse":
        add(p.cx - p.rx, p.cy - p.ry);
        add(p.cx + p.rx, p.cy + p.ry);
        break;
      case "text": {
        const w = measure(p.text, p.size);
        const h = p.size * 1.3;
        const left = p.anchor === "middle" ? p.x - w / 2 : p.anchor === "end" ? p.x - w : p.x;
        const top = p.baseline === "middle" ? p.y - h / 2 : p.baseline === "bottom" ? p.y - h : p.y;
        add(left, top);
        add(left + w, top + h);
      }
    }
  }
  return Number.isFinite(x0)
    ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    : { x: 0, y: 0, w: 0, h: 0 };
}

export const round1 = (n: number) => Math.round(n * 10) / 10;

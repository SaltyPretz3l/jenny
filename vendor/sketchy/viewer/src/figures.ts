import type { Env } from "../../src/figures/expr.js";
import { layoutFigure } from "../../src/figures/index.js";
import { sliderEnv } from "../../src/figures/plot.js";
import type { FigureState, Ink, Primitive } from "../../src/figures/types.js";
import type { LaidOutFigure } from "../../src/scene/laid-out.js";
import { arrowHead, el, mathLine, opts, text, type Pen } from "./draw.js";
import { ANNOTATION, CARD, HIGHLIGHT, INK, INK_SOFT, MARKER, MUTED } from "./palette.js";

/** Fills for series and markers, and the darker pens for lines in those colors. */
const FILL: Record<Ink, string> = {
  ink: INK,
  soft: INK_SOFT,
  muted: MUTED,
  grid: "#e8e3d8",
  card: CARD,
  accent: MARKER,
  blue: ANNOTATION,
  red: HIGHLIGHT,
  s0: "#ffd43b",
  s1: "#74c0fc",
  s2: "#ff8787",
  s3: "#8ce99a",
  s4: "#b197fc",
  s5: "#ffa94d",
};
const PEN: Record<Ink, string> = {
  ...FILL,
  accent: INK,
  s0: "#d9a400",
  s1: "#1c7ed6",
  s2: "#e03131",
  s3: "#2f9e44",
  s4: "#7048e8",
  s5: "#e8590c",
};

type Anchor = { x: number; y: number };

/**
 * One figure in the drawing: it lays itself out for the current step state
 * and slider values and repaints, animating what moved.
 */
export class FigureView {
  state: FigureState = {};
  /** Slider values the user dragged; they win over the step's values. */
  live: Env = {};
  prims: Primitive[] = [];
  private anchors = new Map<string, Anchor>();
  private tween = 0;

  constructor(
    readonly fig: LaidOutFigure,
    readonly g: SVGGElement,
    private readonly pen: Pen,
  ) {
    this.prims = fig.prims;
    this.paint(fig.prims, false);
  }

  /** The slider values the figure shows now. */
  env(): Env {
    const spec = this.fig.spec;
    return spec.kind === "plot" || spec.kind === "draw"
      ? sliderEnv(spec, this.state, this.live)
      : {};
  }

  setState(state: FigureState, animate: boolean): void {
    const before = this.env();
    this.state = state;
    this.live = {};
    const after = this.env();
    const sliders = Object.keys(after).filter((k) => before[k] !== after[k]);
    if (animate && sliders.length && typeof requestAnimationFrame === "function") {
      this.animateSliders(before, after);
      return;
    }
    this.redraw(animate);
  }

  setLive(name: string, value: number): void {
    globalThis.cancelAnimationFrame?.(this.tween);
    this.live = { ...this.live, [name]: value };
    this.redraw(false);
  }

  redraw(animate: boolean): void {
    this.prims = layoutFigure(this.fig, this.state, this.live).prims;
    this.paint(this.prims, animate);
  }

  /** Slider changes glide: the curves morph over half a second. */
  private animateSliders(from: Env, to: Env): void {
    cancelAnimationFrame(this.tween);
    const start = performance.now();
    const frame = (now: number) => {
      const k = Math.min(1, (now - start) / 550);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const live: Env = {};
      for (const name of Object.keys(to)) live[name] = from[name]! + (to[name]! - from[name]!) * e;
      this.prims = layoutFigure(this.fig, this.state, live).prims;
      this.paint(this.prims, false);
      if (k < 1) this.tween = requestAnimationFrame(frame);
    };
    this.tween = requestAnimationFrame(frame);
  }

  private paint(prims: Primitive[], animate: boolean): void {
    const old = this.anchors;
    this.g.replaceChildren();
    const root = el("g", { transform: `translate(${this.fig.x} ${this.fig.y})` });
    this.g.appendChild(root);
    const groups = new Map<string, SVGGElement>();
    const anchors = new Map<string, Anchor>();
    prims.forEach((p, i) => {
      let parent: SVGGElement = root;
      if (p.move) {
        let mg = groups.get(p.move);
        if (!mg) {
          mg = el("g", { "data-move": p.move });
          groups.set(p.move, mg);
          root.appendChild(mg);
          anchors.set(p.move, anchorOf(p));
        }
        parent = mg;
      }
      const node = paintPrimitive(this.pen, p, `${this.fig.id}:${p.move ?? p.key ?? i}`);
      if (p.key) node.setAttribute("data-key", p.key);
      parent.appendChild(node);
    });
    this.anchors = anchors;
    if (!animate) return;
    // Things that moved start where they were and slide into place.
    for (const [move, g] of groups) {
      const was = old.get(move);
      const now = anchors.get(move);
      if (!was || !now) {
        if (!was) {
          g.style.opacity = "0";
          g.style.transition = "opacity 0.45s ease";
          requestAnimationFrame(() => (g.style.opacity = "1"));
        }
        continue;
      }
      const dx = was.x - now.x;
      const dy = was.y - now.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      g.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        g.style.transition = "transform 0.55s cubic-bezier(.4,0,.2,1)";
        g.style.transform = "translate(0px, 0px)";
      });
    }
  }
}

function anchorOf(p: Primitive): Anchor {
  switch (p.t) {
    case "rect":
    case "text":
    case "icon":
      return { x: p.x, y: p.y };
    case "line":
      return { x: p.x1, y: p.y1 };
    case "circle":
    case "ellipse":
    case "wedge":
      return { x: p.cx, y: p.cy };
    default:
      return { x: p.points[0]?.[0] ?? 0, y: p.points[0]?.[1] ?? 0 };
  }
}

export function paintPrimitive(pen: Pen, p: Primitive, seed: string): SVGGElement {
  const g = el("g");
  switch (p.t) {
    case "rect": {
      const o = opts(pen, seed, {
        stroke: p.stroke === "none" ? "none" : PEN[p.stroke ?? "ink"],
        strokeWidth: p.width ?? 1.5,
        fill: p.fill ? FILL[p.fill] : undefined,
        fillStyle: p.hatch ? "hachure" : "solid",
        hachureGap: 5,
        fillWeight: 1.4,
        roughness: 0.9,
        strokeLineDash: p.dashed ? [7, 6] : undefined,
      });
      if (p.hatch && p.fill)
        g.appendChild(
          el("rect", {
            x: p.x + 2,
            y: p.y + 2,
            width: Math.max(0, p.w - 4),
            height: Math.max(0, p.h - 4),
            fill: CARD,
          }),
        );
      g.appendChild(pen.rc.rectangle(p.x, p.y, p.w, p.h, o));
      break;
    }
    case "line": {
      const o = opts(pen, seed, {
        stroke: PEN[p.stroke ?? "ink"],
        strokeWidth: p.width ?? 1.5,
        roughness: 0.7,
        bowing: 0.5,
        strokeLineDash: p.dashed ? [7, 6] : undefined,
      });
      g.appendChild(pen.rc.line(p.x1, p.y1, p.x2, p.y2, o));
      const head = (from: { x: number; y: number }, tip: { x: number; y: number }) =>
        g.appendChild(
          pen.rc.linearPath(
            arrowHead(from, tip, 10).map((q) => [q.x, q.y] as [number, number]),
            { ...o, strokeLineDash: undefined },
          ),
        );
      if (p.arrow) head({ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 });
      if (p.arrow === "both") head({ x: p.x2, y: p.y2 }, { x: p.x1, y: p.y1 });
      break;
    }
    case "poly": {
      if (p.marker)
        g.appendChild(
          el("polyline", {
            points: p.points.map(([x, y]) => `${x},${y}`).join(" "),
            fill: "none",
            stroke: MARKER,
            "stroke-width": 10,
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            opacity: 0.75,
          }),
        );
      const o = opts(pen, seed, {
        stroke: PEN[p.stroke ?? "ink"],
        strokeWidth: p.width ?? 2,
        roughness: p.rough ?? 0.45,
        bowing: 0.3,
        strokeLineDash: p.dashed ? [8, 6] : undefined,
      });
      if (p.closed) {
        if (p.hatch && p.fill)
          g.appendChild(
            el("polygon", { points: p.points.map(([x, y]) => `${x},${y}`).join(" "), fill: CARD }),
          );
        g.appendChild(
          pen.rc.polygon(
            p.points,
            p.fill
              ? {
                  ...o,
                  fill: FILL[p.fill],
                  fillStyle: p.hatch ? "hachure" : "solid",
                  hachureGap: 5,
                  fillWeight: 1.4,
                }
              : o,
          ),
        );
      } else g.appendChild(pen.rc.linearPath(p.points, o));
      const head = (from: [number, number], tip: [number, number]) =>
        g.appendChild(
          pen.rc.linearPath(
            arrowHead({ x: from[0], y: from[1] }, { x: tip[0], y: tip[1] }, 10).map(
              (q) => [q.x, q.y] as [number, number],
            ),
            { ...o, roughness: 0.45, strokeLineDash: undefined },
          ),
        );
      if (p.arrow && p.points.length > 1) {
        head(p.points[p.points.length - 2]!, p.points[p.points.length - 1]!);
        if (p.arrow === "both") head(p.points[1]!, p.points[0]!);
      }
      break;
    }
    case "area": {
      const node = pen.rc.polygon(
        p.points,
        opts(pen, seed, {
          stroke: "none",
          fill: FILL[p.fill],
          fillStyle: p.hatch ? "hachure" : "solid",
          hachureGap: 6,
          fillWeight: 1.3,
          roughness: 0.8,
        }),
      );
      if (p.opacity !== undefined) node.setAttribute("opacity", String(p.opacity));
      g.appendChild(node);
      break;
    }
    case "circle":
      g.appendChild(
        pen.rc.circle(
          p.cx,
          p.cy,
          p.r * 2,
          opts(pen, seed, {
            stroke: p.stroke === "none" ? "none" : PEN[p.stroke ?? "ink"],
            strokeWidth: 1.5,
            fill: p.fill ? FILL[p.fill] : undefined,
            fillStyle: "solid",
            roughness: p.r < 8 ? 0.3 : 0.9,
          }),
        ),
      );
      break;
    case "ellipse": {
      if (p.hatch && p.fill)
        g.appendChild(el("ellipse", { cx: p.cx, cy: p.cy, rx: p.rx, ry: p.ry, fill: CARD }));
      g.appendChild(
        pen.rc.ellipse(
          p.cx,
          p.cy,
          p.rx * 2,
          p.ry * 2,
          opts(pen, seed, {
            stroke: PEN[p.stroke ?? "ink"],
            strokeWidth: p.width ?? 1.6,
            fill: p.fill ? FILL[p.fill] : undefined,
            fillStyle: p.hatch ? "hachure" : "solid",
            hachureGap: 5,
            fillWeight: 1.4,
            roughness: Math.min(p.rx, p.ry) < 8 ? 0.35 : 0.9,
            strokeLineDash: p.dashed ? [7, 6] : undefined,
          }),
        ),
      );
      break;
    }
    case "icon": {
      const icon = el("g", {
        transform: `translate(${p.x} ${p.y}) scale(${p.size / p.vw} ${p.size / p.vh})`,
        color: PEN[p.color ?? "ink"],
        class: "icon",
      });
      // Icon bodies come from the bundled Iconify sets, not from user input.
      icon.innerHTML = p.body;
      g.appendChild(icon);
      break;
    }
    case "wedge": {
      const pt = (a: number) => [p.cx + Math.sin(a) * p.r, p.cy - Math.cos(a) * p.r];
      const [x0, y0] = pt(p.from);
      const [x1, y1] = pt(p.to);
      const large = p.to - p.from > Math.PI ? 1 : 0;
      const d =
        p.to - p.from >= Math.PI * 2 - 1e-6
          ? `M ${p.cx - p.r} ${p.cy} a ${p.r} ${p.r} 0 1 0 ${p.r * 2} 0 a ${p.r} ${p.r} 0 1 0 ${-p.r * 2} 0`
          : `M ${p.cx} ${p.cy} L ${x0} ${y0} A ${p.r} ${p.r} 0 ${large} 1 ${x1} ${y1} Z`;
      g.appendChild(
        pen.rc.path(
          d,
          opts(pen, seed, {
            stroke: INK,
            strokeWidth: 1.4,
            fill: FILL[p.fill],
            fillStyle: "hachure",
            hachureGap: 5,
            fillWeight: 1.5,
            roughness: 0.8,
          }),
        ),
      );
      break;
    }
    case "text": {
      const lh = Math.round(p.size * 1.3);
      const top = p.baseline === "middle" ? p.y - lh / 2 : p.baseline === "bottom" ? p.y - lh : p.y;
      const color = PEN[p.color ?? "ink"];
      if (p.text.includes("$"))
        g.appendChild(
          mathLine({
            x: p.x,
            baseline: top + lh * 0.74,
            text: p.text,
            size: p.size,
            color,
            anchor: p.anchor ?? "start",
            weight: p.weight,
          }),
        );
      else
        g.appendChild(
          text({
            x: p.x,
            y: top,
            lines: [p.text],
            size: p.size,
            color,
            anchor: p.anchor,
            weight: p.weight,
          }),
        );
      break;
    }
  }
  return g;
}

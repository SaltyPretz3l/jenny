import type { Env } from "./expr.js";
import { layoutChart } from "./chart.js";
import { layoutData, layoutTree } from "./data.js";
import { drawIssues, layoutDraw } from "./draw.js";
import { layoutMap } from "./map.js";
import { layoutMoleculeFigure } from "./molecule.js";
import { layoutTemplate } from "./templates.js";
import { layoutPlot } from "./plot.js";
import { layoutSeq } from "./seq.js";
import type { FigureLayout, FigureState, SceneFigure } from "./types.js";

export type { FigureLayout, FigureState, Primitive, SceneFigure } from "./types.js";

/** Lays out one figure in the given state; `live` holds slider values the user dragged. */
export function layoutFigure(fig: SceneFigure, state: FigureState = {}, live?: Env): FigureLayout {
  const s = fig.spec;
  switch (s.kind) {
    case "plot":
      return layoutPlot(s, fig.title, state, live);
    case "chart":
      return layoutChart(s, fig.title);
    case "seq":
      return layoutSeq(s, fig.title);
    case "tree":
      return layoutTree(fig.id, s, fig.title, state);
    case "draw":
      return layoutDraw(fig.id, s, fig.title, state, live);
    case "template":
      return layoutTemplate(fig.id, s, fig.title, state);
    case "molecule":
      return layoutMoleculeFigure(fig.id, s, fig.title);
    case "map":
      return layoutMap(fig.id, s, fig.title);
    default:
      return layoutData(fig.id, s, fig.title, state);
  }
}

/**
 * The state after each step: assignments accumulate, so step 3 shows what
 * steps 1-3 set. Index -1 (or undefined) is the overview: nothing assigned.
 */
export function stateAt(steps: { set?: FigureState }[], index: number | undefined): FigureState {
  const state: FigureState = {};
  if (index === undefined) return state;
  for (let i = 0; i <= index && i < steps.length; i++) Object.assign(state, steps[i]!.set ?? {});
  return state;
}

/**
 * Problems a reader would see in the drawings, at the start and after every
 * step, so the model can fix them before anyone looks.
 */
export function figureIssues(figures: SceneFigure[], steps: { set?: FigureState }[]): string[] {
  const issues: string[] = [];
  for (const fig of figures) {
    if (fig.spec.kind !== "draw") continue;
    const states = [
      { state: {}, when: "at the start" },
      ...steps.map((_, i) => ({ state: stateAt(steps, i), when: `in step ${i + 1}` })),
    ];
    issues.push(...drawIssues(fig.id, fig.spec, states));
  }
  // The same slip shows in many steps; say it once with the first one.
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const what = issue.replace(/ (at the start|in step \d+)$/, "");
    if (seen.has(what)) return false;
    seen.add(what);
    return true;
  });
}

/** The names a figure reads from step assignments. */
export function stateNames(fig: SceneFigure): string[] {
  const s = fig.spec;
  switch (s.kind) {
    case "plot":
      return s.sliders.map((x) => x.name);
    case "array":
    case "list":
    case "stack":
    case "queue":
      return [fig.id, ...s.pointers.map((p) => p.name)];
    case "tree":
    case "template":
      return [fig.id];
    case "draw":
      return [fig.id, ...s.sliders.map((x) => x.name)];
    default:
      return [];
  }
}

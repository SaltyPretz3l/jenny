// Jenny's replacement for upstream viewer/src/palette.ts (plan section 5.8): the drawing takes the app
// theme's colours. The host posts them; setPalette accepts six-digit hex only and anything else falls
// back to upstream's cream value. The exports are live bindings, so the viewer modules that import
// them see a new palette on the next draw. The frame's stylesheet override reads the CSS variables
// this module sets on the document.
import type { Tone, WireColor } from "@sketchy/src/scene/types.js";

/** Upstream's cream palette, the fallback for every colour. */
const CREAM = {
  ink: "#1d1d1f",
  inkSoft: "#5c5f66",
  muted: "#9a9ea6",
  paper: "#fffdf7",
  card: "#ffffff",
  groupFill: "#f5f2ea",
  marker: "#ffe58a",
  annotation: "#1a5fb4",
  highlight: "#e8452c",
  line: "#e7e2d6",
};

export type PaletteKey = keyof typeof CREAM;
export const PALETTE_KEYS = Object.keys(CREAM) as PaletteKey[];

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export let INK = CREAM.ink;
export let INK_SOFT = CREAM.inkSoft;
export let MUTED = CREAM.muted;
export let PAPER = CREAM.paper;
export let CARD = CREAM.card;
export let GROUP_FILL = CREAM.groupFill;
export let MARKER = CREAM.marker;
export let ANNOTATION = CREAM.annotation;
export let HIGHLIGHT = CREAM.highlight;

export const WIRE: Record<WireColor, string> = {
  red: "#e03131",
  black: "#25262b",
  blue: "#1c7ed6",
  green: "#2f9e44",
  yellow: "#f0b400",
  orange: "#f76707",
  purple: "#9c36b5",
  gray: "#868e96",
  white: "#e9ecef",
};

function mix(a: string, b: string, share: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  const out = [1, 3, 5].map((at) => Math.round(channel(a, at) * (1 - share) + channel(b, at) * share));
  return `#${out.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Applies host colours. Missing, malformed or non-hex values fall back to the cream palette. */
export function setPalette(colours?: Partial<Record<PaletteKey, unknown>> | null): void {
  const given = (colours && typeof colours === "object" ? colours : {}) as Record<string, unknown>;
  const pick = (key: PaletteKey): string => {
    const value = given[key];
    return typeof value === "string" && HEX6.test(value) ? value.toLowerCase() : CREAM[key];
  };
  INK = pick("ink");
  INK_SOFT = pick("inkSoft");
  MUTED = pick("muted");
  PAPER = pick("paper");
  CARD = pick("card");
  GROUP_FILL = pick("groupFill");
  MARKER = pick("marker");
  ANNOTATION = pick("annotation");
  HIGHLIGHT = pick("highlight");
  const line = pick("line");
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  const vars: Record<string, string> = {
    "--ink": INK,
    "--ink-soft": INK_SOFT,
    "--paper": PAPER,
    "--line": line,
    "--accent": HIGHLIGHT,
    "--jenny-card": CARD,
    "--jenny-marker": MARKER,
    "--jenny-marker-soft": mix(MARKER, CARD, 0.55),
    "--jenny-marker-deep": mix(MARKER, INK, 0.12),
    "--jenny-annotation": ANNOTATION,
    "--jenny-shadow": mix(PAPER, INK, 0.14),
  };
  for (const [name, value] of Object.entries(vars)) style.setProperty(name, value);
}

export function toneStroke(tone: Tone | undefined): string {
  return tone === "muted" ? MUTED : INK;
}

export function toneText(tone: Tone | undefined): string {
  return tone === "muted" ? INK_SOFT : INK;
}

export function toneFill(tone: Tone | undefined): string {
  return tone === "accent" ? MARKER : CARD;
}

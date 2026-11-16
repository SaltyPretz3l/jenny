import type { Tone, WireColor } from "../../src/scene/types.js";

/**
 * The fixed Sketchy palette. Ink is black; the only accents are a marker
 * yellow for emphasis, annotation blue for callouts and a red pen for step
 * highlights. Scenes cannot introduce other colors (wires aside).
 */
export const INK = "#1d1d1f";
export const INK_SOFT = "#5c5f66";
export const MUTED = "#9a9ea6";
export const PAPER = "#fffdf7";
export const CARD = "#ffffff";
export const GROUP_FILL = "#f5f2ea";
export const MARKER = "#ffe58a";
export const ANNOTATION = "#1a5fb4";
export const HIGHLIGHT = "#e8452c";

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

export function toneStroke(tone: Tone | undefined): string {
  return tone === "muted" ? MUTED : INK;
}

export function toneText(tone: Tone | undefined): string {
  return tone === "muted" ? INK_SOFT : INK;
}

export function toneFill(tone: Tone | undefined): string {
  return tone === "accent" ? MARKER : CARD;
}

/**
 * Typographic and spacing constants shared by the layout engine and the
 * viewer, so measured text and rendered text agree.
 */
export const FONT_FAMILY = "Kalam";

export const FONT = {
  title: 30,
  subtitle: 18,
  node: 18,
  group: 17,
  edge: 15,
  label: 16,
  caption: 15,
  attribution: 11,
} as const;

export const SPACING = {
  margin: 28,
  nodePaddingX: 18,
  nodePaddingY: 12,
  nodeMinWidth: 110,
  nodeMinHeight: 52,
  nodeMaxTextWidth: 200,
  iconSize: 26,
  labelGap: 46,
  labelSpacing: 8,
  labelMaxTextWidth: 190,
  groupPadding: 18,
  groupHeader: 34,
} as const;

import regular from "@fontsource/kalam/files/kalam-latin-400-normal.woff2?inline";
import bold from "@fontsource/kalam/files/kalam-latin-700-normal.woff2?inline";
import regularExt from "@fontsource/kalam/files/kalam-latin-ext-400-normal.woff2?inline";
import boldExt from "@fontsource/kalam/files/kalam-latin-ext-700-normal.woff2?inline";
import { FONT_FAMILY } from "../../src/style/metrics.js";

const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2190-21FF, U+2212, U+2215";
const LATIN_EXT =
  "U+0100-02AF, U+0304, U+0308, U+0329, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

/**
 * Kalam (SIL OFL) is embedded as data URLs: the viewer runs sandboxed
 * without network access, and exported SVG/PNG files keep the handwriting.
 */
export const FONT_CSS = [
  [regular, 400, LATIN],
  [bold, 700, LATIN],
  [regularExt, 400, LATIN_EXT],
  [boldExt, 700, LATIN_EXT],
]
  .map(
    ([src, weight, range]) =>
      `@font-face{font-family:"${FONT_FAMILY}";font-style:normal;font-weight:${weight};font-display:block;src:url(${src}) format("woff2");unicode-range:${range};}`,
  )
  .join("\n");

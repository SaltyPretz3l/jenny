'use strict';

// Static readers for the palette sheets, shared by the palette gates.
// A palette is `styles/palette-<id>.css`; Midnight has no sheet of its own and
// is the foundation defaults (`foundation.css` + `foundation-widget-tokens.css`).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const STYLES_DIR = path.join(ROOT, 'styles');
const FOUNDATION_FILES = ['foundation.css', 'foundation-widget-tokens.css'];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// First declaration wins: a palette sheet's main block comes first, and the
// foundation `:root` block comes before any scoped override.
function readDeclarations(css) {
  const tokens = new Map();
  const pattern = /(--[a-z0-9-]+)\s*:\s*([^;{}]+);/g;
  const body = stripComments(css);
  let match = pattern.exec(body);
  while (match) {
    if (!tokens.has(match[1])) tokens.set(match[1], match[2].trim().replace(/\s+/g, ' '));
    match = pattern.exec(body);
  }
  return tokens;
}

function readFoundationTokens() {
  const tokens = new Map();
  for (const file of FOUNDATION_FILES) {
    for (const [name, value] of readDeclarations(fs.readFileSync(path.join(STYLES_DIR, file), 'utf8'))) {
      if (!tokens.has(name)) tokens.set(name, value);
    }
  }
  return tokens;
}

function readPaletteSheets() {
  return fs.readdirSync(STYLES_DIR)
    .filter((name) => /^palette-.+\.css$/.test(name))
    .sort()
    .map((file) => {
      const css = fs.readFileSync(path.join(STYLES_DIR, file), 'utf8');
      const scheme = stripComments(css).match(/color-scheme:\s*(light|dark)\s*;/);
      return {
        id: file.replace(/^palette-|\.css$/g, ''),
        file,
        scheme: scheme ? scheme[1] : null,
        tokens: readDeclarations(css),
      };
    });
}

// Every palette as the app resolves it: its own tokens over the foundation defaults.
function readResolvedPalettes() {
  const foundation = readFoundationTokens();
  const palettes = [{ id: 'midnight', file: 'foundation.css', scheme: 'dark', tokens: foundation, table: foundation }];
  for (const sheet of readPaletteSheets()) {
    palettes.push({ ...sheet, table: new Map([...foundation, ...sheet.tokens]) });
  }
  return palettes;
}

function resolveValue(table, token, depth = 0) {
  const value = table.get(token);
  if (value === undefined || depth > 8) return null;
  const alias = value.match(/^var\((--[a-z0-9-]+)\)$/);
  return alias ? resolveValue(table, alias[1], depth + 1) : value;
}

// Every colour literal in a value, in order, as { r, g, b, a }.
function readColors(value) {
  const colors = [];
  const pattern = /#([0-9a-fA-F]{3,8})\b|rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)/g;
  let match = pattern.exec(value || '');
  while (match) {
    if (match[1]) {
      const raw = match[1];
      const full = raw.length <= 4 ? raw.split('').map((c) => c + c).join('') : raw;
      colors.push({
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16),
        a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
      });
    } else {
      colors.push({ r: Number(match[2]), g: Number(match[3]), b: Number(match[4]), a: match[5] === undefined ? 1 : Number(match[5]) });
    }
    match = pattern.exec(value || '');
  }
  return colors;
}

function composite(color, backdrop) {
  const mix = (top, under) => Math.round(top * color.a + under * (1 - color.a));
  return { r: mix(color.r, backdrop.r), g: mix(color.g, backdrop.g), b: mix(color.b, backdrop.b), a: 1 };
}

function channelToLinear(value) {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }) {
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

function contrastRatio(a, b) {
  const lumA = relativeLuminance(a);
  const lumB = relativeLuminance(b);
  return (Math.max(lumA, lumB) + 0.05) / (Math.min(lumA, lumB) + 0.05);
}

// The single opaque colour a token resolves to, or null when it is not one literal.
function readSolid(table, token) {
  const colors = readColors(resolveValue(table, token));
  return colors.length === 1 && colors[0].a === 1 ? colors[0] : null;
}

// Colour forms readColors cannot read. A fill that uses one fails loudly rather
// than having that stop skipped.
const UNREADABLE_FILL = /var\(|color-mix\(|hsla?\(|okl(?:ch|ab)\(|rgba?\([^,)]*\)|\btransparent\b/;

// Every colour stop of a fill token, flattened onto the palette's card surface.
function readFillStops(table, token) {
  const value = resolveValue(table, token) || '';
  if (UNREADABLE_FILL.test(value)) throw new Error(`${token}: the contrast gate cannot read "${value}"`);
  const backdrop = readSolid(table, '--bg-surface');
  return readColors(value).map((color) => (color.a === 1 ? color : composite(color, backdrop)));
}

module.exports = {
  ROOT,
  composite,
  contrastRatio,
  readColors,
  readFillStops,
  readFoundationTokens,
  readPaletteSheets,
  readResolvedPalettes,
  readSolid,
  resolveValue,
  stripComments,
};

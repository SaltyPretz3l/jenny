'use strict';

// UIUX-022 — Essential muted text missed WCAG 2.2's 4.5:1 bar in 10 of 11
// palettes (audit measured Midnight 3.55 ... Woolly 2.93). The remediation
// splits the old single token into:
//   --text-muted       semantic READABLE muted: essential secondary copy
//                      (Quick Settings labels, Settings nav, command palette,
//                      chat controls, help text). Must clear 4.5:1 against
//                      every core opaque background token.
//   --text-decorative  decorative/disabled tint: skeletons, muted state
//                      washes, dots. Deliberately faint; WCAG-exempt
//                      (inactive/decorative), so no ratio floor here.
//
// This is the automated half of the finding's gate (static token matrix).
// Gradient/translucent composited surfaces can't be resolved statically —
// the owner-run Windows high-contrast / forced-colors review in
// docs/operations/MANUAL_TEST_MATRIX.md covers those.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STYLES_DIR = path.join(__dirname, '..', 'styles');
const CORE_BACKGROUND_TOKENS = ['bg-base', 'bg-surface', 'bg-surface-2', 'bg-panel'];
const MIN_READABLE_RATIO = 4.5;

const paletteFiles = fs.readdirSync(STYLES_DIR)
  .filter((name) => name.startsWith('palette-') && name.endsWith('.css'))
  .sort();
const allFiles = ['foundation.css', ...paletteFiles];

function hexToRgb(hex) {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function channelToLinear(value) {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]) {
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

function contrastRatio(hexA, hexB) {
  const lumA = relativeLuminance(hexToRgb(hexA));
  const lumB = relativeLuminance(hexToRgb(hexB));
  const [hi, lo] = lumA > lumB ? [lumA, lumB] : [lumB, lumA];
  return (hi + 0.05) / (lo + 0.05);
}

function readToken(css, token) {
  const match = css.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`));
  return match ? match[1] : null;
}

test('every palette defines a literal readable --text-muted and decorative --text-decorative', () => {
  for (const file of allFiles) {
    const css = fs.readFileSync(path.join(STYLES_DIR, file), 'utf8');
    assert.ok(readToken(css, 'text-muted'), `${file}: --text-muted must be a literal hex`);
    assert.ok(readToken(css, 'text-decorative'), `${file}: --text-decorative must be a literal hex`);
  }
});

test('readable muted text clears 4.5:1 against every core background in every palette', () => {
  const failures = [];
  for (const file of allFiles) {
    const css = fs.readFileSync(path.join(STYLES_DIR, file), 'utf8');
    const muted = readToken(css, 'text-muted');
    if (!muted) continue; // covered by the presence test above
    for (const bgToken of CORE_BACKGROUND_TOKENS) {
      const background = readToken(css, bgToken);
      if (!background) continue; // palettes inherit missing bg tokens from foundation
      const ratio = contrastRatio(muted, background);
      if (ratio < MIN_READABLE_RATIO) {
        failures.push(`${file}: --text-muted ${muted} vs --${bgToken} ${background} = ${ratio.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(failures, [], `muted text below ${MIN_READABLE_RATIO}:1:\n${failures.join('\n')}`);
});

test('decorative washes derive from --text-decorative, not readable muted text', () => {
  const foundation = fs.readFileSync(path.join(STYLES_DIR, 'foundation.css'), 'utf8');
  // These are background tints/skeletons — brightening readable muted text
  // must not brighten them, so they must reference the decorative token.
  for (const token of ['state-muted-bg', 'state-muted-border', 'skeleton-base', 'skeleton-shimmer']) {
    const line = foundation.match(new RegExp(`--${token}:[^;]+;`));
    assert.ok(line, `foundation.css must define --${token}`);
    assert.match(line[0], /var\(--text-decorative\)/, `--${token} must derive from --text-decorative`);
  }
});

test('Jenny Day separates decorative accent from readable link and active text', () => {
  const css = fs.readFileSync(path.join(STYLES_DIR, 'palette-jenny-day.css'), 'utf8');
  const foregrounds = ['text-link', 'text-active'];
  for (const foregroundToken of foregrounds) {
    const foreground = readToken(css, foregroundToken);
    assert.ok(foreground, `Jenny Day must define literal --${foregroundToken}`);
    for (const backgroundToken of CORE_BACKGROUND_TOKENS) {
      const background = readToken(css, backgroundToken);
      const ratio = contrastRatio(foreground, background);
      assert.ok(ratio >= MIN_READABLE_RATIO,
        `Jenny Day --${foregroundToken} vs --${backgroundToken} is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.notEqual(readToken(css, 'accent'), readToken(css, 'text-link'),
    'decorative brand accent must not double as small foreground text');
});

'use strict';

// The static contrast gate for every palette, Midnight included. It covers
// what tests/palette-muted-contrast.test.js does not: the sidebar background,
// the secondary text ramp, the composer placeholder, button labels on their
// fills, the accent as a control colour and the editor colours.
//
// Translucent fills are flattened onto the palette's card surface, so the
// numbers are close to, not identical with, what the app composites.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  composite,
  contrastRatio,
  readColors,
  readFillStops,
  readResolvedPalettes,
  readSolid,
  resolveValue,
} = require('./helpers/palette-css.js');

const BACKGROUNDS = ['--bg-base', '--bg-surface', '--bg-surface-2', '--bg-panel', '--bg-sidebar'];
const TEXT_RATIO = 4.5;
const CONTROL_RATIO = 3;

const palettes = readResolvedPalettes();

function worstAgainstBackgrounds(table, token) {
  const foreground = readSolid(table, token);
  if (!foreground) return { ratio: 0, against: 'not one literal colour' };
  let worst = { ratio: Infinity, against: '' };
  for (const background of BACKGROUNDS) {
    const backdrop = readSolid(table, background);
    if (!backdrop) return { ratio: 0, against: `${background} is not one literal colour` };
    const ratio = contrastRatio(foreground, backdrop);
    if (ratio < worst.ratio) worst = { ratio, against: background };
  }
  return worst;
}

// The label colour against each stop of its fill; a translucent label is flattened onto the stop.
function worstOnFill(table, labelToken, fillToken) {
  const labels = readColors(resolveValue(table, labelToken));
  const stops = readFillStops(table, fillToken);
  if (labels.length !== 1 || !stops.length) return null;
  return Math.min(...stops.map((stop) => contrastRatio(labels[0].a === 1 ? labels[0] : composite(labels[0], stop), stop)));
}

function collect(check) {
  const failures = [];
  for (const palette of palettes) check(palette, (message) => failures.push(`${palette.id}: ${message}`));
  return failures;
}

test('secondary and muted text clear 4.5:1 on every background, the sidebar included', () => {
  const failures = collect(({ table }, fail) => {
    for (const token of ['--text-secondary', '--text-muted']) {
      const worst = worstAgainstBackgrounds(table, token);
      if (worst.ratio < TEXT_RATIO) fail(`${token} is ${worst.ratio.toFixed(2)} on ${worst.against}`);
    }
  });
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('secondary text is never fainter than muted text', () => {
  const failures = collect(({ table }, fail) => {
    const base = readSolid(table, '--bg-base');
    const secondary = contrastRatio(readSolid(table, '--text-secondary'), base);
    const muted = contrastRatio(readSolid(table, '--text-muted'), base);
    if (secondary < muted) fail(`--text-secondary ${secondary.toFixed(2)} is below --text-muted ${muted.toFixed(2)} on --bg-base`);
  });
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('the composer placeholder and meta text clear 4.5:1 on the composer surface', () => {
  const failures = collect(({ table }, fail) => {
    const stops = readFillStops(table, '--surface-composer-inner');
    if (!stops.length) return fail('--surface-composer-inner has no colour literal');
    for (const token of ['--widget-placeholder-color', '--widget-composer-meta-color']) {
      const ink = readSolid(table, token);
      if (!ink) { fail(`${token} is not one literal colour`); continue; }
      const worst = Math.min(...stops.map((stop) => contrastRatio(ink, stop)));
      if (worst < TEXT_RATIO) fail(`${token} is ${worst.toFixed(2)} on the composer surface`);
    }
  });
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('button labels are readable on their fills', () => {
  const buttons = [
    ['primary button', '--widget-button-primary-color', '--widget-button-primary-bg', TEXT_RATIO],
    ['approve button', '--widget-approve-color', '--widget-approve-bg', TEXT_RATIO],
    // The send button carries an icon, not text.
    ['send button', '--widget-send-color', '--widget-send-bg', CONTROL_RATIO],
  ];
  const failures = collect(({ table }, fail) => {
    for (const [label, labelToken, fillToken, floor] of buttons) {
      const worst = worstOnFill(table, labelToken, fillToken);
      if (worst === null) { fail(`${label}: ${labelToken} or ${fillToken} has no colour literal`); continue; }
      if (worst < floor) fail(`${label} label is ${worst.toFixed(2)} on its fill (needs ${floor})`);
    }
  });
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('the accent reads as a control colour, or the palette sets readable link and active text', () => {
  const failures = collect(({ table, tokens }, fail) => {
    const readable = ['--text-link', '--text-active'].filter((token) => tokens.has(token));
    for (const token of readable) {
      const worst = worstAgainstBackgrounds(table, token);
      if (worst.ratio < TEXT_RATIO) fail(`${token} is ${worst.ratio.toFixed(2)} on ${worst.against}`);
    }
    if (readable.length === 2) return;
    const accent = worstAgainstBackgrounds(table, '--accent');
    if (accent.ratio < CONTROL_RATIO) {
      fail(`--accent is ${accent.ratio.toFixed(2)} on ${accent.against}; raise it to 3:1 or set literal --text-link and --text-active`);
    }
  });
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('editor colours are readable on the editor background', () => {
  const failures = collect(({ table }, fail) => {
    const base = readSolid(table, '--bg-base');
    for (const name of ['keyword', 'string', 'number', 'function', 'type', 'variable', 'constant', 'comment']) {
      const token = `--syntax-${name}`;
      if (!table.has(token)) continue; // presence is the parity gate's job
      const ink = readSolid(table, token);
      if (!ink) { fail(`${token} is not one literal colour`); continue; }
      const floor = name === 'comment' ? CONTROL_RATIO : TEXT_RATIO;
      const ratio = contrastRatio(ink, base);
      if (ratio < floor) fail(`${token} is ${ratio.toFixed(2)} on --bg-base (needs ${floor})`);
    }
  });
  assert.deepEqual(failures, [], failures.join('\n'));
});

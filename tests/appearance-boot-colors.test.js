'use strict';

// The curtain paints before the palette sheets load, so appearance-utils.js
// repeats each palette's curtain colours. These tests keep the copy honest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const appearanceUtils = require('../renderer/shared/appearance-utils.js');

const STYLES = path.join(__dirname, '..', 'styles');
const TOKENS = { bg: '--bg-base', text: '--text-primary', textSecondary: '--text-secondary', cyan: '--accent-cyan', accent: '--accent' };

function readToken(css, token) {
  const match = css.match(new RegExp(`(?<![\\w-])${token}:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

function readPaletteFiles() {
  return fs.readdirSync(STYLES)
    .filter((name) => /^palette-.+\.css$/.test(name))
    .map((name) => ({ id: name.replace(/^palette-|\.css$/g, ''), css: fs.readFileSync(path.join(STYLES, name), 'utf8') }));
}

test('every palette sheet has curtain colours that match it', () => {
  const foundation = fs.readFileSync(path.join(STYLES, 'foundation.css'), 'utf8');
  const palettes = readPaletteFiles();
  assert.ok(palettes.length >= 11, 'palette sheets were found');
  for (const { id, css } of palettes) {
    const colors = appearanceUtils.resolvePaletteBootColors(id);
    assert.ok(colors, `${id} has curtain colours`);
    for (const [key, token] of Object.entries(TOKENS)) {
      assert.equal(colors[key], readToken(css, token) || readToken(foundation, token), `${id} ${token}`);
    }
  }
});

test('the base palette uses the foundation tokens', () => {
  const foundation = fs.readFileSync(path.join(STYLES, 'foundation.css'), 'utf8');
  const colors = appearanceUtils.resolvePaletteBootColors('midnight');
  for (const [key, token] of Object.entries(TOKENS)) {
    assert.equal(colors[key], readToken(foundation, token), token);
  }
});

test('an unknown palette resolves to nothing so the caller keeps its default', () => {
  assert.equal(appearanceUtils.resolvePaletteBootColors('nope'), null);
  assert.equal(appearanceUtils.resolvePaletteBootColors(undefined), null);
  assert.equal(appearanceUtils.resolvePaletteBootColors('__proto__'), null);
});

test('applying appearance stamps the curtain colours before any palette sheet loads', (t) => {
  const dom = new JSDOM('<!doctype html><html></html>');
  t.after(() => dom.window.close());
  const root = dom.window.document.documentElement;
  appearanceUtils.applyAppearanceToDocument(dom.window.document, { paletteId: 'paper' });
  assert.equal(root.style.getPropertyValue('--startup-bg'), '#ebe6dc');
  assert.equal(root.style.getPropertyValue('--startup-text'), '#1f2635');
  assert.equal(root.style.getPropertyValue('--startup-cyan'), '#157ec7');
  appearanceUtils.applyAppearanceToDocument(dom.window.document, { paletteId: 'slate' });
  assert.equal(root.style.getPropertyValue('--startup-bg'), '#15181c', 'a palette change follows through');
});

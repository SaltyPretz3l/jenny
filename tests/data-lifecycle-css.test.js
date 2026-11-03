'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, '..', 'styles', 'data-lifecycle.css');

test('data lifecycle CSS is palette-neutral and semantic-token-only', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(css, /\b(?:rgb|rgba|hsl|hsla)\s*\(/i);
  assert.doesNotMatch(css, /\[data-palette|palette-(?:paper|signal|woolly|lexicon|rocko|jenny|pewter|obsidian|darkroom)/i);
  const variables = [...css.matchAll(/var\((--[a-z0-9-]+)/gi)].map((match) => match[1]);
  const allowed = /^--(?:settings-shell|surface|text|status|widget-button|space|radius|focus|font|motion|z)-/;
  assert.equal(variables.every((variable) => allowed.test(variable)), true, variables.filter((value) => !allowed.test(value)).join(', '));

  for (const obsoleteToken of [
    '--font-ui',
    '--font-display',
    '--text-xs',
    '--text-sm',
    '--text-lg',
    '--text-2xl',
    '--radius-card',
    '--z-modal',
  ]) {
    assert.equal(css.includes(`var(${obsoleteToken})`), false, `${obsoleteToken} is not a current foundation token`);
  }
});

test('foundation defines the small shadow used by settings surfaces', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'foundation.css'), 'utf8');
  assert.match(css, /--shadow-sm:\s*[^;]+;/);
});

test('uninstall assistant imports the foundation and every palette sheet in canonical order', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'uninstall.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const palettes = [...styles.matchAll(/@import url\("\.\/styles\/(palette-[a-z0-9-]+\.css)"\);/g)]
    .map((match) => match[1]);
  const uninstallPalettes = [...html.matchAll(/href="styles\/(palette-[a-z0-9-]+\.css)"/g)]
    .map((match) => match[1]);
  assert.match(html, /styles\/foundation\.css/);
  assert.deepEqual(uninstallPalettes, palettes);
});

test('Your data sheet (row 95) is flat, palette-neutral and uses only foundation tokens', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'settings-data-storage.css'), 'utf8');
  const foundation = fs.readFileSync(path.join(__dirname, '..', 'styles', 'foundation.css'), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(css, /\b(?:rgb|rgba|hsl|hsla)\s*\(/i);
  assert.doesNotMatch(css, /\[data-palette|palette-[a-z]/i);
  // No side or left-border highlight bars, no shadows or gradients.
  assert.doesNotMatch(css, /border-(?:left|right|inline-start|inline-end)\s*:/i);
  assert.doesNotMatch(css, /box-shadow|gradient\(/i);
  const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/gi)].map((match) => match[1]))];
  const missing = used.filter((name) => !new RegExp(`^\\s*${name}\\s*:`, 'm').test(foundation));
  assert.deepEqual(missing, [], `tokens missing from foundation.css: ${missing.join(', ')}`);
});

test('index.html mounts Your data above Data & Privacy and loads its sheet and module', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const group = html.indexOf('id="dataStorageGroup"');
  assert.ok(group > 0 && group < html.indexOf('aria-labelledby="dataPrivacyHeading"'));
  assert.match(html, /id="dataStorageGroup"[^>]*\bhidden\b/, 'hidden until Settings measures it, so a disabled flag never flashes the group');
  assert.match(html, /<div id="dataStorageMount"><\/div>/);
  assert.match(html, /<link rel="stylesheet" href="styles\/settings-data-storage\.css">/);
  const lifecycle = html.indexOf('renderer/features/renderer-data-lifecycle.js');
  const storage = html.indexOf('renderer/features/renderer-data-storage.js');
  assert.ok(lifecycle > 0 && storage > lifecycle);
});

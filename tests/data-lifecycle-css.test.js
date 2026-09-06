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

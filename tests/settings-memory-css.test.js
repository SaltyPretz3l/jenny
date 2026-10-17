'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('Memory Settings styles use flat hairline rows and load after the shared settings layers', () => {
  const imports = fs.readFileSync(path.join(root, 'styles', 'settings.css'), 'utf8').trim().split(/\r?\n/);
  const css = fs.readFileSync(path.join(root, 'styles', 'settings-memory.css'), 'utf8');
  const baseRecord = /\.memory-record\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';

  // Memory loads after every shared settings layer; only per-section sheets
  // (Projects v2, 2026-09-20) may follow it.
  const memoryIndex = imports.indexOf('@import url("./settings-memory.css");');
  assert.ok(memoryIndex > imports.indexOf('@import url("./settings-affordances.css");'));
  assert.deepEqual(imports.slice(memoryIndex + 1), ['@import url("./settings-projects.css");']);
  assert.doesNotMatch(baseRecord, /\bborder(?:-radius)?\s*:/);
  assert.doesNotMatch(baseRecord, /\bbackground(?:-color)?\s*:/);
  assert.match(css, /\.memory-record \+ \.memory-record\s*\{\s*border-top:/);
  // Text takes the row; the always-on switch and the ⋯ menu never wrap apart.
  assert.match(baseRecord, /grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.memory-record-main\s*\{[^}]*min-width:\s*0;/s);
  assert.match(css, /\.memory-record-side\s*\{[^}]*white-space:\s*nowrap;/s);
  // The pending proposals are the one tinted block, from a token.
  assert.match(css, /\.memory-pending\s*\{[^}]*background:\s*var\(--accent-a-12\);/s);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'colors come from tokens');
  assert.match(css, /\.memory-scope-tab:focus-visible/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
});

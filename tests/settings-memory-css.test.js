'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('Memory Settings styles use flat hairline rows and remain last in settings order', () => {
  const imports = fs.readFileSync(path.join(root, 'styles', 'settings.css'), 'utf8').trim().split(/\r?\n/);
  const css = fs.readFileSync(path.join(root, 'styles', 'settings-memory.css'), 'utf8');
  const baseRecord = /\.memory-record\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';

  assert.equal(imports.at(-1), '@import url("./settings-memory.css");');
  assert.doesNotMatch(baseRecord, /\bborder(?:-radius)?\s*:/);
  assert.doesNotMatch(baseRecord, /\bbackground(?:-color)?\s*:/);
  assert.match(css, /\.memory-record \+ \.memory-record\s*\{\s*border-top:/);
  assert.match(css, /\.memory-record-main\s*\{[^}]*flex:\s*1 1 auto;/s);
  assert.match(css, /\.memory-record-actions\s*\{[^}]*flex:\s*0 0 auto;[^}]*flex-wrap:\s*nowrap;/s);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
});

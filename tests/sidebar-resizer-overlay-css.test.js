'use strict';

// The expanded Chats panel and the tab band meet flush: the sidebar resizer
// takes a 0-wide grid track and overlays the panel edge with its 10px hit
// area. A 10px track showed as a gap between the panel and the first tab
// (owner report, 2026-09-29). jsdom has no grid layout, so this pins source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const body = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} exists`);
  return css.slice(start, css.indexOf('}', start));
};

test('no grid template reserves a track for the sidebar resizer', () => {
  for (const file of ['styles/shell-chrome.css', 'styles/view-panel.css']) {
    const css = read(file);
    assert.doesNotMatch(css, /grid-template-columns:[^;]*var\(--sidebar-resizer-width\)/, `${file} keeps the resizer track at 0`);
  }
  assert.match(body(read('styles/shell-chrome.css'), '.workspace'),
    /grid-template-columns: var\(--sidebar-current-width\) 0 minmax\(0, 1fr\);/);
});

test('the resizer straddles the panel edge above both neighbours and keeps its hit area', () => {
  const resizer = body(read('styles/sidebar.css'), '.sidebar-resizer');
  assert.match(resizer, /width: var\(--sidebar-resizer-width\);/);
  assert.match(resizer, /margin-inline: calc\(var\(--sidebar-resizer-width\) \/ -2\);/);
  assert.match(resizer, /z-index: var\(--z-raised\);/);
});

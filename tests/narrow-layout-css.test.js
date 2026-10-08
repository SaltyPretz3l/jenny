'use strict';

// jsdom has no layout: these pin the source shape of fixes from the 2026-10-06 agent-run gate
// sitting, where narrow panes cut names to one letter, hid overflowing tabs and clipped buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'styles', name), 'utf8');
const ruleIn = (css, selector) => {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `${selector} rule exists`);
  return css.slice(start, css.indexOf('}', start));
};

test('Git row actions overlay the row end and take no width while hidden', () => {
  const css = read('ide-source-control.css');
  const actions = ruleIn(css, '.ide-scm-row-actions');
  assert.match(actions, /position: absolute;/);
  assert.match(actions, /visibility: hidden;/, 'a hidden Discard catches no clicks');
  assert.match(ruleIn(css, '.ide-scm-row'), /position: relative;/);
  assert.match(css, /\.ide-scm-row:focus-within \.ide-scm-row-actions \{\s*visibility: visible;/);
});

test('a scrolling tab strip fades the edges that have more tabs', () => {
  const css = read('ide-workbench.css');
  const tabs = ruleIn(css, '.wb-tabs');
  assert.match(tabs, /animation-timeline: scroll\(self inline\);/);
  assert.match(tabs, /mask-image: linear-gradient\(to right,/);
  assert.match(css, /\.wb-tabs:dir\(rtl\) \{\s*mask-image: linear-gradient\(to left,/);
  assert.match(css, /@property --wb-tabs-fade-start \{[^}]*initial-value: 0px;/, 'a strip that fits shows no fade');
});

test('the notes chat row wraps its actions instead of clipping Undo', () => {
  const css = read('task-rail.css');
  assert.match(ruleIn(css, '.notes-chat__row'), /flex-wrap: wrap;/);
  assert.match(ruleIn(css, '.notes-chat__title'), /text-overflow: ellipsis;/);
});

test('the File Map Hide tests readout sits beside its switch', () => {
  const css = read('ide-file-map.css');
  assert.match(ruleIn(css, '.ide-map-hide-tests'), /display: inline-flex;[\s\S]*gap: 6px;/);
});

test('MCP editor field groups keep their fields as direct grid items', () => {
  assert.match(read('settings-mcp-servers.css'), /\.mcp-editor-group:not\(\[hidden\]\) \{\s*display: contents;/);
});

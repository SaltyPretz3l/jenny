'use strict';

// jsdom has no layout: this pins the source shape that keeps a History row's title readable
// in a narrow Changes panel (the actions wrap under it instead of crushing it to one letter).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'changes-view.css'), 'utf8');
const rule = (selector) => {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `${selector} rule exists`);
  return css.slice(start, css.indexOf('}', start));
};

test('a History row wraps its actions and keeps a claim on width for its title', () => {
  assert.match(rule('.changes-history-turn-head'), /flex-wrap: wrap;/);
  assert.match(rule('.changes-history-title'), /flex: 1 1 12ch;/);
  assert.match(rule('.changes-history-title'), /text-overflow: ellipsis;/);
});

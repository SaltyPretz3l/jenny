'use strict';

/* Pure filter state behind the Problems panel toolbar (the DOM behaviour is
 * covered in renderer-ide-problems-panel.test.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createProblemsFilter, groupMarkers, GLYPHS } = require('../renderer/features/renderer-ide-problems-filter');

const m = (severity, message, extra) => Object.assign({ severity, message, line: 1, column: 1, source: '', code: '' }, extra || {});
const groups = () => [
  { path: 'src/a.js', worst: 0, items: [m('error', 'Boom', { source: 'ts', code: '2304' }), m('hint', 'tiny')] },
  { path: 'lib/b.js', worst: 1, items: [m('warning', 'careful'), m('info', 'fyi')] },
];

test('inactive by default and returns the groups untouched', () => {
  const filter = createProblemsFilter();
  const input = groups();
  assert.equal(filter.isActive(), false);
  const out = filter.apply(input, '', 4);
  assert.equal(out.groups, input);
  assert.equal(out.shown, 4);
});

test('severity toggles hide their markers and hint follows info', () => {
  const filter = createProblemsFilter();
  filter.toggle('info');
  assert.equal(filter.isActive(), true);
  const out = filter.apply(groups(), '', 4);
  assert.deepEqual(out.groups.map((g) => [g.path, g.items.length]), [['src/a.js', 1], ['lib/b.js', 1]]);
  assert.equal(out.shown, 2);
  filter.toggle('error');
  filter.toggle('warning');
  assert.equal(filter.apply(groups(), '', 4).shown, 0);
});

test('text matches message, source, code and path case-insensitively', () => {
  const filter = createProblemsFilter();
  const shownFor = (text) => { filter.state.text = text; return filter.apply(groups(), '', 4).shown; };
  assert.equal(shownFor('BOOM'), 1);
  assert.equal(shownFor('ts'), 1, 'source');
  assert.equal(shownFor('2304'), 1);
  assert.equal(shownFor('lib/'), 2, 'path matches every marker of the file');
  assert.equal(shownFor('   '), 4, 'whitespace-only text is no filter');
});

test('activeOnly keeps just the active path; clear resets everything; unknown toggles are ignored', () => {
  const filter = createProblemsFilter();
  filter.toggle('activeOnly');
  assert.deepEqual(filter.apply(groups(), 'lib/b.js', 4).groups.map((g) => g.path), ['lib/b.js']);
  assert.equal(filter.apply(groups(), '', 4).shown, 0);
  filter.toggle('text');
  filter.state.text = 'x';
  filter.clear();
  assert.deepEqual(filter.state, { text: '', error: true, warning: true, info: true, activeOnly: false });
  assert.equal(filter.isActive(), false);
});

test('exposes the toolbar glyphs', () => {
  assert.match(GLYPHS.collapseAll, /^<svg/);
  assert.match(GLYPHS.expandAll, /^<svg/);
  assert.match(GLYPHS.chevron, /^<svg/);
});

test('groupMarkers groups by file, rows by position, files worst-first then by path, with counts', () => {
  const built = groupMarkers([
    m('warning', 'w', { path: 'b.js', line: 9 }),
    m('error', 'e2', { path: 'c.js', line: 5, column: 3 }),
    m('error', 'e1', { path: 'c.js', line: 5, column: 1 }),
    m('warning', 'w2', { path: 'a.js', line: 1 }),
  ]);
  assert.deepEqual(built.groups.map((g) => [g.path, g.worst, g.items.map((x) => x.message)]), [
    ['c.js', 0, ['e1', 'e2']], ['a.js', 1, ['w2']], ['b.js', 1, ['w']],
  ]);
  assert.deepEqual(built.counts, { error: 2, warning: 2, info: 0, hint: 0, total: 4 });
  assert.deepEqual(groupMarkers(null), { groups: [], counts: { error: 0, warning: 0, info: 0, hint: 0, total: 0 } });
});

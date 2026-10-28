'use strict';

/* tests/renderer-ide-map-components-model.test.js - row 77 phase 3: the pure
 * model of the File Map's Components lens
 * (renderer/features/renderer-ide-map-components-model.js). The fixture is
 * Jenny's own root level as the phase 2 engine drafts it. */

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/features/renderer-ide-map-components-model');

function box(id, parentId, name, fileCount, label, files) {
  const c = { id, parentId, name, origin: 'box', depth: parentId ? 2 : 1, fileCount, label: label || { kind: 'folder', text: name }, parts: [] };
  if (files) c.files = files;
  return c;
}

// Jenny's root (2026-10-25): eight components, fourteen import relations.
function jennyRoot() {
  const roots = [
    ['1', 'services', 895], ['2', 'renderer', 860], ['3', 'sidecar', 628], ['4', 'scripts', 204],
    ['5', 'styles', 170], ['6', 'server', 34], ['8', 'cli', 15],
  ].map(([id, name, n]) => box(id, null, name, n, null, [`${name}/a.js`]));
  roots.push(box('7', null, 'Loose files', 30, { kind: 'loose', dir: '' }, ['main.js']));
  const rel = (from, to, weight) => ({ scopeId: 'root', from, to, weight });
  return {
    version: 1,
    scopes: [{ id: 'root', rung: 'frontier', axis: 'structural', leafReason: '', leafKind: '', ruleCount: 8 }],
    components: roots,
    relations: [
      rel('4', '3', 50), rel('4', '1', 47), rel('7', '1', 35), rel('8', '1', 28), rel('6', '1', 20),
      rel('1', '2', 19), rel('1', '6', 10), rel('4', '2', 9), rel('5', '2', 7), rel('1', '7', 5),
      rel('1', '4', 1), rel('2', '7', 1), rel('4', '7', 1), rel('6', '2', 1),
    ],
    outside: [],
    outsideRelations: [],
  };
}

const names = (row, index) => row.components.map((c) => index.byId.get(c.id).name);

test('rows put importers above what they import, three rows at most', () => {
  const draft = jennyRoot();
  const index = model.indexComponents(draft);
  const rows = model.layoutRows(index.childrenOf(null), model.levelRelations(draft, null));
  assert.deepEqual(rows.map((row) => names(row, index)), [
    ['scripts', 'styles', 'server', 'Loose files', 'cli'],
    // sidecar links only to scripts (first above), so it sits left of services.
    ['sidecar', 'services'],
    ['renderer'],
  ]);
  assert.ok(rows.every((row) => !row.unlinked));
});

test('a two-way pair ranks by its heavier direction; a chain clamps into the last row', () => {
  const chain = ['a', 'b', 'c', 'd', 'e'].map((id, i) => box(id, null, id, 10 - i));
  const rel = (from, to, weight) => ({ scopeId: 'root', from, to, weight });
  const relations = [rel('a', 'b', 9), rel('b', 'c', 9), rel('c', 'd', 9), rel('d', 'e', 9), rel('b', 'a', 3)];
  const rows = model.layoutRows(chain, relations);
  assert.deepEqual(rows.map((row) => row.components.map((c) => c.id)), [['a'], ['b'], ['c', 'd', 'e']]);
});

test('a box with no import link takes a last row of its own', () => {
  const draft = jennyRoot();
  draft.components.push(box('9', null, 'docs-site', 12, null, ['docs-site/a.js']));
  const index = model.indexComponents(draft);
  const rows = model.layoutRows(index.childrenOf(null), model.levelRelations(draft, null));
  const last = rows[rows.length - 1];
  assert.equal(last.unlinked, true);
  assert.deepEqual(names(last, index), ['docs-site']);
});

test('only the strong links draw at rest: a tenth of the heaviest, twelve at most', () => {
  const draft = jennyRoot();
  const strong = model.strongLinks(model.levelRelations(draft, null));
  assert.equal(strong.length, 10);
  assert.deepEqual(strong.map((r) => r.weight), [50, 47, 35, 28, 20, 19, 10, 9, 7, 5]);
  const many = Array.from({ length: 30 }, (_, i) => ({ scopeId: 'root', from: `a${i}`, to: `b${i}`, weight: 100 }));
  assert.equal(model.strongLinks(many).length, model.STRONG_MAX);
});

test('labels: workspace names stay literal, generated ones become i18n keys', () => {
  const draft = { components: [
    box('1', null, 'services', 30, null, null),
    box('1.1', '1', 'Loose files in services', 10, { kind: 'loose', dir: 'services' }, ['services/a.js', 'services/b.js']),
    box('1.1.1', '1.1', 'Loose files in services', 4, { kind: 'loose', dir: 'services' }, ['services/a.js']),
    box('1.2', '1', 'backend', 20, null, ['services/backend/x.js']),
    box('2', null, 'Loose files in lib.util', 3, { kind: 'loose', dir: 'lib/util' }, ['lib/util/u.js']),
  ] };
  const index = model.indexComponents(draft);
  const label = (id) => model.labelFor(index.byId.get(id), index.byId.get(index.byId.get(id).parentId), index.filesOf);
  assert.deepEqual(label('1'), { text: 'services' });
  assert.equal(label('1.1').key, 'ide.map.components.label.topLevel');
  assert.equal(label('1.1.1').key, 'ide.map.components.label.ungrouped');
  assert.deepEqual(label('2'), { key: 'ide.map.components.label.filesIn', params: { dir: 'lib/util' } });
  const of = (lbl) => model.labelFor({ name: 'x', label: lbl }, null, index.filesOf);
  assert.deepEqual(of({ kind: 'family', stem: 'renderer-chat-', more: false }), { text: 'renderer-chat-*' });
  assert.deepEqual(of({ kind: 'family', stem: 'managed-', more: true }).params, { name: 'managed-*' });
  assert.deepEqual(of({ kind: 'other', word: 'route' }), { key: 'ide.map.components.label.otherWord', params: { word: 'route' } });
  assert.equal(of({ kind: 'other', word: '' }).key, 'ide.map.components.label.other');
  assert.equal(of({ kind: 'all' }).key, 'ide.map.components.label.all');
  assert.equal(of({ kind: 'residual', text: 'renderer' }).params.name, 'renderer');
  assert.equal(of({ kind: 'loose', dir: '' }).key, 'ide.map.components.label.topLevel');
  assert.deepEqual(model.labelFor({ name: 'old payload' }, null, index.filesOf), { text: 'old payload' });
});

test('an open component is re-found by its names after the ids renumber (F3)', () => {
  const before = model.indexComponents({ components: [
    box('1', null, 'services', 20, null, null), box('1.1', '1', 'backend', 12, null, ['s/b.js']), box('1.2', '1', 'main', 8, null, ['s/m.js']),
  ] });
  const path = model.namePath(before, '1.2');
  assert.deepEqual(path, ['services', 'main']);
  const after = model.indexComponents({ components: [
    box('1', null, 'renderer', 30, null, ['r/a.js']), box('2', null, 'services', 20, null, null),
    box('2.1', '2', 'main', 9, null, ['s/m.js']), box('2.2', '2', 'backend', 11, null, ['s/b.js']),
  ] });
  assert.equal(model.resolvePath(after, path), '2.1');
  assert.equal(model.resolvePath(after, ['services', 'gone']), '2', 'the deepest match stays open');
  assert.equal(model.resolvePath(after, ['gone']), null, 'otherwise the root');
});

test('a box\'s files are its leaves\' and search counts them', () => {
  const index = model.indexComponents({ components: [
    box('1', null, 'app', 3, null, null), box('1.1', '1', 'chat', 2, null, ['app/chat/a.js', 'app/chat/session.js']), box('1.2', '1', 'shell', 1, null, ['app/shell/session-x.js']),
  ] });
  assert.deepEqual(index.filesOf('1'), ['app/chat/a.js', 'app/chat/session.js', 'app/shell/session-x.js']);
  assert.equal(model.searchCount(index.filesOf('1'), 'SESSION'), 2);
  assert.equal(model.searchCount(index.filesOf('1'), '  '), 0);
  assert.equal(model.commonDir(index.filesOf('1')), 'app');
  assert.equal(model.commonDir(index.filesOf('1.1')), 'app/chat');
});

test('captions, box widths and link paths', () => {
  assert.equal(model.leafCaptionKind(null), 'unsplit');
  assert.equal(model.leafCaptionKind({ leafKind: 'small' }), 'small');
  assert.equal(model.leafCaptionKind({ leafKind: 'exhausted' }), 'cohesive');
  assert.equal(model.axisKind({ rung: 'files', axis: 'files' }), 'families');
  assert.equal(model.axisKind({ rung: 'role', axis: 'role' }), 'roles');
  assert.equal(model.axisKind({ rung: 'unmerge', axis: 'structural' }), 'merged');
  assert.equal(model.axisKind({ rung: 'frontier', axis: 'structural' }), 'folder');
  assert.equal(model.boxWidth(895, 895), 270);
  assert.equal(model.boxWidth(0, 895), 150);
  const s = { l: 0, r: 100, t: 0, b: 40, cx: 50, cy: 20 };
  assert.match(model.linkPath(s, { l: 0, r: 100, t: 100, b: 140, cx: 50, cy: 120 }), /^M50,40 C/);
  assert.match(model.linkPath(s, { l: 200, r: 300, t: 0, b: 40, cx: 250, cy: 20 }), /^M100,14 C/);
  assert.deepEqual(model.languageMix(['a.js', 'b.js', 'c.py'], (f) => f.split('.').pop()), [['js', 2], ['py', 1]]);
});

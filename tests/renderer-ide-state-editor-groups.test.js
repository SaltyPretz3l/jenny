'use strict';

/* Row 40 W5-S1: the ide state reducers keep the editor-group invariant
 * (activeTabPath is a primary tab; grouped tabs persist sparsely). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ideState = require('../renderer/features/renderer-ide-state');

function seeded(tabs, active) {
  const ide = ideState.createIdeUiState();
  ide.openTabs = tabs;
  ide.activeTabPath = active;
  return ide;
}

function file(path, extra) {
  return { path, kind: 'file', ...(extra || {}) };
}

test('createIdeUiState and resetIdeRootState carry an empty runtime groupActive map', () => {
  const ide = ideState.createIdeUiState();
  assert.deepEqual(ide.groupActive, {});
  ide.groupActive['editor-2'] = 'a.js';
  ideState.resetIdeRootState(ide);
  assert.deepEqual(ide.groupActive, {});
});

test('openTab on a grouped tab moves it back to the primary and activates it', () => {
  const ide = seeded([file('a.js'), file('c.js', { group: 'editor-2' })], 'a.js');
  ide.groupActive = { 'editor-2': 'c.js' };
  ideState.openTab(ide, 'c.js');
  assert.equal(ide.activeTabPath, 'c.js');
  assert.equal('group' in ide.openTabs[1], false);
  assert.equal(ide.openTabs.length, 2);
  assert.deepEqual(ide.groupActive, {}, 'the stale group entry is cleared');
});

test('openTab on a grouped tab leaves another group entry untouched', () => {
  const ide = seeded([
    file('c.js', { group: 'editor-2' }),
    file('d.js', { group: 'editor-2' }),
  ], '');
  ide.groupActive = { 'editor-2': 'd.js' };
  ideState.openTab(ide, 'c.js');
  assert.deepEqual(ide.groupActive, { 'editor-2': 'd.js' });
  assert.equal(ide.openTabs[0].group, undefined);
  assert.equal(ide.openTabs[1].group, 'editor-2');
});

test('openTab of a new path creates a primary tab without a group key', () => {
  const ide = seeded([file('c.js', { group: 'editor-2' })], '');
  ideState.openTab(ide, 'n.js');
  assert.equal('group' in ide.openTabs[1], false);
  assert.equal(ide.activeTabPath, 'n.js');
});

test('closeTab of the active primary tab picks the right then left PRIMARY neighbour', () => {
  const ide = seeded([
    file('a.js'),
    file('g1.js', { group: 'editor-2' }),
    file('b.js'),
    file('g2.js', { group: 'editor-3' }),
    file('c.js'),
  ], 'b.js');
  assert.equal(ideState.closeTab(ide, 'b.js'), 'c.js', 'c.js is the next primary tab to the right');
  assert.equal(ide.activeTabPath, 'c.js');
  assert.equal(ideState.closeTab(ide, 'c.js'), 'a.js', 'to the left, skipping the grouped tab g2');
  assert.equal(ide.activeTabPath, 'a.js');
  assert.deepEqual(ide.openTabs.map((tab) => tab.path), ['a.js', 'g1.js', 'g2.js']);
});

test('closeTab never activates a grouped tab, even when it is the right neighbour', () => {
  const ide = seeded([file('a.js'), file('b.js'), file('g.js', { group: 'editor-2' })], 'b.js');
  assert.equal(ideState.closeTab(ide, 'b.js'), 'a.js');
  assert.equal(ide.activeTabPath, 'a.js');
});

test('closeTab of the last primary tab empties the active path while groups keep their tabs', () => {
  const ide = seeded([file('a.js'), file('g.js', { group: 'editor-2' })], 'a.js');
  assert.equal(ideState.closeTab(ide, 'a.js'), '');
  assert.equal(ide.activeTabPath, '');
  assert.equal(ide.openTabs.length, 1);
});

test('closeTab of a grouped tab keeps the primary active tab and clears its groupActive entry', () => {
  const ide = seeded([file('a.js'), file('c.js', { group: 'editor-2' }), file('d.js', { group: 'editor-2' })], 'a.js');
  ide.groupActive = { 'editor-2': 'c.js', 'editor-3': 'zzz.js' };
  assert.equal(ideState.closeTab(ide, 'c.js'), 'a.js');
  assert.equal(ide.activeTabPath, 'a.js');
  assert.deepEqual(ide.groupActive, { 'editor-3': 'zzz.js' });
});

test('closeTab of an unknown path returns the current active path', () => {
  const ide = seeded([file('a.js')], 'a.js');
  assert.equal(ideState.closeTab(ide, 'nope.js'), 'a.js');
  assert.equal(ide.openTabs.length, 1);
});

test('toPersistedState emits group sparsely and only for valid ids', () => {
  const ide = seeded([
    file('a.js'),
    file('c.js', { group: 'editor-2' }),
    file('d.js', { group: 'editor-4', pinned: true }),
    file('bad.js', { group: 'editor-9' }),
    file('one.js', { group: 'editor-1' }),
    file('tmp.js', { group: 'editor-3', transientPreview: true }),
  ], 'a.js');
  ide.groupActive = { 'editor-2': 'c.js' };
  const persisted = ideState.toPersistedState(ide);
  assert.deepEqual(persisted.openTabs, [
    { path: 'a.js' },
    { path: 'c.js', group: 'editor-2' },
    { path: 'd.js', pinned: true, group: 'editor-4' },
    { path: 'bad.js' },
    { path: 'one.js' },
    { path: 'tmp.js', preview: true, group: 'editor-3' },
  ]);
  assert.equal('groupActive' in persisted, false, 'the group active map is runtime-only');
  assert.equal(persisted.activeTabPath, 'a.js');
});

test('applyPersistedState restores valid groups and drops invalid ones', () => {
  const ide = ideState.createIdeUiState();
  ideState.applyPersistedState(ide, {
    openTabs: [
      { path: 'a.js' },
      { path: 'c.js', group: 'editor-2' },
      { path: 'bad.js', group: 'editor-9' },
      { path: 'one.js', group: 'editor-1' },
      { path: 'num.js', group: 3 },
      'plain.js',
    ],
    activeTabPath: 'a.js',
  });
  assert.deepEqual(ide.openTabs.map((tab) => [tab.path, tab.group]), [
    ['a.js', undefined],
    ['c.js', 'editor-2'],
    ['bad.js', undefined],
    ['one.js', undefined],
    ['num.js', undefined],
    ['plain.js', undefined],
  ]);
  assert.equal(ide.openTabs.every((tab) => tab.kind === 'file'), true);
  assert.equal('group' in ide.openTabs[2], false, 'an invalid group key is not copied');
  assert.equal(ide.activeTabPath, 'a.js');
  assert.deepEqual(ide.groupActive, {});
});

test('applyPersistedState never lets activeTabPath name a grouped tab', () => {
  const ide = ideState.createIdeUiState();
  ide.groupActive = { 'editor-2': 'stale.js' };
  ideState.applyPersistedState(ide, {
    openTabs: [{ path: 'c.js', group: 'editor-2' }, { path: 'a.js' }, { path: 'b.js' }],
    activeTabPath: 'c.js',
  });
  assert.equal(ide.activeTabPath, 'a.js', 'falls back to the first primary tab');
  assert.deepEqual(ide.groupActive, {});
});

test('applyPersistedState with only grouped tabs leaves no primary active tab', () => {
  const ide = ideState.createIdeUiState();
  ideState.applyPersistedState(ide, {
    openTabs: [{ path: 'c.js', group: 'editor-3' }],
    activeTabPath: 'c.js',
  });
  assert.equal(ide.activeTabPath, '');
  assert.equal(ide.openTabs[0].group, 'editor-3');
});

test('applyPersistedState falls back to the first primary tab for an unknown active path', () => {
  const ide = ideState.createIdeUiState();
  ideState.applyPersistedState(ide, {
    openTabs: [{ path: 'c.js', group: 'editor-2' }, { path: 'a.js' }],
    activeTabPath: 'missing.js',
  });
  assert.equal(ide.activeTabPath, 'a.js');
});

test('persist then restore round-trips groups, pins and the primary active tab', () => {
  const source = seeded([
    file('a.js', { pinned: true }),
    file('c.js', { group: 'editor-2' }),
    file('b.js'),
    file('e.js', { group: 'editor-3', viewMode: 'exploded' }),
  ], 'b.js');
  source.groupActive = { 'editor-2': 'c.js' };
  const wire = JSON.parse(JSON.stringify(ideState.toPersistedState(source)));
  const restored = ideState.createIdeUiState();
  ideState.applyPersistedState(restored, wire);
  assert.deepEqual(
    restored.openTabs.map((tab) => [tab.path, tab.group || '', tab.pinned === true]),
    [['a.js', '', true], ['c.js', 'editor-2', false], ['b.js', '', false], ['e.js', 'editor-3', false]]
  );
  assert.equal(restored.openTabs[3].viewMode, 'exploded');
  assert.equal(restored.activeTabPath, 'b.js');
  assert.deepEqual(restored.groupActive, {});
});

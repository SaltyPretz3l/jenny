'use strict';

/* Row 40 W5-S1: the persisted tab `group` key of the workspaceIde slice is additive
 * (no CONFIG_VERSION bump) and sparse; activeTabPath never names a grouped tab. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeWorkspaceIde } = require('../services/workspace-ide-config-schema');

test('a valid group rides through on the tab, sparse for primary tabs', () => {
  const out = normalizeWorkspaceIde({
    openTabs: [
      { path: 'a.js' },
      { path: 'b.js', group: 'editor-2' },
      { path: 'c.js', group: 'editor-4', pinned: true, viewMode: 'exploded' },
    ],
    activeTabPath: 'a.js',
  });
  assert.deepEqual(out.openTabs, [
    { path: 'a.js', pinned: false },
    { path: 'b.js', pinned: false, group: 'editor-2' },
    { path: 'c.js', pinned: true, viewMode: 'exploded', group: 'editor-4' },
  ]);
  assert.equal('group' in out.openTabs[0], false);
  assert.equal(out.activeTabPath, 'a.js');
});

test('invalid group values are dropped, leaving a primary tab', () => {
  const bad = ['editor-1', 'editor-5', 'editor-22', 'Editor-2', ' editor-2', '', 'editor-', 2, null, true, {}, ['editor-2']];
  const out = normalizeWorkspaceIde({
    openTabs: bad.map((group, i) => ({ path: `f${i}.js`, group })),
  });
  assert.equal(out.openTabs.length, bad.length);
  assert.equal(out.openTabs.every((tab) => !('group' in tab)), true);
});

test('string and legacy entries have no group', () => {
  const out = normalizeWorkspaceIde({ openTabs: ['a.js', { path: 'b.js' }] });
  assert.deepEqual(out.openTabs, [{ path: 'a.js', pinned: false }, { path: 'b.js', pinned: false }]);
});

test('a non-file tab kind never carries a group', () => {
  const out = normalizeWorkspaceIde({
    openTabs: [
      { path: 'a.js', kind: 'diff', group: 'editor-2' },
      { path: 'b.js', kind: 'file', group: 'editor-3' },
      { path: 'c.js', kind: 'preview', group: 'editor-2' },
    ],
  });
  assert.deepEqual(out.openTabs.map((tab) => tab.group), [undefined, 'editor-3', undefined]);
});

test('activeTabPath naming a grouped tab normalizes to empty', () => {
  const tabs = [{ path: 'a.js' }, { path: 'g.js', group: 'editor-3' }];
  assert.equal(normalizeWorkspaceIde({ openTabs: tabs, activeTabPath: 'g.js' }).activeTabPath, '');
  assert.equal(normalizeWorkspaceIde({ openTabs: tabs, activeTabPath: 'a.js' }).activeTabPath, 'a.js');
  assert.equal(normalizeWorkspaceIde({ openTabs: tabs, activeTabPath: 'missing.js' }).activeTabPath, '');
});

test('activeTabPath naming a tab whose group was invalid stays valid (it is primary)', () => {
  const out = normalizeWorkspaceIde({
    openTabs: [{ path: 'a.js', group: 'editor-9' }],
    activeTabPath: 'a.js',
  });
  assert.equal(out.activeTabPath, 'a.js');
});

test('normalizing twice is stable', () => {
  const once = normalizeWorkspaceIde({
    openTabs: [{ path: 'a.js' }, { path: 'g.js', group: 'editor-2', pinned: true }],
    activeTabPath: 'a.js',
  });
  const twice = normalizeWorkspaceIde(once);
  assert.deepEqual(twice.openTabs, once.openTabs);
  assert.equal(twice.activeTabPath, once.activeTabPath);
});

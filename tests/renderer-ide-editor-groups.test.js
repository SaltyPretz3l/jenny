'use strict';

/* Row 40 W5-S1: the pure editor-group helpers over the ide slice (no DOM). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const groups = require('../renderer/features/renderer-ide-editor-groups');

const {
  MAX_GROUPS,
  isGroupId,
  groupOf,
  tabsIn,
  usedGroups,
  getGroupActive,
  setGroupActive,
  neighbourInGroup,
  moveTab,
  freeGroupId,
  releaseGroup,
} = groups;

function file(path, extra) {
  return { path, kind: 'file', ...(extra || {}) };
}

function makeIde(tabs, active, groupActive) {
  return { openTabs: tabs, activeTabPath: active === undefined ? '' : active, groupActive: groupActive || {} };
}

function paths(list) {
  return list.map((tab) => tab.path);
}

// a, b primary; c, d in editor-2; e in editor-3.
function sample() {
  return makeIde([
    file('a.js'),
    file('c.js', { group: 'editor-2' }),
    file('b.js'),
    file('d.js', { group: 'editor-2' }),
    file('e.js', { group: 'editor-3' }),
  ], 'a.js', { 'editor-2': 'd.js' });
}

test('MAX_GROUPS counts the primary plus three secondary groups', () => {
  assert.equal(MAX_GROUPS, 4);
});

test('isGroupId accepts only editor-2..4', () => {
  for (const id of ['editor-2', 'editor-3', 'editor-4']) assert.equal(isGroupId(id), true, id);
  for (const id of ['', 'editor-1', 'editor-5', 'editor-22', 'editor-', 'Editor-2', ' editor-2', null, undefined, 2, {}]) {
    assert.equal(isGroupId(id), false, String(id));
  }
});

test('groupOf returns the group id, or empty for primary and unknown paths', () => {
  const ide = sample();
  assert.equal(groupOf(ide, 'c.js'), 'editor-2');
  assert.equal(groupOf(ide, 'e.js'), 'editor-3');
  assert.equal(groupOf(ide, 'a.js'), '');
  assert.equal(groupOf(ide, 'nope.js'), '');
  ide.openTabs.push(file('weird.js', { group: 'editor-9' }));
  assert.equal(groupOf(ide, 'weird.js'), '', 'an invalid group id reads as primary');
});

test('tabsIn returns tab objects in openTabs order, empty id meaning primary', () => {
  const ide = sample();
  assert.deepEqual(paths(tabsIn(ide, '')), ['a.js', 'b.js']);
  assert.deepEqual(paths(tabsIn(ide, 'editor-2')), ['c.js', 'd.js']);
  assert.deepEqual(paths(tabsIn(ide, 'editor-3')), ['e.js']);
  assert.deepEqual(tabsIn(ide, 'editor-4'), []);
  assert.equal(tabsIn(ide, 'editor-2')[0], ide.openTabs[1], 'the same tab object, not a copy');
});

test('usedGroups lists sorted unique secondary ids with at least one tab', () => {
  const ide = sample();
  ide.openTabs.unshift(file('z.js', { group: 'editor-4' }));
  ide.openTabs.push(file('y.js', { group: 'editor-2' }));
  assert.deepEqual(usedGroups(ide), ['editor-2', 'editor-3', 'editor-4']);
  assert.deepEqual(usedGroups(makeIde([file('a.js')], 'a.js')), []);
  assert.deepEqual(usedGroups(makeIde([], '')), []);
});

test('getGroupActive: primary reads activeTabPath, a secondary group validates and falls back', () => {
  const ide = sample();
  assert.equal(getGroupActive(ide, ''), 'a.js');
  assert.equal(getGroupActive(ide, 'editor-2'), 'd.js');
  assert.equal(getGroupActive(ide, 'editor-3'), 'e.js', 'no entry falls back to the first tab');
  assert.equal(getGroupActive(ide, 'editor-4'), '', 'an empty group has no active tab');
  ide.groupActive['editor-2'] = 'e.js';
  assert.equal(getGroupActive(ide, 'editor-2'), 'c.js', 'a stale entry naming another group falls back');
  ide.groupActive['editor-2'] = 'gone.js';
  assert.equal(getGroupActive(ide, 'editor-2'), 'c.js', 'an entry naming no tab falls back');
  delete ide.groupActive;
  assert.equal(getGroupActive(ide, 'editor-2'), 'c.js', 'a missing groupActive map is tolerated');
  assert.equal(getGroupActive(ide, 'not-a-group'), '');
});

test('setGroupActive sets the primary active only for a primary tab', () => {
  const ide = sample();
  assert.equal(setGroupActive(ide, '', 'b.js'), true);
  assert.equal(ide.activeTabPath, 'b.js');
  assert.equal(setGroupActive(ide, '', 'c.js'), false, 'a grouped tab cannot be the primary active');
  assert.equal(setGroupActive(ide, '', 'nope.js'), false);
  assert.equal(ide.activeTabPath, 'b.js');
});

test('setGroupActive sets a secondary group active only for that group\'s tab', () => {
  const ide = sample();
  assert.equal(setGroupActive(ide, 'editor-2', 'c.js'), true);
  assert.equal(ide.groupActive['editor-2'], 'c.js');
  assert.equal(setGroupActive(ide, 'editor-2', 'e.js'), false, 'a tab of another group');
  assert.equal(setGroupActive(ide, 'editor-2', 'a.js'), false, 'a primary tab');
  assert.equal(setGroupActive(ide, 'editor-9', 'c.js'), false, 'an invalid group id');
  assert.equal(ide.groupActive['editor-2'], 'c.js');
  const bare = makeIde([file('x.js', { group: 'editor-3' })], '');
  delete bare.groupActive;
  assert.equal(setGroupActive(bare, 'editor-3', 'x.js'), true, 'creates the map when absent');
  assert.deepEqual(bare.groupActive, { 'editor-3': 'x.js' });
});

test('neighbourInGroup prefers the right neighbour, then the left, within the same group', () => {
  const ide = sample();
  assert.equal(neighbourInGroup(ide, 'a.js'), 'b.js');
  assert.equal(neighbourInGroup(ide, 'b.js'), 'a.js', 'last tab falls back to the left');
  assert.equal(neighbourInGroup(ide, 'c.js'), 'd.js');
  assert.equal(neighbourInGroup(ide, 'd.js'), 'c.js');
  assert.equal(neighbourInGroup(ide, 'e.js'), '', 'a lone tab has no neighbour');
  assert.equal(neighbourInGroup(ide, 'nope.js'), '');
});

test('moveTab primary -> secondary moves the active tab and picks the primary neighbour', () => {
  const ide = sample();
  const result = moveTab(ide, 'a.js', 'editor-4');
  assert.deepEqual(result, { ok: true, from: '', to: 'editor-4', primaryActive: 'b.js' });
  assert.equal(ide.activeTabPath, 'b.js');
  assert.equal(groupOf(ide, 'a.js'), 'editor-4');
  assert.equal(ide.groupActive['editor-4'], 'a.js');
  assert.equal(ide.openTabs.length, 5);
});

test('moveTab of the last primary tab leaves the primary without an active tab', () => {
  const ide = makeIde([file('a.js'), file('c.js', { group: 'editor-2' })], 'a.js');
  const result = moveTab(ide, 'a.js', 'editor-2');
  assert.equal(result.ok, true);
  assert.equal(result.primaryActive, '');
  assert.equal(ide.activeTabPath, '');
  assert.equal(ide.groupActive['editor-2'], 'a.js');
});

test('moveTab of a non-active primary tab keeps the primary active tab', () => {
  const ide = sample();
  const result = moveTab(ide, 'b.js', 'editor-3');
  assert.equal(result.ok, true);
  assert.equal(result.primaryActive, 'a.js');
  assert.equal(ide.activeTabPath, 'a.js');
});

test('moveTab secondary -> primary clears the group and activates the tab', () => {
  const ide = sample();
  const result = moveTab(ide, 'd.js', '');
  assert.deepEqual(result, { ok: true, from: 'editor-2', to: '', primaryActive: 'd.js' });
  assert.equal('group' in ide.openTabs.find((tab) => tab.path === 'd.js'), false, 'group key is deleted');
  assert.equal(ide.activeTabPath, 'd.js');
  assert.equal(ide.groupActive['editor-2'], 'c.js', 'the leaving active falls to its neighbour');
});

test('moveTab out of a secondary group deletes the entry when the group empties', () => {
  const ide = sample();
  const result = moveTab(ide, 'e.js', 'editor-2');
  assert.equal(result.ok, true);
  assert.equal('editor-3' in ide.groupActive, false);
  assert.equal(ide.groupActive['editor-2'], 'e.js');
  assert.deepEqual(usedGroups(ide), ['editor-2']);
});

test('moveTab leaves another tab\'s active entry alone when a non-active tab leaves', () => {
  const ide = sample();
  moveTab(ide, 'c.js', 'editor-3');
  assert.equal(ide.groupActive['editor-2'], 'd.js');
  assert.equal(ide.groupActive['editor-3'], 'c.js');
});

test('moveTab between secondary groups updates both groups', () => {
  const ide = sample();
  const result = moveTab(ide, 'd.js', 'editor-3');
  assert.deepEqual(result, { ok: true, from: 'editor-2', to: 'editor-3', primaryActive: 'a.js' });
  assert.equal(groupOf(ide, 'd.js'), 'editor-3');
  assert.equal(ide.groupActive['editor-3'], 'd.js');
  assert.equal(ide.groupActive['editor-2'], 'c.js');
});

test('moveTab drops transientPreview', () => {
  const ide = makeIde([file('a.js', { transientPreview: true }), file('b.js')], 'a.js');
  assert.equal(moveTab(ide, 'a.js', 'editor-2').ok, true);
  assert.equal('transientPreview' in ide.openTabs[0], false);
});

test('moveTab refuses unknown paths, unsupported tabs and invalid group ids without mutating', () => {
  const ide = sample();
  ide.openTabs.push({ path: 'preview://x', kind: 'preview', label: 'Preview' });
  const before = JSON.stringify(ide);
  assert.deepEqual(moveTab(ide, 'nope.js', 'editor-2'), { ok: false });
  assert.deepEqual(moveTab(ide, 'preview://x', 'editor-2'), { ok: false });
  assert.deepEqual(moveTab(ide, 'a.js', 'editor-5'), { ok: false });
  assert.deepEqual(moveTab(ide, 'a.js', 'editor-1'), { ok: false });
  assert.deepEqual(moveTab(ide, 'a.js', 'bogus'), { ok: false });
  assert.deepEqual(moveTab(ide, 'a.js', undefined), { ok: false });
  assert.equal(JSON.stringify(ide), before);
});

test('moveTab refuses a same-group move with no index change', () => {
  const ide = sample();
  const before = JSON.stringify(ide);
  assert.deepEqual(moveTab(ide, 'a.js', ''), { ok: false });
  assert.deepEqual(moveTab(ide, 'c.js', 'editor-2'), { ok: false });
  assert.deepEqual(moveTab(ide, 'c.js', 'editor-2', 0), { ok: false }, 'already first');
  assert.deepEqual(moveTab(ide, 'd.js', 'editor-2', 99), { ok: false }, 'already last');
  assert.equal(JSON.stringify(ide), before);
});

test('moveTab with an index reorders within the same group', () => {
  const ide = sample();
  const result = moveTab(ide, 'd.js', 'editor-2', 0);
  assert.equal(result.ok, true);
  assert.deepEqual(paths(tabsIn(ide, 'editor-2')), ['d.js', 'c.js']);
  assert.deepEqual(paths(tabsIn(ide, '')), ['a.js', 'b.js'], 'the other groups keep their order');
  assert.equal(ide.activeTabPath, 'a.js');
});

test('moveTab positions a tab inside the destination subsequence', () => {
  const ide = sample();
  moveTab(ide, 'e.js', 'editor-2', 1);
  assert.deepEqual(paths(tabsIn(ide, 'editor-2')), ['c.js', 'e.js', 'd.js']);
  moveTab(ide, 'b.js', 'editor-2', 99);
  assert.deepEqual(paths(tabsIn(ide, 'editor-2')), ['c.js', 'e.js', 'd.js', 'b.js'], 'an oversize index appends');
  moveTab(ide, 'a.js', 'editor-2', -5);
  assert.deepEqual(paths(tabsIn(ide, 'editor-2')), ['a.js', 'c.js', 'e.js', 'd.js', 'b.js'], 'a negative index clamps to 0');
  assert.equal(ide.openTabs.length, 5);
});

test('moveTab ignores a non-integer index (append)', () => {
  const ide = sample();
  moveTab(ide, 'a.js', 'editor-3', 'x');
  assert.deepEqual(paths(tabsIn(ide, 'editor-3')), ['e.js', 'a.js']);
});

test('moveTab keeps pinned tabs first after an indexed move', () => {
  const ide = makeIde([
    file('p.js', { pinned: true }),
    file('a.js'),
    file('q.js', { group: 'editor-2', pinned: true }),
    file('c.js', { group: 'editor-2' }),
  ], 'p.js');
  moveTab(ide, 'a.js', 'editor-2', 0);
  assert.deepEqual(paths(tabsIn(ide, 'editor-2')), ['q.js', 'a.js', 'c.js'], 'the pinned tab stays ahead of the moved one');
  const pinnedFlags = ide.openTabs.map((tab) => tab.pinned === true);
  assert.deepEqual(pinnedFlags, [true, true, false, false]);
});

test('freeGroupId returns the lowest unused group id', () => {
  const ide = sample();
  assert.equal(freeGroupId(ide, []), 'editor-4');
  assert.equal(freeGroupId(makeIde([file('a.js')], 'a.js'), []), 'editor-2');
  assert.equal(freeGroupId(makeIde([file('a.js')], 'a.js')), 'editor-2', 'takenIds is optional');
  assert.equal(freeGroupId(makeIde([], ''), ['editor-2']), 'editor-3');
  assert.equal(freeGroupId(makeIde([], ''), ['editor-2', 'editor-4']), 'editor-3');
  assert.equal(freeGroupId(ide, ['editor-4']), '', 'every id is taken by a tab or the layout');
});

test('releaseGroup appends the group\'s tabs to the primary in order', () => {
  const ide = sample();
  const moved = releaseGroup(ide, 'editor-2');
  assert.deepEqual(moved, ['c.js', 'd.js']);
  assert.deepEqual(paths(tabsIn(ide, '')), ['a.js', 'b.js', 'c.js', 'd.js']);
  assert.deepEqual(usedGroups(ide), ['editor-3']);
  assert.equal(ide.activeTabPath, 'a.js', 'an existing primary active tab is kept');
  assert.equal('editor-2' in ide.groupActive, false);
  assert.equal(ide.openTabs.every((tab) => tab.group !== 'editor-2'), true);
});

test('releaseGroup activates the first moved tab when the primary had none', () => {
  const ide = makeIde([file('c.js', { group: 'editor-2' }), file('d.js', { group: 'editor-2' })], '', { 'editor-2': 'd.js' });
  assert.deepEqual(releaseGroup(ide, 'editor-2'), ['c.js', 'd.js']);
  assert.equal(ide.activeTabPath, 'c.js');
  assert.deepEqual(ide.groupActive, {});
});

test('releaseGroup of an empty or invalid group moves nothing', () => {
  const ide = sample();
  const before = JSON.stringify(ide);
  assert.deepEqual(releaseGroup(ide, 'editor-4'), []);
  assert.deepEqual(releaseGroup(ide, ''), []);
  assert.deepEqual(releaseGroup(ide, 'bogus'), []);
  assert.equal(JSON.stringify(ide), before);
});

'use strict';

/* tests/renderer-ide-explode-state.test.js - red-first coverage for the
 * "Exploded View" per-file-tab viewMode ('code'|'exploded') additions to
 * renderer/features/renderer-ide-state.js (getTabViewMode/setTabViewMode/
 * toggleTabViewMode + the toPersistedState/applyPersistedState round-trip)
 * and the services/workspace-ide-config-schema.js normalizer. Mirrors the
 * `pinned` precedent throughout (tests/renderer-ide-state.test.js's pinned
 * round-trip test, tests/renderer-ide-map-tab.test.js's construction style).
 * Pure module, no DOM required. */

const test = require('node:test');
const assert = require('node:assert/strict');

const ideState = require('../renderer/features/renderer-ide-state');
const {
  createIdeUiState,
  openTab,
  openDiffTab,
  openPreviewTab,
  getTabViewMode,
  setTabViewMode,
  toggleTabViewMode,
  toPersistedState,
  applyPersistedState,
} = ideState;

const { normalizeWorkspaceIde } = require('../services/workspace-ide-config-schema');

function freshIde() {
  return createIdeUiState();
}

test('getTabViewMode: defaults to code for a fresh file tab and for a missing tab', () => {
  const ide = freshIde();
  openTab(ide, 'a.js');
  assert.equal(getTabViewMode(ide, 'a.js'), 'code');
  assert.equal(getTabViewMode(ide, 'never-opened.js'), 'code');
});

test('setTabViewMode: applies exploded/code on a file tab and returns the applied mode', () => {
  const ide = freshIde();
  openTab(ide, 'a.js');
  assert.equal(setTabViewMode(ide, 'a.js', 'exploded'), 'exploded');
  assert.equal(getTabViewMode(ide, 'a.js'), 'exploded');
  // Anything but the literal 'exploded' coerces to 'code'.
  assert.equal(setTabViewMode(ide, 'a.js', 'code'), 'code');
  assert.equal(setTabViewMode(ide, 'a.js', 'bogus'), 'code');
  assert.equal(getTabViewMode(ide, 'a.js'), 'code');
});

test('setTabViewMode: returns null for diff/preview/map tabs and never sets viewMode on them', () => {
  const ide = freshIde();
  openDiffTab(ide, { id: 'diff://a/b', label: 'Diff' });
  openPreviewTab(ide, { id: 'preview://README.md', label: 'Preview' });

  assert.equal(setTabViewMode(ide, 'diff://a/b', 'exploded'), null);
  assert.equal(setTabViewMode(ide, 'preview://README.md', 'exploded'), null);
  // The map is a stage surface now (openMapTab is gone); a legacy id is a miss.
  assert.equal(setTabViewMode(ide, 'map://workspace', 'exploded'), null);

  for (const tab of ide.openTabs) {
    assert.ok(!('viewMode' in tab), `${tab.kind} tab must never gain a viewMode key`);
  }
});

test('toggleTabViewMode: flips code<->exploded only on file tabs', () => {
  const ide = freshIde();
  openTab(ide, 'a.js');
  assert.equal(toggleTabViewMode(ide, 'a.js'), 'exploded');
  assert.equal(getTabViewMode(ide, 'a.js'), 'exploded');
  assert.equal(toggleTabViewMode(ide, 'a.js'), 'code');
  assert.equal(getTabViewMode(ide, 'a.js'), 'code');
});

test('toggleTabViewMode: returns false for diff/preview/map tabs, mirrors toggleTabPinned', () => {
  const ide = freshIde();
  openDiffTab(ide, { id: 'diff://a/b', label: 'Diff' });
  openPreviewTab(ide, { id: 'preview://README.md', label: 'Preview' });

  assert.equal(toggleTabViewMode(ide, 'diff://a/b'), false);
  assert.equal(toggleTabViewMode(ide, 'preview://README.md'), false);
  // The map is a stage surface now (openMapTab is gone); a legacy id is a miss.
  assert.equal(toggleTabViewMode(ide, 'map://workspace'), false);
  assert.equal(toggleTabViewMode(ide, 'never-opened.js'), false);
});

test('toPersistedState: emits viewMode only when exploded, and it coexists with pinned', () => {
  const ide = freshIde();
  openTab(ide, 'a.js');
  openTab(ide, 'b.js');
  openTab(ide, 'c.js');
  setTabViewMode(ide, 'a.js', 'exploded');
  // b.js is both pinned AND exploded - the two flags are independent.
  ide.openTabs.find((tab) => tab.path === 'b.js').pinned = true;
  setTabViewMode(ide, 'b.js', 'exploded');

  const persisted = toPersistedState(ide);

  assert.deepEqual(persisted.openTabs.find((tab) => tab.path === 'a.js'), {
    path: 'a.js',
    viewMode: 'exploded',
  });
  assert.deepEqual(persisted.openTabs.find((tab) => tab.path === 'b.js'), {
    path: 'b.js',
    pinned: true,
    viewMode: 'exploded',
  });
  // c.js never left 'code' - no viewMode key at all (sparse emit, mirrors pinned).
  const unexplodedC = persisted.openTabs.find((tab) => tab.path === 'c.js');
  assert.deepEqual(unexplodedC, { path: 'c.js' });
  assert.ok(!('viewMode' in unexplodedC), 'code-mode tab must not emit a viewMode key');
});

test('applyPersistedState: round-trips exploded and defaults an absent viewMode to code', () => {
  const ide = freshIde();
  applyPersistedState(ide, {
    openTabs: [
      { path: 'a.js', viewMode: 'exploded' },
      { path: 'b.js' }, // no viewMode field -> hydrates 'code'
      { path: 'c.js', viewMode: 'bogus' }, // only literal 'exploded' survives
    ],
  });
  assert.equal(getTabViewMode(ide, 'a.js'), 'exploded');
  assert.equal(getTabViewMode(ide, 'b.js'), 'code');
  assert.equal(getTabViewMode(ide, 'c.js'), 'code');
  assert.equal(ide.openTabs.find((tab) => tab.path === 'b.js').viewMode, 'code');

  // A persisted entry with no viewMode field restores as 'code' (tolerant of
  // legacy/pre-feature payloads), same tolerance pinned already has.
  const tolerant = freshIde();
  applyPersistedState(tolerant, { openTabs: [{ path: 'x.js' }] });
  assert.equal(tolerant.openTabs[0].viewMode, 'code');
});

test('applyPersistedState: pinned and viewMode restore independently on the same tab', () => {
  const ide = freshIde();
  applyPersistedState(ide, {
    openTabs: [{ path: 'a.js', pinned: true, viewMode: 'exploded' }],
  });
  const tab = ide.openTabs.find((t) => t.path === 'a.js');
  assert.equal(tab.pinned, true);
  assert.equal(tab.viewMode, 'exploded');
});

// -- services/workspace-ide-config-schema.js: normalizeWorkspaceIde ---------

test('normalizeWorkspaceIde: viewMode absent normalizes to omitted (never a bare "code" key)', () => {
  const normalized = normalizeWorkspaceIde({
    openTabs: [
      { path: 'a.js' },
      'b.js', // string entry - no viewMode possible either
    ],
  });
  for (const tab of normalized.openTabs) {
    assert.ok(!('viewMode' in tab), 'absent viewMode must stay omitted, not backfilled to "code"');
  }
});

test('normalizeWorkspaceIde: viewMode "exploded" survives; only the literal value is accepted', () => {
  const normalized = normalizeWorkspaceIde({
    openTabs: [
      { path: 'a.js', viewMode: 'exploded' },
      { path: 'b.js', viewMode: 'code' }, // explicit 'code' is still omitted (sparse emit)
      { path: 'c.js', viewMode: 'bogus' },
      { path: 'd.js', viewMode: true },
    ],
  });
  assert.deepEqual(
    normalized.openTabs.find((tab) => tab.path === 'a.js'),
    { path: 'a.js', pinned: false, viewMode: 'exploded' }
  );
  for (const path of ['b.js', 'c.js', 'd.js']) {
    const tab = normalized.openTabs.find((t) => t.path === path);
    assert.ok(!('viewMode' in tab), `${path} must not carry a viewMode key`);
  }
});

test('normalizeWorkspaceIde: viewMode coexists with pinned and existing fixtures stay unaffected', () => {
  // Regression guard: a pre-existing { path, pinned } fixture with no viewMode
  // at all must normalize byte-for-byte the same as before this feature.
  const normalized = normalizeWorkspaceIde({
    openTabs: [{ path: 'src/app.js', pinned: true }],
  });
  assert.deepEqual(normalized.openTabs, [{ path: 'src/app.js', pinned: true }]);

  const both = normalizeWorkspaceIde({
    openTabs: [{ path: 'src/app.js', pinned: true, viewMode: 'exploded' }],
  });
  assert.deepEqual(both.openTabs, [
    { path: 'src/app.js', pinned: true, viewMode: 'exploded' },
  ]);
});

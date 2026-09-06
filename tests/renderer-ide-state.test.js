'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ideState = require('../renderer/features/renderer-ide-state');
const replaceJournal = require('../renderer/features/renderer-ide-replace-journal');
const {
  WORKSPACE_IDE_BOTTOM_VIEWS,
  WORKSPACE_IDE_REPLACE_JOURNAL_MAX_APPLIED,
  WORKSPACE_IDE_REPLACE_JOURNAL_QUERY_MAX,
  normalizeRulers,
} = require('../services/workspace-ide-config-schema');

function freshIde() {
  return ideState.createIdeUiState();
}

test('service ruler normalization drops fractional persisted columns', () => {
  assert.deepEqual(normalizeRulers([1.9, 80.5, 120, '160']), [120, 160]);
});

test('ide state opens, activates, and dedupes tabs', () => {
  const ide = freshIde();
  ideState.openTab(ide, 'src\\app.js');
  ideState.openTab(ide, 'README.md');
  ideState.openTab(ide, 'src/app.js'); // dup after separator normalization
  assert.deepEqual(ide.openTabs.map((tab) => tab.path), ['src/app.js', 'README.md']);
  assert.equal(ide.activeTabPath, 'src/app.js');

  ideState.setActiveTab(ide, 'README.md');
  assert.equal(ide.activeTabPath, 'README.md');
  ideState.setActiveTab(ide, 'not-open.txt');
  assert.equal(ide.activeTabPath, 'README.md');

  // Escaping / absolute paths never become tabs.
  ideState.openTab(ide, '../outside.txt');
  ideState.openTab(ide, 'C:/abs.txt');
  assert.equal(ide.openTabs.length, 2);
});

test('transient file previews promote on explicit, dirty, or pinned use and never persist', () => {
  const ide = freshIde();
  ideState.openTab(ide, 'preview.js', { transientPreview: true });
  assert.equal(ideState.getTab(ide, 'preview.js').transientPreview, true);
  assert.deepEqual(ideState.toPersistedState(ide).openTabs, []);
  assert.equal(ideState.toPersistedState(ide).activeTabPath, '');

  ideState.openTab(ide, 'preview.js');
  assert.equal(ideState.getTab(ide, 'preview.js').transientPreview, undefined);

  ideState.openTab(ide, 'dirty.js', { transientPreview: true });
  ideState.setTabDirty(ide, 'dirty.js', true);
  assert.equal(ideState.getTab(ide, 'dirty.js').transientPreview, undefined);

  ideState.openTab(ide, 'pinned.js', { transientPreview: true });
  assert.equal(ideState.toggleTabPinned(ide, 'pinned.js'), true);
  assert.equal(ideState.getTab(ide, 'pinned.js').transientPreview, undefined);
  assert.equal(ideState.getTab(ide, 'pinned.js').pinned, true);

  const malformedOptions = freshIde();
  ideState.openTab(malformedOptions, 'explicit.js', null);
  assert.equal(ideState.getTab(malformedOptions, 'explicit.js').transientPreview, undefined);

  const restored = freshIde();
  ideState.applyPersistedState(restored, {
    openTabs: [
      { path: 'leaked-preview.js', transientPreview: true },
      { path: 'durable.js' },
    ],
  });
  assert.deepEqual(restored.openTabs.map((tab) => tab.path), ['durable.js']);
});

test('ide state closeTab picks the right neighbor, then the left, then empties', () => {
  const ide = freshIde();
  ['a.txt', 'b.txt', 'c.txt'].forEach((path) => ideState.openTab(ide, path));
  ideState.setActiveTab(ide, 'b.txt');

  assert.equal(ideState.closeTab(ide, 'b.txt'), 'c.txt');
  assert.equal(ide.activeTabPath, 'c.txt');
  assert.equal(ideState.closeTab(ide, 'c.txt'), 'a.txt');
  assert.equal(ideState.closeTab(ide, 'a.txt'), '');
  assert.equal(ide.openTabs.length, 0);

  // Closing an inactive tab keeps the active one.
  ['x.txt', 'y.txt'].forEach((path) => ideState.openTab(ide, path));
  ideState.setActiveTab(ide, 'y.txt');
  assert.equal(ideState.closeTab(ide, 'x.txt'), 'y.txt');
});

test('checkTabCapacity returns a typed cap result at MAX_OPEN_TABS but always accepts open paths (WIDE-051)', () => {
  const ide = freshIde();
  for (let i = 0; i < ideState.MAX_OPEN_TABS; i += 1) {
    ideState.openTab(ide, `f${i}.js`);
  }
  assert.deepEqual(
    ideState.checkTabCapacity(ide, 'new.js'),
    { ok: false, code: 'TAB_LIMIT', limit: ideState.MAX_OPEN_TABS },
    'a new path at the cap gets the typed refusal'
  );
  assert.deepEqual(ideState.checkTabCapacity(ide, 'f3.js'), { ok: true }, 'an already-open path always fits');
  ideState.closeTab(ide, 'f0.js');
  assert.deepEqual(ideState.checkTabCapacity(ide, 'new.js'), { ok: true }, 'a freed slot restores capacity');
});

test('root reset replaces every root-owned slice while preserving global layout and editor preferences', () => {
  const ide = freshIde();
  ideState.openTab(ide, 'src/a.js');
  ideState.setTabDirty(ide, 'src/a.js', true);
  ide.staleByPath['src/a.js'] = true;
  ide.expandedDirs.add('src');
  ide.treeRootLoaded = true;
  ide.activeStageSurface = 'preview';
  ide.previewPath = 'src/a.js';
  const oldSearch = { query: 'old', results: [{ path: 'src/a.js' }], busy: true, lastReplace: { records: [{}] } };
  ide.search = oldSearch;
  ide.railWidth = 377;
  ide.fontSize = 18;
  ide.wordWrap = 'on';

  ideState.resetIdeRootState(ide);

  assert.deepEqual(ide.openTabs, []);
  assert.equal(ide.activeTabPath, '');
  assert.deepEqual(ide.dirtyByPath, {});
  assert.deepEqual(ide.staleByPath, {});
  assert.deepEqual([...ide.expandedDirs], []);
  assert.equal(ide.treeRootLoaded, false);
  assert.equal(ide.activeStageSurface, 'editor');
  assert.equal(ide.previewPath, '');
  assert.deepEqual(ide.search, { query: '', results: [], busy: false });
  assert.notEqual(ide.search, oldSearch);
  assert.equal(ide.railWidth, 377);
  assert.equal(ide.fontSize, 18);
  assert.equal(ide.wordWrap, 'on');
});

test('ide state dirty tracking and persisted-subset round-trip', () => {
  const ide = freshIde();
  ideState.openTab(ide, 'src/a.js');
  ideState.openTab(ide, 'src/b.js');
  ideState.setTabDirty(ide, 'src/a.js', true);
  ideState.setTabDirty(ide, 'src/a.js', false);

  ide.expandedDirs.add('src');
  ide.railPanel = 'search';
  ide.railSide = 'left';
  ide.railWidth = 333;
  ide.showGenerated = true;
  ide.wordWrap = 'on';
  ide.fontSize = 18;
  ide.tabSize = 4;
  ide.minimap = false;
  ide.lineNumbers = 'off';
  ide.renderWhitespace = 'all';
  ide.eol = 'crlf';
  ide.autoSaveEnabled = true;
  ide.formatOnSave = true;
  ide.trimTrailingWhitespace = true;
  ide.insertFinalNewline = true;
  ide.rulers = [120, 80, 80]; // unsorted + duplicate -> persists sorted + deduped
  ide.bottomPanelOpen = true;
  ide.bottomPanelHeight = 300;
  ide.bottomPanelActiveView = 'problems';
  ide.panelLocations.changes = 'secondary'; // move changes into the secondary side
  ide.secondaryPanelOpen = true;
  ide.secondaryPanel = 'changes';
  ide.secondaryWidth = 320;
  ide.openTabs.push({ path: 'src/a.js.diff', kind: 'diff' });
  const persisted = ideState.toPersistedState(ide);
  // Diff tabs are session-scoped; they never persist. `pinned` is emitted ONLY
  // when true (the main-side normalizer treats an absent flag as false), so
  // unpinned tabs persist as a bare { path } with no redundant `pinned: false`.
  assert.deepEqual(persisted.openTabs, [
    { path: 'src/a.js' },
    { path: 'src/b.js' },
  ]);
  assert.deepEqual(persisted.expandedDirs, ['src']);
  assert.deepEqual(persisted.rulers, [80, 120]);

  const restored = freshIde();
  ideState.applyPersistedState(restored, persisted);
  assert.deepEqual(restored.openTabs.map((tab) => tab.path), ['src/a.js', 'src/b.js']);
  assert.equal(restored.railPanel, 'search');
  assert.equal(restored.railSide, 'left');
  assert.equal(restored.railWidth, 333);
  assert.equal(restored.showGenerated, true);
  assert.equal(restored.wordWrap, 'on');
  assert.equal(restored.fontSize, 18);
  assert.equal(restored.tabSize, 4);
  assert.equal(restored.minimap, false);
  assert.equal(restored.lineNumbers, 'off');
  assert.equal(restored.renderWhitespace, 'all');
  assert.equal(restored.eol, 'crlf');
  assert.equal(restored.autoSaveEnabled, true);
  assert.equal(restored.formatOnSave, true);
  assert.equal(restored.trimTrailingWhitespace, true);
  assert.equal(restored.insertFinalNewline, true);
  assert.deepEqual(restored.rulers, [80, 120]);
  assert.equal(restored.bottomPanelOpen, true);
  assert.equal(restored.bottomPanelHeight, 300);
  assert.equal(restored.bottomPanelActiveView, 'problems');
  assert.equal(restored.secondaryPanelOpen, true);
  assert.equal(restored.secondaryPanel, 'changes');
  assert.equal(restored.secondaryWidth, 320);
  assert.equal(restored.panelLocations.changes, 'secondary');
  assert.equal(restored.panelLocations.explorer, 'primary');
  assert.deepEqual([...restored.expandedDirs], ['src']);

  // Hostile persisted payloads collapse safely.
  const hostile = freshIde();
  ideState.applyPersistedState(hostile, {
    openTabs: [{ path: '../up.js' }, { path: 'ok.js' }],
    activeTabPath: '../up.js',
    expandedDirs: ['../d'],
    railPanel: 'terminal', // re-homed off the rail at v26 -> coerces to explorer
    railSide: 'middle',
    railWidth: 'wide',
    showGenerated: 'yes',
    wordWrap: 'sideways',
    fontSize: 'huge',
    tabSize: 3,
    minimap: 'maybe',
    lineNumbers: 'relative',
    renderWhitespace: 'sometimes',
    eol: 'cr',
    autoSaveEnabled: 'yes', // non-boolean -> coerces OFF (only literal true enables)
    formatOnSave: 'yes', // non-boolean -> coerces OFF
    trimTrailingWhitespace: 1,
    insertFinalNewline: 'true',
    rulers: [-1, 0, 600, 'x', 90], // out-of-range + garbage dropped -> [90]
    bottomPanelOpen: 'yes',
    bottomPanelHeight: 9999,
    bottomPanelActiveView: 'nope',
    secondaryPanelOpen: 'yes',
    secondaryPanel: 'terminal', // not a rail panel; recomputes to the located one
    secondaryWidth: 9999,
    panelLocations: { search: 'sideways', bogus: 'secondary', 'source-control': 'secondary' },
  });
  assert.deepEqual(hostile.openTabs.map((tab) => tab.path), ['ok.js']);
  assert.equal(hostile.activeTabPath, 'ok.js');
  assert.deepEqual([...hostile.expandedDirs], []);
  assert.equal(hostile.railPanel, 'explorer');
  assert.equal(hostile.railSide, 'left');
  assert.equal(hostile.railWidth, 300);
  assert.equal(hostile.showGenerated, false);
  assert.equal(hostile.wordWrap, 'off');
  assert.equal(hostile.fontSize, 13);
  assert.equal(hostile.tabSize, 2);
  assert.equal(hostile.minimap, true);
  assert.equal(hostile.lineNumbers, 'on');
  assert.equal(hostile.renderWhitespace, 'selection');
  assert.equal(hostile.eol, '');
  assert.equal(hostile.autoSaveEnabled, false);
  assert.equal(hostile.formatOnSave, false);
  assert.equal(hostile.trimTrailingWhitespace, false);
  assert.equal(hostile.insertFinalNewline, false);
  assert.deepEqual(hostile.rulers, [90]);
  assert.equal(hostile.bottomPanelOpen, false);
  assert.equal(hostile.bottomPanelHeight, 600);
  assert.equal(hostile.bottomPanelActiveView, 'terminal');
  assert.equal(hostile.secondaryPanelOpen, false);
  // Max widened 480 → 600 (Phase 5 viewport-safe wide resize).
  assert.equal(hostile.secondaryWidth, 600);
  // panelLocations: an invalid value falls to the panel's DEFAULT home (search ->
  // primary, the absent `changes` -> secondary), an unknown key is dropped, a
  // valid value is kept.
  assert.equal(hostile.panelLocations.search, 'primary');
  assert.equal(hostile.panelLocations.changes, 'secondary');
  assert.equal(hostile.panelLocations.bogus, undefined);
  assert.equal(hostile.panelLocations['source-control'], 'secondary');
  // The active secondary id recomputes to the first located panel (changes).
  assert.equal(hostile.secondaryPanel, 'changes');
});

test('pinned flag round-trips through the renderer persisted subset and clamps left on restore', () => {
  const ide = freshIde();
  ideState.openTab(ide, 'a.js');
  ideState.openTab(ide, 'b.js');
  ideState.openTab(ide, 'c.js');
  // Pin b.js (the middle tab).
  ide.openTabs.find((tab) => tab.path === 'b.js').pinned = true;

  const persisted = ideState.toPersistedState(ide);
  // Pinned tab still carries the flag...
  assert.deepEqual(
    persisted.openTabs.find((tab) => tab.path === 'b.js'),
    { path: 'b.js', pinned: true }
  );
  // ...while unpinned tabs omit the `pinned` key entirely (no redundant false).
  const unpinnedA = persisted.openTabs.find((tab) => tab.path === 'a.js');
  assert.deepEqual(unpinnedA, { path: 'a.js' });
  assert.ok(!('pinned' in unpinnedA), 'unpinned tab must not emit a pinned key');

  // applyPersistedState restores the flag AND clamps pinned-first, even when
  // the persisted order interleaves the groups (defensive on a hand-edited slice).
  const restored = freshIde();
  ideState.applyPersistedState(restored, persisted);
  assert.deepEqual(restored.openTabs.map((tab) => tab.path), ['b.js', 'a.js', 'c.js']);
  assert.equal(restored.openTabs[0].pinned, true);
  assert.ok(!restored.openTabs[1].pinned);

  // A persisted entry with no pinned field restores as unpinned.
  const tolerant = freshIde();
  ideState.applyPersistedState(tolerant, { openTabs: [{ path: 'x.js' }] });
  assert.equal(tolerant.openTabs[0].pinned, false);
});

test('toPersistedState clamps expandedDirs to the max on write', () => {
  const ide = freshIde();
  for (let i = 0; i < 250; i += 1) {
    ide.expandedDirs.add(`dir${i}`);
  }
  const persisted = ideState.toPersistedState(ide);
  // Set preserves insertion order; the write side slices to the first 200 so the
  // persisted payload can never exceed the bound the service normalizer enforces.
  assert.equal(persisted.expandedDirs.length, 200);
  assert.equal(persisted.expandedDirs[0], 'dir0');
  assert.equal(persisted.expandedDirs[199], 'dir199');
});

test('movePanelLocation re-homes a panel and fixes the active-panel invariants', () => {
  const ide = freshIde();
  // Exercise the move mechanics from an all-primary baseline (every panel in the
  // rail, secondary empty), independent of the split default home.
  ide.panelLocations = { explorer: 'primary', search: 'primary', changes: 'primary', 'source-control': 'primary' };
  ide.secondaryPanel = '';
  ide.secondaryPanelOpen = false;
  // explorer starts active in the rail; move it to the secondary side.
  ideState.movePanelLocation(ide, 'explorer', 'secondary');
  assert.equal(ide.panelLocations.explorer, 'secondary');
  assert.equal(ide.secondaryPanel, 'explorer', 'becomes the active secondary panel');
  assert.equal(ide.secondaryPanelOpen, true, 'moving in forces the sidebar open');
  assert.notEqual(ide.railPanel, 'explorer', 'rail reassigns its active panel');
  assert.deepEqual(ideState.secondaryPanels(ide), ['explorer']);
  assert.equal(ideState.isPanelActive(ide, 'explorer'), true);

  // Move it back to the primary rail; the secondary empties + closes.
  ideState.movePanelLocation(ide, 'explorer', 'primary');
  assert.equal(ide.panelLocations.explorer, 'primary');
  assert.equal(ide.railPanel, 'explorer', 'becomes the active rail panel');
  assert.equal(ide.secondaryPanel, '');
  assert.equal(ide.secondaryPanelOpen, false, 'last one out closes the secondary');

  // Keep >=1 in the rail: move all but one out, then the last move is a no-op.
  ideState.movePanelLocation(ide, 'search', 'secondary');
  ideState.movePanelLocation(ide, 'changes', 'secondary');
  ideState.movePanelLocation(ide, 'source-control', 'secondary');
  ideState.movePanelLocation(ide, 'explorer', 'secondary'); // would empty the rail
  assert.deepEqual(ideState.primaryPanels(ide), ['explorer'], 'last primary panel cannot move out');
});

test('ide state accepts the test-runner bottom-panel view (Wave C mirror, additive)', () => {
  // RED-BECAUSE: the BOTTOM_VIEWS mirror does not include 'test-runner' yet, so
  // the normalize collapses it to 'terminal'.
  const ide = freshIde();
  ide.bottomPanelActiveView = 'test-runner';
  const persisted = ideState.toPersistedState(ide);
  assert.equal(persisted.bottomPanelActiveView, 'test-runner', 'the renderer mirror persists the new view');
  const restored = freshIde();
  ideState.applyPersistedState(restored, { bottomPanelActiveView: 'test-runner' });
  assert.equal(restored.bottomPanelActiveView, 'test-runner', 'and restores it on load');
  // A still-bogus value collapses to the default (the accept-set only widened).
  const bogus = freshIde();
  ideState.applyPersistedState(bogus, { bottomPanelActiveView: 'nope' });
  assert.equal(bogus.bottomPanelActiveView, 'terminal');
});

test('chat dock triad persists round-trip and clampChatDockWidth bounds 280/2400/380', () => {
  // Fresh defaults: closed, right side, 380 wide (decision 1 — right is the default).
  const ide = freshIde();
  assert.equal(ide.chatDockOpen, false);
  assert.equal(ide.chatDockSide, 'right');
  assert.equal(ide.chatDockWidth, 380);

  // The dock bounds are their OWN design constants — not the secondary
  // sidebar's 160/480/260 (plan §4: pattern of clampSecondaryWidth, not values).
  assert.equal(ideState.CHAT_DOCK_WIDTH_MIN, 280);
  assert.equal(ideState.CHAT_DOCK_WIDTH_MAX, 2400);
  assert.equal(ideState.CHAT_DOCK_WIDTH_DEFAULT, 380);
  assert.equal(ideState.clampChatDockWidth(500), 500);
  assert.equal(ideState.clampChatDockWidth(10), 280);
  assert.equal(ideState.clampChatDockWidth(9999), 2400);
  assert.equal(ideState.clampChatDockWidth(500.9), 500);
  assert.equal(ideState.clampChatDockWidth('wide'), 380);

  // Persist round-trip.
  ide.chatDockOpen = true;
  ide.chatDockSide = 'left';
  ide.chatDockWidth = 444;
  const persisted = ideState.toPersistedState(ide);
  assert.equal(persisted.chatDockOpen, true);
  assert.equal(persisted.chatDockSide, 'left');
  assert.equal(persisted.chatDockWidth, 444);
  const restored = freshIde();
  ideState.applyPersistedState(restored, persisted);
  assert.equal(restored.chatDockOpen, true);
  assert.equal(restored.chatDockSide, 'left');
  assert.equal(restored.chatDockWidth, 444);

  // Hostile persisted payloads collapse safely (only literal true opens; side
  // whitelist; width clamps to the dock bounds).
  const hostile = freshIde();
  ideState.applyPersistedState(hostile, {
    chatDockOpen: 'yes',
    chatDockSide: 'middle',
    chatDockWidth: 9999,
  });
  assert.equal(hostile.chatDockOpen, false);
  assert.equal(hostile.chatDockSide, 'right');
  assert.equal(hostile.chatDockWidth, 2400);
});

test('the renderer BOTTOM_VIEWS mirror stays in sync with the services schema (UMD duplication guard)', () => {
  // BOTTOM_VIEWS is duplicated because this UMD module cannot import services.
  // Lock the two together so a view added on one side without the other is caught
  // (same precedent as the STATUS_LABELS drift guard).
  assert.deepEqual(
    ideState.BOTTOM_VIEWS,
    WORKSPACE_IDE_BOTTOM_VIEWS,
    'renderer-ide-state BOTTOM_VIEWS must equal services WORKSPACE_IDE_BOTTOM_VIEWS'
  );
});

test('replace journal cap mirrors stay in sync across service and renderer UMD modules', () => {
  assert.equal(WORKSPACE_IDE_REPLACE_JOURNAL_MAX_APPLIED, 200);
  assert.equal(WORKSPACE_IDE_REPLACE_JOURNAL_QUERY_MAX, 500);
  assert.deepEqual(
    [ideState.REPLACE_JOURNAL_MAX_APPLIED, replaceJournal.REPLACE_JOURNAL_MAX_APPLIED],
    [WORKSPACE_IDE_REPLACE_JOURNAL_MAX_APPLIED, WORKSPACE_IDE_REPLACE_JOURNAL_MAX_APPLIED]
  );
  assert.deepEqual(
    [ideState.REPLACE_JOURNAL_QUERY_MAX, replaceJournal.REPLACE_JOURNAL_QUERY_MAX],
    [WORKSPACE_IDE_REPLACE_JOURNAL_QUERY_MAX, WORKSPACE_IDE_REPLACE_JOURNAL_QUERY_MAX]
  );
});

test('replaceJournal persists and hydrates with the same bounded root-scoped shape', () => {
  const ide = freshIde();
  ide.replaceJournal = {
    startedAt: 123,
    query: 'needle',
    total: 2,
    applied: ['src/one.js', '../escape.js', 'src/two.js'],
    truncated: false,
  };

  const persisted = ideState.toPersistedState(ide);
  assert.deepEqual(persisted.replaceJournal, {
    startedAt: 123,
    query: 'needle',
    total: 2,
    applied: ['src/one.js', 'src/two.js'],
    truncated: false,
  });

  const restored = freshIde();
  ideState.applyPersistedState(restored, persisted);
  assert.deepEqual(restored.replaceJournal, persisted.replaceJournal);
  ideState.resetIdeRootState(restored);
  assert.equal(restored.replaceJournal, null);
});

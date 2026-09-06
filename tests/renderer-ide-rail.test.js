'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, findMenuItem, openContextMenu, pressKey, settle } = require('./helpers/renderer-ide-harness');
const { JSDOM } = require('jsdom');
const railUtils = require('../renderer/features/renderer-ide-rail');
const realIdeState = require('../renderer/features/renderer-ide-state');

// An explicit all-primary layout (every panel homed in the rail, secondary side
// empty). The default layout now SPLITS the rail (Changes + Source Control home
// to the secondary sidebar), so tests that assert full-rail / empty-secondary
// behavior seed this pre-split baseline to keep testing that case.
const ALL_PRIMARY_LAYOUT = {
  openTabs: [], activeTabPath: '', expandedDirs: [],
  railPanel: 'explorer', railSide: 'left', railWidth: 300,
  panelLocations: { explorer: 'primary', search: 'primary', changes: 'primary', 'source-control': 'primary' },
  secondaryPanel: '', secondaryPanelOpen: false, secondaryWidth: 260,
};

test('ide rail renders the activity bar with the active panel marked', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' }, persisted: ALL_PRIMARY_LAYOUT } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const bar = harness.getDom().ideActivityBar;
  const buttons = [...bar.querySelectorAll('[data-ide-rail-panel]')];
  assert.deepEqual(
    buttons.map((button) => button.dataset.ideRailPanel),
    ['explorer', 'search', 'changes', 'source-control']
  );
  assert.deepEqual(buttons.map((button) => button.title), [
    'Explorer — browse workspace files',
    'Search — find text across the workspace',
    "Jenny's Changes — review edits Jenny made",
    'Source Control — stage, commit, and switch branches',
  ]);
  const active = buttons.filter((button) => button.classList.contains('ide-activity-button--active'));
  assert.equal(active.length, 1);
  assert.equal(active[0].dataset.ideRailPanel, 'explorer');
  assert.ok(bar.querySelector('[data-ide-rail-flip]'));
  // Panel switchers are tabs inside the role="tablist" activity bar, not toggle
  // buttons: role="tab" + aria-selected reflecting the active panel, no aria-pressed.
  assert.ok(buttons.every((button) => button.getAttribute('role') === 'tab'), 'panel buttons are tabs');
  assert.equal(active[0].getAttribute('aria-selected'), 'true', 'active panel is aria-selected');
  assert.ok(buttons.every((button) => !button.hasAttribute('aria-pressed')), 'no toggle-button semantics');
});

test('ide rail wraps the panel tabs in a role=tablist of ONLY tabs (toggle/flip stay outside)', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'README.md': 'r' },
      persisted: {
        openTabs: [], activeTabPath: '', expandedDirs: [],
        railPanel: 'explorer', railSide: 'left', railWidth: 300,
        panelLocations: { explorer: 'primary', search: 'primary', changes: 'secondary', 'source-control': 'primary' },
        secondaryPanel: 'changes', secondaryPanelOpen: true, secondaryWidth: 260,
      },
    },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const bar = harness.getDom().ideActivityBar;
  const tablist = bar.querySelector('[role="tablist"]');
  assert.ok(tablist, 'an inner tablist wraps the panel tabs');
  // Invalid ARIA was a tablist holding non-tab buttons; the tablist now contains
  // ONLY role=tab children.
  assert.ok([...tablist.children].every((el) => el.getAttribute('role') === 'tab'), 'tablist holds only tabs');
  // The secondary toggle (a panel is homed in the secondary side here) and the
  // side-flip are toolbar buttons living OUTSIDE the tablist.
  assert.equal(tablist.querySelector('[data-ide-rail-flip]'), null, 'flip is not inside the tablist');
  assert.equal(tablist.querySelector('[data-ide-rail-secondary]'), null, 'secondary toggle is not inside the tablist');
  assert.ok(bar.querySelector('[data-ide-rail-flip]'), 'flip still rendered (as a toolbar sibling)');
  assert.ok(bar.querySelector('[data-ide-rail-secondary]'), 'secondary toggle still rendered (as a toolbar sibling)');
});

test('ide rail panel tabs use a roving tabindex (active=0, others=-1)', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const tabs = [...harness.getDom().ideActivityBar.querySelectorAll('[data-ide-rail-panel]')];
  const inOrder = tabs.filter((b) => b.getAttribute('tabindex') === '0');
  assert.equal(inOrder.length, 1, 'exactly one tab is in the Tab order');
  assert.equal(inOrder[0].dataset.ideRailPanel, 'explorer', 'the active panel owns tabindex=0');
  assert.ok(
    tabs.filter((b) => b.dataset.ideRailPanel !== 'explorer').every((b) => b.getAttribute('tabindex') === '-1'),
    'inactive tabs are removed from the Tab order',
  );
});

test('ide rail arrow keys move focus AND activate the focused panel (Home/End jump)', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' }, persisted: ALL_PRIMARY_LAYOUT } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const doc = harness.dom.window.document;
  const bar = harness.getDom().ideActivityBar;
  const explorer = bar.querySelector('[data-ide-rail-panel="explorer"]');
  explorer.focus();

  // ArrowDown -> next panel (search): activates + focus follows + roving 0 moves.
  pressKey(harness, explorer, 'ArrowDown');
  await settle();
  assert.equal(harness.state.ui.ide.railPanel, 'search', 'ArrowDown activates the next panel');
  let focused = doc.activeElement;
  assert.equal(focused?.dataset?.ideRailPanel, 'search', 'focus follows the activation');
  assert.equal(focused.getAttribute('tabindex'), '0', 'the newly active tab takes the roving tabindex');

  // End -> last panel (source-control).
  pressKey(harness, focused, 'End');
  await settle();
  assert.equal(harness.state.ui.ide.railPanel, 'source-control', 'End jumps to the last panel');
  assert.equal(doc.activeElement?.dataset?.ideRailPanel, 'source-control', 'focus moved to the last tab');

  // ArrowDown wraps from the last panel back to the first.
  pressKey(harness, doc.activeElement, 'ArrowDown');
  await settle();
  assert.equal(harness.state.ui.ide.railPanel, 'explorer', 'ArrowDown wraps to the first panel');
});

test('ide rail activity bar lists only primary-located panels; right-click moves one to the secondary', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'README.md': 'r' },
      persisted: {
        openTabs: [], activeTabPath: '', expandedDirs: [],
        railPanel: 'search', railSide: 'left', railWidth: 300,
        panelLocations: { explorer: 'secondary', search: 'primary', changes: 'primary', 'source-control': 'primary' },
        secondaryPanel: 'explorer', secondaryPanelOpen: true, secondaryWidth: 260,
      },
    },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const bar = harness.getDom().ideActivityBar;
  // explorer was moved to the secondary side, so the rail lists the other three.
  assert.deepEqual(
    [...bar.querySelectorAll('[data-ide-rail-panel]')].map((b) => b.dataset.ideRailPanel),
    ['search', 'changes', 'source-control']
  );
  // The move affordance is a right-click menu now, not an inline control.
  assert.equal(bar.querySelector('[data-ide-move-panel]'), null, 'no inline move control');
  // The secondary visibility toggle shows once the secondary side hosts a panel.
  const secondaryToggle = bar.querySelector('[data-ide-rail-secondary]');
  assert.ok(secondaryToggle, 'toggle visible when secondary non-empty');
  // The show/hide toggle is a genuine toggle button (NOT a tab) - it keeps aria-pressed.
  assert.ok(secondaryToggle.hasAttribute('aria-pressed'), 'secondary toggle keeps toggle semantics');
  assert.equal(secondaryToggle.getAttribute('role'), null, 'the toggle is not a tab');

  // Right-clicking a panel button opens a "Move to Secondary Sidebar" action.
  openContextMenu(harness, bar.querySelector('[data-ide-rail-panel="changes"]'));
  const item = findMenuItem(harness.dom.window.document, 'Move to Secondary Sidebar');
  assert.ok(item, 'right-click opens the move menu');
  assert.equal(item.disabled, false, 'enabled while more than one primary remains');
  item.click();
  await settle();
  assert.equal(harness.state.ui.ide.panelLocations.changes, 'secondary', 'the right-click move re-homed the panel');
});

test('ide rail right-click move is disabled on the last remaining primary panel', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'README.md': 'r' },
      persisted: {
        openTabs: [], activeTabPath: '', expandedDirs: [],
        railPanel: 'explorer', railSide: 'left', railWidth: 300,
        panelLocations: { explorer: 'primary', search: 'secondary', changes: 'secondary', 'source-control': 'secondary' },
        secondaryPanel: 'search', secondaryPanelOpen: true, secondaryWidth: 260,
      },
    },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const bar = harness.getDom().ideActivityBar;
  assert.deepEqual(
    [...bar.querySelectorAll('[data-ide-rail-panel]')].map((b) => b.dataset.ideRailPanel),
    ['explorer']
  );
  // No inline control - and right-clicking the last primary offers a DISABLED
  // move item (the rail must always keep >=1 panel).
  assert.equal(bar.querySelector('[data-ide-move-panel]'), null, 'no inline move control');
  openContextMenu(harness, bar.querySelector('[data-ide-rail-panel="explorer"]'));
  const item = findMenuItem(harness.dom.window.document, 'Move to Secondary Sidebar');
  assert.ok(item, 'the menu still opens');
  assert.equal(item.disabled, true, 'the last primary panel cannot be moved out');
});

test('ide rail activity bar hides the secondary toggle while the secondary side is empty', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' }, persisted: ALL_PRIMARY_LAYOUT } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  // Seeded all-primary: every panel is in the rail, so the secondary side is empty.
  assert.equal(harness.getDom().ideActivityBar.querySelector('[data-ide-rail-secondary]'), null);
});

test('ide rail activity click switches panels and persists', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const bar = harness.getDom().ideActivityBar;
  bar.querySelector('[data-ide-rail-panel="search"]').click();
  await settle();

  assert.equal(harness.state.ui.ide.railPanel, 'search');
  // The rail panel now hosts the search surface instead of the tree.
  assert.ok(harness.getDom().ideRailPanel.querySelector('.ide-search'));
  assert.equal(harness.getDom().ideRailPanel.querySelector('.ide-tree'), null);
  assert.ok(
    bar.querySelector('[data-ide-rail-panel="search"]').classList.contains('ide-activity-button--active')
  );

  // Switching back re-renders the explorer without a fresh listing call.
  const listCalls = harness.bridge.calls.listDirectory.length;
  bar.querySelector('[data-ide-rail-panel="explorer"]').click();
  await settle();
  assert.ok(harness.getDom().ideRailPanel.querySelector('.ide-tree'));
  assert.equal(harness.bridge.calls.listDirectory.length, listCalls);

  await settle(600);
  const persistedPanels = harness.bridge.calls.updateState.map((payload) => payload.preferences.railPanel);
  assert.ok(persistedPanels.includes('explorer'));
});

test('ide rail flip control toggles the rail side', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const shell = harness.getDom().ideShell;
  assert.equal(shell.dataset.railSide, 'left', 'explorer docks left by default');
  harness.getDom().ideActivityBar.querySelector('[data-ide-rail-flip]').click();
  await settle();
  assert.equal(harness.state.ui.ide.railSide, 'right');
  assert.equal(shell.dataset.railSide, 'right');

  harness.getDom().ideActivityBar.querySelector('[data-ide-rail-flip]').click();
  await settle();
  assert.equal(shell.dataset.railSide, 'left');

  await settle(600);
  assert.equal(harness.bridge.calls.updateState.at(-1).preferences.railSide, 'left');
});

test('ide rail resizer drag updates the width and persists on release', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const { ideRailResizer, ideShell } = harness.getDom();
  const win = harness.dom.window;
  // Left-pinned rail (default): dragging the handle right grows the panel.
  ideRailResizer.dispatchEvent(new win.MouseEvent('pointerdown', { clientX: 800, bubbles: true }));
  win.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 900 }));
  assert.equal(harness.state.ui.ide.railWidth, 400);
  assert.equal(ideShell.style.getPropertyValue('--ide-rail-width'), '400px');

  // Width clamps at the maximum even on a wild drag.
  win.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 1600 }));
  assert.equal(harness.state.ui.ide.railWidth, 600);

  win.dispatchEvent(new win.MouseEvent('pointerup', { clientX: 1600 }));
  await settle(600);
  assert.equal(harness.bridge.calls.updateState.at(-1).preferences.railWidth, 600);

  // Listeners are gone after release: further moves change nothing.
  win.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 850 }));
  assert.equal(harness.state.ui.ide.railWidth, 600);
});

test('ide rail resizer arrow keys resize with side-aware direction', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const resizer = harness.getDom().ideRailResizer;
  // Left-pinned (default): ArrowRight grows, ArrowLeft shrinks.
  pressKey(harness, resizer, 'ArrowRight');
  assert.equal(harness.state.ui.ide.railWidth, 316);
  pressKey(harness, resizer, 'ArrowLeft');
  pressKey(harness, resizer, 'ArrowLeft');
  assert.equal(harness.state.ui.ide.railWidth, 284);

  // Flipped to the right side the directions invert.
  harness.state.ui.ide.railSide = 'right';
  pressKey(harness, resizer, 'ArrowLeft');
  assert.equal(harness.state.ui.ide.railWidth, 300);
});

test('stage-surface button titles reflect active/inactive wording (re-click-to-return affordance)', (t) => {
  const dom = new JSDOM('<nav id="bar"></nav><div id="resizer"></div><div id="shell"></div>');
  const bar = dom.window.document.getElementById('bar');
  const ide = realIdeState.createIdeUiState();
  let activeSurface = 'editor';

  const rail = railUtils.createIdeRail({
    getDom: () => ({
      ideActivityBar: bar,
      ideRailResizer: dom.window.document.getElementById('resizer'),
      ideShell: dom.window.document.getElementById('shell'),
    }),
    getIde: () => ide,
    onActivateStageSurface: () => {},
    isStageSurfaceEnabled: () => true,
    getActiveStageSurface: () => activeSurface,
  });
  t.after(() => rail.dispose());

  rail.renderActivityBar();
  const previewButton = () => bar.querySelector('[data-ide-stage-surface="preview"]');
  const mapButton = () => bar.querySelector('[data-ide-stage-surface="file_map"]');
  assert.equal(previewButton().getAttribute('title'), 'Show Preview', 'inactive Preview uses the "Show" wording');
  assert.equal(mapButton().getAttribute('title'), 'Show File Map', 'inactive File Map uses the "Show" wording');

  activeSurface = 'preview';
  rail.renderActivityBar();
  assert.equal(
    previewButton().getAttribute('title'),
    'Preview — click to return to the editor',
    'active Preview advertises the return-to-editor affordance'
  );
  assert.equal(mapButton().getAttribute('title'), 'Show File Map', 'File Map stays inactive wording while Preview is active');
});

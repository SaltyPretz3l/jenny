'use strict';

/* "Show panel X" routing under the Move View model: Reveal in Explorer, Find in
 * Folder, Ctrl+Shift+F and the Find in Files palette row must show the panel on
 * whichever side hosts it. When Explorer or Search lives in the secondary
 * sidebar, they open that sidebar on the panel's tab (and the follow-up reveal /
 * input focus lands in the secondary host) instead of pointing ide.railPanel at
 * a secondary-located id, which painted nothing and left stale rail markup. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ideState = require('../renderer/features/renderer-ide-state');
const { createHarness, findMenuItem, openContextMenu, settle } = require('./helpers/renderer-ide-harness');

function layout(overrides) {
  return {
    openTabs: [], activeTabPath: '', expandedDirs: [],
    railPanel: 'explorer', railSide: 'left', railWidth: 300,
    panelLocations: { explorer: 'primary', search: 'primary', changes: 'primary', 'source-control': 'primary' },
    secondaryPanel: '', secondaryPanelOpen: false, secondaryWidth: 260,
    ...overrides,
  };
}

// Explorer + Changes homed in a CLOSED secondary sidebar (showing Changes).
const EXPLORER_SECONDARY = layout({
  railPanel: 'search',
  panelLocations: { explorer: 'secondary', search: 'primary', changes: 'secondary', 'source-control': 'primary' },
  secondaryPanel: 'changes',
});

// Search + Changes homed in a CLOSED secondary sidebar (showing Changes).
const SEARCH_SECONDARY = layout({
  railPanel: 'explorer',
  panelLocations: { explorer: 'primary', search: 'secondary', changes: 'secondary', 'source-control': 'primary' },
  secondaryPanel: 'changes',
});

function activeRailTabs(harness) {
  return [...harness.getDom().ideActivityBar.querySelectorAll('.ide-activity-button--active[data-ide-rail-panel]')]
    .map((el) => el.dataset.ideRailPanel);
}

test('showPanel routes a secondary-located panel to the secondary sidebar and a primary one to the rail', () => {
  const ide = ideState.createIdeUiState();
  ide.panelLocations = { explorer: 'primary', search: 'secondary', changes: 'secondary', 'source-control': 'primary' };
  ide.railPanel = 'explorer';
  const calls = { opened: [], persist: 0, render: 0 };
  const hooks = {
    openSecondary: (id) => calls.opened.push(id),
    schedulePersist: () => { calls.persist += 1; },
    requestRender: () => { calls.render += 1; },
  };

  assert.equal(ideState.showPanel(ide, 'search', hooks), 'secondary');
  assert.deepEqual(calls.opened, ['search'], 'the secondary sidebar opens on the panel');
  assert.equal(ide.railPanel, 'explorer', 'railPanel never points at a secondary-located panel');

  assert.equal(ideState.showPanel(ide, 'source-control', hooks), 'primary');
  assert.equal(ide.railPanel, 'source-control');
  assert.equal(calls.persist, 1);
  assert.equal(calls.render, 1);

  // Already active: render only, no redundant persist.
  ideState.showPanel(ide, 'source-control', hooks);
  assert.equal(calls.persist, 1);
  assert.equal(calls.render, 2);
});

test('Reveal in Explorer opens the secondary sidebar when Explorer lives there, and reveals the row in it', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/deep/x.js': '1' }, persisted: EXPLORER_SECONDARY } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('src/deep/x.js');
  await settle();
  const dom = harness.getDom();
  const ide = harness.state.ui.ide;

  openContextMenu(harness, dom.ideTabStrip.querySelector('[data-ide-tab-path]'));
  findMenuItem(harness.dom.window.document, 'Reveal in Explorer View').click();
  await settle();

  assert.equal(ide.railPanel, 'search', 'the rail keeps its own (primary) panel');
  assert.equal(ide.secondaryPanelOpen, true, 'the secondary sidebar opens');
  assert.equal(ide.secondaryPanel, 'explorer', 'on the Explorer tab');
  assert.equal(dom.ideShell.getAttribute('data-secondary-open'), 'true');
  assert.ok(ide.expandedDirs.has('src/deep'), 'ancestors expanded');
  assert.ok(dom.ideSecondarySidebarPanel.querySelector('[data-ide-tree-path="src/deep/x.js"]'), 'row revealed in the secondary host');
  assert.deepEqual(activeRailTabs(harness), ['search'], 'the rail still has exactly one active tab');
  assert.ok(dom.ideRailPanel.querySelector('[data-ide-search-input]'), 'the rail host still shows its Search panel');
});

test('Ctrl+Shift+F opens the secondary sidebar on Search and focuses its input when Search lives there', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'x' }, persisted: SEARCH_SECONDARY } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const dom = harness.getDom();
  const ide = harness.state.ui.ide;

  dom.ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 'F', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
  await settle();

  assert.equal(ide.railPanel, 'explorer', 'the rail keeps the Explorer');
  assert.equal(ide.secondaryPanelOpen, true, 'the secondary sidebar opens');
  assert.equal(ide.secondaryPanel, 'search', 'on the Search tab');
  const input = dom.ideSecondarySidebarPanel.querySelector('[data-ide-search-input]');
  assert.ok(input, 'the Search input is mounted in the secondary host');
  assert.equal(harness.dom.window.document.activeElement, input, 'focus lands in that input');
  assert.deepEqual(activeRailTabs(harness), ['explorer'], 'the rail still has exactly one active tab');
});

test('the Find in Files palette row routes to the secondary Search too', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'x' }, persisted: SEARCH_SECONDARY } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const dom = harness.getDom();

  const find = harness.controller.getIdeCommandItems().find((item) => item.id === 'ide:find-in-files');
  find.run();
  await settle();

  assert.equal(harness.state.ui.ide.secondaryPanel, 'search');
  assert.equal(harness.state.ui.ide.secondaryPanelOpen, true);
  assert.equal(
    harness.dom.window.document.activeElement,
    dom.ideSecondarySidebarPanel.querySelector('[data-ide-search-input]'),
    'focus lands in the secondary Search input',
  );
});

test('Find in Folder shows Search in the secondary sidebar when Search lives there', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/app.js': 'x' }, persisted: SEARCH_SECONDARY } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const dom = harness.getDom();
  const ide = harness.state.ui.ide;

  openContextMenu(harness, dom.ideRailPanel.querySelector('[data-ide-tree-path="src"]'));
  findMenuItem(harness.dom.window.document, 'Find in Folder').click();
  await settle();

  assert.equal(ide.railPanel, 'explorer', 'the rail keeps the Explorer');
  assert.equal(ide.secondaryPanelOpen, true, 'the secondary sidebar opens');
  assert.equal(ide.secondaryPanel, 'search', 'on the Search tab');
  assert.ok(dom.ideSecondarySidebarPanel.querySelector('[data-ide-search-input]'), 'Search paints in the secondary host');
  assert.ok(dom.ideRailPanel.querySelector('[data-ide-tree-path="src"]'), 'the rail still shows the Explorer');
  assert.deepEqual(activeRailTabs(harness), ['explorer']);
  assert.equal(
    harness.dom.window.document.activeElement,
    dom.ideSecondarySidebarPanel.querySelector('[data-ide-search-input]'),
    'focus lands in the secondary Search input, like Ctrl+Shift+F',
  );
});

// The 2026-09-27 gate layout: Explorer AND Search moved to the (open) secondary
// sidebar, showing Explorer. Find in Folder swaps the secondary host from the
// tree to Search, destroying the focused tree row; focus must land in the
// Search input instead of dropping to <body>.
test('Find in Folder from a secondary-hosted Explorer focuses the Search input that replaces it', async (t) => {
  const persisted = layout({
    railPanel: 'changes',
    panelLocations: { explorer: 'secondary', search: 'secondary', changes: 'primary', 'source-control': 'primary' },
    secondaryPanel: 'explorer',
    secondaryPanelOpen: true,
  });
  const harness = createHarness({ bridgeOptions: { files: { 'src/app.js': 'x' }, persisted } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const dom = harness.getDom();
  const doc = harness.dom.window.document;

  const row = dom.ideSecondarySidebarPanel.querySelector('[data-ide-tree-path="src"]');
  row.focus();
  openContextMenu(harness, row);
  findMenuItem(doc, 'Find in Folder').click();
  await settle();

  assert.equal(harness.state.ui.ide.secondaryPanel, 'search');
  const input = dom.ideSecondarySidebarPanel.querySelector('[data-ide-search-input]');
  assert.ok(input, 'Search paints in the secondary host');
  assert.equal(doc.activeElement, input, 'focus lands in the Search input, not <body>');
});

test('Find in Folder focuses the rail Search input when both panels live in the rail', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/app.js': 'x' }, persisted: layout({}) } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const dom = harness.getDom();
  const doc = harness.dom.window.document;

  openContextMenu(harness, dom.ideRailPanel.querySelector('[data-ide-tree-path="src"]'));
  findMenuItem(doc, 'Find in Folder').click();
  await settle();

  assert.equal(harness.state.ui.ide.railPanel, 'search');
  const input = dom.ideRailPanel.querySelector('[data-ide-search-input]');
  assert.ok(input, 'Search paints in the rail host');
  assert.equal(doc.activeElement, input, 'focus lands in the rail Search input');
});

test('Reveal in Explorer still switches the rail when Explorer lives in the rail', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/x.js': '1' }, persisted: layout({ railPanel: 'search' }) } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('src/x.js');
  await settle();
  const dom = harness.getDom();

  openContextMenu(harness, dom.ideTabStrip.querySelector('[data-ide-tab-path]'));
  findMenuItem(harness.dom.window.document, 'Reveal in Explorer View').click();
  await settle();

  assert.equal(harness.state.ui.ide.railPanel, 'explorer');
  assert.equal(harness.state.ui.ide.secondaryPanelOpen, false, 'the (empty) secondary stays closed');
  assert.ok(dom.ideRailPanel.querySelector('[data-ide-tree-path="src/x.js"]'), 'row revealed in the rail');
});

// Gate N9: closing the secondary sidebar with its X hid the focused element and
// dropped focus to <body>, where Ctrl+Shift+F (bound on #ideView) never fires.
test('closing the secondary sidebar with its X keeps focus inside the IDE so Ctrl+Shift+F still works', async (t) => {
  const persisted = { ...SEARCH_SECONDARY, secondaryPanel: 'search', secondaryPanelOpen: true };
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'x' }, persisted } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const dom = harness.getDom();
  const doc = harness.dom.window.document;
  const ide = harness.state.ui.ide;

  const collapse = dom.ideSecondarySidebarHeader.querySelector('[data-ide-secondary-collapse]');
  collapse.focus(); // a mouse click focuses the button in Chromium
  collapse.click();
  await settle();

  assert.equal(ide.secondaryPanelOpen, false, 'the sidebar closed');
  assert.notEqual(doc.activeElement, doc.body, 'focus did not drop to <body>');
  assert.ok(dom.ideView.contains(doc.activeElement), 'focus stays inside #ideView');
  assert.ok(!dom.ideSecondarySidebar.contains(doc.activeElement), 'and not on the hidden sidebar');

  doc.activeElement.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 'F', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
  await settle();
  assert.equal(ide.secondaryPanelOpen, true, 'Ctrl+Shift+F reopens the sidebar on Search');
  assert.equal(doc.activeElement, dom.ideSecondarySidebarPanel.querySelector('[data-ide-search-input]'));
});

'use strict';

/* End-to-end secondary-sidebar wiring through the real IDE controller + DOM
 * harness (the "Move View" model, CONFIG_VERSION 28): a panel is a SINGLE
 * instance that lives on one side at a time. The rail's right-click "Move to
 * Secondary Sidebar" action moves a panel there (it leaves the rail, opens the
 * secondary, and renders its real content there - NOT a clone); the secondary's
 * right-click "Move to Primary Sidebar" action moves it back and closes the
 * emptied side; open/which-location persist; and a moved panel's events stay
 * live in its new host (the panels bind BOTH hosts once). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, findMenuItem, openContextMenu, settle } = require('./helpers/renderer-ide-harness');

test('rail ⇄ moves a panel to the secondary as ONE instance; secondary ⇄ moves it back and closes the side', async (t) => {
  // Seed the pre-split all-primary layout (every panel in the rail, secondary
  // empty); this test moves explorer in and out of an initially-empty side, so
  // it must not start from the new split default (Changes/Source Control there).
  const harness = createHarness({ bridgeOptions: {
    files: { 'README.md': 'r' },
    persisted: {
      openTabs: [], activeTabPath: '', expandedDirs: [],
      railPanel: 'explorer', railSide: 'left', railWidth: 300,
      panelLocations: { explorer: 'primary', search: 'primary', changes: 'primary', 'source-control': 'primary' },
      secondaryPanel: '', secondaryPanelOpen: false, secondaryWidth: 260,
    },
  } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const dom = harness.getDom();
  const bar = dom.ideActivityBar;
  // Seeded all-primary: every panel is in the rail; the secondary side is empty + hidden.
  assert.equal(dom.ideShell.getAttribute('data-secondary-open'), 'false');
  assert.equal(bar.querySelector('[data-ide-rail-secondary]'), null, 'no toggle while the secondary is empty');
  assert.ok(dom.ideRailPanel.querySelector('.ide-tree'), 'rail shows the explorer tree');

  // Move explorer to the secondary side via its rail right-click action.
  openContextMenu(harness, bar.querySelector('[data-ide-rail-panel="explorer"]'));
  findMenuItem(harness.dom.window.document, 'Move to Secondary Sidebar').click();
  await settle();

  assert.equal(harness.state.ui.ide.panelLocations.explorer, 'secondary');
  assert.equal(harness.state.ui.ide.secondaryPanelOpen, true, 'moving in opens the secondary');
  assert.notEqual(harness.state.ui.ide.railPanel, 'explorer', 'the rail reassigns its active panel');
  assert.equal(dom.ideShell.getAttribute('data-secondary-open'), 'true');
  // explorer's icon left the rail activity bar...
  assert.equal(bar.querySelector('[data-ide-rail-panel="explorer"]'), null, 'explorer icon left the rail');
  // ...and a tab for it appeared in the secondary header.
  assert.ok(dom.ideSecondarySidebarHeader.querySelector('[data-ide-secondary-panel="explorer"]'));
  // SINGLE instance: the explorer tree renders in the SECONDARY host, and the
  // RAIL host shows the reassigned panel instead - no tree clone is left behind.
  assert.ok(dom.ideSecondarySidebarPanel.querySelector('.ide-tree'), 'explorer tree in the secondary host');
  assert.equal(dom.ideRailPanel.querySelector('.ide-tree'), null, 'no clone tree left in the rail');

  await settle(600);
  assert.ok(
    harness.bridge.calls.updateState.some((p) => p.preferences?.panelLocations?.explorer === 'secondary'),
    'panelLocations persisted'
  );

  // The RUNTIME-moved panel's events are live in its NEW host with no rebind
  // (the bind-both contract): clicking a tree row in the secondary host opens it.
  dom.ideSecondarySidebarPanel.querySelector('[data-ide-tree-path="README.md"]').click();
  await settle();
  assert.equal(harness.state.ui.ide.activeTabPath, 'README.md', 'a panel moved at runtime fires events in its new host');

  // Move it back to the rail via the secondary tab's right-click action.
  openContextMenu(harness, dom.ideSecondarySidebarHeader.querySelector('[data-ide-secondary-panel="explorer"]'));
  findMenuItem(harness.dom.window.document, 'Move to Primary Sidebar').click();
  await settle();

  assert.equal(harness.state.ui.ide.panelLocations.explorer, 'primary');
  assert.equal(harness.state.ui.ide.railPanel, 'explorer', 'explorer is the active rail panel again');
  assert.equal(harness.state.ui.ide.secondaryPanelOpen, false, 'the emptied secondary closes');
  assert.equal(dom.ideShell.getAttribute('data-secondary-open'), 'false');
  assert.ok(dom.ideRailPanel.querySelector('.ide-tree'), 'explorer tree back in the rail');
  assert.ok(bar.querySelector('[data-ide-rail-panel="explorer"]'), 'explorer icon back in the rail');

  await settle(600);
  const last = harness.bridge.calls.updateState.at(-1).preferences;
  assert.equal(last.panelLocations.explorer, 'primary', 'final location persisted');
  assert.equal(last.secondaryPanelOpen, false, 'closed state persisted');
});

test('opening a file from the secondary explorer routes through the shared open path (moved panel stays live)', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'README.md': 'r', 'src/app.js': 'x' },
      // Seed explorer already located in the secondary sidebar + open.
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

  const dom = harness.getDom();
  // The explorer renders into the SECONDARY host (its location), not the rail.
  const fileRow = dom.ideSecondarySidebarPanel.querySelector('[data-ide-tree-path="README.md"]');
  assert.ok(fileRow, 'secondary explorer lists the workspace file');
  fileRow.click();
  await settle();
  // The shared onOpenFile path opened the file (it becomes the active tab),
  // proving the panel's click handler is live in the secondary host (bind-both).
  assert.equal(harness.state.ui.ide.activeTabPath, 'README.md', 'clicking a secondary tree row opens the file');
});

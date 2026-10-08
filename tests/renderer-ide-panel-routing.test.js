'use strict';

/* "Show panel X" routing on the workbench layout tree: Reveal in Explorer, Find in
 * Folder, Ctrl+Shift+F and the Find in Files palette row must reveal the view in
 * whichever stack hosts it (opening a collapsed stack, switching the active tab of a
 * shared one) and land focus in the revealed panel instead of dropping to <body>. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ideState = require('../renderer/features/renderer-ide-state');
const layoutModel = require('../renderer/shared/workbench-layout-model');
const { stk, editor, spl, ch, LEFT, BOTTOM, CHAT } = require('./helpers/workbench-layout-fixtures');
const { createHarness, findMenuItem, openContextMenu, settle } = require('./helpers/renderer-ide-harness');

// Default arrangement except `moved` lives in its own COLLAPSED stack on the right edge.
function ownStackLayout(moved) {
  const rest = LEFT.filter((id) => id !== moved);
  return layoutModel.normalizeLayout({
    v: 1,
    root: spl(
      'r',
      'row',
      ch(stk('L', rest), 300),
      ch(spl('c', 'col', ch(editor(), null), ch(stk('B', BOTTOM, { collapsed: true }), 220)), null),
      ch(stk('S', [moved], { collapsed: true }), 260),
      ch(stk('R', CHAT, { collapsed: true }), 380),
    ),
  });
}

function activeTabs(harness, view) {
  const stack = harness.viewHost(view).closest('[data-wb-stack]');
  return [...stack.querySelectorAll('[data-wb-tab][aria-selected="true"]')].map((el) => el.getAttribute('data-wb-tab'));
}

function stackState(harness, view) {
  return harness.viewHost(view).closest('[data-wb-stack]').getAttribute('data-state');
}

test('showPanel reveals a view in its stack (opening a collapsed one) and a primary one in the left stack', () => {
  const ide = ideState.createIdeUiState();
  // Search lives in its own stack and starts collapsed.
  ideState.commitWorkbenchLayout(ide, ownStackLayout('search'));
  assert.equal(ide.secondaryPanelOpen, false);
  const calls = { opened: [], persist: 0, render: 0 };
  const hooks = {
    openSecondary: (id) => calls.opened.push(id),
    schedulePersist: () => { calls.persist += 1; },
    requestRender: () => { calls.render += 1; },
  };

  assert.equal(ideState.showPanel(ide, 'search', hooks), 'secondary');
  // The tree owns the reveal (it opens the stack itself); the old openSecondary
  // hook is accepted but no longer called.
  assert.deepEqual(calls.opened, []);
  assert.equal(ide.secondaryPanelOpen, true, 'the stack opens on the panel');
  assert.equal(ide.secondaryPanel, 'search');
  assert.equal(ide.railPanel, 'explorer', 'railPanel never points at a panel in another stack');
  assert.deepEqual([calls.persist, calls.render], [1, 1]);

  assert.equal(ideState.showPanel(ide, 'source-control', hooks), 'primary');
  assert.equal(ide.railPanel, 'source-control');
  assert.deepEqual([calls.persist, calls.render], [2, 2]);

  // Already active: render only, no redundant persist.
  ideState.showPanel(ide, 'source-control', hooks);
  assert.deepEqual([calls.persist, calls.render], [2, 3]);
});

test('Reveal in Explorer opens the collapsed stack Explorer lives in, and reveals the row in it', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/deep/x.js': '1' }, persisted: { workbenchLayout: ownStackLayout('explorer') } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('src/deep/x.js');
  await settle();
  const dom = harness.getDom();
  const ide = harness.state.ui.ide;
  assert.equal(stackState(harness, 'explorer'), 'collapsed');

  openContextMenu(harness, dom.ideTabStrip.querySelector('[data-ide-tab-path]'));
  findMenuItem(harness.dom.window.document, 'Reveal in Explorer View').click();
  await settle();

  assert.equal(stackState(harness, 'explorer'), 'open', 'the Explorer stack opens');
  assert.equal(stackState(harness, 'search'), 'open', 'the other stack keeps its own state');
  assert.deepEqual(activeTabs(harness, 'explorer'), ['explorer']);
  assert.ok(ide.expandedDirs.has('src/deep'), 'ancestors expanded');
  assert.ok(harness.viewHost('explorer').querySelector('[data-ide-tree-path="src/deep/x.js"]'), 'row revealed in the Explorer host');
  assert.equal(harness.viewHost('explorer').hidden, false);
});

test('Ctrl+Shift+F opens the stack Search lives in and focuses its input', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'x' }, persisted: { workbenchLayout: ownStackLayout('search') } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const dom = harness.getDom();
  assert.equal(stackState(harness, 'search'), 'collapsed');

  dom.ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 'F', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
  await settle();

  assert.equal(stackState(harness, 'search'), 'open', 'the Search stack opens');
  assert.equal(stackState(harness, 'explorer'), 'open', 'the Explorer stack is untouched');
  const input = harness.viewHost('search').querySelector('[data-ide-search-input]');
  assert.ok(input, 'the Search input is mounted in the Search host');
  assert.equal(harness.dom.window.document.activeElement, input, 'focus lands in that input');
  assert.deepEqual(activeTabs(harness, 'explorer'), ['explorer'], 'the Explorer stack still has exactly one active tab');
});

test('the Find in Files palette row routes to the separately hosted Search too', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'x' }, persisted: { workbenchLayout: ownStackLayout('search') } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const find = harness.controller.getIdeCommandItems().find((item) => item.id === 'ide:find-in-files');
  find.run();
  await settle();

  assert.equal(stackState(harness, 'search'), 'open');
  assert.equal(
    harness.dom.window.document.activeElement,
    harness.viewHost('search').querySelector('[data-ide-search-input]'),
    'focus lands in the Search input',
  );
});

test('Find in Folder shows Search in its own stack and focuses the input, like Ctrl+Shift+F', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/app.js': 'x' }, persisted: { workbenchLayout: ownStackLayout('search') } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  openContextMenu(harness, harness.viewHost('explorer').querySelector('[data-ide-tree-path="src"]'));
  findMenuItem(harness.dom.window.document, 'Find in Folder').click();
  await settle();

  assert.equal(stackState(harness, 'search'), 'open');
  assert.ok(harness.viewHost('explorer').querySelector('[data-ide-tree-path="src"]'), 'the Explorer still shows its tree');
  assert.deepEqual(activeTabs(harness, 'explorer'), ['explorer']);
  const input = harness.viewHost('search').querySelector('[data-ide-search-input]');
  assert.ok(input, 'Search paints in its own host');
  assert.ok(harness.viewHost('search').querySelector('[data-ide-search-clear-scope]'), 'scoped to the folder');
  assert.equal(harness.dom.window.document.activeElement, input);
});

// The shared-stack case (the default): Find in Folder swaps the stack's visible view
// from the tree to Search, hiding the focused tree row; focus must land in the Search
// input instead of dropping to <body>.
test('Find in Folder from a focused Explorer row focuses the Search input that replaces it', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/app.js': 'x' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;

  const row = harness.viewHost('explorer').querySelector('[data-ide-tree-path="src"]');
  row.focus();
  openContextMenu(harness, row);
  findMenuItem(doc, 'Find in Folder').click();
  await settle();

  assert.deepEqual(activeTabs(harness, 'search'), ['search']);
  assert.equal(harness.viewHost('explorer').hidden, true);
  const input = harness.viewHost('search').querySelector('[data-ide-search-input]');
  assert.ok(input, 'Search paints in its host');
  assert.equal(doc.activeElement, input, 'focus lands in the Search input, not <body>');
});

test('Reveal in Explorer switches the shared stack back to the Explorer tab', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/x.js': '1' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('src/x.js');
  await settle();
  const dom = harness.getDom();
  harness.dom.window.document.querySelector('[data-wb-tab="search"]').click();
  await settle();
  assert.deepEqual(activeTabs(harness, 'explorer'), ['search']);

  openContextMenu(harness, dom.ideTabStrip.querySelector('[data-ide-tab-path]'));
  findMenuItem(harness.dom.window.document, 'Reveal in Explorer View').click();
  await settle();

  assert.deepEqual(activeTabs(harness, 'explorer'), ['explorer']);
  assert.equal(stackState(harness, 'explorer'), 'open');
  assert.ok(harness.viewHost('explorer').querySelector('[data-ide-tree-path="src/x.js"]'), 'row revealed in the Explorer host');
});

// Gate N9: closing a side panel with its X hid the focused element and dropped focus
// to <body>, where Ctrl+Shift+F (bound on #ideView) never fires.
test('collapsing the left stack keeps focus inside the IDE so Ctrl+Shift+F still works', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'x' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const dom = harness.getDom();
  const doc = harness.dom.window.document;

  const collapse = harness.viewHost('explorer').closest('[data-wb-stack]').querySelector('[data-wb-action="collapse"]');
  collapse.focus(); // a mouse click focuses the button in Chromium
  collapse.click();
  await settle();

  assert.equal(stackState(harness, 'explorer'), 'collapsed', 'the stack collapsed');
  assert.notEqual(doc.activeElement, doc.body, 'focus did not drop to <body>');
  assert.ok(dom.ideView.contains(doc.activeElement), 'focus stays inside #ideView');
  assert.ok(!harness.viewHost('explorer').contains(doc.activeElement), 'and not on the hidden panel');

  doc.activeElement.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 'F', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
  await settle();
  assert.equal(stackState(harness, 'search'), 'open', 'Ctrl+Shift+F reopens the stack on Search');
  assert.equal(doc.activeElement, harness.viewHost('search').querySelector('[data-ide-search-input]'));
});

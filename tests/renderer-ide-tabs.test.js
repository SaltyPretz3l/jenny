'use strict';

/* Editor tab-strip overflow scroller: the "show all tabs" overflow affordance
 * appears only when the strip overflows, the active tab is scrolled into view
 * on (re)render, and the overflow quick-pick lists every open tab. jsdom has no
 * real layout, so overflow is driven by stubbing the strip's scrollWidth /
 * clientWidth and the affordance is asserted via emitted markup / class. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createHarness,
  settle,
} = require('./helpers/renderer-ide-harness');
const { createIdeTabsController } = require('../renderer/features/renderer-ide-tabs-controller');

const FILES = { 'a.js': '1', 'b.js': '2', 'c.js': '3' };

async function openAll(harness) {
  await harness.controller.activateIde();
  for (const path of Object.keys(FILES)) {
    await harness.controller.openFile(path);
  }
  await settle();
}

// Stub the strip's layout metrics so syncOverflow sees it as overflowing
// (overflow=true) or fitting (overflow=false) regardless of jsdom's 0/0.
function stubOverflow(strip, { scrollWidth, clientWidth }) {
  Object.defineProperty(strip, 'scrollWidth', { configurable: true, get: () => scrollWidth });
  Object.defineProperty(strip, 'clientWidth', { configurable: true, get: () => clientWidth });
}

test('empty strip renders no overflow control and stays :empty', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const strip = harness.getDom().ideTabStrip;
  assert.equal(strip.querySelector('[data-ide-tab-overflow]'), null);
  assert.equal(strip.children.length, 0, 'no children -> :empty styling preserved');
});

test('each tab is a tab pointing at the editor stage tabpanel', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await openAll(harness);
  const labels = [...harness.getDom().ideTabStrip.querySelectorAll('.ide-tab-label')];
  assert.ok(labels.length >= 1, 'tabs rendered');
  assert.ok([...harness.getDom().ideTabStrip.querySelectorAll('.ide-tab-close')]
    .every((button) => / \(Ctrl\+F4\)$/.test(button.title)));
  assert.ok(labels.every((b) => b.getAttribute('role') === 'tab'), 'tab labels are tabs');
  assert.ok(
    labels.every((b) => b.getAttribute('aria-controls') === 'ideEditorStage'),
    'each tab controls the shared editor stage (role="tabpanel")',
  );
});

test('overflow affordance is absent when tabs fit, present when they overflow', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await openAll(harness);
  const strip = harness.getDom().ideTabStrip;

  // The control is always rendered (hidden) once tabs exist, but the
  // overflowing CLASS - the actual affordance - stays off while tabs fit.
  assert.ok(strip.querySelector('[data-ide-tab-overflow]'), 'overflow trigger rendered with tabs');
  assert.equal(strip.classList.contains('ide-tabstrip--overflowing'), false);

  // Now make the strip overflow and re-render (opening a 4th file re-runs
  // renderTabs -> syncOverflow, which reads the stubbed metrics).
  stubOverflow(strip, { scrollWidth: 800, clientWidth: 240 });
  harness.bridge.state.files['d.js'] = '4';
  await harness.controller.openFile('d.js');
  await settle();
  assert.equal(strip.classList.contains('ide-tabstrip--overflowing'), true);

  // And it clears again when the tabs fit.
  stubOverflow(strip, { scrollWidth: 200, clientWidth: 240 });
  harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="a.js"]').click();
  await settle();
  assert.equal(strip.classList.contains('ide-tabstrip--overflowing'), false);
});

test('transient file preview tabs expose a distinct visual and accessible state', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js', { preview: true });
  const tab = harness.getDom().ideTabStrip.querySelector('[data-ide-tab="a.js"]');
  assert.ok(tab.classList.contains('ide-tab--preview'));
  assert.match(tab.querySelector('[role="tab"]').getAttribute('aria-label'), /preview/i);
});

test('active tab is scrolled into view and carries the active class', async (t) => {
  const calls = [];
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  // Spy on scrollIntoView (jsdom has no layout; we only verify it is invoked
  // for the active tab on render).
  harness.dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {
    calls.push(this);
  };
  await openAll(harness);
  const strip = harness.getDom().ideTabStrip;

  // Last opened (c.js) is active.
  let active = strip.querySelector('.ide-tab--active');
  assert.equal(active.dataset.ideTab, 'c.js');

  // Switching tabs scrolls the newly-active tab into view.
  calls.length = 0;
  strip.querySelector('[data-ide-tab-path="a.js"]').click();
  await settle();
  active = strip.querySelector('.ide-tab--active');
  assert.equal(active.dataset.ideTab, 'a.js');
  assert.ok(calls.includes(active), 'scrollIntoView called for the active tab');
});

test('overflow menu lists every open tab with active/dirty state', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await openAll(harness);
  const doc = harness.dom.window.document;
  const strip = harness.getDom().ideTabStrip;

  // Make b.js dirty so the quick-pick reflects its state.
  strip.querySelector('[data-ide-tab-path="b.js"]').click();
  await settle();
  const textarea = harness.getDom().ideEditorFallback;
  textarea.value = 'edited';
  textarea.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  await settle();
  assert.equal(
    strip.querySelector('[data-ide-tab="b.js"] .ide-tab-close').title,
    'Close b.js — discards unsaved changes (Ctrl+F4)'
  );

  stubOverflow(strip, { scrollWidth: 900, clientWidth: 200 });
  strip.querySelector('[data-ide-tab-overflow]').click();
  await settle();

  const items = [...doc.body.querySelectorAll('.inv-context-menu-item')];
  assert.equal(items.length, 3, 'one row per open tab');
  const labels = items.map((item) => item.textContent);
  assert.ok(labels.some((label) => label.includes('a.js')));
  assert.ok(labels.some((label) => label.includes('c.js')));
  // Dirty tab carries the ● prefix; active tab (b.js) carries the active hint.
  const dirtyRow = items.find((item) => item.textContent.includes('b.js'));
  assert.ok(dirtyRow.textContent.includes('●'), 'dirty marker shown');
  assert.ok(dirtyRow.textContent.includes('active'), 'active hint shown');

  // Clicking a row activates that tab.
  items.find((item) => item.textContent.includes('c.js')).click();
  await settle();
  assert.equal(harness.state.ui.ide.activeTabPath, 'c.js');
});

// ── Pinned tabs ──────────────────────────────────────────────────────────────

function dblclickTab(harness, path) {
  harness.getDom().ideTabStrip
    .querySelector(`[data-ide-tab-path="${path}"]`)
    .dispatchEvent(new harness.dom.window.MouseEvent('dblclick', { bubbles: true }));
}

function openTabContextMenu(harness, path) {
  harness.getDom().ideTabStrip
    .querySelector(`[data-ide-tab-path="${path}"]`)
    .dispatchEvent(new harness.dom.window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 8, clientY: 8,
    }));
}

test('double-click pins a tab: pinned class + glyph render and it clamps to the left', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await openAll(harness);
  const strip = harness.getDom().ideTabStrip;

  // openAll opens a,b,c left-to-right (c active). Pin the rightmost (c.js).
  dblclickTab(harness, 'c.js');
  await settle();

  // State: c.js carries the pinned flag and is reordered to the front.
  const ide = harness.state.ui.ide;
  assert.equal(ide.openTabs.find((tab) => tab.path === 'c.js').pinned, true);
  assert.deepEqual(ide.openTabs.map((tab) => tab.path), ['c.js', 'a.js', 'b.js'],
    'pinned tab clamps to the left of the strip');

  // Render: the first tab is the pinned c.js with the pinned class + pin glyph.
  const tabs = [...strip.querySelectorAll('.ide-tab')];
  assert.equal(tabs[0].dataset.ideTab, 'c.js');
  assert.ok(tabs[0].classList.contains('ide-tab--pinned'), 'pinned tab carries ide-tab--pinned');
  assert.ok(tabs[0].querySelector('.ide-tab-pin'), 'pin glyph renders on the pinned tab');
  assert.equal(tabs.filter((el) => el.classList.contains('ide-tab--pinned')).length, 1,
    'only the pinned tab is compact');

  // Double-clicking again unpins it (flag clears; class/glyph gone).
  dblclickTab(harness, 'c.js');
  await settle();
  assert.ok(!harness.state.ui.ide.openTabs.find((tab) => tab.path === 'c.js').pinned);
  assert.equal(strip.querySelector('.ide-tab--pinned'), null, 'unpin removes the compact variant');
  assert.equal(strip.querySelector('.ide-tab-pin'), null, 'unpin removes the pin glyph');
});

test('the tab context menu toggles between Pin and Unpin', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await openAll(harness);
  const doc = harness.dom.window.document;

  openTabContextMenu(harness, 'a.js');
  await settle();
  let pinItem = [...doc.body.querySelectorAll('.inv-context-menu-item')]
    .find((item) => item.textContent.trim() === 'Pin');
  assert.ok(pinItem, 'an unpinned tab offers "Pin"');
  pinItem.click();
  await settle();
  assert.equal(harness.state.ui.ide.openTabs.find((tab) => tab.path === 'a.js').pinned, true);

  openTabContextMenu(harness, 'a.js');
  await settle();
  const unpinItem = [...doc.body.querySelectorAll('.inv-context-menu-item')]
    .find((item) => item.textContent.trim() === 'Unpin');
  assert.ok(unpinItem, 'a pinned tab offers "Unpin"');
});

// reorderTabs + togglePin are unit-tested directly against a fake ide (same
// pattern as the close-orchestrator unit tests) - the harness does not expose
// the tab-strip controller, and jsdom's DragEvent/dataTransfer is unreliable.
test('drag-reorder stays within the pinned / unpinned group', () => {
  const ide = {
    openTabs: [
      { path: 'a.js', kind: 'file', pinned: true },
      { path: 'b.js', kind: 'file' },
      { path: 'c.js', kind: 'file' },
    ],
  };
  const controller = createIdeTabsController({
    getIde: () => ide,
    callbacks: { renderTabs() {}, schedulePersist() {} },
  });

  // Pinned a.js dragged after the unpinned c.js: rejected, no move.
  assert.equal(controller.reorderTabs('a.js', 'c.js', { placeAfter: true }), false);
  assert.deepEqual(ide.openTabs.map((tab) => tab.path), ['a.js', 'b.js', 'c.js']);

  // Within-group (both unpinned) reorder still works: b after c.
  assert.equal(controller.reorderTabs('b.js', 'c.js', { placeAfter: true }), true);
  assert.deepEqual(ide.openTabs.map((tab) => tab.path), ['a.js', 'c.js', 'b.js']);
});

test('togglePin flips the flag, clamps pinned-first, and persists', () => {
  let renders = 0;
  let persists = 0;
  const ide = {
    openTabs: [
      { path: 'a.js', kind: 'file' },
      { path: 'b.js', kind: 'file' },
      { path: 'diff://x', kind: 'diff' },
    ],
  };
  const controller = createIdeTabsController({
    getIde: () => ide,
    callbacks: { renderTabs() { renders += 1; }, schedulePersist() { persists += 1; } },
  });

  assert.equal(controller.togglePin('b.js'), true);
  assert.equal(ide.openTabs[0].path, 'b.js', 'newly-pinned tab clamps to the left');
  assert.equal(ide.openTabs.find((tab) => tab.path === 'b.js').pinned, true);
  assert.equal(renders, 1);
  assert.equal(persists, 1);

  // Review surfaces (diff/preview) never pin.
  assert.equal(controller.togglePin('diff://x'), false);
  assert.ok(!ide.openTabs.find((tab) => tab.path === 'diff://x').pinned);
});

// Editor-stage drop-to-open (drag a file row from the tree onto the stage).
// jsdom's DragEvent/dataTransfer is unreliable, so the exposed stage handlers
// are invoked directly with a hand-rolled dataTransfer stub - same pattern as
// the reorder/pin unit tests above.
function makeStageEvent({ types = [], data = {} } = {}) {
  let prevented = false;
  return {
    preventDefault() { prevented = true; },
    wasPrevented() { return prevented; },
    dataTransfer: {
      types,
      dropEffect: '',
      getData(type) { return data[type] || ''; },
    },
  };
}

function makeStageController(onActivate) {
  return createIdeTabsController({
    getDom: () => ({}),
    callbacks: { activateTab: onActivate },
  });
}

test('stage drop opens the dragged tree file via activateTab', () => {
  const opened = [];
  const controller = makeStageController((path) => opened.push(path));
  const event = makeStageEvent({
    types: ['application/x-jenny-tree-path', 'text/plain'],
    data: { 'application/x-jenny-tree-path': 'src/app.js', 'text/plain': 'src/app.js' },
  });

  controller.handleStageDrop(event);
  assert.deepEqual(opened, ['src/app.js']);
  assert.equal(event.wasPrevented(), true, 'drop is claimed (preventDefault) for the internal payload');
});

test('stage ignores OS/external file drops (no internal mime)', () => {
  const opened = [];
  const controller = makeStageController((path) => opened.push(path));

  // OS file drop: 'Files' in types, no internal mime -> getData returns ''.
  const dropEvent = makeStageEvent({ types: ['Files'], data: {} });
  controller.handleStageDrop(dropEvent);
  assert.deepEqual(opened, [], 'external drop never opens a file');

  // dragover stays disarmed (no preventDefault) so the window suppressor claims it.
  const overEvent = makeStageEvent({ types: ['Files'], data: {} });
  controller.handleStageDragOver(overEvent);
  assert.equal(overEvent.wasPrevented(), false, 'OS drag is not armed on the stage');
  assert.equal(overEvent.dataTransfer.dropEffect, '', 'dropEffect untouched for OS drag');
});

test('stage dragover arms (preventDefault + copy) for the internal tree payload', () => {
  const controller = makeStageController(() => {});
  const event = makeStageEvent({ types: ['application/x-jenny-tree-path'] });

  controller.handleStageDragOver(event);
  assert.equal(event.wasPrevented(), true, 'armed: preventDefault lets drop fire');
  assert.equal(event.dataTransfer.dropEffect, 'copy', 'opening a file is a copy effect');
});

test('stage dragleave keeps the highlight while crossing into a child element', () => {
  const removed = [];
  const childHost = { tag: 'monaco-host' };
  const stage = {
    contains: (node) => node === childHost,
    classList: { remove: (cls) => removed.push(cls) },
  };
  const controller = createIdeTabsController({
    getDom: () => ({ ideEditorStage: stage }),
    callbacks: {},
  });

  // Pointer moves from the stage into its Monaco child: relatedTarget is still
  // inside the stage -> the drop outline must NOT be cleared.
  controller.handleStageDragLeave({ relatedTarget: childHost });
  assert.deepEqual(removed, [], 'crossing into a child keeps the highlight');

  // Pointer genuinely leaves the stage subtree -> clear it.
  controller.handleStageDragLeave({ relatedTarget: { tag: 'outside' } });
  assert.deepEqual(removed, ['ide-editor-stage--drop-active'], 'leaving the stage clears the highlight');

  controller.resetForRoot();
  assert.deepEqual(removed, ['ide-editor-stage--drop-active', 'ide-editor-stage--drop-active']);
});

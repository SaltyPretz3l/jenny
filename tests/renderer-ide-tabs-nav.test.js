'use strict';

/* W5 tab & nav UX: middle-click close, Ctrl+F4 / Ctrl+PageUp/Down view
 * shortcuts, bulk-close context-menu entries, copy path, reveal in explorer,
 * and drag-reorder persistence. Runs on the shared jsdom harness. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createHarness,
  findMenuItem,
  openContextMenu,
  settle,
} = require('./helpers/renderer-ide-harness');

const FILES = { 'a.js': '1', 'b.js': '2', 'c.js': '3' };

async function openAll(harness) {
  await harness.controller.activateIde();
  for (const path of Object.keys(FILES)) {
    await harness.controller.openFile(path);
  }
  await settle();
}

function tabPaths(harness) {
  return [...harness.getDom().ideTabStrip.querySelectorAll('[data-ide-tab]')]
    .map((tab) => tab.dataset.ideTab);
}

function pressViewKey(harness, key, init = {}) {
  harness.getDom().ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  }));
}

test('middle-click (auxclick) closes a tab', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await openAll(harness);
  const tab = harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="b.js"]');
  tab.dispatchEvent(new harness.dom.window.MouseEvent('auxclick', {
    button: 1,
    bubbles: true,
    cancelable: true,
  }));
  await settle();
  assert.deepEqual(tabPaths(harness), ['a.js', 'c.js']);
});

test('Ctrl+F4 closes the active tab, Ctrl+PageUp/PageDown cycle', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await openAll(harness);
  assert.equal(harness.state.ui.ide.activeTabPath, 'c.js');

  pressViewKey(harness, 'PageUp');
  await settle();
  assert.equal(harness.state.ui.ide.activeTabPath, 'b.js');
  pressViewKey(harness, 'PageDown');
  pressViewKey(harness, 'PageDown');
  await settle();
  assert.equal(harness.state.ui.ide.activeTabPath, 'a.js', 'cycling wraps');

  pressViewKey(harness, 'F4');
  await settle();
  assert.deepEqual(tabPaths(harness), ['b.js', 'c.js']);

  // Shortcuts are IDE-view-scoped.
  harness.state.ui.activeView = 'chat';
  pressViewKey(harness, 'F4');
  await settle();
  assert.equal(tabPaths(harness).length, 2);
});

test('context menu bulk closes: others, saved, all', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await openAll(harness);
  const doc = harness.dom.window.document;
  const strip = harness.getDom().ideTabStrip;

  openContextMenu(harness, strip.querySelector('[data-ide-tab-path="b.js"]'));
  findMenuItem(doc, 'Close Others').click();
  await settle();
  assert.deepEqual(tabPaths(harness), ['b.js']);

  await harness.controller.openFile('a.js');
  await settle();
  // Dirty b.js survives Close Saved.
  const textarea = harness.getDom().ideEditorFallback;
  harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="b.js"]').click();
  await settle();
  textarea.value = 'edited';
  textarea.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  await settle();
  openContextMenu(harness, strip.querySelector('[data-ide-tab-path="b.js"]'));
  findMenuItem(doc, 'Close Saved').click();
  await settle();
  assert.deepEqual(tabPaths(harness), ['b.js']);

  openContextMenu(harness, strip.querySelector('[data-ide-tab-path="b.js"]'));
  findMenuItem(doc, 'Close All').click();
  await settle();
  // b.js is dirty -> a single batched confirm appears; discard to close all.
  doc.body.querySelector('[data-ide-confirm-action="discard"]').click();
  await settle();
  assert.deepEqual(tabPaths(harness), []);
});

test('context menu copies the relative path and reveals in explorer', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/deep/x.js': '1' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('src/deep/x.js');
  await settle();
  const doc = harness.dom.window.document;
  const strip = harness.getDom().ideTabStrip;

  openContextMenu(harness, strip.querySelector('[data-ide-tab-path]'));
  findMenuItem(doc, 'Copy Relative Path').click();
  await settle();
  assert.deepEqual(harness.bridge.calls.clipboardWriteText, ['src/deep/x.js']);

  openContextMenu(harness, strip.querySelector('[data-ide-tab-path]'));
  findMenuItem(doc, 'Reveal in Explorer View').click();
  await settle();
  assert.ok(harness.state.ui.ide.expandedDirs.has('src'));
  assert.ok(harness.state.ui.ide.expandedDirs.has('src/deep'));
  const row = harness.viewHost('explorer').querySelector('[data-ide-tree-path="src/deep/x.js"]');
  assert.ok(row, 'file row revealed');
  assert.equal(row.tabIndex, 0);
});

test('context menu path/OS utilities: copy path, copy name, OS reveal, default app', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/deep/x.js': '1' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('src/deep/x.js');
  await settle();
  const doc = harness.dom.window.document;
  const strip = harness.getDom().ideTabStrip;

  openContextMenu(harness, strip.querySelector('[data-ide-tab-path]'));
  findMenuItem(doc, 'Copy Path').click();
  await settle();
  // Harness root is 'G:/fake-root' (forward slashes) -> joined POSIX-style.
  assert.deepEqual(harness.bridge.calls.clipboardWriteText, ['G:/fake-root/src/deep/x.js']);

  openContextMenu(harness, strip.querySelector('[data-ide-tab-path]'));
  findMenuItem(doc, 'Copy Name').click();
  await settle();
  assert.equal(harness.bridge.calls.clipboardWriteText.at(-1), 'x.js');

  openContextMenu(harness, strip.querySelector('[data-ide-tab-path]'));
  findMenuItem(doc, 'Reveal in File Explorer').click();
  await settle();
  assert.deepEqual(harness.bridge.calls.revealInFolder, [{ path: 'src/deep/x.js' }]);

  openContextMenu(harness, strip.querySelector('[data-ide-tab-path]'));
  findMenuItem(doc, 'Open in Default App').click();
  await settle();
  assert.deepEqual(harness.bridge.calls.openInDefaultApp, [{ path: 'src/deep/x.js' }]);
});

// Drag a.js to before c.js -> open order becomes ['b.js','a.js','c.js'] and a
// debounced persist is scheduled (timer pending until PERSIST_DEBOUNCE_MS).
// jsdom has no DragEvent and lays nothing out: plain events with a stubbed
// dataTransfer suffice, and each tab gets a 100 px box so the drop index
// (midpoints before the pointer, the dragged tab not counted) is real.
function dragReorderAToC(harness) {
  const strip = harness.getDom().ideTabStrip;
  const window = harness.dom.window;
  [...strip.querySelectorAll('[data-ide-tab]')].forEach((tab, index) => {
    tab.getBoundingClientRect = () => ({ left: index * 100, width: 100, right: index * 100 + 100, top: 0, bottom: 30, height: 30 });
  });
  const dragged = strip.querySelector('[data-ide-tab="a.js"]');
  const target = strip.querySelector('[data-ide-tab="c.js"]');
  const dragStart = new window.Event('dragstart', { bubbles: true });
  dragStart.dataTransfer = { setData: () => {}, effectAllowed: '' };
  dragged.dispatchEvent(dragStart);
  assert.ok(dragged.classList.contains('ide-tab--dragging'), 'the dragged tab is marked');
  const drop = new window.Event('drop', { bubbles: true, cancelable: true });
  drop.clientX = 210; // past b.js's midpoint, before c.js's
  target.dispatchEvent(drop);
}

test('drag-reorder moves a tab and persists the new order', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await openAll(harness);
  dragReorderAToC(harness);
  await settle();

  assert.deepEqual(
    harness.state.ui.ide.openTabs.map((tab) => tab.path),
    ['b.js', 'a.js', 'c.js']
  );
  await settle(600);
  assert.deepEqual(
    harness.bridge.calls.updateState.at(-1).rootState.openTabs.map((tab) => tab.path),
    ['b.js', 'a.js', 'c.js']
  );
});

test('teardown flushes a pending debounced persist (no data loss on dispose)', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose()); // cleanup fallback; explicit dispose() below is idempotent
  await openAll(harness);
  dragReorderAToC(harness);
  await settle(); // 10ms < 500ms debounce: the persist timer is still pending
  const before = harness.bridge.calls.updateState.length;
  harness.dispose(); // runs disposeIdeBindings -> must flush the pending persist
  assert.equal(
    harness.bridge.calls.updateState.length,
    before + 1,
    'pending persist is flushed synchronously on teardown'
  );
  assert.deepEqual(
    harness.bridge.calls.updateState.at(-1).rootState.openTabs.map((tab) => tab.path),
    ['b.js', 'a.js', 'c.js']
  );
});

test('beforeunload flushes a pending persist; the listener unbinds on dispose', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  // Track active beforeunload listeners so removal is proven directly. (Asserting
  // a post-dispose dispatch is a no-op would be vacuous: flushOnUnload guards on
  // persistTimer, which is already null after the flush, so it cannot write
  // whether or not the listener leaked.) Install BEFORE openAll, which binds it.
  const win = harness.dom.window;
  const activeUnloadListeners = new Set();
  const rawAdd = win.addEventListener.bind(win);
  const rawRemove = win.removeEventListener.bind(win);
  win.addEventListener = (type, handler, ...rest) => {
    if (type === 'beforeunload') { activeUnloadListeners.add(handler); }
    return rawAdd(type, handler, ...rest);
  };
  win.removeEventListener = (type, handler, ...rest) => {
    if (type === 'beforeunload') { activeUnloadListeners.delete(handler); }
    return rawRemove(type, handler, ...rest);
  };

  await openAll(harness);
  assert.equal(activeUnloadListeners.size, 1, 'controller binds a beforeunload flush listener');
  dragReorderAToC(harness);
  await settle(); // timer still pending
  const before = harness.bridge.calls.updateState.length;
  win.dispatchEvent(new win.Event('beforeunload'));
  assert.equal(
    harness.bridge.calls.updateState.length,
    before + 1,
    'beforeunload flushes the pending persist before a hard window close'
  );
  harness.dispose();
  assert.equal(activeUnloadListeners.size, 0, 'beforeunload listener is unbound on dispose (no leak)');
});

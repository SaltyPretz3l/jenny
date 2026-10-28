'use strict';

/* Editor groups at the controller (row 40 W5): Split Editor Right moves the active
 * file into a new group with its own stack and tab strip, a tab dragged back joins
 * the primary strip, a group closes with its last tab, an open of a grouped file
 * shows it in its group, the tab menus offer the moves, and the groups persist. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, settle, findMenuItem, openContextMenu } = require('./helpers/renderer-ide-harness');
const ideState = require('../renderer/features/renderer-ide-state');
const ops = require('../renderer/shared/workbench-layout-ops');

const realHost = require('../renderer/features/renderer-ide-editor-host');
const { createIdeEditorGroupsWiring } = require('../renderer/features/renderer-ide-editor-groups-wiring');
const workbenchUtils = require('../renderer/features/renderer-ide-workbench-wiring');

const TAB_MIME = 'application/x-jenny-editor-tab';
const FILES = { 'a.js': 'const a = 1;\n', 'b.js': 'const b = 2;\n', 'c.js': 'const c = 3;\n', 'notes.md': '# n\n' };

// jsdom has no Monaco, and groups hold Monaco text documents only: this host reports
// Monaco as loaded and every open document except notes.md as text.
const textHost = {
  ...realHost,
  createIdeEditorHost(deps) {
    const host = realHost.createIdeEditorHost(deps);
    return { ...host, getMonaco: () => ({}), isTextDocument: (path) => host.hasDocument(path) && path !== 'notes.md' };
  },
};

async function openIde(t, bridgeOptions = { files: FILES }, { monaco = true } = {}) {
  const harness = createHarness({ bridgeOptions, beforeController: () => { if (monaco) globalThis.rendererIdeEditorHost = textHost; } });
  t.after(() => harness.dispose());
  delete globalThis.rendererIdeEditorHost;
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const ide = () => harness.state.ui.ide;
  const groupsInLayout = () => ops.listEditorGroups(ideState.getWorkbenchLayout(ide()));
  const groupEl = (id) => doc.querySelector(`#ideWorkbench [data-ide-group="${id}"]`);
  const primaryTabs = () => [...doc.querySelectorAll('#ideTabStrip [data-ide-tab]')].map((el) => el.getAttribute('data-ide-tab'));
  const groupTabs = (id) => [...(groupEl(id)?.querySelectorAll('[data-ide-tab]') || [])].map((el) => el.getAttribute('data-ide-tab'));
  const runCommand = (id) => harness.controller.getIdeCommandItems().find((item) => item.id === id).run();
  return { harness, doc, ide, groupsInLayout, groupEl, primaryTabs, groupTabs, runCommand };
}

async function openFiles(rig, ...paths) {
  for (const path of paths) {
    await rig.harness.controller.openFile(path);
    await settle();
  }
}

test('W7b opens follow the focused group only for unopened, non-preview text files', async (t) => {
  for (const scenario of ['text', 'non-text', 'primary', 'existing', 'preview']) {
    await t.test(scenario, async (t) => {
      const rig = await openIde(t);
      await openFiles(rig, 'a.js', 'b.js');
      rig.runCommand('ide:split-editor-right');
      await settle();
      if (scenario === 'primary') rig.doc.getElementById('ideEditorFallback').focus();
      const path = scenario === 'non-text' ? 'notes.md' : scenario === 'existing' ? 'a.js' : 'c.js';
      assert.equal(await rig.harness.controller.openFile(path, { preview: scenario === 'preview' }), true);
      await settle();
      assert.deepEqual(rig.groupTabs('editor-2'), scenario === 'text' ? ['b.js', 'c.js'] : ['b.js']);
      assert.equal(rig.primaryTabs().includes(path), scenario !== 'text');
      assert.equal(rig.ide().activeTabPath, scenario === 'text' ? 'a.js' : path);
    });
  }
});

test('W7 review: a follow-focus open moves the file under the spelling the lifecycle opened', async (t) => {
  const rig = await openIde(t, { files: { ...FILES, 'Foo.js': 'const foo = 4;\n' } });
  await openFiles(rig, 'a.js', 'b.js');
  rig.runCommand('ide:split-editor-right');
  await settle();
  // A case-insensitive filesystem answers 'foo.js' with its canonical 'Foo.js'.
  const fs = rig.harness.bridge.jennyShell.workspaceFs;
  const readText = fs.readText.bind(fs);
  fs.readText = (payload) => readText(payload.path === 'foo.js' ? { ...payload, path: 'Foo.js' } : payload);
  assert.equal(await rig.harness.controller.openFile('foo.js'), true);
  await settle();
  assert.deepEqual(rig.groupTabs('editor-2'), ['b.js', 'Foo.js']);
  assert.equal(rig.primaryTabs().includes('Foo.js'), false);
});

// jsdom lays nothing out (every tab rect is 0), so clientX past 0 lands after every tab.
function dropTab(rig, target, payload, clientX = 999) {
  const win = rig.harness.dom.window;
  const event = new win.Event('drop', { bubbles: true, cancelable: true });
  const data = { [TAB_MIME]: JSON.stringify(payload) };
  Object.defineProperty(event, 'dataTransfer', { value: { types: [TAB_MIME], getData: (type) => data[type] || '' } });
  Object.defineProperty(event, 'clientX', { value: clientX });
  target.dispatchEvent(event);
}

test('Split Editor Right moves the active file into a new group beside the editor', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js');
  rig.runCommand('ide:split-editor-right');
  await settle();
  assert.deepEqual(rig.groupsInLayout().slice(1), ['editor-2'], 'the layout gains a second editor stack');
  assert.ok(rig.groupEl('editor-2'), 'which hosts the group view');
  assert.deepEqual(rig.groupTabs('editor-2'), ['b.js'], 'the file moved into the group');
  assert.deepEqual(rig.primaryTabs(), ['a.js'], 'and left the primary strip');
  assert.equal(rig.ide().activeTabPath, 'a.js', 'the primary shows its neighbour');
  assert.equal(rig.ide().openTabs.find((tab) => tab.path === 'b.js').group, 'editor-2');
});

test('a tab dropped on the primary strip leaves its group, and the empty group closes', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js');
  rig.runCommand('ide:split-editor-right');
  await settle();
  dropTab(rig, rig.doc.getElementById('ideTabStrip'), { path: 'b.js', fromGroup: 'editor-2' });
  await settle();
  assert.deepEqual(rig.primaryTabs(), ['a.js', 'b.js']);
  assert.equal(rig.ide().activeTabPath, 'b.js', 'the dropped tab is active in the primary');
  assert.equal(rig.groupEl('editor-2'), null, 'the group view is gone');
  assert.deepEqual(rig.groupsInLayout().slice(1), [], 'and so is its stack');
});

test('a primary tab dropped on a group strip joins that group', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js', 'c.js');
  rig.runCommand('ide:split-editor-right'); // c.js -> editor-2
  await settle();
  dropTab(rig, rig.groupEl('editor-2').querySelector('.ide-tabstrip'), { path: 'a.js', fromGroup: '' });
  await settle();
  assert.deepEqual(rig.groupTabs('editor-2').sort(), ['a.js', 'c.js']);
  assert.deepEqual(rig.primaryTabs(), ['b.js']);
});

test('after a primary tab is dragged into a group, a group tab can be dragged back (dragend on the detached tab; row 40 gate)', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js', 'c.js');
  rig.runCommand('ide:split-editor-right'); // c.js -> editor-2
  await settle();
  const win = rig.harness.dom.window;
  const source = rig.doc.querySelector('#ideTabStrip [data-ide-tab="a.js"]');
  const start = new win.Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(start, 'dataTransfer', { value: { setData() {}, effectAllowed: '' } });
  source.dispatchEvent(start);
  dropTab(rig, rig.groupEl('editor-2').querySelector('.ide-tabstrip'), { path: 'a.js', fromGroup: '' });
  await settle();
  assert.equal(source.isConnected, false, 'the strip re-rendered without the dragged tab');
  source.dispatchEvent(new win.Event('dragend', { bubbles: true })); // fires on the detached source
  dropTab(rig, rig.doc.getElementById('ideTabStrip'), { path: 'c.js', fromGroup: 'editor-2' });
  await settle();
  assert.ok(rig.primaryTabs().includes('c.js'), 'the primary strip accepts the group tab');
  assert.deepEqual(rig.groupTabs('editor-2'), ['a.js']);
});

test('closing the last tab of a group closes the group; the primary keeps its tab', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js');
  rig.runCommand('ide:split-editor-right');
  await settle();
  rig.groupEl('editor-2').querySelector('[data-ide-tab-close="b.js"]').click();
  await settle();
  assert.equal(rig.groupEl('editor-2'), null);
  assert.deepEqual(rig.groupsInLayout().slice(1), []);
  assert.deepEqual(rig.primaryTabs(), ['a.js']);
  assert.equal(rig.ide().activeTabPath, 'a.js');
});

test('opening a file that lives in a group shows it there instead of moving it', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js', 'c.js');
  rig.runCommand('ide:split-editor-right'); // c.js -> editor-2
  await settle();
  await openFiles(rig, 'a.js', 'c.js');
  assert.equal(rig.ide().openTabs.find((tab) => tab.path === 'c.js').group, 'editor-2', 'still in its group');
  assert.equal(rig.ide().activeTabPath, 'a.js', 'the primary did not switch');
});

test('the tab menus offer the moves: Move to New Group Right on a primary tab, Close All in a group', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js');
  openContextMenu(rig.harness, rig.doc.querySelector('#ideTabStrip [data-ide-tab-path="b.js"]'));
  const moveRight = findMenuItem(rig.doc, 'Move to New Group Right');
  assert.ok(moveRight, 'the primary tab menu offers a new group');
  moveRight.click();
  await settle();
  assert.deepEqual(rig.groupTabs('editor-2'), ['b.js']);

  openContextMenu(rig.harness, rig.groupEl('editor-2').querySelector('[data-ide-tab="b.js"]'));
  assert.ok(findMenuItem(rig.doc, 'Close All'), 'the group tab menu has the bulk closes');
  const back = findMenuItem(rig.doc, 'Move to Editor group 1');
  assert.ok(back, 'and a move back to the primary group');
  back.click();
  await settle();
  assert.deepEqual(rig.primaryTabs(), ['a.js', 'b.js']);
  assert.equal(rig.groupEl('editor-2'), null);
});

test('groups persist with their tabs and come back on the next start', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js');
  rig.runCommand('ide:split-editor-right');
  await settle(600);
  const saved = rig.harness.bridge.calls.updateState.at(-1).rootState;
  assert.deepEqual(saved.openTabs, [{ path: 'a.js' }, { path: 'b.js', group: 'editor-2' }]);
  assert.equal(saved.activeTabPath, 'a.js');

  const next = await openIde(t, { files: FILES, persisted: { openTabs: saved.openTabs, activeTabPath: 'a.js', expandedDirs: [] } });
  assert.deepEqual(next.groupTabs('editor-2'), ['b.js'], 'the group view is back with its tab');
  assert.deepEqual(next.groupsInLayout().slice(1), ['editor-2'], 'and its stack is in the layout');
  assert.deepEqual(next.primaryTabs(), ['a.js']);
  const read = (path) => next.harness.bridge.calls.readFile.some((call) => call.path === path);
  assert.ok(read('a.js') && read('b.js'), "the primary's open does not cancel the group's document load");
});

test('a non-text tab stays in the primary group: no move items, and Split leaves it put', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'notes.md');
  openContextMenu(rig.harness, rig.doc.querySelector('#ideTabStrip [data-ide-tab-path="notes.md"]'));
  assert.equal(findMenuItem(rig.doc, 'Move to New Group Right'), null);
  rig.runCommand('ide:split-editor-right');
  await settle();
  assert.deepEqual(rig.groupsInLayout().slice(1), []);
  assert.deepEqual(rig.primaryTabs(), ['a.js', 'notes.md']);
});

test('without Monaco the split rows stay out of the palette', async (t) => {
  const rig = await openIde(t, { files: FILES }, { monaco: false });
  const ids = rig.harness.controller.getIdeCommandItems().map((item) => item.id);
  assert.ok(ids.includes('ide:reset-layout'), 'the layout rows are there');
  assert.equal(ids.includes('ide:split-editor-right'), false);
  assert.equal(ids.includes('ide:focus-next-editor-group'), false);
});

function key(rig, target, keyName) {
  target.dispatchEvent(new rig.harness.dom.window.KeyboardEvent('keydown', { key: keyName, ctrlKey: true, bubbles: true, cancelable: true }));
}

test('group follow-up: activation and editor focus report the group active path', () => {
  const ide = ideState.createIdeUiState();
  ideState.openTab(ide, 'a.js');
  ideState.openTab(ide, 'b.js');
  ide.openTabs.forEach((tab) => { tab.group = 'editor-2'; });
  let viewDeps;
  const activated = [];
  const wiring = createIdeEditorGroupsWiring({
    getIde: () => ide,
    editorHost: { hasDocument: () => true },
    groupViewUtils: {
      createIdeEditorGroupView(deps) {
        viewDeps = deps;
        return { render() {}, dispose() {} };
      },
    },
    onActivated: (path) => activated.push(path),
  });
  wiring.reconcile();
  assert.equal(wiring.activateInGroup('b.js'), true);
  assert.deepEqual(activated, ['b.js']);
  viewDeps.onFocus('editor-2');
  assert.deepEqual(activated, ['b.js', 'b.js']);
  assert.equal(wiring.getFocusedGroup(), 'editor-2');
  assert.equal(wiring.activateInGroup('missing.js'), false);
  assert.equal(activated.length, 2);
  wiring.dispose();
});

test('activating a tab in a group asks the workbench to bring that group into view', () => {
  // Real-app gate 2026-10-26: a file opened from the tree into a group that gave way to the
  // primary (0 px in a narrow window) stayed out of sight.
  const ide = ideState.createIdeUiState();
  ideState.openTab(ide, 'a.js');
  ide.openTabs.forEach((tab) => { tab.group = 'editor-3'; });
  const revealed = [];
  const wiring = createIdeEditorGroupsWiring({
    getIde: () => ide,
    editorHost: { hasDocument: () => true },
    getWorkbenchWiring: () => ({ workbench: { revealEditorGroup: (id) => revealed.push(id) } }),
    groupViewUtils: { createIdeEditorGroupView: () => ({ render() {}, dispose() {} }) },
  });
  wiring.reconcile();
  assert.equal(wiring.activateInGroup('a.js'), true);
  assert.deepEqual(revealed, ['editor-3']);
  wiring.dispose();
});

test('group follow-up: Ctrl+Tab history follows grouped file activation', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js', 'c.js');
  rig.runCommand('ide:split-editor-right');
  await settle();
  await openFiles(rig, 'a.js', 'c.js');
  key(rig, rig.groupEl('editor-2'), 'Tab');
  assert.deepEqual([...rig.doc.querySelectorAll('[data-ide-mru-path]')].map((row) => row.dataset.ideMruPath), ['c.js', 'a.js', 'b.js']);
  assert.equal(rig.doc.querySelector('.ide-mru-switcher .ide-picker-row--selected')?.dataset.ideMruPath, 'a.js');
  rig.harness.dom.window.dispatchEvent(new rig.harness.dom.window.Event('blur'));
});

test('group follow-up: grouped open shows the editor and background open preserves maximization', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js');
  rig.runCommand('ide:split-editor-right');
  await settle();
  const wb = workbenchUtils.getActive().workbench;
  wb.revealView('terminal');
  const panel = wb.hostFor('terminal').closest('[data-wb-stack]').dataset.wbStack;
  wb.toggleMaximize(panel);
  assert.equal(Boolean(rig.doc.querySelector('.wb-cell[hidden] #ideMain')), true);
  assert.equal(await rig.harness.controller.openFile('b.js'), true);
  assert.equal(Boolean(rig.doc.querySelector('.wb-cell[hidden] #ideMain')), false);
  wb.toggleMaximize(panel);
  for (const path of ['a.js', 'b.js']) {
    assert.equal(await rig.harness.controller.openFile(path, { background: true }), true);
    assert.equal(Boolean(rig.doc.querySelector('.wb-cell[hidden] #ideMain')), true);
  }
});

test('group follow-up: Ctrl+Tab activation into a group shows the editor', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js');
  rig.runCommand('ide:split-editor-right');
  await settle();
  const wb = workbenchUtils.getActive().workbench;
  wb.revealView('terminal');
  wb.toggleMaximize(wb.hostFor('terminal').closest('[data-wb-stack]').dataset.wbStack);
  assert.equal(Boolean(rig.doc.querySelector('.wb-cell[hidden] #ideMain')), true);
  key(rig, rig.doc.getElementById('ideView'), 'Tab');
  rig.doc.querySelector('[data-ide-mru-path="b.js"]').click();
  assert.equal(Boolean(rig.doc.querySelector('.wb-cell[hidden] #ideMain')), false);
  assert.equal(ideState.getTab(rig.ide(), 'b.js').group, 'editor-2');
});

test('group follow-up: controller reopen returns a closed tab to its group', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js');
  rig.runCommand('ide:split-editor-right');
  await settle();
  rig.groupEl('editor-2').querySelector('[data-ide-tab-close="b.js"]').click();
  await settle();
  assert.equal(rig.groupEl('editor-2'), null);
  rig.doc.getElementById('ideView').dispatchEvent(new rig.harness.dom.window.KeyboardEvent('keydown', {
    key: 't', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
  await settle();
  assert.equal(ideState.getTab(rig.ide(), 'b.js').group, 'editor-2');
  assert.deepEqual(rig.groupTabs('editor-2'), ['b.js']);
});

test('Ctrl+S and Ctrl+F4 inside a group act on that group, not the primary (W5 review)', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js');
  rig.runCommand('ide:split-editor-right');
  await settle();
  const strip = rig.groupEl('editor-2').querySelector('.ide-tabstrip');
  key(rig, strip, 's');
  await settle(50);
  const written = rig.harness.bridge.calls.writeFile.map((call) => call.path);
  assert.ok(written.includes('b.js'), "the group's file is saved");
  assert.equal(written.includes('a.js'), false, 'the primary file is not');
  key(rig, strip, 'F4');
  await settle();
  assert.equal(rig.groupEl('editor-2'), null, "Ctrl+F4 closed the group's tab, and the group with it");
  assert.deepEqual(rig.primaryTabs(), ['a.js'], 'the primary tab stays');
  const active = rig.doc.activeElement;
  assert.notEqual(active, rig.doc.body, 'focus does not fall to <body> with its group (row 40 review)');
  assert.equal(active.id, 'ideEditorFallback', "it lands in the primary editor (the rig's fallback editor; Monaco in the app)");
});

test('closing a tab in a group shows its neighbour, not the first tab (W5 review)', async (t) => {
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js', 'c.js');
  rig.runCommand('ide:split-editor-right'); // c.js -> editor-2
  await settle();
  for (const path of ['a.js', 'b.js']) {
    openContextMenu(rig.harness, rig.doc.querySelector(`#ideTabStrip [data-ide-tab-path="${path}"]`));
    findMenuItem(rig.doc, 'Move to Editor group 2').click();
    await settle();
  }
  assert.deepEqual(rig.groupTabs('editor-2'), ['c.js', 'a.js', 'b.js']);
  rig.groupEl('editor-2').querySelector('[data-ide-tab-path="a.js"]').click();
  await settle();
  rig.groupEl('editor-2').querySelector('[data-ide-tab-close="a.js"]').click();
  await settle();
  const active = rig.groupEl('editor-2').querySelector('.ide-tab--active');
  assert.equal(active?.getAttribute('data-ide-tab'), 'b.js');
});

// ── Tabs overhaul (row 81): shared strip events, focus marker, menus ──

function makeUnitWiring(extra = {}) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="ideMain"></div></body>');
  const doc = dom.window.document;
  const main = doc.getElementById('ideMain');
  const ide = ideState.createIdeUiState();
  for (const path of ['a.js', 'b.js', 'c.js', 'd.js']) ideState.openTab(ide, path);
  ideState.openTab(ide, 'e.js', { transientPreview: true });
  for (const tab of ide.openTabs) if (tab.path !== 'a.js') tab.group = 'editor-2';
  const viewDeps = {};
  const rendered = [];
  const menus = [];
  const persisted = [];
  const closed = [];
  const wiring = createIdeEditorGroupsWiring({
    getIde: () => ide,
    getDom: () => ({ ideMain: main, ideView: doc.body }),
    editorHost: { hasDocument: () => true },
    canHold: () => false,
    groupViewUtils: {
      createIdeEditorGroupView(deps) {
        viewDeps[deps.groupId] = deps;
        const el = doc.createElement('section');
        doc.body.appendChild(el);
        return { el, render() { rendered.push(deps.groupId); }, dispose() { el.remove(); }, focus() {}, getViewState() { return null; }, forget() {} };
      },
    },
    contextMenu: { show: (options) => menus.push(options) },
    schedulePersist: () => persisted.push(true),
    getCloseOrchestrator: () => ({
      requestCloseToRight: (path) => closed.push(['right', path]),
      requestCloseOthers: (path) => closed.push(['others', path]),
      requestCloseSaved: (id) => closed.push(['saved', id]),
      requestCloseAll: (id) => closed.push(['all', id]),
    }),
    ...extra,
  });
  wiring.bindEvents();
  wiring.reconcile();
  const markerOf = (el) => el.hasAttribute('data-ide-group-focused');
  return { wiring, ide, main, doc, viewDeps, rendered, menus, persisted, closed, markerOf, groupEl: () => wiring.getElement('editor-2'), win: dom.window };
}

test('row 81: the focused group root carries data-ide-group-focused, #ideMain when the primary is focused', () => {
  const rig = makeUnitWiring();
  assert.equal(rig.markerOf(rig.main), true, 'the primary starts focused');
  assert.equal(rig.markerOf(rig.groupEl()), false);
  rig.viewDeps['editor-2'].onFocus('editor-2');
  assert.equal(rig.markerOf(rig.groupEl()), true);
  assert.equal(rig.markerOf(rig.main), false, 'only one group carries it');
  rig.main.dispatchEvent(new rig.win.FocusEvent('focusin', { bubbles: true }));
  assert.equal(rig.markerOf(rig.main), true);
  assert.equal(rig.markerOf(rig.groupEl()), false);
  rig.wiring.activateInGroup('c.js');
  assert.equal(rig.markerOf(rig.groupEl()), true, 'activating a grouped tab focuses its group');
  assert.equal(rig.markerOf(rig.main), false);
  rig.wiring.focusNextGroup();
  assert.equal(rig.markerOf(rig.main), true, 'cycling group focus moves the marker');
  rig.wiring.dispose();
  assert.equal(rig.markerOf(rig.main), false, 'dispose leaves no marker behind');
});

test('row 81: a group view that goes away hands the marker back to the primary group', () => {
  const rig = makeUnitWiring();
  rig.viewDeps['editor-2'].onFocus('editor-2');
  for (const tab of rig.ide.openTabs) delete tab.group;
  rig.wiring.reconcile();
  assert.equal(rig.groupEl(), null);
  assert.equal(rig.markerOf(rig.main), true);
});

test('row 81: the group tab menu adds Keep Open, Close to the Right and Pin / Unpin', () => {
  const rig = makeUnitWiring();
  rig.viewDeps['editor-2'].onContextMenu('e.js', { anchorEl: rig.groupEl() });
  const items = rig.menus.at(-1).items;
  assert.equal(rig.menus.at(-1).anchorEl, rig.groupEl());
  const labels = items.map((item) => item.label || '-');
  assert.deepEqual(labels.slice(0, 7), ['Keep Open', 'Close', 'Close Others', 'Close to the Right', 'Close Saved', 'Close All', 'Close Group']);
  assert.equal(items.find((item) => item.label === 'Close to the Right').disabled, true, 'e.js is the last tab of its group');
  assert.ok(labels.includes('Pin'));
  items[0].action();
  assert.equal(ideState.getTab(rig.ide, 'e.js').transientPreview, undefined);
  assert.ok(rig.rendered.includes('editor-2') && rig.persisted.length === 1);

  rig.viewDeps['editor-2'].onContextMenu('b.js', { anchorX: 1, anchorY: 2 });
  const second = rig.menus.at(-1).items;
  assert.equal(second.some((item) => item.label === 'Keep Open'), false, 'only a preview tab offers Keep Open');
  const toRight = second.find((item) => item.label === 'Close to the Right');
  assert.equal(toRight.disabled, false);
  toRight.action();
  assert.deepEqual(rig.closed, [['right', 'b.js']]);
  second.find((item) => item.label === 'Pin').action();
  assert.equal(ideState.getTab(rig.ide, 'b.js').pinned, true);
  assert.deepEqual(rig.ide.openTabs.map((tab) => tab.path), ['b.js', 'a.js', 'c.js', 'd.js', 'e.js'], 'pinned-first');
  rig.viewDeps['editor-2'].onContextMenu('b.js', { anchorX: 1, anchorY: 2 });
  assert.ok(rig.menus.at(-1).items.some((item) => item.label === 'Unpin'));
});

test('row 81: double-click keeps a preview tab open, otherwise toggles the pin, then renders and persists', () => {
  const rig = makeUnitWiring();
  rig.viewDeps['editor-2'].onDoubleClick('e.js');
  assert.equal(ideState.getTab(rig.ide, 'e.js').transientPreview, undefined);
  assert.notEqual(ideState.getTab(rig.ide, 'e.js').pinned, true);
  rig.viewDeps['editor-2'].onDoubleClick('e.js');
  assert.equal(ideState.getTab(rig.ide, 'e.js').pinned, true);
  assert.equal(rig.persisted.length, 2);
  assert.equal(rig.rendered.filter((id) => id === 'editor-2').length >= 2, true);
  const before = rig.persisted.length;
  rig.viewDeps['editor-2'].onDoubleClick('missing.js');
  assert.equal(rig.persisted.length, before, 'an unknown path changes nothing');
});

test('row 81: the open-tabs list anchors on the trigger, checks the active tab and offers Reopen Closed Tab when wired', () => {
  const reopened = [];
  const rig = makeUnitWiring({ reopenClosedTab: () => reopened.push(true) });
  ideState.setTabDirty(rig.ide, 'c.js', true);
  rig.ide.dirtyByPath = { 'c.js': true };
  const trigger = rig.groupEl();
  rig.wiring.activateInGroup('d.js');
  rig.viewDeps['editor-2'].onOverflow(trigger);
  const menu = rig.menus.at(-1);
  assert.equal(menu.anchorEl, trigger);
  assert.deepEqual(menu.items.map((item) => item.label || '-'), ['b.js', 'c.js', 'd.js', 'e.js', '-', 'Close Saved', 'Close All', 'Reopen Closed Tab']);
  assert.deepEqual(menu.items.map((item) => item.checked), [false, false, true, false, undefined, undefined, undefined, undefined]);
  assert.equal(menu.items[1].shortcutHint, '●', 'the unsaved tab carries the dot');
  menu.items[5].action();
  menu.items[6].action();
  menu.items[7].action();
  assert.deepEqual(rig.closed, [['saved', 'editor-2'], ['all', 'editor-2']]);
  assert.deepEqual(reopened, [true]);
  const bare = makeUnitWiring();
  bare.viewDeps['editor-2'].onOverflow(bare.groupEl());
  assert.equal(bare.menus.at(-1).items.some((item) => item.label === 'Reopen Closed Tab'), false);
});

test('row 81: the git decoration dep reaches each group view', () => {
  const seen = [];
  const rig = makeUnitWiring({ getGitDecoration: (path) => { seen.push(path); return 'modified'; } });
  assert.equal(rig.viewDeps['editor-2'].getGitDecoration('b.js'), 'modified');
  assert.deepEqual(seen, ['b.js']);
  const bare = makeUnitWiring();
  assert.equal(bare.viewDeps['editor-2'].getGitDecoration('b.js'), undefined, 'optional');
});

test('row 81: the group toolbar Split moves the group tab into a new group, double-click pins it', async (t) => {
  const previous = globalThis.rendererIdeStageSwitch;
  globalThis.rendererIdeStageSwitch = {
    editorActionsMarkup: () => '<button class="ide-editor-action" data-ide-editor-action="split-right">s</button>',
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.rendererIdeStageSwitch;
    else globalThis.rendererIdeStageSwitch = previous;
  });
  const rig = await openIde(t);
  await openFiles(rig, 'a.js', 'b.js', 'c.js');
  const main = rig.doc.getElementById('ideMain');
  assert.equal(main.hasAttribute('data-ide-group-focused'), true, 'the primary group starts focused');
  rig.runCommand('ide:split-editor-right'); // c.js -> editor-2
  await settle();
  assert.equal(rig.groupEl('editor-2').hasAttribute('data-ide-group-focused'), true);
  assert.equal(main.hasAttribute('data-ide-group-focused'), false);

  const win = rig.harness.dom.window;
  rig.groupEl('editor-2').querySelector('[data-ide-tab-path="c.js"]').dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(ideState.getTab(rig.ide(), 'c.js').pinned, true, 'a group tab pins on double-click');

  rig.groupEl('editor-2').querySelector('[data-ide-editor-action="split-right"]').click();
  await settle();
  assert.deepEqual(rig.groupTabs('editor-3'), ['c.js'], 'Split moved the active group tab to a new group');
  assert.equal(rig.groupEl('editor-2'), null, 'and the emptied group closed');
});

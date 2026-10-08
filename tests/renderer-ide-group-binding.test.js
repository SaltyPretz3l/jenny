'use strict';

/* Row 40 W7c: a chat or terminal view bound to an editor group. A bound chat's file
 * opens land in its group, a bound group stays open while empty (with Close Group),
 * the stack menu sets the binding and the header shows its group number, and
 * Run / Debug / New Terminal started from a group use the terminal bound to it. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createHarness, settle, findMenuItem, buildChangeTurn, openContextMenu } = require('./helpers/renderer-ide-harness');
const { buildJennyChangeLedgerFromTurnViewModels } = require('../renderer/chat/renderer-jenny-change-ledger');
const ideState = require('../renderer/features/renderer-ide-state');
const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');
const groupsUtils = require('../renderer/features/renderer-ide-editor-groups');
const { createIdeGroupBinding } = require('../renderer/features/renderer-ide-group-binding');
const { createIdeTerminalSet } = require('../renderer/features/renderer-ide-terminal-set');
const realHost = require('../renderer/features/renderer-ide-editor-host');

const FILES = { 'a.js': 'const a = 1;\n', 'b.js': 'const b = 2;\n', 'c.js': 'const c = 3;\n', 'notes.md': '# n\n' };

const textHost = {
  ...realHost,
  createIdeEditorHost(deps) {
    const host = realHost.createIdeEditorHost(deps);
    return { ...host, getMonaco: () => ({}), isTextDocument: (p) => host.hasDocument(p) && p !== 'notes.md' };
  },
};

async function openIde(t, extra = {}) {
  const harness = createHarness({
    ...extra,
    bridgeOptions: { files: { ...FILES, ...extra.files }, snapshots: extra.snapshots },
    beforeController: () => { globalThis.rendererIdeEditorHost = textHost; },
  });
  t.after(() => harness.dispose());
  delete globalThis.rendererIdeEditorHost;
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const ide = () => harness.state.ui.ide;
  const layout = () => ideState.getWorkbenchLayout(ide());
  const setLayout = async (next) => { ideState.commitWorkbenchLayout(ide(), next); harness.controller.renderIde(); await settle(); };
  const groupEl = (id) => doc.querySelector(`#ideWorkbench [data-ide-group="${id}"]`);
  const groupTabs = (id) => [...(groupEl(id)?.querySelectorAll('[data-ide-tab]') || [])].map((el) => el.getAttribute('data-ide-tab'));
  const primaryTabs = () => [...doc.querySelectorAll('#ideTabStrip [data-ide-tab]')].map((el) => el.getAttribute('data-ide-tab'));
  const runCommand = (id) => harness.controller.getIdeCommandItems().find((item) => item.id === id).run();
  const open = async (...paths) => { for (const p of paths) { await harness.controller.openFile(p); await settle(); } };
  return { harness, doc, ide, layout, setLayout, groupEl, groupTabs, primaryTabs, runCommand, open };
}

async function splitB(rig) {
  await rig.open('a.js', 'b.js');
  rig.runCommand('ide:split-editor-right');
  await settle();
  assert.deepEqual(rig.groupTabs('editor-2'), ['b.js']);
}

test('a bound chat opens files in its group, whatever group has focus', async (t) => {
  const rig = await openIde(t);
  await splitB(rig);
  await rig.setLayout(ops.setBinding(rig.layout(), 'chat', 'editor-2'));
  rig.doc.getElementById('ideEditorFallback').focus(); // the primary group has focus
  assert.equal(await rig.harness.controller.openFileAtLine('c.js', 1, 1, { pane: 0 }), true);
  await settle();
  assert.deepEqual(rig.groupTabs('editor-2'), ['b.js', 'c.js'], 'Chat is bound to group 2');
  assert.equal(rig.ide().activeTabPath, 'a.js');
  // A file already open stays where it is; a non-text file stays primary.
  await rig.harness.controller.openFileAtLine('a.js', 1, 1, { pane: 0 });
  await rig.harness.controller.openFileAtLine('notes.md', 1, 1, { pane: 0 });
  await settle();
  assert.deepEqual(rig.groupTabs('editor-2'), ['b.js', 'c.js']);
  assert.ok(rig.primaryTabs().includes('notes.md'));
  // Chat 2 is not bound: the open follows focus (the primary group here).
  await rig.setLayout(ops.setBinding(rig.layout(), 'chat', ops.listEditorGroups(rig.layout())[0]));
  await rig.harness.controller.openFile('b.js'); // focus group 2
  await settle();
  rig.doc.getElementById('ideEditorFallback').focus();
  await rig.harness.controller.openFileAtLine('c.js', 1, 1, { pane: 1 });
  await settle();
  assert.deepEqual(rig.groupTabs('editor-2'), ['b.js', 'c.js']);
});

test('a chat bound to the primary group keeps its opens there while a group has focus', async (t) => {
  const rig = await openIde(t);
  await splitB(rig);
  await rig.setLayout(ops.setBinding(rig.layout(), 'chat', ops.listEditorGroups(rig.layout())[0]));
  rig.groupEl('editor-2').querySelector('.ide-group-stage').focus();
  await rig.harness.controller.openFileAtLine('c.js', 1, 1, { pane: 0 });
  await settle();
  assert.ok(rig.primaryTabs().includes('c.js'));
  assert.deepEqual(rig.groupTabs('editor-2'), ['b.js']);
});

test('a bound group stays open while empty, says what lands there, and Close Group removes it', async (t) => {
  const rig = await openIde(t);
  await splitB(rig);
  await rig.setLayout(ops.setBinding(rig.layout(), 'chat', 'editor-2'));
  await rig.harness.controller.getCloseOrchestrator().requestCloseAll('editor-2');
  await settle();
  rig.harness.controller.renderIde(); // a full render reconciles the layout with the tabs
  await settle();
  assert.ok(rig.groupEl('editor-2'), 'the bound group outlives its last tab');
  assert.deepEqual(ops.listEditorGroups(rig.layout()), ['editor-1', 'editor-2']);
  const empty = rig.groupEl('editor-2').querySelector('.ide-group-empty');
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /Files Jenny opens from Chat land here\./);
  empty.querySelector('[data-ide-group-close]').click();
  await settle();
  assert.equal(rig.groupEl('editor-2'), null);
  assert.deepEqual(ops.listEditorGroups(rig.layout()), ['editor-1']);
  assert.equal(ops.bindingOf(rig.layout(), 'chat'), '');
});

test('Close Group cancelled at the dirty prompt keeps the group and its bindings', async (t) => {
  const rig = await openIde(t);
  await rig.open('a.js');
  const fallback = rig.doc.getElementById('ideEditorFallback');
  fallback.value = 'edited';
  fallback.dispatchEvent(new rig.harness.dom.window.Event('input', { bubbles: true }));
  rig.runCommand('ide:split-editor-right');
  await settle();
  assert.deepEqual(rig.groupTabs('editor-2'), ['a.js']);
  await rig.setLayout(ops.setBinding(rig.layout(), 'chat', 'editor-2'));
  openContextMenu(rig.harness, rig.groupEl('editor-2').querySelector('[data-ide-tab="a.js"]'));
  findMenuItem(rig.doc, 'Close Group').click();
  await settle();
  const cancel = rig.doc.body.querySelector('[data-ide-confirm-action="cancel"]');
  assert.ok(cancel, 'the dirty tab prompts');
  cancel.click();
  await settle();
  assert.deepEqual(rig.groupTabs('editor-2'), ['a.js']);
  assert.equal(ops.bindingOf(rig.layout(), 'chat'), 'editor-2', 'a cancelled close unbinds nothing');
});

test('a new file opened into a focused group leaves the primary group on the tab it showed', async (t) => {
  const rig = await openIde(t, { files: { 'd.js': 'const d = 4;\n' } });
  await splitB(rig); // primary: a.js; group 2: b.js
  rig.doc.getElementById('ideEditorFallback').focus();
  await rig.open('c.js', 'a.js');
  assert.deepEqual(rig.primaryTabs(), ['a.js', 'c.js']);
  assert.equal(rig.ide().activeTabPath, 'a.js');
  rig.groupEl('editor-2').querySelector('.ide-group-stage').focus();
  await rig.open('d.js');
  assert.deepEqual(rig.groupTabs('editor-2'), ['b.js', 'd.js'], 'the open follows focus into group 2');
  assert.equal(rig.ide().activeTabPath, 'a.js', 'not a.js\'s neighbour c.js');
});

test('the stack menu binds a terminal and the header shows the group number', async (t) => {
  const rig = await openIde(t);
  await splitB(rig);
  const stackOf = (viewId) => rig.doc.querySelector(`[data-wb-tab="${viewId}"]`).closest('[data-wb-stack]');
  stackOf('terminal').querySelector('[data-wb-action="more"]').click();
  await settle();
  const item = findMenuItem(rig.doc, 'Bind to Editor Group 2');
  assert.ok(item, 'the menu offers each group');
  assert.equal(findMenuItem(rig.doc, 'Not bound to a group').getAttribute('aria-checked'), 'true');
  item.click();
  await settle();
  assert.equal(ops.bindingOf(rig.layout(), 'terminal'), 'editor-2');
  const badge = stackOf('terminal').querySelector('[data-wb-action="bind"]');
  assert.equal(badge.textContent.trim(), '2');
  assert.equal(badge.getAttribute('aria-label'), 'Bound to editor group 2');
  badge.click();
  await settle();
  assert.equal(findMenuItem(rig.doc, 'Bind to Editor Group 2').getAttribute('aria-checked'), 'true', 'the badge opens the same menu');
  // Bind to New Editor Group opens an empty bound group.
  const bindNew = findMenuItem(rig.doc, 'Bind to New Editor Group');
  assert.equal(bindNew.getAttribute('role'), 'menuitemradio');
  assert.equal(bindNew.getAttribute('aria-checked'), 'false');
  bindNew.click();
  await settle();
  assert.deepEqual(ops.listEditorGroups(rig.layout()), ['editor-1', 'editor-2', 'editor-3']);
  assert.equal(ops.bindingOf(rig.layout(), 'terminal'), 'editor-3');
  assert.ok(rig.groupEl('editor-3'));
  assert.match(rig.groupEl('editor-3').textContent, /Runs started here use Terminal\./);
});

test('a stack keeps its bound terminal badge while another tab is active, until unbound', async (t) => {
  const rig = await openIde(t);
  await splitB(rig);
  const stack = () => rig.doc.querySelector('[data-wb-tab="terminal"]').closest('[data-wb-stack]');
  stack().querySelector('[data-wb-action="more"]').click();
  await settle();
  findMenuItem(rig.doc, 'Bind to Editor Group 2').click();
  await settle();
  assert.equal(ops.bindingOf(rig.layout(), 'terminal'), 'editor-2');
  stack().querySelector('[data-wb-tab="run"]').click();
  await settle();
  assert.equal(stack().querySelector('[data-wb-tab="run"]').getAttribute('aria-selected'), 'true');
  const badge = stack().querySelector('[data-wb-action="bind"]');
  assert.ok(badge, 'the stack still holds the bound terminal');
  assert.equal(badge.textContent.trim(), '2');
  assert.equal(badge.getAttribute('aria-label'), 'Bound to editor group 2');
  // The badge opens the bound view's menu, not the active tab's (Run has no binding rows).
  badge.click();
  await settle();
  assert.equal(findMenuItem(rig.doc, 'Bind to Editor Group 2').getAttribute('aria-checked'), 'true', 'the badge speaks for Terminal');
  findMenuItem(rig.doc, 'Not bound to a group').click();
  await settle();
  assert.equal(ops.bindingOf(rig.layout(), 'terminal'), '');
  assert.equal(stack().querySelector('[data-wb-tab="run"]').getAttribute('aria-selected'), 'true');
  assert.equal(stack().querySelector('[data-wb-action="bind"]'), null);
});

test('a diff a bound chat opens lands in its group with its review bar; the primary diff tab offers Move', async (t) => {
  const rig = await openIde(t, {
    files: { 'src/app.js': 'a\nB\nc\n' }, snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    turnViewModels: [buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', additions: 1, deletions: 1 })],
  });
  const { harness } = rig;
  const ledger = buildJennyChangeLedgerFromTurnViewModels(harness.turnViewModels, {
    sessionId: String(harness.state.currentSessionId || ''), workspaceId: String(harness.state.workspaceRoot?.rootId || '') });
  const changeId = ledger.changes[0].changeId;
  await harness.controller.openLedgerChangeById(changeId);
  await settle();
  const diffId = rig.ide().activeTabPath;
  assert.match(diffId, /^diff:\/\//, 'unbound: the diff opens in the primary group');
  // The primary diff tab's menu offers Move to a new group (and no file actions).
  openContextMenu(harness, rig.doc.querySelector(`#ideTabStrip [data-ide-tab-path="${diffId}"]`));
  assert.ok(findMenuItem(rig.doc, 'Move to New Group Right'), 'a diff tab can move');
  rig.doc.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await harness.controller.getCloseOrchestrator().requestCloseAll('');
  await settle();
  await splitB(rig);
  rig.doc.getElementById('ideEditorFallback').focus();
  await rig.open('c.js', 'a.js');
  assert.deepEqual(rig.primaryTabs(), ['a.js', 'c.js'], 'a.js active, c.js its neighbour');
  await rig.setLayout(ops.setBinding(rig.layout(), 'chat', 'editor-2'));
  rig.doc.getElementById('ideEditorFallback').focus();
  assert.equal(await harness.controller.openLedgerChangeById(changeId), true);
  await settle();
  assert.ok(rig.groupTabs('editor-2').includes(diffId), 'Chat is bound to group 2: its diff lands there');
  assert.ok(!rig.primaryTabs().includes(diffId));
  assert.equal(rig.ide().activeTabPath, 'a.js', 'the primary group keeps the tab it showed, not the neighbour');
  assert.ok(rig.groupEl('editor-2').querySelector('.ide-group-review [data-ide-diff-revert]'), 'the group shows the review bar');
});

/* ---------------------------------------------------------------- routing unit rig */

function bindingRig(layout, focusedGroup = '') {
  let current = layout;
  const shown = [];
  const wiring = { getLayout: () => current, commitLayout: (next) => { current = next; } };
  const binding = createIdeGroupBinding({
    getWorkbenchWiring: () => wiring, getEditorGroups: () => ({ getFocusedGroup: () => focusedGroup }),
    getIde: () => ({ openTabs: [] }), model, ops, groupsUtils,
    showPanel: (id) => { shown.push(id); return true; },
  });
  return { binding, shown, layout: () => current, focus: (id) => { focusedGroup = id; } };
}

function groupsWithTerminals() {
  let layout = ops.addEditorGroup(model.createDefaultLayout(), 'editor-1', 'right', undefined, 'editor-2');
  layout = ops.addStackBeside(layout, ['terminal-3'], 'chat', 'col');
  layout = ops.addView(layout, 'terminal-2', 'terminal');
  return layout;
}

test('chat targets: unbound is undefined, the primary is empty, pane 1 is Chat 2', () => {
  const base = ops.addStackBeside(groupsWithTerminals(), ['chat-2', 'changes-2'], 'chat', 'col');
  const rig = bindingRig(ops.setBinding(ops.setBinding(base, 'chat', 'editor-1'), 'chat-2', 'editor-2'));
  assert.equal(rig.binding.chatTarget(0), '');
  assert.equal(rig.binding.chatTarget(1), 'editor-2');
  assert.equal(bindingRig(base).binding.chatTarget(0), undefined);
  assert.deepEqual(rig.binding.boundGroups(), ['editor-2']);
});

test('openDiffFrom moves only the newly opened diff it names, from a still-bound chat', async () => {
  let layout = ops.setBinding(groupsWithTerminals(), 'chat', 'editor-2');
  const ide = { openTabs: [{ path: 'diff://old' }, { path: 'a.js' }, { path: 'b.js' }], activeTabPath: 'a.js' };
  const moved = [];
  const shown = [];
  const binding = createIdeGroupBinding({
    getWorkbenchWiring: () => ({ getLayout: () => layout }), getIde: () => ide, model, ops, groupsUtils,
    getEditorGroups: () => ({
      moveToGroup: (id, group) => {
        moved.push([id, group]);
        ide.openTabs.find((tab) => tab.path === id).group = group;
        if (ide.activeTabPath === id) ide.activeTabPath = 'b.js'; // the neighbour
        return true;
      },
      showPrimary: (path) => { shown.push(path); ide.activeTabPath = path; },
    }),
  });
  const opens = (id, ok = true) => () => { ide.activeTabPath = id; if (!ide.openTabs.some((tab) => tab.path === id)) ide.openTabs.push({ path: id }); return ok; };
  assert.equal(await binding.openDiffFrom(0, opens('diff://new'), 'diff://new'), true);
  assert.deepEqual(moved, [['diff://new', 'editor-2']]);
  assert.deepEqual(shown, ['a.js'], 'the primary group shows the tab it showed before the open');
  // Another diff opens and takes focus while this one is opening: the named diff still moves.
  let release;
  const pending = binding.openDiffFrom(0, () => new Promise((resolve) => { release = resolve; }), 'diff://mine');
  opens('diff://mine')();
  opens('diff://other')();
  release(true);
  await pending;
  assert.deepEqual(moved.at(-1), ['diff://mine', 'editor-2']);
  assert.equal(ide.activeTabPath, 'diff://other', 'the other diff keeps the primary group');
  const count = moved.length;
  await binding.openDiffFrom(0, opens('diff://old'), 'diff://old');
  await binding.openDiffFrom(1, opens('diff://chat2'), 'diff://chat2');
  await binding.openDiffFrom(undefined, opens('diff://nopane'), 'diff://nopane');
  await binding.openDiffFrom(0, opens('diff://failed', false), 'diff://failed');
  await binding.openDiffFrom(0, opens('diff://unnamed'));
  const rebind = binding.openDiffFrom(0, opens('diff://rebound'), 'diff://rebound');
  layout = ops.setBinding(layout, 'chat', '');
  await rebind;
  assert.equal(moved.length, count, 'open before, Chat 2 unbound, no pane, a failed open, no id or unbound meanwhile: no move');
});

test('Bind to rows and the badge use each group\'s own number, not its place in the tree', () => {
  // Split right (editor-2), then split the primary down (editor-3): tree order is editor-1, editor-3, editor-2.
  let layout = ops.addEditorGroup(model.createDefaultLayout(), 'editor-1', 'right', undefined, 'editor-2');
  layout = ops.addEditorGroup(layout, 'editor-1', 'down', undefined, 'editor-3');
  assert.deepEqual(ops.listEditorGroups(layout), ['editor-1', 'editor-3', 'editor-2']);
  const rig = bindingRig(layout);
  const rows = rig.binding.menuItems('chat').filter((item) => /^Bind to Editor Group/.test(item.label || ''));
  assert.deepEqual(rows.map((item) => item.label), ['Bind to Editor Group 1', 'Bind to Editor Group 2', 'Bind to Editor Group 3']);
  rows[1].action();
  assert.equal(ops.bindingOf(rig.layout(), 'chat'), 'editor-2', 'Group 2 is editor-2, whose strip says Editor group 2');
  const chrome = require('../renderer/features/renderer-ide-workbench-chrome');
  assert.equal(chrome.boundBadge(ops, rig.layout(), ['chat'], 'chat', (k, d, p) => d.replace('{n}', p.n)).n, 2);
});

test('the focused group picks its bound terminal (lowest slot) and Run joins its stack', () => {
  let layout = groupsWithTerminals();
  layout = ops.setBinding(ops.setBinding(layout, 'terminal-3', 'editor-2'), 'terminal-2', 'editor-2');
  const rig = bindingRig(layout, 'editor-2');
  assert.equal(rig.binding.boundTerminal(), 'terminal-2');
  rig.focus('');
  assert.equal(rig.binding.boundTerminal(), '', 'the primary group has no bound terminal');
  rig.focus('editor-2');
  assert.equal(rig.binding.revealTask('run', 'terminal-3'), true);
  assert.equal(model.findView(rig.layout(), 'run').stackId, model.findView(rig.layout(), 'terminal-3').stackId);
  assert.deepEqual(rig.shown, ['run']);
  assert.equal(rig.binding.revealTask('run', ''), false, 'no bound terminal: the caller opens Run as before');
});

test('a debug session uses the bound terminal when idle, else a new one beside it', async () => {
  const panels = new Map();
  const added = [];
  const set = createIdeTerminalSet({
    model,
    ptyTerminalPanelUtils: {
      createIdePtyTerminalPanel: (deps) => {
        const panel = { running: false, session: '', slot: deps.slot, isRunning: () => panel.running, getSessionId: () => panel.session,
          startSession: async () => { panel.session = 's' + deps.slot; return true; }, sendCommand: () => true, dispose() {}, getSlot: () => deps.slot };
        return panel;
      },
    },
    listTerminalViews: () => ['terminal', 'terminal-2', ...added],
    addTerminalView: (id, near) => added.push(id) && panels.set(id, near),
    revealView: () => {},
  });
  set.sync(); // the IDE syncs panels on render
  const handle = await set.openTaskTerminal('terminal-2');
  assert.equal(handle.viewId, 'terminal-2', 'the idle bound terminal runs the task');
  const next = await set.openTaskTerminal('terminal-2');
  assert.equal(next.viewId, 'terminal-3', 'busy: a new terminal opens');
  assert.equal(panels.get('terminal-3'), 'terminal-2', 'beside the bound one');
});

test('the binding module loads under the global name the IDE script manifest uses', () => {
  const file = path.join(__dirname, '..', 'renderer', 'features', 'renderer-ide-group-binding.js');
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  const manifest = require('../renderer/shell/renderer-ide-script-manifest');
  const entry = JSON.stringify(manifest).match(/renderer-ide-group-binding\.js","(\w+)"/);
  assert.ok(entry, 'listed in the manifest');
  assert.equal(typeof context[entry[1]].createIdeGroupBinding, 'function');
});

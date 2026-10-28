'use strict';

/* Terminal set (row 40 W4): one PTY panel per terminal view, slots 1..4. The
 * panel factory and the layout hooks are fakes; the real layout model supplies
 * terminalSlot/terminalViewId. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTerminalSet } = require('../renderer/features/renderer-ide-terminal-set');
const model = require('../renderer/shared/workbench-layout-model');

function fakeApi(opts = {}) {
  const listeners = [];
  const api = {
    listeners,
    onData(cb) { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },
    emit(payload) { for (const cb of listeners.slice()) cb(payload); },
  };
  if (opts.profiles) {
    api.listProfiles = async () => ({ ok: true, profiles: opts.profiles, defaultId: opts.defaultId || '' });
  }
  return api;
}

function fakeContextMenu() {
  const shown = [];
  return { shown, show(o) { shown.push(o); }, hide() {} };
}

function harness(opts = {}) {
  const views = opts.views ? opts.views.slice() : ['terminal'];
  const api = fakeApi(opts);
  const contextMenu = fakeContextMenu();
  const ide = opts.ide || {};
  const calls = { added: [], removed: [], revealed: [], created: [], kills: [], commands: [], starts: [], prefs: [], renders: 0 };
  const panels = new Map();
  const ptyTerminalPanelUtils = {
    createIdePtyTerminalPanel(deps) {
      const slot = deps.slot;
      const state = { sessionId: '', disposed: false, stopped: 0, focused: 0, rendered: 0, bound: 0 };
      const panel = {
        deps,
        state,
        getSessionId: () => state.sessionId,
        getSlot: () => slot,
        isRunning: () => Boolean(state.sessionId),
        async startSession(startOpts) {
          calls.starts.push({ slot, opts: startOpts });
          if (opts.startFails) return false;
          state.sessionId = `sess-${slot}`;
          deps.onSessionChange(state.sessionId);
          return true;
        },
        async sendCommand(builder) {
          if (!state.sessionId) await panel.startSession();
          calls.commands.push({ slot, command: typeof builder === 'function' ? builder('sh', '/w') : builder });
          return true;
        },
        async stopSession() { calls.kills.push({ slot, sessionId: state.sessionId }); state.sessionId = ''; state.stopped += 1; return true; },
        dispose() { if (state.sessionId) calls.kills.push({ slot, sessionId: state.sessionId }); state.sessionId = ''; state.disposed = true; },
        focusTerminal() { state.focused += 1; return true; },
        renderTerminalPanel() { state.rendered += 1; },
        bindEvents() { state.bound += 1; },
      };
      calls.created.push(slot);
      panels.set(slot, panel);
      return panel;
    },
  };
  const set = createIdeTerminalSet({
    ptyTerminalPanelUtils,
    baseDeps: { getWorkspacePtyApi: () => api, marker: 'base', getIde: () => ide, getDom: () => ({ ideWorkbench: opts.workbenchEl || null }) },
    viewDeps: (viewId) => ({ getMountEl: () => null, isActivePanel: () => true, viewId }),
    listTerminalViews: () => views.slice(),
    addTerminalView: (id, near, fallback) => { calls.added.push(id); if (near || fallback) calls.near = { near, fallback }; views.push(id); },
    removeTerminalView: (id) => { calls.removed.push(id); views.splice(views.indexOf(id), 1); },
    revealView: (id, o) => calls.revealed.push({ id, focus: Boolean(o && o.focus) }),
    model,
    maxTerminals: opts.maxTerminals,
    contextMenu,
    actionIcons: { add: '<svg data-i="add"></svg>', trash: '<svg data-i="trash"></svg>', chevron: '<svg data-i="chevron"></svg>' },
    commitPreference: async (key, value) => { calls.prefs.push({ key, value }); ide[key] = value; return { updated: true }; },
    requestRender: () => { calls.renders += 1; },
  });
  return { set, api, calls, panels, views, contextMenu, ide };
}

const PROFILES = [
  { id: 'pwsh', label: 'PowerShell' },
  { id: 'powershell', label: 'Windows PowerShell' },
  { id: 'git-bash', label: 'Git Bash' },
];
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the New Terminal menu lists one row per detected profile, the default marked, then Select Default Profile', async () => {
  const h = harness({ profiles: PROFILES, defaultId: 'powershell' });
  h.set.sync();
  const anchor = { id: 'anchor' };
  assert.equal(await h.set.openProfileMenu({ anchorEl: anchor, near: 'terminal' }), true);
  assert.equal(h.contextMenu.shown.length, 1);
  const menu = h.contextMenu.shown[0];
  assert.equal(menu.anchorEl, anchor);
  const rows = menu.items.filter((item) => !item.separator);
  assert.deepEqual(rows.map((item) => item.label), ['PowerShell', 'Windows PowerShell', 'Git Bash', 'Select Default Profile...']);
  assert.deepEqual(rows.slice(0, 3).map((item) => item.description || ''), ['', 'Default', ''], 'the platform default is marked');

  rows[2].action();
  await flushAsync();
  assert.deepEqual(h.calls.added, ['terminal-2']);
  assert.deepEqual(h.calls.starts, [{ slot: 2, opts: { cwd: '', profileId: 'git-bash' } }], 'the picked shell starts on the user\'s click');
});

test('a stored default is the marked row, and Select Default Profile writes the pref (Automatic clears it)', async () => {
  const h = harness({ profiles: PROFILES, defaultId: 'powershell', ide: { terminalDefaultProfile: 'git-bash' } });
  h.set.sync();
  const anchor = { id: 'anchor' };
  await h.set.openProfileMenu({ anchorEl: anchor });
  const launch = h.contextMenu.shown[0].items;
  assert.deepEqual(launch.filter((i) => !i.separator).slice(0, 3).map((i) => i.description || ''), ['', '', 'Default']);
  assert.equal(h.calls.starts.length, 0, 'opening the menu starts nothing');

  launch[launch.length - 1].action(); // Select Default Profile...
  await flushAsync();
  const picker = h.contextMenu.shown[1];
  assert.equal(picker.focusChecked, true);
  assert.deepEqual(picker.items.map((i) => [i.label, i.checked]), [
    ['Automatic (Windows PowerShell)', false], ['PowerShell', false], ['Windows PowerShell', false], ['Git Bash', true],
  ]);
  picker.items[1].action();
  picker.items[0].action();
  await flushAsync();
  assert.deepEqual(h.calls.prefs, [{ key: 'terminalDefaultProfile', value: 'pwsh' }, { key: 'terminalDefaultProfile', value: '' }]);
  assert.equal(h.calls.starts.length, 0, 'choosing a default starts nothing');
});

test('listProfiles replies are validated: bad ids, duplicates and a failed call never reach the menu', async () => {
  const h = harness({ profiles: [{ id: 'pwsh', label: 'PowerShell' }, { id: 'C:\\x.exe', label: 'evil' }, { id: 'pwsh', label: 'dup' }] });
  h.set.sync();
  await h.set.openProfileMenu({ anchorEl: {} });
  assert.deepEqual(h.contextMenu.shown[0].items.filter((i) => !i.separator).map((i) => i.label), ['PowerShell', 'Select Default Profile...']);
  h.api.listProfiles = async () => { throw new Error('bridge down'); };
  await h.set.openProfileMenu({ anchorEl: {} });
  const rows = h.contextMenu.shown[1].items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].disabled, true, 'a failed listing shows one disabled row');
});

test('header actions: + and the profile chevron while a slot is free, Kill always; no chevron without the bridge', () => {
  const h = harness({ profiles: PROFILES, views: ['terminal'] });
  h.set.sync();
  assert.deepEqual(h.set.viewActions('terminal').map((a) => a.name), ['new-terminal', 'new-terminal-profile', 'kill-terminal']);
  assert.deepEqual(h.set.viewActions('explorer'), [], 'a non-terminal view has none');
  h.set.runViewAction('terminal', 'new-terminal');
  assert.deepEqual(h.calls.near, { near: undefined, fallback: 'terminal' }, 'the + remembers its terminal as the neighbour');
  h.set.newTerminal();
  h.set.newTerminal();
  assert.deepEqual(h.set.viewActions('terminal').map((a) => a.name), ['kill-terminal'], 'at the cap only Kill stays');

  const hosted = harness({ views: ['terminal'] }); // no listProfiles: fail closed
  hosted.set.sync();
  assert.deepEqual(hosted.set.viewActions('terminal').map((a) => a.name), ['new-terminal', 'kill-terminal']);
  assert.equal(hosted.set.profilesAvailable(), false);
});

test('without the listProfiles bridge the profile menus refuse', async () => {
  const h = harness();
  h.set.sync();
  assert.equal(await h.set.openProfileMenu({ anchorEl: {} }), false);
  assert.equal(await h.set.openDefaultProfileMenu({ anchorEl: {} }), false);
  assert.equal(h.contextMenu.shown.length, 0);
});

test('setLabel names a terminal for the session; empty restores the default and the name goes with the view', () => {
  const h = harness({ views: ['terminal'] });
  h.set.sync();
  const extra = h.set.newTerminal();
  assert.equal(h.set.setLabel(extra, '  build   watch  '), true);
  assert.equal(h.set.labelOf(extra), 'build watch');
  assert.equal(h.calls.renders, 1, 'the chrome re-renders');
  assert.equal(h.set.setLabel(extra, 'x'.repeat(100)), true);
  assert.equal(h.set.labelOf(extra).length, 64, 'names are capped');
  h.set.setLabel(extra, '   ');
  assert.equal(h.set.labelOf(extra), '');
  h.set.setLabel(extra, 'server');
  h.set.closeTerminal(extra);
  assert.equal(h.set.labelOf(extra), '', 'a closed terminal forgets its name');
  assert.equal(h.set.setLabel('terminal-4', 'nope'), false, 'an unknown view is refused');
  assert.deepEqual(h.set.menuItems('terminal').map((i) => i.label || 'sep'), ['sep', 'Rename Terminal...']);
});

test('renameTerminal edits the tab inline: Enter keeps the name, an emptied field restores the default, Escape cancels', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="wb"><section data-wb-stack="s1"><header><div class="wb-tabs"><button data-wb-tab="terminal"><span class="wb-tab-label">Terminal</span></button></div></header></section></div>');
  try {
    const workbenchEl = dom.window.document.getElementById('wb');
    const h = harness({ views: ['terminal'], workbenchEl });
    h.set.sync();
    const key = (input, k) => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
    assert.equal(h.set.renameTerminal('terminal'), true);
    let input = workbenchEl.querySelector('input');
    assert.equal(input.value, 'Terminal');
    input.value = 'api server';
    key(input, 'Enter');
    assert.equal(h.set.labelOf('terminal'), 'api server');
    assert.equal(workbenchEl.querySelector('input'), null);

    h.set.renameTerminal('terminal');
    input = workbenchEl.querySelector('input');
    input.value = 'ignored';
    key(input, 'Escape');
    assert.equal(h.set.labelOf('terminal'), 'api server', 'Escape keeps the old name');

    h.set.renameTerminal('terminal');
    input = workbenchEl.querySelector('input');
    input.value = '';
    key(input, 'Enter');
    assert.equal(h.set.labelOf('terminal'), '', 'an emptied name restores the default');

    h.set.bindEvents();
    workbenchEl.querySelector('[data-wb-tab]').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
    assert.ok(workbenchEl.querySelector('input'), 'double-click on the tab starts the rename');
    h.set.dispose();
  } finally {
    dom.window.close();
  }
});

test('clicking or focusing a terminal tab makes it the active terminal (palette Kill/Find/Rename target)', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="wb"><button data-wb-tab="terminal">Terminal</button><button data-wb-tab="terminal-2">Terminal 2</button><button data-wb-tab="explorer">Files</button></div>');
  try {
    const workbenchEl = dom.window.document.getElementById('wb');
    const h = harness({ views: ['terminal'], workbenchEl });
    h.set.sync();
    assert.equal(h.set.newTerminal(), 'terminal-2');
    h.set.bindEvents();
    assert.equal(h.set.activeViewId(), 'terminal-2');
    const tab = (id) => workbenchEl.querySelector(`[data-wb-tab="${id}"]`);
    tab('terminal').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(h.set.activeViewId(), 'terminal', 'a click on a not-started terminal\'s tab makes it active');
    tab('terminal-2').dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
    assert.equal(h.set.activeViewId(), 'terminal-2', 'arrow-key tab focus does too');
    tab('explorer').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(h.set.activeViewId(), 'terminal-2', 'a non-terminal tab changes nothing');
    h.set.dispose();
    tab('terminal').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  } finally {
    dom.window.close();
  }
});

test('sync creates a slotted panel per listed view and disposes panels that left the layout', () => {
  const h = harness({ views: ['terminal', 'terminal-3'] });
  h.set.sync();
  assert.deepEqual(h.calls.created, [1, 3]);
  assert.equal(h.set.panelFor('terminal').deps.marker, 'base', 'base deps pass through');
  assert.equal(h.set.panelFor('terminal-3').deps.viewId, 'terminal-3', 'per-view deps are merged in');
  assert.equal(h.set.count(), 2);
  h.set.sync();
  assert.deepEqual(h.calls.created, [1, 3], 'sync is idempotent');

  h.panels.get(3).state.sessionId = 'sess-3';
  h.views.splice(h.views.indexOf('terminal-3'), 1);
  h.set.sync();
  assert.equal(h.set.panelFor('terminal-3'), null);
  assert.equal(h.panels.get(3).state.disposed, true);
  assert.deepEqual(h.calls.kills, [{ slot: 3, sessionId: 'sess-3' }], 'its own session is killed by id');
});

test('newTerminal picks the lowest free slot, reveals it, and caps at four', () => {
  const h = harness({ views: ['terminal', 'terminal-3'] });
  assert.equal(h.set.canAdd(), true);
  assert.equal(h.set.newTerminal(), 'terminal-2');
  assert.deepEqual(h.calls.added, ['terminal-2']);
  assert.deepEqual(h.calls.revealed, [{ id: 'terminal-2', focus: true }]);
  assert.ok(h.set.panelFor('terminal-2'), 'its panel exists straight away');
  assert.equal(h.set.newTerminal(), 'terminal-4');
  assert.equal(h.set.count(), 4);
  assert.equal(h.set.canAdd(), false);
  assert.equal(h.set.newTerminal(), null);
  assert.equal(h.calls.added.length, 2, 'nothing added at the cap');
});

test('newTerminal starts the session only when asked to', async () => {
  const h = harness();
  const id = h.set.newTerminal();
  assert.equal(h.set.panelFor(id).getSessionId(), '');
  const h2 = harness();
  const id2 = h2.set.newTerminal({ start: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h2.set.panelFor(id2).getSessionId(), 'sess-2');
});

test('closeTerminal: slot 1 stays and stops, slots 2+ leave the layout', async () => {
  const h = harness();
  h.set.sync();
  const extra = h.set.newTerminal();
  await h.set.panelFor('terminal').startSession();
  await h.set.panelFor(extra).startSession();

  assert.equal(h.set.closeTerminal('terminal'), true);
  assert.ok(h.set.panelFor('terminal'), 'slot 1 stays in the set');
  assert.equal(h.panels.get(1).state.stopped, 1);
  assert.deepEqual(h.calls.removed, []);

  assert.equal(h.set.closeTerminal(extra), true);
  await new Promise((resolve) => setTimeout(resolve, 0)); // removal waits for the confirmed stop
  assert.deepEqual(h.calls.removed, [extra]);
  assert.equal(h.set.panelFor(extra), null);
  assert.deepEqual(h.calls.kills.map((k) => k.sessionId), ['sess-1', 'sess-2']);
  assert.equal(h.set.closeTerminal('terminal-4'), false, 'an unknown view is a no-op');
  assert.equal(h.set.newTerminal(), 'terminal-2', 'the freed slot is reusable');
});

test('sendCommand defaults to slot 1 and honours an explicit view', async () => {
  const h = harness();
  h.set.sync();
  const extra = h.set.newTerminal();
  h.set.focusTerminal(extra); // last-used is slot 2, but a bare sendCommand still means slot 1
  assert.equal(await h.set.sendCommand('one'), true);
  assert.equal(await h.set.sendCommand('two', extra), true);
  assert.deepEqual(h.calls.commands, [{ slot: 1, command: 'one' }, { slot: 2, command: 'two' }]);
  assert.equal(await h.set.sendCommand('x', 'terminal-4'), false, 'a view with no panel refuses');
});

test('focusTerminal targets the given view, else the last used one, else slot 1', () => {
  const h = harness();
  h.set.sync();
  assert.equal(h.set.focusTerminal(), true);
  assert.equal(h.panels.get(1).state.focused, 1, 'falls back to slot 1');
  const extra = h.set.newTerminal();
  h.set.focusTerminal(extra);
  assert.equal(h.panels.get(2).state.focused, 1);
  h.set.focusTerminal();
  assert.equal(h.panels.get(2).state.focused, 2, 'the last used terminal gets the id-less focus');
  assert.equal(h.set.focusTerminal('terminal-4'), false);
  h.set.closeTerminal(extra);
  h.set.focusTerminal();
  assert.equal(h.panels.get(1).state.focused, 2, 'back to slot 1 once the last used one is gone');
});

test('renderAll and bindEvents loop every panel', () => {
  const h = harness({ views: ['terminal', 'terminal-2'] });
  h.set.renderAll();
  h.set.bindEvents();
  for (const slot of [1, 2]) {
    assert.equal(h.panels.get(slot).state.rendered, 1);
    assert.equal(h.panels.get(slot).state.bound, 1);
  }
});

test('openTaskTerminal opens a new terminal, resolves once live, and filters onData by session', async () => {
  const h = harness();
  h.set.sync();
  const task = await h.set.openTaskTerminal();
  assert.equal(task.viewId, 'terminal-2');
  assert.equal(task.getSessionId(), 'sess-2');
  assert.equal(h.panels.get(1).getSessionId(), '', 'the user terminal is untouched');

  const seen = [];
  const off = task.onData((p) => seen.push(p.data));
  h.api.emit({ sessionId: 'sess-1', data: 'user shell' });
  h.api.emit({ sessionId: 'sess-2', data: 'banner' });
  assert.deepEqual(seen, ['banner']);
  off();
  h.api.emit({ sessionId: 'sess-2', data: 'late' });
  assert.deepEqual(seen, ['banner'], 'unsubscribe stops delivery');
  assert.equal(h.api.listeners.length, 0);

  assert.equal(await task.sendCommand((shell) => `echo ${shell}`), true);
  assert.deepEqual(h.calls.commands, [{ slot: 2, command: 'echo sh' }]);
});

test('openTaskTerminal at the cap reuses an idle slot 1, else resolves null', async () => {
  const h = harness({ views: ['terminal', 'terminal-2', 'terminal-3', 'terminal-4'] });
  h.set.sync();
  const task = await h.set.openTaskTerminal();
  assert.equal(task.viewId, 'terminal', 'slot 1 is idle, so it is used');
  assert.equal(task.getSessionId(), 'sess-1');
  assert.equal(await h.set.openTaskTerminal(), null, 'slot 1 is now live and nothing is free');
  assert.equal(h.calls.added.length, 0);
});

test('openTaskTerminal resolves false (not null) when the session cannot start', async () => {
  const h = harness({ startFails: true });
  h.set.sync();
  assert.equal(await h.set.openTaskTerminal(), false, 'the caller can tell a failed start from no free terminal');
});

test('openTaskTerminal reuses its own idle task terminal before taking a new slot', async () => {
  const h = harness();
  h.set.sync();
  const first = await h.set.openTaskTerminal();
  assert.equal(first.viewId, 'terminal-2');
  h.set.panelFor('terminal-2').state.sessionId = ''; // the debug session ended
  const second = await h.set.openTaskTerminal();
  assert.equal(second.viewId, 'terminal-2', 'the idle task terminal is reused');
  assert.deepEqual(h.calls.added, ['terminal-2'], 'no second terminal was added');
  const third = await h.set.openTaskTerminal();
  assert.equal(third.viewId, 'terminal-3', 'a busy one is not');
});

test('dispose kills every session by id and the set goes inert', async () => {
  const h = harness({ views: ['terminal', 'terminal-2'] });
  h.set.sync();
  await h.set.panelFor('terminal').startSession();
  await h.set.panelFor('terminal-2').startSession();
  h.set.dispose();
  assert.deepEqual(h.calls.kills.map((k) => k.sessionId).sort(), ['sess-1', 'sess-2']);
  assert.equal(h.set.panelFor('terminal'), null);
  h.set.sync();
  assert.equal(h.set.panelFor('terminal'), null, 'sync after dispose creates nothing');
  assert.equal(h.set.newTerminal(), null);
  assert.equal(await h.set.openTaskTerminal(), null);
});

test('closeTerminal keeps a slot 2+ terminal in the layout when its stop is unconfirmed', async () => {
  const h = harness();
  h.set.sync();
  const extra = h.set.newTerminal();
  await h.set.panelFor(extra).startSession();
  const panel = h.set.panelFor(extra);
  panel.stopSession = async () => false; // main could not confirm the shell died
  assert.equal(h.set.closeTerminal(extra), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.calls.removed, [], 'the view stays so its "stop unconfirmed" state is visible');
  assert.equal(h.set.panelFor(extra), panel);
  panel.stopSession = async () => true;
  h.set.closeTerminal(extra);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.calls.removed, [extra], 'a confirmed retry closes it');
});

test('T12: a workbench re-render mid-rename keeps the field and its text', () => {
  const { JSDOM } = require('jsdom');
  const markup = '<section data-wb-stack="s1"><header><div class="wb-tabs"><button data-wb-tab="terminal"><span class="wb-tab-label">Terminal</span></button></div></header></section>';
  const dom = new JSDOM(`<div id="wb">${markup}</div>`);
  try {
    const workbenchEl = dom.window.document.getElementById('wb');
    const h = harness({ views: ['terminal'], workbenchEl });
    h.set.sync();
    assert.equal(h.set.renameTerminal('terminal'), true);
    const first = workbenchEl.querySelector('input');
    first.value = 'api se';
    first.setSelectionRange(3, 3);
    workbenchEl.innerHTML = markup; // the header re-renders (a session change, a layout pass)
    first.dispatchEvent(new dom.window.Event('blur')); // a detached field may still blur
    assert.equal(h.set.labelOf('terminal'), '', 'a re-render is not a commit');
    h.set.bindEvents(); // the controller rebinds after every workbench render
    const input = workbenchEl.querySelector('input');
    assert.ok(input && input !== first, 'the name field is back on the new tab');
    assert.equal(input.value, 'api se');
    assert.equal(input.selectionStart, 3);
    assert.equal(dom.window.document.activeElement, input, 'and keeps focus');
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(h.set.labelOf('terminal'), 'api se');
    h.set.bindEvents();
    assert.equal(workbenchEl.querySelector('input'), null, 'a finished rename does not come back');
    h.set.dispose();
  } finally {
    dom.window.close();
  }
});

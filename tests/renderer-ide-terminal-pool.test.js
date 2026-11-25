'use strict';

// new-test-file: the terminal pool seam (row 178) is a new surface; it composes the real terminal set and PTY panel.
/* Terminal pool (row 178 slice A): the real set + real PTY panels over a fake pty
 * bridge, a fake xterm per slot and a real layout model, so the seam is exercised
 * end to end: list, create without revealing, close, host in a chat element and
 * back, the IDE placeholder, subscribe coalescing and the root reset. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeTerminalSet } = require('../renderer/features/renderer-ide-terminal-set');
const { createIdePtyTerminalPanel } = require('../renderer/features/renderer-ide-pty-terminal-panel');
const { createIdeTerminalPool } = require('../renderer/features/renderer-ide-terminal-pool');
const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeTerm() {
  return {
    cols: 80, rows: 24, element: null, written: [], cleared: 0, disposed: 0, selection: '', focused: 0, options: {},
    // Like xterm 6: the first open() builds the element in `el`; a second open() is a no-op (the host moves `element`).
    open(el) { if (this.element) return; this.element = el.ownerDocument.createElement('div'); el.appendChild(this.element); },
    get opened() { return this.element ? this.element.parentNode : null; },
    write(data) { this.written.push(data); },
    writeln() {},
    clear() { this.cleared += 1; },
    reset() {},
    dispose() { this.disposed += 1; },
    loadAddon() {},
    onData() { return { dispose() {} }; },
    getSelection() { return this.selection; },
    focus() { this.focused += 1; },
  };
}

function fakeApi() {
  const dataListeners = [];
  const exitListeners = [];
  let n = 0;
  return {
    calls: { spawn: [], kill: [], resize: [] },
    failSpawn: false,
    profiles: [],
    async spawn(request) {
      this.calls.spawn.push(request);
      if (this.failSpawn) return { ok: false, code: 'CMP-TEST-0001', message: 'no shell' };
      n += 1;
      return { ok: true, sessionId: `pty-${request.slot}-${n}`, shell: 'pwsh', cwd: 'C:/ws', alreadyRunning: false };
    },
    async write() {},
    async resize(payload) { this.calls.resize.push(payload); return { ok: true }; },
    async kill(payload) { this.calls.kill.push(payload); return { ok: true, killed: true, terminationConfirmed: true }; },
    async listProfiles() { return { ok: true, profiles: this.profiles, defaultId: '' }; },
    onData(cb) { dataListeners.push(cb); return () => {}; },
    onExit(cb) { exitListeners.push(cb); return () => {}; },
    emitData(payload) { for (const cb of dataListeners.slice()) cb(payload); },
  };
}

function build(opts = {}) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const win = dom.window;
  const doc = win.document;
  const api = fakeApi();
  const terms = new Map(); // viewId -> fake xterm
  const hosts = new Map(); // viewId -> the IDE view's mount element
  const visible = new Set(); // views the IDE currently shows
  const logs = [];
  const reveals = [];
  const activeViews = [];
  let layout = model.createDefaultLayout();
  const wiring = {
    getLayout: () => layout,
    commitLayout: (next) => { layout = next; },
    listViews: () => model.listViews(layout),
    showPanel: (id, options) => { reveals.push({ id, options }); layout = model.revealView(layout, id); return true; },
  };
  const hostOf = (id) => {
    if (!hosts.has(id)) {
      const el = doc.createElement('div');
      doc.body.appendChild(el);
      hosts.set(id, el);
    }
    return hosts.get(id);
  };
  let fakeRevealCalls = 0;
  const set = createIdeTerminalSet({
    ptyTerminalPanelUtils: { createIdePtyTerminalPanel },
    model,
    baseDeps: {
      getWorkspacePtyApi: () => (opts.noApi ? null : api),
      getIde: () => ({}),
      getDom: () => ({}),
      windowRef: win,
      appendClientLog: (level, code, data) => logs.push({ level, code, data }),
      showError: () => {},
      getWorkspaceRootPath: () => '/ws',
    },
    viewDeps: (id) => ({
      getMountEl: () => hostOf(id),
      isActivePanel: () => visible.has(id),
      createTerminal: () => { const term = fakeTerm(); terms.set(id, term); return term; },
      createFitAddon: () => ({ fit() {} }),
    }),
    listTerminalViews: () => wiring.listViews(),
    addTerminalView: (id, near) => { layout = ops.addView(layout, id, near || 'terminal'); },
    removeTerminalView: (id) => { layout = ops.removeView(layout, id); hosts.delete(id); visible.delete(id); },
    revealView: (id, options) => { fakeRevealCalls += 1; wiring.showPanel(id, options); },
    requestRender: () => {},
  });
  const pool = createIdeTerminalPool({
    terminals: set,
    layoutModel: model,
    windowRef: win,
    appendClientLog: (level, code, data) => logs.push({ level, code, data }),
    getWiring: () => wiring,
    setActiveView: (view) => activeViews.push(view),
    getRootPath: () => '/ws',
    getApi: () => (opts.noApi ? null : api),
  });
  const chatEl = (name) => { const el = doc.createElement('div'); el.id = name; doc.body.appendChild(el); return el; };
  return {
    win, api, set, pool, terms, hosts, visible, logs, reveals, activeViews, chatEl, hostOf,
    layout: () => layout,
    layoutOpen: () => { layout = model.revealView(layout, 'terminal'); },
    revealCalls: () => fakeRevealCalls,
    showInIde: (id) => { visible.add(id); set.renderAll(); },
    events: () => { const seen = []; pool.subscribe((event) => seen.push(event.type)); return seen; },
  };
}

test('list() has one ordered entry per terminal view with the documented shape', async () => {
  const h = build();
  assert.deepEqual(h.pool.list(), [{ slot: 1, viewId: 'terminal', label: 'Terminal 1', running: false, starting: false, task: false, cwd: '', shell: '' }]);
  assert.equal(h.pool.maxTerminals, 4);
  assert.equal(h.pool.rootPath(), '/ws');
  assert.equal(await h.pool.start(1), true);
  assert.equal((await h.pool.create()).ok, true);
  const task = await h.set.openTaskTerminal();
  assert.ok(task && task.viewId);
  const list = h.pool.list();
  assert.deepEqual(list.map((entry) => entry.slot), [1, 2, 3]);
  assert.deepEqual(list.map((entry) => entry.task), [false, false, true], 'only the tool-opened terminal is a task terminal');
  assert.deepEqual(list.map((entry) => entry.running), [true, true, true]);
  assert.equal(list[0].cwd, 'C:/ws');
  assert.equal(list[0].shell, 'pwsh');
});

test('create() adds and starts a terminal without revealing or opening the IDE bottom panel', async () => {
  const h = build();
  const before = model.findView(h.layout(), 'terminal');
  assert.equal(before.collapsed, true, 'the default bottom panel is closed');
  const result = await h.pool.create({ profileId: 'git-bash' });
  assert.deepEqual(result, { ok: true, slot: 2 });
  assert.equal(h.revealCalls(), 0, 'revealView is never called');
  assert.equal(h.reveals.length, 0);
  const after = model.findView(h.layout(), 'terminal-2');
  assert.equal(after.collapsed, true, 'the bottom panel stays closed');
  assert.equal(model.findStack(h.layout(), after.stackId).active, 'terminal', 'the active bottom view is unchanged');
  assert.deepEqual(h.api.calls.spawn[0], { cols: 80, rows: 24, slot: 2, profileId: 'git-bash' });
  assert.equal(h.pool.list()[1].running, true);
});

test('create() keeps an open bottom panel on its active view and answers max_terminals at four', async () => {
  const h = build();
  h.showInIde('terminal');
  h.layoutOpen();
  await h.pool.create();
  await h.pool.create();
  await h.pool.create();
  const viewsBefore = model.listViews(h.layout()).length;
  const spawns = h.api.calls.spawn.length;
  assert.deepEqual(await h.pool.create(), { ok: false, reason: 'max_terminals' });
  const open = model.findView(h.layout(), 'terminal-2');
  assert.equal(open.collapsed, false, 'an open bottom panel stays open');
  assert.equal(model.findStack(h.layout(), open.stackId).active, 'terminal', 'and stays on its active view');
  assert.equal(model.listViews(h.layout()).length, viewsBefore, 'the layout is untouched at the cap');
  assert.equal(h.api.calls.spawn.length, spawns, 'nothing is spawned at the cap');
  assert.equal(h.pool.list().length, 4);
});

test('create() answers unavailable without a pty bridge and start_failed (removing the view) when the shell does not start', async () => {
  assert.deepEqual(await build({ noApi: true }).pool.create(), { ok: false, reason: 'unavailable' });
  const h = build();
  h.api.failSpawn = true;
  assert.deepEqual(await h.pool.create(), { ok: false, reason: 'start_failed' });
  assert.deepEqual(h.pool.list().map((entry) => entry.slot), [1], 'the failed terminal does not stay in the layout');
});

test('close() kills slot 1 but keeps it; slot 3 leaves the layout once its kill is confirmed', async () => {
  const h = build();
  await h.pool.start(1);
  await h.pool.create();
  await h.pool.create();
  assert.equal(await h.pool.close(1), true);
  assert.equal(h.pool.list()[0].running, false);
  assert.equal(h.pool.list().length, 3, 'slot 1 stays in the list');
  assert.equal(await h.pool.close(3), true);
  assert.deepEqual(h.pool.list().map((entry) => entry.slot), [1, 2]);
  assert.ok(h.api.calls.kill.length >= 2, 'both shells were killed by session id');
  assert.ok(h.api.calls.kill.every((call) => call.sessionId), 'never an id-less kill');
});

test('host() moves the live xterm into the chat element and the IDE view shows the placeholder with Show here', async () => {
  const h = build();
  h.set.bindEvents();
  await h.pool.start(1);
  h.showInIde('terminal');
  const term = h.terms.get('terminal');
  assert.equal(term.opened, h.hostOf('terminal').querySelector('[data-ide-pty-mount]'));
  const el = h.chatEl('chat-host');
  assert.equal(h.pool.host(1, el), true);
  assert.equal(term.opened, el, 'the xterm element now lives in the chat element');
  assert.equal(h.pool.hostedSlot(), 1);
  const ide = h.hostOf('terminal');
  assert.match(ide.textContent, /Terminal 1 is open in the chat\./);
  assert.ok(ide.querySelector('[data-ide-terminal-action="show-here"]'));
  assert.equal(ide.querySelector('[data-ide-pty-mount]'), null, 'no xterm markup while hosted outside');
  h.api.emitData({ sessionId: h.pool.list()[0].running ? 'pty-1-1' : '', data: 'while-hosted' });
  assert.ok(term.written.includes('while-hosted'), 'output keeps landing in the same xterm');
});

test('a terminal started while hosted gets its xterm created in the chat host', async () => {
  const h = build();
  const el = h.chatEl('chat-host');
  assert.equal(h.pool.host(1, el), true, 'a stopped terminal can be hosted');
  assert.equal(h.pool.hostedSlot(), 1);
  await h.pool.start(1);
  assert.equal(h.terms.get('terminal').opened, el);
});

test('hosting slot 2 releases slot 1', async () => {
  const h = build();
  h.set.bindEvents();
  await h.pool.start(1);
  await h.pool.create();
  h.showInIde('terminal');
  const elA = h.chatEl('a');
  const elB = h.chatEl('b');
  h.pool.host(1, elA);
  assert.match(h.hostOf('terminal').textContent, /open in the chat/);
  h.pool.host(2, elB);
  assert.equal(h.pool.hostedSlot(), 2);
  assert.doesNotMatch(h.hostOf('terminal').textContent, /open in the chat/, 'slot 1 is back in the IDE');
  assert.equal(h.terms.get('terminal').opened, h.hostOf('terminal').querySelector('[data-ide-pty-mount]'));
  assert.equal(h.terms.get('terminal-2').opened, elB);
});

test('hosting slot 2 in the element slot 1 holds leaves one terminal there while the IDE view is hidden', async () => {
  const h = build();
  await h.pool.start(1);
  await h.pool.create();
  const el = h.chatEl('chat-host');
  assert.equal(h.pool.host(1, el), true);
  assert.equal(h.pool.host(2, el), true);
  assert.equal(el.children.length, 1, 'the chat element holds exactly one terminal screen');
  assert.equal(h.terms.get('terminal-2').element.parentNode, el);
  assert.equal(h.terms.get('terminal').element.parentNode, null, 'slot 1 is detached, not stacked under slot 2');
  h.showInIde('terminal');
  assert.equal(h.terms.get('terminal').opened, h.hostOf('terminal').querySelector('[data-ide-pty-mount]'), 'slot 1 re-attaches to its own mount when the IDE renders');
  assert.equal(el.children.length, 1);
  assert.equal(h.terms.get('terminal').disposed, 0, 'nothing was restarted');
});

test('release() re-attaches the xterm to the IDE mount on the next render and is a no-op when nothing is hosted', async () => {
  const h = build();
  await h.pool.start(1);
  h.showInIde('terminal');
  h.pool.release(); // nothing hosted: no throw
  const el = h.chatEl('chat-host');
  h.pool.host(1, el);
  h.pool.release();
  assert.equal(h.pool.hostedSlot(), 0);
  h.set.renderAll();
  const ide = h.hostOf('terminal');
  assert.equal(h.terms.get('terminal').opened, ide.querySelector('[data-ide-pty-mount]'));
  assert.doesNotMatch(ide.textContent, /open in the chat/);
});

test('release() while the IDE view is hidden re-attaches when it is shown again', async () => {
  const h = build();
  await h.pool.start(1);
  const el = h.chatEl('chat-host');
  h.pool.host(1, el);
  h.pool.release();
  assert.equal(h.terms.get('terminal').opened, null, 'out of the chat element at once, waiting for the IDE to render');
  h.showInIde('terminal');
  assert.equal(h.terms.get('terminal').opened, h.hostOf('terminal').querySelector('[data-ide-pty-mount]'));
});

test('the Show here button releases the terminal and tells subscribers', async () => {
  const h = build();
  h.set.bindEvents();
  await h.pool.start(1);
  h.showInIde('terminal');
  h.pool.host(1, h.chatEl('chat-host'));
  await flush();
  const seen = h.events();
  h.hostOf('terminal').querySelector('[data-ide-terminal-action="show-here"]').click();
  await flush();
  assert.equal(h.pool.hostedSlot(), 0);
  assert.deepEqual(seen, ['changed']);
  assert.ok(h.hostOf('terminal').querySelector('[data-ide-pty-mount]'), 'the xterm markup is back');
});

test('showInWorkspace() releases, switches to the Workspace view and reveals that terminal', async () => {
  const h = build();
  await h.pool.start(1);
  await h.pool.create();
  h.pool.host(2, h.chatEl('chat-host'));
  assert.equal(h.pool.showInWorkspace(2), true);
  assert.equal(h.pool.hostedSlot(), 0);
  assert.deepEqual(h.activeViews, ['ide']);
  assert.equal(h.reveals.at(-1).id, 'terminal-2');
  assert.equal(h.pool.showInWorkspace(4), false, 'a missing slot reveals nothing');
});

test('subscribe() coalesces a burst into one changed event and unsubscribes', async () => {
  const h = build();
  await h.pool.start(1);
  await flush();
  const seen = h.events();
  h.pool.rename(1, 'one');
  h.pool.rename(1, 'two');
  await flush();
  assert.deepEqual(seen, ['changed'], 'one event for the whole burst');
  assert.equal(h.pool.list()[0].label, 'two');
  h.pool.rename(1, '');
  assert.equal(h.pool.list()[0].label, 'Terminal 1', 'an empty name restores the default');
  await flush();
  assert.deepEqual(seen, ['changed', 'changed']);
  const stop = h.pool.subscribe(() => { throw new Error('listener bug'); });
  h.pool.rename(1, 'x');
  await flush();
  assert.ok(h.logs.some((entry) => entry.level === 'DEBUG' && /terminal_pool/.test(entry.code)), 'a listener error is logged, not thrown');
  stop();
});

test('root_reset fires after the workspace root switched and every terminal was killed', async () => {
  const h = build();
  await h.pool.start(1);
  await h.pool.create();
  const seen = h.events();
  h.win.dispatchEvent(new h.win.CustomEvent('ide:workspace-root-committed', { detail: {} }));
  assert.deepEqual(h.pool.list().map((entry) => entry.running), [false, false], 'the panels have reset by the time subscribers hear');
  await flush();
  assert.ok(seen.includes('root_reset'));
});

test('getSelection(), focus() and clear() reach the slot xterm', async () => {
  const h = build();
  await h.pool.start(1);
  h.terms.get('terminal').selection = 'picked text';
  assert.equal(h.pool.getSelection(1), 'picked text');
  h.pool.focus(1);
  assert.equal(h.pool.clear(1), true);
  assert.equal(h.terms.get('terminal').cleared >= 1, true);
});

test('listProfiles() returns the validated shells, and [] without the bridge', async () => {
  const h = build();
  h.api.profiles = [{ id: 'pwsh', label: 'PowerShell' }, { id: 'C:\\evil.exe', label: 'bad' }, { id: 'pwsh', label: 'dup' }];
  assert.deepEqual(await h.pool.listProfiles(), [{ id: 'pwsh', label: 'PowerShell' }]);
  assert.deepEqual(await build({ noApi: true }).pool.listProfiles(), []);
});

test('a slot that does not exist is a safe no-op everywhere', async () => {
  const h = build();
  const el = h.chatEl('chat-host');
  assert.equal(h.pool.host(4, el), false);
  assert.equal(h.pool.host(0, el), false);
  assert.equal(h.pool.host(1, null), false);
  assert.equal(await h.pool.start(4), false);
  assert.equal(await h.pool.close(4), false);
  assert.equal(h.pool.rename(4, 'x'), false);
  assert.equal(h.pool.clear(4), false);
  assert.equal(h.pool.getSelection(4), '');
  assert.equal(h.pool.getSelection(NaN), '');
  assert.doesNotThrow(() => { h.pool.focus(4); h.pool.refit(); h.pool.release(); });
  assert.equal(h.pool.showInWorkspace(4), false);
  assert.equal(h.pool.hostedSlot(), 0);
});

test('refit() re-fits the hosted terminal and the pty follows the new size', async () => {
  const h = build();
  await h.pool.start(1);
  const el = h.chatEl('chat-host');
  h.pool.host(1, el);
  const term = h.terms.get('terminal');
  term.cols = 120;
  term.rows = 30;
  Object.defineProperty(el, 'clientWidth', { value: 900, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
  h.pool.refit();
  assert.deepEqual(h.api.calls.resize.at(-1), { sessionId: 'pty-1-1', cols: 120, rows: 30 });
});

test('dispose() gives the hosted terminal back and stops answering', async () => {
  const h = build();
  await h.pool.start(1);
  h.pool.host(1, h.chatEl('chat-host'));
  const seen = h.events();
  h.pool.dispose();
  assert.equal(h.pool.hostedSlot(), 0);
  h.win.dispatchEvent(new h.win.CustomEvent('ide:workspace-root-committed', { detail: {} }));
  await flush();
  assert.deepEqual(seen, [], 'no events after dispose');
  assert.deepEqual(h.pool.list(), []);
  assert.deepEqual(await h.pool.create(), { ok: false, reason: 'unavailable' });
});

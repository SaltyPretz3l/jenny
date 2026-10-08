'use strict';

/* Terminal set (row 40 W4): one PTY panel per terminal view, slots 1..4. The
 * panel factory and the layout hooks are fakes; the real layout model supplies
 * terminalSlot/terminalViewId. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTerminalSet } = require('../renderer/features/renderer-ide-terminal-set');
const model = require('../renderer/shared/workbench-layout-model');

function fakeApi() {
  const listeners = [];
  return {
    listeners,
    onData(cb) { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },
    emit(payload) { for (const cb of listeners.slice()) cb(payload); },
  };
}

function harness(opts = {}) {
  const views = opts.views ? opts.views.slice() : ['terminal'];
  const api = fakeApi();
  const calls = { added: [], removed: [], revealed: [], created: [], kills: [], commands: [] };
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
        async startSession() {
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
        stopSession() { calls.kills.push({ slot, sessionId: state.sessionId }); state.sessionId = ''; state.stopped += 1; },
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
    baseDeps: { getWorkspacePtyApi: () => api, marker: 'base' },
    viewDeps: (viewId) => ({ getMountEl: () => null, isActivePanel: () => true, viewId }),
    listTerminalViews: () => views.slice(),
    addTerminalView: (id) => { calls.added.push(id); views.push(id); },
    removeTerminalView: (id) => { calls.removed.push(id); views.splice(views.indexOf(id), 1); },
    revealView: (id, o) => calls.revealed.push({ id, focus: Boolean(o && o.focus) }),
    model,
    maxTerminals: opts.maxTerminals,
  });
  return { set, api, calls, panels, views };
}

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

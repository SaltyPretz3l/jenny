'use strict';

/* Multi-terminal (row 40 W4): a panel owns one slot and one session id. The slot
 * rides every spawn, write/resize/kill carry the panel's own session id, events
 * for other sessions or slots are ignored, and onSessionChange follows the
 * session's life. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers/renderer-ide-harness');
const { fakeTerminal, fakeFit, fakePtyApi } = require('./helpers/pty-terminal-panel-fixture');
const { createIdePtyTerminalPanel } = require('../renderer/features/renderer-ide-pty-terminal-panel');

function build(harness, extra = {}) {
  const win = harness.dom.window;
  const mount = win.document.createElement('div');
  win.document.body.appendChild(mount);
  const term = fakeTerminal();
  const api = extra.api || fakePtyApi({ ok: true, sessionId: 'pty-2', shell: 'pwsh', cwd: 'C:/ws', slot: 2 });
  const sessions = [];
  const panel = createIdePtyTerminalPanel({
    getDom: () => ({}),
    getIde: () => ({}),
    getMountEl: () => mount,
    isActivePanel: () => true,
    getWorkspacePtyApi: () => api,
    createTerminal: () => term,
    createFitAddon: () => fakeFit(),
    windowRef: win,
    onSessionChange: (id) => sessions.push(id),
    ...extra.deps,
  });
  return { panel, term, api, sessions, mount };
}

test('slot defaults to 1 and is sent in every spawn payload', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const first = build(harness, { deps: { slot: undefined } });
  assert.equal(first.panel.getSlot(), 1);
  await first.panel.startSession();
  assert.deepEqual(first.api.calls.spawn[0], { cols: 80, rows: 24, slot: 1 });

  const third = build(harness, { deps: { slot: 3 } });
  assert.equal(third.panel.getSlot(), 3);
  await third.panel.startSession();
  assert.equal(third.api.calls.spawn[0].slot, 3);
  const bogus = build(harness, { deps: { slot: 9 } });
  assert.equal(bogus.panel.getSlot(), 1, 'an out-of-range slot falls back to 1');
});

test('getSessionId follows the session; write, resize and kill carry the own session id', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, term, api, mount } = build(harness, { deps: { slot: 2 } });
  assert.equal(panel.getSessionId(), '');
  panel.renderTerminalPanel();
  await panel.startSession();
  assert.equal(panel.getSessionId(), 'pty-2');

  term._type('ls');
  assert.equal(await panel.sendCommand('echo hi'), false, 'the fake write result is not an accepted write');
  for (const call of api.calls.write) assert.equal(call.sessionId, 'pty-2');
  assert.ok(api.calls.write.length >= 2);

  term.cols = 100;
  const host = mount.querySelector('[data-ide-pty-mount]');
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 640 });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 });
  panel.renderTerminalPanel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(api.calls.resize.length >= 1, 'a resize went out');
  for (const call of api.calls.resize) assert.equal(call.sessionId, 'pty-2');

  await panel.stopSession();
  assert.deepEqual(api.calls.kill, [{ sessionId: 'pty-2' }]);
  assert.equal(panel.getSessionId(), '');

  await panel.startSession();
  panel.dispose();
  assert.deepEqual(api.calls.kill[1], { sessionId: 'pty-2' }, 'dispose kills by its own id');
  for (const call of api.calls.kill) assert.ok(call.sessionId, 'never an id-less kill');
});

test('data and exit for another session or another slot are ignored', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, term, api } = build(harness, { deps: { slot: 2 } });
  panel.renderTerminalPanel();
  await panel.startSession();

  api.emitData({ sessionId: 'pty-1', slot: 1, data: 'OTHER' });
  api.emitData({ sessionId: 'pty-9', data: 'STRAY' });
  api.emitData({ sessionId: 'pty-2', slot: 2, data: 'MINE' });
  assert.deepEqual(term.written, ['MINE']);

  api.emitExit({ sessionId: 'pty-1', slot: 1, exitCode: 0 });
  api.emitExit({ sessionId: 'pty-9', exitCode: 0 });
  assert.equal(panel.isRunning(), true, 'foreign exits leave the session running');
  api.emitExit({ sessionId: 'pty-2', slot: 2, exitCode: 3 });
  assert.equal(panel.isRunning(), false);
});

test('a slot-1 event heard while this slot-2 panel is still spawning never fills its pre-ready buffer', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  let release;
  const api = fakePtyApi();
  api.spawn = (payload) => {
    api.calls.spawn.push(payload);
    return new Promise((resolve) => { release = () => resolve({ ok: true, sessionId: 'pty-2', shell: 'sh', cwd: '/w' }); });
  };
  const { panel, term } = build(harness, { api, deps: { slot: 2 } });
  panel.renderTerminalPanel();
  const starting = panel.startSession();
  api.emitData({ sessionId: 'pty-1', slot: 1, data: 'FOREIGN' });
  api.emitData({ sessionId: 'pty-2', slot: 2, data: 'EARLY' });
  release();
  await starting;
  assert.deepEqual(term.written, ['EARLY']);
});

test('onSessionChange fires on start, restart and end, once per change', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, api, sessions } = build(harness, { deps: { slot: 2 } });
  panel.renderTerminalPanel();
  await panel.startSession();
  assert.deepEqual(sessions, ['pty-2']);
  api.emitExit({ sessionId: 'pty-2', slot: 2, exitCode: 0 });
  assert.deepEqual(sessions, ['pty-2', '']);
  await panel.startSession();
  await panel.restartSession?.();
  panel.dispose();
  assert.equal(sessions[sessions.length - 1], '');
  for (let i = 1; i < sessions.length; i += 1) assert.notEqual(sessions[i], sessions[i - 1]);
});

test('the panel markup uses no fixed DOM ids, so four instances coexist', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount } = build(harness);
  panel.renderTerminalPanel();
  assert.equal(mount.querySelectorAll('[id]').length, 0);
});

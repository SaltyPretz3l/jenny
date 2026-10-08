'use strict';

/* Terminal wiring: createIdeTerminalPanel builds the ConPTY (xterm) panel, the
 * only Workspace IDE terminal since the piped line terminal and its
 * workspace_pty_terminal flag were retired (post-1.2.0 sweep S8). The deps
 * object passes through untouched apart from the UIUX-011 persistent-host
 * getMountEl override. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeTerminalPanel,
} = require('../renderer/features/renderer-ide-terminal-wiring');
const { createIdePtyTerminalPanel } = require('../renderer/features/renderer-ide-pty-terminal-panel');

function makeDeps() {
  // A stand-in for the exact deps object the controller injects today; identity
  // + key preservation is asserted, so the sentinel keys matter.
  return {
    getDom: () => ({}),
    getIde: () => ({}),
    getWorkspacePtyApi: () => null,
    getMountEl: () => null,
    isActivePanel: () => false,
    showError: () => {},
    toErrorMessage: () => '',
    appendClientLog: () => {},
  };
}

function ptyUtils(returnValue) {
  const calls = [];
  return {
    calls,
    createIdePtyTerminalPanel(deps) {
      calls.push(deps);
      return returnValue;
    },
  };
}

test('builds the PTY panel with the SAME deps object when no persistent host getter is supplied', () => {
  const ptyPanel = { pty: true };
  const pty = ptyUtils(ptyPanel);
  const deps = makeDeps();
  const result = createIdeTerminalPanel({ ptyTerminalPanelUtils: pty, deps });
  assert.equal(result, ptyPanel, 'returns exactly the pty factory result');
  assert.equal(pty.calls.length, 1, 'pty factory called once');
  assert.equal(pty.calls[0], deps, 'same deps object identity passed through');
});

test('pty module missing: returns null, no throw (no legacy fallback exists)', () => {
  assert.equal(createIdeTerminalPanel({ ptyTerminalPanelUtils: undefined, deps: makeDeps() }), null);
  assert.equal(createIdeTerminalPanel(), null);
});

test('a factory returning nothing yields null', () => {
  assert.equal(createIdeTerminalPanel({ ptyTerminalPanelUtils: ptyUtils(undefined), deps: makeDeps() }), null);
});

test('UIUX-011: getPtyMountEl supplied — the pty factory gets a NEW deps object with getMountEl overridden, other keys untouched', () => {
  const pty = ptyUtils({ pty: true });
  const deps = makeDeps();
  const ptyMountEl = () => 'the-persistent-terminal-host';
  createIdeTerminalPanel({
    ptyTerminalPanelUtils: pty,
    getPtyMountEl: ptyMountEl,
    deps,
  });
  assert.equal(pty.calls.length, 1, 'pty factory called once');
  const ptyDeps = pty.calls[0];
  assert.notEqual(ptyDeps, deps, 'the pty panel gets a distinct object, not the original deps by reference');
  assert.equal(ptyDeps.getMountEl, ptyMountEl, 'getMountEl is overridden to the persistent-host getter');
  assert.equal(ptyDeps.getMountEl(), 'the-persistent-terminal-host');
  assert.equal(ptyDeps.getWorkspacePtyApi, deps.getWorkspacePtyApi, 'every other dep key is passed through unchanged');
  assert.deepEqual(Object.keys(ptyDeps).sort(), Object.keys(deps).sort(), 'no keys added or dropped besides the override');
  assert.equal(deps.getMountEl(), null, 'the caller-owned deps object is never mutated');
});

function createSendCommandPanel(api) {
  return createIdePtyTerminalPanel({
    getWorkspacePtyApi: () => api,
    getMountEl: () => null,
    isActivePanel: () => false,
    createTerminal: () => ({
      cols: 80, rows: 24, options: {}, loadAddon() {}, onData() {},
    }),
    createFitAddon: () => ({ fit() {} }),
    showError() {},
  });
}

test('sendCommand starts once, supplies shell/cwd, and writes one CRLF line', async () => {
  const calls = { start: 0, write: [] };
  const api = {
    async spawn() {
      calls.start += 1;
      return { ok: true, sessionId: 'term-1', shell: 'pwsh', cwd: 'C:/workspace' };
    },
    async write(payload) { calls.write.push(payload); return { ok: true, written: Buffer.byteLength(payload.data, 'utf8') }; },
    onData() { return () => {}; },
    onExit() { return () => {}; },
  };
  const panel = createSendCommandPanel(api);
  const result = await panel.sendCommand((shell, cwd) => `cd '${cwd}/${shell}'`);
  assert.equal(result, true);
  assert.equal(calls.start, 1);
  assert.deepEqual(calls.write, [
    { sessionId: 'term-1', data: "cd 'C:/workspace/pwsh'\r\n" },
  ]);
});

test('sendCommand is a false no-op that writes nothing when the builder throws', async () => {
  const writes = [];
  const api = {
    async spawn() { return { ok: true, sessionId: 'term-1', shell: 'pwsh', cwd: 'C:/workspace' }; },
    async write(payload) { writes.push(payload); },
    onData() { return () => {}; },
    onExit() { return () => {}; },
  };
  const panel = createSendCommandPanel(api);
  const result = await panel.sendCommand(() => { throw new Error('stale caller'); });
  assert.equal(result, false, 'the debug inspector relies on this refusal to fence stale launches');
  assert.deepEqual(writes, []);
});

test('sendCommand is a false no-op when its API is unavailable', async () => {
  const panel = createSendCommandPanel(null);
  await assert.doesNotReject(async () => {
    assert.equal(await panel.sendCommand('pwd'), false);
  });
});

test('createIdeTerminalSet passes the options through to the set module', () => {
  const { createIdeTerminalSet } = require('../renderer/features/renderer-ide-terminal-wiring');
  const seen = [];
  const set = { set: true };
  const opts = {
    ptyTerminalPanelUtils: ptyUtils({}),
    terminalSetUtils: { createIdeTerminalSet(o) { seen.push(o); return set; } },
  };
  assert.equal(createIdeTerminalSet(opts), set);
  assert.equal(seen[0], opts, 'same options object');
});

test('createIdeTerminalSet resolves the real set module and refuses without the panel module', () => {
  const { createIdeTerminalSet } = require('../renderer/features/renderer-ide-terminal-wiring');
  const real = createIdeTerminalSet({ ptyTerminalPanelUtils: { createIdePtyTerminalPanel() { return {}; } } });
  assert.equal(typeof real.newTerminal, 'function');
  assert.equal(createIdeTerminalSet({}), null);
  assert.equal(createIdeTerminalSet(), null);
});

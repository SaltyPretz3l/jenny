'use strict';

/* PTY-terminal wiring selector: createIdeTerminalPanelForFlags picks the real
 * ConPTY (xterm) panel when the workspace_pty_terminal flag is ON and the pty
 * module is present, else falls back to the VERBATIM legacy line-terminal panel
 * (flag-off must be today's behavior exactly). The deps object is passed through
 * untouched to whichever factory wins. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeTerminalPanelForFlags,
} = require('../renderer/features/renderer-ide-terminal-wiring');
const { createIdeTerminalPanel } = require('../renderer/features/renderer-ide-terminal-panel');
const { createIdePtyTerminalPanel } = require('../renderer/features/renderer-ide-pty-terminal-panel');

function makeDeps() {
  // A stand-in for the exact deps object the controller injects today; identity
  // + key preservation is asserted, so the sentinel keys matter.
  return {
    getDom: () => ({}),
    getIde: () => ({}),
    getWorkspaceTerminalApi: () => null,
    getWorkspacePtyApi: () => null,
    getMountEl: () => null,
    isActivePanel: () => false,
    showError: () => {},
    toErrorMessage: () => '',
    appendClientLog: () => {},
  };
}

function legacyUtils(returnValue) {
  const calls = [];
  return {
    calls,
    createIdeTerminalPanel(deps) {
      calls.push(deps);
      return returnValue;
    },
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

test('flag OFF: returns the legacy panel, called once with the SAME deps object; pty factory never called', () => {
  const legacyPanel = { legacy: true };
  const legacy = legacyUtils(legacyPanel);
  const pty = ptyUtils({ pty: true });
  const deps = makeDeps();
  const result = createIdeTerminalPanelForFlags({
    isPtyEnabled: () => false,
    terminalPanelUtils: legacy,
    ptyTerminalPanelUtils: pty,
    deps,
  });
  assert.equal(result, legacyPanel, 'returns exactly the legacy factory result');
  assert.equal(legacy.calls.length, 1, 'legacy factory called once');
  assert.equal(legacy.calls[0], deps, 'same deps object identity passed through');
  assert.ok('getWorkspaceTerminalApi' in legacy.calls[0], 'legacy terminal api key preserved');
  assert.deepEqual(Object.keys(legacy.calls[0]).sort(), Object.keys(deps).sort(), 'deps keys untouched');
  assert.equal(pty.calls.length, 0, 'pty factory never called when flag off');
});

test('flag ON: pty factory called with deps; legacy factory NOT called', () => {
  const ptyPanel = { pty: true };
  const legacy = legacyUtils({ legacy: true });
  const pty = ptyUtils(ptyPanel);
  const deps = makeDeps();
  const result = createIdeTerminalPanelForFlags({
    isPtyEnabled: () => true,
    terminalPanelUtils: legacy,
    ptyTerminalPanelUtils: pty,
    deps,
  });
  assert.equal(result, ptyPanel, 'returns the pty factory result');
  assert.equal(pty.calls.length, 1, 'pty factory called once');
  assert.equal(pty.calls[0], deps, 'same deps object identity passed to pty factory');
  assert.equal(legacy.calls.length, 0, 'legacy factory not called when pty wins');
});

test('flag ON but pty module missing: falls back to legacy (no dead tab)', () => {
  const legacyPanel = { legacy: true };
  const legacy = legacyUtils(legacyPanel);
  const deps = makeDeps();
  const result = createIdeTerminalPanelForFlags({
    isPtyEnabled: () => true,
    terminalPanelUtils: legacy,
    ptyTerminalPanelUtils: undefined,
    deps,
  });
  assert.equal(result, legacyPanel, 'falls back to legacy when pty module absent');
  assert.equal(legacy.calls.length, 1, 'legacy factory called for the fallback');
});

test('both modules missing: returns null, no throw', () => {
  const result = createIdeTerminalPanelForFlags({
    isPtyEnabled: () => true,
    terminalPanelUtils: undefined,
    ptyTerminalPanelUtils: undefined,
    deps: makeDeps(),
  });
  assert.equal(result, null, 'null when nothing can construct a panel');
});

test('UIUX-011: flag ON + getPtyMountEl supplied — the pty factory gets a NEW deps object with getMountEl overridden, other keys untouched', () => {
  const legacy = legacyUtils({ legacy: true });
  const pty = ptyUtils({ pty: true });
  const deps = makeDeps();
  const ptyMountEl = () => 'the-persistent-terminal-host';
  createIdeTerminalPanelForFlags({
    isPtyEnabled: () => true,
    terminalPanelUtils: legacy,
    ptyTerminalPanelUtils: pty,
    getPtyMountEl: ptyMountEl,
    deps,
  });
  assert.equal(pty.calls.length, 1, 'pty factory called once');
  const ptyDeps = pty.calls[0];
  assert.notEqual(ptyDeps, deps, 'the pty branch gets a distinct object, not the original deps by reference');
  assert.equal(ptyDeps.getMountEl, ptyMountEl, 'getMountEl is overridden to the persistent-host getter');
  assert.equal(ptyDeps.getMountEl(), 'the-persistent-terminal-host');
  assert.equal(ptyDeps.getWorkspacePtyApi, deps.getWorkspacePtyApi, 'every other dep key is passed through unchanged');
  assert.deepEqual(Object.keys(ptyDeps).sort(), Object.keys(deps).sort(), 'no keys added or dropped besides the override');
});

test('UIUX-011: flag OFF + getPtyMountEl supplied — the legacy factory still gets the ORIGINAL deps object (shared host untouched)', () => {
  const legacy = legacyUtils({ legacy: true });
  const pty = ptyUtils({ pty: true });
  const deps = makeDeps();
  createIdeTerminalPanelForFlags({
    isPtyEnabled: () => false,
    terminalPanelUtils: legacy,
    ptyTerminalPanelUtils: pty,
    getPtyMountEl: () => 'the-persistent-terminal-host',
    deps,
  });
  assert.equal(legacy.calls.length, 1, 'legacy factory called once');
  assert.equal(legacy.calls[0], deps, 'legacy gets the exact original deps object — getMountEl is never overridden for it');
  assert.equal(legacy.calls[0].getMountEl, deps.getMountEl, 'legacy keeps the shared-host getMountEl');
});

test('UIUX-011: flag ON without getPtyMountEl — the pty factory gets the exact original deps object (backward compatible)', () => {
  const pty = ptyUtils({ pty: true });
  const deps = makeDeps();
  createIdeTerminalPanelForFlags({
    isPtyEnabled: () => true,
    ptyTerminalPanelUtils: pty,
    deps,
  });
  assert.equal(pty.calls[0], deps, 'no getPtyMountEl means no override — same object identity as before this fix');
});

function createSendCommandPanel(kind, api) {
  if (kind === 'pty') {
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
  return createIdeTerminalPanel({
    getWorkspaceTerminalApi: () => api,
    getMountEl: () => null,
    isActivePanel: () => false,
    showError() {},
  });
}

for (const kind of ['line', 'pty']) {
  test(`${kind} sendCommand starts once, supplies shell/cwd, and writes one CRLF line`, async () => {
    const calls = { start: 0, write: [] };
    const api = {
      async start() {
        calls.start += 1;
        return { sessionId: 'term-1', shell: 'pwsh', cwd: 'C:/workspace' };
      },
      async spawn() {
        calls.start += 1;
        return { ok: true, sessionId: 'term-1', shell: 'pwsh', cwd: 'C:/workspace' };
      },
      async write(payload) { calls.write.push(payload); },
      onData() { return () => {}; },
      onExit() { return () => {}; },
    };
    const panel = createSendCommandPanel(kind, api);
    const result = await panel.sendCommand((shell, cwd) => `cd '${cwd}/${shell}'`);
    assert.equal(result, true);
    assert.equal(calls.start, 1);
    assert.deepEqual(calls.write, [
      { sessionId: 'term-1', data: "cd 'C:/workspace/pwsh'\r\n" },
    ]);
  });

  test(`${kind} sendCommand is a false no-op when its API is unavailable`, async () => {
    const panel = createSendCommandPanel(kind, null);
    await assert.doesNotReject(async () => {
      assert.equal(await panel.sendCommand('pwd'), false);
    });
  });
}

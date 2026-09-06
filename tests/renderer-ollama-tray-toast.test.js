'use strict';

// Ollama tray remediation (renderer slice) — owner-triggered toast surfaced
// from the `ollama.tray_app_conflict_detected` WARN log event. Renderer-only:
// the backend detection layer + remediation IPC/flag are wired by a parallel
// agent; this module only CONSUMES the contract (window.jennyShell.ollamaTray,
// state.features.featureFlags.ollama_tray_remediation).
//
// Driven entirely via injected deps (no full app boot) — the module is
// dependency-injectable specifically so this suite doesn't need the DOM/IPC
// harness.

const test = require('node:test');
const assert = require('node:assert/strict');

const modulePath = require.resolve('../renderer/shell/renderer-ollama-tray-toast');
let handleOllamaTrayConflictLogEntry;

test.beforeEach(() => {
  delete require.cache[modulePath];
  ({ handleOllamaTrayConflictLogEntry } = require(modulePath));
});

function makeEntry(overrides) {
  return {
    event: 'ollama.tray_app_conflict_detected',
    level: 'WARN',
    trayPids: [1234],
    startupShortcuts: ['Ollama.lnk'],
    ...overrides,
  };
}

function makeDeps(overrides) {
  const toastCalls = [];
  const bridgeCalls = { quitTrayApp: 0, disableStartupShortcut: 0 };
  const deps = {
    showToast: (message, options) => {
      toastCalls.push({ message, options });
      return 'toast_1';
    },
    bridge: {
      quitTrayApp: async () => {
        bridgeCalls.quitTrayApp += 1;
        return { ok: true, killedPids: [1234] };
      },
      disableStartupShortcut: async () => {
        bridgeCalls.disableStartupShortcut += 1;
        return { ok: true, disabled: ['Ollama.lnk'], skipped: [] };
      },
    },
    featureFlags: { ollama_tray_remediation: true },
    navigate: () => {},
    appendClientLog: () => {},
    ...overrides,
  };
  return { deps, toastCalls, bridgeCalls };
}

test('flag ON + matching event calls showToast with 3 actions', (t) => {
  const { deps, toastCalls } = makeDeps();
  handleOllamaTrayConflictLogEntry(makeEntry(), deps);

  assert.equal(toastCalls.length, 1);
  const [{ message, options }] = toastCalls;
  assert.match(message, /Ollama tray app/i);
  assert.equal(options.tone, 'warning');
  assert.equal(options.sticky, true);
  assert.ok(Array.isArray(options.actions));
  assert.equal(options.actions.length, 3);
  const ids = options.actions.map((a) => a.id);
  assert.deepEqual(ids.sort(), ['disable', 'quit', 'settings']);
});

test('clicking the quit action invokes the stubbed bridge method', async (t) => {
  const { deps, toastCalls, bridgeCalls } = makeDeps();
  handleOllamaTrayConflictLogEntry(makeEntry(), deps);

  const quitAction = toastCalls[0].options.actions.find((a) => a.id === 'quit');
  assert.ok(quitAction, 'quit action should be present');
  assert.equal(typeof quitAction.onClick, 'function');
  await quitAction.onClick();

  assert.equal(bridgeCalls.quitTrayApp, 1);
});

test('clicking the disable-startup action invokes the stubbed bridge method', async (t) => {
  const { deps, toastCalls, bridgeCalls } = makeDeps();
  handleOllamaTrayConflictLogEntry(makeEntry(), deps);

  const disableAction = toastCalls[0].options.actions.find((a) => a.id === 'disable');
  assert.ok(disableAction);
  await disableAction.onClick();

  assert.equal(bridgeCalls.disableStartupShortcut, 1);
});

test('clicking the settings action calls navigate to Settings > Models', (t) => {
  const navigateCalls = [];
  const { deps, toastCalls } = makeDeps({ navigate: (section) => navigateCalls.push(section) });
  handleOllamaTrayConflictLogEntry(makeEntry(), deps);

  const settingsAction = toastCalls[0].options.actions.find((a) => a.id === 'settings');
  assert.ok(settingsAction);
  settingsAction.onClick();

  assert.deepEqual(navigateCalls, ['models']);
});

test('flag OFF does not show a toast', (t) => {
  const { deps, toastCalls } = makeDeps({ featureFlags: { ollama_tray_remediation: false } });
  handleOllamaTrayConflictLogEntry(makeEntry(), deps);

  assert.equal(toastCalls.length, 0);
});

test('a non-matching event does not show a toast', (t) => {
  const { deps, toastCalls } = makeDeps();
  handleOllamaTrayConflictLogEntry(makeEntry({ event: 'ollama.something_else' }), deps);

  assert.equal(toastCalls.length, 0);
});

test('dedup: a second identical entry does not re-toast this session', (t) => {
  const { deps, toastCalls } = makeDeps();
  handleOllamaTrayConflictLogEntry(makeEntry(), deps);
  handleOllamaTrayConflictLogEntry(makeEntry(), deps);

  assert.equal(toastCalls.length, 1);
});

test('missing bridge: quit action fails soft to a structured result + warning toast', async (t) => {
  const { deps, toastCalls } = makeDeps({ bridge: null });
  handleOllamaTrayConflictLogEntry(makeEntry(), deps);

  const quitAction = toastCalls[0].options.actions.find((a) => a.id === 'quit');
  const result = await quitAction.onClick();

  // No throw AND an observable soft-failure: a structured unavailable result
  // plus a follow-up warning toast summarizing the failure.
  assert.deepEqual(result, { ok: false, reason: 'unavailable' });
  assert.equal(toastCalls.length, 2);
  assert.match(toastCalls[1].message, /Could not quit the tray app/i);
  assert.equal(toastCalls[1].options.tone, 'warning');
});

test('action failures bound and redact backend reasons before logging or toasting', async () => {
  const clientLogs = [];
  const sensitiveReason = `failed at C:\\Users\\alice\\secret\\ollama.exe ${'x'.repeat(300)}`;
  const { deps, toastCalls } = makeDeps({
    bridge: {
      quitTrayApp: async () => { throw new Error(sensitiveReason); },
      disableStartupShortcut: async () => ({ ok: false, reason: sensitiveReason }),
    },
    appendClientLog: (level, event, detail) => clientLogs.push({ level, event, detail }),
  });
  handleOllamaTrayConflictLogEntry(makeEntry(), deps);

  const quitAction = toastCalls[0].options.actions.find((action) => action.id === 'quit');
  const disableAction = toastCalls[0].options.actions.find((action) => action.id === 'disable');
  const quitResult = await quitAction.onClick();
  await disableAction.onClick();

  assert.equal(clientLogs.length, 1);
  assert.doesNotMatch(clientLogs[0].detail.message, /Users\\alice|ollama\.exe/);
  assert.doesNotMatch(quitResult.reason, /Users\\alice|ollama\.exe/);
  assert.doesNotMatch(toastCalls[1].message, /Users\\alice|ollama\.exe/);
  assert.doesNotMatch(toastCalls[2].message, /Users\\alice|ollama\.exe/);
  assert.ok(clientLogs[0].detail.message.length <= 240);
  assert.ok(toastCalls[1].message.length <= 275);
  assert.ok(toastCalls[2].message.length <= 290);
});

test('missing showToast: no-op that does not consume the once-per-session guard', (t) => {
  // First delivery has no showToast → the handler must bail out BEFORE marking
  // the session as shown (nothing to render).
  const noToast = makeDeps({ showToast: null });
  handleOllamaTrayConflictLogEntry(makeEntry(), noToast.deps);
  assert.equal(noToast.toastCalls.length, 0);

  // A later well-formed delivery must therefore still surface the toast — proof
  // the earlier bail did not silently burn the dedup guard.
  const withToast = makeDeps();
  handleOllamaTrayConflictLogEntry(makeEntry(), withToast.deps);
  assert.equal(withToast.toastCalls.length, 1);
});

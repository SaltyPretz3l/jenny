'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createShellEventBindings } = require('../renderer/shell/renderer-shell-event-utils.js');

function createBindingsHarness(overrides = {}) {
  const dom = new JSDOM('<button id="copy">Copy report</button><button id="end">End Session</button><input id="chat">');
  const { window } = dom;
  const state = overrides.state || {
    auth: { authenticated: true },
    currentSessionId: 'session-1',
    diagnosticsSnapshot: {},
    diagnosticsStatus: {},
    logs: [],
    ui: { logs: { selectedRunId: '' } },
  };
  const calls = { logs: [], resetAttachments: 0, renders: 0, focus: 0 };
  const chatInput = window.document.getElementById('chat');
  chatInput.focus = () => { calls.focus += 1; };
  const callbacks = {
    renderSessions() {},
    renderAll() { calls.renders += 1; },
    showToastMessage() {},
    appendClientLog(...args) { calls.logs.push(args); },
    showSessionActionError(error) { throw error; },
    getCurrentRuntimePreferences() { return { engine: 'local' }; },
    getActiveStreamIdForCancel() { return ''; },
    isSendPreflightPending() { return false; },
    resetAttachmentQueue() { calls.resetAttachments += 1; },
    ...overrides.callbacks,
  };
  const bindings = createShellEventBindings({
    state,
    dom: {
      copyLogsReportButton: window.document.getElementById('copy'),
      sessionActionButton: window.document.getElementById('end'),
      chatInput,
    },
    callbacks,
    constants: { TOAST_SOURCE: { logs: 'logs' } },
  });
  return { dom, window, state, calls, bindings };
}

test('copy feedback replaces its timer and dispose cancels the latest restore', async (t) => {
  const previous = {
    window: global.window,
    AbortController: global.AbortController,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
  };
  const timers = new Map();
  const cleared = [];
  let nextTimer = 1;
  global.setTimeout = (callback) => {
    const handle = nextTimer;
    nextTimer += 1;
    timers.set(handle, callback);
    return handle;
  };
  global.clearTimeout = (handle) => {
    cleared.push(handle);
    timers.delete(handle);
  };
  const harness = createBindingsHarness();
  global.window = harness.window;
  global.AbortController = harness.window.AbortController;
  harness.window.diagnosticsReportUtils = { buildDiagnosticReport: () => 'report' };
  harness.window.jennyShell = { clipboard: { writeText: async () => true } };
  t.after(() => {
    harness.dom.window.close();
    global.window = previous.window;
    global.AbortController = previous.AbortController;
    global.setTimeout = previous.setTimeout;
    global.clearTimeout = previous.clearTimeout;
  });

  harness.bindings.bind();
  const button = harness.window.document.getElementById('copy');
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  button.click();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(button.textContent, 'Copied');
  assert.equal(timers.size, 1);
  assert.deepEqual(cleared, [1]);

  harness.bindings.dispose();
  assert.equal(timers.size, 0);
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(button.textContent, 'Copied');
});

test('refused stream cancellation falls through to end-session teardown', async (t) => {
  const previousWindow = global.window;
  const previousAbortController = global.AbortController;
  const harness = createBindingsHarness({
    callbacks: { getActiveStreamIdForCancel() { return 'stale-stream'; } },
  });
  global.window = harness.window;
  global.AbortController = harness.window.AbortController;
  harness.window.jennyShell = { chat: { cancelStream: async () => false } };
  t.after(() => {
    harness.dom.window.close();
    global.window = previousWindow;
    global.AbortController = previousAbortController;
  });

  harness.bindings.bind();
  harness.window.document.getElementById('end').click();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.state.currentSessionId, '');
  assert.deepEqual(harness.state.runtimeDraft, { engine: 'local' });
  assert.equal(harness.calls.resetAttachments, 1);
  assert.equal(harness.calls.renders, 1);
  assert.equal(harness.calls.focus, 1);
  assert.deepEqual(harness.calls.logs.map((entry) => entry[1]), [
    'chat.cancel_refused',
    'chat.session_ended',
  ]);
  harness.bindings.dispose();
});

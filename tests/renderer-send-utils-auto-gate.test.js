'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createControllerHarness } = require('./helpers/send-controller-harness');

// FG-003 (Astra B1 review): the Auto warning is asked at the shared send
// boundary, so edit-and-resend, regenerate and Resume -- which call the shell's
// startPromptSend directly, not the composer wrapper -- cannot skip it.
function installRunModeControl(t, { mode = 'auto', answer = true } = {}) {
  const previous = globalThis.rendererRunModeControl;
  const asked = [];
  globalThis.rendererRunModeControl = {
    confirmAutoSend: async (sessionId) => {
      asked.push(sessionId);
      return mode === 'auto' ? answer : true;
    },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.rendererRunModeControl;
    else globalThis.rendererRunModeControl = previous;
  });
  return asked;
}

test('a declined Auto warning stops a direct send before it reaches the backend', async (t) => {
  const asked = installRunModeControl(t, { answer: false });
  const harness = createControllerHarness([]);
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('resume', { sessionIdOverride: 'session-1' });

  assert.equal(result, null);
  assert.deepEqual(asked, ['session-1']);
  assert.equal(harness.calls.startStream.length, 0);
});

test('a confirmed Auto warning lets the direct send start', async (t) => {
  const asked = installRunModeControl(t, { answer: true });
  const harness = createControllerHarness([]);
  t.after(() => harness.restore());

  await harness.controller.startPromptSend('hello', { sessionIdOverride: 'session-1' });

  assert.deepEqual(asked, ['session-1']);
  assert.equal(harness.calls.startStream.length, 1);
});

test('the startup audit send is never gated by the Auto warning', async (t) => {
  const asked = installRunModeControl(t, { answer: false });
  const harness = createControllerHarness([]);
  t.after(() => harness.restore());

  await harness.controller.startPromptSend('audit', { startupAudit: true });

  assert.deepEqual(asked, []);
  assert.equal(harness.calls.startStream.length, 1);
});

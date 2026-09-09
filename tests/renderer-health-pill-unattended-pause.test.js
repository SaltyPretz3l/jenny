const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const previousI18nFallback = globalThis.jennyI18nFallback;
globalThis.jennyI18nFallback = function interpolateDefault(_key, fallback, values = {}) {
  return String(fallback).replace(/\{(\w+)\}/g, (_match, name) => String(values[name] ?? ''));
};
const { createHealthPillController } = require('../renderer/shell/renderer-health-pill-utils');
if (previousI18nFallback === undefined) delete globalThis.jennyI18nFallback;
else globalThis.jennyI18nFallback = previousI18nFallback;

function createHarness(t, { withSafety = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const slot = window.document.getElementById('slot');
  const toasts = [];
  let pauseListener = null;
  let unsubscribeCalls = 0;
  const previousRunModeControl = globalThis.rendererRunModeControl;
  const previousHealthPillController = globalThis.rendererHealthPillController;
  globalThis.rendererRunModeControl = { currentRunMode: () => 'auto' };
  window.jennyShell = {
    diagnostics: { getJennyStatus: async () => null },
    ...(withSafety ? {
      safety: {
        onUnattendedPause(listener) {
          pauseListener = listener;
          return () => { unsubscribeCalls += 1; };
        },
      },
    } : {}),
  };
  const controller = createHealthPillController({
    window,
    document: window.document,
    slot,
    showToastMessage: (...args) => toasts.push(args),
  });
  t.after(() => {
    controller.dispose();
    if (previousRunModeControl === undefined) delete globalThis.rendererRunModeControl;
    else globalThis.rendererRunModeControl = previousRunModeControl;
    if (previousHealthPillController === undefined) delete globalThis.rendererHealthPillController;
    else globalThis.rendererHealthPillController = previousHealthPillController;
    dom.window.close();
  });
  return {
    controller,
    slot,
    toasts,
    emitPause(payload) { pauseListener?.(payload); },
    getPauseListener: () => pauseListener,
    getUnsubscribeCalls: () => unsubscribeCalls,
  };
}

function modeText(slot) {
  return slot.querySelector('.workbench-health-pill-mode')?.textContent || '';
}

test('unattended pause request paints the titlebar pill and emits one warning toast', (t) => {
  const harness = createHarness(t);

  harness.emitPause({
    state: 'requested', session_id: 'session-1', stream_id: 's1', threshold_minutes: 10,
  });

  assert.equal(modeText(harness.slot), 'Auto \u00b7 Pause requested');
  assert.equal(harness.toasts.length, 1);
  assert.equal(
    harness.toasts[0][0],
    'You were away for about 10 minutes, so Auto run is pausing: Jenny will ask before its next step, or stop safely if there is nothing left to ask. If nobody answers within 10 minutes the turn stops.'
  );
  assert.deepEqual(harness.toasts[0][1], {
    tone: 'warning',
    source: 'safety.unattended_guard',
    dedupeKey: 'safety:unattended-pause:s1',
  });
});

test('legacy stream events pause and clear only the tracked unattended stream', (t) => {
  const harness = createHarness(t);
  harness.emitPause({ state: 'requested', stream_id: 's1', session_id: 'session-1' });

  harness.controller.observeStreamPayload({ type: 'tool_approval_needed', streamId: 's2' });
  assert.equal(modeText(harness.slot), 'Auto \u00b7 Pause requested');
  harness.controller.observeStreamPayload({ type: 'tool_approval_needed', streamId: 's1' });
  assert.equal(modeText(harness.slot), 'Auto \u00b7 Paused');

  harness.emitPause({ state: 'requested', stream_id: 's1', session_id: 'session-1' });
  harness.controller.observeStreamPayload({
    type: 'tool_result', streamId: 's1', errorCode: 'CMP-TOOL-0046',
  });
  assert.equal(modeText(harness.slot), 'Auto \u00b7 Paused');
  harness.controller.observeStreamPayload({
    type: 'stream_reset', streamId: 's1', reason: 'tool_continuation',
  });
  harness.controller.observeStreamPayload({ type: 'tool_approval_needed', streamId: 's1' });
  assert.equal(modeText(harness.slot), 'Auto \u00b7 Paused');

  harness.controller.observeStreamPayload({ type: 'complete', streamId: 's1' });
  assert.equal(modeText(harness.slot), 'Auto');
  harness.controller.observeStreamPayload({ type: 'tool_approval_needed', streamId: 's1' });
  assert.equal(modeText(harness.slot), 'Auto');
});

test('v2 envelope events drive the same unattended pause transitions', (t) => {
  const harness = createHarness(t);
  harness.emitPause({ state: 'requested', stream_id: 's1', session_id: 'session-1' });

  harness.controller.observeStreamPayload({
    streamId: 's1',
    events: [{ type: 'tool_approval_needed', streamId: 's1' }],
  });
  assert.equal(modeText(harness.slot), 'Auto \u00b7 Paused');

  harness.emitPause({ state: 'requested', stream_id: 's1', session_id: 'session-1' });
  harness.controller.observeStreamPayload({
    streamId: 's1',
    events: [{ eventKind: 'reset', payload: { reason: 'tool_continuation' } }],
  });
  harness.controller.observeStreamPayload({
    streamId: 's1',
    events: [{ type: 'tool_approval_needed' }],
  });
  assert.equal(modeText(harness.slot), 'Auto \u00b7 Paused');
});

test('non-continuation stream resets clear the tracked unattended pause', (t) => {
  const harness = createHarness(t);
  harness.emitPause({ state: 'requested', stream_id: 's1', session_id: 'session-1' });

  harness.controller.observeStreamPayload({
    type: 'stream_reset', streamId: 's1', reason: 'model_winddown',
  });
  assert.equal(modeText(harness.slot), 'Auto');

  harness.emitPause({ state: 'requested', stream_id: 's1', session_id: 'session-1' });
  harness.controller.observeStreamPayload({ type: 'stream_reset', streamId: 's1' });
  assert.equal(modeText(harness.slot), 'Auto');
});

test('a replacement request is tracked and disposal unsubscribes safely', (t) => {
  const harness = createHarness(t);
  assert.equal(typeof harness.getPauseListener(), 'function');
  harness.emitPause({ state: 'requested', stream_id: 's1', session_id: 'session-1' });
  harness.emitPause({ state: 'requested', stream_id: 's2', session_id: 'session-2' });
  harness.controller.observeStreamPayload({ type: 'tool_approval_needed', streamId: 's1' });
  assert.equal(modeText(harness.slot), 'Auto \u00b7 Pause requested');

  harness.controller.dispose();
  assert.equal(harness.getUnsubscribeCalls(), 1);
  assert.doesNotThrow(() => harness.controller.observeStreamPayload({ type: 'complete', streamId: 's2' }));
});

test('a missing safety namespace does not subscribe or throw', (t) => {
  const harness = createHarness(t, { withSafety: false });
  assert.equal(harness.getPauseListener(), null);
  assert.doesNotThrow(() => harness.controller.observeStreamPayload({ type: 'complete', streamId: 's1' }));
});

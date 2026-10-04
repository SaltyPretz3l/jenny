'use strict';

// Status loader (2026-09-29): the startup scenario on lifecycle.onProgress
// carries a phase key and facts. The stepIndex/7 percent and main's English
// sentences are gone; shutdown keeps its step payload unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const runtimeShutdown = require('../services/main/runtime-shutdown');
const { createLifecycleProgressController } = require('../renderer/shell/renderer-lifecycle-progress-utils.js');

function makeController(events) {
  return runtimeShutdown.createRuntimeShutdownController({
    app: { getPath: () => '' },
    processRef: { env: {} },
    sendBridgeEvent: (channel, payload) => { events.push({ channel, payload }); },
    log: () => {},
  });
}

test('emitStartupProgress sends the phase and facts with no percent, step or sentence', () => {
  const events = [];
  const controller = makeController(events);
  controller.emitStartupProgress('sidecar_spawned', { modelId: 'qwen3:8b', elapsedMs: 412 });
  assert.equal(events.length, 1);
  const { channel, payload } = events[0];
  assert.equal(channel, 'lifecycle.onProgress');
  assert.equal(payload.scenario, 'startup');
  assert.equal(payload.phase, 'sidecar_spawned');
  assert.deepEqual(payload.facts, { modelId: 'qwen3:8b', elapsedMs: 412 });
  assert.equal(payload.error, '');
  assert.equal(typeof payload.timestamp, 'number');
  for (const retired of ['percent', 'stepIndex', 'stepCount', 'detail']) {
    assert.equal(Object.prototype.hasOwnProperty.call(payload, retired), false, `${retired} is retired`);
  }
});

test('emitStartupProgress carries the failure text as the error field', () => {
  const events = [];
  makeController(events).emitStartupProgress('ready', {}, 'CMP-SIDECAR-0001 spawn failed');
  assert.equal(events[0].payload.error, 'CMP-SIDECAR-0001 spawn failed');
  assert.deepEqual(events[0].payload.facts, {});
});

test('the startup step table is retired; the shutdown one stays', () => {
  assert.equal(runtimeShutdown.STARTUP_STEP_INDEX, undefined);
  assert.equal(runtimeShutdown.STARTUP_STEP_COUNT, undefined);
  assert.equal(typeof runtimeShutdown.SHUTDOWN_STEP_INDEX.done, 'number');
});

// T-1: the wire main drives (backend onProgress -> emitStartupProgress ->
// lifecycle.onProgress) read by the renderer controller, end to end.
test('startup phases and facts on the wire reach renderer lifecycle state, including the failure', () => {
  const events = [];
  const controller = makeController(events);
  const state = { ui: { activeView: 'chat' }, lifecycleProgress: { active: false } };
  const seen = [];
  const lifecycle = createLifecycleProgressController({ state, dom: {}, callbacks: {} });
  try {
    const forward = (phase, facts, error) => {
      controller.emitStartupProgress(phase, facts, error);
      lifecycle.handleLifecycleProgress(events.at(-1).payload);
      const { scenario, modelId, error: lifecycleError } = state.lifecycleProgress;
      seen.push([scenario, state.lifecycleProgress.phase, modelId, lifecycleError]);
    };
    forward('sidecar_spawn', { modelId: 'qwen3:8b', elapsedMs: 10 });
    forward('sidecar_spawn', { modelId: 'qwen3:8b', elapsedMs: 900, retrying: true });
    forward('ready', {}, 'CMP-SIDECAR-0001 spawn failed');
    assert.deepEqual(seen, [
      ['startup', 'sidecar_spawn', 'qwen3:8b', ''],
      ['startup', 'sidecar_spawn', 'qwen3:8b', ''],
      ['startup', 'ready', '', 'CMP-SIDECAR-0001 spawn failed'],
    ]);
    for (const { payload } of events) {
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'stepIndex'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'detail'), false);
    }
  } finally {
    lifecycle.dispose();
  }
});

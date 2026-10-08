'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const reader = require('../renderer/shared/model-load-failure');
const { createModelLibraryRecoveryActions } = require('../renderer/shell/model-library/model-library-recovery-actions');

function harness(overrides = {}) {
  const calls = [];
  const failure = { cause: 'out_of_memory', model: 'qwen3:8b', context: 40960, message: 'memory', engine: 'ollama', at: '2026-10-07T12:00:00Z' };
  const state = { backend: { phase: 'model_unavailable', model_lifecycle: { failure } } };
  const windowRef = { jennyShell: { modelTuning: { async update(payload) { calls.push(['persist', payload]); return { status: 'applied' }; } } },
    navigator: { clipboard: { async writeText(value) { calls.push(['copy', value]); } } } };
  const recovery = createModelLibraryRecoveryActions({ windowRef, state, reader,
    runtimeActions: { handleUse: (tag) => calls.push(['load', tag]) },
    findModel: () => ({ key: 'qwen3:8b' }), setStatusMessage: (message) => calls.push(['status', message]),
    setFilter: (filter) => calls.push(['filter', filter]), render: () => calls.push(['render']),
    openDiagnostics: () => calls.push(['diagnostics']), ...overrides });
  return { recovery, calls, state, windowRef, failure };
}

test('recovery routes retry, smaller context, recommended models, diagnostics and details', async () => {
  const h = harness();
  await h.recovery.handle('retry', 'QWEN3:8B');
  assert.deepEqual(h.calls.splice(0), [['load', 'QWEN3:8B']]);
  await h.recovery.handle('loadSmaller', 'qwen3:8b');
  assert.deepEqual(h.calls.splice(0), [['persist', { modelId: 'qwen3:8b', contextLength: 32768 }], ['load', 'qwen3:8b']]);
  await h.recovery.handle('showFits', 'qwen3:8b');
  assert.deepEqual(h.calls.splice(0), [['filter', 'recommended']]);
  await h.recovery.handle('diagnostics', 'qwen3:8b');
  assert.deepEqual(h.calls.splice(0), [['diagnostics']]);
  await h.recovery.handle('copyDetails', 'qwen3:8b');
  assert.deepEqual(h.calls.splice(0), [['copy', reader.failureDetails(h.failure)], ['status', 'Copied qwen3:8b']]);
});

test('smaller context waits for persistence and does not load on missing or rejected tuning', async () => {
  const h = harness();
  let finish;
  h.windowRef.jennyShell.modelTuning.update = () => new Promise((resolve) => { finish = resolve; });
  const pending = h.recovery.handle('loadSmaller', 'qwen3:8b');
  await Promise.resolve();
  assert.deepEqual(h.calls, []);
  finish({ status: 'applied' });
  await pending;
  assert.deepEqual(h.calls.splice(0), [['load', 'qwen3:8b']]);
  delete h.windowRef.jennyShell.modelTuning;
  await h.recovery.handle('loadSmaller', 'qwen3:8b');
  assert.deepEqual(h.calls.splice(0), [['status', 'Model lifecycle controls are unavailable right now.']]);
  h.windowRef.jennyShell.modelTuning = { update: async () => ({ status: 'rejected', reason: 'insufficient_memory' }) };
  await h.recovery.handle('loadSmaller', 'qwen3:8b');
  assert.equal(h.calls.some(([action]) => action === 'load'), false);
  assert.deepEqual(h.calls.splice(0), [['status', 'Not applied: insufficient memory.']], "the Tune drawer's wording for a refusal");
  h.windowRef.jennyShell.modelTuning = { update: async () => ({ status: 'rolled_back', reason: 'runtime_refresh_failed' }) };
  await h.recovery.handle('loadSmaller', 'qwen3:8b');
  assert.deepEqual(h.calls.splice(0), [['status', 'The runtime rejected the change. Previous settings were restored.']]);
  h.windowRef.jennyShell.modelTuning = { update: async () => { throw new Error('bridge down C:\\secret\\path'); } };
  await h.recovery.handle('loadSmaller', 'qwen3:8b');
  assert.deepEqual(h.calls.splice(0), [['status', 'bridge down [local path]']]);
});

test('copy details reports unavailable and denied clipboard without claiming success', async () => {
  const h = harness();
  delete h.windowRef.navigator.clipboard;
  await h.recovery.handle('copyDetails', 'qwen3:8b');
  assert.deepEqual(h.calls.splice(0), [['status', 'Clipboard access is unavailable right now.']]);
  h.windowRef.navigator.clipboard = { writeText: async () => { throw new Error('denied'); } };
  await h.recovery.handle('copyDetails', 'qwen3:8b');
  assert.deepEqual(h.calls.splice(0), [['status', 'Could not copy qwen3:8b to the clipboard.']]);
});

test('stale recovery actions have no effect for a cleared or different model failure', async () => {
  const h = harness();
  for (const action of ['retry', 'loadSmaller', 'showFits', 'diagnostics', 'copyDetails']) {
    await h.recovery.handle(action, 'another:8b');
  }
  h.state.backend = { phase: 'ready' };
  for (const action of ['retry', 'loadSmaller', 'showFits', 'diagnostics', 'copyDetails']) {
    await h.recovery.handle(action, 'qwen3:8b');
  }
  assert.deepEqual(h.calls, []);
});

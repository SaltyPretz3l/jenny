'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStage7RuntimeCoordinator } = require('../../../services/plugins/runtime/stage7-runtime-coordinator');

function participant(name, events, options = {}) {
  return {
    prepare: () => options.prepareFailure || { ok: true, prepared: { name } },
    commit: async () => { events.push(`${name}:commit`); return options.commitFailure || { ok: true }; },
    hide: async () => { events.push(`${name}:hide`); },
    snapshot: () => ({ name }),
  };
}

test('view and sidecar prepare before any generation is committed', async () => {
  const events = [];
  const runtime = {
    prepare: async () => ({ ok: true, commit: async () => { events.push('sidecar:commit'); return { ok: true }; } }),
  };
  const coordinator = createStage7RuntimeCoordinator({
    runtimeCoordinator: runtime,
    viewAuthority: participant('view', events),
  });
  const prepared = await coordinator.prepare({ compiled: {}, priorRuntime: null });
  assert.equal(prepared.ok, true);
  assert.deepEqual(events, []);
  assert.deepEqual(await prepared.commit(), { ok: true, degraded: false });
  assert.deepEqual(events, ['sidecar:commit', 'view:commit']);
});

test('a failed sidecar commit leaves view state unpublished', async () => {
  const events = [];
  const coordinator = createStage7RuntimeCoordinator({
    runtimeCoordinator: { prepare: async () => ({ ok: true,
      commit: async () => ({ ok: false, reason: 'sidecar_commit_failed' }) }) },
    viewAuthority: participant('view', events),
  });
  const prepared = await coordinator.prepare({ compiled: {} });
  const result = await prepared.commit();
  assert.equal(result.reason, 'sidecar_commit_failed');
  assert.deepEqual(events, []);
});

// The sidecar participant is createRuntimeApplyCoordinator: it exposes
// reconcile(runtime, reason) and no reconcileCompiled, so restart rehydration
// must build the plugin_runtime envelope itself (the retired Stage 6
// coordinator used to).
test('reconciliation hides the prior view, then reconciles the sidecar with the runtime envelope', async () => {
  const events = [];
  const calls = [];
  const coordinator = createStage7RuntimeCoordinator({
    runtimeCoordinator: {
      reconcile: async (runtime, reason) => {
        events.push('sidecar:reconcile');
        calls.push({ runtime, reason });
        return { ok: true };
      },
    },
    viewAuthority: participant('view', events),
  });
  const compiled = { snapshot: { runtime_schema_version: 6 }, declarative_content: { kind: 'content' } };
  const result = await coordinator.reconcileCompiled(compiled, 'restart_rehydration');
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(events, ['view:hide', 'sidecar:reconcile', 'view:commit']);
  assert.deepEqual(calls, [{
    runtime: {
      envelope: { mode: 'plugin_runtime', plugin_runtime: {
        snapshot: compiled.snapshot, declarative_content: compiled.declarative_content } },
      snapshot: compiled.snapshot,
    },
    reason: 'restart_rehydration',
  }]);
});

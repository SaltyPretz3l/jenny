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

test('all participants prepare before any generation is committed', async () => {
  const events = [];
  const runtime = {
    prepare: async () => ({ ok: true, commit: async () => { events.push('sidecar:commit'); return { ok: true }; } }),
  };
  const coordinator = createStage7RuntimeCoordinator({
    runtimeCoordinator: runtime,
    viewAuthority: participant('view', events),
    providerRuntime: participant('provider', events),
  });
  const prepared = await coordinator.prepare({ compiled: {}, priorRuntime: null });
  assert.equal(prepared.ok, true);
  assert.deepEqual(events, []);
  assert.deepEqual(await prepared.commit(), { ok: true, degraded: false });
  assert.deepEqual(events, ['sidecar:commit', 'view:commit', 'provider:commit']);
});

test('a failed sidecar commit leaves view and provider state unpublished', async () => {
  const events = [];
  const coordinator = createStage7RuntimeCoordinator({
    runtimeCoordinator: { prepare: async () => ({ ok: true,
      commit: async () => ({ ok: false, reason: 'sidecar_commit_failed' }) }) },
    viewAuthority: participant('view', events),
    providerRuntime: participant('provider', events),
  });
  const prepared = await coordinator.prepare({ compiled: {} });
  const result = await prepared.commit();
  assert.equal(result.reason, 'sidecar_commit_failed');
  assert.deepEqual(events, []);
});

test('reconciliation hides the prior view before changing sidecar authority', async () => {
  const events = [];
  const coordinator = createStage7RuntimeCoordinator({
    runtimeCoordinator: { reconcileCompiled: async () => { events.push('sidecar:reconcile'); return { ok: true }; } },
    viewAuthority: participant('view', events),
    providerRuntime: participant('provider', events),
  });
  const result = await coordinator.reconcileCompiled({}, 'test');
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['view:hide', 'sidecar:reconcile', 'view:commit', 'provider:commit']);
});

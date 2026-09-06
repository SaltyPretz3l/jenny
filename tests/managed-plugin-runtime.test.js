'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attachManagedPluginRuntime,
  getManagedPluginRuntime,
  sendWithPluginRuntimeReconciliation,
} = require('../services/backend/managed-plugin-runtime');

function activeEnvelope(revision = 1) {
  return {
    mode: 'plugin_runtime',
    plugin_runtime: {
      snapshot: {
        registry_revision: revision,
        dependency_graph_hash: 'a'.repeat(64),
        commit_epoch: revision,
        active_generation_id: `gen-${revision}`,
        declarative_content: {
          skill_scopes: [{ contribution_id: 'skill-one' }],
          prompts: [],
        },
      },
      declarative_content: [],
    },
  };
}

test('adapter is weak-owner scoped, tracks stable/fenced state, and detaches cleanly', async () => {
  const owner = {};
  const adapter = attachManagedPluginRuntime(owner, { requestApply: async () => ({ ok: true, attestation: {} }) });
  assert.equal(getManagedPluginRuntime(owner), adapter);
  assert.equal(attachManagedPluginRuntime(owner, { requestApply: async () => ({ ok: false }) }), adapter);
  assert.deepEqual(adapter.getState(), { runtime_status: 'inactive', runtime_reason_code: 'not_initialized' });
  adapter.fence('enable');
  assert.deepEqual(adapter.getState(), { runtime_status: 'fenced', runtime_reason_code: 'enable' });
  assert.equal((await adapter.apply({ mode: 'plugin_runtime' })).ok, true);
  assert.deepEqual(adapter.getState(), { runtime_status: 'fenced', runtime_reason_code: 'enable' });
  assert.equal(adapter.commit({ envelope: activeEnvelope() }).ok, true);
  adapter.unfence();
  assert.deepEqual(adapter.getState(), { runtime_status: 'ready', runtime_reason_code: 'ready' });
  adapter.detach();
  assert.equal(getManagedPluginRuntime(owner), null);
  assert.equal((await adapter.apply({})).reason, 'runtime_adapter_detached');
});

test('V6 privileged-only snapshots keep exact chat authority active', async () => {
  const adapter = attachManagedPluginRuntime({}, {
    requestApply: async () => ({ ok: true, attestation: {} }),
  });
  const envelope = activeEnvelope(6);
  envelope.plugin_runtime.snapshot.runtime_schema_version = 6;
  envelope.plugin_runtime.snapshot.declarative_content = {
    skill_scopes: [], prompts: [], themes: [], settings_schemas: [], commands: [], workflows: [],
  };
  envelope.plugin_runtime.snapshot.native_mcp_bindings = [{ binding_digest: 'b'.repeat(64) }];
  assert.equal((await adapter.commit({ envelope })).ok, true);
  assert.deepEqual(adapter.getState(), { runtime_status: 'ready', runtime_reason_code: 'ready' });
  assert.deepEqual(adapter.getChatAuthority(), {
    mode: 'plugin', registry_revision: 6, dependency_graph_hash: 'a'.repeat(64),
    commit_epoch: 6, active_generation_id: 'gen-6',
  });
  adapter.detach();
});

test('overlapping fence owners cannot reopen admission until every owner releases', () => {
  const adapter = attachManagedPluginRuntime({}, {
    requestApply: async () => ({ ok: true, attestation: {} }),
  });
  adapter.commit({ envelope: activeEnvelope() });
  adapter.fence('enable');
  adapter.fence('reconciliation');
  adapter.unfence();
  assert.deepEqual(adapter.getState(), {
    runtime_status: 'fenced',
    runtime_reason_code: 'reconciliation',
  });
  adapter.unfence();
  assert.deepEqual(adapter.getState(), { runtime_status: 'ready', runtime_reason_code: 'ready' });
  adapter.detach();
});

test('an ambiguous in-flight apply is superseded by restart reconciliation before admission can reopen', async () => {
  let resolveApply;
  let restartCalls = 0;
  const adapter = attachManagedPluginRuntime({}, {
    requestApply: async () => new Promise((resolve) => { resolveApply = resolve; }),
    restartAndApply: async () => (++restartCalls, { ok: true, attestation: {} }),
  });
  adapter.fence('disable');
  const candidate = adapter.apply({ candidate: true });
  assert.deepEqual(
    await adapter.apply({ duplicate: true }),
    { ok: false, reason: 'runtime_apply_in_flight', ambiguous: true }
  );
  const repaired = await adapter.reconcile(activeEnvelope());
  assert.equal(repaired.ok, true);
  assert.equal(restartCalls, 1);
  resolveApply({ ok: true, attestation: {} });
  assert.equal((await candidate).reason, 'runtime_apply_superseded');
  assert.deepEqual(adapter.getState(), { runtime_status: 'fenced', runtime_reason_code: 'disable' });
  adapter.unfence();
  assert.deepEqual(adapter.getState(), { runtime_status: 'ready', runtime_reason_code: 'ready' });
});

test('detach invalidates an in-flight request without post-await state or log mutation', async () => {
  let resolveApply;
  const logs = [];
  const adapter = attachManagedPluginRuntime({}, {
    requestApply: async () => new Promise((resolve) => { resolveApply = resolve; }),
    log: (event, data) => logs.push({ event, data }),
  });
  const pending = adapter.apply({ mode: 'plugin_runtime' });
  adapter.detach();
  resolveApply({ ok: true, attestation: {} });
  assert.deepEqual(await pending, { ok: false, reason: 'runtime_adapter_detached' });
  assert.deepEqual(adapter.getState(), { runtime_status: 'inactive', runtime_reason_code: 'runtime_adapter_detached' });
  assert.deepEqual(logs, []);
});

test('reconciliation is single-flight and performs one bounded restart fallback', async () => {
  const owner = {};
  let applyCalls = 0;
  let restartCalls = 0;
  let resolveApply;
  const adapter = attachManagedPluginRuntime(owner, {
    requestApply: async () => {
      applyCalls += 1;
      return new Promise((resolve) => { resolveApply = resolve; });
    },
    restartAndApply: async () => (++restartCalls, { ok: true, attestation: {} }),
  });
  const first = adapter.reconcile(activeEnvelope());
  const second = adapter.reconcile(activeEnvelope());
  assert.equal(first, second);
  resolveApply({ ok: false, reason: 'runtime_unavailable' });
  assert.equal((await first).ok, true);
  assert.equal(applyCalls, 1);
  assert.equal(restartCalls, 1);
  assert.deepEqual(adapter.getState(), { runtime_status: 'ready', runtime_reason_code: 'ready' });
});

test('initial backend startup degradation never triggers a competing sidecar restart', async () => {
  let restartCalls = 0;
  const adapter = attachManagedPluginRuntime({}, {
    requestApply: async () => ({
      ok: false,
      reason: 'runtime_startup_in_progress',
      ambiguous: false,
    }),
    restartAndApply: async () => {
      restartCalls += 1;
      return { ok: true };
    },
  });

  assert.deepEqual(await adapter.reconcile(activeEnvelope()), {
    ok: false,
    reason: 'runtime_sidecar_unavailable',
    ambiguous: false,
  });
  assert.equal(restartCalls, 0);
  assert.deepEqual(adapter.getState(), {
    runtime_status: 'degraded',
    runtime_reason_code: 'runtime_sidecar_unavailable',
  });
});

test('transport failures are bounded, ambiguous, degraded, and content-free in logs', async () => {
  const logs = [];
  const adapter = attachManagedPluginRuntime({}, {
    requestApply: async () => { throw new Error('C:\\secret\\plugin.json'); },
    log: (event, data) => logs.push({ event, data }),
  });
  const result = await adapter.apply({ secret: 'do not log' });
  assert.deepEqual(result, { ok: false, reason: 'runtime_apply_transport_failed', ambiguous: true });
  assert.deepEqual(adapter.getState(), { runtime_status: 'degraded', runtime_reason_code: 'runtime_apply_transport_failed' });
  assert.equal(JSON.stringify(logs).includes('secret'), false);
});

test('authority conflict reconciles once and retries with refreshed plugin authority', async () => {
  const owner = {};
  let applies = 0;
  const adapter = attachManagedPluginRuntime(owner, {
    requestApply: async () => (++applies, { ok: true, attestation: {} }),
  });
  adapter.commit({ envelope: activeEnvelope(2) });
  const seen = [];
  const result = await sendWithPluginRuntimeReconciliation(owner, async (authority) => {
    seen.push(authority);
    if (seen.length === 1) {
      const error = new Error('authority conflict');
      error.error_code = 'CMP-PLUGIN-0011';
      throw error;
    }
    return { ok: true };
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(applies, 1);
  assert.deepEqual(seen.map((authority) => authority.mode), ['plugin', 'plugin']);
  assert.equal(seen[1].registry_revision, 2);
});

test('failed authority reconciliation retries the same effect-free request once as core-only', async () => {
  const owner = {};
  const adapter = attachManagedPluginRuntime(owner, {
    requestApply: async () => ({ ok: false, reason: 'runtime_apply_rejected' }),
  });
  adapter.commit({ envelope: activeEnvelope(3) });
  const seen = [];
  const result = await sendWithPluginRuntimeReconciliation(owner, async (authority) => {
    seen.push(authority);
    if (seen.length === 1) {
      const error = new Error('authority conflict');
      error.rpc = { data: { error_code: 'CMP-PLUGIN-0011' } };
      throw error;
    }
    return { ok: true, mode: authority.mode };
  });
  assert.deepEqual(result, { ok: true, mode: 'core_only' });
  assert.deepEqual(seen.map((authority) => authority.mode), ['plugin', 'core_only']);
});

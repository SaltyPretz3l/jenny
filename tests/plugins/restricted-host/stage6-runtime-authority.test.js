'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  Stage6RuntimeAuthority,
  createStage6RuntimeCoordinator,
} = require('../../../services/plugins/restricted-host/stage6-runtime-authority');

function snapshot(version, generationId = 'gen-1', commitEpoch = 1) {
  return {
    runtime_schema_version: version,
    active_generation_id: generationId,
    commit_epoch: commitEpoch,
  };
}

test('Stage 6 participant preserves legacy V1-V3 activation as an empty restricted set', async () => {
  for (const version of [1, 2, 3]) {
    const revoked = [];
    const authority = new Stage6RuntimeAuthority();
    authority.bindInvocationController({ revokeGeneration: async (id) => revoked.push(id) });
    const sidecar = {
      prepare: async () => ({ ok: true, attestation: { version }, commit: async () => ({ ok: true }) }),
    };
    const coordinator = createStage6RuntimeCoordinator({
      runtimeCoordinator: sidecar,
      restrictedAuthority: authority,
    });
    const prepared = await coordinator.prepare({ compiled: {
      snapshot: snapshot(version, `gen-${version}`, version),
      declarative_content: [],
    } });
    assert.equal(prepared.ok, true);
    assert.equal((await prepared.commit()).ok, true);
    assert.deepEqual(authority.snapshot(), {
      generation_id: `gen-${version}`, commit_epoch: version, active_contributions: 0,
    });
    assert.deepEqual(revoked, []);
    await authority.dispose();
  }
});

test('Stage 6 authority publishes V4 while prior-generation cleanup failure stays bounded', async () => {
  const revoked = [];
  const authority = new Stage6RuntimeAuthority();
  authority.bindInvocationController({
    revokeGeneration: async (id) => { revoked.push(id); throw new Error('cleanup failed'); },
    dispose: async () => {},
  });
  const descriptor = Object.freeze({
    namespaced_name: 'plugin:acme-labs:widgets:compute',
    component_digest: 'a'.repeat(64),
  });
  const first = authority.prepare({
    snapshot: snapshot(4, 'gen-old', 1),
    restricted_descriptors: [], restricted_components: new Map(),
  });
  assert.equal(first.ok, true);
  assert.equal((await authority.commit(first.prepared)).ok, true);
  const next = authority.prepare({
    snapshot: snapshot(4, 'gen-new', 2),
    restricted_descriptors: [descriptor],
    restricted_components: new Map([[descriptor.component_digest, Buffer.from('component')]]),
  });
  assert.equal(next.ok, true);
  assert.equal((await authority.commit(next.prepared)).ok, true,
    'cleanup failure must not roll back newly committed authority');
  assert.deepEqual(revoked, ['gen-old']);
  assert.equal(authority.snapshot().active_contributions, 1);
  assert.deepEqual(authority.loadComponentBytes(descriptor), {
    ok: true, bytes: Buffer.from('component'),
  });
  await authority.dispose();
});

test('Stage 6 invocation resolves only the captured descriptor and generation identity', async () => {
  const digest = (value) => value.repeat(64);
  const descriptor = Object.freeze({
    namespaced_name: 'plugin:acme-labs:widgets:compute', publisher_id: 'acme-labs',
    plugin_id: 'widgets', contribution_id: 'compute', artifact_digest: digest('1'),
    component_digest: digest('2'), content_digest: digest('3'), generation_id: 'gen-bound',
    commit_epoch: 4, lifecycle_epoch: 5, policy_revision: 6,
    workspace_incarnation_id: 'workspace-1', abi_digest: digest('4'),
    protocol_digest: digest('5'), capabilities: ['compute'], network_origins: [],
  });
  let invoked = false;
  const authority = new Stage6RuntimeAuthority();
  authority.bindInvocationController({
    invoke: async () => { invoked = true; return { ok: true, invocation_id: 'inv-1' }; },
  });
  const prepared = authority.prepare({
    snapshot: { ...snapshot(4, 'gen-bound', 4), registry_revision: 7,
      dependency_graph_hash: digest('6') },
    restricted_descriptors: [descriptor],
    restricted_components: new Map([[descriptor.component_digest, Buffer.from('component')]]),
  });
  await authority.commit(prepared.prepared);
  const executionAuthority = {
    authority: { mode: 'plugin', active_generation_id: 'gen-bound', commit_epoch: 4,
      registry_revision: 7, dependency_graph_hash: digest('6') },
    descriptor: { capability_identity: {
      runtime_kind: 'restricted', name: descriptor.namespaced_name,
      artifact_digest: descriptor.artifact_digest, component_digest: descriptor.component_digest,
      content_digest: descriptor.content_digest, generation_id: descriptor.generation_id,
      commit_epoch: descriptor.commit_epoch, lifecycle_epoch: descriptor.lifecycle_epoch,
      policy_revision: descriptor.policy_revision,
      workspace_incarnation_id: descriptor.workspace_incarnation_id,
      abi_digest: descriptor.abi_digest, protocol_digest: descriptor.protocol_digest,
      capabilities: [...descriptor.capabilities], network_origins: [],
    } },
  };
  assert.equal((await authority.execute(descriptor.namespaced_name, {}, {
    executionAuthority,
  })).ok, true);
  assert.equal(invoked, true);
  invoked = false;
  executionAuthority.descriptor.capability_identity.component_digest = digest('9');
  const stale = authority.execute(descriptor.namespaced_name, {}, { executionAuthority });
  assert.equal(stale.reason, 'restricted_tool_authority_stale');
  assert.equal(stale.execution_settlement.producer_started, false);
  assert.equal(invoked, false);
});

test('Stage 6 participant accepts the V5 composite snapshot and rejects V6 or malformed results', () => {
  const authority = new Stage6RuntimeAuthority();
  const stage7 = authority.prepare({
    snapshot: snapshot(5),
    restricted_descriptors: [],
    restricted_components: new Map(),
  });
  assert.equal(stage7.ok, true);
  assert.equal(stage7.prepared.descriptors.size, 0);
  assert.equal(stage7.prepared.components.size, 0);
  assert.equal(authority.prepare({ snapshot: snapshot(6) }).reason,
    'restricted_runtime_compile_result_invalid');
  assert.equal(authority.prepare({}).reason, 'restricted_runtime_compile_result_invalid');
});

test('restart reconciliation publishes restricted authority only after sidecar success', async () => {
  const descriptor = Object.freeze({
    namespaced_name: 'plugin:acme-labs:widgets:compute',
    component_digest: 'a'.repeat(64),
  });
  const compiled = {
    snapshot: snapshot(4, 'gen-rehydrated', 9),
    declarative_content: [],
    restricted_descriptors: [descriptor],
    restricted_components: new Map([[descriptor.component_digest, Buffer.from('component')]]),
  };
  const authority = new Stage6RuntimeAuthority();
  authority.bindInvocationController({ dispose: async () => {} });
  let sidecarOk = false;
  const coordinator = createStage6RuntimeCoordinator({
    runtimeCoordinator: {
      reconcile: async () => sidecarOk
        ? { ok: true, attestation: { commit_epoch: 9 } }
        : { ok: false, reason: 'sidecar_restart_failed' },
    },
    restrictedAuthority: authority,
  });
  const failed = await coordinator.reconcileCompiled(compiled, 'restart_rehydration');
  assert.equal(failed.ok, false);
  assert.equal(authority.snapshot().active_contributions, 0);

  sidecarOk = true;
  const recovered = await coordinator.reconcileCompiled(compiled, 'restart_rehydration');
  assert.equal(recovered.ok, true);
  assert.deepEqual(authority.snapshot(), {
    generation_id: 'gen-rehydrated', commit_epoch: 9, active_contributions: 1,
  });
  await authority.dispose();
});

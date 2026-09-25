'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RemoteMcpRuntimeAuthority,
} = require('../../../services/plugins/remote-mcp/runtime-authority');

test('Stage 5 first activation applies the legacy V2 declarative transition', async () => {
  const snapshot = {
    generation: { generation_schema_version: 2 },
    plugins: [{
      publisher_id: 'jenny-official',
      plugin_id: 'owner-smoke',
      desired_state: 'installed_disabled',
      effective_state: 'installed_disabled',
      contributions: [{
        contribution_id: 'prompt-main',
        kind: 'prompt',
        desired_enabled: true,
        effective_enabled: false,
        blocked_reason: 'master_disabled',
      }, {
        contribution_id: 'mcp-inert',
        kind: 'mcp_descriptor',
        desired_enabled: false,
        effective_enabled: false,
        blocked_reason: 'stage_forbidden',
      }],
    }],
  };
  const authority = new RemoteMcpRuntimeAuthority();

  const result = await authority.prepareCandidatePlugins({
    snapshot,
    operation: 'enable',
    publisherId: 'jenny-official',
    pluginId: 'owner-smoke',
    generationId: 'gen-next',
    commitEpoch: 2,
    stage: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.plugins[0].desired_state, 'active');
  assert.equal(result.plugins[0].effective_state, 'active');
  assert.equal(result.plugins[0].contributions[0].effective_enabled, true);
  assert.equal(result.plugins[0].contributions[0].blocked_reason, 'none');
  assert.equal(result.plugins[0].contributions[1].effective_enabled, false);
  assert.equal(snapshot.plugins[0].effective_state, 'installed_disabled');
});

test('execute resolves a name only among bindings the committed generation references', async () => {
  const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
  const { runCommitSequence } = require('../../../services/plugins/lifecycle/commit-sequence');
  const { BASE_DIR, NOW, commitInput, pluginEntry } = require('../../helpers/plugins/durability-scenario');
  const facade = createMemoryFsFacade();
  const hex = (value) => value.repeat(64);
  const oldDigest = hex('1');
  // remote_binding_digests is a V3+ generation field, so commit a V3 generation.
  const committed = await runCommitSequence(facade, BASE_DIR, {
    ...commitInput('gen-remote', { operationId: 'op-remote', now: NOW }),
    plugins: [{
      ...pluginEntry('alpha', { effectiveState: 'active' }),
      package_record_digest: hex('2'), source_trust_digest: hex('3'),
      advisory_snapshot_digest: hex('4'), data_snapshot_digest: hex('5'),
      remote_binding_digests: [oldDigest],
    }],
    policyGrantRef: { policy_snapshot_digest: hex('8'), policy_revision: 1,
      grant_set_digest: hex('9'), network_consent_digest: hex('a') },
    generationSchemaVersion: 3, lockDigest: hex('6'), distributionStateDigest: hex('7'),
  });
  assert.equal(committed.ok, true, committed.reason);
  const lookups = [];
  const authority = new RemoteMcpRuntimeAuthority({
    facade,
    baseDir: BASE_DIR,
    remoteMcpService: {
      descriptorForName(name, allowed) {
        lookups.push({ name, allowed: [...allowed] });
        return null;
      },
    },
  });
  const result = await authority.execute('plugin:acme:alpha:tool:x', {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'remote_descriptor_rediscovery_required');
  assert.deepEqual(lookups, [{ name: 'plugin:acme:alpha:tool:x', allowed: [oldDigest] }]);
});

test('execute rejects a latest-name descriptor that differs from captured binding identity', async () => {
  const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
  const { runCommitSequence } = require('../../../services/plugins/lifecycle/commit-sequence');
  const { BASE_DIR, NOW, commitInput, pluginEntry } = require('../../helpers/plugins/durability-scenario');
  const facade = createMemoryFsFacade();
  const hex = (value) => value.repeat(64);
  const bindingDigest = hex('1');
  const committed = await runCommitSequence(facade, BASE_DIR, {
    ...commitInput('gen-bound', { operationId: 'op-bound', now: NOW }),
    plugins: [{
      ...pluginEntry('alpha', { effectiveState: 'active' }),
      package_record_digest: hex('2'), source_trust_digest: hex('3'),
      advisory_snapshot_digest: hex('4'), data_snapshot_digest: hex('5'),
      remote_binding_digests: [bindingDigest],
    }],
    policyGrantRef: { policy_snapshot_digest: hex('8'), policy_revision: 1,
      grant_set_digest: hex('9'), network_consent_digest: hex('a') },
    generationSchemaVersion: 3, lockDigest: hex('6'), distributionStateDigest: hex('7'),
  });
  assert.equal(committed.ok, true, committed.reason);
  const name = 'plugin:acme:alpha:tool:x';
  const descriptor = {
    binding: { binding_digest: bindingDigest, descriptor_digest: hex('b'),
      artifact_digest: hex('c'), endpoint_origin_digest: hex('d') },
    contribution: { namespaced_name: name, schema_digest: hex('e') },
  };
  const authority = new RemoteMcpRuntimeAuthority({
    facade, baseDir: BASE_DIR,
    remoteMcpService: { descriptorForName: () => descriptor },
  });
  const state = require('../../../services/plugins/lifecycle/commit-sequence');
  const active = await state.readCommittedState(facade, BASE_DIR);
  const result = await authority.execute(name, {}, { executionAuthority: {
    authority: { mode: 'plugin', active_generation_id: active.generation.generation_id,
      commit_epoch: active.pointer.commit_epoch, registry_revision: active.pointer.revision,
      dependency_graph_hash: active.generation.graph_hash },
    descriptor: { capability_identity: { runtime_kind: 'remote_mcp', name,
      binding_digest: hex('f'), descriptor_digest: hex('b'), artifact_digest: hex('c'),
      schema_digest: hex('e'), endpoint_origin_digest: hex('d') } },
  } });
  assert.equal(result.reason, 'remote_tool_authority_stale');
  assert.deepEqual(result.execution_settlement,
    { cleanup: 'confirmed', producer_started: false });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { runCommitSequence, readCommittedState } = require('../../../services/plugins/lifecycle/commit-sequence');
const {
  buildCandidatePlugins,
  runActivationOperation,
} = require('../../../services/plugins/lifecycle/activation-operation');
const { BASE_DIR, NOW, LATER, commitInput } = require('../../helpers/plugins/durability-scenario');
const { readAuditLog } = require('../../../services/plugins/lifecycle/audit-log');

function compiled(generation, pointer) {
  return {
    ok: true,
    snapshot: {
      kind: 'plugin_runtime_snapshot',
      registry_revision: pointer.revision,
      dependency_graph_hash: generation.graph_hash,
      commit_epoch: pointer.commit_epoch,
      active_generation_id: generation.generation_id,
      declarative_content: {
        skill_scopes: [], prompts: [], themes: [], settings_schemas: [], commands: [], workflows: [], mcp_descriptors: [],
      },
    },
    declarative_content: [],
  };
}

function runtimeCoordinator(events) {
  return {
    fence: (reason) => events.push(`fence:${reason}`),
    unfence: () => events.push('unfence'),
    prepare: async ({ compiled: candidate }) => {
      events.push(`prepare:${candidate.snapshot.active_generation_id}`);
      return {
        ok: true,
        attestation: { participant_kind: 'sidecar' },
        rollback: async () => (events.push('rollback'), { ok: true }),
        reconcile: async () => (events.push('reconcile'), { ok: true }),
        commit: async () => (events.push('commit'), { ok: true }),
      };
    },
  };
}

function operationOptions(operation, pluginId, generationId, events) {
  return {
    operation,
    publisherId: 'acme',
    pluginId,
    newOperationId: () => `op-${generationId}`,
    requireConsent: async () => ({ ok: true }),
    now: LATER,
    lifecycleEpoch: 1,
    generationId,
    policyGrantRef: { policy_snapshot_digest: '1'.repeat(64), policy_revision: 1, grant_set_digest: '2'.repeat(64) },
    compileCandidate: async ({ generation, pointer }) => compiled(generation, pointer),
    runtimeCoordinator: runtimeCoordinator(events),
    stage: 4,
  };
}

test('candidate builder changes only the target and preserves unrelated active plugins', () => {
  const plugins = [
    { publisher_id: 'acme', plugin_id: 'alpha', desired_state: 'active', effective_state: 'active' },
    { publisher_id: 'acme', plugin_id: 'beta', desired_state: 'installed_disabled', effective_state: 'installed_disabled' },
  ];
  const enabled = buildCandidatePlugins(plugins, { publisherId: 'acme', pluginId: 'beta', operation: 'enable' });
  assert.deepEqual(enabled.map((entry) => entry.effective_state), ['active', 'active']);
  const disabled = buildCandidatePlugins(enabled, { publisherId: 'acme', pluginId: 'beta', operation: 'disable' });
  assert.deepEqual(disabled.map((entry) => entry.effective_state), ['active', 'installed_disabled']);
  assert.equal(disabled.some((entry) => ['preparing', 'disabling'].includes(entry.effective_state)), false);
  const quarantined = buildCandidatePlugins(enabled, {
    publisherId: 'acme', pluginId: 'beta', operation: 'quarantine', stage: 6,
  });
  assert.deepEqual(quarantined.map((entry) => entry.effective_state), ['active', 'quarantined']);
});

test('restricted-host crash quarantine commits through lifecycle with a supervisor audit actor', async () => {
  const facade = createMemoryFsFacade();
  const initial = commitInput('gen-before-quarantine', { operationId: 'op-before-quarantine', now: NOW });
  initial.plugins[0].desired_state = 'active';
  initial.plugins[0].effective_state = 'active';
  assert.equal((await runCommitSequence(facade, BASE_DIR, initial)).ok, true);
  const events = [];
  const outcome = await runActivationOperation(facade, BASE_DIR, {
    ...operationOptions('quarantine', initial.plugins[0].plugin_id, 'gen-quarantined', events),
    stage: 6,
  });
  assert.equal(outcome.ok, true);
  const committed = await readCommittedState(facade, BASE_DIR);
  assert.equal(committed.generation.plugins[0].effective_state, 'quarantined');
  const audit = await readAuditLog(facade, BASE_DIR);
  const last = audit.events.at(-1);
  assert.equal(last.action, 'quarantine');
  assert.deepEqual(last.actor, { kind: 'system', component: 'supervisor' });
});

test('activation derives transitive dependencies and admits Stage 5 MCP descriptor state', () => {
  const plugin = {
    publisher_id: 'jenny-official', plugin_id: 'starter',
    desired_state: 'installed_disabled', effective_state: 'installed_disabled',
    contributions: [
      { contribution_id: 'prompt', kind: 'prompt', desired_enabled: false, effective_enabled: false, blocked_reason: 'master_disabled' },
      { contribution_id: 'workflow', kind: 'workflow', desired_enabled: true, effective_enabled: false, blocked_reason: 'master_disabled' },
      { contribution_id: 'command', kind: 'command', desired_enabled: true, effective_enabled: false, blocked_reason: 'master_disabled' },
      { contribution_id: 'mcp', kind: 'mcp_descriptor', desired_enabled: false, effective_enabled: false, blocked_reason: 'stage_forbidden' },
    ],
  };
  const dependencies = new Map([['workflow', ['prompt']], ['command', ['workflow']]]);

  const [enabled] = buildCandidatePlugins([plugin], {
    publisherId: 'jenny-official', pluginId: 'starter', operation: 'enable', dependencyMap: dependencies,
  });

  assert.deepEqual(enabled.contributions.map((item) => [item.contribution_id, item.effective_enabled, item.blocked_reason]), [
    ['prompt', false, 'none'],
    ['workflow', false, 'dependency_disabled'],
    ['command', false, 'dependency_disabled'],
    ['mcp', false, 'none'],
  ]);
});

test('enable and disable apply the complete candidate before pointer authority moves', async () => {
  const facade = createMemoryFsFacade();
  const initial = commitInput('gen-initial', { operationId: 'op-initial', now: NOW });
  initial.plugins = [
    { ...initial.plugins[0], plugin_id: 'alpha' },
    { ...initial.plugins[0], plugin_id: 'beta' },
  ];
  assert.equal((await runCommitSequence(facade, BASE_DIR, initial)).ok, true);

  const events = [];
  const alphaEnabled = await runActivationOperation(facade, BASE_DIR, operationOptions('enable', 'alpha', 'gen-alpha-active', events));
  assert.equal(alphaEnabled.ok, true, JSON.stringify(alphaEnabled));
  assert.equal((await runActivationOperation(facade, BASE_DIR, operationOptions('enable', 'beta', 'gen-beta-active', events))).ok, true);
  assert.equal((await runActivationOperation(facade, BASE_DIR, operationOptions('disable', 'beta', 'gen-beta-disabled', events))).ok, true);

  const state = await readCommittedState(facade, BASE_DIR);
  const states = Object.fromEntries(state.generation.plugins.map((entry) => [entry.plugin_id, entry.effective_state]));
  assert.deepEqual(states, { alpha: 'active', beta: 'installed_disabled' });
  assert.deepEqual(events.filter((event) => event === 'commit').length, 3);
  assert.deepEqual(events.filter((event) => event === 'unfence').length, 3);
});

test('the operation remains a true no-op while the authoritative stage is 3', async () => {
  const facade = createMemoryFsFacade();
  const result = await runActivationOperation(facade, BASE_DIR, {
    operation: 'enable',
    publisherId: 'acme-labs',
    pluginId: 'alpha',
    stage: 3,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'activation_stage_inert');
  assert.equal(facade.callCounts.writeFile, 0);
});

test('deterministic re-verification failure reopens prior admission while indeterminate exceptions stay fenced', async () => {
  const facade = createMemoryFsFacade();
  assert.equal((await runCommitSequence(facade, BASE_DIR, commitInput('gen-initial', { operationId: 'op-initial', now: NOW }))).ok, true);

  const compilers = [
    async () => ({ ok: false, reason: 'package_record_unavailable' }),
    async () => { throw new Error('must stay redacted'); },
  ];
  for (const [index, compileCandidate] of compilers.entries()) {
    const events = [];
    const result = await runActivationOperation(facade, BASE_DIR, {
      ...operationOptions('enable', 'alpha', `gen-failed-${index}`, events),
      compileCandidate,
    });
    assert.equal(result.ok, false);
    assert.equal(events.some((event) => event === 'unfence'), index === 0);
    assert.equal(JSON.stringify(result).includes('redacted'), false);
  }
});

test('a throwing asynchronous candidate factory returns a bounded redacted refusal', async () => {
  const facade = createMemoryFsFacade();
  assert.equal((await runCommitSequence(facade, BASE_DIR,
    commitInput('gen-initial', { operationId: 'op-initial', now: NOW }))).ok, true);
  const result = await runActivationOperation(facade, BASE_DIR, {
    ...operationOptions('enable', 'alpha', 'gen-candidate-failed', []),
    candidatePluginsFactory: async () => { throw new Error('provider failure'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'candidate_plugin_mutation_failed');
  assert.equal(result.operationId, 'op-gen-candidate-failed');
  assert.doesNotMatch(JSON.stringify(result), /provider failure/);
});

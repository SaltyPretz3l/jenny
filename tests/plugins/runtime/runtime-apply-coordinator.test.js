'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_RESOURCE_KINDS,
  validateAttestation,
  createRuntimeApplyCoordinator,
} = require('../../../services/plugins/runtime/runtime-apply-coordinator');

const HASH = 'a'.repeat(64);

function snapshot(overrides = {}) {
  return {
    kind: 'plugin_runtime_snapshot',
    registry_revision: 4,
    dependency_graph_hash: HASH,
    commit_epoch: 9,
    active_generation_id: 'gen-9',
    declarative_content: {
      skill_scopes: [], prompts: [], themes: [], settings_schemas: [], commands: [], workflows: [], mcp_descriptors: [],
    },
    ...overrides,
  };
}

function attestation(source = snapshot(), overrides = {}) {
  return {
    attestation_schema_version: 1,
    participant_kind: 'sidecar',
    registry_revision: source.registry_revision,
    dependency_graph_hash: source.dependency_graph_hash,
    commit_epoch: source.commit_epoch,
    sidecar_plugin_generation: `sidecar-${source.registry_revision}`,
    reused_resource_proofs: REQUIRED_RESOURCE_KINDS.map((kind, index) => ({
      resource_kind: kind,
      resource_id: `${kind}-${index}`,
      digest: String(index + 1).repeat(64),
    })),
    rejected_contributions: [],
    ...overrides,
  };
}

function compiled(source = snapshot()) {
  return { snapshot: source, declarative_content: [] };
}

function runtime(source = snapshot()) {
  return {
    envelope: {
      mode: 'plugin_runtime',
      plugin_runtime: { snapshot: source, declarative_content: [] },
    },
    snapshot: source,
  };
}

function snapshotV6(overrides = {}) {
  return snapshot({ runtime_schema_version: 6, ...overrides });
}

function attestationV6(source = snapshotV6(), overrides = {}) {
  return {
    attestation_schema_version: 6,
    registry_revision: source.registry_revision,
    dependency_graph_hash: source.dependency_graph_hash,
    commit_epoch: source.commit_epoch,
    active_generation_id: source.active_generation_id,
    sidecar_plugin_generation: '1'.repeat(64),
    electron_runtime_generation: '2'.repeat(64),
    participant_set_digest: '3'.repeat(64),
    expected_rejections_digest: '4'.repeat(64),
    applied: false,
    ...overrides,
  };
}

test('attestation must bind exact authority, contain no rejection, and prove every reused resource kind', () => {
  const source = snapshot();
  assert.equal(validateAttestation(attestation(source), source).ok, true);
  assert.equal(validateAttestation(attestation(source, { registry_revision: 5 }), source).reason, 'runtime_attestation_authority_mismatch');
  assert.equal(validateAttestation(attestation(source, { rejected_contributions: [{ contribution_id: 'skill-main', reason_code: 'rejected', retryable: false }] }), source).reason, 'runtime_contribution_rejected');
  assert.equal(validateAttestation(attestation(source, { reused_resource_proofs: attestation(source).reused_resource_proofs.slice(1) }), source).reason, 'runtime_resource_proof_incomplete');
  const duplicateKindProofs = attestation(source).reused_resource_proofs.map((proof, index) => (
    index === 1 ? { ...proof, resource_kind: 'engine' } : proof
  ));
  assert.equal(validateAttestation(attestation(source, { reused_resource_proofs: duplicateKindProofs }), source).reason, 'runtime_resource_proof_incomplete');
});

test('successful prepare returns rollback/commit callbacks and never logs package content', async () => {
  const calls = [];
  const logs = [];
  const source = snapshot();
  const adapter = {
    apply: async (envelope) => (calls.push(['apply', envelope]), { ok: true, attestation: attestation(source) }),
    reconcile: async (envelope) => (
      calls.push(['reconcile', envelope]),
      { ok: true, attestation: attestation(envelope.plugin_runtime.snapshot) }
    ),
    commit: async (preparedRuntime) => (calls.push(['commit', preparedRuntime]), { ok: true }),
    fence: (reason) => calls.push(['fence', reason]),
    unfence: () => calls.push(['unfence']),
  };
  const coordinator = createRuntimeApplyCoordinator({ runtimeAdapter: adapter, log: (event, data) => logs.push({ event, data }) });
  coordinator.fence('enable');
  const priorRuntime = runtime(snapshot({ registry_revision: 3, commit_epoch: 8 }));
  const prepared = await coordinator.prepare({ compiled: compiled(source), priorRuntime });
  assert.equal(prepared.ok, true, prepared.reason);
  assert.equal((await prepared.rollback({ reason: 'pointer_conflict' })).ok, true);
  assert.equal((await prepared.commit({})).ok, true);
  coordinator.unfence();
  assert.deepEqual(calls.map((call) => call[0]), ['fence', 'apply', 'reconcile', 'commit', 'unfence']);
  assert.equal(JSON.stringify(logs).includes('plugin_runtime_snapshot'), false);
});

test('V6 prepare is invisible until commit and requires exact applied attestation', async () => {
  const calls = [];
  const source = snapshotV6();
  const adapter = {
    apply: async () => { throw new Error('legacy apply must not run'); },
    prepare: async () => (calls.push('prepare'), { ok: true, attestation: attestationV6(source) }),
    abort: async () => (calls.push('abort'), { ok: true }),
    commit: async () => (calls.push('commit'), { ok: true, attestation: attestationV6(source, { applied: true }) }),
    reconcile: async () => ({ ok: true, attestation: attestationV6(source, { applied: true }) }),
  };
  const coordinator = createRuntimeApplyCoordinator({ runtimeAdapter: adapter });
  const prepared = await coordinator.prepare({ compiled: compiled(source), priorRuntime: runtime(source) });
  assert.equal(prepared.ok, true, prepared.reason);
  assert.deepEqual(calls, ['prepare']);
  assert.equal((await prepared.commit({})).ok, true);
  assert.deepEqual(calls, ['prepare', 'commit']);
  const second = await coordinator.prepare({ compiled: compiled(source), priorRuntime: runtime(source) });
  assert.equal((await second.rollback({ reason: 'pointer_failed' })).ok, true);
  assert.deepEqual(calls, ['prepare', 'commit', 'prepare', 'abort']);
});

test('timeout and malformed success are ambiguous and reconcile the prior committed snapshot', async () => {
  for (const apply of [
    async () => new Promise(() => {}),
    async () => ({ ok: true, attestation: { malformed: true } }),
  ]) {
    let repairs = 0;
    const coordinator = createRuntimeApplyCoordinator({
      runtimeAdapter: {
        apply,
        reconcile: async (envelope) => (
          ++repairs,
          { ok: true, attestation: attestation(envelope.plugin_runtime.snapshot) }
        ),
      },
      timeoutMs: 5,
    });
    const priorRuntime = runtime();
    const result = await coordinator.prepare({ compiled: compiled(), priorRuntime });
    assert.equal(result.ok, false);
    assert.equal(result.ambiguous, true);
    assert.equal((await result.reconcile()).ok, true);
    assert.equal(repairs, 1);
  }
});

test('reconciliation requires the same exact attestation contract as candidate apply', async () => {
  const coordinator = createRuntimeApplyCoordinator({
    runtimeAdapter: {
      apply: async () => ({ ok: false, reason: 'runtime_unavailable', ambiguous: true }),
      reconcile: async () => ({ ok: true, attestation: { malformed: true } }),
    },
  });
  const prepared = await coordinator.prepare({ compiled: compiled(), priorRuntime: runtime() });
  assert.equal(prepared.ok, false);
  const repaired = await prepared.reconcile();
  assert.deepEqual(repaired, { ok: false, reason: 'runtime_attestation_invalid' });
});

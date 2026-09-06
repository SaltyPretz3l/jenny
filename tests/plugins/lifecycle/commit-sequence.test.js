'use strict';

// The composed durable commit sequence (commit-sequence.js), exercised
// through its own entry point rather than through W3's individual store
// modules (those have their own suites) or through crash injection (that
// sweep lives in crash-injection.test.js -- deliberately not duplicated
// here). What this file pins down is the sequence's own contract: epoch/
// revision arithmetic, the ONE authority rule ("only the active-pointer flip
// commits"), lease/idempotency fail-closed behavior at the composed entry
// point, and that evidence appends never gate a successful commit.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { runCommitSequence, readCommittedState } = require('../../../services/plugins/lifecycle/commit-sequence');
const { acquireLease } = require('../../../services/plugins/store/mutation-lease');
const { createPendingReceipt } = require('../../../services/plugins/store/operation-receipts');
const {
  BASE_DIR,
  NOW,
  LATER,
  DIGEST_B,
  commitInput,
} = require('../../helpers/plugins/durability-scenario');

test('the first commit on an empty store gets commit_epoch 0, revision 1, and settles at lease_released', async () => {
  const facade = createMemoryFsFacade();
  const result = await runCommitSequence(facade, BASE_DIR, commitInput('gen-0', { operationId: 'op-0', now: NOW }));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.stage, 'lease_released');
  assert.equal(result.commitEpoch, 0);
  assert.equal(result.revision, 1);
  assert.equal(result.generationId, 'gen-0');

  const state = await readCommittedState(facade, BASE_DIR);
  assert.equal(state.pointerStatus, 'ok');
  assert.equal(state.pointer.commit_epoch, 0);
  assert.equal(state.pointer.revision, 1);
});

test('Stage 5B adopts an exact precreated receipt and writes an explicit V3 generation', async () => {
  const facade = createMemoryFsFacade(); const d = (value) => value.repeat(64);
  await createPendingReceipt(facade, BASE_DIR, { operationId: 'op-v3', requestFingerprint: d('a'), generationId: 'gen-v3', lifecycleEpoch: 1, commitEpoch: 0, now: NOW });
  const result = await runCommitSequence(facade, BASE_DIR, { operationId: 'op-v3', requestFingerprint: d('a'), lifecycleEpoch: 1,
    generationId: 'gen-v3', createdAt: NOW, now: NOW, generationSchemaVersion: 3,
    lockDigest: d('1'), distributionStateDigest: d('2'), adoptPendingReceipt: true, expectedGenerationId: null,
    plugins: [{ publisher_id: 'acme', plugin_id: 'alpha', display_name: 'Alpha', resolved_version: '1.0.0', publisher_key_id: d('3'), artifact_digest: d('4'), package_record_digest: d('5'), source_trust_digest: d('6'), advisory_snapshot_digest: d('7'), data_snapshot_digest: d('8'), desired_state: 'installed_disabled', effective_state: 'installed_disabled', remote_binding_digests: [] }],
    policyGrantRef: { policy_snapshot_digest: d('9'), policy_revision: 1, grant_set_digest: d('a'), network_consent_digest: d('b') }, dataSchemaRefs: [] });
  assert.equal(result.ok, true, result.reason); assert.equal((await readCommittedState(facade, BASE_DIR)).generation.generation_schema_version, 3);
});

test('a second commit advances commit_epoch and revision by exactly 1 each', async () => {
  const facade = createMemoryFsFacade();
  const first = await runCommitSequence(facade, BASE_DIR, commitInput('gen-0', { operationId: 'op-0', now: NOW }));
  assert.equal(first.ok, true, first.reason);

  const second = await runCommitSequence(facade, BASE_DIR, commitInput('gen-1', { operationId: 'op-1', now: LATER }));
  assert.equal(second.ok, true, second.reason);
  assert.equal(second.commitEpoch, first.commitEpoch + 1);
  assert.equal(second.revision, first.revision + 1);
});

test('rollback reuse of an earlier generation id is refused by the composed sequence (generation_already_exists), never a stale epoch', async () => {
  const facade = createMemoryFsFacade();
  const toA = await runCommitSequence(facade, BASE_DIR, commitInput('gen-a', { operationId: 'op-a', now: NOW }));
  assert.equal(toA.ok, true, toA.reason);
  assert.equal(toA.commitEpoch, 0);

  const toB = await runCommitSequence(facade, BASE_DIR, commitInput('gen-b', { operationId: 'op-b', now: LATER }));
  assert.equal(toB.ok, true, toB.reason);
  assert.equal(toB.commitEpoch, 1);

  // PLUG-D14's A -> B -> A defense (a rollback must mint a FRESH higher
  // epoch, never an earlier one) is proved end to end directly against
  // commitActivePointer in active-pointer.test.js. THIS composed entry point
  // cannot exercise that path today: step 4 unconditionally calls
  // writeGeneration() with the incoming generationId, and generation-store.js
  // refuses outright to rewrite an existing generation ("a generation is
  // never rewritten in place"). So re-submitting gen-a here fails closed
  // before it ever reaches the pointer flip -- recording that as the
  // sequence's actual observed behavior rather than forcing a fabricated
  // re-point.
  const rollbackAttempt = await runCommitSequence(facade, BASE_DIR, commitInput('gen-a', {
    operationId: 'op-rollback-to-a',
    now: LATER,
  }));
  assert.equal(rollbackAttempt.ok, false);
  assert.equal(rollbackAttempt.stage, 'receipt_pending');
  assert.equal(rollbackAttempt.reason, 'generation_already_exists');

  // The store is untouched by the refused attempt: gen-b is still authoritative.
  const state = await readCommittedState(facade, BASE_DIR);
  assert.equal(state.pointer.generation_id, 'gen-b');
  assert.equal(state.pointer.commit_epoch, 1);
});

test('a second concurrent operation while the lease is held and unexpired is rejected busy', async () => {
  const facade = createMemoryFsFacade();
  const held = await acquireLease(facade, BASE_DIR, { operationId: 'op-holder', now: NOW, leaseDurationMs: 60000 });
  assert.equal(held.ok, true);

  const result = await runCommitSequence(facade, BASE_DIR, commitInput('gen-0', { operationId: 'op-other', now: NOW }));
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'start');
  assert.equal(result.reason, 'busy');
});

test('a duplicate operation_id with a DIFFERENT request fingerprint fails closed', async () => {
  const facade = createMemoryFsFacade();
  const first = await runCommitSequence(facade, BASE_DIR, commitInput('gen-0', { operationId: 'op-dup', now: NOW }));
  assert.equal(first.ok, true, first.reason);

  const second = await runCommitSequence(facade, BASE_DIR, commitInput('gen-1', {
    operationId: 'op-dup',
    now: LATER,
    requestFingerprint: DIGEST_B,
  }));
  assert.equal(second.ok, false);
  assert.equal(second.stage, 'lease_acquired');
  assert.equal(second.reason, 'reject_fingerprint_mismatch');

  const state = await readCommittedState(facade, BASE_DIR);
  assert.equal(state.pointer.generation_id, 'gen-0', 'the rejected replay must not have touched authority');
});

test('evidence append is non-fatal: degradedEvidence is empty on the happy path', async () => {
  const facade = createMemoryFsFacade();
  const result = await runCommitSequence(facade, BASE_DIR, commitInput('gen-0', { operationId: 'op-0', now: NOW }));
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.degradedEvidence, []);
});

test('optional participant prepares after generation write and settles only after pointer commit', async () => {
  const facade = createMemoryFsFacade();
  const events = [];
  const result = await runCommitSequence(facade, BASE_DIR, {
    ...commitInput('gen-participant', { operationId: 'op-participant', now: NOW }),
    participantPrepare: async ({ generation, prior_pointer: priorPointer, next_pointer: nextPointer }) => {
      events.push('prepare');
      assert.equal(generation.generation_id, 'gen-participant');
      assert.equal(priorPointer, null);
      assert.equal(nextPointer.revision, 1);
      assert.equal(nextPointer.commit_epoch, 0);
      return {
        ok: true,
        attestation: { participant_kind: 'sidecar' },
        rollback: async () => (events.push('rollback'), { ok: true }),
        reconcile: async () => (events.push('reconcile'), { ok: true }),
        commit: async ({ pointer }) => {
          events.push('commit');
          const state = await readCommittedState(facade, BASE_DIR);
          assert.equal(state.pointer.generation_id, pointer.generation_id);
          return { ok: true };
        },
      };
    },
  });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(events, ['prepare', 'commit']);
  assert.deepEqual(result.participant, { participant_kind: 'sidecar' });
});

test('participant rejection and all three cancellation checkpoints leave pointer authority unchanged', async () => {
  const rejectedFacade = createMemoryFsFacade();
  const rejected = await runCommitSequence(rejectedFacade, BASE_DIR, {
    ...commitInput('gen-rejected', { operationId: 'op-rejected', now: NOW }),
    participantPrepare: async () => ({ ok: false, reason: 'attestation_rejected' }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'attestation_rejected');
  assert.equal((await readCommittedState(rejectedFacade, BASE_DIR)).pointerStatus, 'missing');

  for (const [checkpoint, cancelAt, expectedStage] of [
    ['pre_receipt', 1, 'idempotency_evaluated'],
    ['post_generation_write', 2, 'generation_written'],
    ['pre_pointer', 3, 'participant_prepared'],
  ]) {
    const facade = createMemoryFsFacade();
    let checks = 0;
    let rollbacks = 0;
    const result = await runCommitSequence(facade, BASE_DIR, {
      ...commitInput(`gen-cancel-${cancelAt}`, { operationId: `op-cancel-${cancelAt}`, now: NOW }),
      isCanceled: () => ++checks >= cancelAt,
      participantPrepare: async () => ({
        ok: true,
        commit: async () => ({ ok: true }),
        rollback: async () => (++rollbacks, { ok: true }),
        reconcile: async () => ({ ok: true }),
      }),
    });
    assert.equal(result.ok, false, checkpoint);
    assert.equal(result.reason, 'operation_canceled', checkpoint);
    assert.equal(result.stage, expectedStage, checkpoint);
    assert.equal(rollbacks, cancelAt === 3 ? 1 : 0, checkpoint);
    assert.equal((await readCommittedState(facade, BASE_DIR)).pointerStatus, 'missing', checkpoint);
  }
});

test('a prepared participant without rollback and reconciliation callbacks never reaches pointer authority', async () => {
  const facade = createMemoryFsFacade();
  const result = await runCommitSequence(facade, BASE_DIR, {
    ...commitInput('gen-invalid-participant', { operationId: 'op-invalid-participant', now: NOW }),
    participantPrepare: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'participant_contract_invalid');
  assert.equal(result.detail.requiresReconciliation, true);
  assert.equal((await readCommittedState(facade, BASE_DIR)).pointerStatus, 'missing');
});

test('a prepared participant without a commit callback never reaches pointer authority', async () => {
  const facade = createMemoryFsFacade();
  const result = await runCommitSequence(facade, BASE_DIR, {
    ...commitInput('gen-no-commit-participant', { operationId: 'op-no-commit-participant', now: NOW }),
    participantPrepare: async () => ({
      ok: true,
      rollback: async () => ({ ok: true }),
      reconcile: async () => ({ ok: true }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'participant_contract_invalid');
  assert.equal((await readCommittedState(facade, BASE_DIR)).pointerStatus, 'missing');
});

test('pointer failure rolls back a prepared participant and reports failed repair as reconciliation-required', async () => {
  for (const rollbackOk of [true, false]) {
    const facade = createMemoryFsFacade();
    let reconciliations = 0;
    const result = await runCommitSequence(facade, BASE_DIR, {
      ...commitInput(`gen-pointer-${rollbackOk}`, { operationId: `op-pointer-${rollbackOk}`, now: NOW }),
      participantPrepare: async () => {
        // Simulate lease ownership loss at the last-instant guard.
        await facade.remove(`${BASE_DIR}/mutation-lease.json`);
        return {
          ok: true,
          commit: async () => ({ ok: true }),
          rollback: async () => ({ ok: rollbackOk }),
          reconcile: async () => (++reconciliations, { ok: false }),
        };
      },
    });
    assert.equal(result.ok, false);
    assert.equal((await readCommittedState(facade, BASE_DIR)).pointerStatus, 'missing');
    if (rollbackOk) {
      assert.equal(result.reason, 'lease_not_held');
      assert.equal(result.detail.requiresReconciliation, false);
      assert.equal(reconciliations, 0);
    } else {
      assert.equal(result.reason, 'participant_rollback_failed');
      assert.equal(result.detail.requiresReconciliation, true);
      assert.equal(reconciliations, 1);
    }
  }
});

test('readCommittedState reports the pointer and its pointed-at generation in agreement', async () => {
  const facade = createMemoryFsFacade();
  const committed = await runCommitSequence(facade, BASE_DIR, commitInput('gen-0', { operationId: 'op-0', now: NOW }));
  assert.equal(committed.ok, true, committed.reason);

  const state = await readCommittedState(facade, BASE_DIR);
  assert.equal(state.pointerStatus, 'ok');
  assert.equal(state.generationError, null);
  assert.equal(state.generation.generation_id, state.pointer.generation_id);
  assert.equal(state.pointer.generation_digest, state.generation.graph_hash);
});

// The stage fence, ON the funnel. These exist because an audit proved the
// fence was NOT structural: `runCommitSequence` is exported and callable
// directly, `PluginGenerationV1.effective_state` is an enum over all nine
// lifecycle states, and the three lifecycle call sites all run
// `filterToDisabledOnly` -- a NORMALIZER, not a validator -- immediately
// before their `assertStagePermitsState` call. Because the normalizer's output
// can never be a forbidden state, those asserts could never throw. Stage 4A
// now permits durable `active`, but transitional states must remain transient
// and must still be rejected at this funnel.
//
// These tests drive the entry point RAW (no normalizer) precisely because that
// is the unfenced path a fourth lifecycle operation reaching for the durable
// core would take.
const STAGE_FORBIDDEN_SAMPLE = ['preparing', 'disabling'];

test('the commit sequence refuses a stage-forbidden state passed directly, before taking the lease', async () => {
  for (const state of STAGE_FORBIDDEN_SAMPLE) {
    const facade = createMemoryFsFacade();
    const input = commitInput(`gen-${state}`, { operationId: `op-${state}` });
    // Bypass the helper's default: this is the raw, un-normalized entry.
    input.plugins = [{ ...input.plugins[0], desired_state: state, effective_state: state }];

    const result = await runCommitSequence(facade, BASE_DIR, input);

    assert.equal(result.ok, false, `${state} must be refused`);
    assert.equal(result.reason, 'stage_forbids_state');
    assert.equal(result.stage, 'start', 'refusal must precede the lease');
    assert.equal(result.detail.state, state);

    // A refusal at 'start' is a TRUE no-op: no lease, no receipt, no orphan
    // generation bytes for GC to reclaim. Counted, not assumed.
    assert.equal(facade.callCounts.writeFile, 0, 'a refused commit writes nothing');
    assert.equal(facade.callCounts.renameFile, 0, 'a refused commit renames nothing');

    const state_ = await readCommittedState(facade, BASE_DIR);
    assert.equal(state_.pointerStatus, 'missing', 'nothing was committed');
  }
});

test('one stage-forbidden entry refuses the whole commit, even alongside permitted ones', async () => {
  // Partial commits are the failure mode that matters: a graph that committed
  // the disabled entries and dropped the forbidden one would look successful
  // while silently losing a plugin.
  const facade = createMemoryFsFacade();
  const input = commitInput('gen-mixed', { operationId: 'op-mixed' });
  input.plugins = [
    { ...input.plugins[0], plugin_id: 'alpha' },
    { ...input.plugins[0], plugin_id: 'beta', desired_state: 'preparing', effective_state: 'preparing' },
  ];

  const result = await runCommitSequence(facade, BASE_DIR, input);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stage_forbids_state');
  assert.equal(result.detail.pluginId, 'beta', 'the refusal names the offending entry');
  assert.equal(facade.callCounts.writeFile, 0);
});

test('the permitted state still commits, so the fence is not simply refusing everything', async () => {
  // Without this, both tests above would pass against a fence that rejected
  // every input -- the classic way a guard test proves nothing.
  const facade = createMemoryFsFacade();
  const result = await runCommitSequence(facade, BASE_DIR, commitInput('gen-ok', { operationId: 'op-ok' }));
  assert.equal(result.ok, true, result.reason);
  const committed = await readCommittedState(facade, BASE_DIR);
  assert.equal(committed.generation.plugins[0].effective_state, 'installed_disabled');
});

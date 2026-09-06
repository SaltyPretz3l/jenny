'use strict';

// uninstallPlugin. The one property everything else here supports: authority
// removal and physical cleanup are ORTHOGONAL (PLUG-D17, invariant 20). A
// cleanup that fails in every way this module can observe still leaves the
// uninstall committed, and content still reachable from a retained generation
// is never deleted.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { putContent, hasContent, sha256Hex } = require('../../../services/plugins/store/content-store');
const { readCleanupState } = require('../../../services/plugins/store/cleanup-state');
const { packageRecordPath, readPackageRecord } = require('../../../services/plugins/store/package-record-store');
const { runCommitSequence, readCommittedState } = require('../../../services/plugins/lifecycle/commit-sequence');
const { CLEANUP_ONLY_STATUSES } = require('../../../services/plugins/lifecycle/operation-result');
const { installPackage } = require('../../../services/plugins/lifecycle/install-operation');
const {
  uninstallPlugin,
  reclaimUnreachableContent,
  CLEANUP_FAILURE_WIRE_CODES,
} = require('../../../services/plugins/lifecycle/uninstall-operation');
const { resolvePluginsSafeMode, SAFE_MODE_SWITCH } = require('../../../services/plugins/safe-mode');
const { PLUGIN_ERROR_CODES } = require('../../../services/backend/error-codes');
const { createVerifiedPackageVerifier, commitInput } = require('../../helpers/plugins/durability-scenario');

const BASE_DIR = 'plugins';
const NOW = '2026-07-31T00:00:00Z';
const POLICY_GRANT_REF = Object.freeze({
  policy_snapshot_digest: 'b'.repeat(64),
  policy_revision: 1,
  grant_set_digest: 'c'.repeat(64),
});
const DATA_SCHEMA_REFS = Object.freeze([{ domain: 'alpha_state', schema_version: 1 }]);

const consentOk = async () => ({ ok: true });

function idGenerator(prefix) {
  let index = 0;
  return () => {
    index += 1;
    return `${prefix}-${index}`;
  };
}

async function install(facade, { pluginId, bytes, generationId, prefix }) {
  const outcome = await installPackage(facade, BASE_DIR, {
    packageBytes: bytes,
    publisherId: 'acme',
    pluginId,
    verifyPackage: createVerifiedPackageVerifier({ publisherId: 'acme', pluginId, now: NOW }),
    requireConsent: consentOk,
    newOperationId: idGenerator(prefix),
    now: NOW,
    lifecycleEpoch: 1,
    generationId,
    policyGrantRef: POLICY_GRANT_REF,
    dataSchemaRefs: DATA_SCHEMA_REFS,
  });
  assert.equal(outcome.ok, true, `setup install failed: ${outcome.reason || ''}`);
  return outcome;
}

function uninstallArgs(overrides = {}) {
  return {
    publisherId: 'acme',
    pluginId: 'alpha',
    requireConsent: consentOk,
    newOperationId: idGenerator('op-uninstall'),
    now: NOW,
    lifecycleEpoch: 1,
    generationId: 'gen-removed',
    policyGrantRef: POLICY_GRANT_REF,
    dataSchemaRefs: DATA_SCHEMA_REFS,
    ...overrides,
  };
}

function corruptReceiptAfterPointerFlip(facade, operationId) {
  const renameFile = facade.renameFile.bind(facade);
  facade.renameFile = async (oldPath, newPath) => {
    await renameFile(oldPath, newPath);
    if (newPath === `${BASE_DIR}/active-generation.json`) {
      await facade.writeFile(`${BASE_DIR}/operations/${operationId}.json`, '{corrupt');
    }
  };
}

test('uninstall commits a generation without the plugin and records cleanup', async () => {
  const facade = createMemoryFsFacade();
  await install(facade, { pluginId: 'alpha', bytes: 'alpha-bytes', generationId: 'gen-1', prefix: 'op-install' });

  const outcome = await uninstallPlugin(facade, BASE_DIR, uninstallArgs());
  assert.equal(outcome.ok, true, outcome.reason || '');
  assert.equal(outcome.result.status, 'committed');
  assert.equal(outcome.result.authority_state_before, 'installed_disabled');
  assert.equal(outcome.result.authority_state_after, 'absent');
  assert.equal(outcome.result.cleanup_status, 'complete');
  assert.deepEqual(outcome.result.cleanup_target, { kind: 'absent' });

  const state = await readCommittedState(facade, BASE_DIR);
  assert.equal(state.pointer.generation_id, 'gen-removed');
  assert.deepEqual(state.generation.plugins, []);

  const cleanup = await readCleanupState(facade, BASE_DIR, 'acme', 'alpha');
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.state.cleanup_status, 'complete');
  assert.deepEqual(cleanup.state.cleanup_target, { kind: 'absent' });
  assert.equal(cleanup.state.commit_epoch, outcome.commitEpoch);
});

test('a failed settling marker write blocks physical cleanup and reports retryable cleanup', async () => {
  const facade = createMemoryFsFacade();
  await install(facade, { pluginId: 'alpha', bytes: 'alpha-bytes', generationId: 'gen-1', prefix: 'op-install' });
  const orphan = await putContent(facade, BASE_DIR, 'orphaned-staging-bytes');
  const renameFile = facade.renameFile.bind(facade);
  const removeTreesBefore = facade.callCounts.removeTree;
  let markerWriteFailures = 0;
  let terminationCalls = 0;
  facade.renameFile = async (oldPath, newPath) => {
    if (newPath === `${BASE_DIR}/data/acme/alpha/cleanup-state.json` && markerWriteFailures === 0) {
      markerWriteFailures += 1;
      throw new Error('injected settling marker failure');
    }
    return renameFile(oldPath, newPath);
  };

  const outcome = await uninstallPlugin(facade, BASE_DIR, uninstallArgs({
    terminateResources: async () => {
      terminationCalls += 1;
      return { ok: true };
    },
  }));

  assert.equal(markerWriteFailures, 1);
  assert.equal(terminationCalls, 0, 'resource termination must not begin without a durable marker');
  assert.equal(facade.callCounts.removeTree, removeTreesBefore, 'settings cleanup must not begin without a marker');
  assert.equal(await hasContent(facade, BASE_DIR, orphan.digest), true, 'blob reclamation must not begin without a marker');
  assert.equal(outcome.result.cleanup_status, 'pending_restart');
  assert.notEqual(outcome.result.cleanup_status, 'complete');
  assert.equal(outcome.cleanupWireCode, PLUGIN_ERROR_CODES.CLEANUP_PENDING_RESTART);

  const cleanup = await readCleanupState(facade, BASE_DIR, 'acme', 'alpha');
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.state.cleanup_status, 'pending_restart');
  assert.equal(cleanup.state.cleanup_detail.retryable, true);
});

test('active uninstall requires participant withdrawal and commits absence before cleanup', async () => {
  const facade = createMemoryFsFacade();
  await install(facade, { pluginId: 'alpha', bytes: 'alpha-bytes', generationId: 'gen-1', prefix: 'op-install' });
  const installed = await readCommittedState(facade, BASE_DIR);
  const activeInput = commitInput('gen-active', {
    operationId: 'op-activate-direct',
    now: NOW,
    plugins: installed.generation.plugins.map((entry) => ({ ...entry, desired_state: 'active', effective_state: 'active' })),
  });
  assert.equal((await runCommitSequence(facade, BASE_DIR, { ...activeInput, controlPlaneStage: 4 })).ok, true);

  const refused = await uninstallPlugin(facade, BASE_DIR, uninstallArgs({
    generationId: 'gen-refused-active-uninstall',
    controlPlaneStage: 4,
  }));
  assert.equal(refused.reason, 'runtime_participant_unavailable');
  assert.equal((await readCommittedState(facade, BASE_DIR)).generation.plugins[0].effective_state, 'active');

  const events = [];
  const removed = await uninstallPlugin(facade, BASE_DIR, uninstallArgs({
    generationId: 'gen-active-removed',
    controlPlaneStage: 4,
    participantPrepare: async ({ generation }) => {
      assert.deepEqual(generation.plugins, []);
      events.push('prepare');
      return {
        ok: true,
        rollback: async () => (events.push('rollback'), { ok: true }),
        reconcile: async () => (events.push('reconcile'), { ok: true }),
        commit: async () => (events.push('commit'), { ok: true }),
      };
    },
  }));
  assert.equal(removed.ok, true, removed.reason || 'active uninstall failed');
  assert.deepEqual((await readCommittedState(facade, BASE_DIR)).generation.plugins, []);
  assert.deepEqual(events, ['prepare', 'commit']);
});

test('uninstalling an absent plugin is idempotent-successful, not an error', async () => {
  const facade = createMemoryFsFacade();
  const outcome = await uninstallPlugin(facade, BASE_DIR, uninstallArgs({ pluginId: 'ghost' }));

  assert.equal(outcome.ok, true);
  assert.equal(outcome.idempotent, true);
  assert.equal(outcome.committed, false, 'no epoch may be burned to change nothing');
  assert.equal(outcome.result.status, 'committed');
  assert.equal(outcome.result.authority_state_before, 'absent');
  assert.equal(outcome.result.authority_state_after, 'absent');
  assert.equal(outcome.result.cleanup_status, 'not_required');

  // And again after a real install+uninstall: the second call is still success.
  await install(facade, { pluginId: 'alpha', bytes: 'alpha-bytes', generationId: 'gen-1', prefix: 'op-install' });
  const first = await uninstallPlugin(facade, BASE_DIR, uninstallArgs());
  assert.equal(first.committed, true);
  const second = await uninstallPlugin(facade, BASE_DIR, uninstallArgs({ generationId: 'gen-again' }));
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
});

test('a failed cleanup leaves the uninstall COMMITTED', async () => {
  for (const [status, wireCode] of [
    ['termination_failed', PLUGIN_ERROR_CODES.CLEANUP_TERMINATION_FAILED],
    ['pending_restart', PLUGIN_ERROR_CODES.CLEANUP_PENDING_RESTART],
  ]) {
    const facade = createMemoryFsFacade();
    await install(facade, { pluginId: 'alpha', bytes: 'alpha-bytes', generationId: 'gen-1', prefix: 'op-install' });

    const outcome = await uninstallPlugin(facade, BASE_DIR, uninstallArgs({
      terminateResources: async () => ({ ok: false, status, reason: 'worker would not die' }),
    }));

    assert.equal(outcome.ok, true, `${status}: authority must still be committed`);
    assert.equal(outcome.result.status, 'committed');
    assert.equal(outcome.result.authority_state_after, 'absent');
    assert.equal(outcome.result.cleanup_status, status);
    assert.equal(outcome.cleanupWireCode, wireCode);
    assert.equal(CLEANUP_FAILURE_WIRE_CODES[status], wireCode);

    // The store agrees: the plugin is gone from authority regardless.
    const state = await readCommittedState(facade, BASE_DIR);
    assert.equal(state.pointer.generation_id, 'gen-removed');
    assert.deepEqual(state.generation.plugins, []);

    const cleanup = await readCleanupState(facade, BASE_DIR, 'acme', 'alpha');
    assert.equal(cleanup.state.cleanup_status, status);
    assert.equal(cleanup.state.cleanup_detail.retryable, true);
  }
});

test('a THROWN cleanup failure also leaves the uninstall committed', async () => {
  const facade = createMemoryFsFacade();
  await install(facade, { pluginId: 'alpha', bytes: 'alpha-bytes', generationId: 'gen-1', prefix: 'op-install' });
  const outcome = await uninstallPlugin(facade, BASE_DIR, uninstallArgs({
    terminateResources: async () => { throw new Error('sidecar refused to stop'); },
  }));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.status, 'committed');
  assert.equal(outcome.result.cleanup_status, 'termination_failed');
  assert.deepEqual((await readCommittedState(facade, BASE_DIR)).generation.plugins, []);
});

test('a cleanup status is never reported as an authority state', async () => {
  const facade = createMemoryFsFacade();
  await install(facade, { pluginId: 'alpha', bytes: 'alpha-bytes', generationId: 'gen-1', prefix: 'op-install' });
  const outcome = await uninstallPlugin(facade, BASE_DIR, uninstallArgs({
    terminateResources: async () => ({ ok: false, status: 'termination_failed' }),
  }));
  for (const field of ['authority_state_before', 'authority_state_after']) {
    assert.ok(
      !CLEANUP_ONLY_STATUSES.includes(outcome.result[field]),
      `${field} carried a cleanup-only status`
    );
  }
});

test('content reachable from a retained generation survives; true orphans are reclaimed', async () => {
  const facade = createMemoryFsFacade();
  const retainedBytes = 'alpha-package-bytes';
  const retainedDigest = sha256Hex(retainedBytes);
  await install(facade, { pluginId: 'alpha', bytes: retainedBytes, generationId: 'gen-1', prefix: 'op-a' });
  await install(facade, { pluginId: 'beta', bytes: 'beta-package-bytes', generationId: 'gen-2', prefix: 'op-b' });

  // An abandoned staging blob that no generation has ever referenced.
  const orphan = await putContent(facade, BASE_DIR, 'abandoned-staging-bytes');
  assert.equal(orphan.ok, true);

  const outcome = await uninstallPlugin(facade, BASE_DIR, uninstallArgs());
  assert.equal(outcome.ok, true, outcome.reason || '');

  assert.equal(
    await hasContent(facade, BASE_DIR, retainedDigest),
    true,
    'a digest still reachable from a retained/active generation must survive'
  );
  assert.ok(outcome.reclaimed.includes(orphan.digest), 'the true orphan must be reclaimed');
  assert.ok(!outcome.reclaimed.includes(retainedDigest), 'the retained digest must never be planned for deletion');
  assert.equal(await hasContent(facade, BASE_DIR, orphan.digest), false);
  assert.deepEqual(outcome.reclaimFailed, []);
});

test('a post-pointer receipt failure keeps uninstall authority and cleanup truthful', async () => {
  const facade = createMemoryFsFacade();
  await install(facade, { pluginId: 'alpha', bytes: 'alpha-bytes', generationId: 'gen-1', prefix: 'op-install' });
  corruptReceiptAfterPointerFlip(facade, 'op-uninstall-1');

  const outcome = await uninstallPlugin(facade, BASE_DIR, uninstallArgs());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.committed, true);
  assert.equal(outcome.wireCode, PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE);
  assert.equal(outcome.result.status, 'indeterminate');
  assert.equal(outcome.result.authority_state_before, 'installed_disabled');
  assert.equal(outcome.result.authority_state_after, 'absent');
  assert.deepEqual((await readCommittedState(facade, BASE_DIR)).generation.plugins, []);
});

test('an unreadable retained generation blocks all garbage collection', async () => {
  const facade = createMemoryFsFacade();
  await install(facade, { pluginId: 'alpha', bytes: 'alpha-bytes', generationId: 'gen-1', prefix: 'op-install' });
  const orphan = await putContent(facade, BASE_DIR, 'unknown-retained-bytes');
  await facade.mkdir(`${BASE_DIR}/generations/gen-corrupt`);
  await facade.writeFile(`${BASE_DIR}/generations/gen-corrupt/control-plane.json`, '{corrupt');

  const outcome = await uninstallPlugin(facade, BASE_DIR, uninstallArgs());
  assert.equal(outcome.result.authority_state_after, 'absent');
  assert.equal(outcome.result.cleanup_status, 'pending_restart');
  assert.equal(await hasContent(facade, BASE_DIR, orphan.digest), true);
  assert.ok(outcome.reclaimFailed.some((item) => item.error === 'retained_generation_unreadable'));
});

test('a thrown retained-generation collection failure leaves a committed pending cleanup', async () => {
  const facade = createMemoryFsFacade();
  await install(facade, { pluginId: 'alpha', bytes: 'alpha-bytes', generationId: 'gen-1', prefix: 'op-install' });
  const list = facade.list.bind(facade);
  facade.list = async (targetPath) => {
    if (targetPath === `${BASE_DIR}/generations`) throw new Error('private collection detail');
    return list(targetPath);
  };

  const outcome = await uninstallPlugin(facade, BASE_DIR, uninstallArgs());
  assert.equal(outcome.ok, true);
  assert.equal(outcome.committed, true);
  assert.equal(outcome.result.authority_state_after, 'absent');
  assert.equal(outcome.result.cleanup_status, 'pending_restart');
  assert.deepEqual(outcome.reclaimFailed, [{ error: 'retained_generation_collection_failed' }]);
  assert.doesNotMatch(JSON.stringify(outcome), /private collection detail/);
  assert.deepEqual((await readCommittedState(facade, BASE_DIR)).generation.plugins, []);
  assert.equal((await readCleanupState(facade, BASE_DIR, 'acme', 'alpha')).state.cleanup_status,
    'pending_restart');
});

test('package-record deletion failure preserves the blob so a later cleanup can converge', async () => {
  const facade = createMemoryFsFacade();
  const bytes = 'retryable-package-bytes';
  const digest = sha256Hex(bytes);
  await install(facade, { pluginId: 'alpha', bytes, generationId: 'gen-1', prefix: 'op-install' });
  const recordPath = packageRecordPath(BASE_DIR, digest);
  const remove = facade.remove.bind(facade);
  let failRecordRemoval = true;
  facade.remove = async (targetPath) => {
    if (failRecordRemoval && targetPath === recordPath) throw new Error('injected record removal failure');
    return remove(targetPath);
  };

  const first = await reclaimUnreachableContent(facade, BASE_DIR, {
    activeGeneration: null,
    retainedGenerations: [],
  });
  assert.equal(first.failed.length, 1);
  assert.equal(await hasContent(facade, BASE_DIR, digest), true, 'blob remains discoverable for retry');
  assert.equal((await readPackageRecord(facade, BASE_DIR, digest)).ok, true);

  failRecordRemoval = false;
  const second = await reclaimUnreachableContent(facade, BASE_DIR, {
    activeGeneration: null,
    retainedGenerations: [],
  });
  assert.deepEqual(second.failed, []);
  assert.deepEqual(second.removed, [digest]);
  assert.equal(await hasContent(facade, BASE_DIR, digest), false);
  assert.equal((await readPackageRecord(facade, BASE_DIR, digest)).reason, 'package_record_not_found');
});

test('safe mode and the default-deny consent both refuse an uninstall without writing', async () => {
  const facade = createMemoryFsFacade();
  await install(facade, { pluginId: 'alpha', bytes: 'alpha-bytes', generationId: 'gen-1', prefix: 'op-install' });
  const writesBefore = facade.callCounts.writeFile + facade.callCounts.renameFile + facade.callCounts.remove;

  const safeMode = resolvePluginsSafeMode({ argv: [SAFE_MODE_SWITCH] });
  const refusedBySafeMode = await uninstallPlugin(facade, BASE_DIR, uninstallArgs({ safeMode }));
  assert.equal(refusedBySafeMode.reason, 'safe_mode_active');
  assert.equal(refusedBySafeMode.wireCode, PLUGIN_ERROR_CODES.SAFE_MODE_ACTIVE);

  const args = uninstallArgs();
  delete args.requireConsent;
  const refusedByConsent = await uninstallPlugin(facade, BASE_DIR, args);
  assert.equal(refusedByConsent.reason, 'consent_not_configured');
  assert.equal(refusedByConsent.wireCode, PLUGIN_ERROR_CODES.CONSENT_REQUIRED);

  assert.equal(
    facade.callCounts.writeFile + facade.callCounts.renameFile + facade.callCounts.remove,
    writesBefore,
    'a refused uninstall must not write'
  );
  assert.equal((await readCommittedState(facade, BASE_DIR)).generation.plugins.length, 1);
});

test('a caller-supplied operation id is rejected on the uninstall path too', async () => {
  const facade = createMemoryFsFacade();
  await install(facade, { pluginId: 'alpha', bytes: 'alpha-bytes', generationId: 'gen-1', prefix: 'op-install' });
  const outcome = await uninstallPlugin(facade, BASE_DIR, uninstallArgs({ operationId: 'op-attacker' }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'caller_supplied_operation_id');
  assert.equal((await readCommittedState(facade, BASE_DIR)).generation.plugins.length, 1);
});

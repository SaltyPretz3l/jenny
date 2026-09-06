'use strict';

// The Stage-3 disabled-only uninstall operation.
//
// The property this file is written to defend is PLUG-D17, invariant 20:
// **authority removal and physical cleanup are orthogonal**. Authority is gone
// the instant the active pointer flips to a generation that no longer lists the
// plugin. Deleting bytes, terminating a process, and reclaiming content are
// best-effort work that happens AFTERWARDS and can fail freely: a failed
// cleanup returns CLEANUP_TERMINATION_FAILED / CLEANUP_PENDING_RESTART and
// leaves the uninstall committed. There is deliberately no code path here that
// un-commits authority because cleanup failed, and assertCleanupOrthogonality
// (operation-result.js) is called on the way out to prove it rather than assert
// it in a comment.
//
// Two more rules encoded here:
//
//   Uninstalling an absent plugin is idempotent-SUCCESSFUL. The caller's intent
//   ("this plugin should not be installed") is already true, and a store that
//   errors on that forces every caller to pre-check, which is a race.
//
//   Content reclamation NEVER deletes directly. It routes through gc.js's
//   plan/execute with a reachable set that includes every retained generation,
//   because rollback re-points at an existing generation (PLUG-D14) and that
//   generation's content must still exist. In Stage 3 every on-disk generation
//   is retained -- there is no retention pruning yet -- so uninstall reclaims
//   only true orphans. Bytes belonging to the superseded generation become
//   collectable when a later stage prunes retention, not here.

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { listGenerationIds, readGeneration } = require('../store/generation-store');
const { computeReachableDigests, planGarbageCollection, executeGarbageCollection } = require('../store/gc');
const { removePackageRecord } = require('../store/package-record-store');
const { buildCleanupState, writeCleanupState, readCleanupState, transitionCleanupState } = require('../store/cleanup-state');
const { runCommitSequence } = require('./commit-sequence');
const { wireCodeFor, assertCleanupOrthogonality } = require('./operation-result');
const {
  CONTROL_PLANE_STAGE,
  DISABLED_ONLY_STATE,
  assertStagePermitsState,
  filterToDisabledOnly,
} = require('./stage-gate');
const { safeModeRefusal } = require('../safe-mode');
const { pluginSettingsDir } = require('../paths/store-paths');
const {
  DENY_CONSENT,
  buildRequestFingerprint,
  mintOperationId,
  rejectCallerOperationId,
  createEmitter,
  readAuthoritySnapshot,
  cancellationRequested,
  settle,
  refuse,
} = require('./install-operation');

// Cleanup outcomes that are failures of PHYSICAL work only. Neither may ever
// appear as an authority state -- operation-result.js rejects that structurally.
const CLEANUP_FAILURE_WIRE_CODES = Object.freeze({
  termination_failed: PLUGIN_ERROR_CODES.CLEANUP_TERMINATION_FAILED,
  pending_restart: PLUGIN_ERROR_CODES.CLEANUP_PENDING_RESTART,
});

// Every generation still on disk is retained in Stage 3 (see header). Callers
// may narrow this once retention pruning exists.
async function collectRetainedGenerations(facade, baseDir, { retainedGenerationIds = null } = {}) {
  const ids = retainedGenerationIds === null
    ? await listGenerationIds(facade, baseDir)
    : retainedGenerationIds;
  const records = [];
  for (const generationId of ids) {
    const read = await readGeneration(facade, baseDir, generationId);
    // Missing/corrupt retained evidence makes the reachable set unknowable.
    // Skipping it would make GC bolder, so stop before planning any deletion.
    if (!read.ok) {
      return {
        ok: false,
        reason: 'retained_generation_unreadable',
        generationId,
        detail: read.reason || null,
      };
    }
    records.push(read.record);
  }
  return { ok: true, records };
}

// Best-effort physical reclamation. Returns a bounded report; never throws for
// a domain reason, and never touches authority state.
async function reclaimUnreachableContent(facade, baseDir, { activeGeneration, retainedGenerations }) {
  const reachable = computeReachableDigests({ activeGeneration, retainedGenerations });
  const plan = await planGarbageCollection(facade, baseDir, { reachableDigests: reachable });
  const recordFailures = [];
  const blobCandidates = [];
  for (const digest of plan.toDelete) {
    try {
      const removed = await removePackageRecord(facade, baseDir, digest);
      if (removed.ok) blobCandidates.push(digest);
      else recordFailures.push({ digest, error: removed.reason });
    } catch (error) {
      recordFailures.push({ digest, error: (error && error.message) || String(error) });
    }
  }
  // Record first, blob second. Either failure leaves the blob discoverable by
  // the next GC plan, so cleanup retries can converge.
  const executablePlan = { ...plan, toDelete: blobCandidates };
  const executed = await executeGarbageCollection(facade, baseDir, { plan: executablePlan });
  return { plan, removed: executed.removed, failed: [...recordFailures, ...executed.failed] };
}

// Records the orthogonal cleanup state (store/cleanup-state.js). A stale record
// never overwrites a newer one -- transitionCleanupState owns that check.
async function recordCleanup(facade, baseDir, { publisherId, pluginId, cleanupStatus, lifecycleEpoch, commitEpoch, detail }) {
  const next = buildCleanupState({
    cleanupStatus,
    cleanupTarget: { kind: 'absent' },
    lifecycleEpoch,
    commitEpoch,
    cleanupDetail: detail,
  });
  const existing = await readCleanupState(facade, baseDir, publisherId, pluginId);
  const transition = transitionCleanupState(existing.ok ? existing.state : null, next);
  if (!transition.ok) {
    return { ok: false, reason: transition.reason };
  }
  try {
    const written = await writeCleanupState(facade, baseDir, publisherId, pluginId, transition.state);
    return written.ok ? { ok: true, state: written.state } : { ok: false, reason: written.reason };
  } catch (error) {
    // A cleanup-record write failure is itself cleanup work, so it degrades the
    // cleanup status and nothing else. Authority stays exactly where it is.
    return { ok: false, reason: 'cleanup_record_write_failed', error: (error && error.message) || String(error) };
  }
}

async function uninstallPlugin(facade, baseDir, options = {}) {
  const {
    publisherId,
    pluginId,
    requireConsent = DENY_CONSENT,
    newOperationId,
    clientRequestId = null,
    safeMode = { active: false, source: 'none' },
    now,
    createdAt = now,
    lifecycleEpoch = 0,
    generationId,
    policyGrantRef,
    dataSchemaRefs = [],
    terminateResources = null,
    retainedGenerationIds = null,
    progressLog = null,
    leaseDurationMs,
    isCanceled = null,
    participantPrepare = null,
    controlPlaneStage = CONTROL_PLANE_STAGE,
  } = options;

  if (safeMode && safeMode.active) {
    return safeModeRefusal(safeMode);
  }
  const callerId = rejectCallerOperationId(options);
  if (!callerId.ok) {
    return refuse('start', callerId.reason, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
  }
  const minted = mintOperationId(newOperationId);
  if (!minted.ok) {
    return refuse('start', minted.reason, PLUGIN_ERROR_CODES.POLICY_BLOCKED, { detail: minted.detail || null });
  }
  const operationId = minted.operationId;

  const consent = await requireConsent({ operation: 'uninstall', publisherId, pluginId, operationId });
  if (cancellationRequested(isCanceled)) {
    return refuse('canceled', 'operation_canceled', PLUGIN_ERROR_CODES.FEATURE_DISABLED, { operationId });
  }
  if (!consent || consent.ok !== true) {
    return refuse('consent', (consent && consent.reason) || 'consent_denied', (consent && consent.code) || PLUGIN_ERROR_CODES.CONSENT_REQUIRED, { operationId });
  }

  const snapshot = await readAuthoritySnapshot(facade, baseDir, { publisherId, pluginId });
  if (cancellationRequested(isCanceled)) {
    return refuse('canceled', 'operation_canceled', PLUGIN_ERROR_CODES.FEATURE_DISABLED, { operationId });
  }
  if (!snapshot.ok) {
    return refuse('read_authority', snapshot.reason, wireCodeFor(snapshot.reason) || null, { operationId });
  }
  const authorityStateBefore = snapshot.authorityState;

  const requestFingerprint = buildRequestFingerprint({
    operation: 'uninstall',
    publisherId,
    pluginId,
    contentDigest: null,
    clientRequestId,
    lifecycleEpoch,
  });
  const emitter = createEmitter({
    operationId,
    lifecycleEpoch,
    binding: { commit_epoch: snapshot.commitEpoch },
    log: progressLog,
  });

  // Idempotent-successful removal of an already-absent plugin. No lease, no
  // receipt, no generation: there is nothing to commit, and inventing a commit
  // would burn an epoch to change nothing.
  if (!snapshot.entry) {
    emitter.terminal(now, 'committed', false);
    return settle('absent', true, {
      operationId,
      requestFingerprint,
      status: 'committed',
      authorityStateBefore: 'absent',
      authorityStateAfter: 'absent',
      authorityStateCommitted: 'absent',
      cleanupStatus: 'not_required',
      cleanupTarget: { kind: 'absent' },
      settledAt: now,
    }, { operationId, idempotent: true, committed: false, cleanupStatus: 'not_required' });
  }

  if (snapshot.entry.effective_state === 'active' && typeof participantPrepare !== 'function') {
    return refuse('runtime', 'runtime_participant_unavailable', PLUGIN_ERROR_CODES.POLICY_BLOCKED, { operationId });
  }

  emitter.phase(now, 'committing');
  const survivors = snapshot.plugins.filter((item) => !(item.publisher_id === publisherId && item.plugin_id === pluginId));
  const remaining = controlPlaneStage >= 4 ? { plugins: survivors } : filterToDisabledOnly(survivors);
  for (const entry of remaining.plugins) {
    assertStagePermitsState(entry.effective_state, { stage: controlPlaneStage });
  }
  // 'absent' is the state this operation commits FOR THE SUBJECT: it is simply
  // no longer listed in the new generation.
  if (controlPlaneStage < 4) assertStagePermitsState('absent', { stage: controlPlaneStage });

  const committed = await runCommitSequence(facade, baseDir, {
    operationId,
    requestFingerprint,
    lifecycleEpoch,
    generationId,
    createdAt,
    plugins: remaining.plugins,
    policyGrantRef,
    dataSchemaRefs,
    now,
    auditAction: 'uninstall',
    auditActor: { kind: 'user' },
    participantPrepare,
    isCanceled,
    controlPlaneStage,
    generationSchemaVersion: snapshot.generation.generation_schema_version,
    ...(snapshot.generation.lock_digest
      ? { lockDigest: snapshot.generation.lock_digest } : {}),
    ...(snapshot.generation.distribution_state_digest
      ? { distributionStateDigest: snapshot.generation.distribution_state_digest } : {}),
    ...(leaseDurationMs === undefined ? {} : { leaseDurationMs }),
  });

  const commitEvidenceDegraded = !committed.ok && committed.committed === true;
  if (!committed.ok && !commitEvidenceDegraded) {
    emitter.terminal(now, 'failed', false);
    return settle('commit', false, {
      operationId,
      requestFingerprint,
      status: 'failed',
      authorityStateBefore,
      authorityStateAfter: authorityStateBefore,
      authorityStateCommitted: authorityStateBefore,
      cleanupStatus: 'not_required',
      cleanupTarget: { kind: DISABLED_ONLY_STATE },
      settledAt: now,
      failureReason: committed.reason,
    }, {
      wireCode: wireCodeFor(committed.reason) || null,
      commitStage: committed.stage,
      commitReason: committed.reason,
      requiresReconciliation: committed.detail?.requiresReconciliation === true,
    });
  }

  // ---- Authority is now gone. Everything below is best-effort. ----
  emitter.phase(now, 'cleanup');

  let cleanupStatus = 'complete';
  let cleanupReasonCode = 'cleanup_complete';
  const settingsCleanupFailures = [];
  let reclaim = { plan: { toDelete: [], toKeep: [] }, removed: [], failed: [] };

  const settlingRecorded = await recordCleanup(facade, baseDir, {
    publisherId,
    pluginId,
    cleanupStatus: 'settling',
    lifecycleEpoch,
    commitEpoch: committed.commitEpoch,
    detail: {
      code: 'cleanup_settling',
      retryable: true,
    },
  });
  if (!settlingRecorded.ok) {
    cleanupStatus = 'pending_restart';
    cleanupReasonCode = settlingRecorded.reason || 'cleanup_record_write_failed';
  } else {
    try {
      await facade.removeTree(pluginSettingsDir(baseDir, publisherId, pluginId));
    } catch (error) {
      settingsCleanupFailures.push({
        contribution: 'settings',
        error: String(error?.code || 'settings_cleanup_failed').slice(0, 64),
      });
    }

    if (typeof terminateResources === 'function') {
      let outcome;
      try {
        outcome = await terminateResources({ publisherId, pluginId, operationId, commitEpoch: committed.commitEpoch });
      } catch (error) {
        outcome = { ok: false, status: 'termination_failed', reason: (error && error.message) || String(error) };
      }
      if (!outcome || outcome.ok !== true) {
        cleanupStatus = outcome && outcome.status === 'pending_restart' ? 'pending_restart' : 'termination_failed';
        cleanupReasonCode = cleanupStatus;
      }
    }

    let activeGeneration = null;
    let retained = null;
    try {
      activeGeneration = await readGeneration(facade, baseDir, committed.generationId);
      retained = await collectRetainedGenerations(facade, baseDir, { retainedGenerationIds });
    } catch (_error) {
      cleanupStatus = cleanupStatus === 'complete' ? 'pending_restart' : cleanupStatus;
      cleanupReasonCode = cleanupStatus;
      reclaim.failed.push({
        error: 'retained_generation_collection_failed',
      });
    }
    if (retained && !retained.ok) {
      cleanupStatus = cleanupStatus === 'complete' ? 'pending_restart' : cleanupStatus;
      cleanupReasonCode = cleanupStatus;
      reclaim.failed.push({
        generationId: retained.generationId,
        error: retained.reason,
      });
    } else if (retained) {
      try {
        reclaim = await reclaimUnreachableContent(facade, baseDir, {
          activeGeneration: activeGeneration.ok ? activeGeneration.record : null,
          retainedGenerations: retained.records,
        });
      } catch (error) {
        cleanupStatus = cleanupStatus === 'complete' ? 'pending_restart' : cleanupStatus;
        cleanupReasonCode = cleanupStatus;
      }
    }
    if (reclaim.failed.length > 0 && cleanupStatus === 'complete') {
      // Bytes we could not remove now are retried after a restart; the plugin is
      // still gone from authority either way.
      cleanupStatus = 'pending_restart';
      cleanupReasonCode = 'pending_restart';
    }
    if (settingsCleanupFailures.length > 0) {
      reclaim.failed.push(...settingsCleanupFailures);
      if (cleanupStatus === 'complete') {
        cleanupStatus = 'pending_restart';
        cleanupReasonCode = 'pending_restart';
      }
    }
  }

  const recorded = await recordCleanup(facade, baseDir, {
    publisherId,
    pluginId,
    cleanupStatus,
    lifecycleEpoch,
    commitEpoch: committed.commitEpoch,
    detail: {
      code: cleanupReasonCode,
      retryable: cleanupStatus !== 'complete',
    },
  });
  if (!recorded.ok && cleanupStatus === 'complete') {
    cleanupStatus = 'pending_restart';
  }

  // PLUG-D17 proven, not promised: the authority state reported must be exactly
  // what the pointer flip committed, whatever cleanup did.
  const orthogonality = assertCleanupOrthogonality({
    authorityStateAfter: 'absent',
    authorityStateCommitted: 'absent',
    cleanupStatus,
  });
  if (!orthogonality.ok) {
    return refuse('cleanup', orthogonality.reason, PLUGIN_ERROR_CODES.POLICY_BLOCKED, { operationId, detail: orthogonality.detail });
  }

  emitter.terminal(
    now,
    commitEvidenceDegraded ? 'indeterminate' : 'committed',
    false,
    committed.pointer.generation_digest
  );
  return settle('cleanup', !commitEvidenceDegraded, {
    operationId,
    requestFingerprint,
    status: commitEvidenceDegraded ? 'indeterminate' : 'committed',
    authorityStateBefore,
    authorityStateAfter: 'absent',
    authorityStateCommitted: 'absent',
    cleanupStatus,
    cleanupTarget: { kind: 'absent' },
    settledAt: now,
    ...(commitEvidenceDegraded ? { failureReason: committed.reason } : {}),
  }, {
    operationId,
    committed: true,
    commitEpoch: committed.commitEpoch,
    revision: committed.revision,
    generationId: committed.generationId,
    cleanupStatus,
    cleanupWireCode: CLEANUP_FAILURE_WIRE_CODES[cleanupStatus] || null,
    cleanupRecorded: recorded.ok,
    reclaimed: reclaim.removed,
    reclaimFailed: reclaim.failed,
    retainedDigestCount: reclaim.plan.toKeep.length,
    ...(commitEvidenceDegraded ? {
      wireCode: PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE,
      commitStage: committed.stage,
      commitReason: committed.reason,
    } : {}),
    progress: emitter.log,
  });
}

module.exports = {
  CLEANUP_FAILURE_WIRE_CODES,
  collectRetainedGenerations,
  reclaimUnreachableContent,
  recordCleanup,
  uninstallPlugin,
};

'use strict';

const {
  normalizeTerminalKind,
  terminalIdentityMatches,
  validateTerminalIdentity,
} = require('./chat-lifecycle-contracts');
const {
  resolveCheckpointRecoveryFence,
  resolveCheckpointResumeIdentity,
} = require('./session-turn-actor-resume');
const { normalizeId } = require('../shared/normalize');

const KEEP_TOKEN_CONSUMED_STATUSES = new Set([
  'complete', 'completed', 'question_batch', 'plan_proposal', 'success',
]);
const RETRYABLE_TERMINAL_KINDS = new Set([
  'cancelled', 'denied', 'error', 'preempted', 'timeout',
]);

function normalizeStatus(value) {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLowerCase();
}

function createLeaseLifecycle(providerQuiesced = false) {
  let settleLease;
  let settleProvider;
  const settledPromise = new Promise((resolve) => { settleLease = resolve; });
  const providerQuiescedPromise = new Promise((resolve) => { settleProvider = resolve; });
  if (providerQuiesced) settleProvider();
  return {
    providerQuiesced,
    providerQuiescedPromise,
    settleProvider,
    settledPromise,
    settleLease,
  };
}

function pendingRepairForActiveTurn(registry, store, sessionId, activeTurn) {
  const repairStore = registry._terminalRepairStore;
  if (!repairStore || typeof repairStore.findByIdentity !== 'function' || !activeTurn) {
    return null;
  }
  if (repairStore.hasNewerSchema?.() === true) {
    return { artifact: null, exact: false, reason: 'terminal_repair_newer_schema' };
  }
  const session = store.getSession(sessionId) || {};
  const sessionIncarnation = normalizeId(
    activeTurn.session_incarnation || session.session_incarnation
  );
  const generation = Number(activeTurn.generation ?? session.turn_generation);
  if (!sessionIncarnation || !Number.isSafeInteger(generation) || generation <= 0) {
    return null;
  }
  const artifact = repairStore.findByIdentity({
    sessionId,
    sessionIncarnation,
    generation,
  });
  if (!artifact || !['pending', 'discarded'].includes(artifact.state)) return null;
  const exact = normalizeId(artifact.turn_id) === normalizeId(activeTurn.turn_id)
    && normalizeId(artifact.stream_id) === normalizeId(activeTurn.stream_id);
  return { artifact, exact };
}

function repairAdoptionError(reason) {
  return Object.assign(new Error('Pending terminal repair could not be adopted.'), {
    code: 'terminal_repair_refused',
    category: 'persistence',
    retryable: false,
    reason,
  });
}

function adoptPendingTerminalRepair(registry, {
  identity: sourceIdentity,
  store,
  activeStreams = new Map(),
  artifactId = '',
  allowDiscarded = false,
} = {}) {
  const identityResult = validateTerminalIdentity(sourceIdentity);
  if (!identityResult.ok) throw repairAdoptionError(identityResult.reason);
  const identity = Object.freeze(identityResult.identity);
  if (!store || typeof store.getSession !== 'function' || typeof store.getActiveTurn !== 'function') {
    throw new TypeError('SessionTurnActor.adoptPendingTerminalRepair requires a store.');
  }
  if (registry._terminalRepairStore?.hasNewerSchema?.() === true) {
    throw repairAdoptionError('terminal_repair_newer_schema');
  }
  const actor = registry._getActor(identity.sessionId, store);
  if (actor.tombstoned || actor.deleting) throw repairAdoptionError('session_deleting');
  if (actor.lease) {
    if (terminalIdentityMatches(actor.lease.identity, identity)) return actor.lease;
    throw repairAdoptionError('lease_active');
  }
  const session = store.getSession(identity.sessionId);
  const activeTurn = store.getActiveTurn(identity.sessionId);
  if (
    normalizeId(session?.session_incarnation) !== normalizeId(identity.sessionIncarnation)
    || Number(session?.turn_generation) !== identity.generation
    || !registry._activeTurnMatches(activeTurn, identity)
  ) {
    throw repairAdoptionError('stale_repair_identity');
  }
  const pendingRepair = pendingRepairForActiveTurn(
    registry,
    store,
    identity.sessionId,
    activeTurn
  );
  if (!pendingRepair?.exact) throw repairAdoptionError('repair_artifact_mismatch');
  if (pendingRepair.artifact.state === 'discarded' && allowDiscarded !== true) {
    throw repairAdoptionError('repair_artifact_discarded');
  }
  const expectedArtifactId = normalizeId(artifactId);
  if (expectedArtifactId && normalizeId(pendingRepair.artifact.artifact_id) !== expectedArtifactId) {
    throw repairAdoptionError('repair_artifact_mismatch');
  }
  const lifecycle = createLeaseLifecycle(true);
  const lease = {
    identity,
    store,
    activeStreams,
    prompt: '',
    editedMessageId: null,
    consumedContinuation: null,
    editValidationDeferred: false,
    continuationReplaced: false,
    controller: null,
    released: false,
    activeTurnClaim: { ...activeTurn },
    terminalRepairArtifactId: pendingRepair.artifact.artifact_id,
    terminalRepairDurable: true,
    terminalRepairState: pendingRepair.artifact.state,
    ...lifecycle,
  };
  actor.generation = identity.generation;
  actor.lease = lease;
  actor.store = store;
  registry._touch(actor);
  return lease;
}

function markProviderQuiesced(registry, lease) {
  if (lease?.providerQuiesced) {
    return { ok: true, quiesced: true, alreadyQuiesced: true };
  }
  const reason = registry._leaseReason(lease, true);
  if (reason) {
    registry._logDrop(lease, 'mark_provider_quiesced', reason);
    return { ok: false, quiesced: false, reason };
  }
  const actor = registry._actors.get(lease.identity.sessionId);
  registry._removeController(lease, actor);
  lease.providerQuiesced = true;
  lease.settleProvider?.();
  registry._touch(actor);
  return { ok: true, quiesced: true, alreadyQuiesced: false };
}

function prepareTerminalTransition(registry, lease, { status = '', questionBatch = null } = {}) {
  const reason = registry._leaseReason(lease);
  if (reason) {
    registry._logDrop(lease, 'prepare_terminal_transition', reason);
    return { ok: false, reason, preferencePatch: null };
  }
  const kind = normalizeTerminalKind(status);
  if (!kind) {
    return { ok: false, reason: 'invalid_terminal_kind', preferencePatch: null };
  }
  const batchId = String(questionBatch?.batch_id || '').trim();
  const transitionKey = `${kind}:${batchId}`;
  if (lease.terminalContinuationTransition) {
    return lease.terminalContinuationTransition.key === transitionKey
      ? lease.terminalContinuationTransition
      : { ok: false, reason: 'terminal_transition_conflict', preferencePatch: null };
  }

  let transition = {
    ok: true,
    reason: null,
    key: transitionKey,
    kind: 'none',
    preferencePatch: {},
  };
  if (kind === 'question_batch') {
    if (!batchId) {
      return { ok: false, reason: 'missing_question_batch_id', preferencePatch: null };
    }
    const token = {
      token_id: registry._id('continuation'),
      session_id: lease.identity.sessionId,
      session_incarnation: lease.identity.sessionIncarnation,
      batch_id: batchId,
      prior_generation: lease.identity.generation,
      consumed: false,
      issued_at: registry._timestamp(),
    };
    transition = {
      ...transition,
      kind: 'replace',
      preferencePatch: {
        pending_question_batch: { ...questionBatch, continuation_token: token },
      },
    };
  } else if (
    RETRYABLE_TERMINAL_KINDS.has(kind)
    && lease.consumedContinuation
    && !lease.continuationReplaced
  ) {
    const consumed = lease.consumedContinuation;
    transition = {
      ...transition,
      kind: 'restore',
      preferencePatch: {
        pending_question_batch: {
          ...consumed.batch,
          continuation_token: { ...consumed.token, consumed: false },
        },
      },
    };
  }
  lease.terminalContinuationTransition = transition;
  return transition;
}

function runTerminalMutation(registry, lease, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('SessionTurnActor.runTerminalMutation requires an operation.');
  }
  const reason = registry._leaseReason(lease);
  if (reason) {
    registry._logDrop(lease, 'terminal_commit', reason);
    return Promise.reject(Object.assign(new Error('Terminal actor mutation was refused.'), {
      code: 'terminal_actor_refused',
      reason,
    }));
  }
  const actor = registry._actors.get(lease.identity.sessionId);
  let pending;
  pending = Promise.resolve()
    .then(() => {
      const currentReason = registry._leaseReason(lease);
      if (currentReason) {
        throw Object.assign(new Error('Terminal actor mutation became stale.'), {
          code: 'terminal_actor_refused',
          reason: currentReason,
        });
      }
      return operation();
    })
    .finally(() => {
      actor.pendingMutations.delete(pending);
      registry._touch(actor);
    });
  actor.pendingMutations.add(pending);
  registry._touch(actor);
  return pending;
}

function preserveTerminalOwnership(registry, lease, commitResult, reason) {
  const actor = registry._actors.get(lease.identity.sessionId);
  const bracketDurable = registry._ensureActiveTurnDurably(lease);
  if (!bracketDurable) {
    actor.recoveryBlocked = 'active_turn_preserve_failed';
    registry._log('ERROR', 'lifecycle.active_turn_preserve_failed', {
      sessionId: lease.identity.sessionId,
      streamId: lease.identity.streamId,
      generation: lease.identity.generation,
      reason,
    });
  }
  lease.terminalCommitResult = commitResult;
  const result = {
    released: false,
    preserved: true,
    reason,
    ...(bracketDurable ? {} : { recoveryBlocked: actor.recoveryBlocked }),
  };
  lease.terminalFinalizeResult = result;
  return result;
}

function finalizeTerminal(registry, lease, commitResult, { status = '' } = {}) {
  if (lease?.released && lease.terminalFinalizeResult?.released) {
    return { ...lease.terminalFinalizeResult, alreadyFinalized: true };
  }
  const reason = registry._leaseReason(lease, true);
  if (reason) {
    registry._logDrop(lease, 'finalize_terminal', reason);
    return { released: false, preserved: false, reason };
  }
  markProviderQuiesced(registry, lease);
  if (commitResult?.ok !== true || commitResult?.durableTerminal !== true) {
    return preserveTerminalOwnership(
      registry,
      lease,
      commitResult,
      String(commitResult?.reason || 'terminal_commit_refused')
    );
  }
  const activeTurn = lease.store.getActiveTurn(lease.identity.sessionId);
  if (activeTurn) {
    const activeReason = registry._activeTurnMatches(activeTurn, lease.identity)
      ? 'active_turn_not_cleared'
      : 'active_turn_identity_mismatch';
    return preserveTerminalOwnership(registry, lease, commitResult, activeReason);
  }

  const actor = registry._actors.get(lease.identity.sessionId);
  const transition = lease.terminalContinuationTransition;
  if (transition?.kind === 'replace') {
    lease.continuationReplaced = true;
    lease.consumedContinuation = null;
  } else if (transition?.kind === 'restore') {
    lease.consumedContinuation = null;
  }
  registry._removeController(lease, actor);
  actor.lease = null;
  actor.recoveryBlocked = '';
  lease.released = true;
  lease.terminalCommitResult = commitResult;
  lease.settleLease();
  registry._touch(actor);
  const result = {
    released: true,
    preserved: false,
    reason: null,
    status: normalizeTerminalKind(status),
  };
  lease.terminalFinalizeResult = result;
  return result;
}

// A checkpoint pause preserves ownership until both durable owners settle.
function pauseForCheckpoint(registry, lease, { settleJournal } = {}) {
  const reason = registry._leaseReason(lease);
  if (reason || lease.consumedContinuation || typeof settleJournal !== 'function') {
    return { released: false, reason: reason || 'checkpoint_pause_invalid' };
  }
  const actor = registry._actors.get(lease.identity.sessionId);
  if (!registry._clearActiveTurnDurably(lease)) {
    actor.recoveryBlocked = 'checkpoint_pause_clear_failed';
    return { released: false, preserved: true, reason: actor.recoveryBlocked };
  }
  let journalSettled = false;
  try { journalSettled = settleJournal() === true; } catch (_error) { /* Retain the actor below. */ }
  if (!journalSettled) {
    const restored = registry._ensureActiveTurnDurably(lease);
    actor.recoveryBlocked = restored ? 'checkpoint_pause_journal_failed' : 'active_turn_preserve_failed';
    return { released: false, preserved: true, reason: actor.recoveryBlocked };
  }
  markProviderQuiesced(registry, lease);
  registry._removeController(lease, actor);
  actor.lease = null;
  actor.recoveryBlocked = '';
  lease.released = true;
  lease.settleLease();
  registry._touch(actor);
  return { released: true, preserved: false, status: 'paused' };
}

function blockCheckpointOrphan(registry, { sessionId, store, turnId, streamId, reason,
  checkpointResume = null, recoveryFence = null } = {}) {
  const id = normalizeId(sessionId);
  const turn = normalizeId(turnId);
  const stream = normalizeId(streamId);
  const blockedReason = normalizeId(reason) || 'checkpoint_recovery_uncertain';
  const actor = id && registry._getActor(id, store);
  const active = actor && store?.getActiveTurn?.(id);
  let trustedAbsentActive = false;
  if (actor && !active && checkpointResume && recoveryFence) {
    try {
      const fence = resolveCheckpointRecoveryFence(recoveryFence);
      const resume = resolveCheckpointResumeIdentity(checkpointResume, { sessionId: fence.sessionId,
        store, interactiveResponse: null, editedMessageId: '', deferEditValidation: false });
      trustedAbsentActive = fence.sessionId === id && fence.turnId === turn
        && fence.streamId === stream && resume.turnId === turn
        && resume.userMessageId === fence.userMessageId
        && actor.sessionIncarnation === fence.sessionIncarnation
        && actor.generation === fence.generation;
    } catch (_error) { trustedAbsentActive = false; }
  }
  const exactActive = active && normalizeId(active.request_id) === turn
    && normalizeId(active.turn_id) === turn && normalizeId(active.stream_id) === stream;
  if (!actor || actor.lease || (!exactActive && !trustedAbsentActive)) {
    return { blocked: false, reason: 'checkpoint_orphan_fence_mismatch' };
  }
  actor.checkpointRecoveryBarrier = Object.freeze({ turnId: turn, streamId: stream,
    reason: blockedReason, validatedCheckpoint: trustedAbsentActive });
  registry._touch(actor);
  return { blocked: true, reason: blockedReason };
}

function settleCheckpointOrphan(registry, { store, checkpointResume, recoveryFence } = {}) {
  let fence;
  let resume;
  try {
    fence = resolveCheckpointRecoveryFence(recoveryFence);
    resume = resolveCheckpointResumeIdentity(checkpointResume, { sessionId: fence.sessionId,
      store, interactiveResponse: null, editedMessageId: '', deferEditValidation: false });
  } catch (error) { return { settled: false, reason: error?.reason || 'checkpoint_recovery_invalid' }; }
  const actor = registry._getActor(fence.sessionId, store);
  const barrier = actor.checkpointRecoveryBarrier;
  if (actor.lease || actor.tombstoned || actor.deleting || store.getActiveTurn(fence.sessionId)
    || actor.sessionIncarnation !== fence.sessionIncarnation || actor.generation !== fence.generation
    || resume.turnId !== fence.turnId || resume.userMessageId !== fence.userMessageId) {
    return { settled: false, reason: 'checkpoint_recovery_fence_mismatch' };
  }
  if (barrier && (barrier.validatedCheckpoint !== true || barrier.turnId !== fence.turnId
    || barrier.streamId !== fence.streamId)) {
    return { settled: false, reason: 'checkpoint_recovery_barrier_mismatch' };
  }
  actor.checkpointRecoveryBarrier = null;
  registry._touch(actor);
  return { settled: true, cleared: Boolean(barrier) };
}

function pauseRecoveredCheckpoint(registry, { store, activeStreams, checkpointResume,
  recoveryFence, settleJournal } = {}) {
  let fence;
  let resume;
  try {
    fence = resolveCheckpointRecoveryFence(recoveryFence);
    resume = resolveCheckpointResumeIdentity(checkpointResume, { sessionId: fence.sessionId,
      store, interactiveResponse: null, editedMessageId: '', deferEditValidation: false });
  } catch (error) { return { released: false, reason: error?.reason || 'checkpoint_recovery_invalid' }; }
  if (resume.turnId !== fence.turnId || resume.userMessageId !== fence.userMessageId
    || !activeStreams || typeof activeStreams.get !== 'function'
    || typeof settleJournal !== 'function') {
    return { released: false, reason: 'checkpoint_recovery_fence_mismatch' };
  }
  const actor = registry._getActor(fence.sessionId, store);
  let lease = actor.lease;
  if (lease) {
    if (lease.checkpointRecovery !== true
      || !terminalIdentityMatches(lease.identity, fence)) {
      return { released: false, reason: 'checkpoint_recovery_lease_conflict' };
    }
  } else {
    const activeTurn = store.getActiveTurn(fence.sessionId);
    const identity = Object.freeze({ sessionId: fence.sessionId,
      sessionIncarnation: fence.sessionIncarnation, generation: fence.generation,
      turnId: fence.turnId, streamId: fence.streamId, userMessageId: fence.userMessageId,
      sessionRevision: null });
    if (actor.tombstoned || actor.deleting || actor.sessionIncarnation !== identity.sessionIncarnation
      || actor.generation !== identity.generation || activeStreams.get(identity.streamId)
      || !registry._activeTurnMatches(activeTurn, identity)) {
      return { released: false, reason: 'checkpoint_recovery_fence_mismatch' };
    }
    lease = { identity, store, activeStreams, prompt: '', editedMessageId: null,
      consumedContinuation: null, reuseExistingUserMessage: true, editValidationDeferred: false,
      continuationReplaced: false, controller: null, released: false,
      activeTurnClaim: { ...activeTurn },
      checkpointRecovery: true, ...createLeaseLifecycle(true) };
    actor.lease = lease;
    actor.store = store;
    actor.checkpointRecoveryBarrier = null;
    registry._touch(actor);
  }
  return pauseForCheckpoint(registry, lease, { settleJournal });
}

// Compatibility path for entrypoints not yet routed through TerminalCoordinator.
// L4 callers use finalizeTerminal(), whose refused path retains actor ownership.
function releaseLease(registry, lease, { status = '', preserveActiveTurn = false } = {}) {
  const reason = registry._leaseReason(lease, true);
  if (reason) {
    registry._logDrop(lease, 'release', reason);
    return { released: false, restoredContinuation: false, reason };
  }
  const actor = registry._actors.get(lease.identity.sessionId);
  const terminalStatus = normalizeStatus(status);
  const shouldRestore = (preserveActiveTurn || !KEEP_TOKEN_CONSUMED_STATUSES.has(terminalStatus))
    && lease.consumedContinuation
    && !lease.continuationReplaced;
  const restoredContinuation = shouldRestore ? registry._restoreContinuation(lease) : false;
  const restorationBlocked = Boolean(shouldRestore && !restoredContinuation);
  if (restorationBlocked) {
    actor.recoveryBlocked = 'continuation_restore_failed';
    lease.activeTurnClaim = { ...lease.activeTurnClaim, continuation_restore_required: true };
    registry._log('ERROR', 'lifecycle.continuation_restore_blocked_release', {
      sessionId: lease.identity.sessionId,
      streamId: lease.identity.streamId,
      generation: lease.identity.generation,
    });
  }
  if ((preserveActiveTurn || restorationBlocked) && !registry._ensureActiveTurnDurably(lease)) {
    actor.recoveryBlocked = actor.recoveryBlocked || 'active_turn_preserve_failed';
    registry._log('ERROR', 'lifecycle.active_turn_preserve_failed', {
      sessionId: lease.identity.sessionId,
      streamId: lease.identity.streamId,
      generation: lease.identity.generation,
    });
  }
  let activeTurnReleaseBlocked = false;
  if (!preserveActiveTurn && !restorationBlocked) {
    activeTurnReleaseBlocked = !registry._clearActiveTurnDurably(lease);
    if (activeTurnReleaseBlocked) {
      actor.recoveryBlocked = 'active_turn_release_failed';
      registry._log('ERROR', 'lifecycle.active_turn_release_failed', {
        sessionId: lease.identity.sessionId,
        streamId: lease.identity.streamId,
        generation: lease.identity.generation,
      });
    }
  }
  markProviderQuiesced(registry, lease);
  actor.lease = null;
  lease.released = true;
  lease.settleLease();
  registry._touch(actor);
  return {
    released: true,
    restoredContinuation,
    status: terminalStatus || null,
    ...(restorationBlocked || activeTurnReleaseBlocked
      ? { recoveryBlocked: actor.recoveryBlocked }
      : {}),
  };
}

module.exports = {
  adoptPendingTerminalRepair,
  blockCheckpointOrphan,
  createLeaseLifecycle,
  finalizeTerminal,
  markProviderQuiesced,
  pauseRecoveredCheckpoint,
  pendingRepairForActiveTurn,
  pauseForCheckpoint,
  prepareTerminalTransition,
  releaseLease,
  runTerminalMutation,
  settleCheckpointOrphan,
};

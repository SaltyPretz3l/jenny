'use strict';

const { stableJson } = require('../session-runtime/contracts');
const { recoverCheckpointTurnEventJournal } = require('../session-recovery-service');
const {
  createCheckpointRecoveryFence,
  createCheckpointResumeIdentity,
} = require('./session-turn-actor-resume');

const RESTART_RECOVERY = 'restart_paused';

function requirePort(value, methods, name) {
  for (const method of methods) {
    if (!value || typeof value[method] !== 'function') {
      throw new TypeError(`runtime continuation recovery requires ${name}.${method}().`);
    }
  }
}

function isRecoverableCheckpointWork(work) {
  if (work?.status === 'needs_attention' && work.attempt
    && ['pause', 'cancel'].includes(work.control_request?.kind)
    && work.transition?.from === 'running' && work.transition.reason === 'settlement_unconfirmed') return true;
  if (work?.status === 'paused' && work.checkpoint_ref && work.attempt
    && work.recovery?.kind === 'transition_repaired'
    && work.recovery.previous_status === 'needs_attention') return true;
  return work?.status === 'paused'
    && work.recovery?.kind === RESTART_RECOVERY
    && work.recovery.previous_status === 'running'
    && work.attempt;
}

function activeMatchesFence(active, fence) {
  return Boolean(active
    && active.request_id === fence.turnId
    && active.turn_id === fence.turnId
    && active.stream_id === fence.streamId
    && active.user_message_id === fence.userMessageId
    && active.session_incarnation === fence.sessionIncarnation
    && active.generation === fence.generation);
}

function fenceMatchesWork(fence, work) {
  return Boolean(fence
    && fence.sessionId === work.session_id
    && fence.turnId === work.turn_id
    && fence.streamId === work.attempt.stream_id);
}

function listRestartCandidates(runtimeStore) {
  const ids = [];
  let cursor = null;
  do {
    const page = runtimeStore.listSummaries({ cursor, limit: 100 });
    for (const summary of page.items) {
      if (['paused', 'needs_attention'].includes(summary.status)) ids.push(summary.work_id);
    }
    cursor = page.next_cursor;
  } while (cursor);
  return ids;
}

function recoverPublishedRuntimeContinuations({ runtimeStore, checkpointStore,
  conversationStore, sessionStore, journal, actorRegistry, activeStreams,
  logger = null } = {}) {
  requirePort(runtimeStore, ['get', 'listSummaries', 'attachRecoveredCheckpoint'], 'runtimeStore');
  requirePort(checkpointStore, ['findCommittedForWork'], 'checkpointStore');
  requirePort(conversationStore, ['resolvePendingContinuation'], 'conversationStore');
  requirePort(sessionStore, ['getSession', 'getActiveTurn'], 'sessionStore');
  requirePort(journal, ['list'], 'journal');
  requirePort(actorRegistry, ['blockCheckpointOrphan', 'pauseRecoveredCheckpoint',
    'settleCheckpointOrphan'], 'actorRegistry');
  if (!activeStreams || typeof activeStreams.get !== 'function') {
    throw new TypeError('runtime continuation recovery requires activeStreams.');
  }
  const log = typeof logger === 'function' ? logger : null;
  const counts = { recovered: 0, blocked: 0, ordinary: 0 };
  const block = (work, reason, fence = null, checkpointResume = null) => {
    const active = sessionStore.getActiveTurn(work.session_id);
    const turnId = fence?.turnId || work.turn_id;
    const streamId = fence?.streamId || work.attempt?.stream_id;
    try {
      if (active?.request_id === turnId && active?.turn_id === turnId
        && active?.stream_id === streamId) {
        actorRegistry.blockCheckpointOrphan({ sessionId: work.session_id, store: sessionStore,
          turnId, streamId, reason, checkpointResume, recoveryFence: fence });
      } else if (!active && fence && checkpointResume) {
        actorRegistry.blockCheckpointOrphan({ sessionId: work.session_id, store: sessionStore,
          turnId, streamId, reason, checkpointResume, recoveryFence: fence });
      }
    } catch (_error) { /* The durable work remains paused below. */ }
    counts.blocked += 1;
    try {
      log?.('WARN', 'runtime_continuation.recovery_blocked', {
        workId: work.work_id, sessionId: work.session_id, turnId: work.turn_id, reason,
      });
    } catch (_error) { /* Diagnostics must not change recovery state. */ }
  };

  for (const workId of listRestartCandidates(runtimeStore)) {
    const work = runtimeStore.get(workId);
    if (!isRecoverableCheckpointWork(work)) continue;
    const discovered = checkpointStore.findCommittedForWork(work);
    if (discovered.status === 'none') {
      counts.ordinary += 1;
      continue;
    }
    if (discovered.status !== 'committed') {
      block(work, discovered.reason || 'checkpoint_recovery_uncertain');
      continue;
    }
    let payload;
    let fence;
    let checkpointResume;
    try {
      payload = conversationStore.resolvePendingContinuation(
        discovered.continuation, work, { includePayload: true }
      );
      if (payload?.valid !== true || !payload.recoveryFence) {
        block(work, 'checkpoint_canonical_unavailable');
        continue;
      }
      fence = createCheckpointRecoveryFence(payload.recoveryFence);
      if (!fenceMatchesWork(fence, work)) {
        block(work, 'checkpoint_recovery_fence_mismatch', fence);
        continue;
      }
      checkpointResume = createCheckpointResumeIdentity({ sessionId: fence.sessionId,
        turnId: fence.turnId, userMessageId: fence.userMessageId });
      const journalRecovery = recoverCheckpointTurnEventJournal({ sessionStore, journal,
        recoveryFence: fence });
      if (journalRecovery.settled !== true) {
        block(work, journalRecovery.reason || 'checkpoint_recovery_journal_pending',
          fence, checkpointResume);
        continue;
      }
      const active = sessionStore.getActiveTurn(fence.sessionId);
      if (active && !activeMatchesFence(active, fence)) {
        block(work, 'checkpoint_recovery_active_turn_mismatch', fence, checkpointResume);
        continue;
      }
      const attached = runtimeStore.attachRecoveredCheckpoint(work.work_id, {
        expectedRevision: work.revision, expectedAttempt: work.attempt,
        checkpointRef: discovered.reference,
      });
      if (stableJson(attached.record.checkpoint_ref) !== stableJson(discovered.reference)) {
        block(work, 'checkpoint_recovery_attach_refused', fence, checkpointResume);
        continue;
      }
      if (active) {
        const paused = actorRegistry.pauseRecoveredCheckpoint({ store: sessionStore,
          activeStreams, checkpointResume, recoveryFence: fence,
          settleJournal: () => journal.list(fence.sessionId, fence.turnId).length === 0 });
        if (paused?.released !== true) {
          block(work, paused?.reason || 'checkpoint_recovery_actor_pause_failed',
            fence, checkpointResume);
          continue;
        }
      } else {
        const settled = actorRegistry.settleCheckpointOrphan({ store: sessionStore,
          checkpointResume, recoveryFence: fence });
        if (settled?.settled !== true) {
          block(work, settled?.reason || 'checkpoint_recovery_barrier_failed',
            fence, checkpointResume);
          continue;
        }
      }
      counts.recovered += 1;
    } catch (error) {
      block(work, error?.reason || error?.code || 'checkpoint_recovery_failed',
        fence, checkpointResume);
    }
  }
  return Object.freeze(counts);
}

module.exports = { recoverPublishedRuntimeContinuations };

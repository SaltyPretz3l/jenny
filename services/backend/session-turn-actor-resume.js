'use strict';

const { normalizeIdentifier } = require('./generated-chat-lifecycle-contract');
const { normalizeId } = require('../shared/normalize');

const CANONICAL_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const CHECKPOINT_RESUME_IDENTITIES = new WeakSet();
const CHECKPOINT_RECOVERY_FENCES = new WeakSet();

function resumeError(reason) {
  return Object.assign(new Error('Checkpoint resume identity was rejected.'), {
    code: 'checkpoint_resume_invalid', category: 'validation', retryable: false, reason,
  });
}

function requireStore(store) {
  for (const name of ['getSession', 'getActiveTurn', 'setActiveTurn', 'clearActiveTurn']) {
    if (!store || typeof store[name] !== 'function') {
      throw new TypeError(`SessionTurnActor requires store.${name}().`);
    }
  }
  if (typeof store.flushSession !== 'function' && typeof store.flush !== 'function') {
    throw new TypeError('SessionTurnActor requires a durable store flush operation.');
  }
}

function sessionMessages(store, sessionId) {
  if (typeof store.getSessionMessages === 'function') return store.getSessionMessages(sessionId);
  if (typeof store.getMessages === 'function') return store.getMessages(sessionId);
  const messages = store.getSession(sessionId)?.messages;
  return Array.isArray(messages) ? messages : [];
}

function assertEditAnchor(store, sessionId, editId) {
  const anchor = sessionMessages(store, sessionId).find(
    message => normalizeId(message?.id) === editId
  );
  if (anchor && normalizeId(anchor.role) === 'user') return;
  throw Object.assign(new Error('The edited user message is no longer available.'), {
    code: 'invalid_edit_target', category: 'validation', retryable: false,
  });
}

// The caller must first validate the checkpoint, canonical history, and source
// attempt. This brand only prevents serialized/public input from selecting the
// private actor-resume branch; it is not checkpoint authorization by itself.
function createCheckpointResumeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'sessionId,turnId,userMessageId') {
    throw resumeError('identity_shape');
  }
  const session = normalizeIdentifier(value.sessionId);
  const turn = normalizeIdentifier(value.turnId);
  if (!session.ok || !turn.ok) throw resumeError('runtime_identity_invalid');
  if (typeof value.userMessageId !== 'string'
    || !CANONICAL_MESSAGE_ID.test(value.userMessageId)) {
    throw resumeError('user_message_id_invalid');
  }
  const identity = Object.freeze({ sessionId: session.value,
    turnId: turn.value, userMessageId: value.userMessageId });
  CHECKPOINT_RESUME_IDENTITIES.add(identity);
  return identity;
}

function createCheckpointRecoveryFence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',')
      !== 'generation,sessionId,sessionIncarnation,streamId,turnId,userMessageId') {
    throw resumeError('recovery_fence_shape');
  }
  const fields = ['sessionId', 'sessionIncarnation', 'streamId', 'turnId'];
  const normalized = Object.fromEntries(fields.map((field) => {
    const result = normalizeIdentifier(value[field]);
    if (!result.ok) throw resumeError('recovery_fence_identity_invalid');
    return [field, result.value];
  }));
  if (typeof value.userMessageId !== 'string'
    || !CANONICAL_MESSAGE_ID.test(value.userMessageId)
    || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw resumeError('recovery_fence_identity_invalid');
  }
  const fence = Object.freeze({ ...normalized,
    userMessageId: value.userMessageId, generation: value.generation });
  CHECKPOINT_RECOVERY_FENCES.add(fence);
  return fence;
}

function resolveCheckpointRecoveryFence(value) {
  if (!CHECKPOINT_RECOVERY_FENCES.has(value)) throw resumeError('recovery_fence_untrusted');
  return value;
}

function provePausedRuntimeCleanup(registry, sessionId, handle) {
  const actor = registry?._actors?.get(normalizeId(sessionId));
  return Boolean(actor && handle?.sessionId === actor.sessionId
    && registry._currentDeletion(handle) && actor.deleting && !actor.tombstoned
    && !actor.lease && !actor.controller && !handle.lease && !handle.controller
    && actor.pendingMutations.size === 0 && !actor.recoveryBlocked
    && !actor.checkpointRecoveryBarrier);
}

function resolveCheckpointResumeIdentity(value, { sessionId, store, interactiveResponse,
  editedMessageId, deferEditValidation, logicalTurnId } = {}) {
  if (value == null) return null;
  if (!CHECKPOINT_RESUME_IDENTITIES.has(value)) throw resumeError('identity_untrusted');
  if (interactiveResponse !== null || normalizeId(editedMessageId)
    || deferEditValidation === true || logicalTurnId !== undefined) {
    throw resumeError('mixed_admission_mode');
  }
  if (value.sessionId !== sessionId) throw resumeError('session_mismatch');
  const messages = sessionMessages(store, sessionId).filter(
    message => String(message?.id || '') === value.userMessageId
  );
  if (messages.length !== 1) throw resumeError('user_message_unavailable');
  if (normalizeId(messages[0].role) !== 'user') throw resumeError('user_message_role_mismatch');
  if (String(messages[0].turn_id || '') !== value.turnId) throw resumeError('turn_mismatch');
  return value;
}

function queuedSubmissionBlock(registry, sessionId) {
  const actor = registry._actors.get(normalizeId(sessionId));
  if (actor?.deleting || actor?.tombstoned) return 'session_deleting';
  return actor?.checkpointRecoveryBarrier?.reason || actor?.recoveryBlocked || null;
}

module.exports = {
  queuedSubmissionBlock,
  assertEditAnchor,
  createCheckpointRecoveryFence,
  createCheckpointResumeIdentity,
  provePausedRuntimeCleanup,
  requireStore,
  resolveCheckpointResumeIdentity,
  resolveCheckpointRecoveryFence,
  sessionMessages,
};

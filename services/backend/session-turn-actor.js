const { randomUUID } = require('node:crypto');
const { createSessionBusyError } = require('./chat-stream-admission');
const {
  hasTerminalMessageEvidence,
  isTerminalMessageStatus,
  messageMatchesStream,
} = require('./active-turn-terminal-evidence');
const { recordLifecycleDiagnostic } = require('./chat-lifecycle-diagnostics');
const { INTERACTIVE_ERROR_CODES } = require('./error-codes');
const {
  continuationSnapshotMatches,
  getContinuationToken,
  getPendingQuestionBatch,
  normalizeContinuationToken,
} = require('./session-turn-continuation');
const {
  adoptPendingTerminalRepair: adoptRepairLease,
  createLeaseLifecycle,
  finalizeTerminal: finalizeTerminalLease,
  markProviderQuiesced: markLeaseProviderQuiesced,
  pendingRepairForActiveTurn,
  prepareTerminalTransition: prepareLeaseTerminalTransition,
  releaseLease,
  runTerminalMutation: runLeaseTerminalMutation,
} = require('./session-turn-actor-terminal');
const { normalizeId } = require('../shared/normalize');
const DEFAULT_MAX_ACTORS = 512;
const DEFAULT_QUIESCENCE_TIMEOUT_MS = 5_000;
const MAX_QUIESCENCE_TIMEOUT_MS = 60_000;
const INTERRUPTED_MESSAGE = 'This turn was interrupted before it could finish.';
const RETRYABLE_TERMINAL_STATUSES = new Set([
  'cancelled', 'denied', 'error', 'errored', 'failed', 'interrupted', 'preempted',
  'runtime_error', 'timeout']);
function isRecord(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function asGeneration(value, fallback = 0) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback; }
function normalizeStatus(value) {
  return normalizeId(value).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s.-]+/g, '_').toLowerCase();
}
function sessionMessages(store, sessionId) {
  if (typeof store.getSessionMessages === 'function') return store.getSessionMessages(sessionId);
  if (typeof store.getMessages === 'function') return store.getMessages(sessionId);
  const messages = store.getSession(sessionId)?.messages;
  return Array.isArray(messages) ? messages : [];
}
function terminalConsumesContinuation(messages, streamId) {
  const terminal = [...(Array.isArray(messages) ? messages : [])].reverse().find(
    (message) => messageMatchesStream(message, streamId)
      && isTerminalMessageStatus(message?.status)
  );
  if (!terminal) return false;
  const status = normalizeStatus(terminal.terminal_status || terminal.status);
  if (
    RETRYABLE_TERMINAL_STATUSES.has(status)
    || terminal.retryable === true
    || Boolean(normalizeId(terminal.stream_error))
    || Boolean(normalizeId(terminal.error_code))
  ) return false;
  return true;
}
function continuationError(reason, retryable = false) {
  const code = INTERACTIVE_ERROR_CODES.INVALID_CONTINUATION;
  return Object.assign(new Error(`Interactive continuation rejected (${code}).`), {
    code, category: 'interactive_continuation',
    reason: normalizeId(reason) || 'invalid_continuation',
    retryable: Boolean(retryable),
  });
}
function recoveryError(reason, cause = null) {
  const error = Object.assign(new Error(
    'The previous interrupted turn could not be recovered durably.'
  ), {
    code: 'active_turn_recovery_failed', category: 'persistence', retryable: true,
    reason: normalizeId(reason) || 'recovery_failed',
  });
  if (cause) error.cause = cause;
  return error;
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
class SessionTurnActorRegistry {
  constructor({ maxActors = DEFAULT_MAX_ACTORS, logger = null,
    now = () => Date.now(), createId = () => randomUUID(), terminalRepairStore = null } = {}) {
    const parsedMax = Number(maxActors);
    this.maxActors = Number.isSafeInteger(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_MAX_ACTORS;
    this._logger = typeof logger === 'function' ? logger : null;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._createId = typeof createId === 'function' ? createId : () => randomUUID();
    this._terminalRepairStore = terminalRepairStore;
    this._actors = new Map();
  }
  get size() { return this._actors.size; }
  pendingUnattachedLeaseSettlementBarriers() {
    return [...this._actors.values()]
      .map((actor) => actor.lease)
      .filter((lease) => lease && !lease.controller && !lease.released)
      .map((lease) => lease.settledPromise);
  }
  reserveStart({
    sessionId,
    store,
    activeStreams,
    interactiveResponse = null,
    editedMessageId = '',
    deferEditValidation = false,
    prompt = '',
    path = '',
    traceId = '',
  } = {}) {
    const id = normalizeId(sessionId);
    if (!id) throw new TypeError('SessionTurnActor.reserveStart requires sessionId.');
    requireStore(store);
    if (!activeStreams || typeof activeStreams.get !== 'function') {
      throw new TypeError('SessionTurnActor.reserveStart requires activeStreams.');
    }
    const actor = this._getActor(id, store);
    if (actor.tombstoned || actor.deleting || actor.lease) {
      const deleting = actor.tombstoned || actor.deleting;
      this._recordLeaseConflict(path, id, deleting ? 'session_deleting' : 'lease_active');
      const error = createSessionBusyError(
        deleting ? 'the session is being deleted' : 'a turn is already running'
      );
      error.reason = deleting ? 'session_deleting' : 'lease_active';
      throw error;
    }
    let activeTurn = store.getActiveTurn(id);
    const pendingRepair = pendingRepairForActiveTurn(this, store, id, activeTurn);
    if (pendingRepair) {
      const repairReason = pendingRepair.reason || (pendingRepair.exact
        ? (pendingRepair.artifact?.state === 'discarded'
            ? 'terminal_repair_discard_pending'
            : 'terminal_repair_pending')
        : 'terminal_repair_identity_mismatch');
      this._recordLeaseConflict(path, id, repairReason);
      const error = createSessionBusyError('a terminal repair is pending');
      error.reason = repairReason;
      throw error;
    }
    if (actor.recoveryBlocked) {
      if (!activeTurn) throw recoveryError(actor.recoveryBlocked);
      this._recoverOrphan(actor, store, activeTurn);
      activeTurn = store.getActiveTurn(id);
    }
    if (activeTurn) {
      const activeStreamId = normalizeId(activeTurn.stream_id || activeTurn.request_id);
      if (activeStreamId && activeStreams.get(activeStreamId)) {
        this._recordLeaseConflict(path, id, 'active_stream');
        throw createSessionBusyError();
      }
      // A bracket without the actor lease/controller is crash evidence, even when fresh.
      this._recoverOrphan(actor, store, activeTurn);
    }
    const editId = normalizeId(editedMessageId);
    if (editId && deferEditValidation !== true) this._assertEditAnchor(store, id, editId);
    const continuation = interactiveResponse
      ? this._validateContinuation(actor, store, interactiveResponse)
      : null;
    const previousGeneration = actor.generation;
    const streamId = this._id('stream');
    const identity = Object.freeze({
      sessionId: id, sessionIncarnation: actor.sessionIncarnation,
      generation: previousGeneration + 1, turnId: streamId, streamId,
      userMessageId: editId || `user_${streamId}`, sessionRevision: null,
    });
    const leaseLifecycle = createLeaseLifecycle();
    const lease = {
      identity, store, activeStreams, prompt: String(prompt || ''),
      editedMessageId: editId || null, consumedContinuation: null,
      editValidationDeferred: Boolean(editId && deferEditValidation === true),
      continuationReplaced: false, controller: null, released: false,
      ...leaseLifecycle,
    };
    // Publish the session-local CAS before any caller can await.
    actor.generation = identity.generation;
    actor.lease = lease;
    actor.store = store;
    this._touch(actor);
    let claimAttempted = false;
    try {
      const identityPersisted = typeof store.setTurnIdentity === 'function'
        ? store.setTurnIdentity(id, { session_incarnation: identity.sessionIncarnation,
            turn_generation: identity.generation })
        : null;
      if (!identityPersisted) throw recoveryError('turn_identity_persist_refused');
      const timestamp = this._timestamp();
      lease.activeTurnClaim = {
        request_id: identity.turnId, turn_id: identity.turnId,
        stream_id: identity.streamId, user_message_id: identity.userMessageId,
        trace_id: normalizeId(traceId) || identity.streamId,
        session_incarnation: identity.sessionIncarnation,
        generation: identity.generation, started_at: timestamp, last_event_at: timestamp,
        status: 'awaiting_assistant',
      };
      claimAttempted = true;
      const claimed = store.setActiveTurn(
        id,
        lease.activeTurnClaim,
        { expectedPriorStreamId: identity.streamId }
      );
      if (!claimed) throw new Error('active_turn claim was refused');
      if (!this._activeTurnMatches(store.getActiveTurn(id), identity)) {
        throw recoveryError('active_turn_claim_unverified');
      }
      this._flush(store, id, 'active_turn_claim_flush_refused');
      const persistedSession = store.getSession(id);
      if (
        normalizeId(persistedSession?.session_incarnation) !== identity.sessionIncarnation
        || asGeneration(persistedSession?.turn_generation, -1) !== identity.generation
      ) {
        throw recoveryError('turn_identity_unverified_after_flush');
      }
      if (!this._activeTurnMatches(store.getActiveTurn(id), identity)) {
        throw recoveryError('active_turn_claim_unverified_after_flush');
      }
      // Claim the crash-recovery bracket before consuming a continuation.
      // The safe intermediate state is an orphaned lease with a retryable
      // token, never a consumed token with no durable generation evidence.
      if (continuation) this._consumeContinuation(lease, continuation);
      return lease;
    } catch (error) {
      const continuationRestored = lease.consumedContinuation
        ? this._restoreContinuation(lease)
        : true;
      const continuationRollbackBlocked = !continuationRestored;
      if (continuationRollbackBlocked) {
        actor.recoveryBlocked = 'continuation_restore_failed';
        lease.activeTurnClaim = {
          ...(lease.activeTurnClaim || this._buildActiveTurnClaim(lease, traceId)),
          continuation_restore_required: true,
        };
        this._ensureActiveTurnDurably(lease);
      }
      if (claimAttempted && !continuationRollbackBlocked) {
        if (!this._clearActiveTurnDurably(lease)) {
          actor.recoveryBlocked = 'active_turn_claim_rollback_failed';
          this._log('ERROR', 'lifecycle.active_turn_claim_rollback_failed', {
            sessionId: id,
            streamId: identity.streamId,
            generation: identity.generation,
            reason: actor.recoveryBlocked,
          });
        }
      }
      actor.lease = null;
      lease.released = true;
      lease.providerQuiesced = true;
      lease.settleProvider();
      lease.settleLease();
      throw error;
    }
  }
  guard(lease, site, mutation) {
    if (typeof mutation !== 'function') {
      throw new TypeError('SessionTurnActor.guard requires a mutation function.');
    }
    const reason = this._leaseReason(lease);
    if (!reason) return mutation();
    this._logDrop(lease, site, reason);
    return null;
  }
  attachController(lease, controller) {
    const reason = this._leaseReason(lease);
    if (reason) {
      this._logDrop(lease, 'attach_controller', reason);
      return false;
    }
    const actor = this._actors.get(lease.identity.sessionId);
    actor.controller = controller || null;
    lease.controller = controller || null;
    if (controller && typeof lease.activeStreams.set === 'function') {
      lease.activeStreams.set(lease.identity.streamId, controller);
    }
    if (actor.deleting) {
      const handle = actor.deletionHandle;
      if (handle) handle.controller = controller || null;
      this._cancelForDeletion(actor, lease, controller);
      return false;
    }
    return true;
  }
  runSessionMutation(sessionId, site, operation, commit = null, { requireIdle = false } = {}) {
    const id = normalizeId(sessionId);
    if (!id || typeof operation !== 'function') {
      throw new TypeError('SessionTurnActor.runSessionMutation requires a session and operation.');
    }
    const actor = this._getActor(id, null);
    if (actor.tombstoned || actor.deleting) {
      throw createSessionBusyError('the session is being deleted');
    }
    if (requireIdle && actor.lease) {
      this._recordLeaseConflict('session_mutation', id, 'lease_active');
      throw createSessionBusyError('a turn is already running');
    }
    const incarnation = actor.sessionIncarnation;
    let pending;
    pending = Promise.resolve()
      .then(operation)
      .then((result) => {
        const stale = actor.tombstoned
          || actor.deleting
          || (requireIdle && Boolean(actor.lease))
          || actor.sessionIncarnation !== incarnation
          || this._actors.get(id) !== actor;
        if (stale) {
          this._log('WARN', 'lifecycle.stale_mutation_dropped', {
            sessionId: id,
            sessionIncarnation: incarnation,
            generation: actor.generation,
            turnId: null,
            streamId: null,
            site: normalizeId(site) || 'session_mutation',
            reason: actor.tombstoned ? 'session_tombstoned' : 'session_deleting',
          });
          if (requireIdle && actor.lease) {
            throw createSessionBusyError('a turn is already running');
          }
          return result;
        }
        return typeof commit === 'function' ? commit(result) : result;
      })
      .finally(() => {
        actor.pendingMutations.delete(pending);
        this._touch(actor);
      });
    actor.pendingMutations.add(pending);
    return pending;
  }
  markProviderQuiesced(lease) {
    return markLeaseProviderQuiesced(this, lease);
  }
  adoptPendingTerminalRepair(options) {
    return adoptRepairLease(this, options);
  }
  prepareTerminalTransition(lease, options) {
    return prepareLeaseTerminalTransition(this, lease, options);
  }
  runTerminalMutation(lease, operation) {
    return runLeaseTerminalMutation(this, lease, operation);
  }
  finalizeTerminal(lease, commitResult, options) {
    return finalizeTerminalLease(this, lease, commitResult, options);
  }
  release(lease, options) {
    return releaseLease(this, lease, options);
  }
  attachContinuationToken(lease, batch) {
    const reason = this._leaseReason(lease);
    if (reason) {
      this._logDrop(lease, 'attach_continuation_token', reason);
      throw continuationError(reason);
    }
    const batchId = normalizeId(batch?.batch_id);
    if (!batchId) throw continuationError('missing_batch_id');
    const token = {
      token_id: this._id('continuation'), session_id: lease.identity.sessionId,
      session_incarnation: lease.identity.sessionIncarnation,
      batch_id: batchId, prior_generation: lease.identity.generation,
      consumed: false, issued_at: this._timestamp(),
    };
    const nextBatch = { ...batch, continuation_token: token };
    if (!this._writeBatch(lease.store, lease.identity.sessionId, nextBatch, token)) {
      throw continuationError('token_persist_failed', true);
    }
    lease.continuationReplaced = true;
    lease.consumedContinuation = null;
    return nextBatch;
  }
  beginDeletion(sessionId, { cancel = null } = {}) {
    const id = normalizeId(sessionId);
    if (!id) throw new TypeError('SessionTurnActor.beginDeletion requires sessionId.');
    const actor = this._getActor(id, null);
    if (actor.deletionHandle) return actor.deletionHandle;
    if (actor.tombstoned) {
      return {
        sessionId: id,
        sessionIncarnation: actor.sessionIncarnation,
        deletionId: this._id('deletion'),
        actor,
        lease: null,
        controller: null,
        quiesced: true,
        committed: true,
        rolledBack: false,
        alreadyCommitted: true,
        result: actor.deletionResult || { object: 'session', id, deleted: true },
      };
    }
    actor.deleting = true;
    const lease = actor.lease;
    const controller = actor.controller
      || lease?.controller || lease?.activeStreams?.get?.(lease?.identity?.streamId) || null;
    const handle = {
      sessionId: id, sessionIncarnation: actor.sessionIncarnation,
      deletionId: this._id('deletion'), actor, lease, controller,
      cancel: typeof cancel === 'function' ? cancel : null,
      pendingMutationPromises: [...actor.pendingMutations],
      quiesced: false, committed: false, rolledBack: false, commitPromise: null,
    };
    actor.deletionHandle = handle;
    this._cancelForDeletion(actor, lease, controller);
    return handle;
  }
  async awaitQuiescence(handle, { timeoutMs = DEFAULT_QUIESCENCE_TIMEOUT_MS } = {}) {
    if (handle?.alreadyCommitted) {
      return { ok: true, quiesced: true, timedOut: false, alreadyCommitted: true };
    }
    if (!this._currentDeletion(handle)) {
      return { ok: false, quiesced: false, reason: 'stale_deletion_handle' };
    }
    const barriers = [
      ...(handle.lease?.providerQuiescedPromise ? [handle.lease.providerQuiescedPromise] : []),
      ...(handle.lease?.settledPromise ? [handle.lease.settledPromise] : []),
      ...(Array.isArray(handle.pendingMutationPromises) ? handle.pendingMutationPromises : []),
    ];
    if (!barriers.length) {
      handle.quiesced = true;
      return { ok: true, quiesced: true, timedOut: false };
    }
    const pending = Promise.allSettled(barriers);
    const parsed = Number(timeoutMs);
    const delay = Math.min(Math.max(
      Number.isFinite(parsed) ? parsed : DEFAULT_QUIESCENCE_TIMEOUT_MS, 0
    ), MAX_QUIESCENCE_TIMEOUT_MS);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), delay);
    });
    const settled = Promise.resolve(pending).then(
      () => ({ timedOut: false, rejected: false }),
      () => ({ timedOut: false, rejected: true })
    );
    const result = await Promise.race([settled, timeout]);
    clearTimeout(timer);
    handle.quiesced = result.timedOut !== true;
    if (result.timedOut) {
      return { ok: false, quiesced: false, timedOut: true, reason: 'quiescence_timeout' };
    }
    return { ok: true, quiesced: true, timedOut: false, rejected: result.rejected };
  }
  commitDeletion(handle, mutation) {
    if (handle?.alreadyCommitted) {
      return Promise.resolve({ ok: true, result: handle.result, alreadyCommitted: true });
    }
    if (!this._currentDeletion(handle)) {
      return Promise.resolve({ ok: false, reason: 'stale_deletion_handle' });
    }
    if (!handle.quiesced) return Promise.resolve({ ok: false, reason: 'not_quiesced' });
    if (typeof mutation !== 'function') {
      throw new TypeError('SessionTurnActor.commitDeletion requires a mutation function.');
    }
    if (handle.commitPromise) return handle.commitPromise;
    const actor = handle.actor;
    actor.tombstoned = true;
    handle.commitPromise = (async () => {
      const result = await mutation();
      const explicitlyDeleted = result === true || (
        isRecord(result)
        && (result.deleted === true || (result.ok === true && result.deleted !== false))
      );
      if (!explicitlyDeleted) {
        return { ok: false, reason: 'delete_refused', result };
      }
      if (handle.lease) {
        this._removeController(handle.lease, actor);
        handle.lease.released = true;
        handle.lease.settleLease();
      }
      actor.lease = null;
      actor.deleting = false;
      actor.tombstoned = true;
      actor.deletionResult = result;
      actor.deletionHandle = null;
      handle.committed = true;
      this._touch(actor);
      return { ok: true, result };
    })();
    return handle.commitPromise;
  }
  rollbackDeletion(handle) {
    if (!this._currentDeletion(handle)) return false;
    const actor = handle.actor;
    actor.deleting = false;
    actor.tombstoned = false;
    actor.deletionHandle = null;
    handle.rolledBack = true;
    if (handle.lease && actor.lease === handle.lease) {
      // A timed-out cancellation may still be executing. Keep that lease as
      // the admission barrier until its own terminal path releases it; a new
      // generation must never overlap the unresolved zombie.
      this._log('WARN', 'lifecycle.session_delete_rollback_pending_turn', {
        sessionId: handle.sessionId,
        streamId: handle.lease.identity.streamId,
        generation: handle.lease.identity.generation,
      });
    }
    this._touch(actor);
    return true;
  }
  _assertEditAnchor(store, sessionId, editId) {
    const anchor = sessionMessages(store, sessionId).find(
      (message) => normalizeId(message?.id) === editId
    );
    if (anchor && normalizeId(anchor.role) === 'user') return;
    throw Object.assign(new Error('The edited user message is no longer available.'), {
      code: 'invalid_edit_target', category: 'validation', retryable: false,
    });
  }
  _getActor(sessionId, store) {
    const existing = this._actors.get(sessionId);
    if (existing) {
      if (store && !existing.store) {
        const persisted = this._persistedState(store, sessionId);
        if (!existing.lease) {
          existing.sessionIncarnation = persisted.sessionIncarnation
            || existing.sessionIncarnation;
          existing.generation = Math.max(existing.generation, persisted.generation || 0);
        }
        existing.store = store;
      }
      this._touch(existing);
      return existing;
    }
    this._evict();
    const persisted = store ? this._persistedState(store, sessionId) : {};
    const actor = {
      sessionId,
      sessionIncarnation: persisted.sessionIncarnation || this._id('incarnation'),
      generation: persisted.generation || 0, store: store || null,
      lease: null, controller: null, deleting: false, tombstoned: false,
      deletionHandle: null, recoveryBlocked: '', legacyContinuationTokenId: '',
      deletionResult: null,
      pendingMutations: new Set(),
    };
    this._actors.set(sessionId, actor);
    return actor;
  }
  _persistedState(store, sessionId) {
    const session = store.getSession(sessionId) || {};
    const active = store.getActiveTurn(sessionId) || {};
    const token = getContinuationToken(session);
    return {
      sessionIncarnation: normalizeId(
        session.session_incarnation || active.session_incarnation || token?.session_incarnation
      ),
      generation: Math.max(
        asGeneration(session.turn_generation),
        asGeneration(active.generation),
        token ? token.prior_generation + (token.consumed ? 1 : 0) : 0
      ),
    };
  }
  _evict() {
    if (this._actors.size < this.maxActors) return;
    for (const [sessionId, actor] of this._actors) {
      if (
        !actor.lease
        && !actor.deleting
        && !actor.recoveryBlocked
        && actor.pendingMutations.size === 0
      ) {
        this._actors.delete(sessionId);
        this._log('DEBUG', 'lifecycle.session_turn_actor_evicted', { sessionId });
        return;
      }
    }
    throw Object.assign(new Error('The session turn actor registry is at capacity.'), {
      code: 'actor_registry_full', category: 'resource_limit', retryable: true,
    });
  }
  _recoverOrphan(actor, store, activeTurn) {
    const { sessionId } = actor;
    const requestId = normalizeId(activeTurn.request_id);
    const streamId = normalizeId(activeTurn.stream_id || requestId);
    if (!requestId || !streamId) {
      actor.recoveryBlocked = 'invalid_active_turn';
      throw recoveryError(actor.recoveryBlocked);
    }
    try {
      const messages = sessionMessages(store, sessionId);
      const terminalEvidence = hasTerminalMessageEvidence(messages, streamId);
      const session = store.getSession(sessionId);
      const pendingBatch = getPendingQuestionBatch(session);
      const continuationToken = getContinuationToken(session, pendingBatch);
      const restoreRequired = activeTurn.continuation_restore_required === true;
      const terminalConsumedContinuation = terminalEvidence
        && terminalConsumesContinuation(messages, streamId);
      if (
        pendingBatch
        && continuationToken?.consumed
        && (!terminalConsumedContinuation || restoreRequired)
      ) {
        const restoredToken = { ...continuationToken, consumed: false };
        if (!this._writeBatch(store, sessionId, {
          ...pendingBatch,
          continuation_token: restoredToken,
        }, restoredToken)) {
          throw recoveryError('continuation_restore_failed');
        }
        this._log('INFO', 'lifecycle.orphan_continuation_restored', {
          sessionId,
          streamId,
          generation: asGeneration(activeTurn.generation, null),
        });
      }
      if (!terminalEvidence) {
        const timestamp = this._timestamp();
        const existing = sessionMessages(store, sessionId)
          .find((message) => normalizeId(message?.id) === `assistant_${streamId}`);
        const row = {
          id: `assistant_${streamId}`, role: 'assistant', content: INTERRUPTED_MESSAGE,
          status: 'interrupted', terminal_status: 'interrupted', stream_error: INTERRUPTED_MESSAGE,
          category: 'interrupted', retryable: true, parent_stream_id: streamId, timestamp,
          finalizedAt: timestamp,
          client_message_id: `assistant_${streamId}`,
        };
        let persisted;
        if (existing && typeof store.updateMessage === 'function') {
          persisted = store.updateMessage(sessionId, row.id,
            { ...row, content: String(existing.content || INTERRUPTED_MESSAGE) });
        } else {
          persisted = typeof store.appendMessage === 'function'
            ? store.appendMessage(sessionId, row, { updatePreview: true })
            : store.appendLocalMessage?.(sessionId, row, { updatePreview: true });
        }
        if (!persisted) throw recoveryError('interrupted_persist_refused');
        this._flush(store, sessionId, 'interrupted_flush_refused');
      }
      if (!this._clearOrphanActiveTurnDurably(store, sessionId, activeTurn)) {
        throw recoveryError('active_turn_clear_durability_failed');
      }
      actor.generation = Math.max(actor.generation, asGeneration(activeTurn.generation));
      actor.recoveryBlocked = '';
      this._log('INFO', 'lifecycle.orphan_turn_interrupted', {
        sessionId, streamId, generation: asGeneration(activeTurn.generation, null),
      });
    } catch (error) {
      const normalized = error?.code === 'active_turn_recovery_failed'
        ? error
        : recoveryError('recovery_exception', error);
      actor.recoveryBlocked = normalized.reason;
      throw normalized;
    }
  }
  _flush(store, sessionId, reason) {
    const flushed = typeof store.flushSession === 'function'
      ? store.flushSession(sessionId)
      : store.flush?.();
    if (flushed !== true) throw recoveryError(reason);
  }
  _validateContinuation(actor, store, response) {
    const session = store.getSession(actor.sessionId);
    const batch = getPendingQuestionBatch(session);
    const persisted = getContinuationToken(session, batch);
    const submitted = normalizeContinuationToken(
      response?.continuation_token || response?.continuationToken
    );
    if (!batch) throw continuationError('missing_persisted_batch');
    const batchId = normalizeId(batch.batch_id);
    if (!batchId) throw continuationError('missing_batch_id');
    if (normalizeId(response?.batch_id || response?.batchId) !== batchId) {
      throw continuationError('batch_mismatch');
    }
    if (!continuationSnapshotMatches(batch, response)) {
      throw continuationError('batch_snapshot_mismatch');
    }
    if (!persisted && !submitted) {
      const priorGeneration = Math.max(actor.generation, 1);
      const token = {
        token_id: this._id('continuation'),
        session_id: actor.sessionId,
        session_incarnation: actor.sessionIncarnation,
        batch_id: batchId,
        prior_generation: priorGeneration,
        consumed: false,
        issued_at: this._timestamp(),
      };
      actor.generation = priorGeneration;
      actor.legacyContinuationTokenId = token.token_id;
      return { batch, token, legacy: true };
    }
    if (!persisted) throw continuationError('missing_persisted_token');
    if (!submitted && actor.legacyContinuationTokenId !== persisted.token_id) {
      throw continuationError('missing_submitted_token');
    }
    const candidate = submitted || persisted;
    const fields = [
      'token_id', 'session_id', 'session_incarnation', 'batch_id', 'prior_generation',
    ];
    if (fields.some((field) => candidate[field] !== persisted[field])) {
      throw continuationError('token_mismatch');
    }
    if (
      persisted.session_id !== actor.sessionId
      || persisted.batch_id !== batchId
      || persisted.session_incarnation !== actor.sessionIncarnation
    ) {
      throw continuationError('token_scope_mismatch');
    }
    if (persisted.prior_generation <= 0 || persisted.prior_generation > actor.generation) {
      throw continuationError('stale_generation');
    }
    if (persisted.consumed || candidate.consumed) {
      throw continuationError('token_consumed');
    }
    return { batch, token: persisted };
  }
  _consumeContinuation(lease, continuation) {
    const token = { ...continuation.token, consumed: true };
    const batch = { ...continuation.batch, continuation_token: token };
    // Record the rollback snapshot before the store mutation. Some stores
    // update their in-memory cache before reporting a failed flush; the outer
    // reservation rollback must still be able to restore the retry token.
    lease.consumedContinuation = continuation;
    if (!this._writeBatch(lease.store, lease.identity.sessionId, batch, token)) {
      throw continuationError('consume_persist_failed', true);
    }
  }
  _restoreContinuation(lease) {
    const consumed = lease.consumedContinuation;
    if (!consumed) return false;
    const session = lease.store.getSession(lease.identity.sessionId);
    const batch = getPendingQuestionBatch(session);
    const current = getContinuationToken(session, batch);
    if (!batch || !current || current.token_id !== consumed.token.token_id) {
      return false;
    }
    if (!current.consumed) return true;
    const token = { ...current, consumed: false };
    const restored = this._writeBatch(lease.store, lease.identity.sessionId, {
      ...batch, continuation_token: token,
    }, token);
    if (!restored) {
      this._log('ERROR', 'lifecycle.continuation_restore_failed', {
        sessionId: lease.identity.sessionId, streamId: lease.identity.streamId,
        generation: lease.identity.generation,
      });
    }
    return restored;
  }
  _writeBatch(store, sessionId, batch, token) {
    const previousBatch = getPendingQuestionBatch(store.getSession(sessionId));
    const result = this._setBatch(store, sessionId, batch);
    if (!result) return false;
    const session = store.getSession(sessionId);
    const persistedBatch = getPendingQuestionBatch(session);
    const persistedToken = getContinuationToken(session, persistedBatch);
    const verified = normalizeId(persistedBatch?.batch_id) === normalizeId(batch?.batch_id)
      && persistedToken?.token_id === token.token_id
      && persistedToken?.consumed === token.consumed;
    const flushed = verified
      && (typeof store.flushSession === 'function'
        ? store.flushSession(sessionId)
        : store.flush?.()) === true;
    if (flushed) return true;
    const rolledBack = this._setBatch(store, sessionId, previousBatch);
    const rollbackFlushed = rolledBack
      && (typeof store.flushSession === 'function'
        ? store.flushSession(sessionId)
        : store.flush?.()) === true;
    if (!rollbackFlushed) {
      this._log('ERROR', 'lifecycle.continuation_write_rollback_failed', {
        sessionId,
        tokenId: normalizeId(token?.token_id) || null,
      });
    }
    return false;
  }
  _setBatch(store, sessionId, batch) {
    const patch = { pending_question_batch: batch };
    if (typeof store.setSessionPreferences === 'function') {
      return store.setSessionPreferences(sessionId, patch);
    }
    if (typeof store.updateSession === 'function') {
      return store.updateSession(sessionId, patch);
    }
    if (typeof store.upsertSession === 'function') {
      return store.upsertSession(sessionId, patch);
    }
    return null;
  }
  _activeTurnMatches(activeTurn, identity) {
    return Boolean(
      activeTurn
      && normalizeId(activeTurn.request_id) === identity.turnId
      && normalizeId(activeTurn.turn_id || activeTurn.stream_id) === identity.turnId
      && normalizeId(activeTurn.stream_id) === identity.streamId
      && normalizeId(activeTurn.user_message_id) === identity.userMessageId
      && normalizeId(activeTurn.session_incarnation) === identity.sessionIncarnation
      && asGeneration(activeTurn.generation, -1) === identity.generation
    );
  }
  _buildActiveTurnClaim(lease, traceId = '') {
    const timestamp = this._timestamp();
    const { identity } = lease;
    return {
      request_id: identity.turnId,
      turn_id: identity.turnId,
      stream_id: identity.streamId,
      user_message_id: identity.userMessageId,
      trace_id: normalizeId(traceId) || identity.streamId,
      session_incarnation: identity.sessionIncarnation,
      generation: identity.generation,
      started_at: timestamp,
      last_event_at: timestamp,
      status: 'awaiting_assistant',
    };
  }
  _clearActiveTurnDurably(lease) {
    const { store, identity } = lease;
    const before = store.getActiveTurn(identity.sessionId);
    try {
      if (before) {
        if (!this._activeTurnMatches(before, identity)) return false;
        const cleared = store.clearActiveTurn(identity.sessionId, {
          request_id: identity.turnId,
          stream_id: identity.streamId,
        });
        if (!cleared) return false;
      }
      this._flush(store, identity.sessionId, 'active_turn_release_flush_refused');
      if (!store.getActiveTurn(identity.sessionId)) return true;
    } catch (_error) {
      // Restore the conservative in-flight bracket below.
    }
    try {
      const restored = store.setActiveTurn(
        identity.sessionId,
        before || lease.activeTurnClaim,
        { expectedPriorStreamId: identity.streamId }
      );
      if (restored) {
        this._flush(store, identity.sessionId, 'active_turn_release_rollback_flush_refused');
      }
    } catch (_error) {
      // The caller installs a fail-closed recovery barrier.
    }
    return false;
  }
  _clearOrphanActiveTurnDurably(store, sessionId, activeTurn) {
    const requestId = normalizeId(activeTurn?.request_id);
    const streamId = normalizeId(activeTurn?.stream_id || requestId);
    try {
      const cleared = store.clearActiveTurn(sessionId, {
        request_id: requestId,
        stream_id: streamId,
      });
      if (!cleared) return false;
      this._flush(store, sessionId, 'active_turn_clear_flush_refused');
      if (!store.getActiveTurn(sessionId)) return true;
    } catch (_error) {
      // Restore the exact crash-recovery bracket below.
    }
    try {
      const restored = store.setActiveTurn(
        sessionId,
        activeTurn,
        { expectedPriorStreamId: streamId }
      );
      if (restored) {
        this._flush(store, sessionId, 'active_turn_clear_rollback_flush_refused');
      }
    } catch (_error) {
      // The caller leaves a fail-closed in-memory recovery barrier.
    }
    return false;
  }
  _ensureActiveTurnDurably(lease) {
    const { store, identity } = lease;
    try {
      const current = store.getActiveTurn(identity.sessionId);
      if (current && !this._activeTurnMatches(current, identity)) return false;
      const markerRequired = lease.activeTurnClaim?.continuation_restore_required === true;
      if (!current || (markerRequired && current.continuation_restore_required !== true)) {
        const restored = store.setActiveTurn(
          identity.sessionId,
          lease.activeTurnClaim,
          { expectedPriorStreamId: identity.streamId }
        );
        if (!restored) return false;
      }
      this._flush(store, identity.sessionId, 'active_turn_preserve_flush_refused');
      return this._activeTurnMatches(store.getActiveTurn(identity.sessionId), identity);
    } catch (_error) {
      return false;
    }
  }
  _leaseReason(lease, allowDeleting = false) {
    const identity = lease?.identity;
    const actor = this._actors.get(normalizeId(identity?.sessionId));
    if (!actor) return 'actor_missing';
    if (!allowDeleting && actor.tombstoned) {
      return 'session_tombstoned';
    }
    if (actor.lease !== lease || lease.released) return 'stale_lease';
    if (
      identity.sessionIncarnation !== actor.sessionIncarnation
      || identity.generation !== actor.generation
    ) return 'identity_mismatch';
    return '';
  }
  _removeController(lease, actor) {
    const registered = lease.activeStreams?.get?.(lease.identity.streamId);
    if (!lease.controller || registered === lease.controller) {
      lease.activeStreams?.delete?.(lease.identity.streamId);
    }
    actor.controller = null;
    lease.controller = null;
  }
  _cancelForDeletion(actor, lease, controller) {
    const handle = actor.deletionHandle;
    try {
      if (handle?.cancel) {
        handle.cancel(lease?.identity?.streamId || '', controller || null);
      } else {
        controller?.abort?.();
      }
    } catch (error) {
      this._log('WARN', 'lifecycle.deletion_abort_failed', {
        sessionId: actor.sessionId,
        message: String(error?.message || error).slice(0, 300),
      });
    }
  }
  hasActiveLifecycle(sessionId) {
    const actor = this._actors.get(normalizeId(sessionId));
    return Boolean(
      actor
      && (actor.lease || actor.deleting || actor.tombstoned || actor.pendingMutations.size)
    );
  }
  _currentDeletion(handle) {
    return Boolean(
      handle
      && this._actors.get(handle.sessionId) === handle.actor
      && handle.actor.deletionHandle === handle
      && !handle.committed
      && !handle.rolledBack
    );
  }
  _touch(actor) {
    if (this._actors.get(actor.sessionId) !== actor) return;
    this._actors.delete(actor.sessionId);
    this._actors.set(actor.sessionId, actor);
  }
  _id(prefix) { return `${prefix}_${normalizeId(this._createId()) || randomUUID()}`; }
  _timestamp() { return new Date(this._now()).toISOString(); }
  _logDrop(lease, site, reason) {
    const identity = lease?.identity || {};
    this._log('WARN', 'lifecycle.stale_mutation_dropped', {
      sessionId: normalizeId(identity.sessionId) || null,
      sessionIncarnation: normalizeId(identity.sessionIncarnation) || null,
      generation: Number.isSafeInteger(identity.generation) ? identity.generation : null,
      turnId: normalizeId(identity.turnId) || null, streamId: normalizeId(identity.streamId) || null,
      site: normalizeId(site) || 'unknown', reason,
    });
  }
  _recordLeaseConflict(path, sessionId, reason) {
    recordLifecycleDiagnostic(
      (level, event, details) => this._log(level, event, details),
      'lease_conflict',
      { path: normalizeId(path) || 'actor', sessionId, reason }
    );
  }
  _log(level, event, details) {
    try {
      this._logger?.(level, event, details);
    } catch (_error) {
      // Observability must never reopen a lifecycle race.
    }
  }
}
function ensureSessionTurnActorRegistry(service) {
  if (!service || typeof service !== 'object') {
    throw new TypeError('ensureSessionTurnActorRegistry requires a service object.');
  }
  const existing = service.sessionTurnActorRegistry || service.sessionTurnActors;
  if (existing instanceof SessionTurnActorRegistry) {
    if (!existing._terminalRepairStore && service.terminalRepairStore) {
      existing._terminalRepairStore = service.terminalRepairStore;
    }
    service.sessionTurnActorRegistry = existing;
    service.sessionTurnActors = existing;
    return existing;
  }
  const registry = new SessionTurnActorRegistry({
    maxActors: service.sessionTurnActorRegistryMaxActors,
    terminalRepairStore: service.terminalRepairStore || null,
    logger: typeof service._emitServiceLog === 'function'
      ? (level, event, details) => service._emitServiceLog(level, event, details)
      : null,
  });
  service.sessionTurnActorRegistry = registry;
  service.sessionTurnActors = registry;
  return registry;
}
module.exports = {
  DEFAULT_MAX_ACTORS,
  SessionTurnActorRegistry,
  ensureSessionTurnActorRegistry,
};

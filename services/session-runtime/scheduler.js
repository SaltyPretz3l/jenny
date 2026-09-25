'use strict';

const { randomUUID } = require('node:crypto');
const { isRuntimeRoute } = require('./lanes');
const { normalizeReason } = require('./lifecycle');
const { reclaimAbandonedWork } = require('./abandoned-work-reclaim');
const { persistFencedCancellation } = require('./fenced-cancellation');

const { TERMINAL: TERMINAL_OUTCOMES } = require('./terminal-retention-contract');

function sameAttempt(left, right) {
  return Boolean(left && right && ['attempt_id', 'stream_id', 'incarnation', 'authority_revision']
    .every(key => left[key] === right[key]));
}

function provenOutcome(outcome) {
  return outcome?.producerSettled === true && outcome?.canonicalSettled === true
    && TERMINAL_OUTCOMES.has(outcome.status);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class SessionRuntimeScheduler {
  constructor({ store, lanes, resolveRoute, validateWork, prepareCanonical = null,
    claimCanonical, startProducer, cancelProducer = null, pauseProducer = null, discardPending = null,
    provePausedCleanup = null, enabled = true, createId = randomUUID,
    onAttention = null, onSuspended = null, captureEligibility = null, releaseEligibility = null,
    validateCheckpoint = null, onWorkChange = null } = {}) {
    for (const operation of [resolveRoute, validateWork, claimCanonical, startProducer]) {
      if (typeof operation !== 'function') throw new TypeError('runtime_scheduler_port_required');
    }
    if (!store || !lanes) throw new TypeError('runtime_scheduler_owner_required');
    this.store = store;
    this.lanes = lanes;
    this.resolveRoute = resolveRoute;
    this.validateWork = validateWork;
    this.prepareCanonical = typeof prepareCanonical === 'function' ? prepareCanonical : () => true;
    this.claimCanonical = claimCanonical;
    this.startProducer = startProducer;
    this.pauseProducer = typeof pauseProducer === 'function' ? pauseProducer : () => false;
    this.cancelProducer = typeof cancelProducer === 'function' ? cancelProducer : () => false;
    this.discardPending = typeof discardPending === 'function' ? discardPending : () => false;
    this.provePausedCleanup = typeof provePausedCleanup === 'function' ? provePausedCleanup : () => false;
    this.enabled = enabled === true;
    this.createId = createId;
    this.incarnation = createId();
    this.onAttention = typeof onAttention === 'function' ? onAttention : null;
    this.onSuspended = typeof onSuspended === 'function' ? onSuspended : null;
    this.captureEligibility = typeof captureEligibility === 'function' ? captureEligibility : () => null;
    this.releaseEligibility = typeof releaseEligibility === 'function' ? releaseEligibility : () => false;
    this.validateCheckpoint = typeof validateCheckpoint === 'function' ? validateCheckpoint : () => false;
    this.onWorkChange = onWorkChange;
    this.active = new Map();
    this.cancellationFences = new Map();
    this.pausedCancellationSettlements = new Map();
    this.closing = false;
    this.pumping = false;
    this.lanePumpScheduled = false;
    this.laneMutationDepth = 0;
  }

  setEnabled(enabled) {
    this.enabled = enabled === true;
    if (!this.enabled) {
      this.pausePending({ reason: 'runtime_disabled' });
    }
    // Re-enabling never resumes paused work. Existing producers retain their
    // leases until the normal canonical and physical settlement path completes.
  }

  notifyLaneAvailability() {
    if (!this.enabled || this.closing || this.lanePumpScheduled || this.laneMutationDepth) return false;
    this.lanePumpScheduled = true;
    queueMicrotask(() => {
      this.lanePumpScheduled = false;
      if (!this.enabled || this.closing) return;
      try { this.pump(); } catch (error) { this._attention(null, error); }
    });
    return true;
  }

  resume(workId, expectedRevision) {
    if (this.closing) return Object.freeze({ status: 'rejected', reason: 'runtime_closing' });
    if (!this.enabled) return Object.freeze({ status: 'rejected', reason: 'runtime_disabled' });
    const work = this.store.get(workId);
    if (!work || work.status !== 'paused') return Object.freeze({ status: 'rejected', reason: 'work_not_paused' });
    if (!this._checkpointShapeValid(work)) {
      return Object.freeze({ status: 'rejected', reason: 'runtime_checkpoint_required' });
    }
    const route = this.resolveRoute(work);
    // Retryable admission pressure is not a refusal: the work waits in the pending queue.
    try { this.validateWork(work, route); } catch (error) { if (error?.retryable !== true) throw error; }
    this.store.transition(workId, { expectedRevision, to: 'pending', reason: 'explicit_resume',
      clearPause: work.control_request?.kind === 'pause' });
    this.pump();
    return Object.freeze({ status: 'accepted' });
  }

  hasPendingOrAdmittedWork() {
    return this.active.size > 0 || this.store.getStatus().pending.host_count > 0;
  }

  hasSessionActiveWork(sessionId) {
    return [...this.active.values()].some(entry => entry.work.session_id === sessionId);
  }

  hasSessionCancellationFence(sessionId) {
    return [...this.cancellationFences.values()].some(fence => fence.session_id === sessionId);
  }
  hasUnsettledCancellationFence(sessionId = null) {
    return [...this.cancellationFences].some(([workId, fence]) => {
      if (sessionId !== null && fence.session_id !== sessionId) return false;
      try { return this.active.has(workId) || this.pausedCancellationSettlements.has(workId)
        || this.store.get(workId)?.control_request?.kind !== 'cancel'; }
      catch (_error) { return true; }
    });
  }
  beginClosing() { this.closing = true; return true; }
  reclaimAbandoned(options) { return reclaimAbandonedWork(this, options); }

  reopenAfterShutdown() {
    const lanes = this.lanes.snapshot();
    if (this.active.size || this.hasUnsettledCancellationFence()
      || lanes.active_leases || lanes.quarantined) {
      return Object.freeze({ ok: false, reason: 'runtime_cleanup_unconfirmed' });
    }
    this.closing = false;
    return Object.freeze({ ok: true });
  }

  pausePending({ sessionId = null, reason = 'runtime_paused' } = {}) {
    const normalizedSession = sessionId === null ? null : String(sessionId || '').trim();
    const normalizedReason = normalizeReason(reason, 'runtime_paused');
    let paused = 0;
    for (const summary of this._listSummaries(normalizedSession)) {
      if (summary.status !== 'pending') continue;
      const work = this.store.get(summary.work_id);
      if (!work || work.status !== 'pending') continue;
      try {
        this.store.transition(work.work_id, { expectedRevision: work.revision,
          to: 'paused', reason: normalizedReason });
        this.discardPending(work);
        paused += 1;
      } catch (error) { this._attention(work.work_id, error); }
    }
    return Object.freeze({ paused });
  }

  requestPause(workId, { expectedRevision, reason = 'user_pause' } = {}) {
    const current = this.store.get(workId);
    if (!current) return Object.freeze({ status: 'rejected', reason: 'work_not_found' });
    if (current.revision !== expectedRevision) return Object.freeze({ status: 'rejected', reason: 'revision_conflict' });
    this._assertCancellationOpen(current);
    if (current.status === 'paused') return Object.freeze({ status: 'paused', work_id: workId });
    if (current.status === 'pending') {
      const paused = this.store.transition(workId, { expectedRevision, to: 'paused', reason: normalizeReason(reason, 'user_pause') }).record;
      this.discardPending(paused);
      return Object.freeze({ status: 'paused', work_id: workId, revision: paused.revision });
    }
    const entry = this.active.get(workId);
    if (!entry || !sameAttempt(entry.attempt, current.attempt)) {
      return Object.freeze({ status: 'rejected', reason: 'pause_attempt_unavailable' });
    }
    const saved = this.store.requestPause(workId, { expectedRevision,
      expectedAttempt: entry.attempt, reason: normalizeReason(reason, 'user_pause') }).record;
    try { this.pauseProducer(saved); } catch (error) { this._attention(workId, error); }
    return Object.freeze({ status: 'requested', work_id: workId, revision: saved.revision });
  }

  requestCancellation(workId, { expectedRevision, reason = 'user', abort = true,
    deletionHandle = null } = {}) {
    const id = String(workId || '').trim();
    const current = id ? this.store.get(id) : null;
    if (!current) return Object.freeze({ status: 'rejected', work_id: id || null,
      cleanup_confirmed: false, reason: 'work_not_found' });
    const active = this.active.get(id);
    if (TERMINAL_OUTCOMES.has(current.status)) {
      return Object.freeze({ status: current.status, work_id: id,
        cleanup_confirmed: !active && !this.cancellationFences.has(id),
        ...(active ? { settlement: active.cleanupPromise } : {}) });
    }
    const pendingCleanup = this.pausedCancellationSettlements.get(id);
    if (pendingCleanup) return Object.freeze({ status: 'requested', work_id: id,
      cleanup_confirmed: false, persisted: true, settlement: pendingCleanup.promise });
    const normalizedReason = normalizeReason(reason, 'user');
    this.cancellationFences.set(id, Object.freeze({ attempt: current.attempt,
      reason: normalizedReason, session_id: current.session_id }));
    let saved = current;
    let persisted = true;
    try {
      if (current.attempt) {
        saved = this.store.requestCancellation(id, {
          expectedRevision: expectedRevision === undefined ? current.revision : expectedRevision,
          expectedAttempt: current.attempt,
          reason: normalizedReason,
        }).record;
      } else if (['pending', 'paused'].includes(current.status)) {
        saved = this.store.transition(id, {
          expectedRevision: expectedRevision === undefined ? current.revision : expectedRevision,
          to: 'cancelled', reason: normalizedReason,
        }).record;
      } else {
        throw new Error('cancellation_state_conflict');
      }
    } catch (error) {
      persisted = false;
      this._attention(id, error);
    }
    if (persisted) {
      try { this.onWorkChange?.(saved); } catch (error) { this._attention(id, error); }
    }
    if (!current.attempt && persisted && saved.status === 'cancelled') {
      this.discardPending(current);
      this.cancellationFences.delete(id);
      return Object.freeze({ status: 'cancelled', work_id: id,
        cleanup_confirmed: true, persisted: true });
    }
    const entry = this.active.get(id);
    if (entry) {
      try { this.cancelProducer(saved, normalizedReason, { abort: abort === true }); }
      catch (error) { this._attention(id, error); }
      return Object.freeze({ status: 'requested', work_id: id,
        cleanup_confirmed: false, persisted, settlement: entry.cleanupPromise });
    }
    this.discardPending(saved);
    if (persisted && ['pending', 'paused'].includes(saved.status)) {
      return require('./paused-cancellation-recovery').settlePausedCancellation(
        this, saved, normalizedReason, deletionHandle);
    }

    return Object.freeze({ status: 'requested', work_id: id,
      cleanup_confirmed: false, persisted });
  }

  noteStreamCancellation(streamId, reason = 'user') {
    const id = String(streamId || '').trim();
    const entry = [...this.active.values()].find(candidate => candidate.attempt.stream_id === id);
    if (!entry) return Object.freeze({ status: 'rejected', work_id: null,
      cleanup_confirmed: false, reason: 'runtime_stream_not_found' });
    const current = this.store.get(entry.work.work_id);
    return this.requestCancellation(entry.work.work_id, {
      expectedRevision: current?.revision, reason, abort: false,
    });
  }

  cleanupPromises({ sessionId = null } = {}) {
    return [...[...this.active.values()].filter(entry => sessionId === null
      || entry.work.session_id === sessionId).map(entry => entry.cleanupPromise),
    ...[...this.pausedCancellationSettlements.values()].filter(entry => sessionId === null
      || entry.session_id === sessionId).map(entry => entry.promise)];
  }

  pump() {
    if (this.closing || !this.enabled || this.pumping || this.store.getStatus().read_only) return [];
    this.pumping = true;
    const results = [];
    try {
      for (const summary of this.store.listReadyCandidates({ limit: 256 })) {
        // An ineligible session/lane does not stall later unrelated work.
        results.push(this.tryDispatch(summary.work_id));
      }
    } finally {
      this.pumping = false;
    }
    return results;
  }

  tryDispatch(workId, { immediate = false } = {}) {
    // Rollback of reservations during admission must not schedule another pump
    // against the same unchanged blocker (for example a legacy session actor).
    return this._mutateLanes(() => this._tryDispatch(workId, { immediate }));
  }

  _admissionFailure(work, error) {
    if (error?.retryable === true) {
      return this._waiting(work, { status: 'waiting', reason: String(error.code || 'admission_busy') });
    }
    try {
      this.store.transition(work.work_id, { expectedRevision: work.revision,
        to: 'paused', reason: 'admission_revalidation_failed' });
      this.discardPending(work);
    } catch (persistError) { this._attention(work.work_id, persistError); }
    this._attention(work.work_id, error);
    return Object.freeze({ status: 'rejected', reason: 'admission_revalidation_failed' });
  }

  _tryDispatch(workId, { immediate = false } = {}) {
    if (this.store.getStatus().read_only) return Object.freeze({ status: 'rejected', reason: 'runtime_store_read_only' });
    const work = this.store.get(workId);
    if (!work || work.status !== 'pending') return Object.freeze({ status: 'rejected', reason: 'work_not_pending' });
    if (this.closing) {
      this.pausePending({ sessionId: work.session_id, reason: 'runtime_closing' });
      return Object.freeze({ status: 'rejected', reason: 'runtime_closing' });
    }
    if (!this.enabled && !immediate) {
      return this._waiting(work, { status: 'waiting', reason: 'runtime_disabled' });
    }
    let route;
    try {
      this._assertCancellationOpen(work);
      this._assertCheckpointShape(work);
      route = this.resolveRoute(work);
      if (!isRuntimeRoute(route)) throw new Error('runtime_provider_route_untrusted');
      this.validateWork(work, route);
    } catch (error) {
      return this._admissionFailure(work, error);
    }
    const admission = this.lanes.tryAcquireTurn({ sessionId: work.session_id, route });
    if (admission.status !== 'granted') return this._waiting(work, admission);
    try {
      this._assertCancellationOpen(work);
      this._assertCheckpoint(work);
      this.prepareCanonical(work, route);
    } catch (error) {
      this.lanes.release(admission.lease, { producerSettled: true });
      return this._admissionFailure(work, error);
    }
    let canonicalClaim;
    try {
      canonicalClaim = this.claimCanonical(work, route);
      if (!canonicalClaim || typeof canonicalClaim.rollbackBeforeStart !== 'function'
        || typeof canonicalClaim.assertCurrent !== 'function') {
        throw new Error('runtime_canonical_claim_invalid');
      }
      this.validateWork(work, route);
      this._assertCancellationOpen(work);
      this._assertCheckpointShape(work);
      const attempt = Object.freeze({ attempt_id: this.createId(), stream_id: canonicalClaim.streamId,
        incarnation: this.incarnation, authority_revision: canonicalClaim.authorityRevision });
      const running = this.store.transition(workId, { expectedRevision: work.revision,
        to: 'running', reason: 'runtime_admitted', attempt }).record;
      const cleanup = deferred();
      const entry = { work: running, route, attempt, canonicalClaim, lease: admission.lease,
        eligibilityAdmission: this.captureEligibility(work.session_id),
        cleanupPromise: cleanup.promise, resolveCleanup: cleanup.resolve,
        initialSettlementDone: false, lateConfirmation: null };
      this.active.set(workId, entry);
      const completion = Promise.resolve().then(() => this._start(entry));
      entry.completion = completion;
      return Object.freeze({ status: 'started', work_id: workId,
        turn_id: work.turn_id, stream_id: attempt.stream_id, completion });
    } catch (error) {
      const cleaned = canonicalClaim ? this._rollback(canonicalClaim) : (error?.code === 'session_busy' || error?.claimState === 'not_claimed');
      this.lanes.release(admission.lease, { producerSettled: cleaned });
      if (!cleaned) {
        try {
          this.store.transition(workId, { expectedRevision: work.revision,
            to: 'paused', reason: 'canonical_claim_uncertain' });
        } catch (persistError) { this._attention(workId, persistError); }
        this._attention(workId, error);
      }
      if (cleaned && error?.claimState === 'not_claimed') return this._admissionFailure(work, error);
      const result = { status: cleaned ? 'waiting' : 'rejected', reason: error?.code === 'session_busy' ? 'session_busy' : 'canonical_claim_failed' };
      return cleaned && !this.store.getStatus().read_only ? this._waiting(work, result) : Object.freeze(result);
    }
  }

  _waiting(work, result) {
    if (!this.enabled && result.status === 'waiting') {
      this.store.transition(work.work_id, { expectedRevision: work.revision,
        to: 'paused', reason: 'runtime_disabled' });
    }
    return Object.freeze(result);
  }

  _assertCurrent(entry) {
    const current = this._assertSettlementCurrent(entry);
    this._assertCancellationOpen(current);
    this.validateWork(current, entry.route);
    entry.canonicalClaim.assertCurrent?.();
    return current;
  }

  _assertSettlementCurrent(entry) {
    const current = this.store.get(entry.work.work_id);
    if (this.active.get(entry.work.work_id) !== entry || current?.status !== 'running'
      || !sameAttempt(current.attempt, entry.attempt) || entry.attempt.incarnation !== this.incarnation) {
      throw new Error('runtime_attempt_stale');
    }
    return current;
  }

  async _start(entry) {
    let outcome;
    try {
      this._assertCurrent(entry);
    } catch (error) {
      const cancelled = this._isCancellationRequested(entry);
      outcome = { status: cancelled ? 'cancelled' : 'failed', producerSettled: true,
        canonicalSettled: this._rollback(entry.canonicalClaim) };
      if (!cancelled) this._attention(entry.work.work_id, error);
    }
    if (!outcome) {
      try {
        outcome = await this.startProducer({ work: entry.work, route: entry.route,
          attempt: entry.attempt, canonicalClaim: entry.canonicalClaim,
          assertCurrent: () => this._assertCurrent(entry),
          assertSettlementCurrent: () => this._assertSettlementCurrent(entry),
          confirmLateSettlement: lateOutcome => this.confirmLateSettlement({
            workId: entry.work.work_id, attempt: entry.attempt, outcome: lateOutcome,
          }) });
      } catch (error) {
        // A thrown producer promise is not evidence of process-tree termination
        // or canonical receipt settlement. Preserve capacity for explicit repair.
        outcome = { status: 'failed', producerSettled: false, canonicalSettled: false };
        this._attention(entry.work.work_id, error);
      }
    }
    const initial = await this._settle(entry, outcome);
    entry.initialSettlementDone = true;
    if (!entry.lateConfirmation) return initial;
    const late = this._applyLateSettlement(entry);
    return TERMINAL_OUTCOMES.has(late.status) ? late : initial;
  }

  async _settle(entry, outcome) {
    const suspended = outcome?.status === 'paused' && outcome.producerSettled === true
      && outcome.canonicalSettled === true && outcome.checkpointSettled === true
      && sameAttempt(outcome.checkpointRef?.source_attempt, entry.attempt)
      && this._checkpointValid(entry.work, outcome.checkpointRef);
    const proven = provenOutcome(outcome) || suspended;
    let status = proven ? outcome.status : 'needs_attention';
    let persisted = false;
    let pausedWork = null;
    try {
      let current = this.store.get(entry.work.work_id);
      if (current?.status !== 'running' || !sameAttempt(current.attempt, entry.attempt)) {
        throw new Error('runtime_attempt_stale');
      }
      if (this.cancellationFences.has(current.work_id) && current.control_request?.kind !== 'cancel') {
        current = persistFencedCancellation(this, current, entry.attempt);
      }
      const cancellationRequested = current.control_request?.kind === 'cancel';
      if (suspended) {
        const paused = this.store.transition(current.work_id, { expectedRevision: current.revision,
          expectedAttempt: entry.attempt, to: 'paused', checkpointRef: outcome.checkpointRef,
          reason: 'checkpoint_suspended' }).record;
        pausedWork = paused;
      } else {
        if (proven && cancellationRequested) status = 'cancelled';
        this.store.transition(current.work_id, { expectedRevision: current.revision,
          expectedAttempt: entry.attempt, to: status,
          reason: proven ? 'producer_settled' : 'settlement_unconfirmed' });
      }
      persisted = true;
    } catch (error) {
      this._attention(entry.work.work_id, error);
    }
    const released = this._mutateLanes(() => this.lanes.release(entry.lease,
      { producerSettled: proven && persisted }));
    if (proven && persisted && released) {
      const cleanup = this._completeEntry(entry, status);
      if (status === 'paused' && cleanup?.cleanup_confirmed === true) status = 'cancelled';
      if (status === 'paused' && pausedWork
        && Array.isArray(outcome.waitResources) && outcome.waitResources.length) {
        try { this.onSuspended?.({ work: pausedWork, waitResources: outcome.waitResources,
          admission: entry.eligibilityAdmission }); }
        catch (error) { this._attention(entry.work.work_id, error); }
      }
      this.releaseEligibility(entry.eligibilityAdmission);
      this.notifyLaneAvailability();
    } else this._attention(entry.work.work_id, new Error('runtime_cleanup_quarantined'));
    return Object.freeze({ status: persisted ? status : 'needs_attention', work_id: entry.work.work_id });
  }

  confirmLateSettlement({ workId, attempt, outcome } = {}) {
    const entry = this.active.get(String(workId || ''));
    if (!entry || !sameAttempt(entry.attempt, attempt)) {
      return Promise.resolve(Object.freeze({ status: 'rejected', reason: 'runtime_attempt_stale' }));
    }
    if (!provenOutcome(outcome)) {
      return Promise.resolve(Object.freeze({ status: 'rejected', reason: 'settlement_unconfirmed' }));
    }
    if (entry.lateConfirmation) {
      return entry.lateConfirmation.outcome.status === outcome.status
        ? entry.lateConfirmation.promise
        : Promise.resolve(Object.freeze({ status: 'rejected', reason: 'runtime_settlement_conflict' }));
    }
    const confirmation = deferred();
    entry.lateConfirmation = { outcome: Object.freeze({ ...outcome }), ...confirmation };
    if (entry.initialSettlementDone) this._applyLateSettlement(entry);
    return confirmation.promise;
  }

  _applyLateSettlement(entry) {
    const confirmation = entry.lateConfirmation;
    if (!confirmation || confirmation.result) return confirmation?.result
      || Object.freeze({ status: 'rejected', reason: 'runtime_settlement_missing' });
    let result;
    try {
      let current = this.store.get(entry.work.work_id);
      if (this.active.get(entry.work.work_id) !== entry || current?.status !== 'needs_attention'
        || !sameAttempt(current.attempt, entry.attempt)
        || entry.attempt.incarnation !== this.incarnation) {
        throw new Error('runtime_attempt_stale');
      }
      if (this.cancellationFences.has(current.work_id) && current.control_request?.kind !== 'cancel') {
        current = persistFencedCancellation(this, current, entry.attempt);
      }
      const status = current.control_request?.kind === 'cancel'
        ? 'cancelled' : confirmation.outcome.status;
      const terminal = this.store.transition(current.work_id, { expectedRevision: current.revision,
        expectedAttempt: entry.attempt, to: status,
        reason: 'late_producer_settled' }).record;
      if (!this._mutateLanes(() => this.lanes.confirmCleanup(entry.lease))) {
        throw new Error('runtime_cleanup_not_quarantined');
      }
      this._completeEntry(entry, status);
      this.releaseEligibility(entry.eligibilityAdmission);
      result = Object.freeze({ status: terminal.status, work_id: terminal.work_id });
      this.notifyLaneAvailability();
    } catch (error) {
      this._attention(entry.work.work_id, error);
      result = Object.freeze({ status: 'needs_attention', work_id: entry.work.work_id,
        reason: String(error?.message || 'runtime_late_settlement_failed') });
    }
    confirmation.result = result;
    confirmation.resolve(result);
    return result;
  }

  _rollback(claim) { try { return claim.rollbackBeforeStart() === true; } catch (_error) { return false; } }

  _mutateLanes(operation) {
    this.laneMutationDepth += 1;
    try { return operation(); } finally { this.laneMutationDepth -= 1; }
  }
  _completeEntry(entry, status) {
    const id = entry.work.work_id;
    this.active.delete(id);
    const current = status === 'paused' ? this.store.get(id) : null;
    if (current?.control_request?.kind !== 'cancel') {
      this.cancellationFences.delete(id);
      entry.resolveCleanup?.(Object.freeze({ status, work_id: id, cleanup_confirmed: true }));
      return;
    }
    const requested = require('./paused-cancellation-recovery').settlePausedCancellation(this, current, current.control_request.reason, null);
    const resolve = settled => entry.resolveCleanup?.(Object.freeze({ status, work_id: id, cleanup_confirmed: settled?.cleanup_confirmed === true }));
    requested.settlement ? requested.settlement.then(resolve, () => resolve(null)) : resolve(requested);
    return requested;
  }
  _isCancellationRequested(entry) {
    return this.cancellationFences.has(entry.work.work_id)
      || this.store.get(entry.work.work_id)?.control_request?.kind === 'cancel';
  }

  _assertCancellationOpen(work) {
    if (this.cancellationFences.has(work.work_id) || work.control_request?.kind === 'cancel') {
      const error = new Error('runtime_cancellation_requested');
      error.code = 'runtime_cancellation_requested';
      throw error;
    }
  }

  _listSummaries(sessionId = null) {
    const summaries = [];
    let cursor = null;
    do {
      const page = this.store.listSummaries({ cursor, limit: 100,
        ...(sessionId ? { sessionId } : {}) });
      summaries.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    return summaries;
  }

  _checkpointValid(work, reference) {
    if (!reference) return false;
    try { return this.validateCheckpoint(work, reference) === true; }
    catch (_error) { return false; }
  }

  _checkpointShapeValid(work) {
    return work?.attempt ? sameAttempt(work.attempt, work.checkpoint_ref?.source_attempt)
      : work?.checkpoint_ref == null;
  }

  _assertCheckpointShape(work) {
    if (!this._checkpointShapeValid(work)) throw new Error('runtime_checkpoint_required');
  }

  _assertCheckpoint(work) {
    this._assertCheckpointShape(work);
    if (work.attempt && !this._checkpointValid(work, work.checkpoint_ref)) {
      throw new Error('runtime_checkpoint_required');
    }
  }

  _attention(workId, error) {
    try { this.onAttention?.({ work_id: workId, reason: String(error?.code || error?.message || 'runtime_attention').slice(0, 256) }); }
    catch (_error) { /* Diagnostic observers never change authority or settlement. */ }
  }
}

module.exports = { SessionRuntimeScheduler };

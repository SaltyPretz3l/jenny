'use strict';

const { updateRuntimePending } = require('./pending-input');

const { randomUUID } = require('node:crypto');
const { cancelRuntimeSubtree } = require('./subtree-cancellation');
const { validId } = require('./contracts');
const { validStart, captureRootStart, ensureRootStart, assertRootStart } = require('./root-run-start');
const { normalizeReason, normalizeTimeout, waitForCleanup } = require('./lifecycle');

const { TERMINAL } = require('./terminal-retention-contract');

function runtimeId(prefix, createId) {
  return `${prefix}_${createId()}`;
}

function immediateBusy(reason, work) {
  const error = new Error('This session cannot start another turn yet.');
  error.code = 'session_busy';
  error.reason = String(reason || 'admission_unavailable');
  error.retryable = true;
  error.work_id = work?.work_id || null;
  error.turn_id = work?.turn_id || null;
  return error;
}

// The paused work whose retained attempt owns this stream, if any. A paused
// turn keeps its attempt, so the stream the chat still shows names it. So does
// a continuation whose resource freed but which is still pending behind a busy
// lane: it has not started a fresh stream yet.
const HELD_CONTINUATION_STATUSES = ['paused', 'pending'];
function pausedWorkForStream(runtime, streamId) {
  const id = String(streamId || '').trim();
  if (!id) return null;
  for (const summary of runtime._listSummaries()) {
    if (!HELD_CONTINUATION_STATUSES.includes(summary.status)) continue;
    const work = runtime.store.get(summary.work_id);
    if (HELD_CONTINUATION_STATUSES.includes(work?.status) && work.checkpoint_ref
      && work.attempt?.stream_id === id) return work;
  }
  return null;
}

class SessionRuntimeService {
  constructor({ store, scheduler, chatAdapter, resourceBroker = null, pathResolver = null,
    checkpointStore = null, budgetStore = null, lineageStore = null, conversationStore = null,
    eligibilityCoordinator = null, createId = randomUUID } = {}) {
    if (!store || !scheduler || !chatAdapter || typeof chatAdapter.prepareImmediate !== 'function') {
      throw new TypeError('session_runtime_service_dependencies_invalid');
    }
    this.store = store;
    this.scheduler = scheduler;
    this.lanes = scheduler.lanes;
    this.chatAdapter = chatAdapter;
    this.resourceBroker = resourceBroker;
    this.pathResolver = pathResolver;
    this.checkpointStore = checkpointStore;
    this.budgetStore = budgetStore;
    this.lineageStore = lineageStore;
    this.conversationStore = conversationStore;
    this.eligibilityCoordinator = eligibilityCoordinator;
    this.createId = createId;
    this.shutdownRequest = null;
    this.pendingSubmissions = new Set();
  }

  setEnabled(enabled) {
    const active = enabled === true;
    if (!active) {
      this._invalidateSubmissions();
      this.eligibilityCoordinator?.setEnabled(false);
    }
    this.scheduler.setEnabled(active);
    if (active) this.eligibilityCoordinator?.setEnabled(true);
  }

  hasPendingOrAdmittedWork() {
    const resources = this.resourceBroker?.snapshot();
    return [...this.pendingSubmissions].some(submission => submission.current)
      || this.scheduler.hasPendingOrAdmittedWork()
      || Number(this.lanes?.snapshot?.().active_leases || 0) > 0
      || Number(resources?.lease_count || 0) > 0 || Number(resources?.waiter_count || 0) > 0;
  }

  // Narrower than hasPendingOrAdmittedWork: only work that is producing now.
  // Paused or queued replies are persisted in the store, and a quarantined
  // lease whose producer has returned has nothing live left to interrupt.
  hasProducingWork() {
    const lanes = this.lanes?.snapshot?.() || {};
    const resources = this.resourceBroker?.snapshot?.() || {};
    return [...this.pendingSubmissions].some(submission => submission.current)
      || Number(this.scheduler.active?.size || 0) > 0
      || Number(lanes.active_leases || 0) > Number(lanes.quarantined || 0)
      || Number(resources.lease_count || 0) > Number(resources.quarantined_count || 0)
      || Number(resources.waiter_count || 0) > 0;
  }

  hasSessionWork(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return false;
    if (this._hasLineageReferences(id)) return true;
    if ([...this.pendingSubmissions].some(submission => submission.current && submission.sessionId === id)) return true;
    let cursor = null;
    do {
      const page = this.store.listSummaries({ sessionId: id, limit: 100, cursor });
      if (page.items.some(item => ['pending', 'paused', 'running', 'needs_attention'].includes(item.status))) {
        return true;
      }
      cursor = page.next_cursor;
    } while (cursor);
    return this.scheduler.hasSessionActiveWork?.(id) === true;
  }

  capturePortableState() {
    if (!this.checkpointStore || !this.budgetStore || !this.conversationStore) {
      throw new Error('runtime_archive_port_unavailable');
    }
    const lanes = this.lanes?.snapshot?.() || {};
    const resources = this.resourceBroker?.snapshot?.() || {};
    if (this.children?.publications.size > 0 || Number(lanes.active_leases || 0) > 0 || Number(lanes.quarantined || 0) > 0
      || Number(resources.lease_count || 0) > 0 || Number(resources.waiter_count || 0) > 0
      || Number(resources.quarantined_count || 0) > 0) {
      const error = new Error('Runtime work must settle before creating a portable archive.');
      error.code = 'runtime_archive_busy';
      error.reason = 'runtime_archive_busy';
      throw error;
    }
    return Object.freeze({
      checkpoints: this.checkpointStore.exportPortableSnapshot(),
      root_run_budgets: this.budgetStore.exportPortableSnapshot(),
      lineage: this.lineageStore?.exportPortableSnapshot() || { schema_version: 1, records: [] },
      canonical_sessions: this.conversationStore.exportPendingContinuationsForArchive({
        getWork: workId => this.store.get(workId),
      }),
    });
  }

  start(request, { idempotencyKey, purpose, limits, beforeCommit } = {}) {
    if (!validStart({ purpose, limits })) throw new TypeError('runtime_start_invalid');
    return this.submit(request, { idempotencyKey, beforeCommit, rootStart: { purpose, limits: { ...limits } } });
  }

  async submit(request, { idempotencyKey, ...options } = {}) {
    try {
      if (!validId(idempotencyKey)) throw new TypeError('runtime_idempotency_key_invalid');
      this._assertSubmissionOpen();
      this.maintainTerminalDetail?.();
      if (this.pendingSubmissions.size >= 256) throw new Error('runtime_submission_capacity');
      const submission = { sessionId: request?.sessionId, current: true };
      this.pendingSubmissions.add(submission);
      try { return await this._submit(request, { idempotencyKey, ...options }, submission); }
      finally { this.pendingSubmissions.delete(submission); }
    } catch (error) {
      error.submissionOutcome ||= error.code === 'idempotency_conflict' ? 'unknown' : 'rejected';
      throw error;
    }
  }

  async _submit(request, { idempotencyKey, rootStart = null, beforeCommit, ...options }, submission) {
    const workId = runtimeId('work', this.createId);
    const turnId = runtimeId('turn', this.createId);
    const prepared = await this.chatAdapter.prepareSubmission(request, {
      ...options, getCurrentWork: () => this.store.get(workId),
    }, { workId, turnId });
    let submitted;
    try {
      this._assertSubmissionOpen();
      if (!submission.current) throw new Error('runtime_submission_controlled');
      this.chatAdapter.validateSubmission(prepared);
      if (rootStart) prepared.input = captureRootStart(this.chatAdapter.service, prepared, idempotencyKey, rootStart,
        this.store.findSubmission(idempotencyKey));
      beforeCommit?.();
      submitted = this.store.submit({ idempotencyKey, projectId: prepared.authority.project_id,
        sessionId: prepared.sessionId, purpose: rootStart?.purpose || 'chat', input: prepared.input,
        authority: prepared.authority, workId, turnId });
      if (rootStart && submitted.record.input.kind !== 'terminal_tombstone') {
        if (!submitted.record.attempt) ensureRootStart(this.budgetStore, submitted.record);
        assertRootStart(this.budgetStore, this.chatAdapter.service, submitted.record, prepared);
        this._assertSubmissionOpen();
        if (!submission.current) throw new Error('runtime_submission_controlled');
      }
      if (submitted.created) {
        prepared.awaitingAcknowledgement = true;
        this.chatAdapter.register(workId, prepared);
      }
      else this.chatAdapter.discard(prepared);
    } catch (error) {
      if (submitted) error.submissionOutcome = 'unknown';
      this.chatAdapter.discard(prepared);
      if (rootStart && submitted?.created) {
        try { this.store.transition(submitted.record.work_id, {
          expectedRevision: submitted.record.revision, to: 'paused', reason: 'root_budget_unavailable',
        }); } catch (_pauseError) { /* Missing context still prevents admission; restart recovers the record. */ }
      }
      throw error;
    }
    const work = submitted.record;
    // Give the caller durable identity before any producer or stream can start.
    // Duplicates never kick dispatch, including after restart or explicit pause.
    if (submitted.created) setImmediate(() => {
      prepared.awaitingAcknowledgement = false;
      this.scheduler.notifyLaneAvailability();
    });
    return Object.freeze({ ok: true, created: submitted.created, work_id: work.work_id,
      turn_id: work.turn_id, session_id: work.session_id, project_id: work.project_id,
      revision: work.revision, status: work.status,
      ...(rootStart ? { root_run_id: work.input.root_run.root_run_id } : {}) });
  }

  _invalidateSubmissions(sessionId = null) {
    for (const submission of this.pendingSubmissions) {
      if (sessionId === null || submission.sessionId === sessionId) submission.current = false;
    }
  }

  _assertSubmissionOpen() {
    if (this.scheduler.closing) throw new Error('runtime_closing');
    if (!this.scheduler.enabled) throw new Error('runtime_disabled');
  }

  async startImmediate(request, options = {}) {
    if (this.scheduler.closing) throw immediateBusy('runtime_closing');
    this.maintainTerminalDetail?.();
    const workId = runtimeId('work', this.createId);
    const turnId = runtimeId('turn', this.createId);
    const prepared = await this.chatAdapter.prepareImmediate(request, {
      ...options,
      getCurrentWork: () => this.store.get(workId),
    }, { workId, turnId });
    let work;
    try {
      work = this.store.submit({
        idempotencyKey: runtimeId('immediate', this.createId),
        projectId: prepared.authority.project_id,
        sessionId: prepared.sessionId,
        purpose: 'chat',
        input: prepared.input,
        authority: prepared.authority,
        workId,
        turnId,
      }).record;
      this.chatAdapter.register(workId, prepared);
    } catch (error) {
      this.chatAdapter.discard(prepared);
      throw error;
    }

    const dispatch = this.scheduler.tryDispatch(workId, { immediate: true });
    if (dispatch.status !== 'started') {
      this._cancelUnstarted(workId, dispatch.reason);
      this.chatAdapter.discard(prepared);
      throw immediateBusy(dispatch.reason, work);
    }
    return Promise.race([
      this.chatAdapter.waitForStart(prepared),
      dispatch.completion.then((outcome) => {
        throw immediateBusy(outcome?.status || 'start_failed', work);
      }),
    ]);
  }

  resume(workId, expectedRevision, options = {}) {
    const id = String(workId || '').trim();
    if (this.scheduler.closing) {
      return Object.freeze({ status: 'rejected', reason: 'runtime_closing' });
    }
    if (typeof this.chatAdapter.prepareResume !== 'function') {
      return Object.freeze({ status: 'rejected', reason: 'runtime_resume_unavailable' });
    }
    const source = id ? this.store.get(id) : null;
    if (!source || source.status !== 'paused') {
      return Object.freeze({ status: 'rejected', reason: 'work_not_paused' });
    }
    if (this.scheduler.enabled !== true) {
      return this.scheduler.resume(id, expectedRevision);
    }
    let prepared;
    try {
      prepared = this.chatAdapter.prepareResume(source, {
        ...options,
        checkpointStore: this.checkpointStore,
        conversationStore: this.conversationStore,
        getCurrentWork: () => this.store.get(id),
      });
      this.chatAdapter.register(id, prepared);
      const result = this.scheduler.resume(id, expectedRevision);
      if (result.status === 'accepted') this.eligibilityCoordinator?.forget(id);
      else this.chatAdapter.discard(prepared);
      return result;
    } catch (error) {
      if (prepared) this.chatAdapter.discard(prepared);
      throw error;
    }
  }

  _cancelUnstarted(workId, reason) {
    const current = this.store.get(workId);
    if (!current || !['pending', 'paused'].includes(current.status)) return false;
    this.store.transition(workId, {
      expectedRevision: current.revision,
      to: 'cancelled',
      reason: `Immediate send was not admitted: ${String(reason || 'unavailable').slice(0, 180)}`,
    });
    return true;
  }

  updatePending(workId, options = {}) { return updateRuntimePending(this, workId, options); }

  pause(workId, options = {}) {
    const result = this.scheduler.requestPause(workId, options);
    if (['paused', 'requested'].includes(result.status)) {
      this.eligibilityCoordinator?.forget(String(workId || '').trim());
    }
    return result;
  }

  cancel(workId, { expectedRevision, reason = 'user' } = {}) {
    return cancelRuntimeSubtree(this, workId, { expectedRevision,
      reason: normalizeReason(reason, 'user'), abort: true });
  }

  noteStreamCancellation(streamId, reason = 'user') {
    try {
      const entry = [...this.scheduler.active.values()].find(item => item.attempt.stream_id === streamId);
      // A paused turn has no active entry. Stop cancels it through the same
      // proof-gated path as Discard, which also drops its own resume wait;
      // forgetting the wait first would strand the work paused (HB-034).
      const paused = entry ? null : pausedWorkForStream(this, streamId);
      if (paused) {
        return Object.freeze({ ...cancelRuntimeSubtree(this, paused.work_id, {
          expectedRevision: paused.revision, reason: normalizeReason(reason, 'user'), abort: true }), paused: true });
      }
      this.eligibilityCoordinator?.forgetStream(streamId);
      if (!entry) return this.scheduler.noteStreamCancellation(streamId, normalizeReason(reason, 'user'));
      return cancelRuntimeSubtree(this, entry.work.work_id, { reason: normalizeReason(reason, 'user'), abort: false });
    } catch (error) {
      try { this.eligibilityCoordinator?.forgetStream(streamId); } catch (_error) { /* The intent result below reports the failure. */ }
      return Object.freeze({ status: 'requested', work_id: null,
        cleanup_confirmed: false, persisted: false,
        reason: String(error?.code || error?.message || 'runtime_cancellation_intent_failed') });
    }
  }

  pausePending(options = {}) {
    this._invalidateSubmissions(options.sessionId ?? null);
    if (options?.sessionId === null || options?.sessionId === undefined) {
      this.eligibilityCoordinator?.clear();
    } else {
      this.eligibilityCoordinator?.clearSession(options.sessionId);
    }
    return this.scheduler.pausePending(options);
  }

  async cancelSessionAndWait(sessionId, { reason = 'session_cancelled', timeoutMs,
    deletionHandle = null } = {}) {
    const id = String(sessionId || '').trim();
    if (!id) return Object.freeze({ ok: false, reason: 'session_id_invalid' });
    if (deletionHandle && this._hasLineageReferences(id)) {
      return Object.freeze({ ok: false, reason: 'runtime_lineage_retained' });
    }
    const timeout = normalizeTimeout(timeoutMs);
    const normalizedReason = normalizeReason(reason, 'session_cancelled');
    this._invalidateSubmissions(id);
    this.eligibilityCoordinator?.clearSession(id);
    const lineageRelevant = this.lineageStore && this._hasLineageReferences(id);
    const pending = new Set();
    let descendantsClean = true;
    for (const summary of this._listSummaries(id)) {
      if (TERMINAL.has(summary.status) && !lineageRelevant) continue;
      const work = this.store.get(summary.work_id);
      if (!work) continue;
      const report = cancelRuntimeSubtree(this, work.work_id, {
        expectedRevision: work.revision, reason: normalizedReason, abort: true, deletionHandle,
      });
      if (report.settlement) {
        const settled = report.settlement.then(result => {
          descendantsClean = descendantsClean && result.cleanup_confirmed === true;
        }, () => { descendantsClean = false; }).finally(() => pending.delete(settled));
        pending.add(settled);
      } else descendantsClean = descendantsClean && report.cleanup_confirmed === true;
    }
    return waitForCleanup(() => pending.size === 0 && descendantsClean && this._sessionCleanupConfirmed(id), {
      timeoutMs: timeout, waiters: () => [...pending, ...this.scheduler.cleanupPromises({ sessionId: id })],
    });
  }

  beginShutdown({ reason = 'service_stop', timeoutMs } = {}) {
    const timeout = normalizeTimeout(timeoutMs);
    if (this.shutdownRequest) return this.shutdownRequest;
    const normalizedReason = normalizeReason(reason, 'service_stop');
    this._invalidateSubmissions();
    this.eligibilityCoordinator?.clear();
    this.scheduler.beginClosing();
    this.scheduler.pausePending({ reason: normalizedReason });
    for (const entry of [...this.scheduler.active.values()]) {
      const current = this.store.get(entry.work.work_id);
      if (current && !TERMINAL.has(current.status)) {
        this.scheduler.requestCancellation(current.work_id, {
          expectedRevision: current.revision, reason: normalizedReason, abort: true,
        });
      }
    }
    for (const workId of this.scheduler.cancellationFences.keys()) {
      if (this.scheduler.active.has(workId)) continue;
      const current = this.store.get(workId);
      if (current && !TERMINAL.has(current.status)) {
        this.scheduler.requestCancellation(workId, {
          expectedRevision: current.revision, reason: normalizedReason, abort: true,
        });
      }
    }
    const completion = waitForCleanup(() => this._globalCleanupConfirmed()
      || this._cleanupAwaitsBackendRestart(), {
      timeoutMs: timeout, waiters: () => this.scheduler.cleanupPromises(),
    }).then(result => (result.ok && !this._globalCleanupConfirmed()
      ? Object.freeze({ ok: false, reason: 'runtime_cleanup_awaits_backend_restart' }) : result));
    this.shutdownRequest = Object.freeze({ requested: true, completion });
    return this.shutdownRequest;
  }

  shutdown(options = {}) {
    return this.beginShutdown(options).completion;
  }

  // Synchronous proof for the emergency exit path: no active work, fence,
  // lane or resource lease is left to settle.
  isCleanupConfirmed() {
    return this._globalCleanupConfirmed();
  }

  reopenAfterShutdown() {
    if (!this.shutdownRequest && !this.scheduler.closing) return Object.freeze({ ok: true });
    if (!this._globalCleanupConfirmed()) {
      return Object.freeze({ ok: false, reason: 'runtime_cleanup_unconfirmed' });
    }
    const reopened = this.scheduler.reopenAfterShutdown();
    if (reopened.ok) this.shutdownRequest = null;
    return reopened;
  }

  // Restart proves cleanup of sidecar lanes and sidecar-produced leases, not of
  // external resource owners (DLG-01).
  reclaimAbandonedAfterBackendRestart({ reason = 'backend_restart', cleanupLeases = [] } = {}) {
    const report = this.scheduler.reclaimAbandoned({ reason });
    const resourcesConfirmed = Number(this.resourceBroker?.confirmQuarantinedCleanup?.(
      cleanupLeases, { backendRestart: true }) || 0);
    return Object.freeze({ ...report, resources_confirmed: resourcesConfirmed });
  }

  _lineageWorkSettled(workId) {
    const work = this.store.get(workId);
    return Boolean(work && TERMINAL.has(work.status) && !work.checkpoint_ref
      && !this.scheduler.active.has(workId) && !this.scheduler.cancellationFences.has(workId)
      && !this.children?.publications.has(workId)
      && ![...this.pendingSubmissions].some(item => item.current && item.sessionId === work.session_id)
      && (!this.checkpointStore || this.checkpointStore.canDiscardWorkContext(workId))
      && !(this.resourceBroker?.snapshot().lease_count > 0));
  }

  // Read-only: settled lineage does not hold a session (DLG-03), but it is
  // retired only by retireSettledLineage inside the deletion commit.
  _hasLineageReferences(sessionId) {
    try {
      return this.lineageStore?.hasSessionReferences(sessionId,
        workId => this._lineageWorkSettled(workId)) === true;
    }
    catch (_error) { return true; } // Unreadable ownership cannot authorize deletion.
  }

  // Called by session deletion after every refusal has passed. Throws when the
  // lineage store cannot retire, so the deletion is refused rather than orphaned.
  retireSettledLineage(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id || !this.lineageStore) return 0;
    return this.lineageStore.retireSessionReferences(id, workId => this._lineageWorkSettled(workId));
  }

  _sessionCleanupConfirmed(sessionId) {
    return !this.scheduler.hasSessionActiveWork(sessionId)
      && !this.scheduler.hasUnsettledCancellationFence(sessionId)
      && this._listSummaries(sessionId).every(work => TERMINAL.has(work.status));
  }

  _globalCleanupConfirmed() {
    const lanes = this.lanes?.snapshot?.() || {};
    const resources = this.resourceBroker?.snapshot?.() || {};
    return this.scheduler.active.size === 0
      && !this.scheduler.hasUnsettledCancellationFence()
      && Number(lanes.active_leases || 0) === 0 && Number(lanes.quarantined || 0) === 0
      && Number(resources.lease_count || 0) === 0 && Number(resources.waiter_count || 0) === 0
      && Number(resources.quarantined_count || 0) === 0;
  }

  // True when all that is left is what the backend-restart reclaim retires
  // (B3D-1): entries whose producer already returned unproven, their fences,
  // and quarantined lane leases. Nothing in this process can settle those, so a
  // shutdown drain stops waiting on them. A running producer, a paused
  // cancellation proof, a live lane lease or any resource lease keeps the drain.
  _cleanupAwaitsBackendRestart() {
    const { scheduler } = this;
    const lanes = this.lanes?.snapshot?.() || {};
    const resources = this.resourceBroker?.snapshot?.() || {};
    return [...scheduler.active.values()].every(entry => entry.initialSettlementDone === true)
      && scheduler.pausedCancellationSettlements.size === 0
      && [...scheduler.cancellationFences.keys()].every(workId => {
        try { return scheduler.active.has(workId) || this.store.get(workId)?.control_request?.kind === 'cancel'; }
        catch (_error) { return false; }
      })
      && Number(lanes.active_leases || 0) === Number(lanes.quarantined || 0)
      && Number(resources.lease_count || 0) === 0 && Number(resources.waiter_count || 0) === 0;
  }

  _listSummaries(sessionId = null) {
    return this.scheduler._listSummaries(sessionId);
  }
}

module.exports = { SessionRuntimeService };

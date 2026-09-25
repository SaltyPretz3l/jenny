'use strict';

const controls = require('./application-controls');
const { projectWorkCoordination, projectCanonicalResult } = require('./work-details');

const { normalizeSubmission, normalizeStartSubmission, normalizeResumeRequest } = require('./submission-contract');
const { RUNTIME_ERROR_CODES } = require('../backend/error-codes');
const {
  RuntimeProjectionError,
  normalizeSnapshotRequest,
  normalizeWorkRequest,
  projectRuntimeSnapshot,
  projectWorkRecord,
} = require('./projections');

function failure(code, reason) {
  return Object.freeze({ ok: false, error: Object.freeze({ code, reason }) });
}

function invalid(reason) {
  return failure(RUNTIME_ERROR_CODES.INVALID_REQUEST, reason);
}

function unavailable(reason = 'runtime_inspection_unavailable') {
  return failure(RUNTIME_ERROR_CODES.UNAVAILABLE, reason);
}

/* The composer can only explain a refusal it can name, so the runtime's own
 * closed vocabulary passes through: `_assertSubmissionOpen` and the submission
 * ceiling in `service.js`, `pendingCapacityReason` in `contracts.js`, and the
 * transcript/session admission guards in `services/backend/`. Anything outside
 * this set stays the opaque `runtime_submission_refused` so raw failure text
 * never reaches the renderer. */
const PASSTHROUGH_SUBMISSION_REASONS = new Set([
  'runtime_closing',
  'runtime_disabled',
  'runtime_submission_capacity',
  'host_pending_capacity',
  'project_pending_capacity',
  'session_pending_capacity',
  'pending_input_capacity',
  'runtime_transcript_cache_pressure',
  'session_busy',
]);

function submissionRefusalReason(error) {
  /* `_assertSubmissionOpen` throws plain Errors whose MESSAGE is the code. */
  for (const value of [error?.code, error?.message]) {
    if (typeof value === 'string' && PASSTHROUGH_SUBMISSION_REASONS.has(value)) return value;
  }
  return 'runtime_submission_refused';
}

function runtimeOwner(getRuntime, operation) {
  let runtime;
  try { runtime = getRuntime(); } catch (_error) { return null; }
  if (!runtime || typeof runtime !== 'object' || !runtime.store) return null;
  if (operation === 'snapshot' && (typeof runtime.store.getStatus !== 'function'
    || typeof runtime.store.listSummaries !== 'function'
    || typeof runtime.lanes?.snapshot !== 'function'
    || typeof runtime.resourceBroker?.snapshot !== 'function'
    || !runtime.scheduler || typeof runtime.scheduler !== 'object')) return null;
  if (operation === 'work' && typeof runtime.store.get !== 'function') return null;
  return runtime;
}

function caughtSnapshotFailure(error) {
  const reason = String(error?.code || '');
  if (reason === 'stale_cursor') {
    return failure(RUNTIME_ERROR_CODES.STALE, 'runtime_snapshot_cursor_stale');
  }
  if (['invalid_cursor', 'invalid_page_request', 'cursor_scope_mismatch'].includes(reason)) {
    return invalid('runtime_snapshot_request_invalid');
  }
  return unavailable(error instanceof RuntimeProjectionError
    ? 'runtime_projection_unavailable' : undefined);
}

class RuntimeApplicationService {
  constructor({ getRuntime } = {}) {
    if (typeof getRuntime !== 'function') {
      throw new TypeError('runtime_application_service_dependencies_invalid');
    }
    this.getRuntime = getRuntime;
  }

  async submit(payload, { beforeCommit } = {}) {
    const normalized = normalizeSubmission(payload);
    if (!normalized) return { ...invalid('runtime_submission_request_invalid'), acceptance: 'rejected' };
    const runtime = runtimeOwner(this.getRuntime, 'submit');
    if (typeof runtime?.submit !== 'function') return { ...unavailable('runtime_unavailable'), acceptance: 'rejected' };
    const guard = controls.createCommitGuard(beforeCommit);
    try {
      return await runtime.submit(normalized.request, { idempotencyKey: normalized.idempotencyKey, beforeCommit: guard.check });
    } catch (error) {
      guard.rethrow(error);
      if (error?.code === 'idempotency_conflict') return { ...failure(RUNTIME_ERROR_CODES.STALE, 'idempotency_conflict'), acceptance: 'unknown' };
      return { ...unavailable(submissionRefusalReason(error)),
        acceptance: error?.submissionOutcome === 'rejected' ? 'rejected' : 'unknown' };
    }
  }

  async start(payload, { beforeCommit } = {}) {
    const normalized = normalizeStartSubmission(payload);
    if (!normalized) return invalid('runtime_start_request_invalid');
    const runtime = runtimeOwner(this.getRuntime, 'start');
    if (typeof runtime?.start !== 'function') return unavailable('runtime_unavailable');
    const { request, ...options } = normalized;
    const guard = controls.createCommitGuard(beforeCommit);
    try { return await runtime.start(request, { ...options, beforeCommit: guard.check }); }
    catch (error) {
      guard.rethrow(error);
      if (error?.code === 'idempotency_conflict') return failure(RUNTIME_ERROR_CODES.STALE, 'idempotency_conflict');
      return unavailable('runtime_start_refused');
    }
  }

  pause(payload) {
    const normalized = normalizeResumeRequest(payload);
    if (!normalized) return invalid('runtime_pause_request_invalid');
    const runtime = runtimeOwner(this.getRuntime, 'pause');
    if (typeof runtime?.pause !== 'function') return unavailable('runtime_unavailable');
    try {
      if (runtime.store.get(normalized.workId)?.revision !== normalized.expectedRevision) {
        return failure(RUNTIME_ERROR_CODES.STALE, 'revision_conflict');
      }
      const result = runtime.pause(normalized.workId, { expectedRevision: normalized.expectedRevision });
      return ['requested', 'paused'].includes(result.status)
        ? Object.freeze({ ok: true, work_id: normalized.workId, status: result.status })
        : unavailable('runtime_pause_refused');
    } catch (error) {
      return error?.code === 'revision_conflict' ? failure(RUNTIME_ERROR_CODES.STALE, 'revision_conflict')
        : unavailable('runtime_pause_refused');
    }
  }

  resume(payload) {
    const normalized = normalizeResumeRequest(payload);
    if (!normalized) return invalid('runtime_resume_request_invalid');
    const runtime = runtimeOwner(this.getRuntime, 'resume');
    if (typeof runtime?.resume !== 'function') return unavailable('runtime_unavailable');
    try {
      if (runtime.store.get(normalized.workId)?.revision !== normalized.expectedRevision) {
        return failure(RUNTIME_ERROR_CODES.STALE, 'revision_conflict');
      }
      const result = runtime.resume(normalized.workId, normalized.expectedRevision);
      // Surface the runtime's own reason so callers can tell a transient refusal apart.
      return result.status === 'accepted' ? Object.freeze({ ok: true, work_id: normalized.workId })
        : unavailable(String(result.reason || 'runtime_resume_refused'));
    } catch (error) {
      return error?.code === 'revision_conflict' ? failure(RUNTIME_ERROR_CODES.STALE, 'revision_conflict')
        : unavailable(String(error?.code || 'runtime_resume_refused'));
    }
  }

  cancel(payload) { return controls.cancel(runtimeOwner(this.getRuntime, 'cancel'), payload); }

  updatePending(payload, options) { return controls.updatePending(runtimeOwner(this.getRuntime, 'update'), payload, options); }

  updateLimits(payload) { return controls.updateLimits(runtimeOwner(this.getRuntime, 'limits'), payload); }

  getResult(payload) {
    const request = normalizeWorkRequest(payload);
    if (!request || Object.keys(payload).some(key => key !== 'work_id')) return invalid('runtime_result_request_invalid');
    const runtime = runtimeOwner(this.getRuntime, 'work');
    if (!runtime) return unavailable('runtime_unavailable');
    try { return projectCanonicalResult(runtime, runtime.store.get(request.workId)); }
    catch (_error) { return unavailable('runtime_result_unavailable'); }
  }

  getSnapshot(payload = {}) {
    const request = normalizeSnapshotRequest(payload);
    if (!request) return invalid('runtime_snapshot_request_invalid');
    const runtime = runtimeOwner(this.getRuntime, 'snapshot');
    if (!runtime) return unavailable('runtime_unavailable');
    try {
      const page = runtime.store.listSummaries(request);
      return projectRuntimeSnapshot({
        runtime,
        page,
        storeStatus: runtime.store.getStatus(),
        laneSnapshot: runtime.lanes.snapshot(),
        resourceSnapshot: runtime.resourceBroker.snapshot(),
      });
    } catch (error) {
      return caughtSnapshotFailure(error);
    }
  }

  getWork(payload = {}) {
    const request = normalizeWorkRequest(payload);
    if (!request) return invalid('runtime_work_request_invalid');
    const runtime = runtimeOwner(this.getRuntime, 'work');
    if (!runtime) return unavailable('runtime_unavailable');
    try {
      const work = runtime.store.get(request.workId);
      if (!work) return failure(RUNTIME_ERROR_CODES.NOT_FOUND, 'runtime_work_not_found');
      const projected = projectWorkRecord(work);
      return { ...projected, coordination: projectWorkCoordination(runtime, work, request) };
    } catch (error) {
      return unavailable(error instanceof RuntimeProjectionError
        ? 'runtime_projection_unavailable' : undefined);
    }
  }
}

module.exports = { RuntimeApplicationService };

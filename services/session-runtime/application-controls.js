'use strict';
const { normalizeResumeRequest } = require('./submission-contract');
const { MAX_PENDING_INPUT_BYTES, stableJson } = require('./contracts');
const { applySessionRuntimePatch } = require('../shell-config-session-runtime');
const { RUNTIME_ERROR_CODES } = require('../backend/error-codes');
function failure(reason, stale = false, invalid = false) {
  return { ok: false, error: { code: stale ? RUNTIME_ERROR_CODES.STALE
    : invalid ? RUNTIME_ERROR_CODES.INVALID_REQUEST : RUNTIME_ERROR_CODES.UNAVAILABLE, reason } };
}
function caught(error, operation) {
  return failure(error?.code === 'revision_conflict' ? 'revision_conflict' : `runtime_${operation}_refused`,
    error?.code === 'revision_conflict');
}
function cancel(runtime, payload) {
  const normalized = normalizeResumeRequest(payload);
  if (!normalized) return failure('runtime_cancel_request_invalid', false, true);
  if (typeof runtime?.cancel !== 'function') return failure('runtime_unavailable');
  try {
    const current = runtime.store.get(normalized.workId);
    if (current?.revision !== normalized.expectedRevision) return failure('revision_conflict', true);
    const result = runtime.cancel(normalized.workId, { expectedRevision: normalized.expectedRevision });
    if (result.persisted === false || result.status === 'rejected') return failure('runtime_cancel_refused');
    const work = runtime.store.get(normalized.workId);
    return { ok: true, work_id: work.work_id, revision: work.revision,
      status: result.cleanup_confirmed === true ? work.status : 'requested', cleanup_confirmed: result.cleanup_confirmed === true };
  } catch (error) { return caught(error, 'cancel'); }
}
function createCommitGuard(beforeCommit) {
  let rejected;
  return {
    check() { try { beforeCommit?.(); } catch (error) { rejected = error; throw error; } },
    rethrow(error) { if (error === rejected) throw error; },
  };
}
async function updatePending(runtime, payload, { beforeCommit } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).sort().join(',') !== 'expected_revision,prompt,work_id'
    || typeof payload.prompt !== 'string' || !payload.prompt.trim()
    || Buffer.byteLength(payload.prompt, 'utf8') > MAX_PENDING_INPUT_BYTES) return failure('runtime_update_request_invalid', false, true);
  const normalized = normalizeResumeRequest({ work_id: payload.work_id, expected_revision: payload.expected_revision });
  if (!normalized) return failure('runtime_update_request_invalid', false, true);
  if (typeof runtime?.updatePending !== 'function') return failure('runtime_unavailable');
  const guard = createCommitGuard(beforeCommit);
  try { return await runtime.updatePending(normalized.workId, { expectedRevision: normalized.expectedRevision,
    prompt: payload.prompt, beforeCommit: guard.check }); }
  catch (error) { guard.rethrow(error); return caught(error, 'update'); }
}
function updateLimits(runtime, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).sort().join(',') !== 'expected_limits,patch') return failure('runtime_limits_request_invalid', false, true);
  const config = runtime?.chatAdapter?.service?.configService;
  if (!config?.updateSessionRuntime || !runtime?.lanes?.setLimits || !runtime?.resourceBroker?.setLimits
    || runtime.scheduler.closing) return failure('runtime_limits_unavailable');
  const current = runtime.lanes.snapshot().configured;
  let next;
  let expected;
  try {
    next = applySessionRuntimePatch(current, payload.patch);
    expected = applySessionRuntimePatch({}, payload.expected_limits);
    if (stableJson(expected) !== stableJson(payload.expected_limits)) throw new Error('limits_shape');
  }
  catch (_error) { return failure('runtime_limits_request_invalid', false, true); }
  if (stableJson(current) !== stableJson(expected)) return failure('runtime_limits_stale', true);
  try {
    const saved = config.updateSessionRuntime(payload.patch);
    if (stableJson(saved) !== stableJson(next)) return failure('runtime_limits_persistence_conflict');
    runtime.resourceBroker.setLimits({ ...saved.resources, sandbox_commands: 1 });
    runtime.lanes.setLimits(saved);
    runtime.eligibilityCoordinator?.wake();
    return { ok: true, configured_limits: saved };
  } catch (_error) { return failure('runtime_limits_refused'); }
}
module.exports = { cancel, updatePending, updateLimits, createCommitGuard };

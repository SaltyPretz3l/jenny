'use strict';

const { cloneJson, normalizeAttempt, normalizeControlRequest, stableJson, validateWorkRecord } = require('./contracts');

class RuntimeStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'RuntimeStoreError';
    this.code = code;
  }
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RuntimeStoreError('invalid_clock');
  return date.toISOString();
}

function attemptMatches(actual, expected) {
  const normalized = normalizeAttempt(expected);
  return Boolean(actual && normalized && stableJson(actual) === stableJson(normalized));
}

// Durable intent belongs to the store; it never aborts producers or releases capacity.
function requestWorkControl(store, workId, { expectedRevision, expectedAttempt, reason }, kind) {
  store._assertWritable();
  const current = store._loadRecord(workId);
  if (!current) throw new RuntimeStoreError('work_not_found');
  const label = kind === 'cancel' ? 'cancellation' : 'pause';
  const states = kind === 'cancel' ? ['pending', 'paused', 'running', 'needs_attention'] : ['running'];
  if (!states.includes(current.status) || !current.attempt) throw new RuntimeStoreError(`${label}_state_conflict`);
  if (!attemptMatches(current.attempt, expectedAttempt)) throw new RuntimeStoreError('attempt_fence_conflict');
  if (expectedRevision !== current.revision) throw new RuntimeStoreError('revision_conflict');
  if (kind === 'pause' && current.control_request?.kind === 'cancel') throw new RuntimeStoreError('cancellation_requested');
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!normalizedReason || reason.length > 256) throw new RuntimeStoreError(`invalid_${label}_request`);
  if (current.control_request?.kind === kind) {
    return Object.freeze({ changed: false, record: cloneJson(current) });
  }
  const requestedAt = isoNow(store.now);
  const control = normalizeControlRequest({ kind, reason: normalizedReason, requested_at: requestedAt });
  if (!control) throw new RuntimeStoreError(`invalid_${label}_request`);
  const next = { ...current, revision: current.revision + 1,
    control_request: control, updated_at: requestedAt };
  const checked = validateWorkRecord(next);
  if (!checked.ok) throw new RuntimeStoreError(checked.reason);
  store._commit(checked.record);
  return Object.freeze({ changed: true, record: cloneJson(checked.record) });
}

module.exports = { RuntimeStoreError, isoNow, attemptMatches, requestWorkControl };

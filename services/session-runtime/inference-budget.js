'use strict';

const { validId } = require('./contracts');
const bindings = new WeakSet();
const KEYS = ['inference_requests', 'input_tokens', 'output_tokens'];

// An application capability, never a wire payload. The existing root must be
// created by explicit orchestration; an inference operation cannot mint it.
function createInferenceBudget({ store, rootRunId, workId, attemptId, providerId,
  authorityFingerprint, maxima = null } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.reserve !== 'function'
    || typeof store.settle !== 'function' || ![rootRunId, workId, attemptId].every(validId)
    || typeof providerId !== 'string' || typeof authorityFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(authorityFingerprint) || (maxima !== null
      && (Object.keys(maxima).sort().join(',') !== KEYS.join(',')
        || maxima.inference_requests !== 1
        || KEYS.some(key => !Number.isSafeInteger(maxima[key]) || maxima[key] < 0
          || maxima[key] > 1_000_000_000_000)))) throw new TypeError('inference_budget_binding_invalid');
  const captured = maxima === null ? null : Object.freeze({ ...maxima });
  const binding = { rootRunId, workId, attemptId };
  function assertRoot() {
    const root = store.get(rootRunId);
    if (root.authority_fingerprint !== authorityFingerprint
      || !root.allowed_provider_ids.includes(providerId)) {
      throw Object.assign(new Error('budget_authority_mismatch'), { code: 'budget_authority_mismatch' });
    }
  }
  assertRoot();
  const capability = Object.freeze({
    providerId,
    requiresMaxima: captured === null,
    forProvider(nextProviderId) {
      return createInferenceBudget({ store, rootRunId, workId, attemptId,
        providerId: nextProviderId, authorityFingerprint, maxima: captured });
    },
    reserve(operationId, requestedMaxima = captured) {
      assertRoot();
      if (captured === null && (!(requestedMaxima?.input_tokens > 0)
        || !(requestedMaxima?.output_tokens > 0))) {
        throw Object.assign(new Error('budget_reservation_invalid'), { code: 'budget_reservation_invalid' });
      }
      const result = store.reserve({ ...binding, operationId, providerId, maxima: captured || requestedMaxima });
      // Recovered or already-settled reservations represent possible prior
      // dispatch. Durable idempotence must never become permission to replay.
      if (result.created !== true) {
        throw Object.assign(new Error('budget_operation_duplicate'), { code: 'budget_operation_duplicate' });
      }
    },
    settleUnknown(operationId) {
      // Original binding can settle after authority revocation. The immutable
      // reservation owns its provider/maxima and the store checks work/attempt.
      store.settle({ ...binding, operationId, consumption: 'unknown', usage: null });
    },
  });
  bindings.add(capability);
  return capability;
}

function isInferenceBudget(value) { return bindings.has(value); }

module.exports = { createInferenceBudget, isInferenceBudget };

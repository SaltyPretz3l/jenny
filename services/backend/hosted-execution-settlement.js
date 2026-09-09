'use strict';
const { TOOL_ERROR_CODES } = require('./error-codes');

function hostedExecutionBroker(service) {
  return service?.hostExecutionBroker
    || service?.options?.hostExecutionBroker
    || null;
}

function hostedExecutionEnabled(service) {
  const version = Number(
    service?.options?.hostExecutionPolicyVersion
      ?? service?.hostExecutionPolicyVersion ?? 1
  );
  return service?.hostMode === 'server' && version === 2;
}

async function drainHostedExecution(service, streamId) {
  if (!hostedExecutionEnabled(service)) return { ok: true, drained: false };
  const broker = hostedExecutionBroker(service);
  if (!broker || typeof broker.drainStream !== 'function') {
    const error = new Error('Hosted execution cleanup could not be confirmed.');
    error.reason = 'sandbox_cleanup_unconfirmed';
    return { ok: false, drained: false, error };
  }
  try {
    await broker.drainStream(String(streamId || '').trim());
    return { ok: true, drained: true };
  } catch (error) {
    service?._emitServiceLog?.('ERROR', 'host.sandbox_settlement_uncertain', {
      streamId: String(streamId || '').trim(),
      reason: String(error?.reason || error?.code || 'sandbox_cleanup_unconfirmed'),
    });
    return { ok: false, drained: false, error };
  }
}

// A reverse bridge can outlive cancellation of its sidecar request. Both
// success and failure must pass the same namespace cleanup barrier.
async function settleHostedExecution(service, streamId, errorPayload = null) {
  const settlement = await drainHostedExecution(service, streamId);
  if (settlement.ok) return;
  if (errorPayload) {
    Object.assign(errorPayload, {
      category: 'runtime', status: 'runtime_error', retryable: false,
      error_code: TOOL_ERROR_CODES.EXECUTION_FAILED, terminal_subcode: 'execution_uncertain',
      cancel_reason: '', message: 'Hosted execution cleanup could not be confirmed.',
    });
    return;
  }
  const error = settlement.error || new Error('Hosted execution cleanup could not be confirmed.');
  error.execution_uncertain = true;
  throw error;
}

module.exports = { drainHostedExecution, hostedExecutionBroker, settleHostedExecution };

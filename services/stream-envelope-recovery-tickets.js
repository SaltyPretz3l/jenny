'use strict';

const { normalizeString: normalizeToken } = require('./shared/normalize');

const DEFAULT_MAX_TICKETS = 64;
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 2;
const DEFAULT_RETRY_MS = 1_000;
const RECOVERY_OUTCOMES = new Set(['applied', 'superseded', 'session_missing']);

function normalizePositiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function defaultSetRetry(callback, delayMs) {
  const handle = setTimeout(callback, delayMs);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

function createStreamEnvelopeRecoveryTicketStore({
  sendRecoveryRequired = () => {},
  log = () => {},
  now = () => Date.now(),
  setRetry = defaultSetRetry,
  clearRetry = (handle) => clearTimeout(handle),
  maxTickets = DEFAULT_MAX_TICKETS,
  maxDeliveryAttempts = DEFAULT_MAX_DELIVERY_ATTEMPTS,
  retryMs = DEFAULT_RETRY_MS,
} = {}) {
  const pendingById = new Map();
  const appliedById = new Map();
  const ticketCap = normalizePositiveInteger(maxTickets, DEFAULT_MAX_TICKETS);
  const attemptCap = normalizePositiveInteger(
    maxDeliveryAttempts,
    DEFAULT_MAX_DELIVERY_ATTEMPTS
  );
  const retryDelayMs = normalizePositiveInteger(retryMs, DEFAULT_RETRY_MS);
  let rendererEpoch = 0;

  function emit(level, event, details) {
    try { log(level, event, details); } catch (_error) { /* observability is best-effort */ }
  }

  function clearTicketRetry(ticket) {
    if (!ticket?.retryHandle) return;
    try { clearRetry(ticket.retryHandle); } catch (_error) { /* best-effort */ }
    ticket.retryHandle = null;
  }

  function deletePending(recoveryId) {
    const ticket = pendingById.get(recoveryId);
    if (ticket) clearTicketRetry(ticket);
    pendingById.delete(recoveryId);
  }

  function rememberApplied(ticket) {
    appliedById.set(ticket.recoveryId, {
      streamId: ticket.streamId,
      sessionId: ticket.sessionId,
    });
    while (appliedById.size > ticketCap) {
      appliedById.delete(appliedById.keys().next().value);
    }
  }

  function publicTicket(ticket) {
    return {
      recovery_id: ticket.recoveryId,
      renderer_epoch: ticket.lastRendererEpoch,
      stream_id: ticket.streamId,
      session_id: ticket.sessionId,
      ...(ticket.turnId ? { turn_id: ticket.turnId } : {}),
      ...(ticket.terminalType ? { terminal_type: ticket.terminalType } : {}),
      reason: ticket.reason,
      created_at_ms: ticket.createdAtMs,
    };
  }

  function deliver(ticket) {
    if (!ticket || !pendingById.has(ticket.recoveryId) || rendererEpoch < 1) return null;
    clearTicketRetry(ticket);
    ticket.lastRendererEpoch = rendererEpoch;
    ticket.deliveryAttempts += 1;
    const payload = publicTicket(ticket);
    try {
      sendRecoveryRequired(payload);
    } catch (error) {
      emit('WARN', 'chat.stream_envelope_recovery_ticket_delivery_failed', {
        recoveryId: ticket.recoveryId.slice(0, 30),
        message: String(error?.message || error).slice(0, 200),
      });
    }
    if (ticket.deliveryAttempts < attemptCap) {
      ticket.retryHandle = setRetry(() => {
        ticket.retryHandle = null;
        deliver(ticket);
      }, retryDelayMs);
    }
    return payload;
  }

  function evictOverflow() {
    while (pendingById.size > ticketCap) {
      const oldestId = pendingById.keys().next().value;
      const oldest = pendingById.get(oldestId);
      deletePending(oldestId);
      emit('WARN', 'chat.stream_envelope_recovery_ticket_evicted', {
        recoveryId: normalizeToken(oldest?.recoveryId).slice(0, 30),
        maxTickets: ticketCap,
      });
    }
  }

  function issue(descriptor = {}) {
    const streamId = normalizeToken(descriptor.streamId || descriptor.stream_id);
    const sessionId = normalizeToken(descriptor.sessionId || descriptor.session_id);
    if (!streamId || !sessionId) {
      emit('ERROR', 'chat.stream_envelope_recovery_ticket_rejected', {
        reason: !streamId ? 'missing_stream_id' : 'missing_session_id',
      });
      return null;
    }
    const recoveryId = streamId;
    const existing = pendingById.get(recoveryId);
    if (existing) return publicTicket(existing);
    const createdAtMs = Math.max(Number(now()) || 0, 0);
    const ticket = {
      recoveryId,
      streamId,
      sessionId,
      turnId: normalizeToken(descriptor.turnId || descriptor.turn_id),
      terminalType: normalizeToken(descriptor.terminalType || descriptor.terminal_type),
      reason: normalizeToken(descriptor.reason).slice(0, 80) || 'recovery_required',
      createdAtMs,
      deliveryAttempts: 0,
      lastRendererEpoch: rendererEpoch,
      retryHandle: null,
    };
    pendingById.set(recoveryId, ticket);
    evictOverflow();
    if (!pendingById.has(recoveryId)) return null;
    return deliver(ticket) || publicTicket(ticket);
  }

  function replay(epoch) {
    const normalizedEpoch = normalizePositiveInteger(epoch, 0);
    if (!normalizedEpoch) return [];
    rendererEpoch = normalizedEpoch;
    const delivered = [];
    for (const ticket of Array.from(pendingById.values())) {
      clearTicketRetry(ticket);
      ticket.deliveryAttempts = 0;
      const payload = deliver(ticket);
      if (payload) delivered.push(payload);
    }
    return delivered;
  }

  function acknowledge(record = {}) {
    const recordType = normalizeToken(record.recordType || record.record_type);
    const recoveryId = normalizeToken(record.recoveryId || record.recovery_id);
    const streamId = normalizeToken(record.streamId || record.stream_id);
    const sessionId = normalizeToken(record.sessionId || record.session_id);
    const epoch = record.rendererEpoch ?? record.renderer_epoch;
    const outcome = normalizeToken(record.outcome);
    if (recordType !== 'recovery_applied') {
      emit('WARN', 'chat.stream_envelope_recovery_ack_rejected', {
        recoveryId: recoveryId.slice(0, 30),
        reason: 'invalid_record_type',
      });
      return {
        ok: false,
        reason: 'invalid_recovery_ack_type',
        legacy_reopened: true,
        rehydrate_required: true,
      };
    }
    const ticket = pendingById.get(recoveryId);
    const exact = ticket
      && typeof epoch === 'number'
      && Number.isSafeInteger(epoch)
      && epoch === ticket.lastRendererEpoch
      && streamId === ticket.streamId
      && sessionId === ticket.sessionId
      && RECOVERY_OUTCOMES.has(outcome);
    const applied = appliedById.get(recoveryId);
    if (applied && applied.streamId === streamId && applied.sessionId === sessionId && !ticket) {
      return { ok: true, recovery_applied: true, already_applied: true };
    }
    if (!exact) {
      emit('WARN', 'chat.stream_envelope_recovery_ack_rejected', {
        recoveryId: recoveryId.slice(0, 30),
        reason: ticket ? 'identity_or_epoch_mismatch' : 'unknown_ticket',
      });
      return {
        ok: false,
        reason: ticket ? 'recovery_ack_mismatch' : 'unknown_recovery_ticket',
        legacy_reopened: true,
        rehydrate_required: true,
      };
    }
    deletePending(recoveryId);
    const alreadyApplied = Boolean(applied);
    rememberApplied(ticket);
    emit('INFO', 'chat.stream_envelope_recovery_applied', {
      recoveryId: recoveryId.slice(0, 30),
      rendererEpoch: epoch,
      outcome,
    });
    return { ok: true, recovery_applied: true, already_applied: alreadyApplied };
  }

  return {
    acknowledge,
    issue,
    replay,
    size: () => pendingById.size,
  };
}

module.exports = {
  createStreamEnvelopeRecoveryTicketStore,
};

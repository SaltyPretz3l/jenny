const {
  buildAssistantErrorRecoveryFields,
  copyAssistantErrorRecoveryMetadata,
} = require('./chat-error-recovery');
const {
  normalizeTerminalStatus: normalizeGeneratedTerminalStatus,
} = require('./generated-chat-lifecycle-contract');

const TERMINAL_STATUS_COMPLETED = 'completed';
const TERMINAL_STATUS_DENIED = 'denied';
const TERMINAL_STATUS_CANCELLED = 'cancelled';
const TERMINAL_STATUS_PREEMPTED = 'preempted';
const TERMINAL_STATUS_TIMEOUT = 'timeout';
const TERMINAL_STATUS_RUNTIME_ERROR = 'runtime_error';
const TERMINAL_STATUS_QUESTION_BATCH = 'question_batch';
const CANCEL_REASON_USER = 'user_cancel';
const CANCEL_REASON_SERVICE_STOP = 'service_stop';
const CANCEL_REASON_DISPOSE = 'dispose';
const CANCEL_REASON_TIMEOUT = 'timeout';
const CANCEL_REASON_SESSION_DELETE = 'session_delete';
const CANCEL_REASON_TRANSPORT_ABORT = 'transport_abort';
const CANCEL_REASON_SIDECAR = 'sidecar_cancel';

const CANCEL_REASONS = new Set([
  CANCEL_REASON_USER,
  CANCEL_REASON_SERVICE_STOP,
  CANCEL_REASON_DISPOSE,
  CANCEL_REASON_TIMEOUT,
  CANCEL_REASON_SESSION_DELETE,
  CANCEL_REASON_TRANSPORT_ABORT,
  CANCEL_REASON_SIDECAR,
]);

const TERMINAL_ERROR_STATUSES = new Set([
  TERMINAL_STATUS_CANCELLED,
  TERMINAL_STATUS_PREEMPTED,
  TERMINAL_STATUS_TIMEOUT,
  TERMINAL_STATUS_RUNTIME_ERROR,
]);

function normalizeTerminalStatus(value, fallback = TERMINAL_STATUS_RUNTIME_ERROR) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === TERMINAL_STATUS_QUESTION_BATCH) {
    return normalized;
  }
  const canonical = normalizeGeneratedTerminalStatus(normalized);
  if (canonical === 'complete') return TERMINAL_STATUS_COMPLETED;
  if (canonical === 'error') return TERMINAL_STATUS_RUNTIME_ERROR;
  if ([TERMINAL_STATUS_DENIED, TERMINAL_STATUS_CANCELLED, TERMINAL_STATUS_PREEMPTED,
    TERMINAL_STATUS_TIMEOUT].includes(canonical)) return canonical;
  return String(fallback || TERMINAL_STATUS_RUNTIME_ERROR).trim().toLowerCase() || TERMINAL_STATUS_RUNTIME_ERROR;
}

function isDeniedTerminalStatus(value) {
  return normalizeTerminalStatus(value) === TERMINAL_STATUS_DENIED;
}

function isTerminalErrorStatus(value) {
  return TERMINAL_ERROR_STATUSES.has(normalizeTerminalStatus(value));
}

function resolveToolResultStatus(result) {
  if (!result || result.isError !== true) {
    return TERMINAL_STATUS_COMPLETED;
  }
  const approvalState = String(result.approvalState || '').trim().toLowerCase();
  if (approvalState === TERMINAL_STATUS_DENIED) {
    return TERMINAL_STATUS_DENIED;
  }
  if (approvalState === TERMINAL_STATUS_CANCELLED) {
    return TERMINAL_STATUS_CANCELLED;
  }
  if (approvalState === TERMINAL_STATUS_TIMEOUT) {
    return TERMINAL_STATUS_TIMEOUT;
  }
  if (approvalState === TERMINAL_STATUS_PREEMPTED) {
    return TERMINAL_STATUS_PREEMPTED;
  }
  return 'error';
}

function resolveTerminalStatusFromErrorPayload(errorPayload, fallbackStatus = TERMINAL_STATUS_RUNTIME_ERROR) {
  const payload = errorPayload && typeof errorPayload === 'object' ? errorPayload : {};
  const explicitStatus = String(payload.status || payload.terminal_status || '').trim().toLowerCase();
  if (explicitStatus) {
    return normalizeTerminalStatus(explicitStatus, fallbackStatus);
  }
  const category = String(payload.category || '').trim().toLowerCase();
  if (category === 'timeout') {
    return TERMINAL_STATUS_TIMEOUT;
  }
  if (category === 'cancelled') {
    return TERMINAL_STATUS_CANCELLED;
  }
  return normalizeTerminalStatus(fallbackStatus, TERMINAL_STATUS_RUNTIME_ERROR);
}

function normalizeCancelReason(value, fallback = CANCEL_REASON_TRANSPORT_ABORT) {
  const fallbackReason = CANCEL_REASONS.has(String(fallback || '').trim().toLowerCase())
    ? String(fallback).trim().toLowerCase()
    : CANCEL_REASON_TRANSPORT_ABORT;
  const normalized = String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLowerCase();
  if (!normalized) {
    return fallbackReason;
  }
  if (normalized === 'chat_cancel' || normalized === 'chat_cancelled') {
    return CANCEL_REASON_SIDECAR;
  }
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return fallbackReason;
  }
  return CANCEL_REASONS.has(normalized) ? normalized : fallbackReason;
}

function cancelReasonFromError(error, fallback = CANCEL_REASON_TRANSPORT_ABORT) {
  const candidate = error && typeof error === 'object' ? error : {};
  return normalizeCancelReason(
    candidate.cancel_reason
      || candidate.cancelReason
      || candidate.terminal_subcode
      || candidate.reason,
    fallback
  );
}

function categoryFromCancelReason(cancelReason) {
  return cancelReason === CANCEL_REASON_TIMEOUT ? 'timeout' : 'cancelled';
}

function isExpectedLifecycleCancellation(errorPayload) {
  const payload = errorPayload && typeof errorPayload === 'object' ? errorPayload : {};
  const reason = normalizeCancelReason(
    payload.cancel_reason || payload.cancelReason || payload.terminal_subcode,
    CANCEL_REASON_TRANSPORT_ABORT
  );
  return String(payload.category || '').trim().toLowerCase() === 'cancelled'
    && (reason === CANCEL_REASON_SERVICE_STOP || reason === CANCEL_REASON_DISPOSE);
}

function resolveCancellationMetadata(candidate, category, terminalStatus) {
  const explicitTerminalSubcode = String(candidate.terminal_subcode || '')
    .trim()
    .toLowerCase();
  const includeCancelReason =
    category === TERMINAL_STATUS_CANCELLED
    || category === TERMINAL_STATUS_TIMEOUT
    || terminalStatus === TERMINAL_STATUS_CANCELLED
    || terminalStatus === TERMINAL_STATUS_TIMEOUT;
  if (!includeCancelReason) {
    return {
      cancelReason: '',
      terminalSubcode: explicitTerminalSubcode,
    };
  }
  const cancelReason = cancelReasonFromError(
    candidate,
    category === TERMINAL_STATUS_TIMEOUT ? CANCEL_REASON_TIMEOUT : CANCEL_REASON_SIDECAR
  );
  return {
    cancelReason,
    terminalSubcode: explicitTerminalSubcode || cancelReason,
  };
}

function buildTerminalErrorPayload(error, fallbackCategory = 'runtime') {
  const candidate = error && typeof error === 'object' ? error : {};
  const message = String(candidate.message || error || 'Chat stream failed.');
  const errorCode = String(candidate.error_code || candidate.code || '').trim();
  const category = String(candidate.category || fallbackCategory).trim() || fallbackCategory;
  const terminalStatus = resolveTerminalStatusFromErrorPayload({
    ...candidate,
    category,
  });
  const { cancelReason, terminalSubcode } = resolveCancellationMetadata(
    candidate,
    category,
    terminalStatus
  );
  return {
    message,
    ...(errorCode ? { error_code: errorCode } : {}),
    retryable: candidate.retryable !== false,
    category,
    status: terminalStatus,
    ...(terminalSubcode ? { terminal_subcode: terminalSubcode } : {}),
    ...(cancelReason ? { cancel_reason: cancelReason } : {}),
  };
}

// Live `chat-stream` error events must carry the same recovery metadata the
// persisted assistant_error row gets (chat-stream-session-lifecycle), or the
// renderer falls back to its weaker local classifier mid-stream. Total across
// the emit boundary: malformed input returns unchanged, never throws.
function enrichTerminalErrorPayloadForEmit(errorPayload, {
  terminalStatus = '',
  terminalSubcode = '',
} = {}) {
  if (!errorPayload || typeof errorPayload !== 'object' || Array.isArray(errorPayload)) {
    return errorPayload;
  }
  try {
    const recoveryFields = buildAssistantErrorRecoveryFields(errorPayload, {
      terminalStatus: String(terminalStatus || errorPayload.status || '').trim(),
      terminalSubcode: String(terminalSubcode || errorPayload.terminal_subcode || '').trim(),
    });
    return copyAssistantErrorRecoveryMetadata({ ...errorPayload }, recoveryFields);
  } catch {
    return errorPayload;
  }
}

function createCancellationError(reason = CANCEL_REASON_TRANSPORT_ABORT, message = '') {
  const cancelReason = normalizeCancelReason(reason);
  const error = new Error(
    String(message || '').trim() || (
      cancelReason === CANCEL_REASON_TIMEOUT
        ? 'Stream timed out.'
        : 'Stream cancelled.'
    )
  );
  error.name = 'AbortError';
  error.category = categoryFromCancelReason(cancelReason);
  error.retryable = true;
  error.cancel_reason = cancelReason;
  error.cancelReason = cancelReason;
  error.terminal_subcode = cancelReason;
  return error;
}

function streamErrorDetailsFromAbortSignal(
  signal,
  fallbackReason = CANCEL_REASON_TRANSPORT_ABORT
) {
  const reason = signal && typeof signal === 'object' && 'reason' in signal
    ? signal.reason
    : null;
  if (reason instanceof Error) {
    const cancelReason = cancelReasonFromError(reason, fallbackReason);
    if (!reason.cancel_reason) {
      reason.cancel_reason = cancelReason;
    }
    if (!reason.cancelReason) {
      reason.cancelReason = cancelReason;
    }
    if (!reason.terminal_subcode) {
      reason.terminal_subcode = cancelReason;
    }
    if (!reason.category) {
      reason.category = categoryFromCancelReason(cancelReason);
    }
    if (typeof reason.retryable !== 'boolean') {
      reason.retryable = true;
    }
    return {
      error: reason,
      cancelReason,
    };
  }
  if (typeof reason === 'string' && reason.trim()) {
    const cancelReason = normalizeCancelReason(reason, fallbackReason);
    return {
      error: createCancellationError(cancelReason, reason.trim()),
      cancelReason,
    };
  }
  const cancelReason = normalizeCancelReason('', fallbackReason);
  return {
    error: createCancellationError(cancelReason),
    cancelReason,
  };
}

function resolveTerminalRouting({
  status,
  terminalSubcode = '',
  visibleCompletionEmitted = false,
} = {}) {
  const normalizedStatus = normalizeTerminalStatus(status);
  const normalizedTerminalSubcode = String(terminalSubcode || '').trim().toLowerCase();
  const silentTerminal = normalizedStatus === TERMINAL_STATUS_DENIED;
  const settleQuestionBatch = normalizedStatus === TERMINAL_STATUS_QUESTION_BATCH;
  const completed = normalizedStatus === TERMINAL_STATUS_COMPLETED;
  const emitErrorEvent = !visibleCompletionEmitted && isTerminalErrorStatus(normalizedStatus);
  const persistAssistantFailure = !visibleCompletionEmitted && isTerminalErrorStatus(normalizedStatus);
  const logOnlyLateFailure = visibleCompletionEmitted && isTerminalErrorStatus(normalizedStatus);

  return {
    status: normalizedStatus,
    terminalSubcode: normalizedTerminalSubcode,
    denialSilent: silentTerminal,
    settleQuestionBatch,
    completed,
    emitErrorEvent,
    persistAssistantFailure,
    logOnlyLateFailure,
  };
}

module.exports = {
  CANCEL_REASON_DISPOSE,
  CANCEL_REASON_SERVICE_STOP,
  CANCEL_REASON_SESSION_DELETE,
  CANCEL_REASON_SIDECAR,
  CANCEL_REASON_TIMEOUT,
  CANCEL_REASON_TRANSPORT_ABORT,
  CANCEL_REASON_USER,
  TERMINAL_STATUS_COMPLETED,
  TERMINAL_STATUS_DENIED,
  TERMINAL_STATUS_CANCELLED,
  TERMINAL_STATUS_PREEMPTED,
  TERMINAL_STATUS_TIMEOUT,
  TERMINAL_STATUS_RUNTIME_ERROR,
  TERMINAL_STATUS_QUESTION_BATCH,
  isDeniedTerminalStatus,
  isTerminalErrorStatus,
  cancelReasonFromError,
  buildTerminalErrorPayload,
  createCancellationError,
  enrichTerminalErrorPayloadForEmit,
  isExpectedLifecycleCancellation,
  normalizeCancelReason,
  normalizeTerminalStatus,
  resolveTerminalRouting,
  resolveTerminalStatusFromErrorPayload,
  resolveToolResultStatus,
  streamErrorDetailsFromAbortSignal,
};

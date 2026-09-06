'use strict';

const {
  CLOUD_ERROR_CODES,
  PROTOCOL_ERROR_CODES,
  PROVIDER_CLASSIFICATIONS,
} = require('./error-codes');

// Retry one first-response ChatGPT 401 only before visible output or side
// effects, using one refresh, reconfigure, and resend; otherwise fail closed.

// POLICY CONSTANT — the mid-turn reconfigure runs INSIDE a user-visible turn
// that is already stalled on a failed send, so it cannot inherit the managed
// initialize flight defaults (300s inactivity / 615s absolute): a hung sidecar
// would hold the turn open for minutes past the point the user reads it as
// broken. 8s is above a healthy local initialize round-trip and far below the
// chat idle watchdog, so a stalled reconfigure degrades to the original 401
// instead of racing the stream ceilings.
const TURN_AUTH_RETRY_RECONFIGURE_TIMEOUT_MS = 8_000;
const TURN_AUTH_RETRY_RECONFIGURE_REASON = 'chatgpt_turn_auth_retry';
const CHATGPT_ENGINE_TYPE = 'chatgpt';

// Every notification method whose arrival means the turn already produced
// output or a side effect. A 401 raised by the sidecar's raise_for_initial_status
// fires before ANY of these, so a genuine expiry observes none of them.
const TURN_EFFECT_NOTIFICATION_METHODS = new Set([
  'chat.token',
  'tool.executing',
  'tool.output_chunk',
  'tool.result',
  'chat.question_batch',
  'chat.phase_started',
  'chat.stream_reset',
  'context.compacted',
  'chat.done',
]);

// turn.event is the canonical envelope; only the types that carry visible text,
// persisted reasoning, or a completed message count. Input/progress event types
// (tool_input_delta, tool_execution_progress, ...) are covered by their legacy
// tool.* siblings above.
const TURN_EFFECT_EVENT_TYPES = new Set([
  'text_delta',
  'reasoning_delta',
  'message_completed',
]);

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function readTurnEventType(params) {
  // The wire shape is the event itself (validateTurnEvent reads params.type);
  // params.event is accepted too so a nested envelope can never read as "no
  // effect" and silently unlock a retry.
  const source = asPlainObject(params?.event) || asPlainObject(params) || {};
  return String(source.type || source.event_type || source.eventType || '')
    .trim()
    .toLowerCase();
}

// Per-turn record of "has anything happened yet". Notification-only by design:
// the runtime's own accessors are read separately by the send wrapper so this
// probe stays a pure sink that a caller can hand straight to the send options.
function createTurnEffectProbe() {
  let observedEffect = false;

  function note(notification) {
    if (observedEffect) {
      return;
    }
    const message = asPlainObject(notification);
    if (!message) {
      return;
    }
    const method = String(message.method || '').trim();
    if (!method) {
      return;
    }
    if (method === 'turn.event') {
      if (TURN_EFFECT_EVENT_TYPES.has(readTurnEventType(message.params))) {
        observedEffect = true;
      }
      return;
    }
    if (method === 'chat.thinking') {
      // Only PERSISTED reasoning is an effect; a transient thinking status line
      // is replaced wholesale and leaves no trace in the transcript.
      if (asPlainObject(message.params)?.persist === true) {
        observedEffect = true;
      }
      return;
    }
    if (TURN_EFFECT_NOTIFICATION_METHODS.has(method)) {
      observedEffect = true;
    }
  }

  return {
    note,
    // An approval REQUEST is a turn effect regardless of its outcome: the user
    // has already been shown a gate for this turn.
    noteApproval() {
      observedEffect = true;
    },
    hadEffect() {
      return observedEffect;
    },
    reset() {
      observedEffect = false;
    },
  };
}

function readRpcErrorData(error) {
  return asPlainObject(asPlainObject(error)?.rpc?.data);
}

// provider_code alone cannot identify a 401 (CMP-CLOUD-1003 also covers 5xx and
// context_overflow), which is why the sidecar threads `classification` through
// ToolExecutionFailure.to_error_data(). Both must match, and the turn's engine
// must actually be ChatGPT — anything else fails closed.
function isChatgptAuthRejection(error, engineType) {
  if (String(engineType || '').trim().toLowerCase() !== CHATGPT_ENGINE_TYPE) {
    return false;
  }
  const data = readRpcErrorData(error);
  if (!data) {
    return false;
  }
  return String(data.classification || '').trim() === PROVIDER_CLASSIFICATIONS.INVALID_API_KEY
    && String(data.provider_code || '').trim() === CLOUD_ERROR_CODES.HTTP_ERROR;
}

// The retry deliberately reuses the turn's request_id (it IS the actor lease,
// stream, and notification-routing identity). The sidecar sends a turn's outcome
// BEFORE it unregisters the turn, so a same-id resend inside that window is
// refused with CMP-PROTO-0002. Treat that as "retry declined", not as the
// turn's error.
function isDuplicateRequestIdRejection(error) {
  const data = readRpcErrorData(error);
  if (!data) {
    return false;
  }
  const code = String(data.code || data.error_code || '').trim();
  return code === PROTOCOL_ERROR_CODES.DUPLICATE_REQUEST_ID;
}

function hasTurnEffect(probe, runtime) {
  try {
    if (probe?.hadEffect?.() === true) {
      return true;
    }
    if (runtime?.isVisibleCompletionEmitted?.() === true) {
      return true;
    }
    const toolEvents = runtime?.getDiagnosticToolEvents?.();
    return Array.isArray(toolEvents) && toolEvents.length > 0;
  } catch (_error) {
    // An accessor that throws must fail CLOSED: assume the turn produced
    // effects rather than risk a duplicate send.
    return true;
  }
}

function emitRetryLog(log, ids, level, event, details = {}) {
  if (typeof log !== 'function') {
    return;
  }
  try {
    log(level, event, { ...(asPlainObject(ids) || {}), ...details });
  } catch (_error) {
    // Logging is best-effort and must never alter the turn's outcome.
  }
}

function boundedMessage(error) {
  return String(error?.message || error || '').slice(0, 240);
}

async function sendManagedChatWithAuthRetry({
  service,
  engineType,
  runtime = null,
  controller = null,
  params,
  options,
  probe = null,
  log = null,
  ids = null,
} = {}) {
  const send = () => service.sidecarClient.chatSend(params, options);
  const emit = (level, event, details) => emitRetryLog(log, ids, level, event, details);
  if (service?.featureFlags?.chatgpt_auth_turn_retry === false) {
    return send();
  }
  // At-most-one refresh+retry per turn is enforced STRUCTURALLY: `alreadyRetried`
  // is local to a single invocation and is the ONLY way past the precondition
  // gate a second time — once set, the next failure takes the terminal branch.
  let alreadyRetried = false;
  let originalAuthError = null;
  for (;;) {
    try {
      return await send();
    } catch (error) {
      if (alreadyRetried) {
        if (isDuplicateRequestIdRejection(error)) {
          // The sidecar had not yet unregistered the turn. Retry declined —
          // the truthful error for the user is the original 401.
          emit('WARN', 'chatgpt_auth.turn_retry_declined_duplicate_request_id');
          throw originalAuthError;
        }
        if (isChatgptAuthRejection(error, engineType)) {
          // A freshly minted token that still 401s is sign-out-equivalent: the
          // credential is dead, not merely stale.
          try {
            await service.chatgptAuthService.permanentlyExpireAuth?.();
          } catch (expireError) {
            emit('WARN', 'chatgpt_auth.turn_retry_expire_failed', {
              message: boundedMessage(expireError),
            });
          }
          emit('WARN', 'chatgpt_auth.turn_retry_token_rejected');
        }
        throw error;
      }
      if (!isChatgptAuthRejection(error, engineType)) {
        throw error;
      }
      if (controller?.signal?.aborted === true) {
        throw error;
      }
      if (hasTurnEffect(probe, runtime)) {
        throw error;
      }
      emit('INFO', 'chatgpt_auth.turn_retry_started');

      const auth = service?.chatgptAuthService;
      if (typeof auth?.getAccessToken !== 'function') {
        emit('WARN', 'chatgpt_auth.turn_retry_refresh_failed', {
          reason: 'auth_service_unavailable',
        });
        throw error;
      }
      let refreshedToken;
      try {
        refreshedToken = await auth.getAccessToken({ force: true });
      } catch (refreshError) {
        // A refresh throw may be transient network, so the credential is NOT
        // known-dead here — surface the original 401 and never expire.
        emit('WARN', 'chatgpt_auth.turn_retry_refresh_failed', {
          reason: 'refresh_threw',
          message: boundedMessage(refreshError),
        });
        throw error;
      }
      if (!String(refreshedToken || '').trim()) {
        // '' means the provider rejected the refresh token; the auth service has
        // ALREADY run permanentlyExpireAuth() on that path. Nothing more to do.
        emit('WARN', 'chatgpt_auth.turn_retry_refresh_failed', { reason: 'no_token' });
        throw error;
      }

      try {
        await service.refreshManagedConfig(TURN_AUTH_RETRY_RECONFIGURE_REASON, {
          requestedEngineType: CHATGPT_ENGINE_TYPE,
          inactivityTimeoutMs: TURN_AUTH_RETRY_RECONFIGURE_TIMEOUT_MS,
          absoluteTimeoutMs: TURN_AUTH_RETRY_RECONFIGURE_TIMEOUT_MS,
        });
      } catch (reconfigureError) {
        emit('WARN', 'chatgpt_auth.turn_retry_reconfigure_failed', {
          message: boundedMessage(reconfigureError),
        });
        throw error;
      }

      alreadyRetried = true;
      originalAuthError = error;
      // The retry reuses the SAME params (request_id included) and the SAME
      // options object, so notification routing and the actor lease are intact.
      probe?.reset?.();
    }
  }
}

module.exports = {
  TURN_AUTH_RETRY_RECONFIGURE_REASON,
  TURN_AUTH_RETRY_RECONFIGURE_TIMEOUT_MS,
  createTurnEffectProbe,
  isChatgptAuthRejection,
  isDuplicateRequestIdRejection,
  sendManagedChatWithAuthRetry,
};

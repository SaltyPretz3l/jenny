// Shared per-session in-flight admission gate for the two chat entrypoints
// (managed-sidecar-chat.js, backend-chat-stream.js). Both register a stream
// and persist a user message with no check against an already-in-flight turn
// on the same session; a second concurrent send silently clobbers the first
// turn's active_turn record (bare `setActiveTurn` overwrite) and leaves its
// activeStreams controller orphaned. This module gates BOTH entrypoints at
// the top, before `activeStreams.set(...)` and before any persist.
//
// "Busy" = active_turn present AND a live controller keyed by
// active_turn.stream_id exists in service.activeStreams (reserved for the
// full lifetime of the turn, including the intentional cancel window —
// see managed-sidecar-chat.js's catch block, which deliberately keeps
// active_turn set through persistence so the launch-time reconciler stays
// authoritative if the process dies mid-catch).
//
// "Orphan/reclaimable" = active_turn present but NO live controller AND the
// heartbeat (`last_event_at`) is older than CHAT_STREAM_IDLE_TIMEOUT_MS. This
// mirrors the idle-watchdog timeout managed-sidecar-chat.js already uses to
// decide a turn has gone quiet, and is deliberately a cheaper, purely local
// check than managed-sidecar-reconciliation.js's RPC-backed reconcile (which
// asks the sidecar for its live turn state at startup) — this gate runs on
// every send, so it must not make a network/RPC round trip.
//
// A controller-less active_turn whose heartbeat is still fresh is treated as
// busy too: the controller is only removed in the entrypoint's own `finally`,
// so a fresh heartbeat with no controller is a vanishingly narrow timing
// window, not a confirmed orphan — erring toward busy here avoids a false
// "succeeded" admission racing the real turn's own teardown.

const {
  getConfiguredWithDefault,
} = require('./managed-sidecar-engine-tuning');

// Keep the outer idle watchdog and controller-less orphan threshold derived
// from the same schema-owned value Electron sends to the sidecar.
const MANAGED_LOCAL_MAX_LOOP_WALL_SECONDS = getConfiguredWithDefault(
  { configService: null },
  'maxLoopWallSeconds'
);
const CHAT_STREAM_SETTLEMENT_MARGIN_MS = 60_000;
// 2026-08-30: idle/orphan detection is decoupled from the working-time budget
// (now 30+ minutes by default), so a wedged sidecar is caught in minutes, not
// at the wall budget. The ceiling must still exceed every LEGITIMATE silent
// stretch of a healthy turn: the longest is a run_command honoring a requested
// timeout (600s + 5s handler slop in tool_execution.py's carve-out) that emits
// no output; model-load grace (300s) and chunk-inactivity (120s) are shorter,
// and human-wait states pause the idle clock entirely. 660s covers 605s with
// margin; the settlement margin is added on top by each consumer.
const CHAT_STREAM_IDLE_ACTIVITY_CEILING_MS = 660_000;
const CHAT_STREAM_IDLE_TIMEOUT_MS = (
  Math.min(
    MANAGED_LOCAL_MAX_LOOP_WALL_SECONDS * 1_000,
    CHAT_STREAM_IDLE_ACTIVITY_CEILING_MS
  )
  + CHAT_STREAM_SETTLEMENT_MARGIN_MS
);

function resolveConfiguredLocalMaxLoopWallSeconds(service) {
  try {
    return getConfiguredWithDefault(service || {}, 'maxLoopWallSeconds');
  } catch (_error) {
    return MANAGED_LOCAL_MAX_LOOP_WALL_SECONDS;
  }
}

function resolveLocalChatStreamIdleTimeoutMs(service) {
  return Math.min(
    resolveConfiguredLocalMaxLoopWallSeconds(service) * 1_000,
    CHAT_STREAM_IDLE_ACTIVITY_CEILING_MS
  ) + CHAT_STREAM_SETTLEMENT_MARGIN_MS;
}

function parseIsoTimestampMs(value) {
  const token = String(value || '').trim();
  if (!token) {
    return NaN;
  }
  const parsed = Date.parse(token);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function createSessionBusyError(message = 'a turn is already running') {
  const error = new Error(String(message || '').trim() || 'a turn is already running');
  error.code = 'session_busy';
  error.category = 'session_busy';
  error.retryable = true;
  return error;
}

// Pure predicate (no throw) so callers that only need the boolean (tests,
// future call sites) don't have to catch. assertSessionAdmissible below is
// the throwing wrapper used at the entrypoints.
function isSessionBusy(service, { sessionId, store, now = Date.now() } = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId || !store || typeof store.getActiveTurn !== 'function') {
    return false;
  }
  const activeTurn = store.getActiveTurn(normalizedSessionId);
  if (!activeTurn) {
    return false;
  }
  const streamId = String(activeTurn.stream_id || '').trim();
  const activeStreams = service && service.activeStreams;
  const hasLiveController = Boolean(
    streamId
    && activeStreams
    && typeof activeStreams.get === 'function'
    && activeStreams.get(streamId)
  );
  if (hasLiveController) {
    return true;
  }
  // No live controller: reclaimable only once the heartbeat is stale. A fresh
  // heartbeat with no controller is not (yet) a confirmed orphan.
  const lastEventAtMs = parseIsoTimestampMs(activeTurn.last_event_at);
  if (!Number.isFinite(lastEventAtMs)) {
    // Malformed/missing heartbeat on an otherwise-present active_turn: fail
    // toward busy rather than silently admitting a second send.
    return true;
  }
  const ageMs = Math.max(Number(now) - lastEventAtMs, 0);
  return ageMs < resolveLocalChatStreamIdleTimeoutMs(service);
}

// Throws a structured session_busy error when the session has a genuinely
// in-flight turn. No-op (returns undefined) when admissible — including the
// "no requestedSessionId" (brand-new session) case, since callers should
// skip invoking this at all when there is no prior session to check, but it
// is also safe to call with an empty sessionId (isSessionBusy returns false).
function assertSessionAdmissible(service, { sessionId, store, now } = {}) {
  if (isSessionBusy(service, { sessionId, store, now })) {
    throw createSessionBusyError();
  }
}

module.exports = {
  MANAGED_LOCAL_MAX_LOOP_WALL_SECONDS,
  CHAT_STREAM_SETTLEMENT_MARGIN_MS,
  CHAT_STREAM_IDLE_ACTIVITY_CEILING_MS,
  CHAT_STREAM_IDLE_TIMEOUT_MS,
  resolveConfiguredLocalMaxLoopWallSeconds,
  resolveLocalChatStreamIdleTimeoutMs,
  createSessionBusyError,
  isSessionBusy,
  assertSessionAdmissible,
};

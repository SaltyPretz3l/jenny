'use strict';

/* services/performance/inference-intake.js - per-session ownership of the
 * ephemeral `inference.performance` notifications (row 59 checkpoint 6).
 *
 * The router hands every notification here with its stream context. Nothing a
 * provider or sidecar says can select a session: `request_id` must equal the
 * stream id and `session_id` the resolved session. A session keeps only its
 * latest physical attempt; older attempts and older requests are retired so a
 * late frame cannot resurrect them. Terminal observations are also kept as
 * bounded summaries (latest 32 per request) for the turn's usage record.
 *
 * accept() never throws and never touches the stream: telemetry must not affect
 * liveness, watchdogs or row rendering.
 */

const { createAttemptMetrics } = require('./inference-metrics');
const {
  MAX_SUMMARIES, TERMINAL_PHASES, boundInferencePerformance, normalizeObservation,
} = require('./performance-contract');

const MAX_SESSIONS = 256;
const MAX_RETIRED = 64;
const MAX_TERMINAL_REQUESTS = 64;
const SUMMARY_FIELDS = Object.freeze([
  'turn_id', 'provider_call_id', 'attempt_id', 'sampled_at', 'phase', 'provider_kind',
  'generated_tokens', 'decode_interval_tokens', 'decode_elapsed_ms', 'prompt_tokens', 'cached_prompt_tokens',
  'processed_prompt_tokens', 'prefill_elapsed_ms', 'time_to_first_generated_token_ms',
  'terminal_decode_tps', 'terminal_prefill_tps',
]);

const unavailable = () => ({ value: null, state: 'unavailable', sampled_at: null });

function bounded(set, value, limit) {
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value);
}

function createInferenceIntake({ now = Date.now } = {}) {
  // sessionId -> { requestId, mark, attempt: {id, lastSequence, metrics, providerKind} | null,
  //                retiredAttempts, retiredRequests }
  const sessions = new Map();
  // requestId -> { sessionId, summaries, omitted }
  const terminals = new Map();
  const listeners = new Set();

  function touch(sessionId, entry) {
    sessions.delete(sessionId);
    sessions.set(sessionId, entry);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    return entry;
  }

  function emit(sessionId, detail) {
    for (const listener of [...listeners]) {
      try { listener(sessionId, detail); } catch (_error) { /* a bad listener never breaks the intake */ }
    }
  }

  function newEntry(previous, requestId, mark) {
    const retiredRequests = previous?.retiredRequests || new Set();
    if (previous?.requestId && previous.requestId !== requestId) bounded(retiredRequests, previous.requestId, MAX_RETIRED);
    return { requestId, mark, attempt: null, retiredAttempts: new Set(), retiredRequests };
  }

  function recordTerminal(sessionId, requestId, observation) {
    let record = terminals.get(requestId);
    if (!record) {
      record = { sessionId, summaries: [], omitted: 0 };
      terminals.set(requestId, record);
      while (terminals.size > MAX_TERMINAL_REQUESTS) terminals.delete(terminals.keys().next().value);
    }
    record.summaries.push(Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, observation[field] ?? null])));
    if (record.summaries.length > MAX_SUMMARIES) {
      record.summaries.shift();
      record.omitted += 1;
    }
  }

  function accept(ctx, params) {
    try {
      const sessionId = ctx?.resolvedSessionId;
      const requestId = ctx?.streamId;
      if (typeof sessionId !== 'string' || !sessionId || typeof requestId !== 'string' || !requestId) return false;
      if (!params || typeof params !== 'object' || params.request_id !== requestId || params.session_id !== sessionId) {
        return false;
      }
      const observation = normalizeObservation(params);
      if (!observation) return false;
      let entry = sessions.get(sessionId);
      if (entry?.retiredRequests.has(requestId)) return false;
      if (!entry || (entry.requestId && entry.requestId !== requestId)) {
        entry = newEntry(entry, requestId, null);
      }
      entry.requestId = requestId;
      let attempt = entry.attempt;
      if (!attempt || attempt.id !== observation.attempt_id) {
        if (entry.retiredAttempts.has(observation.attempt_id)) return false;
        if (attempt) bounded(entry.retiredAttempts, attempt.id, MAX_RETIRED);
        attempt = {
          id: observation.attempt_id,
          providerKind: observation.provider_kind,
          metrics: createAttemptMetrics({ now, live: entry.mark?.live_requested !== false }),
        };
        entry.attempt = attempt;
      }
      if (!attempt.metrics.observe(params, now())) return false;
      touch(sessionId, entry);
      const terminal = TERMINAL_PHASES.includes(observation.phase);
      if (terminal) recordTerminal(sessionId, requestId, attempt.metrics.project(now()).observation || observation);
      emit(sessionId, { terminal });
      return true;
    } catch (_error) {
      return false;
    }
  }

  // The counter was off (or the provider cannot stream live metrics) when the
  // request was created. A live-capable provider reports available_next_request:
  // turning the counter on never restarts the request.
  function applyMark(projected, mark, providerKind) {
    if (!mark || mark.live_requested !== false) return projected;
    const next = mark.live_capable !== false && (providerKind === null || providerKind === 'ninfer')
      ? { value: null, state: 'available_next_request', sampled_at: null }
      : unavailable();
    return { ...projected, live_decode: next, live_prefill: { ...next } };
  }

  function snapshotForSession(sessionId, nowMs = now()) {
    try {
      const entry = sessions.get(sessionId);
      if (!entry) return null;
      if (!entry.attempt) {
        // Marked but no frame yet: the request exists, nothing has been measured.
        if (!entry.mark) return null;
        return applyMark({
          observation: null,
          live_decode: { value: null, state: entry.mark.live_requested ? 'warming' : 'unavailable', sampled_at: null },
          live_prefill: { value: null, state: entry.mark.live_requested ? 'warming' : 'unavailable', sampled_at: null },
          cache_fraction: unavailable(),
        }, entry.mark, null);
      }
      return applyMark(entry.attempt.metrics.project(nowMs), entry.mark, entry.attempt.providerKind);
    } catch (_error) {
      return null;
    }
  }

  // Recorded when the request is created, before any frame. `request_id` (when
  // known) lets late frames of the previous request be refused immediately.
  function markRequest(sessionId, { live_requested: liveRequested, live_capable: liveCapable, request_id: requestId } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const mark = { live_requested: liveRequested === true, live_capable: liveCapable !== false };
    const previous = sessions.get(sessionId);
    touch(sessionId, newEntry(previous, typeof requestId === 'string' && requestId ? requestId : null, mark));
    emit(sessionId, { terminal: false });
    return true;
  }

  function takeTerminalSummaries(requestId) {
    const record = terminals.get(requestId);
    if (!record) return null;
    terminals.delete(requestId);
    return boundInferencePerformance({ summaries: record.summaries, omitted_count: record.omitted });
  }

  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function forgetSession(sessionId) {
    sessions.delete(sessionId);
    for (const [requestId, record] of terminals) if (record.sessionId === sessionId) terminals.delete(requestId);
  }

  return { accept, snapshotForSession, markRequest, onChange, forgetSession, takeTerminalSummaries };
}

module.exports = { createInferenceIntake };

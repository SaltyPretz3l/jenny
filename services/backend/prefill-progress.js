"use strict";

// Private, ephemeral chat.thinking extension. Every identity comes from the
// admitted stream context; a provider cannot select a session or logical turn.
function acceptPrefillProgress(ctx, params) {
  if (params.request_id !== ctx.streamId || params.session_id !== ctx.resolvedSessionId
      || params.kind !== 'status' || params.persist !== false) return null;
  const raw = params.progress;
  if (!raw || typeof raw !== 'object' || !/^[a-f0-9]{32}$/.test(raw.attempt_id || '')
      || !Number.isSafeInteger(raw.sequence) || raw.sequence <= 0) return null;
  let state = ctx.prefillProgress;
  if (raw.state === 'start') {
    if (state?.attemptId === raw.attempt_id || state?.retired?.has(raw.attempt_id)) return null;
    // Every tool-loop generation is a new attempt; bound memory, not the turn.
    const retired = state?.retired || new Set();
    if (state) retired.add(state.attemptId);
    if (retired.size > 64) retired.delete(retired.values().next().value);
    state = { attemptId: raw.attempt_id, sequence: raw.sequence, retired, closed: false, sample: null };
    ctx.prefillProgress = state;
  } else {
    if (!state || state.closed || state.attemptId !== raw.attempt_id || raw.sequence <= state.sequence) return null;
    state.sequence = raw.sequence;
  }
  const identity = { state: raw.state, attemptId: state.attemptId, sequence: state.sequence,
    sessionId: ctx.resolvedSessionId, requestId: ctx.streamId, turnId: ctx.turnId || ctx.streamId };
  if (raw.state === 'start') return { progress: identity, moved: false };
  const { total_tokens: total, cached_tokens: cached, processed_tokens: processed, elapsed_ms: elapsed } = raw;
  const valid = raw.state === 'sample' && [total, cached, processed].every(Number.isSafeInteger)
    && 0 <= cached && cached <= processed && processed <= total && total > 0 && total <= 1048576
    && (elapsed == null || (typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0))
    && (!state.sample || (total === state.sample.total && cached === state.sample.cached
      && processed >= state.sample.processed && (elapsed == null || state.sample.elapsed == null || elapsed >= state.sample.elapsed)));
  if (!valid) {
    state.closed = true;
    return { progress: { ...identity, state: 'unavailable' }, moved: false };
  }
  const moved = state.sample ? processed > state.sample.processed : processed > cached;
  if (state.sample?.processed === processed) return null;
  state.sample = { total, cached, processed, elapsed };
  return { progress: { ...identity, ...state.sample }, moved };
}

module.exports = { acceptPrefillProgress };

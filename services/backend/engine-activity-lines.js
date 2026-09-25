'use strict';

// Engine-liveness heartbeat (2026-07-11 CMP-LOOP-0015 RCA, extended 2026-09-19
// to the managed llama-server): a local engine streams NOTHING to the chat
// client while the model composes a buffered tool call, but the llama.cpp
// server prints per-slot telemetry on stderr every few seconds while decoding
// (and progress lines during prompt eval / model load). Lines matching these
// prefixes are forwarded — throttled — to the sidecar's stream-inactivity
// watchdog as proof the engine is busy, not hung.
// Deliberately EXCLUDES `srv` lines ("all slots are idle" is not activity) and
// [GIN] access logs (the shell's own /api/tags polls would defeat the watchdog
// entirely).
const ENGINE_ACTIVITY_LINE_PATTERNS = [
  /^slot\s+\w+/i, // per-slot lifecycle: launch/operator/print_timing/release
  /^cmn\s/i, // reasoning-budget transitions during active decode
  /^(llama_|load_tensors|llm_load|ggml_)/i, // model (re)load progress
];

// Ollama's embedded runner prints the bare line; a standalone llama-server
// prefixes it with its own timestamp and one-letter level ("13.45.081.978 I
// slot print_timing: ..."). Strip that prefix before matching so one pattern
// set covers both — the exclusions above still hold, because the text after
// the prefix is what decides.
const LLAMA_SERVER_LOG_PREFIX = /^\d[\d.]*\s+(?:[A-Z]\s+)?/;
// Builds with colour enabled wrap the timestamp and level in SGR escapes.
// eslint-disable-next-line no-control-regex -- llama.cpp's --log-colors codes.
const LOG_COLOR_CODES = /\u001b\[[\d;]*m/g;

const ENGINE_ACTIVITY_THROTTLE_MS = 5000;

function isEngineActivityLine(line) {
  const text = String(line || '')
    .replace(LOG_COLOR_CODES, '')
    .replace(LLAMA_SERVER_LOG_PREFIX, '');
  return ENGINE_ACTIVITY_LINE_PATTERNS.some((pattern) => pattern.test(text));
}

// Returns a `(line) => void` that calls the sink at most once per throttle
// window for lines that prove decode/load progress, or null when there is no
// sink. Best-effort by contract: a throw in the sink must never take down the
// log pipeline this rides on.
//
// `now` defaults to a monotonic clock: a backward wall-clock step (NTP
// correction) under Date.now would suppress heartbeats for the length of the
// jump, starving the sidecar's liveness clock mid-generation — the exact false
// positive the heartbeat exists to prevent.
function createEngineActivityForwarder({
  onEngineActivity,
  throttleMs = ENGINE_ACTIVITY_THROTTLE_MS,
  now = () => performance.now(),
} = {}) {
  if (typeof onEngineActivity !== 'function') {
    return null;
  }
  const window = Number(throttleMs) >= 0 ? Number(throttleMs) : ENGINE_ACTIVITY_THROTTLE_MS;
  let lastForwardedAt = 0;
  return function forwardEngineActivity(line) {
    if (!isEngineActivityLine(line)) {
      return;
    }
    const at = now();
    if (lastForwardedAt && at - lastForwardedAt < window) {
      return;
    }
    lastForwardedAt = at;
    try {
      onEngineActivity();
    } catch (_error) {
      /* best-effort */
    }
  };
}

module.exports = {
  ENGINE_ACTIVITY_LINE_PATTERNS,
  ENGINE_ACTIVITY_THROTTLE_MS,
  createEngineActivityForwarder,
  isEngineActivityLine,
};

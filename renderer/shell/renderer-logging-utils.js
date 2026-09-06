(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererLoggingUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Largest serialized `details` blob we keep verbatim on intake. A single tool
     payload can be hundreds of KB; beyond this we store a readable preview so it
     neither bloats the ring buffer nor janks the per-render redaction pass. */
  const DEFAULT_DETAIL_SIZE_CAP = 32768;

  /* Intake hardening: onAppend payloads are untrusted. Oversized or circular
     `details` would otherwise propagate verbatim into the buffer and the copy
     path. Returns a plain object that is always safe to JSON.stringify. */
  function sanitizeLogDetails(details, cap) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      return {};
    }
    let serialized;
    try {
      serialized = JSON.stringify(details);
    } catch (_error) {
      return { _unserializable: true };
    }
    const limit = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_DETAIL_SIZE_CAP;
    if (serialized && serialized.length > limit) {
      return { _truncated: true, _originalSize: serialized.length, preview: serialized.slice(0, 2000) };
    }
    return details;
  }

  /* A malformed `ts` becomes NaN and poisons the newest-first sort -- clamp any
     unparseable timestamp to intake time so ordering stays stable. */
  function clampLogTimestamp(ts) {
    const tsMs = ts == null ? NaN : new Date(ts).getTime();
    return Number.isFinite(tsMs) ? ts : new Date().toISOString();
  }

  function createClientLogAppender({
    pushLogEntry,
    component = 'renderer',
  } = {}) {
    const push = typeof pushLogEntry === 'function' ? pushLogEntry : () => {};
    const bootId = `renderer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let originSequence = 0;
    return function appendClientLog(level, event, details = {}) {
      const normalizedDetails = details && typeof details === 'object' && !Array.isArray(details)
        ? { ...details }
        : { value: String(details || '') };
      const normalizedLevel = String(level || 'INFO').trim().toUpperCase();
      const safeLevel = ['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(normalizedLevel)
        ? normalizedLevel
        : 'INFO';
      const normalizedEvent = String(event || 'renderer.event').trim() || 'renderer.event';
      const message = String(
        normalizedDetails.message
        || normalizedDetails.error
        || normalizedDetails.reason
        || normalizedEvent
      ).trim() || normalizedEvent;
      const status = String(normalizedDetails.status || 'ok').trim() || 'ok';
      // Renderer-originated entries get the same size-cap / circular guard the
      // external onAppend path uses, so an oversized or circular `details` object
      // cannot propagate verbatim into the ring buffer or the IPC forwarder batch.
      // (Correlation fields above are read from the original before sanitizing.)
      const safeDetails = sanitizeLogDetails(normalizedDetails);
      push({
        ts: new Date().toISOString(),
        level: safeLevel,
        layer: 'renderer',
        component,
        event: normalizedEvent,
        message,
        trace_id: String(normalizedDetails.trace_id || '').trim(),
        request_id: String(normalizedDetails.request_id || '').trim(),
        session_id: String(normalizedDetails.session_id || normalizedDetails.sessionId || '').trim(),
        tool_call_id: String(normalizedDetails.tool_call_id || normalizedDetails.call_id || normalizedDetails.callId || '').trim(),
        approval_id: String(normalizedDetails.approval_id || '').trim(),
        rpc_id: String(normalizedDetails.rpc_id || '').trim(),
        status,
        duration_ms: Number.isFinite(Number(normalizedDetails.duration_ms))
          ? Number(normalizedDetails.duration_ms)
          : null,
        data: safeDetails,
        redaction_mode: 'redacted',
        schema_version: 1,
        details: {
          ...safeDetails,
          message,
          status,
        },
        source: 'renderer',
        origin_entry_id: `${bootId}:${++originSequence}`,
      });
    };
  }

  return Object.freeze({
    createClientLogAppender,
    sanitizeLogDetails,
    clampLogTimestamp,
    DEFAULT_DETAIL_SIZE_CAP,
  });
});

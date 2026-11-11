// Turn telemetry for startManagedSidecarChatStream (managed-sidecar-chat.js):
// timing markers, phase logs around context assembly and the request send, and
// the fire-and-forget turn diagnostic dump. Logging only; no turn state.
const { dumpTurnDiagnostic } = require('./turn-diagnostic-dump');
const { recordServicePhasePercentile } = require('./phase-percentiles-aggregator');
const { emitManagedTurnPerformanceSummary } = require('./managed-sidecar-chat-helpers');

function createManagedTurnTiming(service, {
  sessionId: resolvedSessionId, streamId, traceId: requestTraceId, clientTiming: normalizedClientTiming,
}) {
  const timingMarkers = [];
  timingMarkers.push({ name: 'send_initiated', ts_ms: Date.now() });
  // Emit chat.send_initiated with renderer timing deltas (if provided). The renderer captures
  // send_started_at_ms (keystroke/click time) and optimistic_rendered_at_ms; the ipc_latency_ms
  // field below is the backend's view of how long the send took to reach the managed chat entry.
  service._emitServiceLog('DEBUG', 'chat.send_initiated', {
    sessionId: resolvedSessionId,
    streamId,
    traceId: requestTraceId,
    // Unmeasured markers are null; Number(null) === 0 once logged the epoch here.
    ipc_latency_ms: normalizedClientTiming.sendStartedAtMs != null
      ? Math.max(Date.now() - normalizedClientTiming.sendStartedAtMs, 0) : null,
    local_render_latency_ms: normalizedClientTiming.localRenderLatencyMs,
  });
  function logTiming(event, startedAt, details = {}) {
    service._emitServiceLog('DEBUG', event, {
      sessionId: resolvedSessionId,
      streamId,
      elapsedMs: Math.max(Date.now() - Number(startedAt || Date.now()), 0),
      ...details,
    });
  }
  function recordTiming(event, startedAt, markerName, details = {}) {
    logTiming(event, startedAt, details);
    timingMarkers.push({ name: String(markerName), ts_ms: Date.now() });
  }
  function recordTimingMarker(name) {
    timingMarkers.push({ name: String(name), ts_ms: Date.now() });
  }
  return { timingMarkers, logTiming, recordTiming, recordTimingMarker };
}

// A dump failure is logged, never thrown into the turn.
function dumpTurnDiagnosticSafely(payload) {
  const { service, sessionId, streamId, traceId } = payload;
  Promise.resolve(dumpTurnDiagnostic(payload)).catch((dumpError) => {
    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('WARN', 'chat.turn_diagnostic_dump_unexpected_error', {
        sessionId,
        streamId,
        traceId,
        message: String(dumpError?.message || dumpError),
      });
    }
  });
}

function noteManagedContextAssemblyStarted(service, {
  recordTimingMarker, clientTiming: normalizedClientTiming,
  sessionId: resolvedSessionId, streamId, engineType, model, contextPreferences,
}) {
  const contextAssemblyStartedAt = Date.now();
  recordTimingMarker('context_assembly_started');
  if (normalizedClientTiming.localRenderLatencyMs != null) {
    recordServicePhasePercentile(service, 'click_to_optimistic_render', normalizedClientTiming.localRenderLatencyMs);
  }
  if (normalizedClientTiming.optimisticRenderedAtMs != null) {
    recordServicePhasePercentile(
      service,
      'optimistic_render_to_context_assembly_started',
      Math.max(contextAssemblyStartedAt - normalizedClientTiming.optimisticRenderedAtMs, 0)
    );
  }
  service._emitServiceLog('INFO', 'chat.context_assembly_started', {
    sessionId: resolvedSessionId,
    streamId,
    engineType,
    model,
    history_scope: contextPreferences.history_scope,
    include_personality: contextPreferences.include_personality !== false,
    include_memory: contextPreferences.include_memory !== false,
    include_git_context: contextPreferences.include_git_context !== false,
    include_codebase_context: contextPreferences.include_codebase_context !== false,
    include_active_file_context: contextPreferences.include_active_file_context !== false,
  });
  return contextAssemblyStartedAt;
}

function noteManagedContextAssemblyCompleted(service, {
  recordTimingMarker, sessionId: resolvedSessionId, streamId, engineType, model,
  contextAssemblyStartedAt, contextAssemblyBreakdown, contextPreferences, memoryPolicy,
}) {
  const contextAssemblyCompletedAt = Date.now();
  recordTimingMarker('context_assembly_completed');
  service._emitServiceLog('INFO', 'chat.context_assembly_completed', {
    sessionId: resolvedSessionId,
    streamId,
    engineType,
    model,
    elapsedMs: Math.max(contextAssemblyCompletedAt - contextAssemblyStartedAt, 0),
    included_personality: contextAssemblyBreakdown?.includedPersonality === true,
    included_memory: contextPreferences.include_memory !== false,
    included_git_context: contextPreferences.include_git_context !== false,
    included_codebase_context: contextPreferences.include_codebase_context !== false,
    memory_policy_enabled: memoryPolicy?.enabled === true,
  });
  return contextAssemblyCompletedAt;
}

// The performance summary, prompt contributions and request-sent logs; returns
// the request start time the settle timing is measured from.
function emitManagedTurnPreSendTelemetry(service, {
  recordTimingMarker, resolvedSessionId, streamId, requestTraceId, canonicalSessionMessages,
  effectiveMode, engineType, model, contextPreferences, contextAssemblyBreakdown, preparedMessages,
  textAttachments, imageAttachments, requestToolPreferences, normalizedDebugOptions,
  sessionTimingStartedAt, contextAssemblyStartedAt, contextAssemblyCompletedAt, promptContributions,
}) {
  const performanceSummaryEmittedAt = Date.now();
  recordTimingMarker('performance_summary_emitted');
  emitManagedTurnPerformanceSummary(service, {
    resolvedSessionId,
    streamId,
    requestTraceId,
    canonicalSessionMessages,
    effectiveMode,
    engineType,
    model,
    contextPreferences,
    contextAssemblyBreakdown,
    preparedMessages,
    textAttachments,
    imageAttachments,
    requestToolPreferences,
    normalizedDebugOptions,
    sessionTimingStartedAt,
    contextAssemblyStartedAt,
    contextAssemblyCompletedAt,
    performanceSummaryEmittedAt,
  });
  service._emitServiceLog('INFO', 'chat.prompt_contributions', {
    sessionId: resolvedSessionId,
    streamId,
    contributions: promptContributions,
  });

  const sidecarRequestStartedAt = Date.now();
  recordTimingMarker('sidecar_request_sent');
  recordServicePhasePercentile(
    service,
    'context_assembly_completed_to_sidecar_request_sent',
    Math.max(sidecarRequestStartedAt - contextAssemblyCompletedAt, 0)
  );
  service._emitServiceLog('INFO', 'chat.sidecar_request_sent', {
    sessionId: resolvedSessionId,
    streamId,
    traceId: requestTraceId,
    mode: effectiveMode,
    engineType,
    model,
    message_count: preparedMessages.length,
    canonical_message_count: canonicalSessionMessages.length,
  });
  return sidecarRequestStartedAt;
}

module.exports = {
  createManagedTurnTiming,
  dumpTurnDiagnosticSafely,
  emitManagedTurnPreSendTelemetry,
  noteManagedContextAssemblyCompleted,
  noteManagedContextAssemblyStarted,
};

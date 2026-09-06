// Stateless helpers for the managed-sidecar chat orchestrator. They depend only
// on Node globals and leaf helpers, never on the orchestrator, so the import
// direction stays one-way (managed-sidecar-chat.js -> this module).

const {
  recordServicePhasePercentile,
} = require('./phase-percentiles-aggregator');
const {
  CHAT_STREAM_SETTLEMENT_MARGIN_MS,
  CHAT_STREAM_IDLE_ACTIVITY_CEILING_MS,
  MANAGED_LOCAL_MAX_LOOP_WALL_SECONDS,
} = require('./chat-stream-admission');
const {
  fingerprintCompactionPrefix,
} = require('./session-compaction-snapshot');

// Electron-side stream ceilings, keyed by engine type to mirror the sidecar's
// cloud loop profile (sidecar/ai/routing/iteration_limits.py). The sidecar
// grants cloud frontier engines a 28,800s turn wall clock and 1,800s silent
// tool calls; the Electron ceilings must stay strictly WIDER than those so the
// sidecar's graceful wind-down/timeout always fires before Electron's hard
// abort (which also forces a sidecar restart). The local idle ceiling is
// derived from the configured working-time limit plus a 60s settlement margin.
// The absolute backstop remains finite and expands when that margin exceeds it.
const CLOUD_ENGINE_TYPES = new Set(['chatgpt', 'codex-cli']);
const CHAT_STREAM_ABSOLUTE_TIMEOUT_MS = 1_800_000;
// 1,800s cloud per-tool timeout + 60s margin: a silent (non-streaming) tool
// call may legitimately produce no stream events for its full budget.
const CLOUD_CHAT_STREAM_IDLE_TIMEOUT_MS = 1_860_000;
// 28,800s cloud wall clock + 600s margin.
const CLOUD_CHAT_STREAM_ABSOLUTE_TIMEOUT_MS = 29_400_000;

function resolveChatStreamCeilings(
  engineType,
  localMaxLoopWallSeconds = MANAGED_LOCAL_MAX_LOOP_WALL_SECONDS
) {
  const cloud = CLOUD_ENGINE_TYPES.has(String(engineType || '').trim().toLowerCase());
  const localWallMs = Math.max(Number(localMaxLoopWallSeconds) || 0, 1) * 1_000;
  // 2026-08-30: idle is capped independently of the working-time budget so the
  // hang detector still fires in minutes (a healthy turn's silent stretches
  // are bounded by tool timeouts / chunk-inactivity, and human waits pause the
  // clock); only the absolute backstop scales with the full wall budget.
  const localIdleTimeoutMs = Math.min(localWallMs, CHAT_STREAM_IDLE_ACTIVITY_CEILING_MS)
    + CHAT_STREAM_SETTLEMENT_MARGIN_MS;
  const localAbsoluteFloorMs = localWallMs + CHAT_STREAM_SETTLEMENT_MARGIN_MS;
  return {
    idleTimeoutMs: cloud ? CLOUD_CHAT_STREAM_IDLE_TIMEOUT_MS : localIdleTimeoutMs,
    absoluteTimeoutMs: cloud
      ? CLOUD_CHAT_STREAM_ABSOLUTE_TIMEOUT_MS
      : Math.max(CHAT_STREAM_ABSOLUTE_TIMEOUT_MS, localAbsoluteFloorMs),
  };
}

// Per-turn stream watchdog: an idle timer re-armed on every observable stream
// event (a healthy turn that keeps producing output runs indefinitely) plus an
// absolute wall-clock backstop so a pathological tight-loop event stream can't
// keep a turn alive forever. Starts on the local ceilings; applyEngineType()
// re-resolves them (and re-arms both timers) once the turn's engine is known.
// pauseForApproval() pauses both clocks; human response time is not model work.
function createChatStreamWatchdog({
  isAborted,
  onTimeout,
  localMaxLoopWallSeconds = MANAGED_LOCAL_MAX_LOOP_WALL_SECONDS,
}) {
  let idleTimer = null;
  let absoluteTimer = null;
  let absoluteRemainingMs = 0;
  let absoluteStartedAt = 0;
  // Depth counter, not a boolean: an approval request can arrive while an
  // ask_user wait already holds the clocks, and the inner resume must not
  // restart them while the outer human wait is still pending.
  let approvalPauseDepth = 0;
  let ceilings = resolveChatStreamCeilings('', localMaxLoopWallSeconds);
  function pauseIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }
  // Stream activity must NOT end an approval pause. Notifications keep arriving
  // while a human decides -- a monitor started earlier in the turn emits, say --
  // and treating those as "the turn resumed" re-armed both clocks mid-decision,
  // so a slow approval aborted the turn on an idle timeout it never earned.
  // Only resumeAfterApproval(), handed out by pauseForApproval(), ends the pause.
  function noteActivity() {
    if (isAborted() || approvalPauseDepth > 0) {
      return;
    }
    pauseIdle();
    idleTimer = setTimeout(() => {
      onTimeout(`Managed chat stream idle for ${ceilings.idleTimeoutMs}ms with no activity.`);
    }, ceilings.idleTimeoutMs);
    if (typeof idleTimer.unref === 'function') {
      idleTimer.unref();
    }
  }
  function armAbsolute({ reset = true } = {}) {
    if (absoluteTimer) {
      clearTimeout(absoluteTimer);
    }
    if (reset || absoluteRemainingMs <= 0) {
      absoluteRemainingMs = ceilings.absoluteTimeoutMs;
    }
    absoluteStartedAt = Date.now();
    absoluteTimer = setTimeout(() => {
      onTimeout(`Managed chat stream exceeded absolute cap of ${ceilings.absoluteTimeoutMs}ms.`);
    }, absoluteRemainingMs);
    if (typeof absoluteTimer.unref === 'function') {
      absoluteTimer.unref();
    }
  }
  function applyEngineType(engineType) {
    ceilings = resolveChatStreamCeilings(engineType, localMaxLoopWallSeconds);
    armAbsolute();
    noteActivity();
  }
  // Returns its own resume so the two cannot be wired up apart. Each resume is
  // idempotent, and the clocks restart only when every outstanding pause has
  // resumed (see approvalPauseDepth above).
  function pauseForApproval() {
    pauseIdle();
    if (absoluteTimer) {
      clearTimeout(absoluteTimer);
      absoluteTimer = null;
      absoluteRemainingMs = Math.max(
        absoluteRemainingMs - Math.max(Date.now() - absoluteStartedAt, 0),
        1
      );
    }
    approvalPauseDepth += 1;
    let resumed = false;
    return function resumeAfterApproval() {
      if (resumed || isAborted()) {
        return;
      }
      resumed = true;
      if (approvalPauseDepth > 0) {
        approvalPauseDepth -= 1;
      }
      if (approvalPauseDepth > 0) {
        return;
      }
      armAbsolute({ reset: false });
      noteActivity();
    };
  }
  function clear() {
    pauseIdle();
    if (absoluteTimer) {
      clearTimeout(absoluteTimer);
      absoluteTimer = null;
    }
    approvalPauseDepth = 0;
  }
  return {
    noteActivity,
    pauseIdle,
    pauseForApproval,
    armAbsolute,
    applyEngineType,
    clear,
    getCeilings: () => ceilings,
  };
}

function normalizeDebugOptions(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {
    disable_thinking: source.disableThinking === true || source.disable_thinking === true,
    lean_context: source.leanContext === true || source.lean_context === true,
    plain_chat_mode: source.plainChatMode === true || source.plain_chat_mode === true,
  };
  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function _finiteNonNegativeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function recordProviderDiagnosticPhases(service, providerDiagnostics) {
  if (!providerDiagnostics || typeof providerDiagnostics !== 'object') {
    return;
  }
  const toProviderStart = _finiteNonNegativeNumber(
    providerDiagnostics.time_to_provider_request_start_ms
  );
  if (toProviderStart != null) {
    recordServicePhasePercentile(
      service,
      'sidecar_request_sent_to_provider_request_start',
      toProviderStart
    );
  }
  const toFirstChunk = _finiteNonNegativeNumber(providerDiagnostics.time_to_first_chunk_ms);
  if (toFirstChunk != null) {
    recordServicePhasePercentile(
      service,
      'provider_request_start_to_first_chunk',
      toFirstChunk
    );
  }
  const toFirstVisibleToken = _finiteNonNegativeNumber(
    providerDiagnostics.time_to_first_visible_token_ms
  );
  if (toFirstChunk != null && toFirstVisibleToken != null) {
    recordServicePhasePercentile(
      service,
      'first_chunk_to_first_visible_token',
      Math.max(toFirstVisibleToken - toFirstChunk, 0)
    );
  }
}

function buildLeanContextPreferences() {
  return {
    history_scope: 'fresh',
    include_personality: false,
    include_memory: false,
    include_git_context: false,
    include_codebase_context: false,
    include_active_file_context: false,
  };
}

function buildAutomaticCompactionSendContext({
  contextPreferences,
  featureFlags,
  frameOutcome,
  canonicalSessionMessages,
  userMessageId,
}) {
  const messages = Array.isArray(canonicalSessionMessages) ? canonicalSessionMessages : [];
  const historyScopeFallback = frameOutcome?.historyScopeFallback || null;
  return {
    eligible: contextPreferences?.history_scope === 'session'
      && featureFlags?.context_compaction === true
      && !historyScopeFallback
      && messages.length > 0,
    boundaryMessageId: String(messages.at(-1)?.id || '').trim(),
    boundaryMessageCount: messages.length,
    boundaryFingerprint: fingerprintCompactionPrefix(messages),
    currentUserMessageId: userMessageId,
    historyScopeFallback,
  };
}

function emitManagedHistoryScopeNarrowing(service, frameOutcome, eventBase) {
  if (!frameOutcome?.historyScopeFallback) return;
  service.emit('chat-stream', {
    type: 'context_compacted',
    strategy: 'narrowed',
    phase: 'preflight',
    summaryStatus: 'not_created',
    reasonCode: 'transport_frame_limit',
    inputComplete: false,
    historyScopeFallback: frameOutcome.historyScopeFallback,
    ...eventBase,
  });
}

function buildImageAttachmentSendParams(imageAttachments) {
  const list = Array.isArray(imageAttachments) ? imageAttachments : [];
  if (!list.length) {
    return {};
  }
  return {
    attachments: list.map((entry) => ({
      id: String(entry.id || '').trim(),
      kind: 'image',
      displayName: String(entry.displayName || '').trim(),
      mimeType: String(entry.mimeType || '').trim(),
      sizeBytes: Math.max(Number(entry.sizeBytes || 0), 0),
      width: Math.max(Number(entry.width || 0), 0),
      height: Math.max(Number(entry.height || 0), 0),
      assetPath: String(entry.assetPath || '').trim(),
      sourceKind: String(entry.sourceKind || 'file').trim() || 'file',
    })),
  };
}

// Emits the per-turn preflight summary and context-assembly percentile. Its
// field set is pinned by tests/backend-service-inject.test.js.
function emitManagedTurnPerformanceSummary(service, {
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
}) {
  recordServicePhasePercentile(
    service,
    contextPreferences.include_memory === false && contextPreferences.include_git_context === false
      ? 'context_assembly_elapsed_no_memory_git'
      : 'context_assembly_elapsed_memory_git',
    Math.max(contextAssemblyCompletedAt - contextAssemblyStartedAt, 0)
  );
  service._emitServiceLog('INFO', 'chat.performance_turn_summary', {
    sessionId: resolvedSessionId,
    streamId,
    traceId: requestTraceId,
    fresh_turn: canonicalSessionMessages.length === 0,
    mode: effectiveMode,
    engineType,
    model,
    history_scope: contextPreferences.history_scope,
    include_personality: contextAssemblyBreakdown?.includedPersonality === true,
    include_memory: contextPreferences.include_memory !== false,
    include_git_context: contextPreferences.include_git_context !== false,
    message_count: preparedMessages.length,
    system_message_count: preparedMessages.filter((message) => message?.role === 'system').length,
    text_attachment_count: textAttachments.length,
    image_attachment_count: imageAttachments.length,
    tool_preferences_present: Boolean(requestToolPreferences),
    debug_options: normalizedDebugOptions || {},
    ms_pre_flight_total: Math.max(performanceSummaryEmittedAt - sessionTimingStartedAt, 0),
    ms_context_assembly_elapsed: Math.max(contextAssemblyCompletedAt - contextAssemblyStartedAt, 0),
    ms_assembly_completed_to_summary_emit: Math.max(
      performanceSummaryEmittedAt - contextAssemblyCompletedAt,
      0
    ),
  });
}

function summarizePromptMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let charCount = 0;
  for (const message of list) {
    charCount += String(message?.content || '').length;
  }
  return {
    message_count: list.length,
    char_count: charCount,
    approx_tokens: charCount > 0 ? Math.max(1, Math.ceil(charCount / 4)) : 0,
  };
}

module.exports = {
  CLOUD_ENGINE_TYPES,
  buildAutomaticCompactionSendContext,
  buildImageAttachmentSendParams,
  buildLeanContextPreferences,
  createChatStreamWatchdog,
  emitManagedHistoryScopeNarrowing,
  emitManagedTurnPerformanceSummary,
  normalizeDebugOptions,
  recordProviderDiagnosticPhases,
  resolveChatStreamCeilings,
  summarizePromptMessages,
};

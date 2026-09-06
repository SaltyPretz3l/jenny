// Shared recording-context harness for the managed chat-stream notification
// dispatcher tests (chat-stream-managed-runtime-notifications.js). Builds a ctx
// whose every collaborator is a recorder pushing { args } so oracles can assert
// both the unit's state mutations and the exact calls it made.

const { createTextSequenceGate } = require('../../services/backend/chat-stream-managed-runtime-utils');

const SENTINEL_SIDECAR_ERROR = Object.freeze({ __sidecarError: true });

function makeCtx(overrides = {}) {
  const calls = {
    emitChatStream: [],
    emitThinkingStatus: [],
    noteTurnEvent: [],
    persistCurrentTextSegment: [],
    discardPersistedTextSegmentsForReset: [],
    noteDiagnosticToolEvent: [],
    settleUnfinishedToolRows: [],
    recordSidecarErrorFromParams: [],
    beginVisibleCompletionFinalization: [],
    applyAuthoritativeTerminalText: [],
    serviceLog: [],
    serviceEmit: [],
    appendText: [],
    appendReasoningEntries: [],
    noteToolStep: [],
    notePhaseStarted: [],
    notePhaseCompleted: [],
    resetSlice: [],
    recordCanonicalEvent: [],
    recordLegacyNotification: [],
    recordLatency: [],
    recordDroppedCanonicalEvent: [],
    noteEvent: [],
    discardCapturedEvents: [],
    handleToolNotification: [],
    touchActiveTurn: [],
  };

  // appendReasoningEntries returns a collector result; the dispatcher reads
  // .protocolViolation and .phase. Default = no violation, a phase echoing the
  // thinking id so reasoning turn events carry a real phase key.
  let appendReasoningResult = (entries, meta = {}) => ({
    protocolViolation: false,
    phase: {
      phase_id: meta.thinking_id || 'phase-1',
      thinking_id: meta.thinking_id || 'phase-1',
      started_at: meta.timestamp || '',
      summary: meta.summary || '',
      tokens_per_second: meta.tokens_per_second,
      render_collapsed: false,
    },
  });

  const transcriptCollector = {
    turnHasVisibleText: false,
    appendText(text, opts) {
      calls.appendText.push({ text, opts });
    },
    appendReasoningEntries(entries, meta, options) {
      calls.appendReasoningEntries.push({ entries, meta, options });
      return appendReasoningResult(entries, meta, options);
    },
    noteToolStep(step) {
      calls.noteToolStep.push({ step });
    },
    notePhaseStarted(phase) {
      calls.notePhaseStarted.push({ phase });
    },
    notePhaseCompleted(phase) {
      calls.notePhaseCompleted.push({ phase });
    },
    resetSlice() {
      calls.resetSlice.push({});
    },
  };

  const service = {
    featureFlags: {},
    _emitServiceLog(level, code, fields) {
      calls.serviceLog.push({ level, code, fields });
    },
    emit(eventName, payload) {
      calls.serviceEmit.push({ eventName, payload });
    },
  };

  // Active-turn progress adapter. getActiveTurn() returns null so the
  // dispatcher's touchProgress() always proceeds to touchActiveTurn, which we
  // record (lets oracles confirm touchProgress fired on the right methods).
  const adapter = {
    getActiveTurn() {
      return null;
    },
    touchActiveTurn(key, fields) {
      calls.touchActiveTurn.push({ key, fields });
      return { ...key, ...fields };
    },
  };

  const ctx = {
    service,
    adapter,
    streamId: 'stream-1',
    resolvedSessionId: 'session-1',
    model: 'test-model',
    assistantBaseMessageId: 'assistant-base-1',
    canonicalBridgeEnabled: true,
    transcriptCollector,

    emitChatStream(payload, options) {
      calls.emitChatStream.push({ payload, options });
    },
    emitThinkingStatus(delta, thinkingId) {
      calls.emitThinkingStatus.push({ delta, thinkingId });
    },
    noteTurnEvent(kind, event) {
      calls.noteTurnEvent.push({ kind, event });
    },
    persistCurrentTextSegment(opts) {
      calls.persistCurrentTextSegment.push({ opts });
    },
    discardPersistedTextSegmentsForReset() {
      calls.discardPersistedTextSegmentsForReset.push({});
    },
    noteDiagnosticToolEvent(payload) {
      calls.noteDiagnosticToolEvent.push({ payload });
    },
    settleUnfinishedToolRows(reason) {
      calls.settleUnfinishedToolRows.push({ reason });
    },
    recordSidecarErrorFromParams(params, opts) {
      calls.recordSidecarErrorFromParams.push({ params, opts });
      return SENTINEL_SIDECAR_ERROR;
    },
    beginVisibleCompletionFinalization() {
      calls.beginVisibleCompletionFinalization.push({});
    },
    applyAuthoritativeTerminalText(content, completionSource, authoritySource) {
      calls.applyAuthoritativeTerminalText.push({ content, completionSource, authoritySource });
      const text = String(content || '');
      if (!text.trim()) return false;
      this.assistantText = text;
      this.currentSegmentText = text;
      this.streamSawText = true;
      return true;
    },

    turnMetrics: {
      recordCanonicalEvent(params) {
        calls.recordCanonicalEvent.push({ params });
      },
      recordLegacyNotification(notification) {
        calls.recordLegacyNotification.push({ notification });
      },
      recordLatency(name, value) {
        calls.recordLatency.push({ name, value });
      },
      recordDroppedCanonicalEvent() {
        calls.recordDroppedCanonicalEvent.push({});
      },
    },

    turnEventCollector: {
      noteEvent(params, meta) {
        calls.noteEvent.push({ params, meta });
        return { captured: true };
      },
      discardCapturedEvents(streamId, kinds, options) {
        calls.discardCapturedEvents.push({ streamId, kinds, options });
      },
    },

    // Mutable accrual state read/written by the dispatcher.
    assistantText: '',
    currentSegmentText: '',
    reasoningEntries: [],
    appliedTextSequenceGate: createTextSequenceGate(),
    canonicalToolStartedCallIds: new Set(),
    eventBase: { requestId: 'stream-1' },

    lastReasoningThinkingId: '',
    reasoningTurnEventOrdinal: 0,
    lastReasoningEventPhaseKey: '',
    visibleAssistantMessageId: '',
    currentThinkingPhaseId: '',
    thinkingStatusText: '',
    legacyTextSequence: 0,

    streamSawText: false,
    streamSawBatch: false,
    hasPersistedSegments: false,
    unfinishedToolsSettled: true,
    questionBatch: null,
    currentPhaseSnapshot: null,
    sidecarProtocolError: null,
    sidecarDoneTerminalError: null,
    turnUsage: null,
    toolResultCounts: { successful: 0, failed: 0 },
    visibleCompletionPromise: null,

    // Test affordances:
    _calls: calls,
    _SENTINEL_SIDECAR_ERROR: SENTINEL_SIDECAR_ERROR,
    _setAppendReasoningResult(fn) {
      appendReasoningResult = fn;
    },
  };

  return Object.assign(ctx, overrides);
}

// A recording tool-notification handler. Default: not claimed (returns false),
// matching the dispatcher contract where the tail seam may decline.
function makeHandleToolNotification(ctx, returnValue = false) {
  return (service, toolContext, notification) => {
    ctx._calls.handleToolNotification.push({ service, toolContext, notification });
    return returnValue;
  };
}

function callsOf(ctx, name) {
  return ctx._calls[name];
}

// Build a valid canonical turn.event params envelope (v=1, turn_id, seq>=1).
function canonicalEvent(type, payload, extra = {}) {
  return {
    v: 1,
    turn_id: 'turn-1',
    seq: 1,
    type,
    payload,
    ...extra,
  };
}

module.exports = {
  SENTINEL_SIDECAR_ERROR,
  makeCtx,
  makeHandleToolNotification,
  callsOf,
  canonicalEvent,
};

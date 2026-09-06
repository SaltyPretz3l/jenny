const {
  normalizeRuntimeToken,
  normalizeRuntimeNumber,
  buildPhaseSnapshot,
  inferStreamChannel,
  phaseMatchesChannel,
  normalizeStopReason,
  createTextSequenceGate,
} = require('./chat-stream-managed-runtime-utils');
const {
  rememberPersistedUserStream,
  hasPersistedUserStream,
} = require('./chat-stream-persisted-user-registry');
const {
  handleNotification: handleNotificationImpl,
} = require('./chat-stream-managed-runtime-notifications');
const {
  persistCurrentTextSegment: persistCurrentTextSegmentImpl,
  discardPersistedTextSegmentsForReset: discardPersistedTextSegmentsForResetImpl,
} = require('./chat-stream-managed-runtime-segments');
const {
  derivePersistRefusalReason: derivePersistRefusalReasonImpl,
  emitDurabilityWarning: emitDurabilityWarningImpl,
} = require('./chat-stream-managed-runtime-durability');
const {
  buildInteractiveQuestionBatchVisibleText,
  hasValidInteractiveQuestionCount,
} = require('./interactive-session-utils');
const {
  isDeniedTerminalStatus,
  resolveTerminalRouting,
} = require('./chat-stream-terminal-utils');
const { settleDeniedTerminal } = require('./chat-stream-managed-runtime-denial');
const {
  logAndBuildActiveTurnClaimRefusedError,
  logAndBuildUserMessagePersistRefusedError,
} = require('./chat-stream-managed-runtime-admission-claim');
const {
  createManagedSessionLifecycleAdapter,
  startActiveTurn,
  clearActiveTurn,
  persistUserTurn,
  settleAssistantCompletion,
  settleQuestionBatch,
} = require('./chat-stream-session-lifecycle');
const { TranscriptPhaseCollector } = require('./chat-transcript-phase-collector');
const {
  INTERACTIVE_ERROR_CODES,
  STREAM_ERROR_CODES,
} = require('./error-codes');
const { normalizePendingQuestionBatch } = require('./message-normalization');
const {
  clearInteractiveStateOnFailure: clearInteractiveStateOnFailureImpl,
  shouldPersistFailureMessage: shouldPersistFailureMessageImpl,
  persistFailureMessage: persistFailureMessageImpl,
  clearReconnectStateOnFailure: clearReconnectStateOnFailureImpl,
  getErrorState: getErrorStateImpl,
  noteDiagnosticToolEvent: noteDiagnosticToolEventImpl,
  settleUnfinishedToolRows: settleUnfinishedToolRowsImpl,
} = require('./chat-stream-managed-runtime-failure');
const { CanonicalTurnMetrics } = require('./canonical-turn-metrics');
const {
  settleManagedAssistantCompletion,
  settleManagedFailureTerminal,
  settleManagedQuestionBatch,
  supportsManagedTerminalCoordinator,
} = require('./chat-stream-managed-terminal-settlement');
const {
  applyAuthoritativeTerminalText: applyAuthoritativeTerminalTextImpl,
  emitDeterministicCompletion: emitDeterministicCompletionImpl,
  logThinkingOnlyCompletion: logThinkingOnlyCompletionImpl,
  recoverToolworkOnlyCompletion: recoverToolworkOnlyCompletionImpl,
} = require('./chat-stream-managed-runtime-completion');

function createManagedChatStreamRuntime({
  service,
  resolvedSessionId,
  streamId,
  traceId = '',
  normalizedPreferences,
  normalizedInteractiveResponse,
  normalizedAttachments,
  transcriptPrompt,
  userMessageId,
  skillInvocation = null,
  reuseExistingUserMessage = false,
  failureRetry,
  exchangeTitle = '',
  onVisibleCompletion = null,
  turnEventCollector = null,
  turnMetrics = null,
  canonicalBridge = false,
  turnLease = null,
}) {
  turnMetrics = turnMetrics && typeof turnMetrics.recordCanonicalEvent === 'function'
    ? turnMetrics
    : new CanonicalTurnMetrics();
  const adapter = createManagedSessionLifecycleAdapter(service, resolvedSessionId, turnLease);
  const transcriptCollector = new TranscriptPhaseCollector({ streamId });
  let model = '';
  let eventBase = {
    streamId,
    sessionId: resolvedSessionId,
    model,
    requestId: streamId,
    traceId: String(traceId || '').trim() || streamId,
    trace_id: String(traceId || '').trim() || streamId,
  };
  let assistantText = '';
  let refusedTextSegments = [];
  let currentSegmentText = '';
  let textSegmentIndex = 0;
  let hasPersistedSegments = false;
  let reasoningEntries = [];
  // A persisted segment boundary must end the current reasoning entry: later
  // deltas start a fresh entry instead of coalescing into an entry an earlier
  // persisted segment already carries (the cross-segment entry-dup defect).
  let reasoningTailBreakPending = false;
  // Raw (unsanitized) accumulation of the current tail entry's deltas so
  // coalescing can rejoin at the true chunk boundary — sanitization trims the
  // trailing edge, which used to destroy every chunk-final newline.
  let reasoningRawTailText = '';
  let thinkingStatusText = '';
  let currentThinkingPhaseId = '';
  let lastReasoningThinkingId = '';
  let questionBatch = null;
  let sidecarError = '';
  let sidecarErrorCode = '';
  let sidecarErrorRetryable = true;
  let sidecarErrorCategory = 'managed_sidecar';
  let sidecarTerminalSubcode = '';
  let sidecarErrorType = '';
  let sidecarErrorMessage = '';
  let sidecarProtocolError = null;
  let sidecarDoneTerminalError = null;
  let streamSawText = false;
  let streamSawDone = false;
  let automaticCompactionContext = null;
  let terminalTextAuthoritySource = '';
  let streamSawBatch = false;
  let turnUsage = null;
  let resumableStop = null;
  const toolResultCounts = { successful: 0, failed: 0 };
  let visibleCompletionEmitted = false;
  let visibleCompletionPromise = null;
  let userMessagePersisted = false;
  // CTL-002 durable settlement: refused persists are tracked so the turn can
  // surface ONE bounded durability warning after visible completion instead of
  // silently painting success over a write the store rejected.
  let userMessagePersistRefused = false;
  let segmentPersistRefused = false;
  let terminalPersistRefused = false;
  let durabilityWarningEmitted = false;
  // SP-20: a denial must reach the renderer as one terminal (see settleTerminalResult).
  let deniedTerminalHandled = false;
  let latestToolContext = null;
  let unfinishedToolsSettled = false;
  const diagnosticToolEvents = [];
  const diagnosticToolNamesByCallId = new Map();
  const assistantBaseMessageId = `assistant_${streamId}`;
  let visibleAssistantMessageId = assistantBaseMessageId;
  let persistedTextSegmentIds = [];
  let reasoningTurnEventOrdinal = 0;
  let lastReasoningEventPhaseKey = '';
  let streamEventSequence = 1;
  let currentPhaseSnapshot = null;
  const channelSequences = new Map();
  const canonicalBridgeEnabled = canonicalBridge === true;
  const appliedTextSequenceGate = createTextSequenceGate();
  const canonicalToolStartedCallIds = new Set();
  // Synthetic sequence counter for legacy chat.token dedup when canonical bridge
  // is active. Must start at 0 (first token gets 1) to match the sidecar's
  // 1-based sequence on canonical text_delta events.
  let legacyTextSequence = 0;

  function nextStreamSequence(explicit) {
    const candidate = normalizeRuntimeNumber(explicit);
    const expected = Number(streamEventSequence || 1);
    if (candidate != null && candidate >= expected) {
      streamEventSequence = candidate + 1;
      return candidate;
    }
    streamEventSequence = expected + 1;
    return expected;
  }

  function nextChannelSequence(channel) {
    const next = Number(channelSequences.get(channel) || 1);
    channelSequences.set(channel, next + 1);
    return next;
  }

  function fallbackPhaseForChannel(channel) {
    if (channel === 'reasoning') {
      return buildPhaseSnapshot({
        phase_id: lastReasoningThinkingId || currentThinkingPhaseId || '',
        phase_kind: 'reasoning',
        iteration: 0,
      });
    }
    if (channel === 'response') {
      return buildPhaseSnapshot({
        phase_id: '',
        phase_kind: 'text',
        iteration: 0,
      });
    }
    return null;
  }

  function emitChatStream(payload, options = {}) {
    const commitStartedAt = Date.now();
    const channel = normalizeRuntimeToken(options.channel) || inferStreamChannel(payload);
    const explicitPhase = Object.prototype.hasOwnProperty.call(options, 'phase')
      ? options.phase
      : undefined;
    const currentPhaseForChannel = phaseMatchesChannel(currentPhaseSnapshot, channel)
      ? currentPhaseSnapshot
      : null;
    const phase = explicitPhase === null
      ? null
      : buildPhaseSnapshot(explicitPhase || payload.phase || payload)
        || currentPhaseForChannel
        || fallbackPhaseForChannel(channel);
    const sequence = nextStreamSequence(options.sequence ?? payload.sequence);
    const channelSequence = nextChannelSequence(channel);
    service.emit('chat-stream', {
      ...payload,
      sequence,
      sequenceEnd: sequence,
      channel,
      channelSequence,
      channelSequenceEnd: channelSequence,
      phase,
      emittedAtMs: Date.now(),
    });
    if (turnMetrics && typeof turnMetrics.recordLatency === 'function') {
      // recordLatency remains O(1), while snapshot construction and sorting are
      // deferred until turn settlement.
      turnMetrics.recordLatency(
        'electron_ingest_to_renderer_commit_ms',
        Math.max(Date.now() - commitStartedAt, 0)
      );
    }
  }

  function noteTurnEvent(kind, options = {}) {
    if (!turnEventCollector || typeof turnEventCollector.noteEvent !== 'function') {
      return null;
    }
    return turnEventCollector.noteEvent({
      turn_id: streamId,
      kind,
      ...options,
    });
  }

  function publishCanonicalMetricsSnapshot() {
    if (service && typeof service === 'object' && typeof turnMetrics?.snapshot === 'function') {
      service._lastCanonicalTurnMetrics = turnMetrics.snapshot();
    }
  }

  function recordSidecarErrorFromParams(params, defaults = {}) {
    const stopReason = normalizeStopReason(defaults.stopReason || params.stop_reason || '');
    const message = String(
      params.message
      || params.error_message
      || defaults.message
      || (stopReason ? `Chat stream ended with stop_reason ${stopReason}.` : 'Chat failed.')
    );
    sidecarError = message;
    sidecarErrorCode = String(params.error_code || params.code || defaults.errorCode || '').trim();
    sidecarErrorRetryable = params.retryable !== false && defaults.retryable !== false;
    sidecarErrorCategory = String(params.category || defaults.category || 'chat').trim() || 'chat';
    sidecarTerminalSubcode = String(
      params.terminal_subcode
      || defaults.terminalSubcode
      || stopReason
      || ''
    ).trim().toLowerCase();
    sidecarErrorType = String(params.error_type || defaults.errorType || '').trim();
    sidecarErrorMessage = String(params.error_message || message || '').trim();
    return {
      status: stopReason || String(defaults.status || 'runtime_error').trim() || 'runtime_error',
      terminalSubcode: sidecarTerminalSubcode,
      message,
    };
  }

  function createTerminalResultError(status, terminalSubcode, message, errorCode = sidecarErrorCode) {
    const normalizedStatus = String(status || '').trim().toLowerCase() || 'runtime_error';
    const normalizedSubcode = String(terminalSubcode || '').trim().toLowerCase();
    const defaultMessage = normalizedStatus === 'timeout' && normalizedSubcode === 'turn'
      ? 'Jenny reached the local turn working-time limit before it finished.'
      : `Turn settled with terminal status ${normalizedStatus}.`;
    const error = new Error(
      String(message || '').trim() || defaultMessage
    );
    error.category = sidecarErrorCategory || 'chat';
    error.status = normalizedStatus;
    if (errorCode) {
      error.error_code = errorCode;
      error.code = errorCode;
    }
    if (normalizedSubcode) {
      error.terminal_subcode = normalizedSubcode;
    }
    error.retryable = sidecarErrorRetryable !== false;
    return error;
  }

  function setModel(nextModel) {
    model = String(nextModel || '').trim();
    eventBase = {
      streamId,
      sessionId: resolvedSessionId,
      model,
      requestId: streamId,
      traceId: String(traceId || '').trim() || streamId,
      trace_id: String(traceId || '').trim() || streamId,
    };
  }

  function getEventBase() {
    return { ...eventBase };
  }

  function recordNoVisibleCompletionError() {
    const message = 'Model returned no visible assistant text. The model may have only produced reasoning without a response.';
    sidecarError = sidecarError || message;
    if (reasoningEntries.length && !sidecarErrorCode) {
      sidecarErrorCode = STREAM_ERROR_CODES.REASONING_ONLY;
      sidecarErrorRetryable = false;
      sidecarErrorCategory = 'managed_sidecar';
      sidecarErrorType = 'reasoning_only_completion';
      sidecarErrorMessage = message;
    }
    return message;
  }

  function emitThinkingStatus(text, thinkingId) {
    const nextText = String(text || '').trim();
    if (thinkingStatusText === nextText) {
      return;
    }
    thinkingStatusText = nextText;
    emitChatStream({
      type: 'thinking_status',
      text: nextText,
      thinkingId: String(thinkingId || ''),
      ...eventBase,
    }, { channel: 'control' });
  }

  function persistUserMessage() {
    if (userMessagePersisted) {
      return false;
    }
    if (hasPersistedUserStream(service, streamId)) {
      userMessagePersisted = true;
      service._emitServiceLog('WARN', 'chat.user_message_persist_reentered', {
        sessionId: resolvedSessionId,
        streamId,
        userMessageId,
      });
      return false;
    }
    const identity = turnLease?.identity || {};
    const claimedActiveTurn = turnLease
      ? adapter.getActiveTurn()
      : startActiveTurn(adapter, {
          requestId: streamId,
          streamId,
          traceId: eventBase.traceId,
          userMessageId,
          turnId: identity.turnId || streamId,
          sessionIncarnation: identity.sessionIncarnation || '',
          generation: identity.generation,
        });
    if (
      !claimedActiveTurn
      || (turnLease && (
        claimedActiveTurn.request_id !== identity.turnId
        || claimedActiveTurn.stream_id !== identity.streamId
      ))
    ) {
      throw logAndBuildActiveTurnClaimRefusedError(service, {
        sessionId: resolvedSessionId,
        streamId,
        userMessageId,
      });
    }
    const userTurnFields = {
      messageId: userMessageId,
      content: transcriptPrompt,
      attachments: normalizedAttachments,
      skill_invocation: skillInvocation,
      model,
    };
    const persistEditedTurn = () => service.sessionStore.truncateAfterMessage(
      resolvedSessionId,
      userMessageId,
      {
            replaceMessageContent: transcriptPrompt,
            replaceMessageAttachments: normalizedAttachments,
            replaceMessageSkillInvocation: skillInvocation,
            preserveActiveTurn: true,
            ...(failureRetry === true ? { preserveSupersededTurn: true } : {}),
      }
    );
    const persistedUserSummary = reuseExistingUserMessage
      ? (turnLease && typeof service.sessionTurnActors?.guard === 'function'
          ? service.sessionTurnActors.guard(
              turnLease,
              'managed.edit_and_regenerate',
              persistEditedTurn
            )
          : persistEditedTurn())
      : persistUserTurn(adapter, userTurnFields);
    if (!persistedUserSummary) {
      // SP-19: a refused user-message persist must also fail the start (see
      // chat-stream-managed-runtime-admission-claim.js).
      userMessagePersistRefused = true;
      throw logAndBuildUserMessagePersistRefusedError(service, {
        sessionId: resolvedSessionId,
        streamId,
        userMessageId,
        reason: derivePersistRefusalReason(),
      });
    }
    rememberPersistedUserStream(service, streamId);
    userMessagePersisted = true;
    return true;
  }

  // Best-effort diagnosis of WHY the store refused a write, per the CTL-002
  // Durability accounting lives in the extracted seam (file-size cap split);
  // the wrappers keep the closure-local call sites unchanged.
  function derivePersistRefusalReason() {
    return derivePersistRefusalReasonImpl(ctx);
  }

  function emitDurabilityWarning(warning) {
    return emitDurabilityWarningImpl(ctx, warning);
  }

  // Segment persistence lives in the extracted seam (file-size cap split);
  // the wrappers keep the closure-local call sites unchanged. `ctx` is
  // declared below but initialized before any stream notification can call in.
  function persistCurrentTextSegment(options) {
    return persistCurrentTextSegmentImpl(ctx, options);
  }

  function discardPersistedTextSegmentsForReset() {
    return discardPersistedTextSegmentsForResetImpl(ctx);
  }

  async function finalizeVisibleCompletion() {
    if (visibleCompletionEmitted) {
      return true;
    }
    if (!String(assistantText || '').trim()) {
      // Successful managed-sidecar tool work gets visible fallback text;
      // no-tool and failed-only empty completions remain fail-closed.
      if (!toolResultCounts.successful) {
        if (reasoningEntries.length) {
          logThinkingOnlyCompletionImpl(ctx);
        }
        recordNoVisibleCompletionError();
        return false;
      }
      recoverToolworkOnlyCompletionImpl(ctx);
      service._emitServiceLog('WARN', 'chat.toolwork_only_completion', {
        sessionId: resolvedSessionId,
        streamId,
        model,
        completedToolResultCount: toolResultCounts.successful,
        failedToolResultCount: toolResultCounts.failed,
        reasoningEntryCount: reasoningEntries.length,
        fallback: 'visible_message',
      });
    }

    if (supportsManagedTerminalCoordinator(ctx)) {
      const settled = await settleManagedAssistantCompletion(ctx);
      return settled.handled;
    }

    const assistantTimestamp = new Date().toISOString();
    transcriptCollector.completeCurrentPhase({}, assistantTimestamp);

    if (!hasPersistedSegments) {
      visibleAssistantMessageId = assistantBaseMessageId;
    }

    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('DEBUG', 'chat.stream_emit_complete_event', {
        sessionId: resolvedSessionId,
        streamId,
        model,
      });
    }

    emitThinkingStatus('');
    visibleCompletionEmitted = true;
    emitChatStream({
      type: 'complete',
      content: assistantText,
      ...(turnUsage ? { usage: turnUsage } : {}),
      ...(resumableStop ? { resumableStop } : {}),
      ...eventBase,
    }, { channel: 'control', phase: null });

    if (typeof onVisibleCompletion === 'function') {
      onVisibleCompletion({
        sessionId: resolvedSessionId,
        messageId: visibleAssistantMessageId,
        content: assistantText,
        model,
        usage: turnUsage,
      });
    }

    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('DEBUG', 'chat.stream_start_settle_assistant_completion', {
        sessionId: resolvedSessionId,
        streamId,
        model,
      });
    }

    const settleOutcome = await settleAssistantCompletion(adapter, {
      messageId: assistantBaseMessageId,
      content: assistantText,
      reasoningEntries,
      parentStreamId: streamId,
      phases: transcriptCollector.slice.phases,
      visibleSegments: transcriptCollector.slice.visibleSegments,
      toolSteps: transcriptCollector.slice.toolSteps,
      model,
      requestId: streamId,
      streamId,
      normalizedPreferences,
      normalizedInteractiveResponse,
      exchangeTitle,
      timestamp: assistantTimestamp,
      // Settle callback contract (CTL-002): falsy = the store REFUSED the
      // persist; intentional no-persists return a truthy sentinel instead.
      persistAssistantMessage: () => {
        if (hasPersistedSegments) {
          // The final slice flushes through the segment path; null from it is
          // a real refusal, undefined is a no-op (nothing left to persist —
          // every segment already landed at a tool boundary).
          const segmentSummary = persistCurrentTextSegment({ resumableStop });
          transcriptCollector.resetSlice();
          // Audit A3: a refusal of ANY segment this turn — a prior mid-stream
          // flush or this final slice — leaves the reply partially
          // non-durable. Report refusal so settleAssistantCompletion retains
          // active_turn / interactive prefs / title for recovery instead of
          // clearing them on the strength of the surviving segments.
          if (segmentSummary === null || segmentPersistRefused) {
            return null;
          }
          return { persisted: 'segments' };
        }
        if (!String(assistantText || '').trim()) {
          // Tool-work-only completion: don't persist an empty final assistant
          // bubble — the tool rows already carry the turn's substance.
          return { persisted: 'tool_rows_only' };
        }
        visibleAssistantMessageId = assistantBaseMessageId;
        return adapter.appendMessage(
          {
            id: assistantBaseMessageId,
            role: 'assistant',
            content: assistantText,
            timestamp: assistantTimestamp,
            finalizedAt: assistantTimestamp,
            client_message_id: assistantBaseMessageId,
            model_used: model,
            ...(resumableStop ? { resumable_stop: resumableStop } : {}),
            ...transcriptCollector.buildAssistantMessageFields({
              fallbackReasoningEntries: reasoningEntries,
            }),
          },
          { model }
        );
      },
    });

    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('DEBUG', 'chat.stream_end_settle_assistant_completion', {
        sessionId: resolvedSessionId,
        streamId,
        model,
      });
    }

    // Durable-terminal accounting: the settle outcome is the single source of
    // truth for the assistant side. Every real segment loss reaches it — the
    // settle callback returns null when any segment this turn was refused —
    // while a refusal the turn RECOVERED from (full-append retry after a
    // refused-only boundary segment: assistantText still carries the whole
    // reply) settles ok:true and must not cry wolf with a warning about a
    // reply that is fully durable.
    const assistantRefused = settleOutcome?.ok === false;
    terminalPersistRefused = assistantRefused;
    if (assistantRefused || userMessagePersistRefused) {
      emitDurabilityWarning({
        scope: assistantRefused
          ? (userMessagePersistRefused ? 'turn' : 'assistant')
          : 'user',
        reason: derivePersistRefusalReason(),
      });
    }
    // A refused interactive-round recap is an auxiliary row (the reply itself
    // is durable), so it gets the structured WARN, not the durability toast.
    if (
      settleOutcome?.ok === true
      && settleOutcome.recapPersisted === false
      && typeof service._emitServiceLog === 'function'
    ) {
      service._emitServiceLog('WARN', 'chat.round_recap_persist_refused', {
        sessionId: resolvedSessionId,
        streamId,
      });
    }

    transcriptCollector.resetSlice();

    return true;
  }

  function beginVisibleCompletionFinalization() {
    if (visibleCompletionPromise) {
      return visibleCompletionPromise;
    }
    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('DEBUG', 'chat.stream_begin_visible_completion_finalization', {
        sessionId: resolvedSessionId,
        streamId,
        model,
      });
    }
    visibleCompletionPromise = finalizeVisibleCompletion().catch((error) => {
      if (!sidecarProtocolError) {
        sidecarProtocolError = error;
      }
      service._emitServiceLog('ERROR', 'chat.visible_completion_failed', {
        sessionId: resolvedSessionId,
        streamId,
        model,
        message: error?.message || String(error),
      });
      if (visibleCompletionEmitted) {
        // The user already saw an unqualified success; a settle that THREW
        // after paint leaves the reply non-durable exactly like a refusal.
        terminalPersistRefused = true;
        emitDurabilityWarning({ scope: 'assistant', reason: 'write_failed' });
      }
      emitThinkingStatus('');
      return false;
    });
    return visibleCompletionPromise;
  }

  async function settleTerminalResult(result) {
    settleUnfinishedToolRows('terminal_result');
    if (visibleCompletionPromise) {
      await visibleCompletionPromise;
    }
    if (sidecarProtocolError) {
      throw sidecarProtocolError;
    }
    if (sidecarDoneTerminalError) {
      throw createTerminalResultError(
        sidecarDoneTerminalError.status,
        sidecarDoneTerminalError.terminalSubcode,
        sidecarDoneTerminalError.message
      );
    }
    const terminal = resolveTerminalRouting({
      status: result.status,
      terminalSubcode: result.terminal_subcode,
      visibleCompletionEmitted,
    });
    const toolObservations = Array.isArray(result.tool_observations)
      ? result.tool_observations : [];
    const terminalCause = [...toolObservations].reverse().find(
      (observation) => String(observation?.error_code || '').trim()
    );
    const terminalErrorCode = sidecarErrorCode
      || String(result.error_code || terminalCause?.error_code || '').trim();
    if (terminal.logOnlyLateFailure) {
      return {
        status: terminal.status,
        terminalSubcode: terminal.terminalSubcode,
        lateFailure: true,
      };
    }
    if (terminal.completed) {
      applyAuthoritativeTerminalTextImpl(
        ctx,
        result.response_text,
        result.completion_source,
        'rpc_result'
      );
      if (visibleCompletionEmitted) {
        return { status: terminal.status, coordinated: ctx.terminalCoordinatorHandled };
      }
      const finalized = await beginVisibleCompletionFinalization();
      if (sidecarProtocolError) {
        throw sidecarProtocolError;
      }
      if (!finalized) {
        throw new Error(recordNoVisibleCompletionError());
      }
      return { status: terminal.status, coordinated: ctx.terminalCoordinatorHandled };
    }
    if (terminal.denialSilent || isDeniedTerminalStatus(result.status)) {
      // SP-20: denial reaches the renderer as one terminal (see
      // chat-stream-managed-runtime-denial.js); the once-per-turn guard lives here.
      emitThinkingStatus('');
      if (!deniedTerminalHandled) {
        deniedTerminalHandled = true;
        if (supportsManagedTerminalCoordinator(ctx)) {
          await settleManagedFailureTerminal(ctx, {
            message: sidecarError || 'The request was denied.',
            ...(terminalErrorCode ? { error_code: terminalErrorCode } : {}),
            category: 'denied',
            status: 'denied',
            retryable: false,
          }, terminal);
          return { status: terminal.status, coordinated: ctx.terminalCoordinatorHandled };
        }
        settleDeniedTerminal({
          clearActiveTurn,
          adapter,
          streamId,
          sidecarError,
          sidecarErrorCode: terminalErrorCode,
          emitChatStream,
          eventBase,
        });
      }
      return { status: terminal.status, coordinated: ctx.terminalCoordinatorHandled };
    }
    if (terminal.settleQuestionBatch) {
      const normalizedBatch = normalizePendingQuestionBatch(questionBatch);
      if (!normalizedBatch || !hasValidInteractiveQuestionCount(normalizedBatch)) {
        throw createTerminalResultError(
          terminal.status,
          terminal.terminalSubcode,
          sidecarError || `${INTERACTIVE_ERROR_CODES.INVALID_BATCH_PAYLOAD} Interactive protocol error: invalid question batch payload.`
        );
      }
      if (supportsManagedTerminalCoordinator(ctx) && !ctx.visibleCompletionEmitted) {
        const settled = await settleManagedQuestionBatch(ctx, normalizedBatch);
        questionBatch = settled.questionBatch;
        return { status: terminal.status, questionBatch, coordinated: settled.handled === true };
      }
      questionBatch = !visibleCompletionEmitted && turnLease
        && typeof service.sessionTurnActors?.attachContinuationToken === 'function'
        ? service.sessionTurnActors.attachContinuationToken(turnLease, normalizedBatch)
        : normalizedBatch;
      const questionBatchAdapter = visibleCompletionEmitted ? createManagedSessionLifecycleAdapter(service, resolvedSessionId) : adapter;
      await settleQuestionBatch(questionBatchAdapter, {
        messageId: `question_batch_${streamId}`,
        content: buildInteractiveQuestionBatchVisibleText(questionBatch),
        questionBatch,
        model,
        requestId: streamId,
        streamId,
        normalizedPreferences,
        exchangeTitle,
      });
      return { status: terminal.status, questionBatch };
    }
    throw createTerminalResultError(
      terminal.status,
      terminal.terminalSubcode,
      sidecarError || (
        String(result.status || '').trim().toLowerCase() === 'awaiting_approval'
          ? 'The turn stopped while another tool approval was pending.'
          : ''
      ),
      terminalErrorCode
    );
  }

  // Turn-failure/interruption settlement lives in the extracted seam
  // (file-size cap split); the wrappers keep the closure-local call sites
  // unchanged. `ctx` is declared below but initialized before any stream
  // notification can call in.
  function clearInteractiveStateOnFailure() {
    return clearInteractiveStateOnFailureImpl(ctx);
  }

  function shouldPersistFailureMessage() {
    return shouldPersistFailureMessageImpl(ctx);
  }

  function persistFailureMessage(errorPayload) {
    return persistFailureMessageImpl(ctx, errorPayload);
  }

  function clearReconnectStateOnFailure() {
    return clearReconnectStateOnFailureImpl(ctx);
  }

  function getErrorState() {
    return getErrorStateImpl(ctx);
  }

  function noteDiagnosticToolEvent(args) {
    return noteDiagnosticToolEventImpl(ctx, args);
  }

  function settleUnfinishedToolRows(reason) {
    return settleUnfinishedToolRowsImpl(ctx, reason);
  }

  // Extracted handlers share these closure bindings through accessors, so moved and
  // factory-kept functions mutate the SAME closure bindings by reference.
  const ctx = {
    service,
    adapter,
    streamId,
    resolvedSessionId,
    transcriptCollector,
    turnMetrics,
    turnEventCollector,
    assistantBaseMessageId,
    turnLease,
    onVisibleCompletion,
    exchangeTitle,
    unfinishedToolRepairs: [],
    unfinishedToolRepairFailure: '',
    terminalCoordinatorHandled: false,
    canonicalBridgeEnabled,
    emitChatStream,
    emitThinkingStatus,
    noteTurnEvent,
    publishCanonicalMetricsSnapshot,
    recordSidecarErrorFromParams,
    persistCurrentTextSegment,
    discardPersistedTextSegmentsForReset,
    noteDiagnosticToolEvent,
    settleUnfinishedToolRows,
    beginVisibleCompletionFinalization,
    applyAuthoritativeTerminalText(content, completionSource, authoritySource) {
      return applyAuthoritativeTerminalTextImpl(
        ctx, content, completionSource, authoritySource
      );
    },
    get model() { return model; },
    set model(v) { model = v; },
    get eventBase() { return eventBase; },
    set eventBase(v) { eventBase = v; },
    get assistantText() { return assistantText; },
    set assistantText(v) { assistantText = v; },
    get refusedTextSegments() { return refusedTextSegments; },
    set refusedTextSegments(v) { refusedTextSegments = v; },
    get currentSegmentText() { return currentSegmentText; },
    set currentSegmentText(v) { currentSegmentText = v; },
    get textSegmentIndex() { return textSegmentIndex; },
    set textSegmentIndex(v) { textSegmentIndex = v; },
    get persistedTextSegmentIds() { return persistedTextSegmentIds; },
    set persistedTextSegmentIds(v) { persistedTextSegmentIds = v; },
    get reasoningEntries() { return reasoningEntries; },
    set reasoningEntries(v) { reasoningEntries = v; },
    get reasoningTailBreakPending() { return reasoningTailBreakPending; },
    set reasoningTailBreakPending(v) { reasoningTailBreakPending = v; },
    get reasoningRawTailText() { return reasoningRawTailText; },
    set reasoningRawTailText(v) { reasoningRawTailText = v; },
    get thinkingStatusText() { return thinkingStatusText; },
    set thinkingStatusText(v) { thinkingStatusText = v; },
    get currentThinkingPhaseId() { return currentThinkingPhaseId; },
    set currentThinkingPhaseId(v) { currentThinkingPhaseId = v; },
    get lastReasoningThinkingId() { return lastReasoningThinkingId; },
    set lastReasoningThinkingId(v) { lastReasoningThinkingId = v; },
    get questionBatch() { return questionBatch; },
    set questionBatch(v) { questionBatch = v; },
    get sidecarProtocolError() { return sidecarProtocolError; },
    set sidecarProtocolError(v) { sidecarProtocolError = v; },
    get sidecarDoneTerminalError() { return sidecarDoneTerminalError; },
    set sidecarDoneTerminalError(v) { sidecarDoneTerminalError = v; },
    get streamSawText() { return streamSawText; },
    set streamSawText(v) { streamSawText = v; },
    get streamSawDone() { return streamSawDone; },
    set streamSawDone(v) { streamSawDone = v; },
    get automaticCompactionContext() { return automaticCompactionContext; },
    set automaticCompactionContext(v) { automaticCompactionContext = v; },
    get terminalTextAuthoritySource() { return terminalTextAuthoritySource; },
    set terminalTextAuthoritySource(v) { terminalTextAuthoritySource = v; },
    get streamSawBatch() { return streamSawBatch; },
    set streamSawBatch(v) { streamSawBatch = v; },
    get turnUsage() { return turnUsage; },
    set turnUsage(v) { turnUsage = v; },
    get resumableStop() { return resumableStop; },
    set resumableStop(v) { resumableStop = v; },
    toolResultCounts,
    get visibleCompletionPromise() { return visibleCompletionPromise; },
    set visibleCompletionPromise(v) { visibleCompletionPromise = v; },
    get latestToolContext() { return latestToolContext; },
    set latestToolContext(v) { latestToolContext = v; },
    get unfinishedToolsSettled() { return unfinishedToolsSettled; },
    set unfinishedToolsSettled(v) { unfinishedToolsSettled = v; },
    get visibleAssistantMessageId() { return visibleAssistantMessageId; },
    set visibleAssistantMessageId(v) { visibleAssistantMessageId = v; },
    get reasoningTurnEventOrdinal() { return reasoningTurnEventOrdinal; },
    set reasoningTurnEventOrdinal(v) { reasoningTurnEventOrdinal = v; },
    get lastReasoningEventPhaseKey() { return lastReasoningEventPhaseKey; },
    set lastReasoningEventPhaseKey(v) { lastReasoningEventPhaseKey = v; },
    get currentPhaseSnapshot() { return currentPhaseSnapshot; },
    set currentPhaseSnapshot(v) { currentPhaseSnapshot = v; },
    get hasPersistedSegments() { return hasPersistedSegments; },
    set hasPersistedSegments(v) { hasPersistedSegments = v; },
    get segmentPersistRefused() { return segmentPersistRefused; },
    set segmentPersistRefused(v) { segmentPersistRefused = v; },
    get durabilityWarningEmitted() { return durabilityWarningEmitted; },
    set durabilityWarningEmitted(v) { durabilityWarningEmitted = v; },
    get legacyTextSequence() { return legacyTextSequence; },
    set legacyTextSequence(v) { legacyTextSequence = v; },
    get appliedTextSequenceGate() { return appliedTextSequenceGate; },
    get canonicalToolStartedCallIds() { return canonicalToolStartedCallIds; },
    get normalizedInteractiveResponse() { return normalizedInteractiveResponse; },
    get normalizedPreferences() { return normalizedPreferences; },
    get visibleCompletionEmitted() { return visibleCompletionEmitted; },
    set visibleCompletionEmitted(v) { visibleCompletionEmitted = v; },
    set terminalPersistRefused(v) { terminalPersistRefused = v; },
    get userMessagePersisted() { return userMessagePersisted; },
    get sidecarError() { return sidecarError; },
    get sidecarErrorCode() { return sidecarErrorCode; },
    get reasoningOnlyErrorCode() { return STREAM_ERROR_CODES.REASONING_ONLY; },
    get sidecarErrorRetryable() { return sidecarErrorRetryable; },
    get sidecarErrorCategory() { return sidecarErrorCategory; },
    get sidecarTerminalSubcode() { return sidecarTerminalSubcode; },
    get sidecarErrorType() { return sidecarErrorType; },
    get sidecarErrorMessage() { return sidecarErrorMessage; },
    get diagnosticToolEvents() { return diagnosticToolEvents; },
    get diagnosticToolNamesByCallId() { return diagnosticToolNamesByCallId; },
  };

  return {
    adapter,
    setModel,
    setAutomaticCompactionContext(value) { automaticCompactionContext = value; },
    getEventBase,
    persistUserMessage,
    emitThinkingStatus,
    handleNotification(notification, deps) {
      return handleNotificationImpl(ctx, notification, deps);
    },
    emitDeterministicCompletion: (content) => emitDeterministicCompletionImpl(ctx, content),
    settleTerminalResult,
    emitQuestionBatchEvent(batch) {
      emitThinkingStatus('');
      emitChatStream({
        type: 'question_batch',
        batch: normalizePendingQuestionBatch(batch),
        ...eventBase,
      }, { channel: 'control', phase: null });
    },
    clearInteractiveStateOnFailure,
    shouldPersistFailureMessage,
    persistFailureMessage,
    settleFailureTerminal(errorPayload, terminal) {
      return supportsManagedTerminalCoordinator(ctx)
        ? settleManagedFailureTerminal(ctx, errorPayload, terminal)
        : Promise.resolve({ handled: false, result: null });
    },
    clearReconnectStateOnFailure,
    getErrorState,
    getDiagnosticToolEvents() {
      return diagnosticToolEvents.map((entry) => ({ ...entry }));
    },
    isVisibleCompletionEmitted() {
      return visibleCompletionEmitted;
    },
    isTerminalCoordinatorHandled() {
      return ctx.terminalCoordinatorHandled;
    },
    shouldPreserveActiveTurnOnRelease() {
      return terminalPersistRefused;
    },
  };
}

module.exports = {
  createManagedChatStreamRuntime,
};

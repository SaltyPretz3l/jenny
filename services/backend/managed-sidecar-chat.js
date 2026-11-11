const {
  buildRecallQuery,
  inferEngineTypeFromModel,
} = require('./backend-service-utils');
const { resolveSessionLockdownRequest } = require('./session-lockdown-gate');
const { inspectContextPreferences } = require('./context-preferences');
const { resolveSessionTranscriptAnswer } = require('./session-transcript-queries');
const { applySessionTitleAtSend, prepareManagedSession } = require('./managed-sidecar-session-preflight');
const { validateImageAttachmentsForManagedSend } = require('./managed-sidecar-attachments');
const { waitForToolApproval } = require('./chat-stream-tool-handling');
const {
  createManagedChatStreamRuntime,
} = require('./chat-stream-managed-runtime');
const { fetchTurnProviderDiagnostics } = require('./turn-diagnostic-dump');
const { normalizePhaseClientTiming } = require('./phase-percentiles-aggregator');
const {
  CANCEL_REASON_SESSION_DELETE,
  CANCEL_REASON_TIMEOUT, CANCEL_REASON_USER,
  createCancellationError,
  TERMINAL_STATUS_COMPLETED,
} = require('./chat-stream-terminal-utils');
const {
  assembleContextForChat,
} = require('./chat-stream-context-assembly');
const { CanonicalTurnEventCollector } = require('./canonical-turn-event-collector');
const {
  finishManagedRuntimeCompletion,
  reportManagedContinuationAttention,
} = require('./managed-sidecar-terminal-cleanup');
const { settleHostedExecution } = require('./hosted-execution-settlement');
const {
  noteToolObservationPromotions,
} = require('./tool-observation-promotion');
const { releaseImageBridgeExecutions } = require('./electron-tool-bridge');
const {
  admitTurnContextRows, managedToolPreferenceInput, wireContextKinds,
  buildLeanContextPreferences,
  captureManagedExecutionAuthority,
  createChatStreamWatchdog,
  deriveManagedTurnHistory,
  normalizeDebugOptions,
  recordProviderDiagnosticPhases,
  summarizePromptMessages,
} = require('./managed-sidecar-chat-helpers');
const { resolveConfiguredLocalMaxLoopWallSeconds } = require('./chat-stream-admission');
const { APPLICATION_TURN_HANDOFF_PREPARATION } = require('./session-handoff-context'); const { APPLICATION_TURN_DIGEST } = require('./application-turns');
const { acknowledgeInterruptedTurnReceipts } = require('./interrupted-turn-receipts');
const { buildManagedStartResult, retainManagedRuntimeController } = require('./chat-lifecycle-contracts');
const { ensureSessionTurnActorRegistry } = require('./session-turn-actor');
const { admitReportReservation } = require('./session-report-admission');
const { isProposeRunMode } = require('./propose-mode');
const { prepareManagedCheckpointHistory } = require('./managed-sidecar-continuation');
// The turn's stages beyond orchestration: request shaping/sending, the failure
// path and the telemetry around them.
const {
  buildManagedChatSendParams, ensureManagedEnginesReadyForChat, sendManagedChatTurnRequest,
} = require('./managed-sidecar-chat-request');
const { settleManagedTurnFailure } = require('./managed-sidecar-chat-failure');
const {
  createManagedTurnTiming, dumpTurnDiagnosticSafely, emitManagedTurnPreSendTelemetry,
  noteManagedContextAssemblyCompleted, noteManagedContextAssemblyStarted,
} = require('./managed-sidecar-chat-telemetry');
async function startManagedSidecarChatStream(service, {
  sessionId,
  prompt,
  visiblePrompt,
  traceId,
  attachments,
  runtimePreferredModel, runtimePreferredEngineType,
  normalizedInteractiveResponse,
  normalizedPreferences,
  activeFileContext,
  mentionContents,
  toolPreferences,
  approvalMode,
  debugOptions,
  clientTiming,
  skillInvocation, imagePromptPin, author = null,
  editedMessageId,
  failureRetry,
  turnLease = null,
  runtimeExecutionAuthority = null, runtimeOperationGateway = null,
  runtimeRoute = null, runtimeAssertCurrent = null, runtimeOnInferenceSettlement = null,
  runtimeContinuation = null, runtimeAdmission = null, safetyPolicy = null,
  sessionHandoffPreparation = null, sessionHandoff = null, applicationTurn = '',
}) {
  const {
    exchangeTitle, existingSession, imageAttachments, normalizedAttachments,
    requestedSessionId, resolvedSessionId, sessionStartDate, textAttachments, transcriptPrompt,
  } = prepareManagedSession(service, {
    sessionId, prompt, visiblePrompt, attachments, normalizedInteractiveResponse, normalizedPreferences,
  });
  const normalizedDebugOptions = normalizeDebugOptions(debugOptions);
  const normalizedClientTiming = normalizePhaseClientTiming(clientTiming);
  if (service.commandSandbox?.transition) throw new Error('Command sandbox configuration is changing; retry the message.');
  const actorRegistry = ensureSessionTurnActorRegistry(service);
  const activeTurnLease = turnLease || actorRegistry.reserveStart({
    sessionId: resolvedSessionId,
    store: service.sessionStore,
    activeStreams: service.activeStreams,
    interactiveResponse: normalizedInteractiveResponse,
    editedMessageId,
    prompt: transcriptPrompt,
    path: 'managed',
    traceId,
  });
  const streamId = activeTurnLease.identity.streamId;
  const turnId = activeTurnLease.identity.turnId;
  const requestId = streamId;
  const runtimeBudgetRequired = Boolean(runtimeOperationGateway?.inference?.budget);
  const userMessageId = activeTurnLease.identity.userMessageId;
  const requestTraceId = String(traceId || '').trim() || streamId;
  const controller = new AbortController();
  controller.traceId = requestTraceId;
  if (!actorRegistry.attachController(activeTurnLease, controller)) {
    throw createCancellationError(CANCEL_REASON_SESSION_DELETE, 'Session deleted before the stream could start.');
  }
  await applySessionTitleAtSend(service, resolvedSessionId, exchangeTitle);
  let runtimeCompletion = { status: 'failed', producerSettled: false, canonicalSettled: false };
  // attachController publishes the actor-owned admission bracket in activeStreams.
  const pendingRun = (async () => {
    await new Promise((resolve) => setImmediate(resolve));
    let model = '';
    // The watchdog's timeout error and the terminal bookkeeping the finally block
    // reads; settleManagedTurnFailure writes it in place.
    const turnState = {
      streamTimeoutError: null, restartReason: '', terminalStatus: 'cancelled', terminalSettledAt: undefined,
    };
    let deferredQuestionBatchEvent = null;
    let executionAuthority = null;
    let continuationPausePending = false;
    let providerDiagnosticsPromise;
    const turnDiagnosticState = {
      engineType: null,
      effectiveMode: null,
      promptContributions: null,
      contextAssemblyBreakdown: null,
    };
    // CTL-001 anchor reuse: a validated edit-resend anchor re-uses the EDITED
    // durable user message; anything else falls back to a fresh user row.
    const editedAnchorMessageId = activeTurnLease.editedMessageId || '';
    const canonicalBridgeEnabled = service.featureFlags?.canonical_bridge === true
      && service.featureFlags?.canonical_turn_events === true;
    const turnEventCollector = new CanonicalTurnEventCollector({
      store: service.sessionStore,
      turnId,
      attemptId: streamId,
      sessionId: resolvedSessionId,
      journal: service.turnEventJournal,
      canonicalPrimary: canonicalBridgeEnabled,
      featureFlags: service.featureFlags || null,
      logger: typeof service._emitServiceLog === 'function'
        ? (level, event, details) => service._emitServiceLog(level, event, details)
        : null,
    });
    const promotionLogger = typeof service._emitServiceLog === 'function'
      ? service._emitServiceLog.bind(service)
      : null;
    const promotionLogContext = {
      sessionId: resolvedSessionId,
      streamId,
      traceId: requestTraceId,
    };
    function noteToolObservationPayload(observations) {
      noteToolObservationPromotions({
        turnEventCollector,
        observations,
        requestId,
        turnId,
        logger: promotionLogger,
        logContext: promotionLogContext,
      });
    }
    const runtime = createManagedChatStreamRuntime({
      service,
      resolvedSessionId,
      streamId,
      traceId: requestTraceId,
      normalizedPreferences,
      normalizedInteractiveResponse,
      normalizedAttachments,
      transcriptPrompt,
      userMessageId, skillInvocation, imagePromptPin, author, applicationTurn: sessionHandoffPreparation ? APPLICATION_TURN_HANDOFF_PREPARATION : applicationTurn,
      reuseExistingUserMessage: Boolean(editedAnchorMessageId), failureRetry,
      turnLease: activeTurnLease, runtimeAdmission,
      getSuspendedDecision: () => controller._runtimeDecisionControl?.suspendedDecision(),
      exchangeTitle, isUserStop: () => controller.signal.reason?.cancel_reason === CANCEL_REASON_USER,
      turnEventCollector, canonicalBridge: canonicalBridgeEnabled,
      onVisibleCompletion: () => {
        streamWatchdog.clear();
      },
    });
    if (runtimeAdmission) service.emit('chat-stream', { type: 'started', ...runtime.getEventBase() });
    const seenToolCalls = new Set();
    const toolSummaries = new Map();
    function ensureNotAborted() {
      if (controller.signal.aborted) {
        throw turnState.streamTimeoutError || new Error('Stream cancelled.');
      }
    }
    const { timingMarkers, logTiming, recordTiming, recordTimingMarker } = createManagedTurnTiming(service, {
      sessionId: resolvedSessionId, streamId, traceId: requestTraceId, clientTiming: normalizedClientTiming,
    });
    function fetchAndRecordProviderDiagnosticPhases() {
      providerDiagnosticsPromise ||= fetchTurnProviderDiagnostics({
        service,
        requestId,
      }).then((providerDiagnostics) => {
        recordProviderDiagnosticPhases(service, providerDiagnostics);
        return providerDiagnostics;
      });
      return providerDiagnosticsPromise;
    }
    function abortStreamForTimeout(message) {
      if (controller.signal.aborted) {
        return;
      }
      turnState.streamTimeoutError = createCancellationError(CANCEL_REASON_TIMEOUT, message);
      controller.abort(turnState.streamTimeoutError);
    }
    // Idle watchdog + absolute backstop, engine-keyed; starts on local
    // ceilings until the turn's engine is known (applyEngineType below).
    const streamWatchdog = createChatStreamWatchdog({
      isAborted: () => controller.signal.aborted,
      onTimeout: abortStreamForTimeout,
      localMaxLoopWallSeconds: resolveConfiguredLocalMaxLoopWallSeconds(service),
    });
    streamWatchdog.armAbsolute();
    // Arm the idle watchdog for the initial request leg.
    streamWatchdog.noteActivity();

    try {
      ensureNotAborted();

      const sessionTimingStartedAt = Date.now();
      recordTimingMarker('session_timing_started');
      if (requestedSessionId) {
        await Promise.resolve(service.setSessionPreferences(resolvedSessionId, {
          ...normalizedPreferences,
          ...(existingSession?.session_start_date ? {} : { session_start_date: sessionStartDate }),
        }));
      }
      recordTiming('chat.session_id_allocated', sessionTimingStartedAt, 'session_id_allocated', {
        createdSession: requestedSessionId ? false : true,
      });

      ensureNotAborted();
      const userMessagePersistedStartedAt = Date.now();
      const userRowPersisted = runtime.persistUserMessage();
      if (userRowPersisted) {
        service.sessionAttachmentAuthority?.noteCanonicalAttachmentsPersisted(resolvedSessionId);
        recordTiming('chat.user_message_persisted', userMessagePersistedStartedAt, 'user_message_persisted', {
          attachmentCount: normalizedAttachments.length,
        });
      }

      // No session message/title mutation occurs before their final use below, so one
      // normalized snapshot safely serves every post-persist history consumer.
      const sessionSummary = service.sessionStore.getSession(resolvedSessionId);
      const sessionMessages = [...(sessionSummary?.messages || [])];
      const checkpointHistory = prepareManagedCheckpointHistory(service, runtimeContinuation);
      let canonicalSessionMessages = checkpointHistory?.canonicalHistoryMessages || sessionMessages
        .filter((message) => String(message?.id || '').trim() !== userMessageId);
      const transcriptQueryMessages = canonicalSessionMessages;
      const transcriptAnswer = !checkpointHistory && resolveSessionTranscriptAnswer({
        prompt: transcriptPrompt,
        messages: transcriptQueryMessages,
      });
      if (transcriptAnswer) {
        if (!runtimeAdmission) service.emit('chat-stream', {
          type: 'started',
          deterministic: true,
          ...runtime.getEventBase(),
        });
        await runtime.emitDeterministicCompletion(transcriptAnswer);
        recordTimingMarker('deterministic_transcript_answer_completed');
        turnState.terminalSettledAt = Date.now();
        turnState.terminalStatus = TERMINAL_STATUS_COMPLETED;
        service._emitServiceLog('INFO', 'chat.deterministic_transcript_answer_completed', {
          sessionId: resolvedSessionId,
          streamId,
          traceId: requestTraceId,
        });
        dumpTurnDiagnosticSafely({
          service,
          sessionId: resolvedSessionId,
          streamId,
          requestId: streamId,
          traceId: requestTraceId,
          terminalStatus: TERMINAL_STATUS_COMPLETED,
          timingMarkers,
          contextContributions: null,
          contextAssemblyBreakdown: null,
          toolEvents: runtime.getDiagnosticToolEvents(),
          compactions: runtime.getDiagnosticCompactions?.(),
          terminalError: null,
          engineType: null,
          model: null,
          mode: 'deterministic_transcript',
          counts: null,
          clientTiming: normalizedClientTiming,
        });
        return;
      }

      // A linked child's report slot (cp5b, fail-closed) for every new turn identity, never a checkpoint resume or a
      // handoff preparation turn; before the model loads, so a load failure still reports `failed` (2026-10-27).
      admitReportReservation(service, { sessionId: resolvedSessionId, turnId, lease: activeTurnLease,
        handoffPreparation: sessionHandoffPreparation, resumed: Boolean(checkpointHistory) });

      ensureNotAborted();
      const requestedModel = String(runtimePreferredModel || normalizedPreferences.preferred_model || '').trim();
      const requestedEngine = String(runtimePreferredEngineType || '').trim().toLowerCase();
      const lockdownRequest = resolveSessionLockdownRequest(service, sessionSummary,
        { requestedEngine, requestedModel }, managedToolPreferenceInput(toolPreferences, { service, sessionId: resolvedSessionId,
          session: sessionSummary, catalog: service.currentStatus?.tools_status, handoffPreparation: sessionHandoffPreparation, applicationTurn }));
      const requestToolPreferences = lockdownRequest.toolPreferences;
      const modelTimingStartedAt = Date.now();
      runtimeAssertCurrent?.();
      // streamId: this turn is already in activeStreams (attachController, above), so the engine-switch guard must not count it as somebody else's live response.
      model = await service._resolveModel(requestedModel, requestedEngine, streamId);
      lockdownRequest.assertResolvedEngine(); // catalog hints / engine pins can switch engines during resolution
      runtime.setModel(model);
      recordTiming('chat.model_resolved', modelTimingStartedAt, 'model_resolved', {
        model,
      });
      ensureNotAborted();
      // A local GGUF tag is indistinguishable from an Ollama tag by name alone, so ask the running engine.
      const engineType = requestedEngine || String(service?.currentEngineType || '').trim().toLowerCase() || inferEngineTypeFromModel(model);
      if (runtimeRoute && (engineType !== runtimeRoute.engine_type
        || String(service.currentEngineType || '').trim().toLowerCase() !== runtimeRoute.engine_type)) {
        throw Object.assign(new Error('The captured provider is no longer selected for this turn.'), {
          code: 'runtime_provider_retargeted', retryable: false,
        });
      }
      runtimeAssertCurrent?.();
      require('../execution/execution-settlement').assertExecutionPolicy(service, engineType);
      turnDiagnosticState.engineType = engineType;
      const effectiveMode = 'assist';
      turnDiagnosticState.effectiveMode = effectiveMode;
      executionAuthority = runtimeExecutionAuthority || captureManagedExecutionAuthority(service, resolvedSessionId, {
        requestId, signal: controller.signal,
        mode: normalizedPreferences.plan_mode === true ? 'plan' : effectiveMode,
        toolPreferences: requestToolPreferences, handoffPreparation: sessionHandoffPreparation,
        readOnly: isProposeRunMode(sessionSummary) || applicationTurn === APPLICATION_TURN_DIGEST, // row 86 digests: read-only
        approvalMode: isProposeRunMode(sessionSummary) ? 'prompt' : approvalMode,
      });
      // Cloud engines get wider stream ceilings (mirrors the sidecar's cloud loop profile); re-arm both timers now that the engine is known.
      streamWatchdog.applyEngineType(engineType);
      const {
        normalized: storedContextPreferences,
        warnings: contextPreferenceWarnings,
      } = inspectContextPreferences(sessionSummary?.context_preferences);
      if (contextPreferenceWarnings.length) {
        service._emitServiceLog('WARN', 'context.preferences_normalized', {
          sessionId: resolvedSessionId,
          warnings: contextPreferenceWarnings,
        });
      }
      const contextPreferences = normalizedDebugOptions?.lean_context
        ? buildLeanContextPreferences()
        : storedContextPreferences;
      if (checkpointHistory) contextPreferences.history_scope = checkpointHistory.historySelector.history_scope;

      const turnHistoryInput = {
        sessionId: resolvedSessionId, userMessageId, sessionSummary, checkpointHistory, prompt, textAttachments, skillInvocation,
        imagePromptPin, contextPreferences,
      };
      let wireKinds = wireContextKinds(service.sidecarClient);
      let { compactedHistory, preparedHistoryMessages, preparedMessages } = deriveManagedTurnHistory(service, {
        ...turnHistoryInput, sessionMessages, wireKinds,
      });
      const promptContributions = {
        base_history: summarizePromptMessages(preparedMessages.slice(0, -1)),
        current_user_prompt: summarizePromptMessages(preparedMessages.slice(-1)),
      };
      const recallQuery = buildRecallQuery(canonicalSessionMessages, transcriptPrompt);
      const recentUserTurns = canonicalSessionMessages
        .filter((message) => message?.role === 'user' && !String(message?.kind || '').trim())
        .slice(-2)
        .map((message) => message.content);

      turnDiagnosticState.promptContributions = promptContributions;
      // Server before sidecar: a sidecar initialized against a dead endpoint
      // falls back and throws, so the restart below would never be reached.
      await ensureManagedEnginesReadyForChat(service, {
        engineType, sessionId: resolvedSessionId, streamId, traceId: requestTraceId,
      });

      // The first turn's handoff row (fail-closed) joins only a brand-new model turn; queued mail also joins a failure
      // retry, whose failed attempt may have died before admission (a model load). A resume or edit reuses its rows.
      const contextAdmission = admitTurnContextRows(service, {
        sessionHandoff, brandNew: userRowPersisted && !checkpointHistory && !editedAnchorMessageId && !failureRetry,
        mailRetry: userRowPersisted && !checkpointHistory && failureRetry === true,
        sessionId: resolvedSessionId, turnId, userMessageId, preparedMessages, lease: activeTurnLease, previousKinds: wireKinds,
      });
      if (contextAdmission.rebuild) {
        wireKinds = contextAdmission.kinds;
        ({
          canonicalSessionMessages, compactedHistory, preparedHistoryMessages, preparedMessages,
        } = deriveManagedTurnHistory(service, {
          ...turnHistoryInput,
          sessionMessages: [...(service.sessionStore.getSession(resolvedSessionId)?.messages || [])],
          wireKinds,
        }));
      }

      const contextAssemblyStartedAt = noteManagedContextAssemblyStarted(service, {
        recordTimingMarker, clientTiming: normalizedClientTiming,
        sessionId: resolvedSessionId, streamId, engineType, model, contextPreferences,
      });
      const {
        memoryPolicy,
        promptContributions: assembledPromptContributions,
        contextAssemblyBreakdown,
        contextBlocks,
      } = await assembleContextForChat(service, {
        resolvedSessionId,
        streamId,
        model,
        engineType,
        contextPreferences,
        sessionSummary,
        sessionMessages: canonicalSessionMessages,
        prompt: transcriptPrompt,
        recentUserTurns,
        preparedMessages,
        recallQuery,
        logTiming,
        activeFileContext,
        mentionContents,
        executionAuthority,
      });
      Object.assign(promptContributions, assembledPromptContributions || {});
      turnDiagnosticState.promptContributions = promptContributions;
      turnDiagnosticState.contextAssemblyBreakdown = contextAssemblyBreakdown || null;
      const contextAssemblyCompletedAt = noteManagedContextAssemblyCompleted(service, {
        recordTimingMarker, sessionId: resolvedSessionId, streamId, engineType, model,
        contextAssemblyStartedAt, contextAssemblyBreakdown, contextPreferences, memoryPolicy,
      });

      if (!runtimeAdmission) service.emit('chat-stream', {
        type: 'started',
        ...runtime.getEventBase(),
      });

      const toolContext = {
        seenToolCalls,
        toolSummaries,
        workspaceRoot: service.sessionExecutionAuthority.requireCurrent(executionAuthority).root_path || '',
        executionAuthority,
        model,
        resolvedSessionId,
        streamId,
        adapter: runtime.adapter,
        turnEventCollector,
        get eventBase() {
          return runtime.getEventBase();
        },
      };
      const requestApprovalMode = !isProposeRunMode(sessionSummary) && String(approvalMode || '').trim() === 'auto_run' ? 'auto_run' : 'prompt';
      if (requestToolPreferences) {
        service._emitServiceLog('INFO', 'chat.tool_preferences_applied', {
          sessionId: resolvedSessionId,
          streamId,
          enabledTools: requestToolPreferences.enabled_tools,
          disabledTools: requestToolPreferences.disabled_tools,
        });
      }

      const sidecarRequestStartedAt = emitManagedTurnPreSendTelemetry(service, {
        recordTimingMarker, resolvedSessionId, streamId, requestTraceId, canonicalSessionMessages,
        effectiveMode, engineType, model, contextPreferences, contextAssemblyBreakdown, preparedMessages,
        textAttachments, imageAttachments, requestToolPreferences, normalizedDebugOptions,
        sessionTimingStartedAt, contextAssemblyStartedAt, contextAssemblyCompletedAt, promptContributions,
      });
      const chatSendParams = buildManagedChatSendParams(service, {
        resolvedSessionId, requestId, turnId, requestTraceId, promotionLogger, lockdownRequest,
        sessionSummary, sessionMessages, normalizedPreferences, toolContext, safetyPolicy, activeTurnLease,
        sessionStartDate, effectiveMode, normalizedInteractiveResponse, preparedMessages, canonicalSessionMessages,
        exchangeTitle, requestedModel, requestedEngine, imageAttachments, memoryPolicy, contextBlocks,
        requestToolPreferences, sessionHandoffPreparation, requestApprovalMode, engineType, normalizedDebugOptions,
        skillInvocation, executionAuthority,
      });
      const { result, boundedChatSendParams, continuationBoundary } = await sendManagedChatTurnRequest(service, {
        controller, runtime, runtimeContinuation, runtimeOperationGateway, runtimeBudgetRequired,
        runtimeAssertCurrent, runtimeOnInferenceSettlement, turnEventCollector, chatSendParams,
        executionAuthority, checkpointHistory, canonicalSessionMessages, compactedHistory, preparedHistoryMessages,
        contextPreferences, sessionSummary, prompt, textAttachments, skillInvocation, imagePromptPin, wireKinds,
        resolvedSessionId, streamId, requestId, requestTraceId, userMessageId, toolContext, normalizedPreferences,
        streamWatchdog, activeTurnLease, engineType,
      });
      recordTiming('chat.sidecar_request_settled', sidecarRequestStartedAt, 'sidecar_request_settled', {
        status: String(result?.status || ''),
      });

      if (controller.signal.aborted) {
        throw turnState.streamTimeoutError || new Error('Stream cancelled.');
      }
      if (result?.status === 'paused') {
        continuationPausePending = true;
        if (!continuationBoundary) throw new Error('runtime_continuation_pause_unexpected');
        runtimeCompletion = continuationBoundary.settlePause(result, { actorRegistry, lease: activeTurnLease, pendingToolApprovals: service.pendingToolApprovals,
          pendingUserQuestions: service.pendingUserQuestions });
        return;
      }
      noteToolObservationPayload(result?.tool_observations);
      await settleHostedExecution(service, streamId);
      const settledTerminal = await require('../execution/execution-settlement').settleManagedTerminal(service, streamId, runtime, result);
      acknowledgeInterruptedTurnReceipts({ journal: service.turnEventJournal, store: service.sessionStore, result,
        sessionId: resolvedSessionId, receipts: boundedChatSendParams.interrupted_turn_receipts, logger: promotionLogger });
      deferredQuestionBatchEvent = settledTerminal?.coordinated
        ? null : (settledTerminal?.questionBatch || null);
      if (deferredQuestionBatchEvent && runtime.isTerminalCoordinatorHandled()) {
        runtime.emitQuestionBatchEvent(deferredQuestionBatchEvent);
        deferredQuestionBatchEvent = null;
      }
      turnState.terminalStatus = String(settledTerminal?.status || '').trim()
        || TERMINAL_STATUS_COMPLETED;
      turnState.terminalSettledAt = Date.now();
      recordTimingMarker('terminal_settled');
      const providerDiagnostics = await fetchAndRecordProviderDiagnosticPhases();
      // Record the actual non-throwing terminal status, including denial.
      dumpTurnDiagnosticSafely({
        service,
        sessionId: resolvedSessionId,
        streamId,
        requestId: streamId,
        traceId: requestTraceId,
        terminalStatus: String(settledTerminal?.status || '').trim() || TERMINAL_STATUS_COMPLETED,
        timingMarkers,
        contextContributions: turnDiagnosticState.promptContributions,
        contextAssemblyBreakdown: turnDiagnosticState.contextAssemblyBreakdown,
        toolEvents: runtime.getDiagnosticToolEvents(),
        compactions: runtime.getDiagnosticCompactions?.(),
        terminalError: null,
        engineType: turnDiagnosticState.engineType,
        model,
        mode: turnDiagnosticState.effectiveMode,
        counts: null,
        clientTiming: normalizedClientTiming,
        providerDiagnostics,
      });
    } catch (error) {
      if (continuationPausePending) {
        reportManagedContinuationAttention(service, runtime, error, { traceId: requestTraceId, timingMarkers, turnDiagnosticState, model, clientTiming: normalizedClientTiming });
        return;
      }
      await settleManagedTurnFailure(service, {
        error, turnState, controller, runtime, streamWatchdog, model,
        resolvedSessionId, streamId, requestTraceId,
        timingMarkers, recordTimingMarker, turnDiagnosticState, normalizedClientTiming,
        fetchAndRecordProviderDiagnosticPhases, noteToolObservationPayload,
      });
    } finally {
      streamWatchdog.clear();
      releaseImageBridgeExecutions(service, streamId);
      if (!runtimeExecutionAuthority) service.sessionExecutionAuthority?.close?.(executionAuthority);
      if (!continuationPausePending) runtimeCompletion = await finishManagedRuntimeCompletion({
        service, runtime, actorRegistry, lease: activeTurnLease, turnEventCollector,
        sessionId: resolvedSessionId, streamId,
        terminalStatus: turnState.terminalStatus,
        deferredQuestionBatchEvent, runtimeOperationGateway, terminalSettledAt: turnState.terminalSettledAt,
        managedSidecarRestartReason: turnState.restartReason, requestTraceId,
      });
    }
  })();
  controller._pendingPromise = pendingRun;
  controller._runtimeCompletion = pendingRun.then(() => runtimeCompletion, () => runtimeCompletion);

  return retainManagedRuntimeController(buildManagedStartResult(service, {
    sessionId: resolvedSessionId, streamId, identity: activeTurnLease.identity,
  }), controller);
}

module.exports = {
  waitForToolApproval,
  validateImageAttachmentsForManagedSend,
  startManagedSidecarChatStream,
};

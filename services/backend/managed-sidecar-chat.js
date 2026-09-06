const {
  buildRecallQuery,
  normalizeManagedToolPreferences,
  inferEngineTypeFromModel,
  promptHasExplicitResponseStyleInstruction,
} = require('./backend-service-utils');
const { resolveSessionLockdownRequest } = require('./session-lockdown-gate');
const { inspectContextPreferences } = require('./context-preferences');
const { buildPreparedMessages } = require('./chat-stream-reasoning');
const { resolveSessionTranscriptAnswer } = require('./session-transcript-queries');
const {
  isImageAttachment,
  isTextAttachment,
} = require('../attachment-service');
const {
  validateImageAttachmentsForManagedSend,
} = require('./managed-sidecar-attachments');
const {
  buildAutomaticSessionTitleCandidate,
  shouldApplyAutomaticSessionTitle,
} = require('./interactive-session-utils');
const {
  createSessionId,
  getLocalISODate,
  localIsoDateFromTimestamp,
} = require('./electron-session-store');
const {
  buildResumePayload,
} = require('../session-recovery-service');
const { API_VERSION } = require('./sidecar-client');
const { normalizeReasoningEffort } = require('../../reasoning-effort-profiles');
const {
  waitForToolApproval,
  handleToolNotification,
} = require('./chat-stream-tool-handling');
const {
  createManagedChatStreamRuntime,
} = require('./chat-stream-managed-runtime');
const {
  dumpTurnDiagnostic,
  fetchTurnProviderDiagnostics,
} = require('./turn-diagnostic-dump');
const {
  normalizePhaseClientTiming,
  recordServicePhasePercentile,
} = require('./phase-percentiles-aggregator');
const {
  CANCEL_REASON_SESSION_DELETE,
  CANCEL_REASON_TIMEOUT,
  buildTerminalErrorPayload,
  createCancellationError,
  enrichTerminalErrorPayloadForEmit,
  isExpectedLifecycleCancellation,
  resolveTerminalRouting,
  TERMINAL_STATUS_COMPLETED,
  streamErrorDetailsFromAbortSignal,
} = require('./chat-stream-terminal-utils');
const {
  assembleContextForChat,
} = require('./chat-stream-context-assembly');
const {
  ensureManagedEngineNotFallbackForChat,
  ensureManagedLlamaServerReadyForChat,
  ensureManagedOllamaReadyForChat,
  ensureManagedSidecarReadyForChat,
  scheduleManagedSidecarReconnectAfterFailure,
} = require('./managed-sidecar-chat-reconnect');
const { CanonicalTurnEventCollector } = require('./canonical-turn-event-collector');
const {
  dumpFailedTurnDiagnostic,
} = require('./managed-sidecar-chat-turn-seams');
const { finalizeManagedTerminalCleanup } = require('./managed-sidecar-terminal-cleanup');
const {
  noteToolObservationPromotions,
} = require('./tool-observation-promotion');
const {
  buildManagedSidecarChatSendOptions,
} = require('./electron-tool-bridge');
const {
  createTurnEffectProbe,
  sendManagedChatWithProviderAuthRetry,
} = require('./provider-auth-turn-retry');
const {
  fitChatSendParamsToFrameBudgetWithOutcome,
  projectCanonicalSessionMessagesForSend,
} = require('./chat-send-frame-budget');
const {
  buildImageAttachmentSendParams,
  buildAutomaticCompactionSendContext,
  buildLeanContextPreferences,
  createChatStreamWatchdog,
  emitManagedHistoryScopeNarrowing,
  emitManagedTurnPerformanceSummary,
  normalizeDebugOptions,
  recordProviderDiagnosticPhases,
  summarizePromptMessages,
} = require('./managed-sidecar-chat-helpers');
const { resolveConfiguredLocalMaxLoopWallSeconds } = require('./chat-stream-admission');
const {
  applyCompactionSnapshotForChatSend,
} = require('./session-compaction-snapshot');
const { computeInterruptedTurnReceipts } = require('./interrupted-turn-receipts');
const { buildManagedStartResult } = require('./chat-lifecycle-contracts');
const { ensureSessionTurnActorRegistry } = require('./session-turn-actor');
const {
  getManagedPluginRuntime,
  sendWithPluginRuntimeReconciliation,
} = require('./managed-plugin-runtime');
const { buildApprovedPlanSendFields } = require('./approved-plan-context');
const { activeUseRequestFields } = require('../workspace-active-use-tracker');

// Idle watchdog + absolute backstop are engine-keyed (cloud engines get wider
// ceilings than local ones) — see resolveChatStreamCeilings in
// managed-sidecar-chat-helpers.js for the values and rationale.
const CHAT_STREAM_REQUEST_SETTLE_GRACE_MS = 1_000;

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
  pluginCommandInvocation, skillInvocation,
  editedMessageId,
  failureRetry,
  turnLease = null,
}) {
  const requestedSessionId = String(sessionId || '').trim();
  const resolvedSessionId = requestedSessionId || createSessionId();
  const transcriptPrompt = String(
    typeof visiblePrompt === 'string' ? visiblePrompt : prompt
  ).trim();
  const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
  const normalizedDebugOptions = normalizeDebugOptions(debugOptions);
  const normalizedClientTiming = normalizePhaseClientTiming(clientTiming);
  const imageAttachments = normalizedAttachments.filter((entry) => isImageAttachment(entry));
  const textAttachments = normalizedAttachments.filter((entry) => isTextAttachment(entry));
  const existingSession = requestedSessionId
    ? service.sessionStore.getSession(resolvedSessionId)
    : null;
  const sessionStartDate = String(
    existingSession?.session_start_date
    || localIsoDateFromTimestamp(existingSession?.created_at)
    || getLocalISODate()
  ).trim();
  const automaticTitleCandidate = buildAutomaticSessionTitleCandidate(
    transcriptPrompt,
    normalizedInteractiveResponse
  );
  const exchangeTitle =
    requestedSessionId
    && shouldApplyAutomaticSessionTitle(existingSession, automaticTitleCandidate)
      ? automaticTitleCandidate
      : '';

  if (imageAttachments.length) {
    validateImageAttachmentsForManagedSend(service, imageAttachments);
  }
  if (!requestedSessionId) {
    const createdSession = service.sessionStore.createSessionWithId(resolvedSessionId, {
      title: automaticTitleCandidate || 'New Chat',
      preferences: {
        ...normalizedPreferences,
        session_start_date: sessionStartDate,
      },
    });
    if (!createdSession) {
      throw new Error(
        'Chat could not start: a new session could not be created '
        + '(session storage rejected the write).'
      );
    }
  }
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
  const requestId = activeTurnLease.identity.turnId;
  const userMessageId = activeTurnLease.identity.userMessageId;
  const requestTraceId = String(traceId || '').trim() || streamId;
  const controller = new AbortController();
  controller.traceId = requestTraceId;
  if (!actorRegistry.attachController(activeTurnLease, controller)) {
    throw createCancellationError(CANCEL_REASON_SESSION_DELETE,
      'Session deleted before the stream could start.');
  }

  // attachController publishes the actor-owned admission bracket in activeStreams.
  const pendingRun = (async () => {
    await new Promise((resolve) => setImmediate(resolve));

    let model = '';
    let streamTimeoutError = null;
    let managedSidecarRestartReason = '';
    let deferredQuestionBatchEvent = null;
    let approvalCleanupTerminalState = 'cancelled';
    let terminalSettledAt;
    let providerDiagnosticsRecorded = false;
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
      turnId: streamId,
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
        turnId: streamId,
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
      userMessageId, skillInvocation,
      reuseExistingUserMessage: Boolean(editedAnchorMessageId),
      failureRetry,
      turnLease: activeTurnLease,
      exchangeTitle,
      turnEventCollector,
      canonicalBridge: canonicalBridgeEnabled,
      onVisibleCompletion: () => {
        streamWatchdog.clear();
      },
    });
    const seenToolCalls = new Set();
    const toolSummaries = new Map();

    function ensureNotAborted() {
      if (controller.signal.aborted) {
        throw streamTimeoutError || new Error('Stream cancelled.');
      }
    }

    const timingMarkers = [];
    timingMarkers.push({ name: 'send_initiated', ts_ms: Date.now() });
    // Emit chat.send_initiated with renderer timing deltas (if provided). The renderer captures
    // send_started_at_ms (keystroke/click time) and optimistic_rendered_at_ms; the ipc_latency_ms
    // field below is the backend's view of how long the send took to reach the managed chat entry.
    service._emitServiceLog('DEBUG', 'chat.send_initiated', {
      sessionId: resolvedSessionId,
      streamId,
      traceId: requestTraceId,
      ipc_latency_ms: Number.isFinite(Number(normalizedClientTiming?.sendStartedAtMs))
        ? Math.max(Date.now() - Number(normalizedClientTiming.sendStartedAtMs), 0)
        : null,
      local_render_latency_ms: Number.isFinite(Number(normalizedClientTiming?.localRenderLatencyMs))
        ? Number(normalizedClientTiming.localRenderLatencyMs)
        : null,
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

    async function fetchAndRecordProviderDiagnosticPhases() {
      if (providerDiagnosticsRecorded) {
        return null;
      }
      providerDiagnosticsRecorded = true;
      const providerDiagnostics = await fetchTurnProviderDiagnostics({
        service,
        requestId,
      });
      recordProviderDiagnosticPhases(service, providerDiagnostics);
      return providerDiagnostics;
    }

    function abortStreamForTimeout(message) {
      if (controller.signal.aborted) {
        return;
      }
      streamTimeoutError = createCancellationError(CANCEL_REASON_TIMEOUT, message);
      controller.abort(streamTimeoutError);
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
      if (runtime.persistUserMessage()) {
        recordTiming('chat.user_message_persisted', userMessagePersistedStartedAt, 'user_message_persisted', {
          attachmentCount: normalizedAttachments.length,
        });
      }

      // No session message/title mutation occurs before their final use below, so one
      // normalized snapshot safely serves every post-persist history consumer.
      const sessionSummary = service.sessionStore.getSession(resolvedSessionId);
      const sessionMessages = [...(sessionSummary?.messages || [])];
      const canonicalSessionMessages = sessionMessages
        .filter((message) => String(message?.id || '').trim() !== userMessageId);
      const transcriptQueryMessages = canonicalSessionMessages;
      const transcriptAnswer = resolveSessionTranscriptAnswer({
        prompt: transcriptPrompt,
        messages: transcriptQueryMessages,
      });
      if (transcriptAnswer) {
        service.emit('chat-stream', {
          type: 'started',
          deterministic: true,
          ...runtime.getEventBase(),
        });
        await runtime.emitDeterministicCompletion(transcriptAnswer);
        recordTimingMarker('deterministic_transcript_answer_completed');
        terminalSettledAt = Date.now();
        approvalCleanupTerminalState = TERMINAL_STATUS_COMPLETED;
        service._emitServiceLog('INFO', 'chat.deterministic_transcript_answer_completed', {
          sessionId: resolvedSessionId,
          streamId,
          traceId: requestTraceId,
        });
        Promise.resolve(dumpTurnDiagnostic({
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
          terminalError: null,
          engineType: null,
          model: null,
          mode: 'deterministic_transcript',
          counts: null,
          clientTiming: normalizedClientTiming,
        })).catch((dumpError) => {
          if (typeof service._emitServiceLog === 'function') {
            service._emitServiceLog('WARN', 'chat.turn_diagnostic_dump_unexpected_error', {
              sessionId: resolvedSessionId,
              streamId,
              traceId: requestTraceId,
              message: String(dumpError?.message || dumpError),
            });
          }
        });
        return;
      }

      ensureNotAborted();
      const requestedModel = String(runtimePreferredModel || normalizedPreferences.preferred_model || '').trim();
      const requestedEngine = String(runtimePreferredEngineType || '').trim().toLowerCase();
      const lockdownRequest = resolveSessionLockdownRequest(service, sessionSummary,
        { requestedEngine, requestedModel }, normalizeManagedToolPreferences(toolPreferences));
      const modelTimingStartedAt = Date.now();
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
      turnDiagnosticState.engineType = engineType;
      // Cloud engines get wider stream ceilings (mirrors the sidecar's cloud loop profile); re-arm both timers now that the engine is known.
      streamWatchdog.applyEngineType(engineType);
      // JCA-003: a valid manual-compaction snapshot replaces the summarized prefix
      // in the PROMPT history only; the canonical record stays full.
      const compactedHistory = applyCompactionSnapshotForChatSend(
        service,
        resolvedSessionId,
        canonicalSessionMessages
      );
      const resumePayload = buildResumePayload({
        ...sessionSummary,
        messages: compactedHistory.messages,
        // The actor already terminalized any orphan; never resume that generation.
        active_turn: null,
      });
      const preparedHistoryMessages = resumePayload.resumeMessage
        ? resumePayload.messages.concat(resumePayload.resumeMessage)
        : resumePayload.messages;
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

      const preparedMessages = buildPreparedMessages(preparedHistoryMessages, prompt, {
        attachments: textAttachments,
        contextPreferences,
      });
      const promptContributions = {
        base_history: summarizePromptMessages(preparedMessages.slice(0, -1)),
        current_user_prompt: summarizePromptMessages(preparedMessages.slice(-1)),
      };
      const recallQuery = buildRecallQuery(canonicalSessionMessages, transcriptPrompt);
      const promptHasExplicitStyleInstruction =
        promptHasExplicitResponseStyleInstruction(transcriptPrompt);
      const recentUserTurns = canonicalSessionMessages
        .filter((message) => message?.role === 'user' && !String(message?.kind || '').trim())
        .slice(-2)
        .map((message) => message.content);

      turnDiagnosticState.promptContributions = promptContributions;
      // Server before sidecar: a sidecar initialized against a dead endpoint
      // falls back and throws, so the restart below would never be reached.
      await ensureManagedLlamaServerReadyForChat(service, {
        engineType,
        sessionId: resolvedSessionId,
        streamId,
        traceId: requestTraceId,
      });
      await ensureManagedSidecarReadyForChat(service, {
        sessionId: resolvedSessionId,
        streamId,
        traceId: requestTraceId,
      });
      await ensureManagedOllamaReadyForChat(service, {
        engineType,
        sessionId: resolvedSessionId,
        streamId,
        traceId: requestTraceId,
      });
      await ensureManagedEngineNotFallbackForChat(service, {
        sessionId: resolvedSessionId,
        streamId,
        traceId: requestTraceId,
      });

      const contextAssemblyStartedAt = Date.now();
      recordTimingMarker('context_assembly_started');
      recordServicePhasePercentile(
        service,
        'click_to_optimistic_render',
        normalizedClientTiming.localRenderLatencyMs
      );
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
        promptHasExplicitStyleInstruction,
        preparedMessages,
        recallQuery,
        logTiming,
        activeFileContext,
        mentionContents,
      });
      Object.assign(promptContributions, assembledPromptContributions || {});
      turnDiagnosticState.promptContributions = promptContributions;
      turnDiagnosticState.contextAssemblyBreakdown = contextAssemblyBreakdown || null;
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
        memory_response_style_enabled: memoryPolicy?.include_response_style === true,
      });

      service.emit('chat-stream', {
        type: 'started',
        ...runtime.getEventBase(),
      });

      const toolContext = {
        seenToolCalls,
        toolSummaries,
        workspaceRoot: service.configService?.getToolsWorkspaceRoot?.()
          || service.configService?.getState?.()?.toolsWorkspaceRoot
          || '',
        model,
        resolvedSessionId,
        streamId,
        adapter: runtime.adapter,
        turnEventCollector,
        get eventBase() {
          return runtime.getEventBase();
        },
      };
      const requestToolPreferences = lockdownRequest.toolPreferences;
      const requestApprovalMode = String(approvalMode || '').trim() === 'auto_run' ? 'auto_run' : 'prompt';
      if (requestToolPreferences) {
        service._emitServiceLog('INFO', 'chat.tool_preferences_applied', {
          sessionId: resolvedSessionId,
          streamId,
          enabledTools: requestToolPreferences.enabled_tools,
          disabledTools: requestToolPreferences.disabled_tools,
        });
      }

      const visionUnifiedTurn = service.featureFlags?.vision_unified_turn !== false;
      const effectiveMode = normalizedDebugOptions?.plain_chat_mode === true || (!visionUnifiedTurn && imageAttachments.length) ? 'chat' : 'assist';
      turnDiagnosticState.effectiveMode = effectiveMode;
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
      // W7: attach a truthful per-tool ledger for a hard-interrupted prior turn
      // (surviving journal partition), so the model gets ground truth over its
      // own last narration. null on every clean or approval-paused turn.
      const interruptedTurnReceipts = computeInterruptedTurnReceipts({
        journal: service.turnEventJournal,
        sessionId: resolvedSessionId,
        currentTurnId: requestId,
        logger: typeof service._emitServiceLog === 'function'
          ? service._emitServiceLog.bind(service)
          : null,
      });
      const chatSendParams = {
        accept_version: API_VERSION,
        request_id: requestId,
        trace_id: requestTraceId,
        session_id: resolvedSessionId,
        session_offline_lockdown: lockdownRequest.active,
        ...activeUseRequestFields(service, toolContext.workspaceRoot),
        session_incarnation: activeTurnLease.identity.sessionIncarnation,
        generation: activeTurnLease.identity.generation,
        session_start_date: sessionStartDate,
        mode: effectiveMode,
        ...buildApprovedPlanSendFields(normalizedPreferences.plan_mode, effectiveMode,
          sessionMessages),
        interactive_response: normalizedInteractiveResponse,
        interactive_round_count: normalizedPreferences.interactive_round_count,
        messages: preparedMessages,
        canonical_session_messages: projectCanonicalSessionMessagesForSend(canonicalSessionMessages), // Wire-only: keep local full for transcript queries, recall, compaction, and telemetry.
        session_title: String(sessionSummary?.title || exchangeTitle || '').trim(),
        ...(normalizeReasoningEffort(normalizedPreferences.reasoning_effort) !== 'default'
          ? { reasoning_effort: normalizeReasoningEffort(normalizedPreferences.reasoning_effort) }
          : {}),
        ...buildImageAttachmentSendParams(imageAttachments),
        ...(interruptedTurnReceipts ? { interrupted_turn_receipts: interruptedTurnReceipts } : {}),
        memory_policy: memoryPolicy,
        ...(contextBlocks?.length ? { context_blocks: contextBlocks } : {}),
        ...(requestToolPreferences ? { tool_preferences: requestToolPreferences } : {}),
        approval_mode: requestApprovalMode,
        ...(normalizedDebugOptions ? { debug_options: normalizedDebugOptions } : {}),
        ...(pluginCommandInvocation ? { plugin_command_invocation: pluginCommandInvocation } : {}), ...(skillInvocation ? { skill_invocation: skillInvocation } : {}),
        plugin_runtime_authority: getManagedPluginRuntime(service)?.getChatAuthority?.()
          || { mode: 'core_only' },
      };
      // Frame fitting trims canonical history first, then whole history rounds.
      const frameFit = fitChatSendParamsToFrameBudgetWithOutcome(chatSendParams, {
        rebuildMessages: (historyScope) => buildPreparedMessages(preparedHistoryMessages, prompt, {
          attachments: textAttachments,
          contextPreferences: { ...contextPreferences, history_scope: historyScope },
        }),
        // The helper reports an irreducible frame at ERROR.
        log: (level, event, payload) => service._emitServiceLog(level, event, {
          sessionId: resolvedSessionId,
          streamId,
          traceId: requestTraceId,
          ...payload,
        }),
      });
      const boundedChatSendParams = frameFit.params;
      runtime.setAutomaticCompactionContext(buildAutomaticCompactionSendContext({
        contextPreferences,
        featureFlags: service.featureFlags,
        frameOutcome: frameFit.outcome,
        canonicalSessionMessages,
        userMessageId,
      }));
      emitManagedHistoryScopeNarrowing(service, frameFit.outcome, runtime.getEventBase());
      // Request-time auth retry remains legal only before any turn effect.
      const turnEffectProbe = createTurnEffectProbe();
      const chatSendOptions = (pluginRuntimeAuthority) => buildManagedSidecarChatSendOptions({
          service, controller, streamId, resolvedSessionId, requestId, requestTraceId,
          runtime, toolContext, handleToolNotification, waitForToolApproval,
          turnEventCollector, normalizedPreferences,
          noteStreamActivity: streamWatchdog.noteActivity,
          pauseStreamIdleTimer: streamWatchdog.pauseForApproval,
          onNotificationObserved: turnEffectProbe.note,
          onApprovalObserved: turnEffectProbe.noteApproval,
          pluginRuntimeAuthority,
          // Transport-level ceiling tracks the absolute cap; the idle watchdog
          // owns the "actively producing vs hung" decision so the request layer
          // never kills a healthy long stream first.
          timeoutMs: streamWatchdog.getCeilings().absoluteTimeoutMs
            + CHAT_STREAM_REQUEST_SETTLE_GRACE_MS,
      });
      const result = await sendWithPluginRuntimeReconciliation(
        service,
        (pluginRuntimeAuthority) => sendManagedChatWithProviderAuthRetry({
          service, engineType, runtime, controller, probe: turnEffectProbe,
          params: {
            ...boundedChatSendParams,
            plugin_runtime_authority: pluginRuntimeAuthority,
          },
          options: chatSendOptions(pluginRuntimeAuthority),
          log: service._emitServiceLog.bind(service),
          ids: { sessionId: resolvedSessionId, streamId, traceId: requestTraceId },
        }),
        { log: service._emitServiceLog.bind(service) }
      );
      recordTiming('chat.sidecar_request_settled', sidecarRequestStartedAt, 'sidecar_request_settled', {
        status: String(result?.status || ''),
      });

      if (controller.signal.aborted) {
        throw streamTimeoutError || new Error('Stream cancelled.');
      }
      noteToolObservationPayload(result?.tool_observations);
      const settledTerminal = await runtime.settleTerminalResult(result);
      deferredQuestionBatchEvent = settledTerminal?.coordinated
        ? null : (settledTerminal?.questionBatch || null);
      if (deferredQuestionBatchEvent && runtime.isTerminalCoordinatorHandled()) {
        runtime.emitQuestionBatchEvent(deferredQuestionBatchEvent);
        deferredQuestionBatchEvent = null;
      }
      approvalCleanupTerminalState = String(settledTerminal?.status || '').trim()
        || TERMINAL_STATUS_COMPLETED;
      terminalSettledAt = Date.now();
      recordTimingMarker('terminal_settled');
      await fetchAndRecordProviderDiagnosticPhases();
      // Record the actual non-throwing terminal status, including denial.
      Promise.resolve(dumpTurnDiagnostic({
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
        terminalError: null,
        engineType: turnDiagnosticState.engineType,
        model,
        mode: turnDiagnosticState.effectiveMode,
        counts: null,
        clientTiming: normalizedClientTiming,
      })).catch((dumpError) => {
        if (typeof service._emitServiceLog === 'function') {
          service._emitServiceLog('WARN', 'chat.turn_diagnostic_dump_unexpected_error', {
            sessionId: resolvedSessionId,
            streamId,
            traceId: requestTraceId,
            message: String(dumpError?.message || dumpError),
          });
        }
      });
    } catch (error) {
      const effectiveError = streamTimeoutError || (
        controller.signal.aborted
          ? streamErrorDetailsFromAbortSignal(controller.signal).error
          : error
      );
      // F-01 containment: the synchronous re-check-before-claim in
      // persistUserMessage() lost the admission race to a concurrent send on
      // this session. No user message was persisted and no active_turn was
      // claimed for THIS turn -- it never started one, so it is not a failed
      // turn and must not run the generic failed-turn machinery below (no
      // phantom assistant-failure row with no matching user message, no
      // sidecar restart consideration, no provider-diagnostics fetch). Reuse
      // the existing chat-stream 'error' event shape (same shape the
      // external path's session_busy rejection carries) so the renderer's
      // existing error handling surfaces the busy state with no new wiring.
      if (effectiveError && effectiveError.code === 'session_busy') {
        service._emitServiceLog('WARN', 'chat.session_busy_rejected', {
          sessionId: resolvedSessionId,
          streamId,
          traceId: requestTraceId,
        });
        service.emit('chat-stream', {
          type: 'error',
          message: String(effectiveError.message || 'a turn is already running'),
          error_code: 'session_busy',
          category: 'session_busy',
          retryable: true,
          status: 'runtime_error',
          ...runtime.getEventBase(),
        });
        return;
      }
      if (streamTimeoutError) {
        managedSidecarRestartReason = 'chat.timeout';
        service._emitServiceLog('WARN', 'chat.stream_timeout', {
          sessionId: resolvedSessionId,
          streamId,
          model,
          idleTimeoutMs: streamWatchdog.getCeilings().idleTimeoutMs,
          absoluteTimeoutMs: streamWatchdog.getCeilings().absoluteTimeoutMs,
          message: String(streamTimeoutError.message || streamTimeoutError),
        });
      }
      // Keep active_turn until persistence so crash recovery can reconcile it.
      runtime.emitThinkingStatus('');
      const {
        sidecarErrorCode,
        sidecarErrorRetryable,
        sidecarErrorCategory,
        sidecarTerminalSubcode,
        sidecarErrorType,
        sidecarErrorMessage,
      } = runtime.getErrorState();
      const normalizedErrorPayload = buildTerminalErrorPayload(
        effectiveError,
        streamTimeoutError
          ? 'timeout'
          : (controller.signal.aborted ? 'cancelled' : sidecarErrorCategory)
      );
      if (sidecarErrorCode && !normalizedErrorPayload.error_code) {
        normalizedErrorPayload.error_code = sidecarErrorCode;
      }
      if (sidecarErrorRetryable === false) {
        normalizedErrorPayload.retryable = false;
      }
      if (sidecarTerminalSubcode && !normalizedErrorPayload.terminal_subcode) {
        normalizedErrorPayload.terminal_subcode = sidecarTerminalSubcode;
      }
      if (sidecarErrorType && !normalizedErrorPayload.error_type) {
        normalizedErrorPayload.error_type = sidecarErrorType;
      }
      if (sidecarErrorMessage && !normalizedErrorPayload.error_message) {
        normalizedErrorPayload.error_message = sidecarErrorMessage;
      }
      noteToolObservationPayload(effectiveError?.rpc?.data?.tool_observations);
      const visibleCompletionEmitted = runtime.isVisibleCompletionEmitted();
      const reconnectReason = scheduleManagedSidecarReconnectAfterFailure(
        service,
        normalizedErrorPayload,
        {
          streamTimeout: Boolean(streamTimeoutError),
          visibleCompletionEmitted,
          sessionId: resolvedSessionId,
          streamId,
          traceId: requestTraceId,
        }
      );
      if (reconnectReason) {
        managedSidecarRestartReason = reconnectReason;
      }
      const terminal = resolveTerminalRouting({
        status: normalizedErrorPayload.status,
        terminalSubcode: normalizedErrorPayload.terminal_subcode,
        visibleCompletionEmitted,
      });
      approvalCleanupTerminalState = terminal.status;
      recordTimingMarker('terminal_settled');
      terminalSettledAt = Date.now();
      Promise.resolve(fetchAndRecordProviderDiagnosticPhases()).catch((providerDiagnosticError) => {
        if (typeof service._emitServiceLog === 'function') {
          service._emitServiceLog('WARN', 'chat.provider_phase_percentiles_failed', {
            sessionId: resolvedSessionId,
            streamId,
            traceId: requestTraceId,
            message: String(providerDiagnosticError?.message || providerDiagnosticError),
          });
        }
      });
      dumpFailedTurnDiagnostic({
        service,
        sessionId: resolvedSessionId,
        streamId,
        traceId: requestTraceId,
        terminal,
        timingMarkers,
        turnDiagnosticState,
        runtime,
        normalizedErrorPayload,
        sidecarErrorType,
        sidecarErrorMessage,
        model,
        clientTiming: normalizedClientTiming,
      });
      if (terminal.logOnlyLateFailure) {
        const expectedLifecycleCancellation = isExpectedLifecycleCancellation(normalizedErrorPayload);
        const settlementEvent = expectedLifecycleCancellation ? 'cancelled' : 'failed';
        service._emitServiceLog(expectedLifecycleCancellation ? 'INFO' : 'WARN',
          `chat.stream_late_settlement_${settlementEvent}`, {
          sessionId: resolvedSessionId, streamId, model,
          message: String(effectiveError && effectiveError.message || effectiveError),
          timedOut: Boolean(streamTimeoutError), status: terminal.status,
          terminalSubcode: terminal.terminalSubcode,
          cancelReason: normalizedErrorPayload.cancel_reason || '',
        });
        if (!runtime.isTerminalCoordinatorHandled()) {
          runtime.clearReconnectStateOnFailure();
        }
        return;
      }
      const coordinatedFailure = await runtime.settleFailureTerminal(
        normalizedErrorPayload,
        terminal
      );
      if (!coordinatedFailure.handled) {
        if (runtime.shouldPersistFailureMessage() && terminal.persistAssistantFailure) {
          runtime.persistFailureMessage(normalizedErrorPayload);
        } else {
          runtime.clearReconnectStateOnFailure();
        }
        if (terminal.emitErrorEvent) {
          service.emit('chat-stream', {
            type: 'error',
            ...enrichTerminalErrorPayloadForEmit(normalizedErrorPayload, {
              terminalStatus: terminal.status,
              terminalSubcode: terminal.terminalSubcode,
            }),
            ...runtime.getEventBase(),
          });
        }
      }
    } finally {
      streamWatchdog.clear();
      await finalizeManagedTerminalCleanup({
        service, runtime, actorRegistry, lease: activeTurnLease, turnEventCollector,
        sessionId: resolvedSessionId, streamId,
        terminalStatus: approvalCleanupTerminalState,
        deferredQuestionBatchEvent,
        beforeRelease: async () => {
          if (typeof terminalSettledAt === 'number') {
            recordServicePhasePercentile(service, 'completion_to_terminal_persist',
              Math.max(Date.now() - terminalSettledAt, 0));
          }
          if (managedSidecarRestartReason) {
            if (typeof service._restartManagedSidecar === 'function') {
              await service._restartManagedSidecar(managedSidecarRestartReason);
            } else {
              service._emitServiceLog('WARN', 'chat.sidecar_restart_unavailable', {
                sessionId: resolvedSessionId,
                streamId,
                traceId: requestTraceId,
                reason: managedSidecarRestartReason,
              });
            }
          }
        },
      });
    }
  })();
  controller._pendingPromise = pendingRun;

  return buildManagedStartResult(service, {
    sessionId: resolvedSessionId, streamId, identity: activeTurnLease.identity,
  });
}

module.exports = {
  waitForToolApproval,
  validateImageAttachmentsForManagedSend,
  startManagedSidecarChatStream,
};

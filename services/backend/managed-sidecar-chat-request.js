// The request stage of startManagedSidecarChatStream (managed-sidecar-chat.js):
// engine readiness, chat.send payload shaping, then frame fitting, transport
// options, the runtime-operation handler and the provider-auth-retrying send.
const { applyRuntimeChildSendFields } = require('../session-runtime/child-capabilities');
const { buildPreparedMessages } = require('./chat-stream-reasoning');
const { API_VERSION } = require('./sidecar-client');
const { buildRequestReasoningEffortField } = require('./backend-managed-reasoning');
const {
  waitForToolApproval,
  handleToolNotification,
} = require('./chat-stream-tool-handling');
const { inferencePerformanceRequestField } = require('../performance/provider-identity');
const {
  ensureManagedEngineNotFallbackForChat,
  ensureManagedLlamaServerReadyForChat,
  ensureManagedNinferReadyForChat,
  ensureManagedOllamaReadyForChat,
  ensureManagedSidecarReadyForChat,
  waitForManagedInitialization,
} = require('./managed-sidecar-chat-reconnect');
const { noteRuntimeInferenceSettlement } = require('./managed-sidecar-terminal-cleanup');
const { buildManagedSidecarChatSendOptions } = require('./electron-tool-bridge');
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
  emitManagedHistoryScopeNarrowing,
} = require('./managed-sidecar-chat-helpers');
const { computeInterruptedTurnReceipts } = require('./interrupted-turn-receipts');
const { buildChatSendOptionalFields } = require('./chat-send-optional-fields');
const { retainRuntimeSettlementHandler } = require('./sidecar-client-request-rpc');
const {
  assertRuntimeOperationsProtocol, assertRuntimeBudgetProtocol,
} = require('../session-runtime/inference-protocol');
const { createManagedContinuationSend } = require('./managed-sidecar-continuation');
// Idle watchdog + absolute backstop are engine-keyed (cloud engines get wider
// ceilings than local ones) — see resolveChatStreamCeilings in
// managed-sidecar-chat-helpers.js for the values and rationale.
const CHAT_STREAM_REQUEST_SETTLE_GRACE_MS = 1_000;

async function ensureManagedEnginesReadyForChat(service, {
  engineType, sessionId: resolvedSessionId, streamId, traceId: requestTraceId,
}) {
  await ensureManagedLlamaServerReadyForChat(service, {
    engineType,
    sessionId: resolvedSessionId,
    streamId,
    traceId: requestTraceId,
  });
  await ensureManagedNinferReadyForChat(service, {
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
}

function buildManagedChatSendParams(service, {
  resolvedSessionId, requestId, turnId, requestTraceId, promotionLogger, lockdownRequest,
  sessionSummary, sessionMessages, normalizedPreferences, toolContext, safetyPolicy, activeTurnLease,
  sessionStartDate, effectiveMode, normalizedInteractiveResponse, preparedMessages, canonicalSessionMessages,
  exchangeTitle, requestedModel, requestedEngine, imageAttachments, memoryPolicy, contextBlocks,
  requestToolPreferences, sessionHandoffPreparation, requestApprovalMode, engineType, normalizedDebugOptions,
  skillInvocation, executionAuthority,
}) {
  // W7: attach a truthful per-tool ledger for a hard-interrupted prior turn
  // (surviving journal partition), so the model gets ground truth over its
  // own last narration. null on every clean or approval-paused turn.
  const interruptedTurnReceipts = computeInterruptedTurnReceipts({
    journal: service.turnEventJournal,
    sessionId: resolvedSessionId,
    currentTurnId: requestId,
    logger: promotionLogger,
  });
  const chatSendParams = {
    subagent_routing: require('../subagent-routing-settings').normalizeSubagentRouting(
      service.configService?.getState?.()?.subagentRouting
    ),
    accept_version: API_VERSION,
    request_id: requestId, logical_turn_id: turnId,
    trace_id: requestTraceId,
    session_id: resolvedSessionId,
    session_offline_lockdown: lockdownRequest.active,
    // Workspace active use, approved plan, propose mode, primary role (row 69), safety policy.
    ...buildChatSendOptionalFields(service, { sessionId: resolvedSessionId, sessionSummary, sessionMessages,
      planMode: normalizedPreferences.plan_mode, workspaceRoot: toolContext.workspaceRoot, safetyPolicy }),
    session_incarnation: activeTurnLease.identity.sessionIncarnation,
    generation: activeTurnLease.identity.generation,
    session_start_date: sessionStartDate,
    mode: effectiveMode,
    interactive_response: normalizedInteractiveResponse,
    interactive_round_count: normalizedPreferences.interactive_round_count,
    messages: preparedMessages,
    canonical_session_messages: projectCanonicalSessionMessagesForSend(canonicalSessionMessages), // Wire-only: keep local full for transcript queries, recall, compaction, and telemetry.
    session_title: String(sessionSummary?.title || exchangeTitle || '').trim(),
    ...buildRequestReasoningEffortField(service, normalizedPreferences.reasoning_effort, requestedModel, requestedEngine),
    ...buildImageAttachmentSendParams(imageAttachments),
    ...(interruptedTurnReceipts ? { interrupted_turn_receipts: interruptedTurnReceipts } : {}),
    memory_policy: memoryPolicy, ...require('./session-context-usage').contextCalibrationSendField(sessionSummary),
    ...(contextBlocks?.length ? { context_blocks: contextBlocks } : {}),
    ...(requestToolPreferences ? { tool_preferences: requestToolPreferences } : {}), ...(sessionHandoffPreparation ? { handoff_preparation: sessionHandoffPreparation } : {}),
    approval_mode: requestApprovalMode,
    ...inferencePerformanceRequestField(service, { engineType, sessionId: resolvedSessionId, requestId }),
    ...(normalizedDebugOptions ? { debug_options: normalizedDebugOptions } : {}), ...(skillInvocation ? { skill_invocation: skillInvocation } : {}),
    execution_context: service.sessionExecutionAuthority.toExecutionContext(executionAuthority),
  };
  return chatSendParams;
}

async function sendManagedChatTurnRequest(service, {
  controller, runtime, runtimeContinuation, runtimeOperationGateway, runtimeBudgetRequired,
  runtimeAssertCurrent, runtimeOnInferenceSettlement, turnEventCollector, chatSendParams,
  executionAuthority, checkpointHistory, canonicalSessionMessages, compactedHistory, preparedHistoryMessages,
  contextPreferences, sessionSummary, prompt, textAttachments, skillInvocation, imagePromptPin, wireKinds,
  resolvedSessionId, streamId, requestId, requestTraceId, userMessageId, toolContext, normalizedPreferences,
  streamWatchdog, activeTurnLease, engineType,
}) {
  await waitForManagedInitialization(service, controller.signal);
  const continuationSend = createManagedContinuationSend({ service, runtimeContinuation, controller, activateCanonical: runtime.activateCanonicalContinuation,
    gateway: runtimeOperationGateway, collector: turnEventCollector, executionAuthority, canonicalSessionMessages,
    contextPreferences, compactedHistory, sessionSummary, traceId: requestTraceId });
  applyRuntimeChildSendFields(chatSendParams, executionAuthority, runtimeOperationGateway, continuationSend, runtimeBudgetRequired);
  // Frame fitting trims canonical history first, then whole history rounds.
  const frameFit = fitChatSendParamsToFrameBudgetWithOutcome(chatSendParams, {
    rebuildMessages: checkpointHistory ? undefined : (historyScope) => buildPreparedMessages(preparedHistoryMessages, prompt, {
      attachments: textAttachments, skillInvocation, imagePromptPin, ...wireKinds,
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
  const continuationBoundary = continuationSend?.bindFrame(frameFit);
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
  const chatSendOptions = () => buildManagedSidecarChatSendOptions({
      service, controller, streamId, resolvedSessionId, requestId, requestTraceId,
      runtime, toolContext, handleToolNotification, waitForToolApproval,
      turnEventCollector, normalizedPreferences,
      noteStreamActivity: streamWatchdog.noteActivity,
      pauseStreamIdleTimer: streamWatchdog.pauseForApproval,
      onNotificationObserved: turnEffectProbe.note,
      onApprovalObserved: turnEffectProbe.noteApproval,
      executionAuthority, turnIdentity: activeTurnLease.identity,
      // The idle watchdog handles progress; transport follows the absolute cap.
      timeoutMs: streamWatchdog.getCeilings().absoluteTimeoutMs
        + CHAT_STREAM_REQUEST_SETTLE_GRACE_MS,
  });
  const runtimeOperationHandler = (params) => {
    if (params?.kind === 'continuation' && continuationBoundary) return continuationBoundary.handleOperation(params);
    const result = ['inference', 'tool'].includes(params?.kind) && runtimeOperationGateway
      ? runtimeOperationGateway.handle(params)
      : service.sessionExecutionAuthority.checkRuntimeOperation(executionAuthority, params);
    return noteRuntimeInferenceSettlement(params, result, runtimeOnInferenceSettlement);
  };
  if (runtimeOperationGateway) {
    (runtimeBudgetRequired ? assertRuntimeBudgetProtocol : assertRuntimeOperationsProtocol)(service.sidecarClient);
    controller._runtimeSettlementUnregister = retainRuntimeSettlementHandler(service.sidecarClient,
      requestId, runtimeOperationHandler);
  }
  runtimeAssertCurrent?.();
  const providerOptions = () => ({
    ...chatSendOptions(),
    onRuntimeOperation: runtimeOperationHandler,
  });
  const result = await sendManagedChatWithProviderAuthRetry({
    service, engineType, runtime, controller, probe: turnEffectProbe,
    params: boundedChatSendParams,
    options: providerOptions(),
    assertBeforeSend: () => {
      runtimeAssertCurrent?.(); continuationSend?.assertProtocol();
      if (runtimeOperationGateway) (runtimeBudgetRequired ? assertRuntimeBudgetProtocol : assertRuntimeOperationsProtocol)(service.sidecarClient);
      setImmediate(() => service.backgroundJobWake?.onTurnStarted?.(resolvedSessionId)); // after this frame, before the first step
    },
    log: service._emitServiceLog.bind(service),
    ids: { sessionId: resolvedSessionId, streamId, traceId: requestTraceId },
  });
  return { result, boundedChatSendParams, continuationBoundary };
}

module.exports = {
  buildManagedChatSendParams,
  ensureManagedEnginesReadyForChat,
  sendManagedChatTurnRequest,
};

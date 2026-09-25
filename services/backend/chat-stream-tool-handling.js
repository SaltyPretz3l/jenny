const { waitForApproval } = require('./chat-stream-tool-approval');
const { summarizeToolPayload } = require('./backend-service-utils');
const {
  resolveToolResultStatus,
} = require('./chat-stream-terminal-utils');
const {
  LOOP_PROTOCOL_ERROR_CODES,
  TOOL_ERROR_CODES,
} = require('./error-codes');
const {
  buildElectronOrphanRepairPromotion,
} = require('./tool-observation-promotion');
const {
  buildToolResultMessageId,
  buildToolUseMessageId,
} = require('./tool-message-id');
const {
  normalizeToolResultMetadataForStorage,
  normalizePersistedToolResultMetadata,
} = require('./tool-result-diff-metadata');
const {
  drainPendingMonitorNotificationsForToolResult,
} = require('./monitor-event-service');
const { handleToolOutputChunkNotification } = require('./chat-stream-tool-output-chunk');
const {
  ingestToolResultAttachments,
  toPersistedToolResultAttachmentRefs,
} = require('./tool-result-attachments');
const {
  sanitizeToolSummary,
  buildPersistedToolInputSnapshot,
  buildApprovalCanonicalEvent,
  normalizeGeneratedArtifactsFromNotification,
  mergeLocalGeneratedArtifactPaths,
  normalizeToolResultMetadataFromNotification,
  workspaceIdentityForDiffMetadata,
  normalizeToolInputFromNotification,
  normalizeExternalPayloadsFromNotification,
  completedToolResultCallIdsForStream,
  buildToolCallPayload,
  findToolMessageId,
  approvalTerminalOutput,
  normalizeDurationMs,
  makeNoteTurnEvent,
  peekToolLookupMessages,
} = require('./chat-stream-tool-payload-utils');
const planDocuments = require('./plan-document-events');

const LOOP_TOOL_INTERRUPTED_CODE = LOOP_PROTOCOL_ERROR_CODES.TOOL_INTERRUPTED;
const LOOP_TOOL_INTERRUPTED_OUTPUT = 'System error: tool execution interrupted. Retry if needed.';

function recordToolObservability(service, observationType, payload = {}) {
  const aggregator = service?.toolObservabilityAggregator;
  if (!aggregator) {
    return false;
  }
  const method = observationType === 'executing'
    ? 'recordToolExecuting'
    : 'recordToolResult';
  if (typeof aggregator[method] !== 'function') {
    return false;
  }
  try {
    return aggregator[method](payload) === true;
  } catch (error) {
    if (typeof service?._emitServiceLog === 'function') {
      service._emitServiceLog('WARN', 'chat.tool_observability_record_failed', {
        observationType,
        streamId: String(payload.streamId || '').trim(),
        callId: String(payload.callId || '').trim(),
        error: String(error?.message || error),
      });
    }
    return false;
  }
}

function upsertToolResultMessage({
  service,
  sessionId,
  callId,
  streamId = '',
  turnId = streamId,
  summary,
  model,
  toolResult,
  existingMessages: providedExistingMessages = null,
}) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedCallId = String(callId || '').trim();
  if (!normalizedSessionId || !normalizedCallId) {
    return;
  }
  const preferredMessageId = buildToolResultMessageId(streamId, normalizedCallId);
  const existingMessages = Array.isArray(providedExistingMessages)
    ? providedExistingMessages
    : peekToolLookupMessages(service, normalizedSessionId);
  const existingMessageId = findToolMessageId(existingMessages, {
    kind: 'tool_result',
    callId: normalizedCallId,
    streamId,
    fallbackId: preferredMessageId,
  });
  const safeSummary = sanitizeToolSummary(summary).trim();
  const safeToolResult = {
    ...toolResult,
    summary: sanitizeToolSummary(toolResult?.summary || safeSummary).trim(),
  };
  const patch = {
    turn_id: turnId,
    role: 'tool',
    kind: 'tool_result',
    content: safeSummary,
    tool_result: safeToolResult,
    finalizedAt: new Date().toISOString(),
    model_used: String(model || ''),
  };
  if (existingMessageId && typeof service?.sessionStore?.updateMessage === 'function') {
    service.sessionStore.updateMessage(normalizedSessionId, existingMessageId, patch);
    return;
  }
  if (typeof service?.sessionStore?.appendMessage !== 'function') {
    return;
  }
  service.sessionStore.appendMessage(normalizedSessionId, {
    id: preferredMessageId,
    timestamp: new Date().toISOString(),
    ...patch,
  }, { updatePreview: false });
}

function persistTerminalApprovalResult({
  service,
  sessionId,
  streamId,
  callId,
  toolName,
  summary,
  model,
  approvalState,
  inputSnapshot,
  policyDecisionId = '',
  turnEventCollector = null,
  output: outputOverride = '',
}) {
  const normalizedState = String(approvalState || 'denied').trim() || 'denied';
  const output = String(outputOverride || '').trim() || approvalTerminalOutput(toolName, normalizedState);
  const resultSummary = sanitizeToolSummary(`${toolName || 'tool'} ${normalizedState}`).trim();
  const errorCode = TOOL_ERROR_CODES.APPROVAL_DENIED;
  const status = resolveToolResultStatus({
    isError: true,
    approvalState: normalizedState,
  });
  const metadata = {
    recovery: 'approval_resolved',
    terminal_state: normalizedState,
  };
  const noteTurnEvent = makeNoteTurnEvent(turnEventCollector, streamId);
  upsertToolResultMessage({
    turnId: turnEventCollector?.turnId || streamId,
    service,
    sessionId,
    callId,
    streamId,
    summary: resultSummary || summary,
    model,
    toolResult: {
      call_id: callId,
      tool_name: toolName,
      output_text: output,
      summary: resultSummary || summary,
      is_error: true,
      error_code: errorCode,
      exit_code: null,
      duration_ms: 0,
      parent_stream_id: streamId,
      approval_state: normalizedState,
      generated_artifacts: [],
      metadata,
    },
  });
  recordToolObservability(service, 'result', {
    streamId,
    sessionId,
    callId,
    toolName,
    success: false,
    errorCode,
    terminalState: normalizedState,
  });
  noteTurnEvent('tool_result', () => {
    const toolResultMessageId = buildToolResultMessageId(streamId, callId);
    return {
      primary_message_id: toolResultMessageId,
      source_message_ids: [toolResultMessageId],
      tool_call_id: callId,
      status,
      payload: {
        tool_name: toolName,
        output_text: output,
        summary: resultSummary || summary,
        is_error: true,
        error_code: errorCode,
        approval_state: normalizedState,
        parent_stream_id: streamId,
        generated_artifacts: [],
        metadata,
      },
    };
  });
  service.emit('chat-stream', {
    type: 'tool_result',
    streamId,
    sessionId,
    model,
    callId,
    ...(policyDecisionId ? { policyDecisionId } : {}),
    toolName,
    input: inputSnapshot?.input || {},
    content: output,
    summary: resultSummary || summary,
    isError: true,
    approvalState: normalizedState,
    durationMs: 0,
    generatedArtifacts: [],
    errorCode,
    metadata,
  });
}
function waitForToolApproval(service, streamId, sessionId, requestId, params, controller,
  turnEventCollector = null, executionAuthority = null) {
  return waitForApproval(service, streamId, sessionId, requestId, params, controller,
    turnEventCollector, executionAuthority, persistTerminalApprovalResult);
}
function handleToolNotification(service, context, notification, options = {}) {
  const {
    seenToolCalls,
    toolSummaries,
    model,
    resolvedSessionId,
    streamId,
    workspaceRoot = '',
    eventBase,
    turnEventCollector = null,
  } = context;
  const params = notification.params && typeof notification.params === 'object'
    ? notification.params
    : {};
  const noteTurnEvent = options.canonicalEvent === true || turnEventCollector?.canonicalPrimary === true ? () => null
    : makeNoteTurnEvent(turnEventCollector, streamId);
  if (notification.method === 'tool.executing' || notification.method === 'tool.requested') {
    const requested = notification.method === 'tool.requested';
    const status = requested ? 'pending' : 'running';
    const callId = String(params.tool_call_id || '').trim();
    if (!callId) {
      return true;
    }
    const toolName = String(params.tool_name || '').trim();
    const policyDecisionId = String(
      params.policy_decision_id || params.policyDecisionId || ''
    ).trim();
    const input = normalizeToolInputFromNotification(params.tool_input);
    const persistedInputSnapshot = buildPersistedToolInputSnapshot(input);
    const externalPayloads = normalizeExternalPayloadsFromNotification(
      params._external_payloads,
      service
    );
    const summary = sanitizeToolSummary(toolSummaries.get(callId) || summarizeToolPayload(toolName, input));
    toolSummaries.set(callId, summary);
    const toolUseMessageId = buildToolUseMessageId(streamId, callId);
    const existingMessages = peekToolLookupMessages(service, resolvedSessionId);
    const existingToolUseId = findToolMessageId(existingMessages, {
      kind: 'tool_use',
      callId,
      streamId,
      fallbackId: toolUseMessageId,
    });
    if (existingToolUseId) {
      service.sessionStore.updateMessage(resolvedSessionId, existingToolUseId, {
        tool_call: buildToolCallPayload({
          callId,
          policyDecisionId,
          toolName,
          input,
          workspaceRoot,
          inputSnapshot: persistedInputSnapshot,
          summary,
          status,
          approvalState: 'auto',
          streamId,
          externalPayloads,
        }),
      });
    } else {
      service.sessionStore.appendMessage(resolvedSessionId, {
        turn_id: turnEventCollector?.turnId || streamId,
        id: toolUseMessageId,
        role: 'assistant',
        kind: 'tool_use',
        content: summary,
        tool_call: buildToolCallPayload({
          callId,
          policyDecisionId,
          toolName,
          input,
          workspaceRoot,
          inputSnapshot: persistedInputSnapshot,
          summary,
          status,
          approvalState: 'auto',
          streamId,
          externalPayloads,
        }),
        finalizedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        model_used: model,
      }, { updatePreview: false });
    }
    noteTurnEvent('tool_use', () => ({
      primary_message_id: existingToolUseId || toolUseMessageId,
      source_message_ids: [existingToolUseId || toolUseMessageId],
      tool_call_id: callId,
      status,
      payload: {
        tool_name: toolName,
        input: persistedInputSnapshot.input,
        ...(policyDecisionId ? { policy_decision_id: policyDecisionId } : {}),
        summary,
        parent_stream_id: streamId,
      },
    }));
    noteTurnEvent('tool_executing', () => ({
      primary_message_id: existingToolUseId || toolUseMessageId,
      source_message_ids: [existingToolUseId || toolUseMessageId],
      tool_call_id: callId,
      status,
      payload: {
        tool_name: toolName,
      },
    }));
    if (!requested) seenToolCalls.add(callId);
    if (!requested) recordToolObservability(service, 'executing', {
      streamId,
      sessionId: resolvedSessionId,
      callId,
      toolName,
    });
    service.emit('chat-stream', {
      type: 'tool_use',
      ...eventBase,
      ...(options.nextAssistantMessageId ? { next_assistant_message_id: options.nextAssistantMessageId } : {}),
      callId,
      ...(policyDecisionId ? { policyDecisionId } : {}),
      toolName,
      input: persistedInputSnapshot.input,
      summary,
      status,
      ...(Object.keys(externalPayloads).length ? { externalPayloads } : {}),
    });
    return true;
  }

  if (handleToolOutputChunkNotification(service, context, notification)) {
    return true;
  }

  if (notification.method === 'tool.result') {
    const callId = String(params.tool_call_id || '').trim();
    if (!callId) {
      return true;
    }
    const toolName = String(params.tool_name || '').trim();
    const policyDecisionId = String(
      params.policy_decision_id || params.policyDecisionId || ''
    ).trim();
    const input = normalizeToolInputFromNotification(params.tool_input);
    const persistedInputSnapshot = buildPersistedToolInputSnapshot(input);
    const externalPayloads = normalizeExternalPayloadsFromNotification(
      params._external_payloads,
      service
    );
    const summary = sanitizeToolSummary(toolSummaries.get(callId) || summarizeToolPayload(toolName, input));
    toolSummaries.set(callId, summary);
    const generatedArtifacts = mergeLocalGeneratedArtifactPaths(service, {
      streamId,
      callId,
      sessionId: resolvedSessionId,
      artifacts: normalizeGeneratedArtifactsFromNotification(params.generated_artifacts),
    });
    // WIDE-019: ingest typed attachment bytes synchronously into the existing
    // AttachmentAssetStore; only stored refs (asset id/path) persist below.
    const trustedAttachmentRefs = ingestToolResultAttachments(
      service,
      params.trusted_attachments,
      { sessionId: resolvedSessionId, streamId, callId, toolName }
    );
    const persistedAttachmentRefs = toPersistedToolResultAttachmentRefs(trustedAttachmentRefs);
    const resultTraceId = String(params.trace_id || '').trim();
    const normalizedMetadata = {
      ...normalizeToolResultMetadataFromNotification(params.metadata),
      ...workspaceIdentityForDiffMetadata(service, params.metadata, context.workspaceRoot),
      // Omit rather than store `undefined`: the canonical message must round-trip
      // through JSON persistence with the same key set.
      ...(resultTraceId ? { trace_id: resultTraceId } : {}),
    };
    planDocuments.recordPlanToolOutcome({ toolName, service, sessionId: resolvedSessionId, streamId, callId,
      result: { isError: params.success === false, metadata: normalizedMetadata }, turnEventCollector });
    const metadataOptions = {
      streamId,
      callId,
      toolName,
      input,
    };
    const persistedMetadata = normalizePersistedToolResultMetadata(normalizedMetadata, {
      ...metadataOptions,
    });
    const safeMetadata = normalizeToolResultMetadataForStorage(
      normalizedMetadata,
      metadataOptions,
      persistedMetadata
    );
    const toolStatus = params.success === false ? 'error' : 'completed';
    const explicitDurationMs = normalizeDurationMs(params.duration_ms ?? params.durationMs);
    const toolUseMessageId = buildToolUseMessageId(streamId, callId);
    const toolResultMessageId = buildToolResultMessageId(streamId, callId);
    // Fetch the session message list once for the tool.result path.
    // The tool_use update below only mutates the tool_use message, which the
    // tool_result lookup inside upsertToolResultMessage ignores, so the same
    // array is safe to thread through for both lookups.
    const existingMessagesAtResult = peekToolLookupMessages(service, resolvedSessionId);
    const existingToolUseId = findToolMessageId(
      existingMessagesAtResult,
      { kind: 'tool_use', callId, streamId, fallbackId: toolUseMessageId }
    );
    if (existingToolUseId) {
      service.sessionStore.updateMessage(resolvedSessionId, existingToolUseId, {
        tool_call: buildToolCallPayload({
          callId,
          policyDecisionId,
          toolName,
          input,
          workspaceRoot,
          inputSnapshot: persistedInputSnapshot,
          summary,
          status: toolStatus,
          approvalState: 'auto',
          streamId,
          externalPayloads,
        }),
      });
    }
    upsertToolResultMessage({
      turnId: turnEventCollector?.turnId || streamId,
      service,
      sessionId: resolvedSessionId,
      callId,
      streamId,
      summary,
      model,
      existingMessages: existingMessagesAtResult,
      toolResult: {
        call_id: callId,
        tool_name: toolName,
        output_text: String(params.output || ''),
        summary,
        is_error: params.success === false,
        error_code: String(params.error_code || '').trim(),
        exit_code:
          params.metadata
          && typeof params.metadata === 'object'
          && !Array.isArray(params.metadata)
          && params.metadata.exitCode != null
            ? Number(params.metadata.exitCode)
            : null,
        duration_ms: explicitDurationMs ?? 0,
        parent_stream_id: streamId,
        generated_artifacts: generatedArtifacts,
        metadata: safeMetadata,
        ...(persistedAttachmentRefs.length
          ? { trusted_attachment_refs: persistedAttachmentRefs }
          : {}),
        ...(Object.keys(externalPayloads).length ? { external_payloads: externalPayloads } : {}),
      },
    });
    if (toolName === 'monitor') {
      const monitorMetadata = normalizedMetadata.monitor
        && typeof normalizedMetadata.monitor === 'object'
        && !Array.isArray(normalizedMetadata.monitor)
        ? normalizedMetadata.monitor
        : {};
      drainPendingMonitorNotificationsForToolResult(service, {
        sessionId: resolvedSessionId,
        requestId: streamId,
        toolCallId: callId,
        monitorId: String(monitorMetadata.monitor_id || '').trim(),
      });
    }
    noteTurnEvent('tool_result', () => ({
      primary_message_id: toolResultMessageId,
      source_message_ids: [toolResultMessageId],
      tool_call_id: callId,
      status: toolStatus,
      payload: {
        tool_name: toolName,
        output_text: String(params.output || ''),
        summary,
        is_error: params.success === false,
        error_code: String(params.error_code || '').trim(),
        duration_ms: explicitDurationMs ?? 0,
        approval_state: 'auto',
        parent_stream_id: streamId,
        generated_artifacts: generatedArtifacts.map((artifact) => ({
          ...artifact,
          tool_call_id: callId,
        })),
        ...(persistedAttachmentRefs.length
          ? { trusted_attachment_refs: persistedAttachmentRefs }
          : {}),
        ...(persistedMetadata ? { metadata: persistedMetadata } : {}),
      },
    }));
    recordToolObservability(service, 'result', {
      streamId,
      sessionId: resolvedSessionId,
      callId,
      toolName,
      success: params.success !== false,
      errorCode: String(params.error_code || '').trim(),
      durationMs: explicitDurationMs,
    });
    service.emit('chat-stream', {
      type: 'tool_result',
      ...eventBase,
      callId,
      ...(policyDecisionId ? { policyDecisionId } : {}),
      toolName,
      input: persistedInputSnapshot.input,
      content: String(params.output || ''),
      summary,
      isError: params.success === false,
      approvalState: 'auto',
      durationMs: explicitDurationMs ?? 0,
      generatedArtifacts,
      errorCode: String(params.error_code || '').trim(),
      metadata: safeMetadata,
      ...(trustedAttachmentRefs.length ? { trustedAttachments: trustedAttachmentRefs } : {}),
      ...(Object.keys(externalPayloads).length ? { externalPayloads } : {}),
    });
    return true;
  }

  return false;
}

function collectStreamToolUseCandidates(messages, streamId, completedCallIds, statusPredicate) {
  const candidates = [];
  for (const message of messages) {
    if (String(message?.kind || '').trim() !== 'tool_use') {
      continue;
    }
    const toolCall = message?.tool_call || {};
    if (String(toolCall.parent_stream_id || '').trim() !== streamId) {
      continue;
    }
    const callId = String(toolCall.call_id || '').trim();
    if ((callId && completedCallIds.has(callId)) || !statusPredicate(toolCall, callId)) {
      continue;
    }
    const input = toolCall.input && typeof toolCall.input === 'object' ? toolCall.input : {};
    candidates.push({ message, toolCall, callId, input });
  }
  return candidates;
}

function settlePendingApprovalsForStream(
  service,
  sessionId,
  streamId,
  terminalState = 'cancelled'
) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedStreamId = String(streamId || '').trim();
  const normalizedTerminalState = String(terminalState || 'cancelled').trim() || 'cancelled';
  if (!normalizedSessionId || !normalizedStreamId) {
    return 0;
  }
  for (const [callId, pending] of [...service.pendingToolApprovals.entries()]) {
    if (String(pending?.streamId || '').trim() !== normalizedStreamId) {
      continue;
    }
    pending.resolve(false, normalizedTerminalState);
    service.pendingToolApprovals.delete(callId);
  }

  const messages = service.sessionStore.getSessionMessages(normalizedSessionId);
  const completedCallIds = completedToolResultCallIdsForStream(
    messages,
    normalizedStreamId
  );
  const candidates = collectStreamToolUseCandidates(
    messages, normalizedStreamId, completedCallIds,
    (toolCall) => String(toolCall.status || '').trim() === 'pending_approval'
      || String(toolCall.approval_state || '').trim() === 'pending'
  );
  let repairedCount = 0;
  for (const { message, toolCall, callId, input } of candidates) {
    const persistedInputSnapshot = buildPersistedToolInputSnapshot(input);
    const toolName = String(toolCall.tool_name || '').trim();
    const summary = sanitizeToolSummary(toolCall.summary || summarizeToolPayload(toolName, input)).trim();
    const policyDecisionId = String(toolCall.policy_decision_id || '').trim();
    service.sessionStore.updateMessage(normalizedSessionId, String(message.id || ''), {
      tool_call: buildToolCallPayload({
        callId,
        policyDecisionId,
        toolName,
        input,
        inputSnapshot: persistedInputSnapshot,
        summary,
        status: normalizedTerminalState,
        approvalState: normalizedTerminalState,
        streamId: normalizedStreamId,
        externalPayloads:
          toolCall.external_payloads
          && typeof toolCall.external_payloads === 'object'
          && !Array.isArray(toolCall.external_payloads)
            ? { ...toolCall.external_payloads }
            : {},
      }),
    });
    if (callId) {
      service.emit('chat-stream', {
        type: 'tool_use',
        streamId: normalizedStreamId,
        sessionId: normalizedSessionId,
        model: service.currentModel,
        callId,
        ...(policyDecisionId ? { policyDecisionId } : {}),
        toolName,
        input: persistedInputSnapshot.input,
        summary,
        status: normalizedTerminalState,
      });
    }
    repairedCount += 1;
  }
  return repairedCount;
}

function settleUnfinishedToolsForStream(
  service,
  context,
  terminalState = 'interrupted'
) {
  const {
    toolSummaries = new Map(),
    model = '',
    resolvedSessionId = '',
    streamId = '',
    workspaceRoot = '',
    eventBase = {},
    turnEventCollector = null,
  } = context || {};
  const normalizedSessionId = String(resolvedSessionId || '').trim();
  const normalizedStreamId = String(streamId || '').trim();
  const normalizedTerminalState = String(terminalState || 'interrupted').trim() || 'interrupted';
  if (!normalizedSessionId || !normalizedStreamId) {
    return [];
  }
  const messages = service.sessionStore.getSessionMessages(normalizedSessionId);
  const completedCallIds = completedToolResultCallIdsForStream(
    messages,
    normalizedStreamId
  );
  const candidates = collectStreamToolUseCandidates(
    messages, normalizedStreamId, completedCallIds,
    (toolCall, callId) => Boolean(callId)
      && String(toolCall.status || '').trim() === 'running'
  );
  const noteTurnEvent = makeNoteTurnEvent(turnEventCollector, normalizedStreamId);
  const settlements = [];
  for (const { message, toolCall, callId, input } of candidates) {
    const persistedInputSnapshot = buildPersistedToolInputSnapshot(input);
    const toolName = String(toolCall.tool_name || '').trim();
    const policyDecisionId = String(toolCall.policy_decision_id || '').trim();
    const summary = sanitizeToolSummary(
      toolCall.summary
      || (toolSummaries instanceof Map ? toolSummaries.get(callId) : '')
      || summarizeToolPayload(toolName, input)
    ).trim();
    service.sessionStore.updateMessage(normalizedSessionId, String(message.id || ''), {
      tool_call: buildToolCallPayload({
        callId,
        policyDecisionId,
        toolName,
        input,
        workspaceRoot,
        summary,
        status: normalizedTerminalState,
        approvalState: 'auto',
        streamId: normalizedStreamId,
        externalPayloads:
          toolCall.external_payloads
          && typeof toolCall.external_payloads === 'object'
          && !Array.isArray(toolCall.external_payloads)
            ? { ...toolCall.external_payloads }
            : {},
      }),
    });
    upsertToolResultMessage({
      turnId: turnEventCollector?.turnId || normalizedStreamId,
      service,
      sessionId: normalizedSessionId,
      callId,
      streamId: normalizedStreamId,
      summary,
      model,
      toolResult: {
        call_id: callId,
        tool_name: toolName,
        output_text: LOOP_TOOL_INTERRUPTED_OUTPUT,
        summary,
        is_error: true,
        error_code: LOOP_TOOL_INTERRUPTED_CODE,
        exit_code: null,
        duration_ms: 0,
        parent_stream_id: normalizedStreamId,
        generated_artifacts: [],
        metadata: {
          recovery: 'orphaned_tool_call',
          terminal_state: normalizedTerminalState,
        },
      },
    });
    recordToolObservability(service, 'result', {
      streamId: normalizedStreamId,
      sessionId: normalizedSessionId,
      callId,
      toolName,
      success: false,
      errorCode: LOOP_TOOL_INTERRUPTED_CODE,
      terminalState: normalizedTerminalState,
    });
    noteTurnEvent('tool_result', () => {
      const orphanPromotion = buildElectronOrphanRepairPromotion({
        requestId: normalizedStreamId,
        turnId: normalizedStreamId,
        toolCallId: callId,
        toolName,
        summary,
        terminalState: normalizedTerminalState,
      });
      const toolResultMessageId = buildToolResultMessageId(normalizedStreamId, callId);
      return {
        primary_message_id: toolResultMessageId,
        source_message_ids: [toolResultMessageId],
        tool_call_id: callId,
        status: 'error',
        payload: {
          tool_name: toolName,
          output_text: LOOP_TOOL_INTERRUPTED_OUTPUT,
          summary,
          is_error: true,
          error_code: LOOP_TOOL_INTERRUPTED_CODE,
          approval_state: normalizedTerminalState,
          parent_stream_id: normalizedStreamId,
          generated_artifacts: [],
          ...(orphanPromotion
            ? { promoted_observations: [orphanPromotion.promoted_observation] }
            : {}),
        },
      };
    });
    service.emit('chat-stream', {
      type: 'tool_use',
      ...eventBase,
      callId,
      ...(policyDecisionId ? { policyDecisionId } : {}),
      toolName,
      input: persistedInputSnapshot.input,
      summary,
      status: normalizedTerminalState,
    });
    service.emit('chat-stream', {
      type: 'tool_result',
      ...eventBase,
      callId,
      ...(policyDecisionId ? { policyDecisionId } : {}),
      toolName,
      input: persistedInputSnapshot.input,
      content: LOOP_TOOL_INTERRUPTED_OUTPUT,
      summary,
      isError: true,
      approvalState: normalizedTerminalState,
      durationMs: 0,
      generatedArtifacts: [],
      errorCode: LOOP_TOOL_INTERRUPTED_CODE,
      metadata: {
        recovery: 'orphaned_tool_call',
        terminal_state: normalizedTerminalState,
      },
    });
    completedCallIds.add(callId);
    settlements.push({ callId, toolName });
  }
  if (settlements.length && typeof service._emitServiceLog === 'function') {
    service._emitServiceLog('WARN', 'chat.orphaned_tool_calls_settled', {
      sessionId: normalizedSessionId,
      streamId: normalizedStreamId,
      count: settlements.length,
      code: LOOP_TOOL_INTERRUPTED_CODE,
    });
  }
  return settlements;
}

module.exports = {
  normalizeGeneratedArtifactsFromNotification,
  normalizeExternalPayloadsFromNotification,
  waitForToolApproval,
  handleToolNotification,
  settlePendingApprovalsForStream,
  settleUnfinishedToolsForStream,
};

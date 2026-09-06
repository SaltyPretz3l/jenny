const {
  normalizeAttachmentMetadataList,
} = require('../attachment-service');
const {
  INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
  INTERACTIVE_SEQUENCE_IDLE,
  INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
  MAX_INTERACTIVE_ROUNDS,
  buildInteractiveQuestionBatchTranscript,
  buildInteractiveRoundRecap,
  isDefaultSessionTitle,
} = require('./interactive-session-utils');

// The exchange title is captured at send time; by the time the turn settles,
// the renderer's auto-title or a manual rename may already have titled the
// session. Those must win — only a still-default title gets the exchange
// title. A store that cannot answer (missing/partial in stubs) fails open to
// the historical always-apply behavior.
function sessionTitleStillDefault(store, sessionId) {
  if (!store || typeof store.getSession !== 'function') {
    return true;
  }
  try {
    return isDefaultSessionTitle(store.getSession(sessionId)?.title);
  } catch (_error) {
    return true;
  }
}
const {
  buildReasoningPayloadFromPhases,
} = require('./chat-transcript-phase-collector');
const {
  buildAssistantErrorRecoveryFields,
} = require('./chat-error-recovery');

const ACTIVE_TURN_PROGRESS_WRITE_INTERVAL_MS = 1000;

function buildReasoningPayload(reasoningEntries, phases) {
  return buildReasoningPayloadFromPhases(phases, reasoningEntries);
}

function buildAssistantTranscriptFields({
  parentStreamId = '',
  phases = [],
  visibleSegments = [],
  toolSteps = [],
  reasoningEntries = [],
} = {}) {
  return {
    parent_stream_id: String(parentStreamId || '').trim(),
    phases: Array.isArray(phases) ? phases : [],
    visible_segments: Array.isArray(visibleSegments) ? visibleSegments : [],
    tool_steps: Array.isArray(toolSteps) ? toolSteps : [],
    reasoning: buildReasoningPayload(reasoningEntries, phases),
  };
}

function buildInteractiveResetPreferences(_normalizedPreferences) {
  return {
    pending_question_batch: null,
    pending_plan_proposal: null,
    interactive_sequence_state: INTERACTIVE_SEQUENCE_IDLE,
    interactive_round_count: 0,
  };
}

function createSessionLifecycleAdapter({
  appendMessage,
  setSessionPreferences,
  applySessionTitle,
  getActiveTurn,
  setActiveTurn,
  touchActiveTurn,
  clearActiveTurn,
}) {
  if (typeof appendMessage !== 'function') {
    throw new TypeError('createSessionLifecycleAdapter requires an appendMessage function.');
  }
  if (typeof setSessionPreferences !== 'function') {
    throw new TypeError('createSessionLifecycleAdapter requires a setSessionPreferences function.');
  }
  if (typeof getActiveTurn !== 'function') {
    throw new TypeError('createSessionLifecycleAdapter requires a getActiveTurn function.');
  }
  if (typeof setActiveTurn !== 'function') {
    throw new TypeError('createSessionLifecycleAdapter requires a setActiveTurn function.');
  }
  if (typeof touchActiveTurn !== 'function') {
    throw new TypeError('createSessionLifecycleAdapter requires a touchActiveTurn function.');
  }
  if (typeof clearActiveTurn !== 'function') {
    throw new TypeError('createSessionLifecycleAdapter requires a clearActiveTurn function.');
  }
  let hasCachedActiveTurn = false;
  let cachedActiveTurn = null;
  const accepted = (result) => (
    result && typeof result === 'object' && typeof result.ok === 'boolean'
      ? result.ok
      : Boolean(result)
  );
  const copy = (value) => (value && typeof value === 'object' ? { ...value } : null);
  return {
    appendMessage,
    setSessionPreferences,
    getActiveTurn() {
      if (hasCachedActiveTurn) {
        return cachedActiveTurn;
      }
      cachedActiveTurn = getActiveTurn();
      hasCachedActiveTurn = true;
      return cachedActiveTurn;
    },
    peekActiveTurn() {
      return hasCachedActiveTurn ? cachedActiveTurn : null;
    },
    setActiveTurn(activeTurn, options) {
      const next = setActiveTurn(activeTurn, options);
      if (accepted(next)) {
        cachedActiveTurn = copy(activeTurn);
        hasCachedActiveTurn = true;
      } else {
        hasCachedActiveTurn = false;
        cachedActiveTurn = null;
      }
      return next;
    },
    touchActiveTurn(match, patch) {
      const current = hasCachedActiveTurn ? cachedActiveTurn : getActiveTurn();
      const next = touchActiveTurn(match, patch);
      if (accepted(next)) {
        cachedActiveTurn = { ...(current || match || {}), ...(patch || {}) };
        hasCachedActiveTurn = true;
      } else {
        hasCachedActiveTurn = false;
        cachedActiveTurn = null;
      }
      return next;
    },
    clearActiveTurn(match) {
      const next = clearActiveTurn(match);
      if (accepted(next)) {
        cachedActiveTurn = null;
        hasCachedActiveTurn = true;
      } else {
        cachedActiveTurn = null;
        hasCachedActiveTurn = false;
      }
      return next;
    },
    applySessionTitle:
      typeof applySessionTitle === 'function'
        ? applySessionTitle
        : async () => {},
  };
}

function createActorMutationGuard(service, turnLease) {
  return (site, mutation) => {
    if (!turnLease || typeof service.sessionTurnActors?.guard !== 'function') {
      return mutation();
    }
    return service.sessionTurnActors.guard(turnLease, site, mutation);
  };
}

function createManagedSessionLifecycleAdapter(service, sessionId, turnLease = null) {
  const mutate = createActorMutationGuard(service, turnLease);
  return createSessionLifecycleAdapter({
    appendMessage(message, options = {}) {
      const model = String(options.model || message?.model_used || '').trim();
      return mutate('managed.append_message', () => service.sessionStore.appendMessage(
        sessionId,
        {
          ...message,
          ...(model && !String(message?.model_used || '').trim() ? { model_used: model } : {}),
        },
        {
          updatePreview: options.updatePreview !== false,
        }
      ));
    },
    setSessionPreferences(preferences) {
      return mutate(
        'managed.set_preferences',
        () => service.sessionStore.setSessionPreferences(sessionId, preferences)
      );
    },
    getActiveTurn() {
      return service.sessionStore.getActiveTurn(sessionId);
    },
    setActiveTurn(activeTurn, options) {
      return mutate(
        'managed.set_active_turn',
        () => service.sessionStore.setActiveTurn(sessionId, activeTurn, options)
      );
    },
    touchActiveTurn(match, patch) {
      return mutate(
        'managed.touch_active_turn',
        () => service.sessionStore.touchActiveTurn(sessionId, match, patch)
      );
    },
    clearActiveTurn(match) {
      return mutate(
        'managed.clear_active_turn',
        () => service.sessionStore.clearActiveTurn(sessionId, match)
      );
    },
    async applySessionTitle(title, options = {}) {
      if (!sessionTitleStillDefault(service.sessionStore, sessionId)) {
        return null;
      }
      try {
        return await service.renameSession(sessionId, title);
      } catch (error) {
        if (typeof service._emitServiceLog === 'function') {
          service._emitServiceLog('WARN', 'chat.session_title_update_failed', {
            sessionId,
            reason: String(options.reason || 'complete'),
            title: String(title || ''),
            message: String(error?.message || error),
          });
        }
        return null;
      }
    },
  });
}

function startActiveTurn(adapter, {
  requestId,
  streamId,
  traceId = '',
  userMessageId,
  timestamp = new Date().toISOString(),
  expectedPriorStreamId,
  turnId = '',
  sessionIncarnation = '',
  generation,
}) {
  return adapter.setActiveTurn({
    request_id: String(requestId || '').trim(),
    stream_id: String(streamId || '').trim(),
    ...(String(turnId || '').trim() ? { turn_id: String(turnId).trim() } : {}),
    ...(String(sessionIncarnation || '').trim()
      ? { session_incarnation: String(sessionIncarnation).trim() }
      : {}),
    ...(Number.isSafeInteger(generation) && generation > 0 ? { generation } : {}),
    trace_id: String(traceId || '').trim(),
    user_message_id: String(userMessageId || '').trim(),
    started_at: timestamp,
    last_event_at: timestamp,
    status: 'awaiting_assistant',
  }, expectedPriorStreamId ? { expectedPriorStreamId } : undefined);
}

function parseIsoTimestamp(value) {
  const token = String(value || '').trim();
  if (!token) {
    return NaN;
  }
  const parsed = Date.parse(token);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function shouldPersistActiveTurnProgress(adapter, {
  requestId,
  streamId,
  status,
  timestamp,
  taskId,
  taskType,
  agentStage,
  agentSummary,
  agentPercent,
}) {
  const current = typeof adapter.peekActiveTurn === 'function'
    ? (adapter.peekActiveTurn() || adapter.getActiveTurn())
    : adapter.getActiveTurn();
  if (!current) {
    return true;
  }
  if (
    String(current.request_id || '').trim() !== String(requestId || '').trim()
    || String(current.stream_id || '').trim() !== String(streamId || '').trim()
  ) {
    return true;
  }
  if (String(current.status || '').trim() !== String(status || '').trim()) {
    return true;
  }
  if (
    String(current.task_id || '').trim() !== String(taskId || '').trim()
    || String(current.task_type || '').trim() !== String(taskType || '').trim()
    || String(current.agent_stage || '').trim() !== String(agentStage || '').trim()
    || String(current.agent_summary || '').trim() !== String(agentSummary || '').trim()
  ) {
    return true;
  }
  const normalizedPercent = Number.isFinite(Number(agentPercent))
    ? Math.min(100, Math.max(0, Math.round(Number(agentPercent))))
    : null;
  const currentPercent = Number.isFinite(Number(current.agent_percent))
    ? Math.min(100, Math.max(0, Math.round(Number(current.agent_percent))))
    : null;
  if (normalizedPercent !== currentPercent) {
    return true;
  }
  const nextTime = parseIsoTimestamp(timestamp);
  const currentTime = parseIsoTimestamp(current.last_event_at);
  if (!Number.isFinite(nextTime) || !Number.isFinite(currentTime)) {
    return true;
  }
  return (nextTime - currentTime) >= ACTIVE_TURN_PROGRESS_WRITE_INTERVAL_MS;
}

function touchActiveTurnProgress(adapter, {
  requestId,
  streamId,
  status = 'streaming',
  timestamp = new Date().toISOString(),
  taskId = '',
  taskType = '',
  agentStage = '',
  agentSummary = '',
  agentPercent = null,
}) {
  if (!shouldPersistActiveTurnProgress(adapter, {
    requestId,
    streamId,
    status,
    timestamp,
    taskId,
    taskType,
    agentStage,
    agentSummary,
    agentPercent,
  })) {
    return typeof adapter.peekActiveTurn === 'function'
      ? adapter.peekActiveTurn()
      : adapter.getActiveTurn();
  }
  const normalizedPercent = Number.isFinite(Number(agentPercent))
    ? Math.min(100, Math.max(0, Math.round(Number(agentPercent))))
    : null;
  return adapter.touchActiveTurn(
    {
      request_id: requestId,
      stream_id: streamId,
    },
    {
      status,
      last_event_at: timestamp,
      ...(String(taskId || '').trim() ? { task_id: String(taskId || '').trim() } : {}),
      ...(String(taskType || '').trim() ? { task_type: String(taskType || '').trim() } : {}),
      ...(String(agentStage || '').trim() ? { agent_stage: String(agentStage || '').trim() } : {}),
      ...(String(agentSummary || '').trim() ? { agent_summary: String(agentSummary || '').trim() } : {}),
      ...(normalizedPercent != null ? { agent_percent: normalizedPercent } : {}),
    }
  );
}

function clearActiveTurn(adapter, {
  requestId,
  streamId,
}) {
  return adapter.clearActiveTurn({
    request_id: requestId,
    stream_id: streamId,
  });
}

function persistUserTurn(adapter, {
  messageId,
  content,
  attachments,
  skill_invocation = null,
  timestamp = new Date().toISOString(),
  model = '',
}) {
  return adapter.appendMessage(
    {
      id: messageId,
      role: 'user',
      content: String(content || ''),
      timestamp,
      client_message_id: String(messageId || ''),
      attachments: normalizeAttachmentMetadataList(attachments),
      skill_invocation,
    },
    { model }
  );
}

function buildAssistantFailureTerminalMutation({
  messageId,
  content = '',
  errorPayload,
  reasoningEntries,
  parentStreamId = '',
  phases = [],
  visibleSegments = [],
  toolSteps = [],
  model = '',
  terminalStatus = 'error',
  terminalSubcode = '',
  timestamp = new Date().toISOString(),
}) {
  const normalizedPayload =
    errorPayload && typeof errorPayload === 'object' ? errorPayload : {};
  const normalizedTerminalStatus = String(terminalStatus || 'runtime_error').trim() || 'runtime_error';
  const normalizedTerminalSubcode = String(terminalSubcode || '').trim();
  const recoveryFields = buildAssistantErrorRecoveryFields(normalizedPayload, {
    terminalStatus: normalizedTerminalStatus,
    terminalSubcode: normalizedTerminalSubcode,
  });
  return {
    messages: [{
      id: messageId,
      role: 'assistant',
      // Partial streamed text is threaded in so a mid-stream failure leaves a
      // durable copy of what the user already saw — the row is the only
      // surviving carrier once the live stream dies.
      content: String(content || ''),
      status: normalizedTerminalStatus,
      terminal_status: normalizedTerminalStatus,
      ...(normalizedTerminalSubcode
        ? { terminal_subcode: normalizedTerminalSubcode }
        : {}),
      stream_error: String(normalizedPayload.message || 'Chat stream failed.'),
      ...(normalizedPayload.error_code ? { error_code: normalizedPayload.error_code } : {}),
      ...(typeof normalizedPayload.retryable === 'boolean'
        ? { retryable: normalizedPayload.retryable }
        : {}),
      ...(normalizedPayload.category ? { category: normalizedPayload.category } : {}),
      ...recoveryFields,
      timestamp,
      finalizedAt: timestamp,
      client_message_id: String(messageId || ''),
      model_used: String(model || ''),
      ...buildAssistantTranscriptFields({
        parentStreamId,
        phases,
        visibleSegments,
        toolSteps,
        reasoningEntries,
      }),
    }],
    preferencePatch: {},
    title: null,
  };
}

function persistAssistantFailure(adapter, options) {
  const mutation = buildAssistantFailureTerminalMutation(options);
  return adapter.appendMessage(mutation.messages[0], { model: options?.model });
}

function buildAssistantCompletionTerminalMutation({
  messageId,
  content,
  reasoningEntries,
  parentStreamId = '',
  phases = [],
  visibleSegments = [],
  toolSteps = [],
  model = '',
  normalizedPreferences,
  normalizedInteractiveResponse,
  exchangeTitle = '',
  resumableStop = null,
  timestamp = new Date().toISOString(),
  includeAssistantMessage = true,
}) {
  const messages = [];
  if (includeAssistantMessage) {
    messages.push({
      id: messageId,
      role: 'assistant',
      content: String(content || ''),
      timestamp,
      finalizedAt: timestamp,
      client_message_id: String(messageId || ''),
      model_used: String(model || ''),
      ...(resumableStop ? { resumable_stop: resumableStop } : {}),
      ...buildAssistantTranscriptFields({
        parentStreamId,
        phases,
        visibleSegments,
        toolSteps,
        reasoningEntries,
      }),
    });
  }
  const roundRecap = buildInteractiveRoundRecap(normalizedInteractiveResponse);
  if (roundRecap) {
    const recapTimestamp = new Date(Date.parse(timestamp) + 1).toISOString();
    messages.push({
      id: `interactive_round_recap_${String(messageId || '').replace(/^assistant_/, '')}`,
      role: 'assistant',
      kind: 'interactive_round_recap',
      content: `Asked ${roundRecap.answer_count} question${roundRecap.answer_count === 1 ? '' : 's'}`,
      timestamp: recapTimestamp,
      finalizedAt: recapTimestamp,
      interactive_round_recap: roundRecap,
      model_used: String(model || ''),
    });
  }
  return {
    messages,
    preferencePatch: buildInteractiveResetPreferences(normalizedPreferences),
    title: String(exchangeTitle || '').trim() || null,
    roundRecap,
  };
}

async function settleAssistantCompletion(adapter, {
  messageId,
  content,
  reasoningEntries,
  parentStreamId = '',
  phases = [],
  visibleSegments = [],
  toolSteps = [],
  model = '',
  requestId = '',
  streamId = '',
  normalizedPreferences,
  normalizedInteractiveResponse,
  exchangeTitle = '',
  resumableStop = null,
  timestamp = new Date().toISOString(),
  persistAssistantMessage = null,
}) {
  const terminalMutation = buildAssistantCompletionTerminalMutation({
    messageId,
    content,
    reasoningEntries,
    parentStreamId,
    phases,
    visibleSegments,
    toolSteps,
    model,
    normalizedPreferences,
    normalizedInteractiveResponse,
    exchangeTitle,
    resumableStop,
    timestamp,
  });
  const persist =
    typeof persistAssistantMessage === 'function'
      ? persistAssistantMessage
      : () => adapter.appendMessage(terminalMutation.messages[0], { model });
  // CTL-002 durable settlement: visible completion has already painted, but
  // the turn is only durably terminal once the store ACCEPTED the persist.
  // Callback contract: a falsy result is a refusal; intentional no-persists
  // (segments already durable, tool-rows-only turn) return a truthy sentinel.
  // On refusal, return a structured degraded result and keep every piece of
  // recovery provenance intact — active_turn stays as the crash-reconciliation
  // bracket, interactive pending state is not reset (its message never
  // persisted), and no title/recap is derived from an unpersisted completion.
  const persistOutcome = await persist({ assistantTimestamp: timestamp });
  if (!persistOutcome) {
    return {
      ok: false,
      reason: 'assistant_persist_refused',
      roundRecap: null,
      assistantTimestamp: timestamp,
    };
  }

  const { roundRecap } = terminalMutation;
  let recapPersisted = true;
  if (roundRecap) {
    const recapTimestamp = new Date(Date.parse(timestamp) + 1).toISOString();
    recapPersisted = Boolean(adapter.appendMessage(
      {
        id: `interactive_round_recap_${String(messageId || '').replace(/^assistant_/, '')}`,
        role: 'assistant',
        kind: 'interactive_round_recap',
        content: `Asked ${roundRecap.answer_count} question${roundRecap.answer_count === 1 ? '' : 's'}`,
        timestamp: recapTimestamp,
        finalizedAt: recapTimestamp,
        interactive_round_recap: roundRecap,
        model_used: String(model || ''),
      },
      { model, updatePreview: false }
    ));
  }

  adapter.setSessionPreferences(terminalMutation.preferencePatch);
  clearActiveTurn(adapter, {
    requestId,
    streamId,
  });
  if (exchangeTitle) {
    await adapter.applySessionTitle(exchangeTitle, { reason: 'complete' });
  }

  return {
    ok: true,
    recapPersisted,
    roundRecap,
    assistantTimestamp: timestamp,
  };
}

async function settleQuestionBatch(adapter, {
  messageId,
  content,
  questionBatch,
  model = '',
  requestId = '',
  streamId = '',
  normalizedPreferences,
  exchangeTitle = '',
  timestamp = new Date().toISOString(),
}) {
  const mutation = buildQuestionBatchTerminalMutation({
    messageId,
    content,
    questionBatch,
    model,
    exchangeTitle,
    timestamp,
  });
  // Same CTL-002 contract as settleAssistantCompletion: a falsy persist result
  // is a refusal — leave active_turn/pending state intact for recovery.
  const persistOutcome = await adapter.appendMessage(mutation.messages[0], { model });
  if (!persistOutcome) {
    return { ok: false, reason: 'question_batch_persist_refused' };
  }
  adapter.setSessionPreferences(mutation.preferencePatch);
  clearActiveTurn(adapter, {
    requestId,
    streamId,
  });
  if (exchangeTitle) {
    await adapter.applySessionTitle(exchangeTitle, { reason: 'complete' });
  }

  return {
    nextRoundCount: mutation.nextRoundCount,
    guardrailExceeded: mutation.guardrailExceeded,
  };
}

function buildQuestionBatchTerminalMutation({
  messageId,
  content,
  questionBatch,
  model = '',
  exchangeTitle = '',
  timestamp = new Date().toISOString(),
}) {
  const nextRoundCount = Math.max(Number(questionBatch?.round_index || 0), 0);
  const guardrailExceeded = nextRoundCount > MAX_INTERACTIVE_ROUNDS;
  return {
    messages: [{
      id: messageId,
      role: 'assistant',
      kind: 'question_batch',
      content: buildInteractiveQuestionBatchTranscript(questionBatch) || String(content || ''),
      interactive_batch: questionBatch,
      timestamp,
      finalizedAt: timestamp,
      model_used: String(model || ''),
    }],
    preferencePatch: {
      pending_question_batch: questionBatch,
      interactive_sequence_state: guardrailExceeded
        ? INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED
        : INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
      interactive_round_count: nextRoundCount,
    },
    title: String(exchangeTitle || '').trim() || null,
    nextRoundCount,
    guardrailExceeded,
  };
}

function clearInteractivePendingState(adapter, normalizedPreferences) {
  return adapter.setSessionPreferences(
    buildInteractiveResetPreferences(normalizedPreferences)
  );
}

module.exports = {
  buildAssistantCompletionTerminalMutation,
  buildAssistantFailureTerminalMutation,
  buildQuestionBatchTerminalMutation,
  buildReasoningPayload,
  createSessionLifecycleAdapter,
  createManagedSessionLifecycleAdapter,
  startActiveTurn,
  touchActiveTurnProgress,
  clearActiveTurn,
  persistUserTurn,
  persistAssistantFailure,
  settleAssistantCompletion,
  settleQuestionBatch,
  clearInteractivePendingState,
};

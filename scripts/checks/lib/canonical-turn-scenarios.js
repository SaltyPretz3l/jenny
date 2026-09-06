'use strict';

const {
  buildCanonicalTurnEvent,
} = require('../../../services/backend/canonical-turn-event');
const {
  CanonicalTurnEventCollector,
} = require('../../../services/backend/canonical-turn-event-collector');
const {
  createManagedChatStreamRuntime,
} = require('../../../services/backend/chat-stream-managed-runtime');
const {
  handleToolNotification,
  waitForToolApproval,
} = require('../../../services/backend/chat-stream-tool-handling');

function createSessionStore() {
  const messagesBySession = new Map();
  const activeTurnsBySession = new Map();

  function messagesFor(sessionId) {
    const key = String(sessionId || '').trim();
    if (!messagesBySession.has(key)) {
      messagesBySession.set(key, []);
    }
    return messagesBySession.get(key);
  }

  return {
    appendMessage(sessionId, message) {
      messagesFor(sessionId).push({ ...message });
      return null;
    },
    updateMessage(sessionId, messageId, patch) {
      const messages = messagesFor(sessionId);
      const target = messages.find(
        (message) => String(message.id || '') === String(messageId || '')
      );
      if (target) {
        Object.assign(target, patch);
      }
      return target || null;
    },
    getSessionMessages(sessionId) {
      return messagesFor(sessionId);
    },
    setSessionPreferences() {
      return null;
    },
    getActiveTurn(sessionId) {
      return activeTurnsBySession.get(String(sessionId || '').trim()) || null;
    },
    setActiveTurn(sessionId, activeTurn) {
      activeTurnsBySession.set(String(sessionId || '').trim(), activeTurn);
      return activeTurn;
    },
    touchActiveTurn(sessionId, _match, patch) {
      const key = String(sessionId || '').trim();
      const activeTurn = activeTurnsBySession.get(key);
      if (!activeTurn) {
        return null;
      }
      const next = { ...activeTurn, ...patch };
      activeTurnsBySession.set(key, next);
      return next;
    },
    clearActiveTurn(sessionId) {
      activeTurnsBySession.delete(String(sessionId || '').trim());
      return null;
    },
  };
}

function createService({ canonicalTurnEvents = true } = {}) {
  const emitted = [];
  const logs = [];
  return {
    currentModel: 'm3-gate-model',
    featureFlags: {
      canonical_turn_events: canonicalTurnEvents,
      stream_envelope_v2: true,
      phase_events: true,
    },
    pendingToolApprovals: new Map(),
    sessionStore: createSessionStore(),
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        emitted.push(payload);
      }
    },
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
    renameSession: async () => null,
    _m3GateEmitted: emitted,
    _m3GateLogs: logs,
  };
}

function createTurn({
  turnIndex,
  metrics,
  canonicalPrimary,
  canonicalTurnEvents = true,
  canonicalBridge,
  notificationFilter = null,
}) {
  const sessionId = `m3-session-${turnIndex}`;
  const streamId = `m3-stream-${turnIndex}`;
  const service = createService({ canonicalTurnEvents });
  const collector = new CanonicalTurnEventCollector({
    turnId: streamId,
    sessionId,
    ...(typeof canonicalPrimary === 'boolean' ? { canonicalPrimary } : {}),
  });
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: sessionId,
    streamId,
    traceId: `m3-trace-${turnIndex}`,
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    guardrailFallbackRequested: false,
    normalizedAttachments: [],
    transcriptPrompt: 'M3 representative prompt',
    userMessageId: `m3-user-${turnIndex}`,
    turnEventCollector: collector,
    turnMetrics: metrics,
    ...(typeof canonicalBridge === 'boolean' ? { canonicalBridge } : {}),
  });
  const toolContext = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'm3-gate-model',
    resolvedSessionId: sessionId,
    streamId,
    eventBase: {
      streamId,
      sessionId,
      model: 'm3-gate-model',
    },
    adapter: runtime.adapter,
    turnEventCollector: collector,
  };
  const approvalController = new AbortController();
  const context = {
    toolContext,
    handleToolNotification,
    notificationFilter,
    requestToolApproval(params) {
      return waitForToolApproval(
        service,
        streamId,
        sessionId,
        streamId,
        params,
        approvalController,
        collector
      );
    },
  };
  return { service, runtime, collector, context, sessionId, streamId };
}

function notify(runtime, method, params, context) {
  if (
    typeof context?.notificationFilter === 'function'
    && context.notificationFilter(method) !== true
  ) {
    return null;
  }
  if (method === 'tool.request_approval') {
    return context.requestToolApproval(params);
  }
  return runtime.handleNotification({ method, params }, context);
}

function canonical(turn, seq, type, payload = {}, extra = {}) {
  return buildCanonicalTurnEvent({
    type,
    turn_id: turn.streamId,
    stream_id: turn.streamId,
    session_id: turn.sessionId,
    seq,
    payload,
    ...extra,
  });
}

async function finishTurn(turn) {
  notify(turn.runtime, 'chat.done', { stop_reason: 'end_turn' }, turn.context);
  await turn.runtime.settleTerminalResult({ status: 'completed' });
}

async function runTextTurn(turn, { content } = {}) {
  const canonicalContent = typeof content === 'string' ? content : 'Hello from canonical.';
  const legacyContent = typeof content === 'string' ? content : 'Hello from legacy.';
  notify(turn.runtime, 'turn.event', canonical(turn, 1, 'text_delta', {
    delta: canonicalContent,
  }), turn.context);
  notify(turn.runtime, 'chat.token', {
    delta: legacyContent,
    sequence: 1,
  }, turn.context);
  await finishTurn(turn);
}

async function runReasoningTurn(turn, { content } = {}) {
  const reasoningContent = String(content?.reasoning || 'Checking the next step.');
  const answerContent = String(content?.answer || 'Reasoned answer.');
  notify(turn.runtime, 'chat.phase_started', {
    phase_id: `${turn.streamId}-reasoning`,
    phase_kind: 'reasoning',
    iteration: 1,
    thinking_id: `${turn.streamId}-thinking`,
    summary: 'Reasoning',
  }, turn.context);
  notify(turn.runtime, 'turn.event', canonical(turn, 1, 'reasoning_delta', {
    delta: reasoningContent,
    persist: true,
  }), turn.context);
  notify(turn.runtime, 'chat.thinking', {
    delta: reasoningContent,
    thinking_id: `${turn.streamId}-thinking`,
    kind: 'reasoning',
    persist: true,
  }, turn.context);
  notify(turn.runtime, 'chat.phase_completed', {
    phase_id: `${turn.streamId}-reasoning`,
    phase_kind: 'reasoning',
    iteration: 1,
    thinking_id: `${turn.streamId}-thinking`,
  }, turn.context);
  notify(turn.runtime, 'chat.phase_started', {
    phase_id: `${turn.streamId}-text`,
    phase_kind: 'text',
    iteration: 1,
    summary: 'Answer',
  }, turn.context);
  notify(turn.runtime, 'turn.event', canonical(turn, 2, 'text_delta', {
    delta: answerContent,
  }), turn.context);
  notify(turn.runtime, 'chat.token', {
    delta: answerContent,
    sequence: 2,
  }, turn.context);
  await finishTurn(turn);
}

async function runToolTurn(turn, { content } = {}) {
  const answerContent = String(content?.answer || 'Tool turn complete.');
  const callId = `${turn.streamId}-tool`;
  notify(turn.runtime, 'turn.event', canonical(turn, 1, 'tool_call_requested', {
    tool_name: 'inspect_harness',
    tool_input: { sections: ['runtime'] },
  }, { tool_call_id: callId }), turn.context);
  notify(turn.runtime, 'tool.executing', {
    tool_call_id: callId,
    tool_name: 'inspect_harness',
    tool_input: { sections: ['runtime'] },
  }, turn.context);
  notify(turn.runtime, 'tool.result', {
    tool_call_id: callId,
    tool_name: 'inspect_harness',
    tool_input: { sections: ['runtime'] },
    output_text: 'runtime ok',
    summary: 'Inspect Harness',
    success: true,
    duration_ms: 1,
  }, turn.context);
  notify(turn.runtime, 'turn.event', canonical(turn, 2, 'text_delta', {
    delta: answerContent,
  }), turn.context);
  notify(turn.runtime, 'chat.token', {
    delta: answerContent,
    sequence: 3,
  }, turn.context);
  await finishTurn(turn);
}

async function runMultiTokenTurn(turn, { content } = {}) {
  const deltas = Array.isArray(content) ? content.map(String) : ['First ', 'second ', 'third.'];
  for (let index = 0; index < deltas.length; index += 1) {
    notify(turn.runtime, 'turn.event', canonical(turn, index + 1, 'text_delta', {
      delta: deltas[index],
    }), turn.context);
    notify(turn.runtime, 'chat.token', {
      delta: deltas[index],
      sequence: index + 1,
    }, turn.context);
  }
  await finishTurn(turn);
}

module.exports = {
  canonical,
  createService,
  createTurn,
  finishTurn,
  notify,
  runMultiTokenTurn,
  runReasoningTurn,
  runTextTurn,
  runToolTurn,
};

const fs = require('node:fs');

async function waitForDiagnosticDump(service, streamId, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = service.serviceLogs.find(
      (log) =>
        log.event === 'chat.turn_diagnostic_dumped'
        && String(log.details?.streamId || '') === String(streamId || '')
    );
    if (entry?.details?.path && fs.existsSync(entry.details.path)) {
      return entry.details.path;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for diagnostic dump for ${streamId}`);
}

const BASE_MANAGED_CHAT_PREFERENCES = Object.freeze({
  preferred_model: 'mock-v1',
  reasoning_effort: 'default',
  conversation_mode: 'chat',
  pending_question_batch: null,
  interactive_sequence_state: 'idle',
  interactive_round_count: 0,
  plan_mode: false,
});

function buildManagedChatRequest(overrides = {}) {
  const {
    normalizedPreferences,
    ...rest
  } = overrides && typeof overrides === 'object' ? overrides : {};
  const prompt = String(rest.prompt || 'Managed chat request');
  return {
    sessionId: 'session_managed_chat_request',
    prompt,
    visiblePrompt: prompt,
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    ...rest,
    normalizedPreferences: {
      ...BASE_MANAGED_CHAT_PREFERENCES,
      ...(normalizedPreferences && typeof normalizedPreferences === 'object'
        ? normalizedPreferences
        : {}),
    },
  };
}

function markManagedSidecarReady(service) {
  service.sidecarManager.process = { pid: 4242 };
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.ollamaManager.ensureRunning = async () => ({
    ready: true,
    started: false,
    external: false,
    skipped: true,
  });
  service.ollamaManager.start = async () => ({
    started: false,
    external: false,
    skipped: true,
  });
  service.ollamaManager.stop = async () => {};
}

function createManagedChatServiceStub(options = {}) {
  const emittedEvents = [];
  const serviceLogs = [];
  const sessionMessages = [];
  const sessionTurnEvents = [];
  const sessionRecords = new Map();
  const createdSessionIds = [];
  const deletedSessionIds = [];
  const configState = {
    followUps: [],
    ...(options.configState && typeof options.configState === 'object' ? options.configState : {}),
  };
  const configCalls = {
    upsertFollowUp: [],
    resolveFollowUp: [],
  };
  return {
    activeStreams: new Map(),
    pendingToolApprovals: new Map(),
    currentModel: 'mock-v1',
    personalityWorkspace: null,
    attachmentAssetStore: null,
    sidecarClient: null,
    featureFlags: {
      ...(options.featureFlags && typeof options.featureFlags === 'object' ? options.featureFlags : {}),
    },
    emittedEvents,
    serviceLogs,
    sessionMessages,
    createdSessionIds,
    deletedSessionIds,
    configCalls,
    configService: {
      getState() {
        return JSON.parse(JSON.stringify(configState));
      },
      upsertFollowUp(payload) {
        configCalls.upsertFollowUp.push(payload);
        const normalizedId = String(payload?.id || '').trim();
        if (!normalizedId) {
          return this.getState();
        }
        const next = {
          ...payload,
          id: normalizedId,
        };
        const existingIndex = configState.followUps.findIndex((followUp) => String(followUp?.id || '').trim() === normalizedId);
        if (existingIndex >= 0) {
          configState.followUps[existingIndex] = {
            ...configState.followUps[existingIndex],
            ...next,
          };
        } else {
          configState.followUps.push(next);
        }
        return this.getState();
      },
      resolveFollowUp(id) {
        configCalls.resolveFollowUp.push(id);
        const normalizedId = String(id || '').trim();
        configState.followUps = configState.followUps.map((followUp) =>
          String(followUp?.id || '').trim() === normalizedId
            ? {
                ...followUp,
                status: 'resolved',
              }
            : followUp
        );
        return this.getState();
      },
    },
    sessionStore: {
      createSessionWithId(sessionId, data = {}) {
        const summary = {
          id: sessionId,
          ...data,
          ...(data.preferences && typeof data.preferences === 'object'
            ? data.preferences
            : {}),
        };
        sessionRecords.set(sessionId, summary);
        createdSessionIds.push(sessionId);
        return summary;
      },
      getSessionMessages() {
        return sessionMessages;
      },
      getSessionTurnEvents() {
        return sessionTurnEvents;
      },
      getSession(sessionId) {
        const current = sessionRecords.get(sessionId) || null;
        if (!current) {
          return null;
        }
        return {
          ...current,
          turn_event_log_version: current.turn_event_log_version || 0,
          turn_event_seq_counter: current.turn_event_seq_counter || sessionTurnEvents.length,
          turn_events: sessionTurnEvents.slice(),
          messages: sessionMessages.slice(),
        };
      },
      getActiveTurn(sessionId) {
        return sessionRecords.get(sessionId)?.active_turn || null;
      },
      setActiveTurn(sessionId, activeTurn) {
        const current = sessionRecords.get(sessionId) || { id: sessionId };
        current.active_turn = activeTurn;
        sessionRecords.set(sessionId, current);
        return current;
      },
      touchActiveTurn(sessionId, match = {}, patch = {}) {
        const current = sessionRecords.get(sessionId) || null;
        const activeTurn = current?.active_turn || null;
        if (
          !activeTurn
          || (match.request_id && activeTurn.request_id !== match.request_id)
          || (match.stream_id && activeTurn.stream_id !== match.stream_id)
        ) {
          return null;
        }
        current.active_turn = {
          ...activeTurn,
          ...patch,
        };
        sessionRecords.set(sessionId, current);
        return current;
      },
      clearActiveTurn(sessionId, match = {}) {
        const current = sessionRecords.get(sessionId) || null;
        const activeTurn = current?.active_turn || null;
        if (
          !activeTurn
          || (match.request_id && activeTurn.request_id !== match.request_id)
          || (match.stream_id && activeTurn.stream_id !== match.stream_id)
        ) {
          return null;
        }
        current.active_turn = null;
        sessionRecords.set(sessionId, current);
        return current;
      },
      appendMessage(_sessionId, message) {
        sessionMessages.push(message);
        // Mirror the real store contract: a truthy summary means ACCEPTED.
        // CTL-002 settle validation treats a falsy return as a refusal.
        return message;
      },
      replaceMessages(_sessionId, messages) {
        sessionMessages.splice(
          0,
          sessionMessages.length,
          ...(Array.isArray(messages) ? messages : [])
        );
      },
      appendTurnEvents(_sessionId, events) {
        const sourceEvents = Array.isArray(events) ? events : [];
        const seen = new Set(sessionTurnEvents.map((event) => String(event?.event_id || '').trim()));
        let nextSeq = sessionTurnEvents.length;
        for (const event of sourceEvents) {
          const eventId = String(event?.event_id || '').trim();
          if (!eventId || seen.has(eventId)) {
            continue;
          }
          sessionTurnEvents.push({
            ...event,
            event_seq: nextSeq,
          });
          seen.add(eventId);
          nextSeq += 1;
        }
        const current = sessionRecords.get(_sessionId) || { id: _sessionId };
        current.turn_event_log_version = sourceEvents.length ? 1 : (current.turn_event_log_version || 0);
        current.turn_event_seq_counter = nextSeq;
        sessionRecords.set(_sessionId, current);
      },
      deleteSession(sessionId) {
        deletedSessionIds.push(sessionId);
        return sessionRecords.delete(sessionId);
      },
      updateMessage(_sessionId, messageId, patch = {}) {
        const targetId = String(messageId || '').trim();
        if (!targetId) {
          return null;
        }
        const index = sessionMessages.findIndex(
          (message) => String(message?.id || '').trim() === targetId
        );
        if (index < 0) {
          return null;
        }
        sessionMessages[index] = {
          ...sessionMessages[index],
          ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}),
          id: sessionMessages[index].id,
          timestamp: sessionMessages[index].timestamp,
        };
        return sessionMessages[index];
      },
      truncateAfterMessage(sessionId, messageId, options = {}) {
        const current = sessionRecords.get(sessionId) || null;
        const targetId = String(messageId || '').trim();
        const targetIndex = sessionMessages.findIndex(
          (message) => String(message?.id || '').trim() === targetId
        );
        const target = sessionMessages[targetIndex];
        if (!current || targetIndex < 0 || target?.role !== 'user') {
          return null;
        }
        const replacement = {
          ...target,
          ...(typeof options.replaceMessageContent === 'string'
            ? { content: options.replaceMessageContent }
            : {}),
          ...(Array.isArray(options.replaceMessageAttachments)
            ? { attachments: options.replaceMessageAttachments }
            : {}),
          id: target.id,
          timestamp: target.timestamp,
        };
        sessionMessages.splice(targetIndex, sessionMessages.length - targetIndex, replacement);
        if (options.preserveActiveTurn !== true) {
          current.active_turn = null;
        }
        sessionRecords.set(sessionId, current);
        return current;
      },
      setTurnIdentity(sessionId, identity) {
        // Direct-runtime tests pass an existing session id without exercising
        // the higher-level create call; model that durable row here.
        const current = sessionRecords.get(sessionId) || { id: sessionId };
        Object.assign(current, identity);
        sessionRecords.set(sessionId, current);
        return current;
      },
      setSessionPreferences(sessionId, preferences = {}) {
        const current = sessionRecords.get(sessionId) || null;
        if (!current) {
          return null;
        }
        Object.assign(current, preferences);
        sessionRecords.set(sessionId, current);
        return current;
      },
      flushSession() {
        return true;
      },
    },
    emit(eventName, payload) {
      emittedEvents.push({ eventName, payload });
    },
    _emitServiceLog(level, event, details) {
      serviceLogs.push({ level, event, details });
    },
    async _resolveModel() {
      return 'mock-v1';
    },
    async recallApprovedMemories() {
      return { memories: [] };
    },
    async recallRecentApprovedMemories() {
      return { memories: [] };
    },
    async setSessionPreferences() {},
    async renameSession() {},
    async _restartManagedSidecar() {},
  };
}

module.exports = {
  BASE_MANAGED_CHAT_PREFERENCES,
  buildManagedChatRequest,
  createManagedChatServiceStub,
  markManagedSidecarReady,
  waitForDiagnosticDump,
};

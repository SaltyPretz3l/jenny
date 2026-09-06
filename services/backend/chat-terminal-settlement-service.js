'use strict';

const {
  buildTerminalTranscriptPreview,
} = require('./chat-stream-terminal-preview');
const {
  normalizeTerminalMutations,
} = require('./chat-stream-terminal-tool-repairs');
const {
  planTerminalToolRepairs,
} = require('./chat-terminal-tool-repair-planner');
const { normalizeId } = require('../shared/normalize');

function resolveConversationPort(service, rawStore) {
  if (rawStore?.conversationStore?.commitTerminal) return rawStore.conversationStore;
  if (rawStore?.commitTerminal) return rawStore;
  if (service?.conversationStore?.commitTerminal) return service.conversationStore;
  return null;
}

function buildTerminalEvents({
  collector,
  identity,
  currentMessages,
  messages,
  toolRepairs,
  timestamp,
}) {
  const normalized = normalizeTerminalMutations(
    messages,
    toolRepairs,
    identity,
    timestamp
  );
  if (!normalized.ok) return normalized;
  const preview = buildTerminalTranscriptPreview(currentMessages, {
    messages: normalized.messages,
    toolRepairs: normalized.toolRepairs,
  });
  if (!preview.ok) return preview;
  if (!collector) {
    return { ok: true, turnEvents: [], previewMessages: preview.messages };
  }
  collector.flushJournalEvents?.();
  const finalized = collector.buildFinalizedTurnEvents?.(
    identity.turnId,
    preview.messages
  );
  return {
    ok: true,
    turnEvents: Array.isArray(finalized) ? finalized : [],
    previewMessages: preview.messages,
  };
}

async function settleTerminalMutation(service, {
  lease,
  rawStore,
  terminal,
  messages = [],
  toolRepairs = null,
  preferencePatch = {},
  title = null,
  turnEventCollector = null,
} = {}) {
  const coordinator = service?.terminalCoordinator;
  const identity = lease?.identity;
  const store = resolveConversationPort(service, rawStore || lease?.store);
  if (!coordinator?.settle || !identity || !store) {
    return { handled: false, result: null, previewMessages: [] };
  }
  const timestamp = normalizeId(terminal?.timestamp) || new Date().toISOString();
  const currentMessages = store.getSessionMessages?.(identity.sessionId) || [];
  const plannedRepairs = toolRepairs == null
    ? planTerminalToolRepairs(currentMessages, identity.streamId, {
        model: terminal?.model,
        terminalState: terminal?.kind || terminal?.status,
      })
    : { ok: true, repairs: toolRepairs };
  if (!plannedRepairs.ok) {
    service?._emitServiceLog?.('ERROR', 'lifecycle.terminal_tool_repair_plan_refused', {
      sessionId: identity.sessionId,
      streamId: identity.streamId,
      reason: plannedRepairs.reason,
    });
    const result = typeof coordinator.settlePreparationRefusal === 'function'
      ? await coordinator.settlePreparationRefusal({
          lease,
          identity,
          store,
          terminal: { ...terminal, timestamp },
          messages,
          toolRepairs: [],
          turnEvents: [],
          preferencePatch,
          title,
        }, plannedRepairs.reason, { requiresToolReplan: true })
      : {
          ok: false,
          visibleTerminal: false,
          durableTerminal: false,
          reason: plannedRepairs.reason,
          persistedMessageIds: [],
          repairDurable: null,
          artifactId: null,
        };
    return { handled: true, result, previewMessages: [] };
  }
  const effectiveRepairs = plannedRepairs.repairs;
  const prepared = buildTerminalEvents({
    collector: turnEventCollector,
    identity,
    currentMessages,
    messages,
    toolRepairs: effectiveRepairs,
    timestamp,
  });
  if (!prepared.ok) {
    const result = await coordinator.settle({
      lease,
      identity,
      store,
      terminal: { ...terminal, timestamp },
      messages,
      toolRepairs: effectiveRepairs,
      turnEvents: [],
      preferencePatch,
      title,
    });
    return { handled: true, result, previewMessages: [] };
  }
  const result = await coordinator.settle({
    lease,
    identity,
    store,
    terminal: { ...terminal, timestamp },
    messages,
    toolRepairs: effectiveRepairs,
    turnEvents: prepared.turnEvents,
    preferencePatch,
    title,
  });
  return { handled: true, result, previewMessages: prepared.previewMessages };
}

module.exports = {
  buildTerminalEvents,
  resolveConversationPort,
  settleTerminalMutation,
};

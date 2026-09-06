'use strict';

const {
  buildAssistantCompletionTerminalMutation,
  buildAssistantFailureTerminalMutation,
  buildQuestionBatchTerminalMutation,
} = require('./chat-stream-session-lifecycle');
const { settleTerminalMutation } = require('./chat-terminal-settlement-service');
const {
  buildTerminalErrorPayload,
  enrichTerminalErrorPayloadForEmit,
} = require('./chat-stream-terminal-utils');
const { buildInteractiveQuestionBatchVisibleText } = require('./interactive-session-utils');

function supportsManagedTerminalCoordinator(ctx) {
  return Boolean(
    ctx?.service?.terminalCoordinator?.settle
    && ctx?.turnLease?.identity
  );
}

async function settleMutation(ctx, {
  kind,
  mutation,
  rendererPayload,
  questionBatch = null,
  repairMessage = null,
  preexistingRefusalReason = '',
  timestamp,
} = {}) {
  ctx.emitThinkingStatus?.('');
  if (ctx.unfinishedToolRepairFailure) {
    ctx.terminalCoordinatorHandled = true;
    ctx.terminalPersistRefused = true;
    return {
      handled: true,
      result: {
        ok: false,
        visibleTerminal: false,
        durableTerminal: false,
        reason: ctx.unfinishedToolRepairFailure,
        persistedMessageIds: [],
        repairDurable: null,
        artifactId: null,
      },
    };
  }
  const settled = await settleTerminalMutation(ctx.service, {
    lease: ctx.turnLease,
    rawStore: ctx.turnLease.store,
    terminal: {
      kind,
      model: ctx.model,
      timestamp,
      rendererPayload,
      ...(questionBatch ? { questionBatch } : {}),
      ...(repairMessage ? { repairMessage } : {}),
      ...(preexistingRefusalReason ? { preexistingRefusalReason } : {}),
    },
    messages: mutation.messages,
    toolRepairs: ctx.unfinishedToolRepairs,
    preferencePatch: mutation.preferencePatch,
    title: mutation.title,
    turnEventCollector: ctx.turnEventCollector,
  });
  if (settled.handled) {
    ctx.terminalCoordinatorHandled = true;
    ctx.terminalPersistRefused = settled.result?.durableTerminal !== true;
  }
  return settled;
}

function completionMessageShape(ctx) {
  if (ctx.hasPersistedSegments || ctx.refusedTextSegments?.length) {
    const phases = Array.isArray(ctx.transcriptCollector?.slice?.phases)
      ? ctx.transcriptCollector.slice.phases
      : [];
    const hasTrailingReasoning = phases.some(
      (phase) => String(phase?.phase_kind || '') === 'reasoning'
    );
    if (!String(ctx.currentSegmentText || '').trim() && !hasTrailingReasoning) return null;
    return {
      id: `assistant_${ctx.streamId}_seg${ctx.textSegmentIndex}`,
      content: ctx.currentSegmentText,
      reasoning: [],
    };
  }
  if (!String(ctx.assistantText || '').trim()) return null;
  return { id: ctx.assistantBaseMessageId, content: ctx.assistantText, reasoning: ctx.reasoningEntries };
}

// Ownership parity with persistCurrentTextSegment: reasoning streams before the
// segment message it lands in exists, so live capture points at the synthetic
// base assistant id. The boundary-segment path retargets onto the real id once
// the append lands; this path mints the FINAL segment id itself and must do the
// same, or the durable reasoning_phase event anchors to an id no message carries
// and the reload projection falls back to event_seq -- ordering the final
// thought BELOW the final answer.
function retargetSettledSliceReasoning(ctx, messageId) {
  const collector = ctx.turnEventCollector;
  const targetId = String(messageId || '').trim();
  if (!targetId || typeof collector?.retargetCapturedEvents !== 'function') return 0;
  // A non-segmented completion already owns its reasoning. Returning early keeps
  // it a true no-op: retargetCapturedEvents SEALS an event before it checks for
  // a same-id target, and sealing correctly-owned events buys nothing.
  if (targetId === ctx.assistantBaseMessageId) return 0;
  const phases = Array.isArray(ctx.transcriptCollector?.slice?.phases)
    ? ctx.transcriptCollector.slice.phases
    : [];
  const phaseIds = phases
    .filter((phase) => String(phase?.phase_kind || '') === 'reasoning')
    .map((phase) => String(phase?.phase_id || ''))
    .filter(Boolean);
  if (!phaseIds.length) return 0;
  return collector.retargetCapturedEvents(ctx.streamId, { phaseIds, messageId: targetId });
}

async function settleManagedAssistantCompletion(ctx) {
  ctx.settleUnfinishedToolRows?.('terminal_complete');
  const timestamp = new Date().toISOString();
  ctx.transcriptCollector.completeCurrentPhase({}, timestamp);
  const assistant = completionMessageShape(ctx);
  // Must precede settleMutation: settleTerminalMutation serializes the captured
  // events (flushJournalEvents + buildFinalizedTurnEvents) BEFORE it calls
  // coordinator.settle, so a retarget after it never reaches disk. Both the
  // message and the events go to that one settle, so they land or fail together.
  if (assistant) retargetSettledSliceReasoning(ctx, assistant.id);
  const mutation = buildAssistantCompletionTerminalMutation({
    messageId: assistant?.id || ctx.assistantBaseMessageId,
    content: assistant?.content || '',
    reasoningEntries: assistant?.reasoning || [],
    parentStreamId: ctx.streamId,
    phases: ctx.transcriptCollector.slice.phases,
    visibleSegments: ctx.transcriptCollector.slice.visibleSegments,
    toolSteps: ctx.transcriptCollector.slice.toolSteps,
    model: ctx.model,
    normalizedPreferences: ctx.normalizedPreferences,
    normalizedInteractiveResponse: ctx.normalizedInteractiveResponse,
    exchangeTitle: ctx.exchangeTitle,
    resumableStop: ctx.resumableStop,
    timestamp,
    includeAssistantMessage: Boolean(assistant),
  });
  const refusedSegments = Array.isArray(ctx.refusedTextSegments)
    ? ctx.refusedTextSegments.map((message) => ({ ...message }))
    : [];
  if (refusedSegments.length) mutation.messages = [...refusedSegments, ...mutation.messages];
  const canonicalAssistant = mutation.messages.find((message) => message.id === assistant?.id)
    || mutation.messages[mutation.messages.length - 1]
    || null;
  const repairContent = mutation.messages.map((message) => String(message?.content || '')).join('');
  const repairMessage = canonicalAssistant && repairContent.trim()
    ? { ...canonicalAssistant, content: repairContent }
    : null;
  const settled = await settleMutation(ctx, {
    kind: 'complete',
    mutation,
    timestamp,
    repairMessage,
    rendererPayload: {
      type: 'complete',
      content: ctx.assistantText,
      ...(ctx.turnUsage ? { usage: ctx.turnUsage } : {}),
      ...(ctx.resumableStop ? { resumableStop: ctx.resumableStop } : {}),
      ...ctx.eventBase,
    },
  });
  if (settled.handled) {
    if (assistant) ctx.visibleAssistantMessageId = assistant.id;
    ctx.visibleCompletionEmitted = settled.result?.visibleTerminal === true;
    ctx.transcriptCollector.resetSlice();
    if (ctx.visibleCompletionEmitted) ctx.onVisibleCompletion?.({
      sessionId: ctx.resolvedSessionId,
      messageId: ctx.visibleAssistantMessageId,
      content: ctx.assistantText,
      model: ctx.model,
      usage: ctx.turnUsage,
    });
  }
  return settled;
}

async function settleManagedQuestionBatch(ctx, questionBatch) {
  const timestamp = new Date().toISOString();
  const mutation = buildQuestionBatchTerminalMutation({
    messageId: `question_batch_${ctx.streamId}`,
    content: buildInteractiveQuestionBatchVisibleText(questionBatch),
    questionBatch,
    model: ctx.model,
    exchangeTitle: ctx.exchangeTitle,
    timestamp,
  });
  const settled = await settleMutation(ctx, {
    kind: 'question_batch', mutation, questionBatch, timestamp,
    rendererPayload: { type: 'question_batch', batch: questionBatch, ...ctx.eventBase },
  });
  const effectiveBatch = ctx.turnLease?.terminalCoordinatorRequest?.terminal?.questionBatch;
  return { ...settled, questionBatch: effectiveBatch || questionBatch };
}

async function settleManagedFailureTerminal(ctx, errorPayload, terminal) {
  ctx.settleUnfinishedToolRows?.(`terminal_${terminal?.status || 'error'}`);
  const timestamp = new Date().toISOString();
  const shouldPersist = ctx.userMessagePersisted
    && !ctx.visibleCompletionEmitted
    && !ctx.streamSawBatch
    && terminal?.persistAssistantFailure;
  const mutation = shouldPersist
    ? buildAssistantFailureTerminalMutation({
        messageId: ctx.assistantBaseMessageId,
        content: ctx.currentSegmentText,
        errorPayload,
        reasoningEntries: ctx.reasoningEntries,
        parentStreamId: ctx.streamId,
        phases: ctx.transcriptCollector.slice.phases,
        visibleSegments: ctx.transcriptCollector.slice.visibleSegments,
        toolSteps: ctx.transcriptCollector.slice.toolSteps,
        model: ctx.model,
        terminalStatus: terminal.status,
        terminalSubcode: terminal.terminalSubcode,
        timestamp,
      })
    : { messages: [], preferencePatch: {}, title: null };
  const canonicalAssistant = mutation.messages[0] || null;
  const repairMessage = canonicalAssistant && String(ctx.assistantText || '').trim()
    ? { ...canonicalAssistant, content: ctx.assistantText }
    : null;
  const normalizedPayload = buildTerminalErrorPayload(errorPayload, terminal?.status);
  const settled = await settleMutation(ctx, {
    kind: terminal?.status,
    mutation,
    timestamp,
    repairMessage,
    rendererPayload: {
      type: 'error',
      ...(ctx.turnUsage ? { usage: ctx.turnUsage } : {}),
      ...enrichTerminalErrorPayloadForEmit(normalizedPayload, {
        terminalStatus: terminal?.status,
        terminalSubcode: terminal?.terminalSubcode,
      }),
      ...ctx.eventBase,
    },
  });
  if (settled.handled) ctx.transcriptCollector.resetSlice();
  return settled;
}

module.exports = {
  settleManagedAssistantCompletion,
  settleManagedFailureTerminal,
  settleManagedQuestionBatch,
  supportsManagedTerminalCoordinator,
};

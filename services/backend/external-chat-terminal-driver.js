'use strict';

const {
  buildAssistantCompletionTerminalMutation,
  buildAssistantFailureTerminalMutation,
  buildQuestionBatchTerminalMutation,
} = require('./chat-stream-session-lifecycle');
const {
  settleTerminalMutation,
} = require('./chat-terminal-settlement-service');
const {
  appendPersistedReasoningEntry,
} = require('./chat-stream-reasoning');

const MAX_EXTERNAL_LIVE_CONTENT_BYTES = 256 * 1024;
const MAX_EXTERNAL_LIVE_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_EXTERNAL_LIVE_TRANSCRIPT_ITEMS = 128;

function clipUtf8(value, maxBytes) {
  const buffer = Buffer.from(String(value || ''), 'utf8');
  if (buffer.length <= maxBytes) return buffer.toString('utf8');
  return buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}

function boundedReasoningEntries(entries) {
  let bounded = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const appended = appendPersistedReasoningEntry(
      bounded,
      entry?.text,
      entry?.timestamp,
      { thinkingId: entry?.thinkingId || entry?.thinking_id }
    );
    bounded = appended.entries;
    if (appended.truncated) break;
  }
  return bounded;
}

function boundedTranscriptFields(value, content) {
  const source = value && typeof value === 'object' ? value : {};
  let remainingVisibleBytes = MAX_EXTERNAL_LIVE_CONTENT_BYTES;
  const visibleSegments = [];
  for (const segment of (Array.isArray(source.visible_segments)
    ? source.visible_segments : []).slice(0, MAX_EXTERNAL_LIVE_TRANSCRIPT_ITEMS)) {
    if (remainingVisibleBytes <= 0) break;
    const text = clipUtf8(segment?.text, remainingVisibleBytes);
    remainingVisibleBytes -= Buffer.byteLength(text, 'utf8');
    visibleSegments.push({
      segment_id: clipUtf8(segment?.segment_id, 256),
      phase_id: clipUtf8(segment?.phase_id, 256),
      text,
    });
  }
  const phases = (Array.isArray(source.phases) ? source.phases : [])
    .slice(0, MAX_EXTERNAL_LIVE_TRANSCRIPT_ITEMS)
    .map((phase) => ({
      phase_id: clipUtf8(phase?.phase_id, 256),
      phase_kind: clipUtf8(phase?.phase_kind, 64),
      iteration: Math.max(0, Number(phase?.iteration || 0) || 0),
      thinking_id: clipUtf8(phase?.thinking_id, 256),
      tool_call_id: clipUtf8(phase?.tool_call_id, 256),
      tool_name: clipUtf8(phase?.tool_name, 256),
      render_collapsed: phase?.render_collapsed === true,
      started_at: clipUtf8(phase?.started_at, 64),
      completed_at: clipUtf8(phase?.completed_at, 64),
      ...(Array.isArray(phase?.entries)
        ? { entries: boundedReasoningEntries(phase.entries) } : {}),
    }));
  const toolSteps = (Array.isArray(source.tool_steps) ? source.tool_steps : [])
    .slice(0, MAX_EXTERNAL_LIVE_TRANSCRIPT_ITEMS)
    .map((step) => ({
      call_id: clipUtf8(step?.call_id, 256),
      tool_name: clipUtf8(step?.tool_name, 256),
      tool_use_message_id: clipUtf8(step?.tool_use_message_id, 256),
      tool_result_message_id: clipUtf8(step?.tool_result_message_id, 256),
      status: clipUtf8(step?.status, 64),
    }));
  return {
    phases,
    visible_segments: visibleSegments.length || !content ? visibleSegments : [{
      segment_id: 'segment_external_partial_1', phase_id: '', text: content,
    }],
    tool_steps: toolSteps,
  };
}

function createExternalTranscriptSnapshot() {
  let current = { content: '', reasoningEntries: [], assistantTranscript: null };
  let observed = null;
  function normalize(value = {}) {
    observed = null;
    const content = clipUtf8(value.content, MAX_EXTERNAL_LIVE_CONTENT_BYTES);
    const next = {
      content,
      reasoningEntries: boundedReasoningEntries(value.reasoningEntries),
      assistantTranscript: boundedTranscriptFields(value.assistantTranscript, content),
    };
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_EXTERNAL_LIVE_SNAPSHOT_BYTES) {
      next.assistantTranscript = boundedTranscriptFields(null, content);
    }
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_EXTERNAL_LIVE_SNAPSHOT_BYTES) {
      next.content = clipUtf8(content, 32 * 1024);
      next.reasoningEntries = [];
      next.assistantTranscript = boundedTranscriptFields(null, next.content);
    }
    current = next;
  }
  return {
    capture(value = {}) {
      normalize(value);
    },
    observe(value = {}) {
      observed = value;
    },
    read() {
      if (observed) normalize(observed);
      return structuredClone(current);
    },
  };
}

function terminalEvent(type, eventBase, payload = {}) {
  return { type, ...payload, ...eventBase };
}

async function applyRemoteTitleAfterDurable(service, sessionId, title, result) {
  if (!title || result?.durableTerminal !== true || typeof service?.renameSession !== 'function') {
    return;
  }
  try {
    await service.renameSession(sessionId, title);
  } catch (error) {
    service?._emitServiceLog?.('WARN', 'chat.session_title_update_failed', {
      sessionId,
      reason: 'complete',
      message: String(error?.message || error),
    });
  }
}

async function settleExternalQuestionBatch(service, {
  lease,
  rawStore,
  turnEventCollector,
  eventBase,
  questionBatch,
  content,
  model,
  exchangeTitle,
  timestamp = new Date().toISOString(),
} = {}) {
  const mutation = buildQuestionBatchTerminalMutation({
    messageId: `question_batch_${lease.identity.streamId}`,
    content,
    questionBatch,
    model,
    exchangeTitle,
    timestamp,
  });
  const settled = await settleTerminalMutation(service, {
    lease,
    rawStore,
    terminal: {
      kind: 'question_batch',
      questionBatch,
      model,
      timestamp,
      rendererPayload: terminalEvent('question_batch', eventBase, { batch: questionBatch }),
    },
    messages: mutation.messages,
    preferencePatch: mutation.preferencePatch,
    title: mutation.title,
    turnEventCollector,
  });
  if (settled.handled) {
    await applyRemoteTitleAfterDurable(
      service,
      lease.identity.sessionId,
      mutation.title,
      settled.result
    );
  }
  return settled;
}

async function settleExternalCompletion(service, {
  lease,
  rawStore,
  turnEventCollector,
  eventBase,
  content,
  reasoningEntries,
  assistantTranscript,
  model,
  normalizedPreferences,
  normalizedInteractiveResponse,
  exchangeTitle,
  timestamp = new Date().toISOString(),
} = {}) {
  const mutation = buildAssistantCompletionTerminalMutation({
    messageId: `assistant_${lease.identity.streamId}`,
    content,
    reasoningEntries,
    parentStreamId: lease.identity.streamId,
    phases: assistantTranscript?.phases,
    visibleSegments: assistantTranscript?.visible_segments,
    toolSteps: assistantTranscript?.tool_steps,
    model,
    normalizedPreferences,
    normalizedInteractiveResponse,
    exchangeTitle,
    timestamp,
  });
  const settled = await settleTerminalMutation(service, {
    lease,
    rawStore,
    terminal: {
      kind: 'complete',
      model,
      timestamp,
      rendererPayload: terminalEvent('complete', eventBase, { content }),
    },
    messages: mutation.messages,
    preferencePatch: mutation.preferencePatch,
    title: mutation.title,
    turnEventCollector,
  });
  if (settled.handled) {
    await applyRemoteTitleAfterDurable(
      service,
      lease.identity.sessionId,
      mutation.title,
      settled.result
    );
  }
  return settled;
}

async function settleExternalFailure(service, {
  lease,
  rawStore,
  turnEventCollector,
  eventBase,
  errorPayload,
  terminal,
  content,
  reasoningEntries,
  assistantTranscript,
  model,
  timestamp = new Date().toISOString(),
} = {}) {
  const messages = terminal?.persistAssistantFailure
      ? buildAssistantFailureTerminalMutation({
        messageId: `assistant_${lease.identity.streamId}`,
        content,
        errorPayload,
        reasoningEntries,
        parentStreamId: lease.identity.streamId,
        phases: assistantTranscript?.phases,
        visibleSegments: assistantTranscript?.visible_segments,
        toolSteps: assistantTranscript?.tool_steps,
        model,
        terminalStatus: terminal.status,
        terminalSubcode: terminal.terminalSubcode,
        timestamp,
      }).messages
    : [];
  const emitError = terminal?.emitErrorEvent || terminal?.status === 'denied';
  return settleTerminalMutation(service, {
    lease,
    rawStore,
    terminal: {
      kind: terminal?.status,
      model,
      timestamp,
      rendererPayload: emitError
        ? terminalEvent('error', eventBase, errorPayload)
        : terminalEvent('error', eventBase, {
            message: String(errorPayload?.message || 'Chat stream failed.'),
            status: terminal?.status,
          }),
    },
    messages,
    turnEventCollector,
  });
}

module.exports = {
  MAX_EXTERNAL_LIVE_SNAPSHOT_BYTES,
  createExternalTranscriptSnapshot,
  settleExternalCompletion,
  settleExternalFailure,
  settleExternalQuestionBatch,
};

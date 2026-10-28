'use strict';

// A createStreamToolHandlers rig over one session holding a running call-1 tool_use
// row; it records scheduled live patches, renders, message writes and summary patches.
const { createStreamToolHandlers } = require('../../renderer/chat/renderer-stream-handler-tools');

function createToolHandlerHarness(options = {}) {
  const initialToolName = options.initialToolName || 'Read';
  const messagesBySession = new Map([[
    'session-1',
    [{
      id: 'tool_use_call-1',
      role: 'assistant',
      content: 'Reading',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call-1',
        approval_id: '',
        tool_name: initialToolName,
        input: { path: 'README.md' },
        input_json: '{"path":"README.md"}',
        summary: 'Reading',
        status: 'running',
        parent_stream_id: 'stream-1',
      },
      status: 'complete',
    }],
  ]]);
  const state = {
    pendingStreams: options.pendingStreams || new Map(),
    toolCallsByStream: new Map([[
      'stream-1',
      [{ callId: 'call-1', toolName: initialToolName, status: 'running', input: { path: 'README.md' }, summary: 'Reading' }],
    ]]),
    pendingToolApprovals: new Map(),
    sessions: options.sessions || [],
  };
  const scheduledPatches = [];
  const renderCalls = [];
  const operationOrder = [];
  const sessionPatches = [];
  const messageWrites = [];
  const handlers = createStreamToolHandlers({
    state,
    streamSegmentState: options.streamSegmentState || new Map(),
    getSessionMessages(sessionId) {
      return messagesBySession.get(sessionId) || [];
    },
    setSessionMessages(sessionId, messages) {
      messageWrites.push(sessionId);
      messagesBySession.set(sessionId, messages);
    },
    createNormalizedMessage(role, content, extra = {}) {
      return { id: extra.id || `${role}_message`, role, content, ...extra };
    },
    releaseApprovalToastSessions() {},
    clearSessionComposerNotice() {},
    patchSessionSummary(sessionId, patch) { sessionPatches.push({ sessionId, patch }); },
    queueSessionRender(sessionId, flags) {
      operationOrder.push('render');
      renderCalls.push({ sessionId, flags });
    },
    isCurrentSession() { return true; },
    isRowModelEnabled() { return true; },
    applyLiveTurnPayload() { return null; },
    noteTimelineMessageCreated() {},
    invalidateProjectionStateForSession(sessionId) {
      operationOrder.push('invalidate');
      return sessionId ? 1 : 0;
    },
    scheduleLiveToolPatch(payload, details) {
      scheduledPatches.push({ payload, details });
      if (options.patchThrows === true) {
        throw new Error('patch scheduler unavailable');
      }
      return options.patchAccepted === true;
    },
    MESSAGE_STATUS: { COMPLETE: 'complete' },
  });
  return { handlers, state, messagesBySession, messageWrites, operationOrder, renderCalls, scheduledPatches, sessionPatches };
}

module.exports = { createToolHandlerHarness };

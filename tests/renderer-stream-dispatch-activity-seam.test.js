// File Map Living Atlas seam (W3): the dispatch router fans stream payloads
// to an injected handleWorkspaceActivityStreamEvent callback the SAME way it
// already fans them to handlePresenceStreamEvent (see
// renderer-stream-handler-dispatch-gate.test.js for the presence precedent
// this harness mirrors). Covers: which types reach the callback, which don't,
// throw-isolation + the WARN log, and byte-identical behavior when the
// callback is absent.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createStreamDispatchRouter } = require('../renderer/chat/renderer-stream-handler-dispatch');
const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');

function buildRouterHarness({ handleWorkspaceActivityStreamEvent } = {}) {
  const controller = createMultiStreamController({ getState: () => ({}) });
  const logs = [];
  const invocations = [];
  const record = (name) => async (payload) => {
    invocations.push({ name, streamId: String(payload?.streamId || '') });
    return { buffered: false, terminal: name === 'handleComplete' || name === 'handleError' };
  };
  const handlers = {
    handleStarted: record('handleStarted'),
    handleThinkingStatus: record('handleThinkingStatus'),
    handlePhaseStarted: record('handlePhaseStarted'),
    handlePhaseCompleted: record('handlePhaseCompleted'),
    handleAgentStatus: record('handleAgentStatus'),
    handleToolUse: record('handleToolUse'),
    handleApprovalNeeded: record('handleApprovalNeeded'),
    handleUserQuestionsRequested: record('handleUserQuestionsRequested'),
    handleToolResult: record('handleToolResult'),
    handleStreamReset: record('handleStreamReset'),
    handleContextCompacted: record('handleContextCompacted'),
    handleDelta: record('handleDelta'),
    handleQuestionBatch: record('handleQuestionBatch'),
    handleMessageUpdated: record('handleMessageUpdated'),
    handleComplete: record('handleComplete'),
    handleError: record('handleError'),
  };
  const router = createStreamDispatchRouter({
    state: {},
    normalizeId: (value) => String(value || '').trim(),
    normalizeString: (value) => String(value || '').trim(),
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
    handlers,
    handleWorkspaceActivityStreamEvent,
    isRenderableBufferedStreamEvent: () => false,
    waitForRenderFrame: async () => {},
    isStreamFinalized: (streamId) => controller.isStreamFinalized(streamId),
    isStreamTerminalSettled: (streamId) => controller.isStreamTerminalSettled(streamId),
    markStreamTerminalSettled: (streamId) => controller.markStreamTerminalSettled(streamId),
  });
  const activityFailedLogs = () => logs.filter((entry) => entry.event === 'stream.activity_event_failed');
  return { router, controller, handlers, invocations, logs, activityFailedLogs };
}

test('tool_use / tool_approval_needed / user_questions_requested / tool_result / complete / error reach the injected activity callback', async () => {
  const activityPayloads = [];
  const harness = buildRouterHarness({
    handleWorkspaceActivityStreamEvent: (payload) => activityPayloads.push(payload),
  });

  await harness.router.handleStreamPayload({
    type: 'tool_use', sessionId: 'session-1', streamId: 'stream-1', toolName: 'read_file', input: { path: 'a.js' },
  });
  await harness.router.handleStreamPayload({
    type: 'tool_approval_needed', sessionId: 'session-1', streamId: 'stream-1', toolName: 'write_file',
  });
  await harness.router.handleStreamPayload({
    type: 'user_questions_requested', sessionId: 'session-1', streamId: 'stream-1', toolName: 'ask_user',
    callId: 'call-question', questionRef: 'question-ref', questions: [],
  });
  await harness.router.handleStreamPayload({
    type: 'tool_result', sessionId: 'session-1', streamId: 'stream-1', toolCallId: 'call-1',
  });
  await harness.router.handleStreamPayload({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-1',
  });

  const harness2 = buildRouterHarness({
    handleWorkspaceActivityStreamEvent: (payload) => activityPayloads.push(payload),
  });
  await harness2.router.handleStreamPayload({
    type: 'error', sessionId: 'session-2', streamId: 'stream-2', message: 'boom',
  });

  const types = activityPayloads.map((p) => p.type);
  assert.deepEqual(types, ['tool_use', 'tool_approval_needed', 'user_questions_requested', 'tool_result', 'complete', 'error']);
  assert.equal(activityPayloads[0].streamId, 'stream-1');
  assert.equal(activityPayloads[0].toolName, 'read_file');
  assert.equal(activityPayloads[5].streamId, 'stream-2');
});

test('delta and started do NOT reach the activity callback', async () => {
  const activityPayloads = [];
  const harness = buildRouterHarness({
    handleWorkspaceActivityStreamEvent: (payload) => activityPayloads.push(payload),
  });

  await harness.router.handleStreamPayload({ type: 'started', sessionId: 'session-1', streamId: 'stream-1' });
  await harness.router.handleStreamPayload({ type: 'delta', sessionId: 'session-1', streamId: 'stream-1', content: 'hi' });

  assert.deepEqual(activityPayloads, []);
});

test('a throwing activity callback never breaks the handler result and logs the WARN', async () => {
  const harness = buildRouterHarness({
    handleWorkspaceActivityStreamEvent: () => { throw new Error('activity bus exploded'); },
  });

  const result = await harness.router.handleStreamPayload({
    type: 'tool_use', sessionId: 'session-1', streamId: 'stream-1', toolName: 'read_file', input: { path: 'a.js' },
  });

  assert.equal(harness.invocations.length, 1, 'the tool_use handler still ran');
  assert.equal(result.buffered, false);
  const failedLogs = harness.activityFailedLogs();
  assert.equal(failedLogs.length, 1);
  assert.equal(failedLogs[0].level, 'WARN');
  assert.equal(failedLogs[0].details.type, 'tool_use');
  assert.equal(failedLogs[0].details.streamId, 'stream-1');
  assert.match(failedLogs[0].details.message, /activity bus exploded/);
});

test('a throwing activity callback on a terminal event still reports terminal:true and logs the WARN', async () => {
  const harness = buildRouterHarness({
    handleWorkspaceActivityStreamEvent: () => { throw new Error('activity bus exploded on terminal'); },
  });

  const result = await harness.router.handleStreamPayload({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-1',
  });

  assert.equal(result.terminal, true);
  assert.equal(harness.activityFailedLogs().length, 1);
});

test('an absent activity callback leaves dispatch unchanged (byte-identical no-op)', async () => {
  const harness = buildRouterHarness();

  const toolUseResult = await harness.router.handleStreamPayload({
    type: 'tool_use', sessionId: 'session-1', streamId: 'stream-1', toolName: 'read_file', input: { path: 'a.js' },
  });
  const completeResult = await harness.router.handleStreamPayload({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-1',
  });

  assert.equal(harness.invocations.filter((e) => e.name === 'handleToolUse').length, 1);
  assert.equal(harness.invocations.filter((e) => e.name === 'handleComplete').length, 1);
  assert.equal(toolUseResult.buffered, false);
  assert.equal(completeResult.terminal, true);
  assert.equal(harness.activityFailedLogs().length, 0);
});

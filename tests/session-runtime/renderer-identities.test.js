'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeChatMessage } = require('../../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../../renderer/chat/renderer-turn-tree-projector');
const { projectTurn, projectTurnRows } = require('../../renderer/chat/renderer-turn-row-projector');
const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
  reconcileTurnRows,
} = require('../../renderer/chat/renderer-turn-reducer');
const { createReducerWiring } = require('../../renderer/chat/renderer-stream-handler-reducer-wiring');
const { createPendingMessageUtils } = require('../../renderer/chat/renderer-stream-handler-pending-message');
const {
  rehydrateSessionLiveState,
  resolveInFlightTurnId,
} = require('../../renderer/chat/renderer-stream-rehydrate');
const { createHydrationPipeline } = require('../../renderer/chat/renderer-render-pipeline-hydration');
const { indexRowsByRenderMessageId } = require('../../renderer/chat/renderer-render-message-index-utils');
const { createStreamContinuationOwner } = require('../../renderer/chat/renderer-stream-continuation-guard');
const { createMultiStreamController } = require('../../renderer/chat/renderer-multi-stream-utils');
const {
  createHarness: createStreamHandlerHarness,
} = require('../helpers/renderer-stream-handler-buffering-harness');
const { CanonicalTurnEventCollector } = require('../../services/backend/canonical-turn-event-collector');

const normalizeId = (value) => String(value || '').trim();

function createReducerHarness() {
  const sessionMessages = new Map();
  const sessionLiveStates = new Map();
  function getSessionLiveTurnState(sessionId, options = {}) {
    let state = sessionLiveStates.get(sessionId) || null;
    if (!state && options.create) {
      state = createTurnReducerState();
      sessionLiveStates.set(sessionId, state);
    }
    return state;
  }
  const wiring = createReducerWiring({
    streamSegmentState: new Map(),
    normalizeId,
    normalizeString: normalizeId,
    getSessionMessages: (sessionId) => sessionMessages.get(sessionId) || [],
    isRowModelEnabled: () => true,
    getSessionLiveTurnState,
    pruneEmptySessionLiveState(sessionId, state) {
      if (!Object.keys(state.turns_by_id).length
        && !Object.keys(state.reconciled_rows_by_turn_id).length
        && !Object.keys(state.pending_reconciliation_by_turn_id).length) {
        sessionLiveStates.delete(sessionId);
      }
    },
    buildRolloutRowKey: (row) => String(row?.row_id || ''),
    buildTurnEventFromStreamPayload,
    applyTurnStreamEvent,
    reconcileTurnRows,
    turnTreeProjectorUtils: { projectTurnTree },
    turnRowProjectorUtils: { projectTurn, projectTurnRows },
    streamRehydrateUtils: {},
  });
  return { wiring, sessionMessages, sessionLiveStates };
}

function buildCanonicalMessages() {
  return [
    {
      id: 'user_stream-attempt-2', role: 'user', content: 'Inspect the project.', status: 'complete',
      turn_id: 'turn-logical-1', streamId: 'stream-attempt-2',
    },
    {
      id: 'assistant_stream-attempt-2', role: 'assistant', content: 'I inspected it.', status: 'complete',
      turn_id: 'turn-logical-1', parent_stream_id: 'stream-attempt-2',
    },
    {
      id: 'tool_use_call-1', role: 'assistant', kind: 'tool_use', turn_id: 'turn-logical-1',
      tool_call: {
        call_id: 'call-1', tool_name: 'workspace_read', status: 'completed',
        parent_stream_id: 'stream-attempt-2', input: { path: 'README.md' },
      },
    },
    {
      id: 'tool_result_call-1', role: 'tool', kind: 'tool_result', turn_id: 'turn-logical-1',
      tool_result: {
        call_id: 'call-1', status: 'completed', content: 'ok', is_error: false,
        parent_stream_id: 'stream-attempt-2',
      },
    },
  ];
}

test('message normalization preserves an explicit logical turn id without changing legacy shape', () => {
  const normalized = normalizeChatMessage({
    id: 'assistant-stream-1', role: 'assistant', content: 'hello', status: 'complete',
    turnId: ' turn-logical-1 ', streamId: 'stream-attempt-1',
  });
  assert.equal(normalized.turn_id, 'turn-logical-1');
  assert.equal(normalized.streamId, 'stream-attempt-1');

  const legacy = normalizeChatMessage({
    id: 'assistant-stream-legacy', role: 'assistant', content: 'legacy', status: 'complete',
    streamId: 'stream-legacy',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'turn_id'), false);
});

test('projector groups canonical messages by logical turn while legacy messages retain stream grouping', () => {
  const canonical = projectTurnTree({ messages: buildCanonicalMessages() });
  assert.equal(canonical.turns.length, 1);
  assert.equal(canonical.turns[0].turn_id, 'turn-logical-1');
  assert.deepEqual(
    canonical.turns[0].source_message_ids,
    ['user_stream-attempt-2', 'assistant_stream-attempt-2', 'tool_use_call-1', 'tool_result_call-1']
  );

  const legacy = projectTurnTree({ messages: [
    { id: 'user_stream-legacy', role: 'user', streamId: 'stream-legacy', content: 'question' },
    { id: 'assistant_stream-legacy', role: 'assistant', streamId: 'stream-legacy', content: 'answer' },
  ] });
  assert.equal(legacy.turns.length, 1);
  assert.equal(legacy.turns[0].turn_id, 'stream-legacy');
  assert.equal(legacy.byMessageId['assistant_stream-legacy'], 'stream-legacy');
});

test('failure retry keeps an explicitly restamped user with the new logical turn during collection', () => {
  const messages = [
    {
      id: 'user_stream-attempt-1', role: 'user', content: 'retry unchanged', status: 'complete',
      turn_id: 'turn-logical-2', streamId: 'stream-attempt-1',
    },
    {
      id: 'assistant_stream-attempt-1', role: 'assistant', content: 'failed answer', status: 'error',
      turn_id: 'turn-logical-1', parent_stream_id: 'stream-attempt-1',
    },
    {
      id: 'tool_result_old', role: 'tool', kind: 'tool_result', turn_id: 'turn-logical-1',
      tool_result: {
        call_id: 'call-old', status: 'completed', content: 'old result', is_error: false,
        parent_stream_id: 'stream-attempt-1',
      },
    },
    {
      id: 'assistant_stream-attempt-2', role: 'assistant', content: 'new answer', status: 'complete',
      turn_id: 'turn-logical-2', parent_stream_id: 'stream-attempt-2',
    },
  ];
  const tree = projectTurnTree({ messages });
  assert.equal(tree.byMessageId['user_stream-attempt-1'], 'turn-logical-2');
  assert.equal(tree.byMessageId['assistant_stream-attempt-1'], 'turn-logical-1');
  assert.equal(tree.byMessageId.tool_result_old, 'turn-logical-1');
  assert.equal(tree.byMessageId['assistant_stream-attempt-2'], 'turn-logical-2');
  assert.deepEqual(new Set(tree.turns.map((turn) => turn.turn_id)),
    new Set(['turn-logical-1', 'turn-logical-2']));

  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-logical-2' });
  const finalized = collector.buildFinalizedTurnEvents('turn-logical-2', messages);
  assert.ok(finalized.length > 0);
  assert.match(JSON.stringify(finalized), /new answer/);
  assert.doesNotMatch(JSON.stringify(finalized), /failed answer|old result/);
});

test('live reducer and terminal reconciliation converge on logical identity while row messages remain stream based', () => {
  const harness = createReducerHarness();
  const sessionId = 'session-1';
  const payload = {
    sessionId,
    streamId: 'stream-attempt-2',
    requestId: 'request-attempt-2',
    turnId: 'turn-logical-1',
  };
  harness.sessionMessages.set(sessionId, buildCanonicalMessages());

  harness.wiring.applyLiveTurnPayload({ ...payload, type: 'started' });
  harness.wiring.applyLiveTurnPayload(
    { ...payload, type: 'delta', aggregate: 'I inspected it.' },
    { segmentText: 'I inspected it.', assistantPhase: 'final_answer' }
  );
  harness.wiring.applyLiveTurnPayload(
    { ...payload, type: 'tool_use', callId: 'call-1', toolName: 'workspace_read', status: 'running' },
    { primaryToolMessageId: 'tool_use_call-1' }
  );
  harness.wiring.applyLiveTurnPayload(
    { ...payload, type: 'tool_result', callId: 'call-1', toolName: 'workspace_read', content: 'ok' },
    { toolResultMessageId: 'tool_result_call-1' }
  );

  const live = harness.sessionLiveStates.get(sessionId);
  assert.deepEqual(Object.keys(live.turns_by_id), ['turn-logical-1']);
  assert.equal(live.turns_by_id['turn-logical-1'].primary_assistant_message_id, 'assistant_stream-attempt-2');

  const reconciliation = harness.wiring.reconcileLiveTurnWithHydratedRows(
    sessionId,
    'turn-logical-1',
    buildCanonicalMessages()
  );
  assert.ok(reconciliation);
  const settled = harness.sessionLiveStates.get(sessionId);
  assert.equal(settled.turns_by_id['turn-logical-1'], undefined);
  const reconciled = settled.reconciled_rows_by_turn_id['turn-logical-1'];
  assert.ok(reconciled.rows.some((row) => row.kind === 'assistant_text'));
  assert.ok(reconciled.rows.some((row) => row.kind === 'tool_call'));
  assert.ok(reconciled.rows.some((row) => row.kind === 'tool_result'));
});

function createPendingHarness(initialMessages = []) {
  const state = {
    currentSessionId: 'session-1',
    pendingStreams: new Map(),
  };
  const messagesBySession = new Map([['session-1', initialMessages]]);
  const utils = createPendingMessageUtils({
    state,
    normalizeId,
    normalizeString: normalizeId,
    streamSegmentState: new Map(),
    buildAssistantShellMessageId: (streamId) => `assistant_${streamId}`,
    MESSAGE_STATUS: { STREAMING: 'streaming', COMPLETE: 'complete', ERROR: 'error' },
    getSessionMessages: (sessionId) => messagesBySession.get(sessionId) || [],
    setSessionMessages: (sessionId, messages) => messagesBySession.set(sessionId, messages),
    createNormalizedMessage: (role, content, extra) => ({ role, content, ...extra }),
    getReasoningPhasesForStream: () => [],
    createPendingStreamCommitQueue: () => ({ flush: () => null, flushWhere: () => [] }),
    queueRender: () => {},
  });
  return { state, messagesBySession, utils };
}

test('pending assistant messages keep physical stream identity and adopt logical identity', () => {
  const created = createPendingHarness();
  created.utils.ensurePendingStreamEntry({
    sessionId: 'session-1', streamId: 'stream-attempt-2', turnId: 'turn-logical-1', type: 'started',
  });
  const message = created.messagesBySession.get('session-1')[0];
  assert.equal(message.id, 'assistant_stream-attempt-2');
  assert.equal(message.streamId, 'stream-attempt-2');
  assert.equal(message.turn_id, 'turn-logical-1');
  assert.equal(created.state.pendingStreams.get('stream-attempt-2'), 'assistant_stream-attempt-2');

  const adopted = createPendingHarness([{
    id: 'assistant_stream-attempt-2', role: 'assistant', status: 'streaming', streamId: 'stream-attempt-2',
  }]);
  adopted.state.pendingStreams.set('stream-attempt-2', 'assistant_stream-attempt-2');
  adopted.utils.ensurePendingStreamEntry({
    sessionId: 'session-1', streamId: 'stream-attempt-2', turn_id: 'turn-logical-1', type: 'delta',
  });
  assert.equal(adopted.messagesBySession.get('session-1')[0].turn_id, 'turn-logical-1');

  const legacy = createPendingHarness();
  legacy.utils.ensurePendingStreamEntry({ sessionId: 'session-1', streamId: 'stream-legacy', type: 'started' });
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.messagesBySession.get('session-1')[0], 'turn_id'), false);
});

test('terminal handler reconciles the logical turn and clears only the physical stream', async (t) => {
  const harness = createStreamHandlerHarness({
    callbackOverrides: {
      getChatTimelineRowModelEnabled: () => true,
    },
  });
  t.after(() => harness.restore());
  const envelope = {
    sessionId: 'session-1', streamId: 'stream-attempt-2', turnId: 'turn-logical-1',
  };
  await harness.emit({ ...envelope, type: 'started' });
  await harness.emit({ ...envelope, type: 'delta', aggregate: 'done' });
  await harness.emit({ ...envelope, type: 'complete', content: 'done' });

  assert.equal(harness.state.pendingStreams.has('stream-attempt-2'), false);
  const assistant = harness.state.messagesBySession.get('session-1').find((message) => message.role === 'assistant');
  assert.equal(assistant.id, 'assistant_stream-attempt-2');
  assert.equal(assistant.turn_id, 'turn-logical-1');
  const liveState = harness.state.ui.chatTimelineLiveStateBySession.get('session-1');
  assert.equal(liveState.turns_by_id['turn-logical-1'], undefined);
  assert.ok(liveState.reconciled_rows_by_turn_id['turn-logical-1']);
  assert.equal(liveState.reconciled_rows_by_turn_id['stream-attempt-2'], undefined);
});

test('a live event for another session updates only that session and never repaints the selection', async (t) => {
  const harness = createStreamHandlerHarness();
  t.after(() => harness.restore());
  await harness.emit({
    sessionId: 'session-2', streamId: 'stream-other', turnId: 'turn-other', type: 'started',
  });
  await harness.emit({
    sessionId: 'session-2', streamId: 'stream-other', turnId: 'turn-other', type: 'delta', aggregate: 'hidden',
  });

  assert.equal(harness.state.currentSessionId, 'session-1');
  assert.deepEqual(harness.state.messagesBySession.get('session-1'), []);
  assert.equal(harness.calls.renderMessages, 0);
  const other = harness.state.messagesBySession.get('session-2')[0];
  assert.equal(other.turn_id, 'turn-other');
  assert.equal(other.streamId, 'stream-other');
});

test('an empty pre-tool segment keeps live tool messages in the logical turn', async (t) => {
  const messagesBySession = new Map([['session-1', [{
    id: 'user_stream-attempt-2', role: 'user', content: 'read', status: 'complete',
    streamId: 'stream-attempt-2',
  }]]]);
  const harness = createStreamHandlerHarness({
    stateOverrides: { messagesBySession },
    callbackOverrides: { getChatTimelineRowModelEnabled: () => true },
  });
  t.after(() => harness.restore());
  const envelope = {
    sessionId: 'session-1', streamId: 'stream-attempt-2', turnId: 'turn-logical-1',
  };

  await harness.emit({ ...envelope, type: 'started' });
  await harness.emit({
    ...envelope,
    type: 'tool_use',
    callId: 'call-1',
    toolName: 'workspace_read',
    status: 'running',
    input: { path: 'README.md' },
  });
  await harness.emit({
    ...envelope,
    type: 'tool_result',
    callId: 'call-1',
    toolName: 'workspace_read',
    content: 'ok',
    summary: 'read complete',
    isError: false,
  });

  const messages = harness.state.messagesBySession.get('session-1');
  const toolMessages = messages.filter((message) => message.kind === 'tool_use' || message.kind === 'tool_result');
  assert.deepEqual(toolMessages.map((message) => message.turn_id), ['turn-logical-1', 'turn-logical-1']);
  assert.deepEqual(
    toolMessages.map((message) => message.tool_call?.parent_stream_id || message.tool_result?.parent_stream_id),
    ['stream-attempt-2', 'stream-attempt-2']
  );
  const tree = projectTurnTree({ messages });
  assert.equal(tree.turns.length, 1);
  assert.equal(tree.turns[0].turn_id, 'turn-logical-1');
});

test('restart hydration selects logical identity and fences the prior physical attempt immediately', () => {
  const events = [{
    event_id: 'turn-logical-1:tool_use:0',
    turn_id: 'turn-logical-1',
    kind: 'tool_use',
    primary_message_id: 'tool_use_call-1',
    source_message_ids: ['tool_use_call-1'],
    tool_call_id: 'call-1',
    status: 'running',
    sort_key: [0, 0, 0],
    payload: { tool_name: 'workspace_read', input: { path: 'README.md' } },
  }];
  const liveStateStore = new Map();
  const state = rehydrateSessionLiveState({
    sessionId: 'session-1',
    turnEvents: events,
    activeTurn: { turn_id: 'turn-logical-1', stream_id: 'stream-attempt-2' },
    liveStateStore,
  });
  assert.equal(resolveInFlightTurnId({ turn_id: 'turn-logical-1', stream_id: 'stream-attempt-2' }), 'turn-logical-1');
  assert.ok(state.turns_by_id['turn-logical-1']);
  assert.equal(state.turns_by_id['stream-attempt-2'], undefined);
  assert.equal(state.turns_by_id['turn-logical-1'].stream_id, 'stream-attempt-2');

  const harness = createReducerHarness();
  harness.sessionLiveStates.set('session-1', state);
  harness.sessionMessages.set('session-1', buildCanonicalMessages());
  assert.equal(harness.wiring.reconcileLiveTurnWithHydratedRows(
    'session-1', 'turn-logical-1', buildCanonicalMessages(), null, undefined, 'stream-attempt-1'
  ), null);
  assert.ok(state.turns_by_id['turn-logical-1']);

  assert.equal(resolveInFlightTurnId({ stream_id: 'stream-legacy' }), 'stream-legacy');
});

test('hydrated logical turns still use physical message stream ids for live tool fencing', () => {
  const messages = [
    {
      id: 'user_stream-attempt-2', role: 'user', content: 'read', status: 'complete',
      turn_id: 'turn-logical-1', parent_stream_id: 'stream-attempt-2',
    },
    {
      id: 'tool_use_call-1', role: 'assistant', kind: 'tool_use', turn_id: 'turn-logical-1',
      parent_stream_id: 'stream-attempt-2',
      tool_call: {
        call_id: 'call-1', tool_name: 'workspace_read', status: 'running',
        parent_stream_id: 'stream-attempt-2', input: { path: 'README.md' },
      },
    },
  ];
  const pipeline = createHydrationPipeline({
    state: {
      features: { featureFlags: {} },
      pendingStreams: new Map([['stream-attempt-2', 'assistant_stream-attempt-2']]),
      ui: {},
    },
    callbacks: { projectTurnTree, projectTurn, projectTurnRows, indexRowsByRenderMessageId },
  });
  const projection = pipeline.buildHydratedTurnProjection(
    messages,
    null,
    { turnEventLogVersion: 0, turnEvents: [] },
    { sessionId: 'session-1' }
  );
  const rows = projection.rowsByTurnId.get('turn-logical-1');
  const toolRow = rows.find((row) => row.kind === 'tool_call');
  assert.equal(toolRow.payload.state, 'running');
});

test('an old attempt callback cannot clear a newer physical stream with the same logical turn id', () => {
  const state = { sessions: [{ id: 'session-1' }], messagesBySession: new Map([['session-1', []]]) };
  const controller = createMultiStreamController({ getState: () => state });
  controller.registerStream('session-1', 'stream-attempt-1');
  const owner = createStreamContinuationOwner({
    state,
    normalizeId,
    captureStreamGeneration: (sessionId, streamId) => controller.captureStreamGeneration(sessionId, streamId),
    isStreamGenerationCurrent: (token) => controller.isStreamGenerationCurrent(token),
  });
  const oldAttempt = owner.createTerminalContinuation({
    sessionId: 'session-1', streamId: 'stream-attempt-1', turnId: 'turn-logical-1',
  });

  controller.registerStream('session-1', 'stream-attempt-2');
  assert.equal(oldAttempt.isCurrent(), false);
  assert.equal(oldAttempt.mutate(() => controller.clearStream('stream-attempt-1')), false);
  assert.equal(controller.getStreamIdForSession('session-1'), 'stream-attempt-2');
});

test('a permitted late terminal repair cannot settle the newer attempt under the same logical turn', async (t) => {
  const harness = createStreamHandlerHarness({
    callbackOverrides: { getChatTimelineRowModelEnabled: () => true },
  });
  t.after(() => harness.restore());
  const logical = { sessionId: 'session-1', turnId: 'turn-logical-1' };

  await harness.emit({ ...logical, streamId: 'stream-attempt-1', type: 'started' });
  await harness.emit({ ...logical, streamId: 'stream-attempt-1', type: 'delta', aggregate: 'old partial' });
  harness.multiStreamController.clearStream('stream-attempt-1');
  harness.state.pendingStreams.delete('stream-attempt-1');

  await harness.emit({ ...logical, streamId: 'stream-attempt-2', type: 'started' });
  await harness.emit({ ...logical, streamId: 'stream-attempt-2', type: 'delta', aggregate: 'new partial' });
  const beforeLateRepair = harness.state.ui.chatTimelineLiveStateBySession.get('session-1')
    .turns_by_id['turn-logical-1'];
  assert.ok(beforeLateRepair);
  assert.equal(beforeLateRepair.stream_id, 'stream-attempt-2');
  await harness.emit({
    ...logical,
    streamId: 'stream-attempt-1',
    type: 'error',
    message: 'old attempt failed after retry began',
  });

  assert.equal(harness.multiStreamController.getStreamIdForSession('session-1'), 'stream-attempt-2');
  assert.equal(harness.state.pendingStreams.has('stream-attempt-2'), true);
  const liveState = harness.state.ui.chatTimelineLiveStateBySession.get('session-1');
  const liveTurn = liveState.turns_by_id['turn-logical-1'];
  assert.ok(liveTurn);
  assert.equal(liveTurn.stream_id, 'stream-attempt-2');
  assert.notEqual(liveTurn.status, 'errored');
  assert.equal(liveState.reconciled_rows_by_turn_id['turn-logical-1'], undefined);
});

test('a hidden session old terminal cannot clear its newer physical attempt', async (t) => {
  const harness = createStreamHandlerHarness({
    callbackOverrides: { getChatTimelineRowModelEnabled: () => true },
  });
  t.after(() => harness.restore());
  const logical = { sessionId: 'session-2', turnId: 'turn-logical-2' };

  await harness.emit({ ...logical, streamId: 'stream-attempt-1', type: 'started' });
  await harness.emit({ ...logical, streamId: 'stream-attempt-1', type: 'delta', aggregate: 'old partial' });
  harness.multiStreamController.clearStream('stream-attempt-1');
  harness.state.pendingStreams.delete('stream-attempt-1');
  await harness.emit({ ...logical, streamId: 'stream-attempt-2', type: 'started' });
  await harness.emit({ ...logical, streamId: 'stream-attempt-2', type: 'delta', aggregate: 'new partial' });

  await harness.emit({
    ...logical,
    streamId: 'stream-attempt-1',
    type: 'error',
    message: 'old hidden attempt failed after retry began',
  });

  assert.equal(harness.state.currentSessionId, 'session-1');
  assert.equal(harness.multiStreamController.getStreamIdForSession('session-2'), 'stream-attempt-2');
  assert.equal(harness.state.pendingStreams.has('stream-attempt-2'), true);
  const liveState = harness.state.ui.chatTimelineLiveStateBySession.get('session-2');
  assert.ok(liveState);
  assert.equal(liveState.turns_by_id['turn-logical-2'].stream_id, 'stream-attempt-2');
  assert.equal(liveState.reconciled_rows_by_turn_id['turn-logical-2'], undefined);
});

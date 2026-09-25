'use strict';

// Gate A7 F9: after a renderer reload, a still-running ask_user turn is
// re-attached through the multi-stream controller (rehydrateActiveTurnState ->
// registerStream), not through state.pendingStreams. The hydration guard must
// read that registration, or the running question row projects 'interrupted'
// and its card never comes back.

const test = require('node:test');
const assert = require('node:assert/strict');

const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurn } = require('../renderer/chat/renderer-turn-row-projector');
const { buildMessageProjectionFingerprint } = require('../renderer/chat/renderer-message-index-utils');
const { createHydrationPipeline } = require('../renderer/chat/renderer-render-pipeline-hydration');
const { indexRowsByRenderMessageId } = require('../renderer/chat/renderer-render-message-index-utils');
const { createSessionLifecycleController } = require('../renderer/shell/renderer-session-lifecycle-utils');
const { createHarness } = require('./helpers/renderer-stream-handler-harness');

const SESSION_ID = 'sess_reload';
const STREAM_ID = 'stream_ask_live';
const CALL_ID = 'call_ask_live';

function persistedTurn() {
  const canonical = (seq, type, payload) => ({
    v: 1,
    event_id: `${STREAM_ID}:canonical:${seq}`,
    turn_id: STREAM_ID,
    stream_id: STREAM_ID,
    session_id: SESSION_ID,
    seq,
    kind: type === 'tool_call_requested' ? 'tool_use' : 'tool_executing',
    tool_call_id: CALL_ID,
    payload: { canonical_event_type: type, canonical_seq: seq, tool_name: 'ask_user', ...payload },
  });
  const questions = [{ id: 'season_pref', prompt: 'Which season?', options: ['summer', 'winter'] }];
  return {
    messages: [
      { id: 'user_1', role: 'user', content: 'Ask me a question.', streamId: STREAM_ID, turn_id: STREAM_ID },
      {
        id: 'tool_use_1',
        role: 'assistant',
        kind: 'tool_use',
        streamId: STREAM_ID,
        turn_id: STREAM_ID,
        tool_call: {
          call_id: CALL_ID,
          name: 'ask_user',
          tool_name: 'ask_user',
          status: 'running',
          parent_stream_id: STREAM_ID,
          input: { questions },
        },
      },
    ],
    turnEvents: [
      canonical(1, 'tool_call_requested', { tool_input: { questions } }),
      canonical(2, 'tool_execution_started', { tool_input: { questions } }),
    ],
  };
}

function askUserState(registeredStreamId) {
  const state = { pendingStreams: new Map(), ui: {} };
  const hydration = createHydrationPipeline({
    state,
    callbacks: {
      projectTurnTree,
      projectTurn,
      projectTurnRows: (events, options) => projectTurn({ turn_id: '', events }, options).rows,
      buildMessageProjectionFingerprint,
      indexRowsByRenderMessageId,
      getRegisteredStreamIdForSession: (sessionId) => (sessionId === SESSION_ID ? registeredStreamId : null),
    },
  });
  const { messages, turnEvents } = persistedTurn();
  const projection = hydration.buildHydratedTurnProjection(
    messages,
    null,
    { turnEventLogVersion: 2, turnEvents },
    { sessionId: SESSION_ID }
  );
  const rows = [...projection.rowsByTurnId.values()].flat();
  const row = rows.find((candidate) => candidate?.kind === 'tool_call'
    && String(candidate.tool_call_id || candidate.payload?.tool_call_id || '') === CALL_ID);
  assert.ok(row, 'the ask_user tool row is projected');
  return String(row.payload?.state || '');
}

test('a stream re-attached after a reload keeps its running ask_user row live', () => {
  assert.equal(askUserState(STREAM_ID), 'running');
});

test('without a live stream the same persisted row settles as interrupted', () => {
  assert.equal(askUserState(null), 'interrupted');
  assert.equal(askUserState('stream_some_other_turn'), 'interrupted');
});

test('a reload replays the question main still waits on, so its card state and ref come back', async (t) => {
  const { messages } = persistedTurn();
  const questions = messages[1].tool_call.input.questions;
  const harness = createHarness({ stateOverrides: {
    currentSessionId: 'sess_before_reload',
    sessions: [{ id: SESSION_ID }],
    messagesBySession: new Map(),
    sessionMessageAccessOrder: new Map(),
  } });
  t.after(() => harness.restore());
  const lifecycle = createSessionLifecycleController({
    state: harness.state,
    getMultiStreamController: () => harness.multiStreamController,
    sessionCacheController: { async evictColdSessionCaches() {} },
    thinkingController: { resumeAutoScroll() {} },
    jennyShell: {
      sessions: { async getMessages() { return { data: messages, turn_events: [] }; } },
      chat: { async getActiveTurnState() {
        return {
          stream_id: STREAM_ID, request_id: STREAM_ID, turn_id: STREAM_ID, state: 'streaming',
          pending_user_questions: [{
            question_id: 'question_live', question_ref: 'question_ref_live', call_id: CALL_ID,
            tool_name: 'ask_user', questions,
          }],
        };
      } },
    },
    callbacks: {
      setSessionMessages: (id, nextMessages) => harness.state.messagesBySession.set(id, nextMessages),
      rehydrateLiveTurnState: (...args) => harness.handler.rehydrateSessionFromPersistedTurnEvents(...args),
    },
  });

  await lifecycle.openSession(SESSION_ID, { silent: true });
  await new Promise((resolve) => setImmediate(resolve));

  const toolUse = harness.state.messagesBySession.get(SESSION_ID)
    .find((message) => message.kind === 'tool_use' && message.tool_call?.call_id === CALL_ID);
  assert.equal(toolUse.tool_call.status, 'pending_user_input');
  assert.equal(toolUse.tool_call.question_ref, 'question_ref_live');
  assert.deepEqual(toolUse.tool_call.user_questions, questions);
  assert.equal(harness.multiStreamController.getSessionAttentionStates([SESSION_ID]).get(SESSION_ID), 'input_needed');
});

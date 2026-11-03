'use strict';

// Row 89 (docs/plans/PRIMARY_NOTIFICATIONS_2026-11-02.md D1): every renderer event of an app-started
// turn names its kind, so the desktop toast can say what finished ("Check done: <title>").

const test = require('node:test');
const assert = require('node:assert/strict');

const { applicationTurnEventFields } = require('../services/backend/application-turns');
const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const { createManagedChatServiceStub } = require('./helpers/managed-sidecar-chat-lifecycle-helpers');

test('applicationTurnEventFields names known app turns and a check by its title; anything else adds nothing', () => {
  assert.deepEqual(applicationTurnEventFields('scheduled_check', 'Scheduled check: Morning PR sweep'),
    { applicationTurn: 'scheduled_check', applicationTurnTitle: 'Morning PR sweep' });
  assert.deepEqual(applicationTurnEventFields('scheduled_check', ''), { applicationTurn: 'scheduled_check' });
  assert.deepEqual(applicationTurnEventFields('wake', 'Woken by a report from Review'), { applicationTurn: 'wake' });
  assert.deepEqual(applicationTurnEventFields('digest', 'While you were away'), { applicationTurn: 'digest' });
  assert.deepEqual(applicationTurnEventFields('handoff_preparation', 'x'), {});
  assert.deepEqual(applicationTurnEventFields('', 'hi'), {});
  assert.deepEqual(applicationTurnEventFields('anything', 'hi'), {});
});

async function runTurn(applicationTurn, visiblePrompt) {
  const service = createManagedChatServiceStub({ featureFlags: { canonical_bridge: true, canonical_turn_events: true } });
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({ method: 'chat.token', params: { delta: 'Two PRs need review.', sequence: 1 } });
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'end_turn', response_text: 'Two PRs need review.', completion_source: 'model' } });
      return { status: 'completed', response_text: 'Two PRs need review.', completion_source: 'model' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_row89', prompt: 'Check the open PRs.', visiblePrompt, attachments: [],
    ...(applicationTurn ? { applicationTurn } : {}),
    runtimePreferredModel: 'mock-v1', normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1', reasoning_effort: 'default', conversation_mode: 'chat', pending_question_batch: null,
      interactive_sequence_state: 'idle', interactive_round_count: 0, plan_mode: false,
    },
  });
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  return service.emittedEvents.filter((entry) => entry.eventName === 'chat-stream').map((entry) => entry.payload);
}

test('a scheduled check turn carries its kind and title on the complete event', async () => {
  const events = await runTurn('scheduled_check', 'Scheduled check: Morning PR sweep');
  const complete = events.find((event) => event.type === 'complete');
  assert.ok(complete, 'the turn completed');
  assert.equal(complete.applicationTurn, 'scheduled_check');
  assert.equal(complete.applicationTurnTitle, 'Morning PR sweep');
  assert.equal(complete.sessionId, 'session_row89');
  assert.equal(complete.trace_id, complete.traceId, 'the trace fields are unchanged');
});

test('an ordinary turn carries no application-turn fields', async () => {
  const events = await runTurn('', 'Check the open PRs.');
  const complete = events.find((event) => event.type === 'complete');
  assert.ok(complete, 'the turn completed');
  assert.equal(Object.hasOwn(complete, 'applicationTurn'), false);
  assert.equal(Object.hasOwn(complete, 'applicationTurnTitle'), false);
});

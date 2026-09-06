'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveApprovedPlanContext,
  buildApprovedPlanOverlay,
} = require('../services/backend/approved-plan-context');
const {
  recordPendingPlanDocument,
  recordPlanDocumentOutcome,
  settleStalePendingPlanDocuments,
  deriveFilesRead,
  preparePlanApproval,
  denyUnrenderablePlan,
  planApprovalWaiterResult,
  DUPLICATE_PLAN_MESSAGE,
  UNRENDERABLE_PLAN_MESSAGE,
} = require('../services/backend/plan-document-events');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
const { TURN_EVENT_LOG_VERSION } = require('../services/backend/session-turn-events');
const { approveToolCall } = require('../services/backend/backend-chat-stream');

function fakeService() {
  const messages = [];
  return {
    sessionStore: {
      getSessionMessages: () => messages,
      appendMessage: (_id, message) => messages.push(message),
      updateMessage: (_id, messageId, patch) => {
        const index = messages.findIndex((message) => message.id === messageId);
        if (index >= 0) messages[index] = { ...messages[index], ...patch };
      },
    },
    messages,
  };
}

test('rejected proposal can be superseded by one revised proposal in the same turn', () => {
  const service = fakeService();
  const turnEventCollector = new CanonicalTurnEventCollector({ turnId: 'turn', sessionId: 's' });
  const first = recordPendingPlanDocument({
    service, sessionId: 's', streamId: 'turn', callId: 'call_1',
    input: { title: 'First', steps: ['One'] }, turnEventCollector,
  });
  recordPlanDocumentOutcome({
    service, sessionId: 's', streamId: 'turn', callId: 'call_1', turnEventCollector,
    result: { isError: false, metadata: {
      result_kind: 'plan_mode_transition', plan_decision: 'rejected', plan_feedback: 'Revise it',
    } },
  });
  const second = recordPendingPlanDocument({
    service, sessionId: 's', streamId: 'turn', callId: 'call_2',
    input: { title: 'Second', steps: ['Two'] }, turnEventCollector,
  });
  assert.ok(first && second);
  assert.deepEqual(turnEventCollector.capturedEvents.map((event) => event.payload.transition),
    ['pending', 'rejected', 'superseded', 'pending']);
});

test('same provider call id in two streams preserves independently settled plan messages', () => {
  const messages = [];
  const events = [];
  const service = { sessionStore: {
    getSessionMessages: () => messages,
    appendMessage: (_sessionId, message) => {
      if (messages.some((entry) => entry.id === message.id)) return null;
      messages.push(message);
      return true;
    },
    updateMessage: (_sessionId, messageId, patch) => {
      const message = messages.find((entry) => entry.id === messageId);
      if (!message) return null;
      Object.assign(message, patch);
      return true;
    },
  } };
  const turnEventCollector = { noteEvent: (event) => events.push(event) };
  for (const [streamId, title] of [['stream_a', 'First'], ['stream_b', 'Second']]) {
    recordPendingPlanDocument({
      service, sessionId: 's', streamId, callId: 'call_1',
      input: { title, steps: ['Do it'] }, turnEventCollector,
    });
  }
  for (const [streamId, decision] of [['stream_a', 'approved'], ['stream_b', 'rejected']]) {
    recordPlanDocumentOutcome({
      service, sessionId: 's', streamId, callId: 'call_1', turnEventCollector,
      result: { isError: false, metadata: {
        result_kind: 'plan_mode_transition', plan_decision: decision,
      } },
    });
  }

  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].id, messages[1].id);
  assert.deepEqual(messages.map((message) => [message.plan_document.title, message.plan_document.state]),
    [['First', 'approved'], ['Second', 'rejected']]);
  assert.equal(new Set(events.map((event) => event.event_id)).size, 4);
});

test('edited outcome updates the recorded plan and approved-plan overlay', () => {
  const service = fakeService();
  const events = [];
  const turnEventCollector = { noteEvent: (event) => events.push(event) };
  recordPendingPlanDocument({
    service, sessionId: 's', streamId: 'turn', callId: 'call', turnEventCollector,
    input: { title: 'Original', steps: ['Old'], notes: 'Keep', verification: 'Verify' },
  });
  recordPlanDocumentOutcome({
    service, sessionId: 's', streamId: 'turn', callId: 'call', turnEventCollector,
    result: { isError: false, metadata: {
      result_kind: 'plan_mode_transition', plan_decision: 'approved', plan_edited: true,
      plan: { title: 'Edited', steps: ['New'], summary: '', notes: 'Keep', verification: 'Verify' },
    } },
  });

  const recorded = service.messages[0].plan_document;
  assert.equal(recorded.title, 'Edited');
  assert.deepEqual(recorded.steps, ['New']);
  assert.equal(recorded.plan_edited, true);
  assert.equal(events.at(-1).payload.plan_edited, true);
  assert.match(buildApprovedPlanOverlay(recorded, 'Seed todos.'), /1\. New/);
  assert.doesNotMatch(buildApprovedPlanOverlay(recorded, 'Seed todos.'), /Old/);
});

test('duplicate plan after approval is denied with the actionable duplicate message', () => {
  const service = fakeService();
  recordPendingPlanDocument({
    service, sessionId: 's', streamId: 'turn', callId: 'first',
    input: { title: 'First', steps: ['One'] },
  });
  recordPlanDocumentOutcome({
    service, sessionId: 's', streamId: 'turn', callId: 'first',
    result: { isError: false, metadata: {
      result_kind: 'plan_mode_transition', plan_decision: 'approved',
    } },
  });
  const approval = preparePlanApproval({
    toolName: 'exit_plan_mode', service, sessionId: 's', streamId: 'turn', callId: 'second',
    input: { title: 'Second', steps: ['Two'] }, approvalId: 'approval',
  });
  let persisted;
  assert.equal(approval.duplicate, true);
  assert.equal(approval.unrenderable, false);
  assert.equal(denyUnrenderablePlan(approval, (value) => { persisted = value; }, {}), true);
  assert.equal(persisted.output, DUPLICATE_PLAN_MESSAGE);
  assert.notEqual(persisted.output, UNRENDERABLE_PLAN_MESSAGE);
  assert.equal(UNRENDERABLE_PLAN_MESSAGE, 'The plan proposal was missing a title or steps, so it could not be '
    + 'shown for review. Resubmit exit_plan_mode with a non-empty title and at least one step.');
});

test('plan approval waiter maps only object edits to edited_plan', () => {
  const plan = { title: 'Edited', steps: ['One'] };
  assert.deepEqual(planApprovalWaiterResult({
    toolName: 'exit_plan_mode', approved: true, state: 'approved', feedback: '', plan,
  }).edited_plan, plan);
  assert.equal(Object.hasOwn(planApprovalWaiterResult({
    toolName: 'exit_plan_mode', approved: true, state: 'approved', feedback: '', plan: 'bad',
  }), 'edited_plan'), false);
});

test('approveToolCall passes the renderer plan object to the waiter untouched', () => {
  const resolved = [];
  const plan = { title: 'Edited', steps: ['One'] };
  const service = {
    pendingToolApprovals: new Map([['approval', {
      toolName: 'exit_plan_mode', resolve: (...args) => resolved.push(args),
    }]]),
  };

  assert.equal(approveToolCall(service, 'approval', {
    decision: 'approved', feedback: 'ok', plan,
  }), true);
  assert.deepEqual(resolved, [[true, 'approved', 'ok', plan]]);
});

function approvedPlanMessage() {
  return {
    role: 'assistant', kind: 'plan_document',
    plan_document: { plan_id: 'p', state: 'approved', title: 'Plan', steps: ['A', 'B'] },
  };
}

test('completed todo projection permanently expires approved-plan continuity', () => {
  const planMessage = approvedPlanMessage();
  const completed = {
    kind: 'tool_use', tool_call: { tool_name: 'todo_write', input: {
      todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'completed' }],
    } },
  };
  const unrelated = {
    kind: 'tool_use', tool_call: { tool_name: 'todo_write', input: {
      todos: [{ content: 'Unrelated', status: 'in_progress' }],
    } },
  };

  assert.equal(deriveApprovedPlanContext([planMessage, completed]), null);
  assert.equal(deriveApprovedPlanContext([planMessage, completed, unrelated]), null);
});

test('empty todo projection does not drop an active approved plan', () => {
  const planMessage = approvedPlanMessage();
  const inProgress = {
    kind: 'tool_use', tool_call: { tool_name: 'todo_write', input: {
      todos: [{ content: 'A', status: 'in_progress' }],
    } },
  };
  const empty = {
    kind: 'tool_use', tool_call: { tool_name: 'todo_write', input: { todos: [] } },
  };

  assert.ok(deriveApprovedPlanContext([planMessage, inProgress, empty]));
});

test('approved plan without todos survives ten subsequent user turns', () => {
  const planMessage = approvedPlanMessage();
  const userTurns = Array.from({ length: 11 }, () => ({ role: 'user' }));

  assert.ok(deriveApprovedPlanContext([planMessage, ...userTurns.slice(0, 5)]));
  assert.ok(deriveApprovedPlanContext([planMessage, ...userTurns.slice(0, 10)]));
  assert.equal(deriveApprovedPlanContext([planMessage, ...userTurns]), null);
  assert.ok(deriveApprovedPlanContext(
    [planMessage, ...userTurns.slice(0, 9)], { includeCurrentUserTurn: true }));
  assert.equal(deriveApprovedPlanContext(
    [planMessage, ...userTurns.slice(0, 10)], { includeCurrentUserTurn: true }), null);
});

test('approved-plan overlay includes normalized steps', () => {
  const planMessage = approvedPlanMessage();
  assert.match(buildApprovedPlanOverlay(planMessage.plan_document, 'Seed todos.'), /1\. A/);
});

test('startup recovery settles stale pending plans as abandoned without touching future logs', () => {
  const pending = {
    turn_event_log_version: TURN_EVENT_LOG_VERSION, turn_event_seq_counter: 1,
    messages: [{ kind: 'plan_document', plan_document: {
      plan_id: 'p', state: 'pending', title: 'Plan', steps: ['A'],
    } }],
    turn_events: [{ event_id: 'e', event_seq: 0, turn_id: 't', kind: 'plan_document',
      status: 'pending', payload: { plan_id: 'p', transition: 'pending', title: 'Plan', steps: ['A'] } }],
  };
  const settled = settleStalePendingPlanDocuments(pending);
  assert.equal(settled.changed, true);
  assert.equal(settled.session.turn_events.at(-1).payload.transition, 'abandoned');
  assert.equal(settled.session.messages[0].plan_document.state, 'abandoned');
  assert.equal(settled.session.turn_event_log_version, TURN_EVENT_LOG_VERSION);
  const future = settleStalePendingPlanDocuments({
    ...pending, turn_event_log_version: TURN_EVENT_LOG_VERSION + 1,
  });
  assert.equal(future.changed, false);
});

test('files-read projection trusts only successful executor metadata from the current turn', () => {
  const messages = [
    { kind: 'tool_use', tool_call: { call_id: 'safe', tool_name: 'read_file',
      parent_stream_id: 'turn', input: { path: 'model-supplied.md' } } },
    { kind: 'tool_result', tool_result: { call_id: 'safe', parent_stream_id: 'turn',
      is_error: false, metadata: { path: 'src/validated.js' } } },
    { kind: 'tool_use', tool_call: { call_id: 'failed', tool_name: 'read_file',
      parent_stream_id: 'turn', input: { path: 'failed.md' } } },
    { kind: 'tool_result', tool_result: { call_id: 'failed', parent_stream_id: 'turn',
      is_error: true, metadata: { path: 'src/failed.js' } } },
    { kind: 'tool_use', tool_call: { call_id: 'other', tool_name: 'read_file',
      parent_stream_id: 'older', input: { path: 'older.md' } } },
    { kind: 'tool_result', tool_result: { call_id: 'other', parent_stream_id: 'older',
      is_error: false, metadata: { path: 'src/older.js' } } },
  ];
  assert.deepEqual(deriveFilesRead(messages, 'turn'), ['src/validated.js']);
});

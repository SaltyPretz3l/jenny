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
  resolvePlanApprovalState,
  markAcceptedPlanApproved,
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
  assert.equal(Object.hasOwn(planApprovalWaiterResult({
    toolName: 'exit_plan_mode', approved: true, state: 'approved', feedback: '',
    plan: { title: 'Huge', steps: ['x'.repeat(16 * 1024)] },
  }), 'edited_plan'), false, 'an edit over the 16 KiB sidecar cap is dropped');
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

test('approveToolCall denies an unrecognized decision instead of approving it', () => {
  const resolved = [];
  const service = {
    pendingToolApprovals: new Map([['approval', {
      toolName: 'exit_plan_mode', resolve: (...args) => resolved.push(args),
    }]]),
  };
  assert.equal(approveToolCall(service, 'approval', { decision: 'build_everything' }), true);
  assert.deepEqual(resolved, [[false, 'denied']]);
  assert.equal(service.pendingToolApprovals.size, 0);
});

test('an approval whose state is unknown never resolves to execute', () => {
  assert.equal(resolvePlanApprovalState(true, 'yolo'), 'denied');
  assert.equal(resolvePlanApprovalState(true, 'accepted'), 'accepted');
  assert.deepEqual(planApprovalWaiterResult({
    toolName: 'exit_plan_mode', approved: true, state: 'accepted', feedback: '',
  }), { approved: true, decision: 'accepted', feedback: '' });
});

test('accepted outcome records an accepted receipt that blocks a same-turn re-proposal', () => {
  const service = fakeService();
  const turnEventCollector = new CanonicalTurnEventCollector({ turnId: 'turn', sessionId: 's' });
  recordPendingPlanDocument({
    service, sessionId: 's', streamId: 'turn', callId: 'call_1',
    input: { title: 'Hold', steps: ['One'] }, turnEventCollector,
  });
  const entry = recordPlanDocumentOutcome({
    service, sessionId: 's', streamId: 'turn', callId: 'call_1', turnEventCollector,
    result: { isError: false, metadata: { result_kind: 'plan_mode_transition', plan_decision: 'accepted' } },
  });
  assert.equal(entry.state, 'accepted');
  assert.equal(service.messages[0].plan_document.state, 'accepted');
  assert.equal(recordPendingPlanDocument({
    service, sessionId: 's', streamId: 'turn', callId: 'call_2',
    input: { title: 'Again', steps: ['Two'] }, turnEventCollector,
  }), null);
  assert.equal(deriveApprovedPlanContext(service.messages), null, 'an accepted plan is not injected');
});

function acceptedPlanSession({ activeTurn = null, state = 'accepted', priorEvent = true, appendResult = { ok: true } } = {}) {
  const messages = [
    { id: 'plan_document_plan_old', kind: 'plan_document',
      plan_document: { plan_id: 'plan_old', state: 'accepted', title: 'Old', steps: ['A'] } },
    { id: 'plan_document_plan_new', kind: 'plan_document',
      plan_document: { plan_id: 'plan_new', state, title: 'New', steps: ['B'], parent_stream_id: 'stream_1' } },
  ];
  const events = priorEvent ? [{
    event_id: 'stream_1:plan_document:plan_new:accepted', kind: 'plan_document', status: 'accepted',
    payload: { plan_id: 'plan_new', transition: 'accepted' },
  }] : [];
  const appended = [];
  const service = {
    sessionStore: {
      getActiveTurn: () => activeTurn,
      getSessionMessages: () => messages,
      getSessionTurnEvents: () => events,
      appendTurnEvents: (_id, rows) => {
        if (appendResult.ok) appended.push(...rows);
        return appendResult;
      },
      updateMessage: (_id, messageId, patch) => {
        const index = messages.findIndex((message) => message.id === messageId);
        if (index >= 0) messages[index] = { ...messages[index], ...patch };
      },
    },
  };
  return { service, messages, appended };
}

test('building an accepted plan flips only the latest idle accepted plan to approved', () => {
  const busy = acceptedPlanSession({ activeTurn: { stream_id: 'x' } });
  assert.deepEqual(markAcceptedPlanApproved({ service: busy.service, sessionId: 's', planId: 'plan_new' }),
    { ok: false, reason: 'busy' });
  const older = acceptedPlanSession();
  assert.deepEqual(markAcceptedPlanApproved({ service: older.service, sessionId: 's', planId: 'plan_old' }),
    { ok: false, reason: 'not_latest' });
  const built = acceptedPlanSession({ state: 'approved' });
  assert.deepEqual(markAcceptedPlanApproved({ service: built.service, sessionId: 's', planId: 'plan_new' }),
    { ok: false, reason: 'not_accepted' });

  const live = acceptedPlanSession();
  assert.deepEqual(markAcceptedPlanApproved({ service: live.service, sessionId: 's', planId: 'plan_new' }),
    { ok: true });
  assert.equal(live.messages[1].plan_document.state, 'approved');
  assert.equal(live.appended.length, 1);
  assert.equal(live.appended[0].event_id, 'stream_1:plan_document:plan_new:approved');
  assert.equal(live.appended[0].payload.transition, 'approved');
  assert.equal(deriveApprovedPlanContext(live.messages)?.title, 'New', 'the next send carries the plan');
});

test('building an accepted plan with no prior turn event still records the approved event', () => {
  const live = acceptedPlanSession({ priorEvent: false });
  assert.deepEqual(markAcceptedPlanApproved({ service: live.service, sessionId: 's', planId: 'plan_new' }),
    { ok: true });
  assert.equal(live.messages[1].plan_document.state, 'approved');
  assert.equal(live.appended.length, 1, 'the message and the turn events agree');
  const [event] = live.appended;
  assert.equal(event.event_id, 'stream_1:plan_document:plan_new:approved');
  assert.equal(event.kind, 'plan_document');
  assert.equal(event.status, 'approved');
  assert.equal(event.primary_message_id, 'plan_document_plan_new');
  assert.equal(event.payload.transition, 'approved');
  assert.equal(event.payload.title, 'New');
  assert.deepEqual(event.payload.steps, ['B']);
});

test('building an accepted plan refuses without touching the message when the event cannot persist', () => {
  const refused = acceptedPlanSession({ appendResult: { ok: false, reason: 'durability_failed' } });
  assert.deepEqual(markAcceptedPlanApproved({ service: refused.service, sessionId: 's', planId: 'plan_new' }),
    { ok: false, reason: 'persist_failed' });
  assert.equal(refused.messages[1].plan_document.state, 'accepted', 'the message still says accepted');
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

test('an accepted plan-document projection is a continuation event like the other states', () => {
  const { isContinuationTextProjection } = require('../services/session-runtime/continuation-events');
  const planId = 'plan_0123456789abcdef0123';
  const event = (state) => ({
    event_id: `stream_1:plan_document:${planId}:${state}`, kind: 'plan_document', status: state,
    tool_call_id: 'call_1', payload: { plan_id: planId, transition: state, tool_call_id: 'call_1' },
  });
  assert.equal(isContinuationTextProjection(event('accepted')), true);
  assert.equal(isContinuationTextProjection(event('yolo')), false);
});

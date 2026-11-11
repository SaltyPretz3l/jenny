'use strict';

// Electron keeps each delegated child's latest lifecycle on the active turn so
// a reopened chat can rebuild the live summary (session sess_1794250947615:
// three tasks, the card vanished on return and only two came back).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_DELEGATE_CHILDREN,
  applyDelegateChildEvent,
  normalizeDelegateChildren,
} = require('../services/backend/delegate-active-turn-children');
const { mirrorAgentStatusToActiveTurn } = require('../services/backend/work-lifecycle-coordinator');
const { buildTouchedActiveTurn, normalizeActiveTurn } = require('../services/backend/session-normalizers');
const { getManagedActiveTurnState } = require('../services/backend/backend-active-turn-state');

const CALL = 'call_delegate';
const frame = (ordinal, status, extra = {}) => ({
  type: 'agent_status', streamId: 'stream-1', sessionId: 'session-1', requestId: 'turn-1',
  taskId: `delegate:${CALL}`, taskType: 'sub_agent', source: 'delegate', toolCallId: CALL,
  childTaskId: `task:${ordinal}`, childAgentId: `agent:${ordinal}`, childOrdinal: ordinal, childCount: 3,
  childLabel: `Task ${ordinal}`, status, stage: `task_${ordinal}_${status}`, percent: 10,
  summary: `Task ${ordinal}/3 ${status}.`, terminal: false, success: false, childTerminal: false, childSuccess: false,
  ...extra,
});

function makeAdapter(initial = { request_id: 'turn-1', stream_id: 'stream-1', status: 'streaming' }) {
  const adapter = {
    current: initial,
    touches: 0,
    peekActiveTurn: () => adapter.current,
    touchActiveTurn(match, patch) {
      assert.equal(match.request_id, adapter.current.request_id);
      assert.equal(match.stream_id, adapter.current.stream_id);
      adapter.touches += 1;
      adapter.current = buildTouchedActiveTurn(adapter.current, patch);
      return adapter.current;
    },
  };
  return adapter;
}

function statuses(rows) {
  return rows.map((row) => `${row.ordinal}:${row.status}`);
}

test('every queued child is recorded, so one that has not started survives a reopen', () => {
  const adapter = makeAdapter();
  for (const ordinal of [1, 2, 3]) mirrorAgentStatusToActiveTurn(adapter, frame(ordinal, 'queued'));
  mirrorAgentStatusToActiveTurn(adapter, frame(1, 'running'));
  assert.deepEqual(statuses(adapter.current.delegate_children), ['1:running', '2:queued', '3:queued']);
});

test('a settling frame is recorded even though it carries activity', () => {
  const adapter = makeAdapter();
  mirrorAgentStatusToActiveTurn(adapter, frame(1, 'running'));
  mirrorAgentStatusToActiveTurn(adapter, frame(1, 'completed', {
    childTerminal: true, childSuccess: true, childActivity: { sequence: 9, steps: [], step_count: 2, text: 'secret-free' },
    usage: { total_tokens: 12 },
  }));
  const [row] = adapter.current.delegate_children;
  assert.equal(row.status, 'completed');
  assert.equal(row.child_terminal, true);
  assert.equal(row.child_success, true);
  assert.equal(row.usage.total_tokens, 12);
  assert.equal(Object.hasOwn(row, 'childActivity'), false, 'activity is never stored');
});

test('activity frames, repeats and late frames write nothing', () => {
  const adapter = makeAdapter();
  mirrorAgentStatusToActiveTurn(adapter, frame(1, 'running'));
  const touchesAfterRunning = adapter.touches;
  const rows = adapter.current.delegate_children;
  assert.equal(applyDelegateChildEvent(rows, frame(1, 'running', { childActivity: { sequence: 2 } })), null);
  assert.equal(applyDelegateChildEvent(rows, frame(1, 'running')), null);
  mirrorAgentStatusToActiveTurn(adapter, frame(1, 'running', { childActivity: { sequence: 2 } }));
  assert.equal(adapter.touches, touchesAfterRunning, 'an activity frame does not touch the active turn');

  const settled = applyDelegateChildEvent(rows, frame(1, 'completed', { childTerminal: true }));
  assert.equal(applyDelegateChildEvent(settled, frame(1, 'running')), null, 'a settled child stays settled');
});

test('a start that arrives with activity attached still moves the child out of queued', () => {
  const rows = applyDelegateChildEvent([], frame(1, 'queued'), 1000);
  const next = applyDelegateChildEvent(rows, frame(1, 'running', { childActivity: { sequence: 1 } }), 2000);
  assert.equal(next[0].status, 'running');
  assert.equal(next[0].started_at_ms, 2000);
});

test('the clock starts when a queued child enters running and then holds', () => {
  let rows = applyDelegateChildEvent([], frame(1, 'queued'), 1000);
  assert.equal(rows[0].started_at_ms, 1000);
  rows = applyDelegateChildEvent(rows, frame(1, 'running'), 5000);
  assert.equal(rows[0].started_at_ms, 5000);
  rows = applyDelegateChildEvent(rows, frame(1, 'completed', { childTerminal: true }), 9000);
  assert.equal(rows[0].started_at_ms, 5000);
  assert.equal(rows[0].updated_at_ms, 9000);
});

test('non-delegate frames are ignored and malformed rows are dropped', () => {
  assert.equal(applyDelegateChildEvent([], { ...frame(1, 'running'), taskType: 'local_agent' }), null);
  assert.equal(applyDelegateChildEvent([], { ...frame(1, 'running'), toolCallId: '' }), null);
  assert.equal(applyDelegateChildEvent([], { ...frame(1, 'running'), childTaskId: '', childAgentId: '' }), null);
  assert.deepEqual(normalizeDelegateChildren('nope'), []);
  assert.deepEqual(normalizeDelegateChildren([null, [], { tool_call_id: CALL }, { child_task_id: 'x', status: 'running' }]), []);
});

test('the row list is bounded and evicts settled children first', () => {
  let rows = [];
  for (let ordinal = 1; ordinal <= MAX_DELEGATE_CHILDREN; ordinal += 1) {
    rows = applyDelegateChildEvent(rows, frame(ordinal, 'running', { childCount: 99 }), ordinal);
  }
  rows = applyDelegateChildEvent(rows, frame(5, 'completed', { childTerminal: true }), 100);
  rows = applyDelegateChildEvent(rows, frame(99, 'running'), 101);
  assert.equal(rows.length, MAX_DELEGATE_CHILDREN);
  assert.equal(rows.some((row) => row.ordinal === 5), false, 'the settled child went first');
  assert.equal(rows[rows.length - 1].ordinal, 99);

  const oversized = applyDelegateChildEvent([], frame(1, 'running', { childLabel: 'x'.repeat(500), summary: 'y'.repeat(900) }));
  assert.equal(oversized[0].label.length, 80);
  assert.equal(oversized[0].summary.length, 240);
});

test('the field survives active-turn normalization and reaches the live snapshot', () => {
  const rows = applyDelegateChildEvent([], frame(1, 'queued'), 1000);
  const stored = normalizeActiveTurn({
    request_id: 'turn-1', stream_id: 'stream-1', status: 'streaming', user_message_id: 'user-1',
    started_at: '2026-11-09T19:00:00.000Z', last_event_at: '2026-11-09T19:00:00.000Z', delegate_children: rows,
  });
  assert.deepEqual(stored.delegate_children, rows);

  const service = {
    sessionStore: { getActiveTurn: () => stored },
    activeStreams: new Map([['stream-1', {}]]),
    pendingToolApprovals: new Map(),
  };
  assert.deepEqual(getManagedActiveTurnState(service, 'session-1').delegate_children, rows);
  service.activeStreams.clear();
  assert.equal(getManagedActiveTurnState(service, 'session-1'), null, 'no live stream, nothing to restore');
});

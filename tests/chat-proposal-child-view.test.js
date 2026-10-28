'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createChildTracker, deriveChildView } = require('../services/backend/chat-proposal-child-view');

// F3b (2026-10-27): the New session card follows its child chat after admission instead of saying
// "Started" for good; the incident's child failed its first turn with CMP-AI-0002 behind that word.
const summary = (extra = {}) => ({ id: 'child', run_mode: 'ask', preferred_model: 'ornith15:9b-q6-256k', ...extra });
const user = (turn, id = `u_${turn}`) => ({ id, role: 'user', turn_id: turn });
const reply = (turn, extra = {}) => ({ id: `a_${turn}`, role: 'assistant', turn_id: turn, content: 'ok', ...extra });

test('phases follow the child: starting, running, waiting, reported', () => {
  assert.equal(deriveChildView({ summary: summary() }).phase, 'starting');
  const running = deriveChildView({ summary: summary(), activeTurn: { status: 'streaming', started_at: '2026-10-27T13:16:40Z' } });
  assert.equal(running.phase, 'running');
  assert.equal(running.turn_started_at, '2026-10-27T13:16:40Z');
  assert.equal(deriveChildView({ summary: summary(), work: { status: 'pending' } }).phase, 'running', 'queued work reads running');
  assert.equal(deriveChildView({ summary: summary(), approvalCount: 1, activeTurn: { status: 'streaming' } }).phase, 'waiting');
  assert.equal(deriveChildView({ summary: summary({ pending_plan_proposal: { id: 'p' } }) }).phase, 'waiting');
  const done = deriveChildView({ summary: summary(), work: { status: 'completed', turn_id: 't1' }, rows: [user('t1'), reply('t1')] });
  assert.equal(done.phase, 'reported');
  assert.equal(done.model, 'ornith15:9b-q6-256k');
  assert.equal(done.run_mode, 'ask');
});

test('the incident: a first turn that failed on model_busy is failed, first, and retryable', () => {
  const rows = [user('t1', 'msg_first'), reply('t1', {
    error_code: 'CMP-AI-0002', stream_error: 'Model initialization is already in progress', recovery_title: 'Model was still switching',
  })];
  const view = deriveChildView({ summary: summary(), work: { status: 'failed', turn_id: 't1' }, rows, firstTurnId: 't1' });
  assert.equal(view.phase, 'failed');
  assert.equal(view.error_code, 'CMP-AI-0002');
  assert.equal(view.error_class, 'model_busy');
  assert.equal(view.failed_turn_is_first, true);
  assert.deepEqual(view.retry, { message_id: 'a_t1' }, "the failed reply, as the child's own Retry turn targets it");
  assert.equal(JSON.stringify(view).includes('initialization'), false, 'engine text never reaches the card');
});

test('a failed older turn is not retried from the card; an engine code maps to engine', () => {
  const rows = [user('t1'), reply('t1', { error_code: 'CMP-AI-0002' }), user('t2')];
  const view = deriveChildView({ summary: summary(), work: { status: 'failed', turn_id: 't1' }, rows, firstTurnId: 't1' });
  assert.equal(view.error_class, 'engine', 'a plain connection failure is not the busy switch');
  assert.equal(view.retry, null, 'the child moved on to a newer turn');
});

test('a budget stop reads running while a resume is pending, then stopped with the chain count', () => {
  const rows = [user('t1'), reply('t1', { resumable_stop: 'context_budget', terminal_report_message_id: 'rep_1' })];
  const base = { summary: summary(), work: { status: 'completed', turn_id: 't1' }, rows };
  assert.equal(deriveChildView({ ...base, probe: { pending: true, count: 2, max: 5 } }).phase, 'running');
  const stopped = deriveChildView({ ...base, probe: { pending: false, count: 5, max: 5 }, readReplyTurnId: (id) => (id === 'rep_1' ? 'wake_turn' : '') });
  assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.resume_count, 5);
  assert.equal(stopped.resume_max, 5);
  assert.equal(stopped.reply_turn_id, 'wake_turn');
});

test('archived and deleted children; the key changes with what the card shows', () => {
  assert.equal(deriveChildView({ summary: summary({ archived_at: '2026-10-27T14:00:00Z' }) }).phase, 'archived');
  assert.equal(deriveChildView({ summary: null }).phase, 'gone');
  const a = deriveChildView({ summary: summary(), activeTurn: { status: 'streaming' } });
  const b = deriveChildView({ summary: summary(), activeTurn: { status: 'streaming' } });
  const c = deriveChildView({ summary: summary({ run_mode: 'auto' }), activeTurn: { status: 'streaming' } });
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, c.key);
});

test('the tracker views only accepted New session records and refreshes the source on child lifecycle events', () => {
  const changed = [];
  const tracker = createChildTracker({ readFacts: () => ({ summary: summary() }), changed: (id) => changed.push(id) });
  const record = {
    kind: 'session', decision: { choice: 'new_session' }, child_session_id: 'child', source_session_id: 'src',
    action_state: 'succeeded', first_turn_turn_id: 't1',
  };
  assert.equal(tracker.view({ ...record, decision: { choice: 'do_it_here' } }), null);
  assert.equal(tracker.view({ ...record, action_state: 'preparing' }), null);
  assert.equal(tracker.view(record).phase, 'starting');
  tracker.onEvent({ sessionId: 'child', turnId: 't1', type: 'token' });
  tracker.onEvent({ sessionId: 'child', turnId: 't1', type: 'token' });
  tracker.onEvent({ sessionId: 'child', turnId: 't1', type: 'tool_approval_requested' });
  tracker.onEvent({ sessionId: 'child', turnId: 't1', type: 'error' });
  assert.deepEqual(changed, ['src', 'src', 'src'], 'first event, approval and terminal; never a token delta');
  tracker.onEvent({ sessionId: 'src', turnId: 'w1', type: 'token' });
  tracker.onEvent({ sessionId: 'src', turnId: 'w1', type: 'complete' });
  assert.deepEqual(changed, ['src', 'src', 'src', 'src'], 'the source turn that admits the report refreshes too');
  assert.equal(createChildTracker({ readFacts: () => { throw new Error('x'); } }).view(record), null);
});

test('review fixes: needs_attention, a denied or stopped turn, a nested chat, and an automatic resume refresh', () => {
  assert.equal(deriveChildView({ summary: summary(), work: { status: 'needs_attention' }, rows: [user('t1'), reply('t1')] }).phase, 'attention');
  const denied = [user('t1'), { id: 'tc', role: 'assistant', turn_id: 't1', tool_call: { approval_state: 'denied' } }, reply('t1', { error_code: 'CMP-TOOL-0001' })];
  const deniedView = deriveChildView({ summary: summary(), work: { status: 'failed', turn_id: 't1' }, rows: denied });
  assert.equal(deniedView.phase, 'cancelled', 'the person denied a tool: Stopped, no Retry');
  assert.equal(deniedView.retry, null);
  const stopped = [user('t1'), reply('t1', { kind: 'assistant_error', terminal_status: 'cancelled' })];
  assert.equal(deriveChildView({ summary: summary(), rows: stopped }).phase, 'cancelled');

  const changed = [];
  const tracker = createChildTracker({ readFacts: () => ({ summary: summary() }), changed: (id) => changed.push(id) });
  const record = (child, source) => ({
    kind: 'session', decision: { choice: 'new_session' }, child_session_id: child, source_session_id: source, action_state: 'succeeded',
  });
  tracker.view(record('mid', 'top'));
  tracker.view(record('leaf', 'mid'));
  tracker.onEvent({ sessionId: 'mid', turnId: 'w1', type: 'complete' });
  assert.deepEqual(changed, ['top', 'mid'], 'a chat that is a child and a source refreshes both');
  tracker.touch('leaf');
  tracker.touch('unknown');
  assert.deepEqual(changed, ['top', 'mid', 'mid']);
});

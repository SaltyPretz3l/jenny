'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { CanonicalTurnEventCollector } = require('../../services/backend/canonical-turn-event-collector');
const { persistRuntimeContinuationPrefix } = require('../../services/backend/runtime-continuation-prefix');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-continuation-prefix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sessions.json');
  const store = new ElectronSessionStore(file);
  store.createSessionWithId('session_1', { title: 'Prefix' });
  store.appendMessage('session_1', { id: 'user_1', turn_id: 'turn_1', role: 'user', kind: 'message',
    content: 'Read the workspace.', timestamp: '2026-09-10T12:00:00.000Z' });
  const state = { current: true, journalEvents: [], flushes: 0, journalDurable: true };
  const journal = { append(session, turn, events) { state.journalEvents.push(...structuredClone(events)); },
    flush() { state.flushes += 1; return state.journalDurable; }, clear() { assert.fail('must retain journal'); } };
  const collector = new CanonicalTurnEventCollector({ store, sessionId: 'session_1', turnId: 'turn_1',
    attemptId: 'stream_1', canonicalPrimary: true, journal });
  const args = { collector, conversationStore: store.conversationStore, sessionId: 'session_1',
    turnId: 'turn_1', streamId: 'stream_1', assertCurrent: () => state.current };
  return { file, store, state, collector, args };
}

test('tools-only first call durably saves its user message with an empty event prefix', t => {
  const f = fixture(t);
  const result = persistRuntimeContinuationPrefix(f.args);
  assert.equal(result.through_seq, 0);
  assert.equal(result.commit.durable, true);
  const restarted = new ElectronSessionStore(f.file);
  assert.equal(restarted.getSession('session_1').messages[0].id, 'user_1');
  assert.equal(restarted.getSession('session_1').turn_events.length, 0);
});

test('canonical reasoning is saved without terminal projection or journal clearing', t => {
  const f = fixture(t);
  f.collector.noteEvent({ event_id: 'stream_1:canonical:3', turn_id: 'turn_1', kind: 'reasoning_phase',
    status: 'streaming', payload: { canonical_seq: 3, canonical_event_type: 'reasoning_delta', text: 'Inspecting' } });
  const before = structuredClone(f.collector.capturedEvents);
  const result = persistRuntimeContinuationPrefix(f.args);
  assert.equal(result.through_seq, 3);
  assert.deepEqual(f.collector.capturedEvents, before);
  assert.equal(f.state.journalEvents.length, 1);
  assert.equal(f.state.flushes, 1);
  const restarted = new ElectronSessionStore(f.file);
  const saved = restarted.getSession('session_1').turn_events[0];
  assert.equal(saved.payload.canonical_seq, 3);
  assert.equal(saved.status, 'streaming');
  assert.equal(saved.completed_at, '');
  assert.equal(persistRuntimeContinuationPrefix(f.args).through_seq, 3);
  assert.equal(f.store.getSession('session_1').turn_events.length, 1);
});

test('executing, approval, preview, malformed and wrong-attempt prefixes fail before canonical publication', t => {
  for (const kind of ['tool_executing', 'tool_result', 'approval_requested', 'preview_image']) {
    const f = fixture(t);
    f.collector.noteEvent({ event_id: 'event_1', turn_id: 'turn_1', kind, payload: { canonical_seq: 1 } });
    assert.throws(() => persistRuntimeContinuationPrefix(f.args), /prefix_ineligible/);
    assert.equal(f.store.getSession('session_1').turn_events.length, 0);
  }
  const f = fixture(t);
  f.collector.noteEvent({ event_id: 'event_1', turn_id: 'turn_1', kind: 'reasoning_phase', payload: {} });
  assert.throws(() => persistRuntimeContinuationPrefix(f.args), /prefix_ineligible/);
  f.args.streamId = 'old_stream';
  assert.throws(() => persistRuntimeContinuationPrefix(f.args), /prefix_fence_conflict/);
});

test('journal failure or lost authority retains captured recovery material and prevents canonical append', t => {
  const f = fixture(t);
  f.collector.noteEvent({ event_id: 'event_1', turn_id: 'turn_1', kind: 'reasoning_phase',
    payload: { canonical_seq: 1, text: 'Pending' } });
  f.state.journalDurable = false;
  assert.throws(() => persistRuntimeContinuationPrefix(f.args), /journal_not_durable/);
  assert.equal(f.collector.capturedEvents.length, 1);
  assert.equal(f.state.journalEvents.length, 1);
  assert.equal(f.store.getSession('session_1').turn_events.length, 0);
  f.state.current = false;
  assert.throws(() => persistRuntimeContinuationPrefix(f.args), /prefix_fence_conflict/);
});

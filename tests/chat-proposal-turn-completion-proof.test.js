'use strict';

/* Row 59 checkpoint 5a-1: the cp3 suspicion that `turn_completed` is never journaled, so a
 * restart reconciliation of a completed continuation could never prove success. The first two
 * tests pin the evidence with the REAL collector and journal; the rest pin the repaired proof
 * (`turnCompleteKnown` reads the persisted turn: rows present, none a failure). */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
const { buildCanonicalTurnEvent, UNPERSISTED_DURABLE_TYPES } = require('../services/backend/canonical-turn-event');
const { TurnEventJournal } = require('../services/backend/turn-event-journal');
const { buildCommitResult } = require('../services/backend/conversation-store-port');
const { turnCompleteKnown } = require('../services/chat-proposal-wiring');

const SESSION = 'sess_proof';
const TURN = 'turn_proof_1';

function realJournal(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-turn-proof-'));
  const journal = new TurnEventJournal(path.join(dir, 'turn-events.json'));
  t.after(() => {
    journal.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return journal;
}

test('the real collector never journals turn_completed: it is a durable type with no persisted row', (t) => {
  const journal = realJournal(t);
  const collector = new CanonicalTurnEventCollector({ turnId: TURN, sessionId: SESSION, journal });
  assert.equal(UNPERSISTED_DURABLE_TYPES.has('turn_completed'), true);
  const completed = buildCanonicalTurnEvent({ type: 'turn_completed', turn_id: TURN, session_id: SESSION, seq: 9, payload: {} });
  assert.equal(collector.noteEvent(completed), null, 'the collector drops turn_completed');
  collector.noteEvent({ kind: 'tool_use', turn_id: TURN, event_id: 'evt-1', status: 'pending', payload: {} });
  const kinds = journal.list(SESSION, TURN).map((event) => event.kind);
  assert.deepEqual(kinds, ['tool_use'], 'other durable rows are journaled, turn_completed is not');
  assert.equal(journal.list(SESSION, TURN).some((event) => event.type === 'turn_completed' || event.kind === 'turn_completed'), false);
});

test('the journal is cleared when the turn finalizes, so even a journaled marker would not survive to a restart', (t) => {
  const journal = realJournal(t);
  const collector = new CanonicalTurnEventCollector({ turnId: TURN, sessionId: SESSION, journal });
  collector.noteEvent({ kind: 'tool_use', turn_id: TURN, event_id: 'evt-1', status: 'pending', payload: {} });
  assert.equal(journal.list(SESSION, TURN).length, 1);
  const durable = buildCommitResult({ ok: true, applied: true, durable: true, commitEpoch: 1, dirtyEpoch: 1, durableEpoch: 1 });
  assert.equal(journal.clear(SESSION, TURN, { commitResult: durable }).cleared, true);
  assert.deepEqual(journal.list(SESSION, TURN), []);
});

function backend({ messages = [], events = [], journal = null } = {}) {
  return {
    turnEventJournal: journal,
    sessionStore: {
      peekSessionMessages: () => messages,
      getSessionTurnEvents: () => events,
    },
  };
}

const user = { id: 'u1', role: 'user', turn_id: TURN, content: 'go' };
const finished = { id: 'a1', role: 'assistant', turn_id: TURN, content: 'done', finalizedAt: '2026-10-15T10:00:00.000Z' };

test('turnCompleteKnown: a persisted turn with no failure row is a proven completion, even with an empty journal', (t) => {
  const journal = realJournal(t);
  assert.equal(turnCompleteKnown(backend({ messages: [user, finished], journal }), SESSION, TURN), true);
  assert.equal(turnCompleteKnown(backend({ messages: [user, finished], events: [{ turn_id: TURN, kind: 'tool_result' }] }), SESSION, TURN), true);
});

test('turnCompleteKnown: a failure row, an assistant_error event or a journaled failure refuses the proof', (t) => {
  const journal = realJournal(t);
  const failed = { ...finished, id: 'a2', stream_error: 'Chat stream failed.' };
  assert.equal(turnCompleteKnown(backend({ messages: [user, failed] }), SESSION, TURN), false);
  assert.equal(turnCompleteKnown(backend({ messages: [user, { ...finished, kind: 'assistant_error' }] }), SESSION, TURN), false);
  assert.equal(turnCompleteKnown(backend({ messages: [user, finished], events: [{ turn_id: TURN, kind: 'assistant_error' }] }), SESSION, TURN), false);
  const collector = new CanonicalTurnEventCollector({ turnId: TURN, sessionId: SESSION, journal });
  collector.noteEvent({ kind: 'assistant_error', turn_id: TURN, event_id: 'evt-err', status: 'error', payload: {} });
  assert.equal(turnCompleteKnown(backend({ messages: [user, finished], journal }), SESSION, TURN), false, 'an un-finalized journaled failure');
});

test('turnCompleteKnown: no persisted rows for the turn, other turns only, or an unreadable store prove nothing', () => {
  assert.equal(turnCompleteKnown(backend({ messages: [] }), SESSION, TURN), false);
  assert.equal(turnCompleteKnown(backend({ messages: [{ ...finished, turn_id: 'turn_other' }] }), SESSION, TURN), false);
  assert.equal(turnCompleteKnown({}, SESSION, TURN), false);
  assert.equal(turnCompleteKnown({ sessionStore: { peekSessionMessages() { throw new Error('boom'); } } }, SESSION, TURN), false);
});

'use strict';

// Direct unit tests for the extracted turn-event append/persist helpers
// (services/backend/session-turn-events.js). Static-literal import so the
// coverage-map graph reaches the source; the append body itself is additionally
// exercised end-to-end through ElectronSessionStore.appendTurnEvents.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TURN_EVENT_LOG_VERSION,
  appendTurnEventsToSession,
  persistDurableTurnEvents,
} = require('../services/backend/session-turn-events');
const { buildCommitResult } = require('../services/backend/conversation-store-port');
const {
  getLifecycleDiagnosticCounts,
  resetLifecycleDiagnosticCounts,
} = require('../services/backend/chat-lifecycle-diagnostics');

test('TURN_EVENT_LOG_VERSION is a positive integer', () => {
  assert.ok(Number.isInteger(TURN_EVENT_LOG_VERSION) && TURN_EVENT_LOG_VERSION > 0);
});

function makeFakeStore(appendResult) {
  return { appendTurnEvents: () => appendResult };
}

function makeJournal() {
  const cleared = [];
  return {
    cleared,
    clear: (sessionId, turnId, options) => {
      cleared.push({ sessionId, turnId, commitResult: options?.commitResult });
      return { ok: true, cleared: true, durable: true, reason: null };
    },
  };
}

test('persistDurableTurnEvents clears the journal and logs on a successful durable append', () => {
  const journal = makeJournal();
  const logs = [];
  const { appended } = persistDurableTurnEvents({
    store: makeFakeStore(buildCommitResult({
      ok: true, applied: true, durable: true, commitEpoch: 2, dirtyEpoch: 2,
      durableEpoch: 2, value: { appended: 2, duplicateCount: 0 },
    })),
    journal,
    logger: (level, event, data) => logs.push({ level, event, data }),
    sessionId: 'sess-ok',
    turnId: 'turn-ok',
    events: [{}, {}],
    session: { turn_events: [] },
  });
  assert.equal(appended, 2);
  assert.equal(journal.cleared.length, 1);
  assert.equal(journal.cleared[0].commitResult.commitEpoch, 2);
  assert.equal(logs.filter((l) => l.event === 'chat.turn_events_persisted').length, 1);
});

test('persistDurableTurnEvents RETAINS the journal and WARNs on a failed durable append', () => {
  resetLifecycleDiagnosticCounts();
  const journal = makeJournal();
  const logs = [];
  const { appended } = persistDurableTurnEvents({
    store: makeFakeStore(buildCommitResult({ reason: 'newer_schema' })),
    journal,
    logger: (level, event, data) => logs.push({ level, event, data }),
    sessionId: 'sess-fail',
    turnId: 'turn-fail',
    events: [{}],
    session: { turn_events: [] },
  });
  assert.equal(appended, 0);
  assert.deepEqual(journal.cleared, [], 'a failed persist must not clear the journal');
  const warns = logs.filter((l) => l.event === 'turn_journal.retained_after_persist_failure');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].data.reason, 'newer_schema');

  // L1 diagnostics (Chat Lifecycle v2 plan §4): a refused durable append is
  // one of the two backend durability_degrade sites this wave wires into
  // chat-lifecycle-diagnostics.js's shared counter.
  const lifecycleWarns = logs.filter((l) => l.event === 'lifecycle.durability_degrade');
  assert.equal(lifecycleWarns.length, 1);
  assert.equal(lifecycleWarns[0].level, 'WARN');
  assert.equal(lifecycleWarns[0].data.reason, 'newer_schema');
  assert.equal(lifecycleWarns[0].data.sessionId, 'sess-fail');
  assert.equal(lifecycleWarns[0].data.turnId, 'turn-fail');
  assert.deepEqual(getLifecycleDiagnosticCounts(), { durability_degrade: 1 });
});

test('persistDurableTurnEvents rejects a legacy summary without epoch proof', () => {
  const journal = makeJournal();
  const result = persistDurableTurnEvents({
    store: makeFakeStore({ id: 'summary' }),
    journal,
    logger: null,
    sessionId: 'sess-legacy',
    turnId: 'turn-legacy',
    events: [{}, {}, {}],
    session: { turn_events: [] },
  });
  assert.deepEqual(result, { ok: false, appended: 0, reason: 'invalid_commit_result' });
  assert.deepEqual(journal.cleared, []);
});

// ---------------------------------------------------------------------------
// SP-03 (L0.3): duplicate-only durable replay must flush before clearing the
// journal. These drive the REAL appendTurnEventsToSession control flow (via
// persistDurableTurnEvents -> store.appendTurnEvents -> the actual exported
// function) against a store double whose lower-level primitives
// (getSession/_compactTurnEvents/_updateSessionRecord/_backend.flushSession)
// are faked, but appendTurnEventsToSession itself is never mocked or
// bypassed. This reproduces the real sequence: a debounced write means the
// cache can be mutated durable:true and still fail to flush; a retried
// durable append of the SAME (now-duplicate) events must not report ok:true
// -- and therefore must not let the caller clear its crash-recovery journal
// -- unless a flush actually lands the events on disk.
// ---------------------------------------------------------------------------

// A store double that implements just enough of ElectronSessionStore's
// surface for appendTurnEventsToSession to run its real control flow:
// in-memory session cache, identity compaction, and a controllable
// `_backend.flushSession` whose per-call outcome is driven by `flushResults`
// (the last entry repeats once exhausted).
function makeControllableStore(flushResults) {
  let session = { turn_events: [], turn_event_log_version: 0, turn_event_seq_counter: 0 };
  let dirtyEpoch = 1;
  let durableEpoch = 1;
  const flushCalls = [];
  const store = {
    _logger: null,
    getSession: () => session,
    _compactTurnEvents: (sessionId, turnEvents) => turnEvents,
    _updateSessionRecord: (sessionId, patch) => {
      session = { ...session, ...patch };
      dirtyEpoch += 1;
      return session;
    },
    flushSession: (sessionId) => {
      const outcome = flushResults[Math.min(flushCalls.length, flushResults.length - 1)];
      flushCalls.push(sessionId);
      if (outcome) durableEpoch = dirtyEpoch;
      return outcome;
    },
    _backend: {
      hasNewerSchema: () => false,
      getSessionDurability: () => ({ dirtyEpoch, durableEpoch }),
    },
  };
  store.appendTurnEvents = (sessionId, events, options) =>
    appendTurnEventsToSession(store, sessionId, events, options);
  return { store, flushCalls, getSession: () => session };
}

test('SP-03: duplicate-only durable replay flushes before reporting ok, and clears the journal only after a successful flush', () => {
  // First flush attempt fails, second (retry) succeeds.
  const { store, flushCalls } = makeControllableStore([false, true]);
  const journal = makeJournal();
  const logs = [];
  const logger = (level, event, data) => logs.push({ level, event, data });
  const events = [{ turn_id: 'turn-1', kind: 'assistant_text', event_id: 'evt-1' }];

  // First durable append: a real (non-duplicate) event lands in the cache but
  // the forced flush fails -> ok:false, journal retained.
  const first = persistDurableTurnEvents({
    store, journal, logger, sessionId: 'sess-1', turnId: 'turn-1', events,
  });
  assert.equal(first.ok, false, 'a failed flush must not report ok:true');
  assert.equal(flushCalls.length, 1, 'the first durable append must attempt a flush');
  assert.deepEqual(journal.cleared, [], 'the journal must be retained after a failed flush');

  // Retry in the same process with the SAME events: they are now duplicates
  // against the cache mutated by the first (flush-failed) attempt. This is
  // the exact SP-03 sequence: duplicate-only durable append must still flush
  // before reporting success, not short-circuit to ok:true from the cache.
  const second = persistDurableTurnEvents({
    store, journal, logger, sessionId: 'sess-1', turnId: 'turn-1', events,
  });
  assert.equal(flushCalls.length, 2, 'a duplicate-only durable append must still trigger a flush call');
  assert.equal(second.ok, true, 'ok:true is reported once the retry flush succeeds');
  assert.equal(journal.cleared.length, 1,
    'the journal is cleared only after the successful flush, not on the earlier failed attempt');
  assert.equal(journal.cleared[0].commitResult.durableEpoch, 2);
});

test('SP-03: duplicate-only durable replay retains the journal when the flush fails on every attempt', () => {
  const { store, flushCalls } = makeControllableStore([false, false]);
  const journal = makeJournal();
  const events = [{ turn_id: 'turn-2', kind: 'assistant_text', event_id: 'evt-2' }];

  const first = persistDurableTurnEvents({
    store, journal, logger: null, sessionId: 'sess-2', turnId: 'turn-2', events,
  });
  assert.equal(first.ok, false);

  const second = persistDurableTurnEvents({
    store, journal, logger: null, sessionId: 'sess-2', turnId: 'turn-2', events,
  });
  assert.equal(flushCalls.length, 2, 'the duplicate-only retry must still attempt a flush');
  assert.equal(second.ok, false, 'ok must stay false when the retry flush also fails');
  assert.deepEqual(
    journal.cleared,
    [],
    'the journal must never be cleared while every flush attempt has failed'
  );
});

test('SP-03: a NON-durable duplicate-only append keeps its early return and never calls flushSession', () => {
  const { store, flushCalls } = makeControllableStore([false]);
  const events = [{ turn_id: 'turn-3', kind: 'assistant_text', event_id: 'evt-3' }];

  // Prime the cache with a non-durable append so the second call is all-duplicates.
  const first = appendTurnEventsToSession(store, 'sess-3', events, { durable: false });
  assert.equal(first.ok, true);
  assert.equal(flushCalls.length, 0, 'a non-durable append never flushes');

  const second = appendTurnEventsToSession(store, 'sess-3', events, { durable: false });
  assert.equal(second.ok, true);
  assert.equal(second.reason, 'all_duplicates');
  assert.deepEqual(second.value, { appended: 0, duplicateCount: 1 });
  assert.equal(flushCalls.length, 0, 'a non-durable duplicate-only append must not trigger a flush');
});

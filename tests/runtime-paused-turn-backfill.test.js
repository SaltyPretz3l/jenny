'use strict';

// 2026-09-22: a paused continuation persisted reasoning/tool_executing/
// tool_result events and was cancelled at restart without terminal
// finalization, so every reopen projected orphan_tool_executing rows.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  backfillCancelledPausedTurnEvents,
  emitCancelledPausedTurnTerminal,
  isCancelledPausedWork,
  repairCancelledPausedTurns,
} = require('../services/backend/runtime-paused-turn-backfill');
const rowProjector = require('../renderer/chat/renderer-turn-row-projector');

const SESSION = 'sess_backfill';
const TURN = 'turn_backfill';
const STREAM = 'stream_backfill';
const CALL = 'call_backfill_1';

function messages() {
  return [
    { id: `user_${STREAM}`, role: 'user', content: 'List the workspace', turn_id: TURN },
    { id: `tool_use_${STREAM}_${CALL}`, role: 'assistant', kind: 'tool_use', content: 'list_dir', turn_id: TURN,
      tool_call: { call_id: CALL, tool_name: 'list_dir', input_json: '{}', input: {}, summary: 'list_dir',
        status: 'completed', parent_stream_id: STREAM } },
    { id: `tool_result_${STREAM}_${CALL}`, role: 'tool', kind: 'tool_result', content: 'list_dir', turn_id: TURN,
      tool_result: { call_id: CALL, tool_name: 'list_dir', output_text: 'entries: 1', summary: 'list_dir',
        is_error: false, parent_stream_id: STREAM } },
  ];
}

function pausedPrefixEvents() {
  return [
    { event_id: `${STREAM}:canonical:1`, event_seq: 0, turn_id: TURN, kind: 'tool_executing', status: 'running',
      primary_message_id: `tool_use_${STREAM}_${CALL}`, tool_call_id: CALL, payload: { tool_name: 'list_dir' } },
    { event_id: `${STREAM}:canonical:2`, event_seq: 1, turn_id: TURN, kind: 'tool_result', status: 'completed',
      primary_message_id: `tool_result_${STREAM}_${CALL}`, tool_call_id: CALL, payload: { tool_name: 'list_dir' } },
  ];
}

function makeStore(events = pausedPrefixEvents()) {
  const store = {
    events: [...events],
    appended: [],
    getSessionMessages: (sessionId) => (sessionId === SESSION ? messages() : []),
    getSessionTurnEvents: (sessionId) => (sessionId === SESSION ? store.events : []),
    appendTurnEvents(sessionId, incoming, options) {
      assert.equal(sessionId, SESSION);
      assert.equal(options.durable, true);
      const known = new Set(store.events.map((event) => event.event_id));
      const fresh = incoming.filter((event) => !known.has(event.event_id))
        .map((event, index) => ({ ...event, event_seq: store.events.length + index }));
      store.events.push(...fresh);
      store.appended.push(...fresh);
      return { ok: true, appended: fresh.length };
    },
  };
  return store;
}

const cancelledPaused = {
  work_id: 'work_backfill', session_id: SESSION, turn_id: TURN, status: 'cancelled',
  checkpoint_ref: { checkpoint_id: 'checkpoint_backfill' }, transition: { from: 'paused', to: 'cancelled' },
};

test('a cancelled paused turn gets exactly its missing tool_use events', () => {
  const store = makeStore();
  const orphanedBefore = JSON.stringify(rowProjector.projectTurnRows(store.events, {})).match(/orphan_/g) || [];
  assert.equal(orphanedBefore.length, 1);

  assert.equal(backfillCancelledPausedTurnEvents(store, cancelledPaused), 1);
  assert.deepEqual(store.appended.map((event) => [event.kind, event.tool_call_id]), [['tool_use', CALL]]);
  assert.equal(JSON.stringify(rowProjector.projectTurnRows(store.events, {})).match(/orphan_/g), null);

  assert.equal(backfillCancelledPausedTurnEvents(store, cancelledPaused), 0, 'idempotent once repaired');
});

test('only cancelled work that was paused on a checkpoint is touched', () => {
  assert.equal(isCancelledPausedWork({ ...cancelledPaused, transition: { from: 'running' } }), false);
  assert.equal(isCancelledPausedWork({ ...cancelledPaused, checkpoint_ref: null }), false);
  assert.equal(isCancelledPausedWork({ ...cancelledPaused, status: 'paused' }), false);
  const store = makeStore();
  assert.equal(backfillCancelledPausedTurnEvents(store, { ...cancelledPaused, transition: { from: 'running' } }), 0);
  assert.equal(store.appended.length, 0);
});

test('the startup repair scans cancelled work and skips everything else', () => {
  const store = makeStore();
  const runtimeStore = {
    index: { summaries: [
      { work_id: 'work_running', status: 'running' },
      { work_id: 'work_backfill', status: 'cancelled' },
    ] },
    get: (workId) => (workId === 'work_backfill' ? cancelledPaused : { status: 'running' }),
  };
  assert.deepEqual(repairCancelledPausedTurns(runtimeStore, store), { appended: 1, failed: 0 });
  assert.deepEqual(repairCancelledPausedTurns(runtimeStore, store), { appended: 0, failed: 0 });
});

test('the repair reaches an old orphaned turn behind many newer cancellations', () => {
  const store = makeStore();
  const newer = Array.from({ length: 100 }, (_unused, index) => ({ work_id: `work_new_${index}`, status: 'cancelled' }));
  const runtimeStore = {
    index: { summaries: [{ work_id: 'work_backfill', status: 'cancelled' }, ...newer] },
    get: (workId) => (workId === 'work_backfill' ? cancelledPaused : { status: 'cancelled', transition: { from: 'running' } }),
  };
  assert.deepEqual(repairCancelledPausedTurns(runtimeStore, store), { appended: 1, failed: 0 });
});

// Dogfood HB-034: a paused leg gets no terminal of its own, so a stopped or
// discarded paused reply left the chat showing a live stream until reload.
const stoppedPaused = {
  ...cancelledPaused,
  attempt: { attempt_id: 'attempt_1', stream_id: STREAM, incarnation: 'incarnation_live', authority_revision: 'a1' },
  transition: { from: 'paused', to: 'cancelled', reason: 'user_cancel' },
};

function emitter() {
  const events = [];
  return { events, emit: (channel, payload) => events.push([channel, payload]) };
}

test('a stopped paused turn ends its live stream with one cancelled terminal', () => {
  const service = emitter();
  assert.equal(emitCancelledPausedTurnTerminal(service, stoppedPaused, 'incarnation_live'), true);
  assert.equal(service.events.length, 1);
  const [channel, payload] = service.events[0];
  assert.equal(channel, 'chat-stream');
  assert.equal(payload.type, 'error');
  assert.equal(payload.status, 'cancelled');
  assert.equal(payload.category, 'cancelled');
  assert.equal(payload.cancel_reason, 'user_cancel');
  assert.deepEqual([payload.sessionId, payload.streamId, payload.turnId], [SESSION, STREAM, TURN]);

  const discarded = emitter();
  assert.equal(emitCancelledPausedTurnTerminal(discarded,
    { ...stoppedPaused, transition: { from: 'paused', to: 'cancelled', reason: 'user' } }, 'incarnation_live'), true);
});

test('no terminal is sent for work this process never streamed, or that the user did not stop', () => {
  for (const work of [
    { ...stoppedPaused, attempt: { ...stoppedPaused.attempt, incarnation: 'incarnation_before_restart' } },
    { ...stoppedPaused, transition: { from: 'paused', to: 'cancelled', reason: 'session_cancelled' } },
    { ...stoppedPaused, transition: { from: 'running', to: 'cancelled', reason: 'user_cancel' } },
    { ...stoppedPaused, status: 'paused' },
    { ...stoppedPaused, attempt: null },
    { ...stoppedPaused, checkpoint_ref: null },
  ]) {
    const service = emitter();
    assert.equal(emitCancelledPausedTurnTerminal(service, work, 'incarnation_live'), false);
    assert.equal(service.events.length, 0);
  }
  assert.equal(emitCancelledPausedTurnTerminal(emitter(), stoppedPaused, ''), false);
});

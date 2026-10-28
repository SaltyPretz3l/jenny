'use strict';

/* Row 76 S3: the primary chat's Pause inside the wake decision (services/chat-messaging-wake.js).
 * While `paused(destination)` is true nothing wakes that chat; mail stays queued and deferred.
 * `resumeDestination` is the user's Resume gesture: it rebuilds deferred entries from the inbox
 * (a restart empties the in-memory maps) and wakes once for the oldest queued message. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGE_WAKE_PROMPT, REPORT_WAKE_PROMPT, createWakeOps } = require('../services/chat-messaging-wake');

const SRC = 'sess_source';
const DST = 'sess_dest';
const chat = (title) => ({
  id: title, title, session_type: 'chat', archived_at: null, lockdown: false, messaging_addressable: true,
  preferred_model: 'qwen-local', reasoning_effort: 'high', plan_mode: false, run_mode: 'auto',
});

// One shared world (inbox, summaries, activity); `build()` makes a fresh ops over it, as after a restart.
// A submit marks the oldest queued record attempted, as the real turn start admits the mail.
function world({ paused = () => false, midTurn = null } = {}) {
  const state = {
    paused, activeTurn: new Map(), work: new Set(), inbox: new Map(), submits: [], pushes: [], rechecks: [], logs: [],
    summaries: { [SRC]: chat('Research notes'), [DST]: chat('Builder') },
  };
  let turn = 0;
  const build = () => createWakeOps({
    paused: (id) => state.paused(id),
    getSessionSummary: (id) => state.summaries[id] || null,
    getActiveTurn: (id) => state.activeTurn.get(id) || null,
    hasSessionWork: (id) => state.work.has(id),
    readInbox: (id) => state.inbox.get(id) || [],
    submitTurn: async (request, options) => {
      state.submits.push({ request, options });
      turn += 1;
      return { ok: true, created: true, work_id: `work_${turn}`, turn_id: `turn_wake_${turn}` };
    },
    deliverMidTurn: midTurn ? (id, ids) => { state.pushes.push({ id, ids }); return midTurn(); } : null,
    now: () => new Date(Date.parse('2026-10-25T10:00:00.000Z')),
    log: (level, event, details) => state.logs.push([level, event, details]),
    scheduleRecheck: (fn) => { state.rechecks.push(fn); return null; },
  });
  let n = 0;
  const deliver = (extra = {}, receiveSequence = n + 1) => {
    n += 1;
    const envelope = {
      message_id: `msg_${String(n).padStart(4, '0')}`, kind: 'user_message', source_session_id: SRC,
      destination_session_id: DST, source_turn_id: null, ...extra,
    };
    const inbox = state.inbox.get(DST) || [];
    inbox.push({ envelope, receive_sequence: receiveSequence, context: { state: 'queued' } });
    state.inbox.set(DST, inbox);
    return { operation_id: `op_${n}`, state: 'delivered', envelope };
  };
  const markAll = (nextState) => {
    for (const record of state.inbox.get(DST) || []) record.context = { state: nextState };
  };
  return { build, state, deliver, markAll };
}

const skipped = (state) => state.logs.filter(([, event, d]) => event === 'chat_messaging.wake_skipped' && d.reason === 'paused');

test('a delivery to a paused idle destination wakes nothing, logs paused and keeps the entry deferred', async () => {
  const { build, state, deliver } = world({ paused: () => true });
  const ops = build();
  assert.deepEqual(await ops.onDelivered(deliver()), { outcome: 'paused' });
  assert.equal(state.submits.length, 0);
  assert.equal(skipped(state).length, 1);
  assert.deepEqual(skipped(state)[0][2], { destination_session_id: DST, message_id: 'msg_0001', kind: 'message', reason: 'paused' });
  assert.equal(ops.stats().deferred, 1);
  assert.equal(state.logs.some(([, event]) => event === 'chat_messaging.wake_deferred'), false, 'no wake_deferred log for paused');
  assert.equal(state.rechecks.length, 0, 'no watchSettling');
});

test('a paused working destination gets no mid-turn push', async () => {
  const { build, state, deliver } = world({ paused: () => true, midTurn: () => ({ ok: true }) });
  state.activeTurn.set(DST, { turn_id: 'turn_user' });
  const ops = build();
  assert.equal((await ops.onDelivered(deliver())).outcome, 'paused');
  assert.equal(state.pushes.length, 0);
  assert.equal(state.submits.length, 0);
});

test('a settle while paused keeps the entries; once unpaused the next settle wakes once with the oldest', async () => {
  let isPaused = true;
  const { build, state, deliver } = world({ paused: () => isPaused });
  const ops = build();
  await ops.onDelivered(deliver());
  await ops.onDelivered(deliver());
  assert.equal((await ops.onTurnSettled(DST)).outcome, 'paused');
  assert.equal(state.submits.length, 0);
  assert.equal(ops.stats().deferred, 2);
  isPaused = false;
  assert.equal((await ops.onTurnSettled(DST)).outcome, 'submitted');
  assert.equal(state.submits.length, 1);
  assert.match(state.submits[0].options.idempotencyKey, /^wake_/);
});

test('resumeDestination after a restart wakes once for the oldest queued message; a second call is a no-op', async () => {
  const w = world();
  w.deliver({ kind: 'terminal_report', source_turn_id: 'turn_child' }, 7); // listed first, received last
  w.deliver({ kind: 'user_message' }, 3);
  const ops = w.build(); // fresh maps: nothing deferred yet
  assert.equal(ops.stats().deferred, 0);
  const result = await ops.resumeDestination(DST);
  assert.equal(result.outcome, 'submitted');
  assert.equal(w.state.submits.length, 1);
  assert.equal(w.state.submits[0].request.prompt, MESSAGE_WAKE_PROMPT, 'the oldest receive_sequence is the user_message');
  assert.equal(w.state.submits[0].request.visiblePrompt, 'Woken by a message from Research notes');
  assert.match(w.state.submits[0].options.idempotencyKey, /^wake_/);
  assert.equal(ops.depthForTurn('turn_wake_1'), 1);
  w.markAll('attempted'); // the woken turn admitted the mail
  assert.equal((await ops.resumeDestination(DST)).outcome, 'none');
  assert.equal(w.state.submits.length, 1);
});

test('resumeDestination never re-queues a message whose wake was already attempted in this process', async () => {
  const w = world();
  const ops = w.build();
  await ops.onDelivered(w.deliver()); // idle destination: the delivery itself wakes it once
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.state.submits.length, 1);
  assert.equal((await ops.resumeDestination(DST)).outcome, 'none', 'the mail is still queued, but its wake was attempted');
  assert.equal(w.state.submits.length, 1);
});

test('resumeDestination wakes a queued terminal_report with the report prompt', async () => {
  const w = world();
  w.deliver({ kind: 'terminal_report', source_turn_id: 'turn_child' });
  const result = await w.build().resumeDestination(DST);
  assert.equal(result.outcome, 'submitted');
  assert.equal(w.state.submits[0].request.prompt, REPORT_WAKE_PROMPT);
});

test('resumeDestination on a busy destination defers, schedules a recheck and wakes once it is idle', async () => {
  const w = world();
  w.deliver();
  w.state.work.add(DST); // no active turn, the runtime still holds work: watchSettling applies
  const ops = w.build();
  assert.equal((await ops.resumeDestination(DST)).outcome, 'deferred');
  assert.equal(w.state.submits.length, 0);
  assert.equal(w.state.rechecks.length, 1);
  w.state.work.delete(DST);
  w.state.rechecks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.state.submits.length, 1);
});

test('resumeDestination with no queued mail is none; still paused is paused; an unreadable inbox is none', async () => {
  const w = world();
  assert.deepEqual(await w.build().resumeDestination(DST), { outcome: 'none' });
  w.deliver();
  w.state.paused = () => true;
  const ops = w.build();
  assert.equal((await ops.resumeDestination(DST)).outcome, 'paused');
  assert.equal(w.state.submits.length, 0);
  assert.equal(ops.stats().deferred, 1);
  assert.deepEqual(await createWakeOps({ readInbox: () => null }).resumeDestination(DST), { outcome: 'none' });
  assert.deepEqual(await createWakeOps({ readInbox: () => { throw new Error('boom'); } }).resumeDestination(DST), { outcome: 'none' });
});

test('a throwing paused port reads as not paused', async () => {
  const { build, state, deliver } = world({ paused: () => { throw new Error('boom'); } });
  assert.equal((await build().onDelivered(deliver())).outcome, 'submitted');
  assert.equal(state.submits.length, 1);
});

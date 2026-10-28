'use strict';

/* Row 70 W1: a delivered message or report wakes the destination chat (services/chat-messaging-wake.js).
 * Pure decision logic over fakes: an injected clock, a recording submitTurn and an in-memory inbox. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const {
  AGENT_MESSAGE_WAKE_PROMPT, MESSAGE_WAKE_PROMPT, REPORT_WAKE_PROMPT, createWakeOps, isTurnSettledEvent, wakeIdempotencyKey, wakeTitle,
} = require('../services/chat-messaging-wake');

const START_MS = Date.parse('2026-10-20T10:00:00.000Z');
const TEN_MINUTES = 10 * 60 * 1000;
const SRC = 'sess_source';
const DST = 'sess_dest';

function chat(title, extra = {}) {
  return {
    id: extra.id || title, title, session_type: 'chat', archived_at: null, lockdown: false, messaging_addressable: true,
    preferred_model: 'qwen-local', reasoning_effort: 'high', plan_mode: false, run_mode: 'auto', ...extra,
  };
}

function harness({ summaries = {}, results = [], maxTracked, enabled = true, midTurn = null, reserve = undefined } = {}) {
  const state = {
    clock: START_MS,
    enabled,
    summaries: { [SRC]: chat('Research notes'), [DST]: chat('Builder'), ...summaries },
    activeTurn: new Map(),
    work: new Set(),
    inbox: new Map(),
    submits: [],
    pushes: [],
    reserves: [],
    rechecks: [],
    logs: [],
    results: [...results],
  };
  let turn = 0;
  const ops = createWakeOps({
    enabled: () => state.enabled,
    getSessionSummary: (id) => state.summaries[id] || null,
    getActiveTurn: (id) => state.activeTurn.get(id) || null,
    hasSessionWork: (id) => state.work.has(id),
    readInbox: (id) => state.inbox.get(id) || [],
    submitTurn: async (request, options) => {
      state.submits.push({ request, options });
      if (state.results.length) return state.results.shift();
      turn += 1;
      return { ok: true, created: true, work_id: `work_${turn}`, turn_id: `turn_wake_${turn}` };
    },
    now: () => new Date(state.clock),
    log: (level, event, details) => state.logs.push([level, event, details]),
    ...(reserve ? { reserveReportBack: (request) => { state.reserves.push(request); return reserve(request); } } : {}),
    ...(maxTracked ? { maxTracked } : {}),
    ...(midTurn ? { deliverMidTurn: (id, messageIds) => { state.pushes.push({ id, messageIds }); return midTurn(id, messageIds); } } : {}),
    scheduleRecheck: (fn) => { state.rechecks.push(fn); return null; },
  });
  let n = 0;
  // A delivered operation as the delivery transaction returns it; the destination inbox holds it as queued.
  const deliver = (extra = {}) => {
    n += 1;
    const envelope = {
      message_id: `msg_${String(n).padStart(4, '0')}`, kind: 'user_message', source_session_id: SRC,
      destination_session_id: DST, source_turn_id: null, body: 'secret body text', ...extra,
    };
    const inbox = state.inbox.get(envelope.destination_session_id) || [];
    inbox.push({ envelope, context: { state: 'queued' } });
    state.inbox.set(envelope.destination_session_id, inbox);
    return { operation_id: `op_${n}`, state: 'delivered', envelope };
  };
  const setContext = (messageId, context) => {
    for (const records of state.inbox.values()) {
      for (const record of records) if (record.envelope.message_id === messageId) record.context = context;
    }
  };
  return { ops, state, deliver, setContext };
}

// ---------- submit ----------

test('an idle destination is woken once with the exact request of the destination chat', async () => {
  const longTitle = `Research\u0007 notes ${'x'.repeat(120)}`;
  const { ops, state, deliver } = harness({ summaries: { [SRC]: chat(longTitle) } });
  const op = deliver();
  const result = await ops.onDelivered(op);
  assert.equal(result.outcome, 'submitted');
  assert.equal(state.submits.length, 1);
  const [{ request, options }] = state.submits;
  const clipped = Array.from(`Research notes ${'x'.repeat(120)}`).slice(0, 80).join('');
  assert.deepEqual(request, {
    sessionId: DST,
    prompt: MESSAGE_WAKE_PROMPT,
    visiblePrompt: `Woken by a message from ${clipped}`,
    applicationTurn: 'wake',
    attachments: [],
    preferredModel: 'qwen-local',
    reasoningEffort: 'high',
    planMode: false,
    approvalMode: 'auto_run',
  });
  const digest = createHash('sha256').update(op.envelope.message_id).digest('hex').slice(0, 32);
  assert.equal(options.idempotencyKey, `wake_${digest}`);
  assert.equal(wakeIdempotencyKey(op.envelope.message_id), `wake_${digest}`);
  assert.match(options.idempotencyKey, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u, 'the runtime ID_PATTERN accepts it');
  assert.equal(ops.depthForTurn('turn_wake_1'), 1, 'the wake turn carries depth 1');
  const submitted = state.logs.find(([, event]) => event === 'chat_messaging.wake_submitted');
  assert.deepEqual(submitted[2], { destination_session_id: DST, kind: 'message', depth: 1, work_id: 'work_1' });
});

test('the request follows the destination authority: Ask prompts, Plan stays Plan, absent fields fall back', async () => {
  const { ops, state, deliver } = harness({
    summaries: { [DST]: chat('Builder', { run_mode: 'ask', plan_mode: true, preferred_model: null, reasoning_effort: 3 }) },
  });
  await ops.onDelivered(deliver());
  const { request } = state.submits[0];
  assert.equal(request.approvalMode, 'prompt');
  assert.equal(request.planMode, true);
  assert.equal(request.preferredModel, '');
  assert.equal(request.reasoningEffort, undefined);
});

test('a terminal report uses the report prompt and anchor; an unknown source falls back to "another chat"', async () => {
  const { ops, state, deliver } = harness();
  delete state.summaries[SRC];
  await ops.onDelivered(deliver({ kind: 'terminal_report', source_turn_id: 'turn_child' }));
  const { request } = state.submits[0];
  assert.equal(request.prompt, REPORT_WAKE_PROMPT);
  assert.equal(request.visiblePrompt, 'Woken by a report from another chat');
  assert.equal(wakeTitle('\u0000\u001f  '), 'another chat');
  assert.equal(wakeTitle('Plan  review'), 'Plan  review');
});

// ---------- refusals ----------

test('the kill switch wakes nothing and defers nothing', async () => {
  const { ops, state, deliver } = harness({ enabled: false });
  state.activeTurn.set(DST, { turn_id: 'turn_user' });
  assert.equal((await ops.onDelivered(deliver())).outcome, 'disabled');
  state.activeTurn.clear();
  assert.equal((await ops.onDelivered(deliver())).outcome, 'disabled');
  await ops.onTurnSettled(DST);
  assert.equal(state.submits.length, 0);
  assert.equal(ops.stats().deferred, 0);
});

test('an archived, lockdown, non-chat, unaddressable or missing destination is never woken', async () => {
  for (const patch of [{ archived_at: '2026-10-20T09:00:00.000Z' }, { lockdown: true }, { session_type: 'image' },
    { messaging_addressable: false }, null]) {
    const { ops, state, deliver } = harness();
    if (patch) state.summaries[DST] = chat('Builder', patch);
    else delete state.summaries[DST];
    const result = await ops.onDelivered(deliver());
    assert.equal(result.outcome, 'ineligible', JSON.stringify(patch));
    assert.equal(state.submits.length, 0);
    assert.equal(ops.stats().deferred, 0);
  }
});

test('a message from a chat woken at the depth cap does not wake; one below the cap wakes at the cap', async () => {
  const { ops, state, deliver } = harness();
  ops.noteWakeTurn('turn_deep', 3);
  ops.noteWakeTurn('turn_mid', 2);
  const deep = await ops.onDelivered(deliver({ kind: 'agent_message', source_turn_id: 'turn_deep' }));
  assert.deepEqual(deep, { outcome: 'depth_exceeded' });
  assert.equal(state.submits.length, 0);
  assert.ok(state.logs.some(([, event, details]) => event === 'chat_messaging.wake_depth_exceeded' && details.depth === 4));
  const mid = await ops.onDelivered(deliver({ kind: 'agent_message', source_turn_id: 'turn_mid' }));
  assert.equal(mid.outcome, 'submitted');
  assert.equal(ops.depthForTurn('turn_wake_1'), 3);
  assert.equal(ops.depthForTurn('turn_unknown'), 0);
});

test('at most six wakes per destination in ten minutes; the window rolls', async () => {
  const { ops, state, deliver } = harness();
  for (let i = 0; i < 6; i += 1) {
    assert.equal((await ops.onDelivered(deliver())).outcome, 'submitted', `wake ${i + 1}`);
    state.clock += 1000;
  }
  assert.equal((await ops.onDelivered(deliver())).outcome, 'rate_limited');
  assert.equal(state.submits.length, 6);
  assert.ok(state.logs.some(([, event]) => event === 'chat_messaging.wake_rate_limited'));
  state.clock = START_MS + TEN_MINUTES + 1;
  assert.equal((await ops.onDelivered(deliver())).outcome, 'submitted');
  assert.equal(state.submits.length, 7);
});

test('an operation that is not delivered, or a message already attempted, never submits', async () => {
  const { ops, state, deliver } = harness();
  const failed = deliver();
  assert.equal((await ops.onDelivered({ ...failed, state: 'failed' })).outcome, 'not_delivered');
  assert.equal((await ops.onDelivered(null)).outcome, 'not_delivered');
  const op = deliver();
  await ops.onDelivered(op);
  assert.equal((await ops.onDelivered(op)).outcome, 'duplicate');
  assert.equal(state.submits.length, 1);
});

// ---------- deferral ----------

test('a busy destination defers; its settled turn wakes it once while the message is still queued', async () => {
  const { ops, state, deliver } = harness();
  state.activeTurn.set(DST, { turn_id: 'turn_user' });
  assert.equal((await ops.onDelivered(deliver())).outcome, 'deferred');
  assert.equal(state.submits.length, 0);
  assert.equal(ops.stats().deferred, 1);
  // The terminal event of the running turn is the idle signal (the runtime still lists the settling work then).
  const settled = await ops.onTurnSettled(DST);
  assert.equal(settled.outcome, 'submitted');
  assert.equal(state.submits.length, 1);
  assert.equal(ops.stats().deferred, 0);
  assert.equal((await ops.onTurnSettled(DST)).outcome, 'none', 'a second settle runs nothing');
  assert.equal(state.submits.length, 1);
});

test('runtime work alone also defers', async () => {
  const { ops, state, deliver } = harness();
  state.work.add(DST);
  assert.equal((await ops.onDelivered(deliver())).outcome, 'deferred');
  assert.equal(state.submits.length, 0);
});

test('a settle after the user turn included the message runs nothing and forgets the entry', async () => {
  const { ops, state, deliver, setContext } = harness();
  state.activeTurn.set(DST, { turn_id: 'turn_user' });
  const op = deliver();
  await ops.onDelivered(op);
  setContext(op.envelope.message_id, { state: 'included', turn_id: 'turn_user' });
  assert.equal((await ops.onTurnSettled(DST)).outcome, 'none');
  assert.equal(state.submits.length, 0);
  assert.equal(ops.stats().deferred, 0);
  await ops.onDelivered(deliver());
  state.inbox.set(DST, []);
  assert.equal((await ops.onTurnSettled(DST)).outcome, 'none', 'a message that is gone is forgotten too');
  assert.equal(ops.stats().deferred, 0);
});

test('two deferred messages produce one wake keyed by the oldest message', async () => {
  const { ops, state, deliver } = harness();
  state.activeTurn.set(DST, { turn_id: 'turn_user' });
  const first = deliver();
  const second = deliver();
  await ops.onDelivered(first);
  await ops.onDelivered(second);
  assert.equal(ops.stats().deferred, 2);
  await ops.onTurnSettled(DST);
  assert.equal(state.submits.length, 1);
  assert.equal(state.submits[0].options.idempotencyKey, wakeIdempotencyKey(first.envelope.message_id));
  assert.equal(ops.stats().deferred, 0);
});

test('a deferred wake from a source past the depth cap is dropped at settle', async () => {
  const { ops, state, deliver } = harness();
  ops.noteWakeTurn('turn_deep', 3);
  state.activeTurn.set(DST, { turn_id: 'turn_user' });
  const result = await ops.onDelivered(deliver({ kind: 'agent_message', source_turn_id: 'turn_deep' }));
  assert.equal(result.outcome, 'depth_exceeded', 'depth is checked before the idle test');
  assert.equal(ops.stats().deferred, 0);
});

test('a session_busy refusal defers and the next settle wakes; any other refusal gives up', async () => {
  const { ops, state, deliver } = harness({ results: [{ ok: false, reason: 'session_busy', acceptance: 'rejected' }] });
  assert.equal((await ops.onDelivered(deliver())).outcome, 'deferred');
  assert.equal(ops.stats().deferred, 1);
  assert.ok(state.logs.some(([, event, details]) => event === 'chat_messaging.wake_refused' && details.reason === 'session_busy'));
  assert.equal((await ops.onTurnSettled(DST)).outcome, 'submitted');
  assert.equal(state.submits.length, 2);

  const other = harness({ results: [{ ok: false, reason: 'runtime_disabled', acceptance: 'rejected' }] });
  assert.equal((await other.ops.onDelivered(other.deliver())).outcome, 'refused');
  assert.equal(other.ops.stats().deferred, 0);
  await other.ops.onTurnSettled(DST);
  assert.equal(other.state.submits.length, 1, 'given up: the mail waits for the person');
});

test('a submitTurn that throws is a refusal, never an exception', async () => {
  const { ops, state, deliver } = harness();
  const throwing = createWakeOps({
    enabled: () => true, getSessionSummary: (id) => state.summaries[id] || null, getActiveTurn: () => null,
    hasSessionWork: () => false, readInbox: () => [], submitTurn: async () => { throw new Error('boom secret'); },
    now: () => new Date(START_MS), log: (...entry) => state.logs.push(entry),
  });
  const result = await throwing.onDelivered(deliver());
  assert.equal(result.outcome, 'refused');
  assert.equal(ops.stats().deferred, 0);
  assert.ok(state.logs.every((entry) => !JSON.stringify(entry).includes('boom')));
});

// ---------- bounds and hygiene ----------

test('the depth, deferred and rate maps are bounded and evict the oldest entry', async () => {
  const { ops, state, deliver } = harness({ maxTracked: 2 });
  ops.noteWakeTurn('turn_a', 1);
  ops.noteWakeTurn('turn_b', 2);
  ops.noteWakeTurn('turn_c', 3);
  assert.equal(ops.depthForTurn('turn_a'), 0, 'evicted');
  assert.equal(ops.depthForTurn('turn_c'), 3);
  state.activeTurn.set(DST, { turn_id: 'turn_user' });
  const first = deliver();
  await ops.onDelivered(first);
  await ops.onDelivered(deliver());
  await ops.onDelivered(deliver());
  assert.equal(ops.stats().deferred, 2);
  await ops.onTurnSettled(DST);
  assert.notEqual(state.submits[0].options.idempotencyKey, wakeIdempotencyKey(first.envelope.message_id), 'the oldest entry was evicted');
  assert.ok(ops.stats().tracked_turns <= 2);
});

test('logs carry ids, kinds, reasons and depth only: no body and no title', async () => {
  const { ops, state, deliver } = harness({ summaries: { [SRC]: chat('Private title') } });
  await ops.onDelivered(deliver());
  state.activeTurn.set(DST, { turn_id: 'turn_user' });
  await ops.onDelivered(deliver());
  await ops.onTurnSettled(DST);
  assert.ok(state.logs.length >= 3);
  for (const entry of state.logs) {
    const text = JSON.stringify(entry);
    assert.ok(!text.includes('secret body') && !text.includes('Private title'), text);
  }
});

test('isTurnSettledEvent accepts the chat-stream terminal types only', () => {
  for (const type of ['complete', 'error', 'question_batch', 'plan_proposal']) {
    assert.equal(isTurnSettledEvent({ type, sessionId: DST }), true, type);
  }
  for (const type of ['delta', 'tool_call', 'status', undefined]) assert.equal(isTurnSettledEvent({ type, sessionId: DST }), false);
  assert.equal(isTurnSettledEvent({ type: 'error', error_code: 'session_busy' }), false, 'a refused start settles nothing');
  assert.equal(isTurnSettledEvent(null), false);
});

test('a working destination with the mid-turn channel gets the mail pushed into its turn; the settle wakes only for unconsumed mail', async () => {
  const h = harness({ midTurn: () => ({ ok: true, reason: null, snapshot_id: 'snap_1', message_ids: ['msg_0001'] }) });
  h.state.activeTurn.set(DST, { turn_id: 'turn_live' });
  const op = h.deliver();
  assert.deepEqual(await h.ops.onDelivered(op), { outcome: 'delivered_mid_turn' });
  assert.deepEqual(h.state.pushes, [{ id: DST, messageIds: ['msg_0001'] }]);
  assert.equal(h.state.submits.length, 0, 'no wake turn while the mail rides the live turn');
  assert.ok(h.state.logs.some(([, event]) => event === 'chat_messaging.wake_mid_turn_delivered'));
  // The turn consumed it (W2a marks it included at the settle): nothing to wake for.
  h.setContext('msg_0001', { state: 'included', turn_id: 'turn_live' });
  h.state.activeTurn.delete(DST);
  assert.deepEqual(await h.ops.onTurnSettled(DST), { outcome: 'none' });
  assert.equal(h.state.submits.length, 0);
  // A second message the turn never consumed returns to queued at the settle, and that settle wakes.
  h.state.activeTurn.set(DST, { turn_id: 'turn_live_2' });
  const second = h.deliver();
  assert.deepEqual(await h.ops.onDelivered(second), { outcome: 'delivered_mid_turn' });
  h.state.activeTurn.delete(DST);
  const settled = await h.ops.onTurnSettled(DST);
  assert.equal(settled.outcome, 'submitted');
  assert.equal(h.state.submits.length, 1);
  assert.equal(h.state.submits[0].request.sessionId, DST);
});

test('a working destination whose mid-turn push is refused (or has no channel) defers as before', async () => {
  const refused = harness({ midTurn: () => ({ ok: false, reason: 'no_active_managed_turn' }) });
  refused.state.work.add(DST);
  assert.deepEqual(await refused.ops.onDelivered(refused.deliver()), { outcome: 'deferred' });
  assert.equal(refused.state.pushes.length, 1);
  assert.equal(refused.state.submits.length, 0);
  refused.state.work.delete(DST);
  assert.equal((await refused.ops.onTurnSettled(DST)).outcome, 'submitted');

  const none = harness();
  none.state.work.add(DST);
  assert.deepEqual(await none.ops.onDelivered(none.deliver()), { outcome: 'deferred' });
  assert.equal(none.state.submits.length, 0);
});

test('a Stop, Deny, crash-recovery or unconfirmed terminal is not a settle: deferred mail waits for the next real one', async () => {
  for (const event of [
    { type: 'error', terminal_status: 'cancelled' }, { type: 'error', terminal_status: 'denied' },
    { type: 'error', status: 'cancelled' }, { type: 'error', category: 'process_exit' },
    { type: 'error', category: 'interrupted' }, { type: 'error', terminal_status: 'unknown' },
    { type: 'error', error_code: 'session_busy' },
  ]) assert.equal(isTurnSettledEvent(event), false, JSON.stringify(event));
  for (const event of [{ type: 'complete' }, { type: 'error', message: 'boom' }, { type: 'error', terminal_status: 'failed' },
    { type: 'question_batch' }, { type: 'plan_proposal' }]) assert.equal(isTurnSettledEvent(event), true, JSON.stringify(event));
});

test('a settle keeps entries whose mail is still reserved for the live turn, and a rate-limited settle keeps them all', async () => {
  const h = harness();
  h.state.work.add(DST);
  const op = h.deliver();
  assert.deepEqual(await h.ops.onDelivered(op), { outcome: 'deferred' });
  // An early terminal-typed event while the mid-turn push still holds the record reserved: nothing is forgotten.
  h.setContext(op.envelope.message_id, { state: 'reserved', turn_id: 'turn_live', snapshot_id: 'snap' });
  assert.deepEqual(await h.ops.onTurnSettled(DST), { outcome: 'none' });
  assert.equal(h.ops.stats().deferred, 1);
  // The real settle releases it to queued: one wake.
  h.setContext(op.envelope.message_id, { state: 'queued' });
  h.state.work.delete(DST);
  assert.equal((await h.ops.onTurnSettled(DST)).outcome, 'submitted');
  assert.equal(h.ops.stats().deferred, 0);

  const limited = harness();
  limited.state.activeTurn.set(DST, { turn_id: 'turn_user' });
  assert.deepEqual(await limited.ops.onDelivered(limited.deliver()), { outcome: 'deferred' });
  limited.state.activeTurn.clear();
  for (let n = 0; n < 6; n += 1) assert.equal((await limited.ops.onDelivered(limited.deliver())).outcome, 'submitted');
  assert.deepEqual(await limited.ops.onTurnSettled(DST), { outcome: 'rate_limited' });
  assert.equal(limited.ops.stats().deferred, 1, 'the entry survives the rate window');
  limited.state.clock += 10 * 60 * 1000 + 1;
  assert.equal((await limited.ops.onTurnSettled(DST)).outcome, 'submitted');
});

test('a message landing while the runtime still lists the settling work is re-checked and woken without another settle', async () => {
  const h = harness();
  h.state.work.add(DST); // terminal already emitted, work not yet released: no active turn, work present
  const op = h.deliver();
  assert.deepEqual(await h.ops.onDelivered(op), { outcome: 'deferred' });
  assert.equal(h.state.rechecks.length, 1, 'one bounded re-check scheduled');
  h.state.rechecks.shift()(); // still settling: another re-check
  assert.equal(h.state.submits.length, 0);
  assert.equal(h.state.rechecks.length, 1);
  h.state.work.delete(DST);
  h.state.rechecks.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.submits.length, 1, 'woken once the work is released');
  assert.equal(h.state.rechecks.length, 0, 'the watch ends');
  // A destination with an active turn is never watched: its settle event drains the entry.
  const live = harness();
  live.state.activeTurn.set(DST, { turn_id: 'turn_1' });
  assert.deepEqual(await live.ops.onDelivered(live.deliver()), { outcome: 'deferred' });
  assert.equal(live.state.rechecks.length, 0);
});

test('a mid-turn push carries the chain depth onto the live turn, and the anchor title drops format and separator characters', async () => {
  const h = harness({ midTurn: () => ({ ok: true }) });
  h.state.activeTurn.set(DST, { turn_id: 'turn_user' });
  const op = h.deliver({ source_turn_id: 'turn_src' });
  h.ops.noteWakeTurn('turn_src', 2);
  assert.deepEqual(await h.ops.onDelivered(op), { outcome: 'delivered_mid_turn' });
  assert.equal(h.ops.depthForTurn('turn_user'), 3, 'a reply from the live turn continues at the cap');
  assert.equal(wakeTitle('Bu\u202Eilder\u200B\u2028 notes\u0007'), 'Builder notes');
});

test('a newer-schema (read-only) store wakes nothing', async () => {
  const h = harness();
  const ops = createWakeOps({
    getSessionSummary: (id) => h.state.summaries[id] || null, readInbox: () => [],
    submitTurn: async () => { throw new Error('must not submit'); }, storeReadOnly: () => true,
    log: (level, event, details) => h.state.logs.push([level, event, details]),
  });
  assert.deepEqual(await ops.onDelivered(h.deliver()), { outcome: 'ineligible' });
});

// ---------- sender first ----------

test("a message from the sender's live turn wakes only after that turn settles, oldest first", async () => {
  const DST2 = 'sess_dest_two';
  const { ops, state, deliver } = harness({ summaries: { [DST2]: chat('Tester', { id: DST2 }) } });
  state.activeTurn.set(SRC, { turn_id: 'turn_primary' });
  const first = await ops.onDelivered(deliver({ kind: 'agent_message', source_turn_id: 'turn_primary' }));
  const second = await ops.onDelivered(deliver({ kind: 'agent_message', source_turn_id: 'turn_primary', destination_session_id: DST2 }));
  assert.equal(first.outcome, 'held_for_sender');
  assert.equal(second.outcome, 'held_for_sender');
  assert.equal(state.submits.length, 0, 'nothing queues for the model while the sender is still replying');
  assert.equal(ops.stats().held, 2);
  assert.equal((await ops.onDelivered({ state: 'delivered', envelope: state.inbox.get(DST)[0].envelope })).outcome, 'duplicate');
  const held = state.logs.filter(([, event]) => event === 'chat_messaging.wake_held_for_sender');
  assert.equal(held.length, 2);
  assert.ok(!JSON.stringify(held).includes('secret body text'));

  state.activeTurn.delete(SRC);
  await ops.onTurnSettled(SRC);
  assert.deepEqual(state.submits.map(({ request }) => request.sessionId), [DST, DST2]);
  assert.equal(ops.stats().held, 0);
  await ops.onTurnSettled(SRC);
  assert.equal(state.submits.length, 2, 'a second settle wakes nothing more');
});

test('a sender stopped without a settle releases its held wake once it has no active turn', async () => {
  const { ops, state, deliver } = harness();
  state.activeTurn.set(SRC, { turn_id: 'turn_primary' });
  await ops.onDelivered(deliver({ kind: 'agent_message', source_turn_id: 'turn_primary' }));
  assert.equal(state.rechecks.length, 1);
  state.rechecks.shift()();
  assert.equal(state.submits.length, 0, 'still replying: the re-check waits again');
  assert.equal(state.rechecks.length, 1);
  state.activeTurn.delete(SRC);
  state.rechecks.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.submits.length, 1);
  assert.equal(state.submits[0].request.sessionId, DST);
});

test('sender first never holds a dialog message, a busy destination push, or a message to the sender itself', async () => {
  const { ops, state, deliver } = harness({ midTurn: () => ({ ok: true }) });
  state.activeTurn.set(SRC, { turn_id: 'turn_primary' });
  assert.equal((await ops.onDelivered(deliver())).outcome, 'submitted', 'a person-sent message has no sender turn');
  state.activeTurn.set(DST, { turn_id: 'turn_worker' });
  const pushed = await ops.onDelivered(deliver({ kind: 'agent_message', source_turn_id: 'turn_primary' }));
  assert.equal(pushed.outcome, 'delivered_mid_turn', 'a working destination still sees the mail inside its turn at once');
  const self = await ops.onDelivered(deliver({ kind: 'agent_message', source_turn_id: 'turn_primary', destination_session_id: SRC }));
  assert.notEqual(self.outcome, 'held_for_sender');
  assert.equal(ops.stats().held, 0);
});

// ---------- report back to the starter ----------

const FROM_TURN = { kind: 'agent_message', source_turn_id: 'turn_primary', source_session_incarnation: 'inc_src' };
const logged = (state, event) => state.logs.filter(([, name]) => name === event).map(([, , details]) => details);

test("a wake from a chat's own turn reserves a report-back for the returned turn id and uses the agent prompt", async () => {
  const { ops, state, deliver } = harness({ reserve: () => ({ ok: true }) });
  const op = deliver(FROM_TURN);
  assert.equal((await ops.onDelivered(op)).outcome, 'submitted');
  assert.deepEqual(state.reserves, [{
    sessionId: DST, turnId: 'turn_wake_1', parentSessionId: SRC, parentIncarnation: 'inc_src', messageId: op.envelope.message_id,
  }]);
  assert.equal(state.submits[0].request.prompt, AGENT_MESSAGE_WAKE_PROMPT);
  const shared = MESSAGE_WAKE_PROMPT.slice(0, MESSAGE_WAKE_PROMPT.indexOf(' If it asked'));
  assert.ok(AGENT_MESSAGE_WAKE_PROMPT.startsWith(shared), 'only the last sentence differs');
  assert.match(AGENT_MESSAGE_WAKE_PROMPT, /your final reply is sent back to that chat automatically as a report, so do not message that chat back.$/);
  assert.deepEqual(logged(state, 'chat_messaging.report_back_reserved'),
    [{ destination_session_id: DST, message_id: op.envelope.message_id, turn_id: 'turn_wake_1' }]);
  assert.ok(!JSON.stringify(state.logs).includes('secret body text'));
});

test('dialog messages, report wakes and self-addressed mail reserve nothing and keep the dialog prompts', async () => {
  const { ops, state, deliver } = harness({ reserve: () => ({ ok: true }) });
  await ops.onDelivered(deliver());
  await ops.onDelivered(deliver({ kind: 'terminal_report', source_turn_id: 'turn_child', source_session_incarnation: 'inc_src' }));
  await ops.onDelivered(deliver({ ...FROM_TURN, destination_session_id: SRC }));
  assert.deepEqual(state.submits.map(({ request }) => request.prompt), [MESSAGE_WAKE_PROMPT, REPORT_WAKE_PROMPT, MESSAGE_WAKE_PROMPT]);
  assert.deepEqual(state.reserves, []);
});

test('a failing, refusing or absent reserve port never changes the wake outcome, and a refused submit reserves nothing', async () => {
  const thrown = harness({ reserve: () => { throw new Error('boom'); } });
  assert.equal((await thrown.ops.onDelivered(thrown.deliver(FROM_TURN))).outcome, 'submitted');
  assert.deepEqual(logged(thrown.state, 'chat_messaging.report_back_skipped').map((d) => d.reason), ['exception']);
  const refused = harness({ reserve: () => ({ ok: false, reason: 'report_backpressure' }) });
  assert.equal((await refused.ops.onDelivered(refused.deliver(FROM_TURN))).outcome, 'submitted');
  assert.deepEqual(logged(refused.state, 'chat_messaging.report_back_skipped').map((d) => d.reason), ['report_backpressure']);
  const absent = harness();
  assert.equal((await absent.ops.onDelivered(absent.deliver(FROM_TURN))).outcome, 'submitted');
  const noTurn = harness({ reserve: () => ({ ok: true }), results: [{ ok: true }] });
  assert.equal((await noTurn.ops.onDelivered(noTurn.deliver(FROM_TURN))).outcome, 'submitted');
  assert.deepEqual(noTurn.state.reserves, [], 'no turn id, nothing to key the reservation by');
  const failed = harness({ reserve: () => ({ ok: true }), results: [{ ok: false, reason: 'runtime_unavailable' }] });
  assert.equal((await failed.ops.onDelivered(failed.deliver(FROM_TURN))).outcome, 'refused');
  assert.deepEqual(failed.state.reserves, []);
  const noIncarnation = harness({ reserve: () => ({ ok: true }) });
  await noIncarnation.ops.onDelivered(noIncarnation.deliver({ kind: 'agent_message', source_turn_id: 'turn_primary' }));
  assert.deepEqual(noIncarnation.state.reserves, [], 'a sender with no incarnation cannot be named as a report parent');
});

test('a held or deferred wake reserves when it finally submits, and the report from a cap-depth wake wakes nobody', async () => {
  const { ops, state, deliver } = harness({ reserve: () => ({ ok: true }) });
  state.activeTurn.set(SRC, { turn_id: 'turn_primary' });
  await ops.onDelivered(deliver(FROM_TURN));
  assert.deepEqual(state.reserves, [], 'still held for the sender');
  state.activeTurn.delete(SRC);
  await ops.onTurnSettled(SRC);
  assert.deepEqual(state.reserves.map((request) => request.turnId), ['turn_wake_1']);
  const cap = harness({ reserve: () => ({ ok: true }) });
  cap.ops.noteWakeTurn('turn_mid', 2);
  assert.equal((await cap.ops.onDelivered(cap.deliver({ ...FROM_TURN, source_turn_id: 'turn_mid' }))).outcome, 'submitted');
  const report = cap.deliver({
    kind: 'terminal_report', source_session_id: DST, destination_session_id: SRC, source_turn_id: 'turn_wake_1',
    source_session_incarnation: 'inc_dst',
  });
  assert.deepEqual(await cap.ops.onDelivered(report), { outcome: 'depth_exceeded' });
  assert.equal(cap.state.submits.length, 1, 'the depth cap stops the chain at the report');
});

test('a held wake whose mail the destination admitted meanwhile is forgotten at the release', async () => {
  const { ops, state, deliver, setContext } = harness();
  state.activeTurn.set(SRC, { turn_id: 'turn_primary' });
  const op = deliver({ kind: 'agent_message', source_turn_id: 'turn_primary' });
  assert.equal((await ops.onDelivered(op)).outcome, 'held_for_sender');
  setContext(op.envelope.message_id, { state: 'included' }); // the person's own turn in that chat took it
  state.activeTurn.delete(SRC);
  await ops.onTurnSettled(SRC);
  assert.equal(state.submits.length, 0);
  assert.equal(ops.stats().held, 0);
});

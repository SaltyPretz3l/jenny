'use strict';

// Row 85 S3: the scheduled-check port (services/primary-scheduled-check.js). Gates (flag, Jenny chat,
// catch-up bound, Pause, eligibility, busy, rate caps), the submit request (approval mode always
// `prompt`, the scheduled_check application turn, a per-occurrence sched_ key, a wake-turn note), the
// busy deferral and its retry, and the backend wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createScheduledCheckOps,
  scheduledCheckIdempotencyKey,
  scheduledCheckPrompt,
  wirePrimaryScheduledChecks,
} = require('../services/primary-scheduled-check');

const JENNY = 'sess_jenny';
const NOW = new Date(2026, 10, 2, 8, 0).getTime();

function summary(extra = {}) {
  return {
    id: JENNY, title: 'Jenny', session_type: 'chat', archived_at: null, lockdown: false,
    preferred_model: 'qwen-local', reasoning_effort: 'high', plan_mode: false, run_mode: 'auto', ...extra,
  };
}

function check(extra = {}) {
  return {
    id: 'check-1', label: 'Overnight', prompt: 'Tell me what finished overnight', scheduleType: 'daily_at',
    dailyAt: '08:00', weekdays: [], intervalMinutes: 0, onceAt: '', enabled: true, action: 'jenny_turn', ...extra,
  };
}

function harness({ enabled = true, paused = false, busy = false, summaryExtra = {}, submitResult = null, rate } = {}) {
  const state = { now: NOW, paused, busy, enabled };
  const submits = [];
  const records = [];
  const wakeNotes = [];
  const logs = [];
  const rechecks = [];
  const ops = createScheduledCheckOps({
    enabled: () => state.enabled,
    primarySessionId: () => JENNY,
    paused: (sessionId) => sessionId === JENNY && state.paused,
    getSessionSummary: (sessionId) => (sessionId === JENNY ? summary(summaryExtra) : null),
    getActiveTurn: () => (state.busy ? { turn_id: 'live' } : null),
    submitTurn: async (request, options) => {
      submits.push({ request, options });
      return submitResult ? submitResult(submits.length) : { ok: true, created: true, turn_id: `turn_${submits.length}` };
    },
    noteWakeTurn: (turnId, depth) => wakeNotes.push({ turnId, depth }),
    record: (kind, reminder, reason) => records.push({ kind, id: reminder.id, reason }),
    scheduleRecheck: (fn, ms) => rechecks.push({ fn, ms }),
    now: () => state.now,
    log: (level, event, details) => logs.push({ level, event, details }),
    ...(rate ? { rate } : {}),
  });
  return { ops, state, submits, records, wakeNotes, logs, rechecks };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('an idle Jenny chat gets one durable turn that always asks before tools', async () => {
  const h = harness();
  assert.deepEqual(h.ops.onDue(check(), NOW, { nowMs: NOW + 1000 }), { handled: true });
  await flush();
  assert.equal(h.submits.length, 1);
  const { request, options } = h.submits[0];
  assert.equal(request.sessionId, JENNY);
  assert.equal(request.approvalMode, 'prompt', 'the chat runs in Auto, but a fired check still asks');
  assert.equal(request.applicationTurn, 'scheduled_check');
  assert.equal(request.visiblePrompt, 'Scheduled check: Overnight');
  assert.equal(request.preferredModel, 'qwen-local');
  assert.equal(request.reasoningEffort, 'high');
  assert.equal(request.planMode, false);
  assert.match(request.prompt, /"""\nTell me what finished overnight\n"""/);
  assert.equal(options.idempotencyKey, scheduledCheckIdempotencyKey('check-1', NOW));
  assert.match(options.idempotencyKey, /^sched_[0-9a-f]{32}$/);
  assert.deepEqual(h.wakeNotes, [{ turnId: 'turn_1', depth: 1 }]);
  assert.deepEqual(h.records, []);
  assert.ok(!JSON.stringify(h.logs).includes('finished overnight'), 'diagnostics never carry the instruction');
});

test('the idempotency key is stable per occurrence and differs across occurrences', () => {
  assert.equal(scheduledCheckIdempotencyKey('a', NOW), scheduledCheckIdempotencyKey('a', NOW));
  assert.notEqual(scheduledCheckIdempotencyKey('a', NOW), scheduledCheckIdempotencyKey('a', NOW + 86400000));
  assert.notEqual(scheduledCheckIdempotencyKey('a', NOW), scheduledCheckIdempotencyKey('b', NOW));
});

test('the flag off or no Jenny chat hands the occurrence back to the toast', () => {
  const off = harness({ enabled: false });
  assert.deepEqual(off.ops.onDue(check(), NOW, { nowMs: NOW }), { handled: false });
  const none = createScheduledCheckOps({ primarySessionId: () => null });
  assert.deepEqual(none.onDue(check(), NOW, { nowMs: NOW }), { handled: false });
  assert.deepEqual(none.onDue(null, NOW), { handled: false });
});

test('a check later than its catch-up bound is logged missed and never submitted', async () => {
  const h = harness();
  const once = check({ id: 'once', scheduleType: 'once_at', onceAt: '2026-11-01T07:00' });
  assert.deepEqual(h.ops.onDue(once, NOW - 25 * 3600000, { nowMs: NOW }), { handled: true });
  assert.deepEqual(h.ops.onDue(check(), NOW - 7 * 3600000, { nowMs: NOW }), { handled: true });
  // Within the bound: a 5-hour-late daily check still runs once.
  h.ops.onDue(check({ id: 'recent' }), NOW - 5 * 3600000, { nowMs: NOW });
  await flush();
  assert.deepEqual(h.records, [
    { kind: 'schedule_missed', id: 'once', reason: 'late' },
    { kind: 'schedule_missed', id: 'check-1', reason: 'late' },
  ]);
  assert.equal(h.submits.length, 1);
});

test('Pause skips a recurring occurrence and holds a one-off for Resume', async () => {
  const h = harness({ paused: true });
  h.ops.onDue(check(), NOW, { nowMs: NOW });
  await flush();
  assert.deepEqual(h.records, [{ kind: 'schedule_skipped', id: 'check-1', reason: 'paused' }]);
  assert.equal(h.submits.length, 0);
  assert.equal(h.ops.holds(check({ scheduleType: 'once_at' })), true);
  assert.equal(h.ops.holds(check()), false, 'recurring checks reach the port and are skipped there');
  h.state.paused = false;
  assert.equal(h.ops.holds(check({ scheduleType: 'once_at' })), false);
  h.state.enabled = false;
  h.state.paused = true;
  assert.equal(h.ops.holds(check({ scheduleType: 'once_at' })), false, 'flag off: the toast fallback is never held');
});

test('a repeated skip writes Activity once until the check runs again', async () => {
  const h = harness({ paused: true });
  for (let day = 0; day < 3; day += 1) {
    h.ops.onDue(check(), NOW + day * 86400000, { nowMs: NOW + day * 86400000 });
    await flush();
  }
  assert.deepEqual(h.records, [{ kind: 'schedule_skipped', id: 'check-1', reason: 'paused' }]);
  assert.equal(h.logs.filter((entry) => entry.details.repeat === true).length, 2, 'repeats are still logged');
  h.state.paused = false;
  h.state.now = NOW + 3 * 86400000;
  h.ops.onDue(check(), h.state.now, { nowMs: h.state.now });
  await flush();
  assert.equal(h.submits.length, 1);
  h.state.paused = true;
  h.ops.onDue(check(), h.state.now + 86400000, { nowMs: h.state.now + 86400000 });
  await flush();
  assert.equal(h.records.length, 2, 'a skip after a run is written again');
});

test('an archived or locked-down Jenny chat skips the occurrence as ineligible', async () => {
  for (const summaryExtra of [{ archived_at: '2026-11-01T00:00:00.000Z' }, { lockdown: true }]) {
    const h = harness({ summaryExtra });
    h.ops.onDue(check(), NOW, { nowMs: NOW });
    await flush();
    assert.deepEqual(h.records, [{ kind: 'schedule_skipped', id: 'check-1', reason: 'ineligible' }]);
    assert.equal(h.submits.length, 0);
  }
});

test('a busy Jenny chat defers to its settled turn, and a 2-minute recheck backs it up', async () => {
  const h = harness({ busy: true });
  h.ops.onDue(check(), NOW, { nowMs: NOW });
  await flush();
  assert.equal(h.submits.length, 0);
  assert.equal(h.ops.stats().deferred, 1);
  assert.equal(h.rechecks.length, 1);
  assert.equal(h.rechecks[0].ms, 120000);

  assert.deepEqual(await h.ops.onTurnSettled('sess_other'), { outcome: 'none' });
  h.state.busy = false;
  assert.deepEqual(await h.ops.onTurnSettled(JENNY), { outcome: 'retried' });
  assert.equal(h.submits.length, 1);
  assert.equal(h.ops.stats().deferred, 0);
});

test('a deferred check that outlives its bound is logged missed on retry', async () => {
  const h = harness({ busy: true });
  h.ops.onDue(check(), NOW, { nowMs: NOW });
  await flush();
  h.state.now = NOW + 7 * 3600000;
  h.state.busy = false;
  h.rechecks[0].fn();
  await flush();
  assert.equal(h.submits.length, 0);
  assert.deepEqual(h.records, [{ kind: 'schedule_missed', id: 'check-1', reason: 'late' }]);
});

test('a session_busy refusal defers; another refusal is logged with its reason token', async () => {
  const busy = harness({ submitResult: () => ({ ok: false, reason: 'session_busy' }) });
  busy.ops.onDue(check(), NOW, { nowMs: NOW });
  await flush();
  assert.equal(busy.ops.stats().deferred, 1);
  assert.deepEqual(busy.records, []);

  const refused = harness({ submitResult: () => ({ ok: false, reason: 'runtime_disabled' }) });
  refused.ops.onDue(check(), NOW, { nowMs: NOW });
  await flush();
  assert.deepEqual(refused.records, [{ kind: 'schedule_skipped', id: 'check-1', reason: 'runtime_disabled' }]);
  assert.equal(refused.ops.stats().fires_last_day, 0, 'a refused submit does not spend the rate budget');
});

test('fires are capped per hour and per day across all checks', async () => {
  const h = harness({ rate: { hour: 2, day: 3 } });
  for (let index = 0; index < 3; index += 1) {
    h.ops.onDue(check({ id: `c${index}` }), h.state.now, { nowMs: h.state.now });
    await flush();
  }
  assert.equal(h.submits.length, 2);
  assert.deepEqual(h.records, [{ kind: 'schedule_skipped', id: 'c2', reason: 'rate_limited' }]);
  h.state.now += 3600001;
  h.ops.onDue(check({ id: 'c3' }), h.state.now, { nowMs: h.state.now });
  await flush();
  h.ops.onDue(check({ id: 'c4' }), h.state.now, { nowMs: h.state.now });
  await flush();
  assert.equal(h.submits.length, 3);
  assert.deepEqual(h.records.at(-1), { kind: 'schedule_skipped', id: 'c4', reason: 'rate_limited' });
});

test('the prompt quotes the instruction and names the cadence kind and local due time', () => {
  const prompt = scheduledCheckPrompt(check({ scheduleType: 'once_at' }), NOW);
  assert.match(prompt, /one-off, due 2026-11-02 08:00 local time/);
  assert.match(prompt, /Title: Overnight/);
  assert.match(prompt, /Every tool still asks the user first/);
});

test('wirePrimaryScheduledChecks reads the backend lazily and retries on a settled Jenny turn', async () => {
  const backend = new EventEmitter();
  let active = { turn_id: 'live' };
  const submits = [];
  const notes = [];
  const recorded = [];
  backend.featureFlags = { primary_chat: true, primary_scheduled_checks: true };
  backend.primaryChatControls = {
    primarySessionId: () => JENNY,
    isPaused: () => false,
    recordScheduleEvent: (entry) => { recorded.push(entry); return true; },
  };
  backend.sessionStore = { getSessionSummary: () => summary(), peekActiveTurn: () => active };
  backend.sessionRuntime = {
    hasSessionWork: () => false,
    submitApplicationTurn: async (request, options) => { submits.push({ request, options }); return { ok: true, turn_id: 'turn_w' }; },
  };
  backend.chatMessages = { noteWakeTurn: (turnId, depth) => notes.push({ turnId, depth }) };
  const ops = wirePrimaryScheduledChecks(backend);
  assert.equal(backend.primaryScheduledChecks, ops);
  assert.deepEqual(ops.onDue(check(), Date.now(), {}), { handled: true });
  await flush();
  assert.equal(submits.length, 0);
  active = null;
  backend.emit('chat-stream', { type: 'complete', sessionId: JENNY });
  await flush();
  assert.equal(submits.length, 1);
  assert.deepEqual(notes, [{ turnId: 'turn_w', depth: 1 }]);

  backend.featureFlags.primary_scheduled_checks = false;
  assert.deepEqual(ops.onDue(check(), Date.now(), {}), { handled: false });
  backend.featureFlags.primary_scheduled_checks = true;
  backend.primaryChatControls.isPaused = () => true;
  ops.onDue(check(), Date.now(), {});
  await flush();
  assert.deepEqual(recorded, [{ kind: 'schedule_skipped', reminder_id: 'check-1', label: 'Overnight', reason: 'paused' }]);
});

test('a deferred check runs what is stored now: nothing once deleted or off, else its current instruction', async () => {
  const stored = new Map([['check-1', check()]]);
  const submits = [];
  let busy = true;
  const ops = createScheduledCheckOps({
    enabled: () => true, primarySessionId: () => JENNY, paused: () => false,
    getSessionSummary: () => summary(), getActiveTurn: () => (busy ? { turn_id: 'live' } : null),
    submitTurn: async (request) => { submits.push(request); return { ok: true, turn_id: 't' }; },
    getReminder: (id) => stored.get(id) || null, scheduleRecheck: () => {}, now: () => NOW,
  });
  ops.onDue(check(), NOW);
  await flush();
  stored.set('check-1', check({ enabled: false }));
  busy = false;
  await ops.onTurnSettled(JENNY);
  assert.equal(submits.length, 0, 'turned off while deferred');
  busy = true;
  stored.set('check-1', check());
  ops.onDue(check(), NOW);
  await flush();
  stored.delete('check-1');
  busy = false;
  await ops.onTurnSettled(JENNY);
  assert.equal(submits.length, 0, 'deleted while deferred');
  busy = true;
  stored.set('check-1', check());
  ops.onDue(check(), NOW);
  await flush();
  stored.set('check-1', check({ prompt: 'Summarize only the failures' }));
  busy = false;
  await ops.onTurnSettled(JENNY);
  assert.equal(submits.length, 1);
  assert.match(submits[0].prompt, /Summarize only the failures/);
});

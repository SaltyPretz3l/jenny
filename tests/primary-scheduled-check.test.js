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

function harness({ enabled = true, paused = false, busy = false, summaryExtra = {}, submitResult = null, rate, gate, floor = true } = {}) {
  const state = { now: NOW, paused, busy, enabled, floor, gate };
  const gateCalls = [];
  const notices = [];
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
    ...(gate ? {
      checkModel: async (sum, options) => { gateCalls.push(options); return state.gate(sum, options); },
      floorEnabled: () => state.floor,
      notify: (notice) => notices.push(notice),
    } : {}),
  });
  return { ops, state, submits, records, wakeNotes, logs, rechecks, gateCalls, notices };
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
  backend.getBackendStatus = () => ({ phase: 'ready' });
  backend.listModels = async () => ({ available: true, data: [{ id: 'qwen-local', parameterSize: '27.8B' }] });
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

// Row 144: the model gate (plan SCHEDULED_CHECK_MODEL_FLOOR_2026-11-13.md section 3.1).
const fit = (model) => () => ({ status: 'fit', model });
const small = (model) => () => ({ status: 'too_small', model, params_b: 2 });

test('a check whose model is too small is held: Activity, one notice, nothing submitted', async () => {
  const h = harness({ gate: small('lfm3-omni-2b') });
  h.ops.onDue(check(), NOW);
  await flush();
  assert.equal(h.submits.length, 0);
  assert.deepEqual(h.records, [{ kind: 'schedule_held', id: 'check-1', reason: 'model_too_small' }]);
  assert.deepEqual(h.notices, [{ type: 'held', reminder_id: 'check-1', label: 'Overnight', reason: 'model_too_small', model: 'lfm3-omni-2b' }]);
  assert.deepEqual(h.ops.listHeld(), [{ reminder_id: 'check-1', label: 'Overnight', reason: 'model_too_small', model: 'lfm3-omni-2b' }]);
  // A retry that is still too small logs nothing new and sends no second notice.
  await h.ops.onModelsChanged();
  assert.equal(h.records.length, 1);
  assert.equal(h.notices.length, 1);
});

test('a missing model holds the check as unavailable', async () => {
  const h = harness({ gate: () => ({ status: 'unavailable', model: 'qwen38-27b' }) });
  h.ops.onDue(check(), NOW);
  await flush();
  assert.deepEqual(h.records, [{ kind: 'schedule_held', id: 'check-1', reason: 'model_unavailable' }]);
  assert.equal(h.notices[0].reason, 'model_unavailable');
});

test('a fit model is pinned on the request, over the chat\'s own model', async () => {
  const h = harness({ gate: fit('qwen38-27b') });
  h.ops.onDue(check(), NOW);
  await flush();
  assert.equal(h.submits.length, 1);
  assert.equal(h.submits[0].request.preferredModel, 'qwen38-27b');
  assert.equal(h.submits[0].request.approvalMode, 'prompt');
  assert.deepEqual(h.gateCalls, [{ override: false }]);
  assert.deepEqual(h.notices, []);
});

test('a model list that is not ready is asked again shortly, then held after the grace period', async () => {
  const h = harness({ gate: () => ({ status: 'pending', model: '' }) });
  h.ops.onDue(check(), NOW);
  await flush();
  assert.equal(h.submits.length, 0);
  assert.deepEqual(h.records, []);
  assert.equal(h.rechecks.at(-1).ms, 15000);
  h.state.gate = fit('qwen38-27b');
  h.rechecks.at(-1).fn();
  await flush();
  assert.equal(h.submits.length, 1);

  const late = harness({ gate: () => ({ status: 'pending', model: '' }) });
  late.ops.onDue(check(), NOW);
  await flush();
  late.state.now = NOW + 2 * 60000 + 1;
  late.rechecks.at(-1).fn();
  await flush();
  // A model never confirmed is not available (no Run anyway), not too small.
  assert.deepEqual(late.records, [{ kind: 'schedule_held', id: 'check-1', reason: 'model_unavailable' }]);
});

test('a held check runs once a big enough model is set, and its notice is withdrawn', async () => {
  const h = harness({ gate: small('lfm3-omni-2b') });
  h.ops.onDue(check(), NOW);
  await flush();
  h.state.gate = fit('qwen38-27b');
  assert.deepEqual(await h.ops.onModelsChanged(), { outcome: 'retried' });
  assert.equal(h.submits.length, 1);
  assert.equal(h.submits[0].request.preferredModel, 'qwen38-27b');
  assert.deepEqual(h.notices.at(-1), { type: 'cleared', reminder_id: 'check-1' });
  assert.deepEqual(h.ops.listHeld(), []);
  assert.deepEqual(await h.ops.onModelsChanged(), { outcome: 'none' });
});

test('a held check past its catch-up bound is missed and its notice is withdrawn', async () => {
  const h = harness({ gate: small('lfm3-omni-2b') });
  h.ops.onDue(check(), NOW);
  await flush();
  h.state.now = NOW + 7 * 60 * 60000; // a daily check catches up for at most 6 h
  await h.ops.onModelsChanged();
  assert.deepEqual(h.records.at(-1), { kind: 'schedule_missed', id: 'check-1', reason: 'late' });
  assert.deepEqual(h.notices.at(-1), { type: 'cleared', reminder_id: 'check-1' });
});

test('Run anyway runs one held occurrence with the size test skipped; Skip drops one', async () => {
  const h = harness({ gate: (sum, options) => (options.override ? fit('lfm3-omni-2b')() : small('lfm3-omni-2b')()) });
  h.ops.onDue(check(), NOW);
  await flush();
  const ran = await h.ops.runHeld('check-1');
  assert.deepEqual(ran, { ok: true, turn_id: 'turn_1' });
  assert.deepEqual(h.gateCalls.at(-1), { override: true });
  assert.deepEqual(h.records.at(-1), { kind: 'schedule_run_anyway', id: 'check-1', reason: 'user' });
  assert.deepEqual(h.notices.at(-1), { type: 'cleared', reminder_id: 'check-1' });
  assert.deepEqual(await h.ops.runHeld('check-1'), { ok: false, reason: 'not_held' });

  const s = harness({ gate: small('lfm3-omni-2b') });
  s.ops.onDue(check({ id: 'check-2' }), NOW);
  await flush();
  assert.deepEqual(await s.ops.skipHeld('check-2'), { ok: true });
  assert.deepEqual(s.records.at(-1), { kind: 'schedule_skipped', id: 'check-2', reason: 'user' });
  assert.deepEqual(s.notices.at(-1), { type: 'cleared', reminder_id: 'check-2' });
  assert.equal(s.submits.length, 0);
  assert.deepEqual(await s.ops.skipHeld('check-2'), { ok: false, reason: 'not_held' });
});

test('with the floor off nothing is held: a confirmed model is pinned, otherwise today\'s routing', async () => {
  const h = harness({ floor: false, gate: () => ({ status: 'unavailable', model: 'gone' }) });
  h.ops.onDue(check(), NOW);
  await flush();
  assert.equal(h.submits.length, 1);
  assert.equal(h.submits[0].request.preferredModel, 'qwen-local'); // the chat's own model, as before row 144
  assert.deepEqual(h.gateCalls, [{ override: true }]);
  assert.deepEqual(h.notices, []);
});

test('the wiring holds a check on a small model, notifies, and retries when the backend status changes', async () => {
  const backend = new EventEmitter();
  const submits = [];
  const notices = [];
  let models = [{ id: 'qwen-local', parameterSize: '2.6B' }];
  backend.featureFlags = { primary_chat: true, primary_scheduled_checks: true };
  backend.primaryChatControls = { primarySessionId: () => JENNY, isPaused: () => false, recordScheduleEvent: () => true };
  backend.sessionStore = { getSessionSummary: () => summary(), peekActiveTurn: () => null };
  backend.sessionRuntime = {
    hasSessionWork: () => false,
    submitApplicationTurn: async (request) => { submits.push(request); return { ok: true, turn_id: 'turn_s' }; },
  };
  backend.getBackendStatus = () => ({ phase: 'ready' });
  backend.listModels = async () => ({ available: true, data: models });
  const ops = wirePrimaryScheduledChecks(backend, { notify: (notice) => notices.push(notice) });
  ops.onDue(check(), Date.now());
  await flush();
  assert.equal(submits.length, 0);
  assert.equal(notices[0].type, 'held');
  assert.equal(notices[0].reason, 'model_too_small');
  models = [{ id: 'qwen-local', parameterSize: '27.8B' }];
  backend.emit('backend-status', { phase: 'ready' });
  await flush();
  await flush();
  assert.equal(submits.length, 1);
  assert.equal(submits[0].preferredModel, 'qwen-local');
  assert.deepEqual(notices.at(-1), { type: 'cleared', reminder_id: 'check-1' });
});

test('a held check that has to wait again (Jenny busy, model list pending) stays held with its notice', async () => {
  const h = harness({ gate: small('lfm3-omni-2b') });
  h.ops.onDue(check(), NOW);
  await flush();
  assert.equal(h.ops.listHeld().length, 1);
  h.state.busy = true;
  await h.ops.onModelsChanged();
  assert.equal(h.ops.listHeld().length, 1, 'busy keeps it held');
  h.state.busy = false;
  h.state.gate = () => ({ status: 'pending', model: '' });
  await h.ops.onModelsChanged();
  assert.equal(h.ops.listHeld().length, 1, 'pending keeps it held');
  assert.equal(h.notices.filter((n) => n.type === 'cleared').length, 0);
  assert.equal(h.notices.filter((n) => n.type === 'held').length, 1);
  h.state.gate = fit('qwen38-27b');
  await h.ops.onModelsChanged();
  assert.equal(h.submits.length, 1);
  assert.deepEqual(h.notices.at(-1), { type: 'cleared', reminder_id: 'check-1' });
});

test('Run anyway while Jenny is busy keeps the override for when the chat is free', async () => {
  const h = harness({ gate: (sum, options) => (options.override ? fit('lfm3-omni-2b')() : small('lfm3-omni-2b')()) });
  h.ops.onDue(check(), NOW);
  await flush();
  h.state.busy = true;
  assert.deepEqual(await h.ops.runHeld('check-1'), { ok: false, reason: 'still_waiting' });
  assert.equal(h.ops.listHeld().length, 1);
  h.state.busy = false;
  await h.ops.onTurnSettled(JENNY);
  assert.equal(h.submits.length, 1);
  assert.deepEqual(h.gateCalls.at(-1), { override: true });
});

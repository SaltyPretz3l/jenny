'use strict';

/* A finished background job wakes its chat once (services/background-job-wake.js, owner pick 2026-11-01).
 * Pure decision logic over fakes: an injected clock, a recording submitTurn and manual re-checks. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createBackgroundJobWakeOps, jobWakeIdempotencyKey, jobWakePrompt, wireBackgroundJobWake,
} = require('../services/background-job-wake');
const { APPLICATION_TURN_WAKE } = require('../services/backend/application-turns');

const CHAT = 'sess_chat';

function summary(extra = {}) {
  return {
    id: CHAT, title: 'Tests', session_type: 'chat', archived_at: null, lockdown: false,
    preferred_model: 'qwen-local', reasoning_effort: 'high', plan_mode: false, run_mode: 'ask', ...extra,
  };
}

function job(extra = {}) {
  return {
    jobId: '3869b0f37a73', sessionId: CHAT, command: 'python -m pytest tests/sidecar -q', state: 'completed',
    exitCode: 0, endedAtMs: 1000, stopRequested: false, ...extra,
  };
}

function harness({ results = [], summaryExtra = {}, paused = false, enabled = true, deliverMidTurn } = {}) {
  const state = {
    clock: 0, activeTurn: null, work: false, submits: [], rechecks: [], logs: [], results: [...results], midTurn: [],
  };
  const ops = createBackgroundJobWakeOps({
    enabled: () => enabled,
    paused: () => paused,
    getSessionSummary: (sessionId) => (sessionId === CHAT ? summary(summaryExtra) : null),
    getActiveTurn: () => state.activeTurn,
    hasSessionWork: () => state.work,
    submitTurn: async (request, options) => {
      state.submits.push({ request, options });
      return state.results.shift() || { ok: true, turn_id: `turn_${state.submits.length}` };
    },
    ...(deliverMidTurn ? {
      deliverMidTurn: (sessionId, jobs) => {
        state.midTurn.push({ sessionId, jobs });
        return deliverMidTurn(sessionId, jobs);
      },
    } : {}),
    scheduleRecheck: (fn) => state.rechecks.push(fn),
    now: () => state.clock,
    log: (level, event, details) => state.logs.push({ level, event, details }),
  });
  return { ops, state };
}

test('an idle chat is woken once with its own authority and a prompt naming the job', async () => {
  const { ops, state } = harness();
  const outcome = await ops.onJobSettled(job());
  assert.equal(outcome.outcome, 'submitted');
  assert.equal(state.submits.length, 1);
  const { request, options } = state.submits[0];
  assert.equal(request.sessionId, CHAT);
  assert.equal(request.applicationTurn, APPLICATION_TURN_WAKE);
  assert.equal(request.approvalMode, 'prompt');
  assert.equal(request.preferredModel, 'qwen-local');
  assert.match(request.prompt, /3869b0f37a73 \(`python -m pytest tests\/sidecar -q`\): completed, exit 0/);
  assert.match(request.prompt, /check_background_job/);
  assert.equal(options.idempotencyKey, jobWakeIdempotencyKey(['3869b0f37a73']));
  assert.equal((await ops.onTurnSettled(CHAT)).outcome, 'none', 'a woken job never wakes twice');
});

test('a job whose settled result the model already read does not wake', async () => {
  const { ops, state } = harness();
  ops.noteResultRead('3869b0f37a73');
  assert.equal((await ops.onJobSettled(job())).outcome, 'not_needed');
  assert.equal(state.submits.length, 0);
});

test('a job the person stopped never wakes; it is held for the next turn', async () => {
  const { ops, state } = harness({ deliverMidTurn: () => ({ ok: false, reason: 'no_live_stream' }) });
  assert.equal((await ops.onJobSettled(job({ stopRequested: true, state: 'failed' }))).outcome, 'held');
  assert.equal(state.submits.length, 0);
  assert.equal(state.rechecks.length, 0);
  await ops.onTurnSettled(CHAT);
  assert.equal(state.submits.length, 0, 'a turn ending elsewhere still never wakes it');
  assert.equal(ops.stats().stopped, 1);
});

test('a stop is told to the model as "stopped", at the next turn start, until it is acknowledged', async () => {
  let live = false;
  const { ops, state } = harness({ deliverMidTurn: () => (live ? { ok: true } : { ok: false, reason: 'no_live_stream' }) });
  await ops.onJobSettled(job({ stopRequested: true, state: 'failed', exitCode: 1 }));
  live = true;
  assert.equal(ops.onTurnStarted(CHAT).outcome, 'delivered');
  const sent = state.midTurn.at(-1).jobs[0];
  assert.equal(sent.state, 'stopped');
  assert.equal(sent.exitCode, null);
  assert.equal(ops.stats().stopped, 1, 'unacknowledged: the next turn hears it again');
  ops.noteResultRead(sent.jobId);
  assert.equal(ops.stats().stopped, 0);
  assert.equal(ops.onTurnStarted(CHAT).outcome, 'none');
  assert.equal(state.submits.length, 0);
});

test('a stop during a live turn reaches that turn at once', async () => {
  const { ops, state } = harness({ deliverMidTurn: () => ({ ok: true }) });
  state.activeTurn = { turn_id: 'turn_live' };
  assert.equal((await ops.onJobSettled(job({ stopRequested: true }))).outcome, 'delivered');
  assert.equal(state.midTurn.length, 1);
  assert.equal(state.submits.length, 0);
});

test('a stop whose result the model already read is not told again', async () => {
  const { ops, state } = harness({ deliverMidTurn: () => ({ ok: true }) });
  ops.noteResultRead('3869b0f37a73');
  assert.equal((await ops.onJobSettled(job({ stopRequested: true }))).outcome, 'not_needed');
  assert.equal(state.midTurn.length, 0);
});

test('a job that settles mid-turn waits for the settle and is skipped if the turn read it', async () => {
  const { ops, state } = harness();
  state.activeTurn = { turn_id: 'turn_live' };
  assert.equal((await ops.onJobSettled(job())).outcome, 'deferred');
  ops.noteResultRead('3869b0f37a73'); // the live turn polled it with wait_ms
  state.activeTurn = null;
  assert.equal((await ops.onTurnSettled(CHAT)).outcome, 'none');
  assert.equal(state.submits.length, 0);
});

test('an unread job that settled mid-turn wakes the chat when that turn ends, batched', async () => {
  const { ops, state } = harness();
  state.activeTurn = { turn_id: 'turn_live' };
  await ops.onJobSettled(job());
  await ops.onJobSettled(job({ jobId: 'aaaaaaaaaaaa', command: 'npm run lint', state: 'failed', exitCode: 1, endedAtMs: 2000 }));
  state.activeTurn = null;
  assert.equal((await ops.onTurnSettled(CHAT)).outcome, 'submitted');
  assert.equal(state.submits.length, 1);
  assert.match(state.submits[0].request.prompt, /^Background jobs you started/);
  assert.match(state.submits[0].request.prompt, /aaaaaaaaaaaa \(`npm run lint`\): failed, exit 1/);
});

test('a settled job while the chat is busy is delivered mid-turn and stays pending until read', async () => {
  const { ops, state } = harness({ deliverMidTurn: () => ({ ok: true, pushed: 1 }) });
  state.activeTurn = { turn_id: 'turn_live' };
  const first = await ops.onJobSettled(job());
  assert.equal(first.outcome, 'deferred');
  assert.equal(state.midTurn.length, 1);
  assert.equal(state.midTurn[0].sessionId, CHAT);
  assert.deepEqual(state.midTurn[0].jobs.map((entry) => entry.jobId), ['3869b0f37a73']);
  const logged = state.logs.find((entry) => entry.event === 'background_job_wake.mid_turn');
  assert.deepEqual(logged.details, { session_id: CHAT, job_count: 1, outcome: 'delivered' });
  assert.equal(ops.stats().pending, 1, 'no ack yet: the job is still pending');
  // The turn ended without an acknowledgement: the post-turn wake still delivers it.
  state.activeTurn = null;
  assert.equal((await ops.onTurnSettled(CHAT)).outcome, 'submitted');
  assert.equal(state.submits.length, 1);
});

test('an acknowledged mid-turn notice (background-job-read) means no wake after the turn', async () => {
  const { ops, state } = harness({ deliverMidTurn: () => ({ ok: true, pushed: 1 }) });
  state.activeTurn = { turn_id: 'turn_live' };
  await ops.onJobSettled(job());
  ops.noteResultRead('3869b0f37a73'); // session.job_notice_consumed -> background-job-read
  state.activeTurn = null;
  assert.equal((await ops.onTurnSettled(CHAT)).outcome, 'none');
  assert.equal(state.submits.length, 0);
});

test('a refused or throwing mid-turn delivery still defers to the post-turn wake and logs only counts', async () => {
  for (const deliverMidTurn of [() => ({ ok: false, reason: 'no_live_stream' }), () => { throw new Error('boom `secret`'); }]) {
    const { ops, state } = harness({ deliverMidTurn });
    state.activeTurn = { turn_id: 'turn_live' };
    assert.equal((await ops.onJobSettled(job())).outcome, 'deferred');
    const logged = state.logs.find((entry) => entry.event === 'background_job_wake.mid_turn');
    assert.deepEqual(Object.keys(logged.details).sort(), ['job_count', 'outcome', 'session_id']);
    assert.doesNotMatch(JSON.stringify(state.logs), /pytest|secret/);
    state.activeTurn = null;
    assert.equal((await ops.onTurnSettled(CHAT)).outcome, 'submitted');
  }
});

test('paused and ineligible chats are not offered a mid-turn notice', async () => {
  for (const options of [{ paused: true }, { summaryExtra: { lockdown: true } }]) {
    const { ops, state } = harness({ ...options, deliverMidTurn: () => ({ ok: true }) });
    state.activeTurn = { turn_id: 'turn_live' };
    await ops.onJobSettled(job());
    assert.equal(state.midTurn.length, 0);
  }
});

test('wiring: the mid-turn port reaches the backend push and the unread job still wakes', async () => {
  const backend = new EventEmitter();
  backend.featureFlags = {};
  backend.sessionStore = { getSessionSummary: () => summary(), peekActiveTurn: () => ({ turn_id: 'live' }) };
  backend.sessionRuntime = { hasSessionWork: () => true, submitApplicationTurn: async () => ({ ok: true }) };
  const logs = [];
  let settled = null;
  wireBackgroundJobWake(backend, { onJobSettled: (fn) => { settled = fn; } }, { log: (level, event, details) => logs.push({ event, details }) });
  settled(job());
  await new Promise((resolve) => setImmediate(resolve));
  const logged = logs.find((entry) => entry.event === 'background_job_wake.mid_turn');
  assert.deepEqual(logged.details, { session_id: CHAT, job_count: 1, outcome: 'no_live_stream' });
  assert.equal(backend.backgroundJobWake.stats().pending, 1);
});

test('a settle while the runtime still holds the work re-checks until the chat is idle', async () => {
  const { ops, state } = harness();
  state.work = true;
  assert.equal((await ops.onJobSettled(job())).outcome, 'deferred');
  assert.equal(state.rechecks.length, 1);
  state.work = false;
  state.rechecks.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.submits.length, 1);
});

test('pause, disabled, ineligible chats and the rate window drop the wake', async () => {
  for (const [options, reason] of [
    [{ paused: true }, 'paused'],
    [{ enabled: false }, 'disabled'],
    [{ summaryExtra: { archived_at: '2026-11-01T00:00:00Z' } }, 'ineligible'],
    [{ summaryExtra: { lockdown: true } }, 'ineligible'],
  ]) {
    const { ops, state } = harness(options);
    assert.equal((await ops.onJobSettled(job())).outcome, reason);
    assert.equal(state.submits.length, 0);
  }
  const { ops, state } = harness();
  for (let index = 0; index < 6; index += 1) {
    await ops.onJobSettled(job({ jobId: `00000000000${index}` }));
  }
  assert.equal((await ops.onJobSettled(job({ jobId: 'ffffffffffff' }))).outcome, 'rate_limited');
  assert.equal(state.submits.length, 6);
  state.clock += 10 * 60 * 1000 + 1;
  assert.equal((await ops.onJobSettled(job({ jobId: 'eeeeeeeeeeee' }))).outcome, 'submitted');
});

test('a busy refusal returns the job to pending for the next settle', async () => {
  const { ops, state } = harness({ results: [{ ok: false, reason: 'session_busy' }] });
  assert.equal((await ops.onJobSettled(job())).outcome, 'deferred');
  assert.equal((await ops.onTurnSettled(CHAT)).outcome, 'submitted');
  assert.equal(state.submits.length, 2);
});

test('the prompt strips control characters and backticks from the command and bounds it', () => {
  const prompt = jobWakePrompt([job({ command: `echo \`x\`‮${'y'.repeat(300)}` })]);
  assert.doesNotMatch(prompt, /‮/);
  assert.match(prompt, /^A background job you started/);
  const line = prompt.split('\n')[1];
  assert.ok(line.length < 160, line);
});

test('wiring: tracker settles wake, reads are noted, the kill switch holds', async () => {
  const backend = new EventEmitter();
  const submits = [];
  let settled = null;
  backend.featureFlags = {};
  backend.sessionStore = { getSessionSummary: () => summary(), peekActiveTurn: () => null };
  backend.sessionRuntime = { hasSessionWork: () => false, submitApplicationTurn: async (request) => { submits.push(request); return { ok: true }; } };
  const tracker = { onJobSettled: (fn) => { settled = fn; } };
  wireBackgroundJobWake(backend, tracker);

  backend.emit('background-job-read', { jobId: '3869b0f37a73' });
  settled(job());
  settled(job({ jobId: 'bbbbbbbbbbbb' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submits.length, 1);
  assert.match(submits[0].prompt, /bbbbbbbbbbbb/);
  assert.doesNotMatch(submits[0].prompt, /3869b0f37a73/);
  backend.featureFlags = { background_job_wake: false };
  settled(job({ jobId: 'cccccccccccc' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submits.length, 1, 'the kill switch stops the wake');
});

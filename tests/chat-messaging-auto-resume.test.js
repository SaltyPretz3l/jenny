const test = require('node:test');
const assert = require('node:assert/strict');

const { autoResumeIdempotencyKey, createAutoResumeOps } = require('../services/chat-messaging-auto-resume');

// 2026-10-27: a spawned review child stopped on its context budget and its half-finished report woke the
// primary; the owner wants Jenny to resume the child until the task finishes.
const CHILD = 'sess_child';
const PARENT = 'sess_parent';

function report(id, { stop = 'context_budget', outcome = 'completed', body = `progress ${id}` } = {}) {
  return {
    operation: {
      state: 'delivered',
      envelope: {
        kind: 'terminal_report', message_id: id, source_session_id: CHILD, destination_session_id: PARENT,
        body, report: { outcome },
      },
    },
    row: { role: 'assistant', terminal_report_message_id: id, ...(stop ? { resumable_stop: stop } : {}) },
  };
}

function harness(overrides = {}) {
  const rows = [];
  const submits = [];
  const fallbacks = [];
  const logs = [];
  const state = { active: null, work: false, submitResult: { ok: true, work_id: 'work_1', turn_id: 'turn_1' } };
  const timers = [];
  const ops = createAutoResumeOps({
    getSessionSummary: () => ({ id: CHILD, run_mode: 'ask', preferred_model: 'ornith15:9b-q6-256k', session_type: 'chat' }),
    readMessages: () => rows,
    getActiveTurn: () => state.active,
    hasSessionWork: () => state.work,
    submitTurn: async (request, options) => { submits.push({ request, options }); return state.submitResult; },
    fallback: async (operation) => { fallbacks.push(operation.envelope.message_id); },
    scheduleRecheck: (fn) => { timers.push(fn); },
    log: (level, event, details) => logs.push({ event, details }),
    ...overrides,
  });
  const deliver = (entry) => { rows.push(entry.row); return ops.take(entry.operation); };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { ops, rows, submits, fallbacks, logs, state, timers, deliver, flush };
}

test('a budget-stopped child report resumes the child under its own model and does not wake the parent', async () => {
  const h = harness();
  assert.equal(h.deliver(report('m1')), true);
  await h.flush();
  assert.equal(h.submits.length, 1);
  const [{ request, options }] = h.submits;
  assert.equal(request.sessionId, CHILD);
  assert.equal(request.preferredModel, 'ornith15:9b-q6-256k');
  assert.equal(request.approvalMode, 'prompt');
  assert.match(request.prompt, /^resume/);
  assert.equal(request.visiblePrompt, 'Resumed automatically after a turn-budget stop');
  assert.equal(options.idempotencyKey, autoResumeIdempotencyKey('m1'));
  assert.deepEqual(h.fallbacks, []);
});

test('a finished report, a failure or diminishing returns goes to the ordinary wake', () => {
  const h = harness();
  assert.equal(h.deliver(report('m1', { stop: '' })), false);
  assert.equal(h.deliver(report('m2', { outcome: 'failed' })), false);
  assert.equal(h.deliver(report('m3', { stop: 'diminishing_returns' })), false);
  assert.equal(h.submits.length, 0);
});

test('the chain stops at the cap and on a repeated report, handing the report to the parent', async () => {
  const h = harness({ maxChain: 2 });
  assert.equal(h.deliver(report('m1')), true);
  await h.flush();
  assert.equal(h.deliver(report('m2')), true);
  await h.flush();
  assert.equal(h.deliver(report('m3')), false, 'third resume in a row exceeds the cap');
  assert.equal(h.logs.at(-1).details.reason, 'chain_cap');
  assert.equal(h.deliver(report('m4', { body: 'same' })), true, 'a new chain starts after the cap hands off');
  await h.flush();
  assert.equal(h.deliver(report('m5', { body: 'same' })), false, 'no progress since the last resume');
  assert.equal(h.logs.at(-1).details.reason, 'no_progress');
});

test('a busy child waits for its settle; a refused submit falls back to the parent wake', async () => {
  const h = harness();
  h.state.work = true;
  assert.equal(h.deliver(report('m1')), true);
  await h.flush();
  assert.equal(h.submits.length, 0, 'the previous turn is still settling');
  h.state.work = false;
  await h.ops.onTurnSettled(CHILD);
  assert.equal(h.submits.length, 1);

  const refused = harness();
  refused.state.submitResult = { ok: false, reason: 'runtime_submission_refused' };
  assert.equal(refused.deliver(report('m1')), true);
  await refused.flush();
  await refused.flush();
  assert.deepEqual(refused.fallbacks, ['m1']);
});

test('a child that moved on to a newer turn is not resumed', async () => {
  const h = harness();
  h.state.work = true;
  assert.equal(h.deliver(report('m1')), true);
  h.rows.push({ role: 'user', content: 'do something else' }, { role: 'assistant', content: 'done' });
  h.state.work = false;
  await h.ops.onTurnSettled(CHILD);
  await h.flush();
  assert.equal(h.submits.length, 0);
  assert.deepEqual(h.fallbacks, ['m1']);
});

test('the kill switch and a paused parent leave the report to the ordinary wake', () => {
  assert.equal(harness({ enabled: () => false }).deliver(report('m1')), false);
  assert.equal(harness({ paused: () => true }).deliver(report('m1')), false);
});

test("a resume turn inherits its stopped turn's wake depth; a failed report ends the chain", async () => {
  const noted = [];
  const h = harness({
    maxChain: 1,
    depthForTurn: (turnId) => (turnId === 'turn_stopped' ? 3 : 0),
    noteWakeTurn: (turnId, depth) => noted.push([turnId, depth]),
  });
  const entry = report('m1');
  entry.operation.envelope.source_turn_id = 'turn_stopped';
  assert.equal(h.deliver(entry), true);
  await h.flush();
  assert.deepEqual(noted, [['turn_1', 3]]);
  assert.equal(h.deliver(report('m2', { outcome: 'failed' })), false);
  assert.equal(h.deliver(report('m3')), true, 'the failed report reset the chain, so the cap of 1 is fresh');
});

test('probe: the card sees a pending resume, the running count, and the count of a chain that hit the cap', async () => {
  const h = harness({ maxChain: 1 });
  h.state.work = true;
  assert.equal(h.deliver(report('m1')), true);
  assert.deepEqual(h.ops.probe(CHILD), { pending: true, count: 1, max: 1 });
  h.state.work = false;
  await h.ops.onTurnSettled(CHILD);
  assert.deepEqual(h.ops.probe(CHILD), { pending: false, count: 1, max: 1 });
  assert.equal(h.deliver(report('m2')), false);
  assert.deepEqual(h.ops.probe(CHILD), { pending: false, count: 1, max: 1 }, 'the ended chain keeps its count');
  assert.equal(h.deliver(report('m3', { stop: '' })), false);
  assert.equal(h.ops.probe(CHILD).count, 0, 'a finished report clears it');
});

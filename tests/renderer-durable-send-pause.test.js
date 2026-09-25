'use strict';
/**
 * tests/renderer-durable-send-pause.test.js
 *
 * Runtime UX A2 (JEN-044) gate: pausing the reply in progress from the
 * composer, watching the request on the shared poll tick, and the paused
 * reply's Resume and Discard. Every notice is written only in the
 * conversation that paused; a request is never called a pause.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { summary, running, workRead, queueHarness } = require('./helpers/durable-send-queue-harness');

test('pausing a running reply reads the fresh revision and promises only what the runtime can do', async t => {
  const { h, calls } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [running(1)] }),
    getWork: workRead('running', 7),
    pause: () => ({ ok: true, work_id: 'work_1', status: 'requested' }),
  });
  // A running turn has no pending entry (admission deletes it), so the pause
  // target can only come from the session snapshot.
  assert.equal(h.state.runtimeSendController.listPending('session-1').length, 0);
  assert.equal(await h.state.runtimeSendController.pauseSession('session-1'), true);
  assert.deepEqual(calls.snapshots[0], { session_id: 'session-1', limit: 100 });
  assert.deepEqual(calls.works, [{ work_id: 'work_1' }], 'the revision is re-read immediately before pausing');
  assert.deepEqual(calls.pauses, [{ work_id: 'work_1', expected_revision: 7 }]);
  const notice = h.calls.composerNotices.at(-1);
  assert.equal(notice.options.owner, 'runtime:pause');
  assert.equal(notice.options.tone, 'pending');
  assert.match(notice.message, /at her next approval/);
  assert.match(notice.message, /a reply that needs no approval finishes/);
  assert.equal(/next tool call/i.test(notice.message), false, 'auto-approved tool calls never offer a pause point');
  assert.equal(/\bpaused\b/i.test(notice.message), false, 'a request is not a pause');
  assert.deepEqual(h.state.runtimeSendController.getSessionRuntimeState('session-1').pause,
    { workId: 'work_1', status: 'requested' });
});

test('a settled pause says so once, offers Resume and never numbers paused work', async t => {
  let status = 'running';
  const { h } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [summary(1, { status })] }),
    getWork: payload => workRead(status, 7)(payload),
    pause: () => ({ ok: true, work_id: 'work_1', status: 'requested' }),
  });
  await h.state.runtimeSendController.pauseSession('session-1');
  status = 'paused';
  await h.state.runtimeSendController.refreshPending();
  const notice = h.calls.composerNotices.at(-1);
  assert.equal(notice.options.owner, 'runtime:pause');
  assert.equal(notice.options.tone, 'success');
  assert.match(notice.message, /^Paused\. Resume from the queue strip when you.re ready\.$/);
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1')
    .map(row => [row.key, row.status, row.position, row.prompt, row.admitted]),
  [['work:work_1', 'paused', null, 'Paused reply', true]]);
  assert.equal(h.state.runtimeSendController.getSessionRuntimeState('session-1').pause.status, 'paused');
});

test('a reply that finishes before the pause lands clears the request through the owner-scoped clear', async t => {
  let status = 'running';
  const { h } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [summary(1, { status })] }),
    getWork: payload => workRead(status, 7)(payload),
    pause: () => ({ ok: true, work_id: 'work_1', status: 'requested' }),
  });
  await h.state.runtimeSendController.pauseSession('session-1');
  status = 'completed';
  await h.state.runtimeSendController.refreshPending();
  const notice = h.calls.composerNotices.at(-1);
  assert.equal(notice.options.owner, 'runtime:pause');
  assert.equal(notice.message, '', 'a moot request leaves no claim on screen');
  assert.equal(notice.options.cleared, true, 'the clear names its owner, so another owner\'s newer notice survives');
  assert.equal(h.state.runtimeSendController.getSessionRuntimeState('session-1').pause, null);
});

test('a pause that settles while another conversation is on screen leaves that composer alone', async t => {
  let status = 'running';
  const { h } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [summary(1, { status })] }),
    getWork: payload => workRead(status, 7)(payload),
    pause: () => ({ ok: true, work_id: 'work_1', status: 'requested' }),
  });
  await h.state.runtimeSendController.pauseSession('session-1');
  const written = h.calls.composerNotices.length;
  h.state.currentSessionId = 'session-2';
  status = 'paused';
  await h.state.runtimeSendController.refreshPending();
  assert.equal(h.state.runtimeSendController.getSessionRuntimeState('session-1').pause.status, 'paused');
  assert.equal(h.calls.composerNotices.length, written, 'no "Paused." lands in a conversation that paused nothing');
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => row.key), ['work:work_1']);
});

test('pausing with only queued work is refused: Pause acts on the reply in progress alone', async t => {
  const { h, calls } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [summary(1, { status: 'pending' })] }),
    getWork: payload => workRead('pending', 4)(payload),
  });
  await h.controller.startPromptSend('hold this one');
  assert.equal(await h.state.runtimeSendController.pauseSession('session-1'), false);
  assert.deepEqual(calls.pauses, [], 'a queued message is withdrawn or paused from Settings, never by the composer Pause');
  const rows = h.state.runtimeSendController.listPending('session-1');
  assert.deepEqual([rows[0].status, rows[0].position], ['pending', 1]);
  const notice = h.calls.composerNotices.at(-1);
  assert.equal(notice.options.owner, 'runtime:pause');
  assert.match(notice.message, /nothing to pause/i);
  assert.equal(h.state.runtimeSendController.getSessionRuntimeState('session-1').pause, null);
});

test('a request the runtime can no longer answer is dropped after three silent reads', async t => {
  let reads = 'ok';
  const { h } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [running(1)] }),
    getWork: payload => (reads === 'ok' ? workRead('running', 7)(payload)
      : { ok: false, error: { code: 'CMP-RUNTIME-0005', reason: 'runtime_work_not_found' } }),
    pause: () => ({ ok: true, work_id: 'work_1', status: 'requested' }),
  });
  await h.state.runtimeSendController.pauseSession('session-1');
  reads = 'gone';
  await h.state.runtimeSendController.refreshPending();
  await h.state.runtimeSendController.refreshPending();
  assert.equal(h.state.runtimeSendController.getSessionRuntimeState('session-1').pause.status, 'requested',
    'two silent reads are a hiccup, not an answer');
  await h.state.runtimeSendController.refreshPending();
  assert.equal(h.state.runtimeSendController.getSessionRuntimeState('session-1').pause, null);
  const notice = h.calls.composerNotices.at(-1);
  assert.deepEqual([notice.message, notice.options.owner, notice.options.cleared], ['', 'runtime:pause', true]);
  assert.ok(h.calls.logs.some(entry => entry.event === 'chat.turn_pause_unanswered'), 'the drop is logged');
});

test('discarding a paused reply cancels at its fresh revision and the row leaves only when the snapshot agrees', async t => {
  let status = 'paused';
  const { h, calls } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [summary(1, { status })] }),
    getWork: payload => workRead('paused', 9)(payload),
    cancel: () => { status = 'cancelled'; return { ok: true, work_id: 'work_1', cleanup_confirmed: true }; },
  });
  await h.state.runtimeSendController.refreshSessionRows('session-1');
  const [row] = h.state.runtimeSendController.listPending('session-1');
  assert.deepEqual([row.key, row.detached, row.status], ['work:work_1', true, 'paused']);
  assert.equal(await h.state.runtimeSendController.withdraw(row.key), true);
  assert.deepEqual(calls.cancels, [{ work_id: 'work_1', expected_revision: 9 }]);
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1'), []);
});

test('a refused discard names the refusal and keeps the paused reply on screen', async t => {
  const { h } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [summary(1, { status: 'paused' })] }),
    getWork: payload => workRead('paused', 9)(payload),
    cancel: () => ({ ok: false, error: { code: 'CMP-RUNTIME-0006', reason: 'revision_conflict' } }),
  });
  await h.state.runtimeSendController.refreshSessionRows('session-1');
  assert.equal(await h.state.runtimeSendController.withdraw('work:work_1'), false);
  const notice = h.calls.composerNotices.at(-1);
  assert.equal(notice.options.owner, 'runtime:withdraw');
  assert.match(notice.message, /changed first/i);
  const [row] = h.state.runtimeSendController.listPending('session-1');
  assert.deepEqual([row.key, row.status], ['work:work_1', 'paused']);
});

test('only a stream admitted through durable Send counts as runtime-owned', async t => {
  const { h } = queueHarness(t);
  await h.controller.startPromptSend('owned');
  assert.equal(h.state.runtimeSendController.ownsStream('stream-legacy'), false);
  h.state.runtimeSendController.acceptAdmission({ type: 'started', sessionId: 'session-1', streamId: 'stream-9', turnId: 'turn_1',
    runtimeAdmission: { work_id: 'work_1', turn_id: 'turn_1', session_id: 'session-1', stream_id: 'stream-9',
      user_message_id: 'user_1', idempotency_key: h.state.runtimeSendController.listPending('session-1')[0].key } });
  assert.equal(h.state.runtimeSendController.ownsStream('stream-9'), true);
  assert.equal(h.state.runtimeSendController.ownsStream(''), false);
});

test('a refused pause names the refusal and records no request', async t => {
  const { h } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [running(1)] }),
    getWork: workRead('running', 7),
    pause: () => ({ ok: false, error: { code: 'CMP-RUNTIME-0006', reason: 'revision_conflict' } }),
  });
  assert.equal(await h.state.runtimeSendController.pauseSession('session-1'), false);
  const notice = h.calls.composerNotices.at(-1);
  assert.equal(notice.options.owner, 'runtime:pause');
  assert.match(notice.message, /changed first/i);
  assert.equal(h.state.runtimeSendController.getSessionRuntimeState('session-1').pause, null);
});

test('nothing to pause is refused instead of silently doing nothing', async t => {
  const { h, calls } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [summary(1, { status: 'completed' })] }),
  });
  assert.equal(await h.state.runtimeSendController.pauseSession('session-1'), false);
  assert.deepEqual(calls.pauses, []);
  const notice = h.calls.composerNotices.at(-1);
  assert.equal(notice.options.owner, 'runtime:pause');
  assert.match(notice.message, /nothing to pause/i);
});

test('resuming paused work the composer never queued reads its revision and drops the row', async t => {
  let status = 'paused';
  const { h, calls } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [summary(1, { status })] }),
    getWork: payload => workRead('paused', 9)(payload),
    resume: () => { status = 'running'; return { ok: true, work_id: 'work_1' }; },
  });
  await h.state.runtimeSendController.refreshSessionRows('session-1');
  const [row] = h.state.runtimeSendController.listPending('session-1');
  assert.equal(row.key, 'work:work_1');
  assert.equal(row.position, null);
  assert.equal(await h.state.runtimeSendController.resume(row.key), true);
  assert.deepEqual(calls.resumes, [{ work_id: 'work_1', expected_revision: 9 }]);
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1'), []);
});

test('a refused resume on detached paused work names the refusal and keeps the row', async t => {
  const { h } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [summary(1, { status: 'paused' })] }),
    getWork: payload => workRead('paused', 9)(payload),
    resume: () => ({ ok: false, error: { code: 'CMP-RUNTIME-0005', reason: 'runtime_resume_refused' } }),
  });
  await h.state.runtimeSendController.refreshSessionRows('session-1');
  assert.equal(await h.state.runtimeSendController.resume('work:work_1'), false);
  const notice = h.calls.composerNotices.at(-1);
  assert.equal(notice.options.owner, 'runtime:resume');
  assert.match(notice.message, /resume/i);
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => row.key), ['work:work_1']);
});

test('a closing runtime is reported so Resume can say why it cannot run yet', async t => {
  const { h, calls } = queueHarness(t, {
    snapshot: () => ({ ok: true, closing: true, next_cursor: null, work: [summary(1, { status: 'paused' })] }),
  });
  await Promise.all([h.state.runtimeSendController.refreshSessionRows('session-1'),
    h.state.runtimeSendController.refreshSessionRows('session-1')]);
  assert.equal(calls.snapshots.length, 1, 'concurrent row reads share one in-flight snapshot');
  assert.equal(h.state.runtimeSendController.getSessionRuntimeState('session-1').closing, true);
  assert.equal(h.state.runtimeSendController.getSessionRuntimeState('another-session').closing, false);
});

test('an outstanding pause request still costs exactly one snapshot read per tick', async t => {
  const { h, calls } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [running(1), summary(2)] }),
    getWork: workRead('running', 7),
    pause: () => ({ ok: true, work_id: 'work_1', status: 'requested' }),
  });
  await h.controller.startPromptSend('behind the reply');
  await h.state.runtimeSendController.pauseSession('session-1');
  const before = calls.snapshots.length;
  await h.state.runtimeSendController.refreshPending();
  await h.state.runtimeSendController.refreshPending();
  assert.equal(calls.snapshots.length - before, 2, 'one snapshot per tick, no extra read per request');
});

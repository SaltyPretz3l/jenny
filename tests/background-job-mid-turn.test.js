'use strict';

// Mid-turn background-job notices (row 71): services/backend/background-job-mid-turn.js over fake services
// and clients; the wake's own port wiring is covered in background-job-wake.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { attachMidTurnMail } = require('../services/backend/session-mail-mid-turn');
const {
  MID_TURN_ACKS, acceptJobNoticeConsumedNotification, promptCommand, pushMidTurnJobNotices,
} = require('../services/backend/background-job-mid-turn');

const CHAT = 'sess_chat';
const JOB = '3869b0f37a73';

function snapshot(extra = {}) {
  return { jobId: JOB, sessionId: CHAT, command: 'npm test', state: 'failed', exitCode: 1, endedAtMs: 1, ...extra };
}

function makeService({ sent = true, flags } = {}) {
  const service = new EventEmitter();
  service.logs = [];
  service.frames = [];
  service.featureFlags = flags || {};
  service.activeStreams = new Map();
  service.sessionStore = { active: new Map(), getActiveTurn(id) { return this.active.get(id) || null; } };
  service._emitServiceLog = (level, event, details) => service.logs.push({ level, event, details });
  // The client surface notifyJobSettled (sidecar-client-notifications.js) writes through.
  service.sidecarClient = {
    process: { stdin: {} },
    connected: true,
    sendResult: sent,
    _batch4TransportEnabled: () => true,
    _writeFrame(frame) {
      service.frames.push(frame);
      return this.sendResult;
    },
  };
  service.openStream = (streamId, turnId = `turn_${streamId}`) => {
    const ctx = { service, resolvedSessionId: CHAT, streamId, turnId };
    attachMidTurnMail(ctx);
    service.sessionStore.active.set(CHAT, { stream_id: streamId, turn_id: turnId });
    service.activeStreams.set(streamId, {});
    return ctx;
  };
  return service;
}

test('the kill switch refuses before anything is sent', () => {
  const service = makeService({ flags: { background_job_notices: false } });
  service.openStream('s1');
  assert.deepEqual(pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot()] }), { ok: false, reason: 'disabled' });
  assert.equal(service.frames.length, 0);
});

test('a chat with no live managed stream gets no push', () => {
  const service = makeService();
  assert.equal(pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot()] }).reason, 'no_live_stream');
  service.openStream('s1');
  service.sessionStore.active.delete(CHAT); // the turn is no longer active
  assert.equal(pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot()] }).reason, 'no_live_stream');
  assert.equal(pushMidTurnJobNotices(service, { sessionId: '', jobs: [snapshot()] }).reason, 'no_live_stream');
  assert.equal(service.frames.length, 0);
});

test('the wire frame carries the live stream id, a sanitized command and a null exit code', () => {
  const service = makeService();
  service.openStream('s1');
  const result = pushMidTurnJobNotices(service, {
    sessionId: CHAT,
    jobs: [snapshot({ command: 'echo `x`‮ hi' }), snapshot({ jobId: 'aaaaaaaaaaaa', state: 'completed', exitCode: undefined })],
  });
  assert.deepEqual(result, { ok: true, pushed: 2 });
  assert.deepEqual(service.frames, [{
    jsonrpc: '2.0',
    method: 'session.job_settled',
    params: {
      session_id: CHAT,
      request_id: 's1',
      jobs: [
        { job_id: JOB, command: 'echo x hi', state: 'failed', exit_code: 1 },
        { job_id: 'aaaaaaaaaaaa', command: 'npm test', state: 'completed', exit_code: null },
      ],
    },
  }]);
  assert.doesNotMatch(JSON.stringify(service.logs), /npm test|echo/, 'logs carry counts, never commands');
});

test('invalid ids and unsettled states are dropped, and a frame carries at most 8 jobs', () => {
  const service = makeService();
  service.openStream('s1');
  const many = Array.from({ length: 12 }, (_, index) => snapshot({ jobId: `00000000000${index.toString(16)}` }));
  const result = pushMidTurnJobNotices(service, {
    sessionId: CHAT,
    jobs: [snapshot({ jobId: 'NOT-AN-ID' }), snapshot({ jobId: 'bbbbbbbbbbbb', state: 'running' }), snapshot({ jobId: 7 }), ...many],
  });
  assert.deepEqual(result, { ok: true, pushed: 8 });
  assert.deepEqual(service.frames[0].params.jobs.map((entry) => entry.job_id), many.slice(0, 8).map((entry) => entry.jobId));
  assert.equal(pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot({ jobId: 'NOPE' })] }).reason, 'nothing_to_push');
});

test('a failed send keeps the ids unpushed so the next attempt resends them', () => {
  const service = makeService({ sent: false });
  service.openStream('s1');
  assert.deepEqual(pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot()] }), { ok: false, reason: 'send_failed' });
  service.sidecarClient.sendResult = true;
  assert.deepEqual(pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot()] }), { ok: true, pushed: 1 });
  assert.equal(service.frames.length, 2);
  service.sidecarClient.connected = false; // the sidecar went away mid-turn
  assert.equal(pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot({ jobId: 'cccccccccccc' })] }).reason, 'send_failed');
  service.sidecarClient = null;
  assert.equal(pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot({ jobId: 'cccccccccccc' })] }).reason, 'send_failed');
});

test('a job is pushed once per stream, only the new ids follow, and a newer stream may resend', () => {
  const service = makeService();
  service.openStream('s1');
  assert.equal(pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot()] }).ok, true);
  assert.deepEqual(pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot()] }), { ok: false, reason: 'nothing_to_push' });
  const second = pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot(), snapshot({ jobId: 'dddddddddddd' })] });
  assert.deepEqual(second, { ok: true, pushed: 1 });
  assert.deepEqual(service.frames[1].params.jobs.map((entry) => entry.job_id), ['dddddddddddd']);
  service.openStream('s2'); // the next turn of the same chat
  assert.deepEqual(pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot()] }), { ok: true, pushed: 1 });
  assert.equal(service.frames[2].params.request_id, 's2');
});

test('a throwing client or service never throws out of the push', () => {
  const service = makeService();
  service.openStream('s1');
  service.sidecarClient._writeFrame = () => { throw new Error('pipe closed'); };
  assert.deepEqual(pushMidTurnJobNotices(service, { sessionId: CHAT, jobs: [snapshot()] }), { ok: false, reason: 'exception' });
  assert.equal(pushMidTurnJobNotices(null, undefined).ok, false);
});

test('the acknowledgement marks each valid job id read and ignores junk', () => {
  const service = makeService();
  const ctx = service.openStream('s1');
  const reads = [];
  service.on('background-job-read', (info) => reads.push(info.jobId));
  assert.equal(acceptJobNoticeConsumedNotification(ctx, { job_ids: [JOB, 'bad', 7, null, 'aaaaaaaaaaaa', { jobId: JOB }] }), 2);
  assert.deepEqual(reads, [JOB, 'aaaaaaaaaaaa']);
  for (const params of [undefined, {}, { job_ids: JOB }, { job_ids: {} }]) {
    assert.equal(acceptJobNoticeConsumedNotification(ctx, params), 0);
  }
  assert.equal(acceptJobNoticeConsumedNotification(null, { job_ids: [JOB] }), 0);
  const capped = Array.from({ length: 40 }, (_, index) => `0000000000${(index + 16).toString(16)}`.slice(-12));
  reads.length = 0;
  acceptJobNoticeConsumedNotification(ctx, { job_ids: capped });
  assert.equal(reads.length, 16, 'at most 16 ids are honoured');
});

test('promptCommand keeps a command on one line without backticks and clips it to 120 characters', () => {
  assert.equal(promptCommand('npm\ttest\n-- `x` y'), 'npm test -- x y');
  assert.equal(promptCommand(null), '');
  const clipped = promptCommand('a'.repeat(200));
  assert.equal(clipped.length, 120);
  assert.ok(clipped.endsWith('…'));
});

test('the router table covers both mid-turn acknowledgements', () => {
  assert.deepEqual([...MID_TURN_ACKS.keys()], ['session.mail_consumed', 'session.job_notice_consumed']);
  assert.equal(MID_TURN_ACKS.get('session.job_notice_consumed'), acceptJobNoticeConsumedNotification);
});

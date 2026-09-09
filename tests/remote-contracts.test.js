'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const contracts = require('../services/remote/remote-contracts');
const limits = require('../services/remote/remote-limits');

const OPTIONAL_SESSION_OPERATIONS = new Set([
  'session.list', 'session.create', 'heartbeat', 'resync',
]);

const VALID_PAYLOADS = Object.freeze({
  'session.list': {},
  'session.create': {},
  'session.share_ack': {},
  'transcript.page': { before: 'message_1', limit: 25 },
  'chat.send': { prompt: 'hello from phone' },
  'chat.stop': {},
  'decision.tool': {
    stream_id: 'stream_1', approval_id: 'approval_1', decision_revision: 0, decision: 'approve_once',
  },
  'decision.question': {
    question_ref: 'question_1',
    batch_id: 'batch_1',
    decision: 'answer',
    answers: [{ id: 'answer_1', value: 'yes' }],
  },
  'decision.plan': {
    stream_id: 'stream_1',
    approval_id: 'approval_1',
    decision_revision: 1,
    decision: 'revise',
    feedback: 'Use the existing service boundary.',
  },
  'control.request': {},
  'control.release': {},
  heartbeat: {},
  resync: { last_event_seq: 4 },
});

const WRONG_PAYLOADS = Object.freeze({
  'session.list': [],
  'session.create': null,
  'session.share_ack': 'bad',
  'transcript.page': { limit: '25' },
  'chat.send': { prompt: 42 },
  'chat.stop': [],
  'decision.tool': {
    stream_id: 'stream_1', approval_id: 'approval_1', decision_revision: 0, decision: true,
  },
  'decision.question': {
    question_ref: 'question_1', batch_id: 'batch_1', answers: 'yes',
  },
  'decision.plan': {
    stream_id: 'stream_1', approval_id: 'approval_1', decision_revision: '1', decision: 'approve',
  },
  'control.request': null,
  'control.release': [],
  heartbeat: false,
  resync: { last_event_seq: 1.5 },
});

function command(operation, payload = VALID_PAYLOADS[operation]) {
  const value = {
    v: 1,
    kind: 'command',
    request_id: 'request_1',
    operation,
    payload,
  };
  if (!OPTIONAL_SESSION_OPERATIONS.has(operation)) value.session_id = ' session_1 ';
  return value;
}

test('frame header accepts the versioned bounded base64url envelope', () => {
  const result = contracts.validateFrameHeader({
    v: 1,
    route_id: 'route_123',
    connection_id: 'connect_1',
    epoch: 'epoch_123',
    seq: 0,
    ciphertext: 'YWJjZA',
  });
  assert.deepEqual(result, {
    ok: true,
    value: {
      v: 1,
      route_id: 'route_123',
      connection_id: 'connect_1',
      epoch: 'epoch_123',
      seq: 0,
      ciphertext: 'YWJjZA',
    },
  });
});

test('frame header rejects every bounded header failure path', () => {
  const base = {
    v: 1,
    route_id: 'route_123',
    connection_id: 'connect_1',
    epoch: 'epoch_123',
    seq: 0,
    ciphertext: 'YWJjZA',
  };
  const cases = [
    [{ ...base, v: 2 }, '$.v'],
    [{ ...base, route_id: 'bad id!' }, '$.route_id'],
    [{ ...base, connection_id: 'bad id!' }, '$.connection_id'],
    [{ ...base, epoch: 'bad id!' }, '$.epoch'],
    [{ ...base, seq: -1 }, '$.seq'],
    [{ ...base, seq: 1.5 }, '$.seq'],
    [{ ...base, extra: true }, '$.extra'],
    [{ ...base, ciphertext: 'a'.repeat(limits.FRAME_MAX_BYTES - limits.FRAME_HEADER_BUDGET_BYTES + 1) }, '$.ciphertext'],
    [{ ...base, ciphertext: '' }, '$.ciphertext'],
    [{ ...base, ciphertext: 'AB' }, '$.ciphertext'],
    [{ ...base, ciphertext: 'AA==' }, '$.ciphertext'],
    [{ ...base, ciphertext: 'not+base64' }, '$.ciphertext'],
  ];
  for (const [candidate, path] of cases) {
    const result = contracts.validateFrameHeader(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.path, path);
  }
});

test('command envelope rejects version, request id, kind, operation, and unknown fields', () => {
  const base = command('session.list');
  const cases = [
    [{ ...base, v: 2 }, '$.v'],
    [{ ...base, kind: 'event' }, '$.kind'],
    [{ ...base, request_id: 'bad id!' }, '$.request_id'],
    [{ ...base, operation: 'session.delete' }, '$.operation'],
    [{ ...base, unexpected: true }, '$.unexpected'],
  ];
  for (const [candidate, path] of cases) {
    const result = contracts.validateCommand(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.path, path);
  }
});

test('every operation accepts its payload and rejects extra keys and a wrong type', () => {
  for (const operation of contracts.OPERATIONS) {
    const accepted = contracts.validateCommand(command(operation));
    assert.equal(accepted.ok, true, `${operation} should accept its valid payload`);
    if (accepted.value.session_id) assert.equal(accepted.value.session_id, 'session_1');

    const withExtra = { ...VALID_PAYLOADS[operation], extra: true };
    const extraResult = contracts.validateCommand(command(operation, withExtra));
    assert.equal(extraResult.ok, false, `${operation} should reject an extra key`);
    assert.equal(extraResult.reason, 'invalid_request');
    assert.equal(extraResult.path, '$.payload.extra');

    const wrongResult = contracts.validateCommand(command(operation, WRONG_PAYLOADS[operation]));
    assert.equal(wrongResult.ok, false, `${operation} should reject a wrong type`);
  }
});

test('session_id is required only for session-scoped operations', () => {
  for (const operation of contracts.OPERATIONS) {
    const withoutSession = command(operation);
    delete withoutSession.session_id;
    const result = contracts.validateCommand(withoutSession);
    assert.equal(
      result.ok,
      OPTIONAL_SESSION_OPERATIONS.has(operation),
      `${operation} session requirement`
    );
    if (!result.ok) assert.equal(result.path, '$.session_id');
  }
});

test('decision payload validator reuses tool, question, and plan rules', () => {
  assert.equal(contracts.validateDecisionPayload('tool', VALID_PAYLOADS['decision.tool']).ok, true);
  assert.equal(
    contracts.validateDecisionPayload('question', VALID_PAYLOADS['decision.question']).ok,
    true
  );
  assert.equal(contracts.validateDecisionPayload('plan', VALID_PAYLOADS['decision.plan']).ok, true);
  assert.equal(contracts.validateDecisionPayload('future', {}).path, '$.kind');
  assert.equal(contracts.validateDecisionPayload('plan', {
    stream_id: 'stream_1',
    approval_id: 'approval_1',
    decision_revision: 1,
    decision: 'revise',
  }).path, '$.feedback');
});

test('scoped stream and approval identities accept 256 characters without truncation', () => {
  const base = {
    stream_id: 's'.repeat(256), approval_id: 'a'.repeat(256),
    decision_revision: 1, decision: 'approve_once',
  };
  assert.equal(contracts.validateDecisionPayload('tool', base).ok, true);
  assert.equal(contracts.validateDecisionPayload('tool', {
    ...base, approval_id: 'a'.repeat(257),
  }).ok, false);
  assert.equal(contracts.validateDecisionPayload('tool', {
    ...base, stream_id: 's'.repeat(257),
  }).ok, false);
});

test('question decisions carry an explicit answer/decline discriminator and multiselect arrays', () => {
  const base = { question_ref: 'question_1', batch_id: 'batch_1' };
  const declined = contracts.validateDecisionPayload('question', { ...base, decision: 'decline' });
  assert.equal(declined.ok, true);
  assert.deepEqual(declined.value, { ...base, decision: 'decline' });
  assert.equal(contracts.validateDecisionPayload('question', {
    ...base, decision: 'decline', answers: [],
  }).ok, false);
  const multi = contracts.validateDecisionPayload('question', {
    ...base, decision: 'answer', answers: [{ id: 'q1', value: ['a', 'b'] }, { id: 'q2', other: 'free text' }],
  });
  assert.equal(multi.ok, true);
  assert.deepEqual(multi.value.answers, [{ id: 'q1', value: ['a', 'b'] }, { id: 'q2', other: 'free text' }]);
  assert.equal(contracts.validateDecisionPayload('question', { ...base, answers: [] }).ok, false);
  assert.equal(contracts.validateDecisionPayload('question', {
    ...base, decision: 'answer', answers: [{ id: 'q1', value: 'x'.repeat(501) }],
  }).ok, false);
  assert.equal(contracts.validateDecisionPayload('question', {
    ...base, decision: 'answer', answers: [{ id: 'q1', value: ['x'.repeat(501)] }],
  }).ok, false);
  assert.equal(contracts.validateDecisionPayload('question', {
    ...base, decision: 'answer', answers: [{ id: 'q'.repeat(65), value: 'x' }],
  }).ok, false);
});

test('plan feedback is rejected beyond the backend\'s 800-character ceiling', () => {
  const base = { stream_id: 'stream_1', approval_id: 'approval_1', decision_revision: 1, decision: 'revise' };
  assert.equal(contracts.validateDecisionPayload('plan', { ...base, feedback: 'x'.repeat(800) }).ok, true);
  assert.equal(contracts.validateDecisionPayload('plan', { ...base, feedback: 'x'.repeat(801) }).ok, false);
  assert.equal(contracts.validateDecisionPayload('plan', { ...base, feedback: '会'.repeat(700) }).ok, false);
});

test('prompt, feedback, answer, and page limits use their contract bounds', () => {
  assert.equal(contracts.validateCommand(command('chat.send', {
    prompt: '会'.repeat(Math.ceil(limits.PROMPT_MAX_BYTES / 3)),
  })).ok, false);
  assert.equal(contracts.validateDecisionPayload('question', {
    question_ref: 'question_1',
    batch_id: 'batch_1',
    answers: Array.from({ length: 33 }, (_, index) => ({ id: `answer_${index}` })),
  }).ok, false);
  assert.equal(contracts.validateCommand(command('transcript.page', {
    limit: limits.TRANSCRIPT_PAGE_MAX_MESSAGES + 1,
  })).ok, false);
});

test('result, error, event, and session-id helpers emit the wire shape', () => {
  assert.deepEqual(contracts.buildResult('request_1', { accepted: true }), {
    v: 1, kind: 'result', request_id: 'request_1', ok: true, data: { accepted: true },
  });
  assert.deepEqual(contracts.buildError('request_1', 'rate_limited', 'slow down', true), {
    v: 1,
    kind: 'result',
    request_id: 'request_1',
    ok: false,
    error: { code: 'CMP-REMOTE-0006', reason: 'slow down', retryable: true },
  });
  assert.throws(() => contracts.buildError('request_1', 'missing', 'bad'), /unknown remote error code/);
  assert.deepEqual(contracts.buildEvent({
    eventSeq: 7,
    type: 'delta',
    sessionId: ' session_1 ',
    streamId: 'stream_1',
    turnId: 'turn_1',
    payload: { text: 'hi' },
  }), {
    v: 1,
    kind: 'event',
    event_seq: 7,
    type: 'delta',
    session_id: 'session_1',
    stream_id: 'stream_1',
    turn_id: 'turn_1',
    payload: { text: 'hi' },
  });
  assert.throws(() => contracts.buildEvent({
    eventSeq: 1, type: 'future', sessionId: 'session_1', payload: {},
  }), /unknown remote event type/);
  assert.equal(contracts.toWireSessionId(' session_1 '), 'session_1');
  assert.equal(contracts.fromWireSessionId(' session_1 '), 'session_1');
  assert.throws(() => contracts.toWireSessionId('x'.repeat(129)), RangeError);
});

test('remote error codes are frozen, unique, and canonical', () => {
  const values = Object.values(contracts.ERROR_CODES);
  assert.equal(Object.isFrozen(contracts.ERROR_CODES), true);
  assert.equal(new Set(values).size, values.length);
  assert.equal(values.length, 12);
  for (const code of values) assert.match(code, /^CMP-REMOTE-\d{4}$/);
});

test('rate limiter refills without timers and evicts the oldest of 256 keys', () => {
  let currentTime = 0;
  const limiter = limits.createRateLimiter({ perMinute: 60, burst: 2, now: () => currentTime });
  assert.equal(limiter.take('device_1'), true);
  assert.equal(limiter.take('device_1'), true);
  assert.equal(limiter.take('device_1'), false);
  currentTime = 1000;
  assert.equal(limiter.take('device_1'), true);
  limiter.reset('device_1');
  assert.equal(limiter.size(), 0);

  for (let index = 0; index < 257; index += 1) limiter.take(`device_${index}`);
  assert.equal(limiter.size(), 256);
  assert.equal(limiter.take('device_0'), true);
});

test('remote limits expose the approved Slice 0 values', () => {
  const expected = {
    PAIRING_WINDOW_MS: 120_000,
    PAIRING_FAILURES_MAX: 5,
    MAX_DEVICES: 5,
    ACCESS_SESSION_MS: 900_000,
    COMMANDS_PER_MIN: 30,
    COMMANDS_BURST: 10,
    SENDS_PER_MIN: 6,
    SESSION_CREATES_PER_HOUR: 5,
    PROMPT_MAX_BYTES: 16_384,
    FRAME_MAX_BYTES: 1_048_576,
    FRAME_HEADER_BUDGET_BYTES: 512,
    PENDING_COMMANDS_MAX: 16,
    TRANSCRIPT_PAGE_MAX_MESSAGES: 50,
    TRANSCRIPT_PAGE_MAX_BYTES: 262_144,
    OUTBOUND_QUEUE_MAX_BYTES: 1_048_576,
    REPLAY_MAX_BYTES: 2_097_152,
    REPLAY_MAX_MS: 120_000,
    DELTA_COALESCE_MS: 50,
    RECONNECT_BACKOFF_MAX_MS: 30_000,
    HEARTBEAT_MS: 20_000,
    RELAY_ONLINE_LEASE_MS: 30_000,
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(limits[name], value, name);
  assert.equal(Object.isFrozen(limits), true);
});

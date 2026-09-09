'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('../services/remote/remote-contracts');
const limits = require('../services/remote/remote-limits');
const policy = require('../services/remote/remote-policy');
const { createControlLeases } = require('../services/remote/remote-control-leases');
const { createCommandRouter } = require('../services/remote/remote-command-router');

const sessionId = 'session-local-1';
const deviceId = 'device_id1';
const epoch = 'epoch_id1';

function command(operation, payload = {}, options = {}) {
  const value = {
    v: 1,
    kind: 'command',
    request_id: options.requestId || 'request_1',
    operation,
    payload,
  };
  if (!['session.list', 'session.create', 'heartbeat', 'resync'].includes(operation)) {
    value.session_id = contracts.toWireSessionId(options.sessionId || sessionId);
  }
  if (options.leaseId) value.control_lease = options.leaseId;
  return value;
}

function fixture(overrides = {}) {
  let clock = 100;
  let nextId = 1;
  const calls = [];
  const events = [];
  const shared = Object.hasOwn(overrides, 'shared') ? overrides.shared : [sessionId];
  const leases = createControlLeases({
    now: () => clock,
    randomId: () => `lease_${String(nextId++).padStart(3, '0')}`,
  });
  const chatAdapter = {
    listSessions: async (input) => { calls.push(['listSessions', input]); return { ok: true, sessions: [] }; },
    createSession: async (input) => {
      calls.push(['createSession', input]);
      return { ok: true, data: { id: 'created-session' } };
    },
    transcriptPage: async (input) => { calls.push(['transcriptPage', input]); return { ok: true, data: { messages: [] } }; },
    send: async (input) => { calls.push(['send', input]); return { ok: true, data: { stream_id: 'stream_01' } }; },
    stop: async (input) => { calls.push(['stop', input]); return { ok: true, data: { reason: 'remote_stop' } }; },
    ...overrides.chatAdapter,
  };
  const decisionAdapter = {
    decideTool: async (input) => { calls.push(['decideTool', input]); return { ok: true, data: { settled: true } }; },
    decidePlan: async (input) => { calls.push(['decidePlan', input]); return { ok: true, data: { settled: true } }; },
    answerQuestions: async (input) => { calls.push(['answerQuestions', input]); return { ok: true, data: { settled: true } }; },
    declineQuestions: async (input) => { calls.push(['declineQuestions', input]); return { ok: true, data: { settled: true } }; },
    ...overrides.decisionAdapter,
  };
  const router = createCommandRouter({
    contracts,
    limits,
    policy,
    chatAdapter,
    decisionAdapter,
    leases,
    getSession: (id) => (overrides.missingSession || id !== sessionId ? null : {
      id,
      session_type: 'chat',
      archived_at: null,
      lockdown: overrides.lockdown === true,
    }),
    hasGrant: (id) => shared.includes(id),
    featureFlags: () => ({ session_offline_lockdown: true }),
    now: () => clock,
    currentEpoch: () => (typeof overrides.currentEpoch === 'function'
      ? overrides.currentEpoch() : (overrides.currentEpoch || epoch)),
    emitEvent: (event) => { events.push(event); return true; },
  });
  return {
    router,
    leases,
    calls,
    events,
    peer: { deviceId, epoch },
    setClock: (value) => { clock = value; },
  };
}

async function runWithLease(fix, value) {
  const granted = fix.leases.request(sessionId, deviceId);
  value.control_lease = granted.lease.lease_id;
  return fix.router.handle({ peer: fix.peer, command: value });
}

test('dispatches every adapter operation with trusted identity and normalized arguments', async () => {
  const cases = [
    ['session.list', command('session.list'), 'listSessions'],
    ['transcript.page', command('transcript.page', { before: 'message-1', limit: 5 }), 'transcriptPage'],
    ['chat.send', command('chat.send', { prompt: 'hello' }), 'send'],
    ['chat.stop', command('chat.stop'), 'stop'],
    ['decision.tool', command('decision.tool', {
      stream_id: 'stream_01', approval_id: 'approve_1', decision_revision: 1, decision: 'approve_once',
    }), 'decideTool'],
    ['decision.plan', command('decision.plan', {
      stream_id: 'stream_01', approval_id: 'approve_1', decision_revision: 1, decision: 'approve',
    }), 'decidePlan'],
    ['decision.question', command('decision.question', {
      question_ref: 'question-1', batch_id: 'batch-1', decision: 'answer',
      answers: [{ id: 'answer-1', value: 'yes' }],
    }), 'answerQuestions'],
    ['decision.question', command('decision.question', {
      question_ref: 'question-1', batch_id: 'batch-1', decision: 'decline',
    }), 'declineQuestions'],
  ];
  for (const [operation, value, expected] of cases) {
    const fix = fixture();
    const result = ['chat.send', 'chat.stop', 'decision.tool', 'decision.plan', 'decision.question']
      .includes(operation) ? await runWithLease(fix, value)
      : await fix.router.handle({ peer: fix.peer, command: value });
    assert.equal(result.ok, true, operation);
    assert.equal(fix.calls[0][0], expected, operation);
    assert.equal(fix.calls[0][1].deviceId, deviceId);
    assert.equal(typeof fix.calls[0][1].isAuthorized, 'function');
    if (value.session_id) assert.equal(fix.calls[0][1].sessionId, sessionId);
  }
});

test('normalizeCommand exposes the contracts-normalized session identity', () => {
  const fix = fixture();
  const value = command('transcript.page');
  value.session_id = ` ${sessionId} `;
  assert.equal(fix.router.normalizeCommand(value).session_id, sessionId);
});

test('lease enforcement covers send, stop, and every decision family', async () => {
  const values = [
    command('chat.send', { prompt: 'hello' }),
    command('chat.stop'),
    command('decision.tool', {
      stream_id: 'stream_01', approval_id: 'approve_1', decision_revision: 1, decision: 'deny',
    }),
    command('decision.plan', {
      stream_id: 'stream_01', approval_id: 'approve_1', decision_revision: 1, decision: 'approve',
    }),
    command('decision.question', {
      question_ref: 'question-1', batch_id: 'batch-1', decision: 'decline',
    }),
  ];
  for (const value of values) {
    const fix = fixture();
    const result = await fix.router.handle({ peer: fix.peer, command: value });
    assert.equal(result.error.code, contracts.ERROR_CODES.unauthorized);
    assert.equal(result.error.reason, 'control_required');
    assert.equal(fix.calls.length, 0);
  }
});

test('rejects unshared sessions and stale epochs before dispatch', async () => {
  const unshared = fixture({ shared: [] });
  const missing = await unshared.router.handle({
    peer: unshared.peer,
    command: command('transcript.page'),
  });
  assert.equal(missing.error.code, contracts.ERROR_CODES.session_not_shared);
  const stale = fixture({ currentEpoch: 'other_ep1' });
  const rejected = await stale.router.handle({ peer: stale.peer, command: command('heartbeat') });
  assert.equal(rejected.error.code, contracts.ERROR_CODES.epoch_invalid);
});

test('rate limits a device at the configured burst', async () => {
  const fix = fixture();
  for (let index = 0; index < limits.COMMANDS_BURST; index += 1) {
    const result = await fix.router.handle({
      peer: fix.peer,
      command: command('heartbeat', {}, { requestId: `request_${index}` }),
    });
    assert.equal(result.ok, true);
  }
  const limited = await fix.router.handle({ peer: fix.peer, command: command('heartbeat') });
  assert.equal(limited.error.code, contracts.ERROR_CODES.rate_limited);
});

test('maps thrown adapter failures without leaking exception text', async () => {
  const fix = fixture({
    chatAdapter: { listSessions: async () => { throw new Error('super secret failure'); } },
  });
  const result = await fix.router.handle({ peer: fix.peer, command: command('session.list') });
  assert.equal(result.error.code, contracts.ERROR_CODES.not_reachable);
  assert.equal(result.error.reason, 'internal_error');
  assert.doesNotMatch(JSON.stringify(result), /super secret/);
});

test('control request reports another holder and session create dispatches to the adapter', async () => {
  const held = fixture();
  held.leases.request(sessionId, 'other_dev1');
  const busy = await held.router.handle({ peer: held.peer, command: command('control.request') });
  assert.equal(busy.error.code, contracts.ERROR_CODES.session_busy);
  assert.equal(busy.error.reason, 'controlled_by_other');

  const created = fixture();
  const result = await created.router.handle({ peer: created.peer, command: command('session.create') });
  assert.equal(result.ok, true);
  assert.equal(created.calls[0][0], 'createSession');
  assert.deepEqual(created.events, []);
});

test('adapter share failures preserve the bounded share_failed reason', async () => {
  const fix = fixture({
    chatAdapter: {
      createSession: async () => ({
        ok: false,
        error: 'not_reachable',
        reason: 'share_failed',
        retryable: true,
      }),
    },
  });
  const result = await fix.router.handle({ peer: fix.peer, command: command('session.create') });
  assert.equal(result.error.code, contracts.ERROR_CODES.not_reachable);
  assert.equal(result.error.reason, 'share_failed');
});

test('epoch invalidation after create prevents remote sharing and drops the result', async () => {
  let activeEpoch = epoch;
  let resolveCreate;
  const fix = fixture({
    currentEpoch: () => activeEpoch,
    chatAdapter: {
      createSession: () => new Promise((resolve) => { resolveCreate = resolve; }),
    },
  });
  const pending = fix.router.handle({ peer: fix.peer, command: command('session.create') });
  await Promise.resolve();
  activeEpoch = 'other_ep1';
  resolveCreate({ ok: true, data: { id: 'created-session' } });
  assert.equal(await pending, null);
  assert.deepEqual(fix.events, []);
});

test('policy rejects lockdown and missing sessions before any adapter call', async () => {
  for (const options of [{ lockdown: true }, { missingSession: true }]) {
    const fix = fixture(options);
    const result = await fix.router.handle({
      peer: fix.peer,
      command: command('transcript.page'),
    });
    assert.equal(result.error.code, contracts.ERROR_CODES.session_not_shared);
    assert.deepEqual(fix.calls, []);
  }
});

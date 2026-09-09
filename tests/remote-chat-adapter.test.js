'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const realLimits = require('../services/remote/remote-limits');
const policy = require('../services/remote/remote-policy');
const projector = require('../services/remote/remote-transcript-projector');
const {
  validateChatStartPayload,
} = require('../services/backend/generated-chat-lifecycle-contract');
const { normalizeManagedToolPreferences } = require('../services/backend/backend-service-utils');
const { normalizeMessageFields } = require('../services/backend/message-normalization');
const { createRemoteChatAdapter } = require('../services/remote/remote-chat-adapter');

function session(overrides = {}) {
  return {
    id: 'session_1',
    title: 'Shared chat',
    session_type: 'chat',
    updated_at: '2026-09-05T12:00:00.000Z',
    message_count: 2,
    last_message_preview: 'latest',
    archived_at: null,
    lockdown: false,
    plan_mode: true,
    preferred_model: 'qwen-local',
    reasoning_effort: 'high',
    context_preferences: { memory: false },
    run_mode: 'ask',
    tool_category_overrides: { files: false, web: false, terminal: false, python: false },
    ...overrides,
  };
}

class FakeBackend extends EventEmitter {
  constructor(records = [session()]) {
    super();
    this.records = new Map(records.map((record) => [record.id, record]));
    this.startCalls = [];
    this.createCalls = [];
    this.cancelCalls = [];
    this.active = null;
    this.messages = [];
    this.sessionStore = { getSession: (id) => this.records.get(id) || null };
  }

  async listSessions() {
    return { object: 'list', data: [...this.records.values()] };
  }

  async createSession(input) {
    this.createCalls.push(input);
    const created = session({ id: `session_${this.createCalls.length + 1}`, title: input.title });
    this.records.set(created.id, created);
    return { object: 'session', data: created };
  }

  async startChatStream(payload, options) {
    this.startCalls.push({ payload, options });
    return { sessionId: payload.sessionId, streamId: `stream_${this.startCalls.length}` };
  }

  async getActiveTurnState() {
    return this.active;
  }

  async cancelChatStream(streamId, reason) {
    this.cancelCalls.push({ streamId, reason });
    return true;
  }

  async getSessionMessages() {
    return { object: 'list', data: this.messages };
  }
}

function createAdapter(backend = new FakeBackend(), overrides = {}) {
  let validations = 0;
  const limits = { ...realLimits, ...(overrides.limits || {}) };
  const adapter = createRemoteChatAdapter({
    backendService: backend,
    featureFlags: () => overrides.flags || {},
    now: overrides.now || (() => 0),
    limits,
    policy,
    contracts: {
      validateChatStartPayload(value) {
        validations += 1;
        return overrides.validate ? overrides.validate(value) : validateChatStartPayload(value);
      },
    },
    projector,
    leases: overrides.leases || {
      controllerOf: (id) => (id === 'session_1' ? 'device_1' : null),
      leaseFor: (sessionId, deviceId) => (
        sessionId === 'session_1' && deviceId === 'device_1'
          ? { lease_id: 'lease_1', session_id: sessionId, device_id: deviceId }
          : null
      ),
    },
    cancellations: overrides.cancellations || {
      create: () => ({ signal: new AbortController().signal, bindStream() {} }),
    },
    shareSession: overrides.shareSession || (async () => ({ ok: true })),
    currentEpoch: overrides.currentEpoch || (() => 'epoch_1'),
  });
  return { adapter, backend, validations: () => validations };
}

function sendInput(overrides = {}) {
  return {
    deviceId: 'device_1',
    sessionId: 'session_1',
    prompt: 'hello from phone',
    requestId: 'request_1',
    hasGrant: (id) => id === 'session_1',
    lease: { device_id: 'device_1', session_id: 'session_1' },
    ...overrides,
  };
}

test('session listing is policy filtered, grant filtered, and controller projected', async () => {
  const backend = new FakeBackend([
    session(),
    session({ id: 'session_2', title: 'Not shared' }),
    session({ id: 'session_3', lockdown: true }),
  ]);
  const { adapter } = createAdapter(backend, { flags: { session_offline_lockdown: true } });
  const result = await adapter.listSessions({
    hasGrant: (id) => ['session_1', 'session_3'].includes(id),
  });
  assert.deepEqual(result, {
    ok: true,
    sessions: [{
      id: 'session_1',
      title: 'Shared chat',
      updated_at: '2026-09-05T12:00:00.000Z',
      message_count: 2,
      last_message_preview: 'latest',
      controlled_by: 'device_1',
    }],
  });
});

test('send derives desktop-equivalent tool and approval preferences from trusted session state', async () => {
  const { adapter, backend, validations } = createAdapter();
  const result = await adapter.send(sendInput({
    preferredModel: 'attacker-model',
    planMode: false,
  }));

  assert.equal(result.ok, true);
  assert.equal(validations(), 1);
  assert.deepEqual(backend.startCalls[0].payload, {
    sessionId: 'session_1',
    prompt: 'hello from phone',
    visiblePrompt: 'hello from phone',
    traceId: 'remote:request_1',
    planMode: true,
    preferredModel: 'qwen-local',
    reasoningEffort: 'high',
    contextPreferences: { memory: false },
    toolPreferences: normalizeManagedToolPreferences({
      file_tools: false, web_search: false, Bash: false, python_execute: false,
    }),
    approvalMode: 'prompt',
  });
});

test('send rejects client-supplied forbidden backend options before validation', async () => {
  const { adapter, backend, validations } = createAdapter();
  const result = await adapter.send(sendInput({ toolPreferences: { file_tools: true } }));
  assert.equal(result.error, 'invalid_request');
  assert.equal(result.detail, 'forbidden field: toolPreferences');
  assert.equal(validations(), 0);
  assert.equal(backend.startCalls.length, 0);
});

test('a forbidden-field replay cannot reuse a prior clean receipt', async () => {
  const { adapter, backend } = createAdapter();
  assert.equal((await adapter.send(sendInput())).ok, true);
  const replay = await adapter.send(sendInput({ approvalMode: 'auto_run' }));
  assert.equal(replay.error, 'invalid_request');
  assert.equal(backend.startCalls.length, 1);
});

test('validator rejection surfaces as invalid_request before backend start', async () => {
  const { adapter, backend, validations } = createAdapter(undefined, {
    validate: () => ({ ok: false, error: { reason: 'forced_invalid' } }),
  });
  const result = await adapter.send(sendInput());
  assert.equal(result.error, 'invalid_request');
  assert.equal(result.reason, 'invalid_request');
  assert.equal(result.detail, 'forced_invalid');
  assert.equal(validations(), 1);
  assert.equal(backend.startCalls.length, 0);
});

test('unshared, lockdown, and busy sends map to bounded remote errors', async () => {
  const unshared = createAdapter();
  assert.equal((await unshared.adapter.send(sendInput({ hasGrant: () => false }))).error, 'session_not_shared');

  const lockedBackend = new FakeBackend([session({ lockdown: true })]);
  const locked = createAdapter(lockedBackend, { flags: { session_offline_lockdown: true } });
  assert.equal((await locked.adapter.send(sendInput())).error, 'lockdown');

  const busy = createAdapter();
  busy.backend.startChatStream = async () => {
    const error = new Error('a turn is already running');
    error.code = 'session_busy';
    throw error;
  };
  assert.equal((await busy.adapter.send(sendInput())).error, 'session_busy');
});

test('backend start failures expose only a public code and sanitized bounded detail', async () => {
  const failed = createAdapter();
  failed.backend.startChatStream = async () => {
    throw new Error('failed at C:\\Users\\private\\secret.txt token=sk-abcdefghijklmnop');
  };
  const result = await failed.adapter.send(sendInput());
  assert.equal(result.reason, 'not_reachable');
  assert.ok(result.detail.length <= 200);
  assert.doesNotMatch(result.detail, /Users|sk-abcdefghijklmnop/);
});

test('send receipts are idempotent and reject request id digest changes', async () => {
  const { adapter, backend } = createAdapter();
  const first = await adapter.send(sendInput());
  const repeat = await adapter.send(sendInput());
  const mismatch = await adapter.send(sendInput({ prompt: 'different' }));
  assert.deepEqual(repeat, first);
  assert.equal(backend.startCalls.length, 1);
  assert.equal(mismatch.error, 'invalid_request');
});

test('receipt capacity never evicts unsettled work', async () => {
  let currentTime = 0;
  const releases = [];
  const backend = new FakeBackend();
  backend.startChatStream = (payload, options) => new Promise((resolve) => {
    backend.startCalls.push({ payload, options });
    releases.push(() => resolve({
      sessionId: payload.sessionId, streamId: `stream_${backend.startCalls.length}`,
    }));
  });
  const pending = createAdapter(backend, {
    now: () => currentTime,
    limits: { PENDING_COMMANDS_MAX: 1, MAX_DEVICES: 1, SENDS_PER_MIN: 6 },
  });
  const first = pending.adapter.send(sendInput());
  const second = pending.adapter.send(sendInput({ requestId: 'request_2' }));
  const replay = pending.adapter.send(sendInput());
  assert.equal(backend.startCalls.length, 0);
  await Promise.resolve();
  assert.equal(backend.startCalls.length, 2);
  releases.forEach((release) => release());
  assert.deepEqual(await replay, await first);
  await second;
  assert.equal(backend.startCalls.length, 2);
});

test('settled receipt replays expire after ten minutes', async () => {
  let currentTime = 0;
  const retained = createAdapter(undefined, { now: () => currentTime });
  await retained.adapter.send(sendInput());
  currentTime = 600_001;
  const expired = await retained.adapter.send(sendInput());
  assert.equal(expired.error, 'invalid_request');
  assert.equal(expired.detail, 'request_id expired');
  assert.equal(retained.backend.startCalls.length, 1);
});

test('prompt byte limits and per-device send limits are enforced', async () => {
  const prompt = createAdapter();
  assert.equal((await prompt.adapter.send(sendInput({ prompt: '' }))).error, 'invalid_request');
  assert.equal((await prompt.adapter.send(sendInput({
    requestId: 'request_large',
    prompt: 'x'.repeat(realLimits.PROMPT_MAX_BYTES + 1),
  }))).error, 'payload_too_large');

  const limited = createAdapter(undefined, { limits: { SENDS_PER_MIN: 1 } });
  assert.equal((await limited.adapter.send(sendInput())).ok, true);
  assert.equal((await limited.adapter.send(sendInput({ requestId: 'request_2' }))).error, 'rate_limited');
});

test('session creation uses desktop defaults, rate limits, and receipts', async () => {
  const { adapter, backend } = createAdapter(undefined, {
    limits: { SESSION_CREATES_PER_HOUR: 1 },
  });
  const first = await adapter.createSession({ deviceId: 'device_1', requestId: 'create_1' });
  const repeat = await adapter.createSession({ deviceId: 'device_1', requestId: 'create_1' });
  const limited = await adapter.createSession({ deviceId: 'device_1', requestId: 'create_2' });
  assert.equal(first.ok, true);
  assert.deepEqual(repeat, first);
  assert.deepEqual(backend.createCalls, [{ title: 'Phone chat' }]);
  assert.equal(limited.error, 'rate_limited');
  assert.equal((await adapter.createSession({ deviceId: 'device_1' })).error, 'invalid_request');
});

test('session creation retries only a failed initial share and freezes completed receipts', async () => {
  let shareCalls = 0;
  let shared = false;
  const fix = createAdapter(undefined, {
    shareSession: async () => {
      shareCalls += 1;
      if (shareCalls === 1) return { ok: false, reason: 'save_failed' };
      shared = true;
      return { ok: true };
    },
  });
  const input = { deviceId: 'device_1', requestId: 'create_retry', isEpochLive: () => true };
  const failed = await fix.adapter.createSession(input);
  assert.equal(failed.error, 'not_reachable');
  assert.equal(failed.reason, 'share_failed');
  assert.equal(fix.backend.createCalls.length, 1);
  fix.backend.records.get('session_2').title = 'Canonical after retry';
  const succeeded = await fix.adapter.createSession(input);
  assert.equal(succeeded.ok, true);
  assert.equal(succeeded.data.title, 'Canonical after retry');
  assert.equal(fix.backend.createCalls.length, 1);
  assert.equal(shareCalls, 2);
  assert.equal(shared, true);
  shared = false;
  const replay = await fix.adapter.createSession(input);
  assert.deepEqual(replay, succeeded);
  assert.equal(shareCalls, 2);
  assert.equal(shared, false);
});

test('queued create checks epoch liveness before calling the backend', async () => {
  let live = true;
  const fix = createAdapter();
  const pending = fix.adapter.createSession({
    deviceId: 'device_1',
    requestId: 'create_denied',
    isEpochLive: () => live,
  });
  live = false;
  const result = await pending;
  assert.equal(result.error, 'epoch_invalid');
  assert.equal(fix.backend.createCalls.length, 0);
});

test('revoked create authority retains the receipt without sharing or creating twice', async () => {
  const backend = new FakeBackend();
  let resolveCreate;
  let authorized = true;
  let createCalls = 0;
  let shareCalls = 0;
  backend.createSession = () => new Promise((resolve) => {
    createCalls += 1;
    resolveCreate = () => {
      const created = session({ id: 'session_2', title: 'Phone chat' });
      backend.records.set(created.id, created);
      resolve({ data: created });
    };
  });
  const fix = createAdapter(backend, {
    shareSession: async () => { shareCalls += 1; return { ok: true }; },
  });
  const input = {
    deviceId: 'device_1',
    requestId: 'create_revoked',
    isEpochLive: () => true,
    isAuthorized: () => authorized,
  };
  const pending = fix.adapter.createSession(input);
  while (!resolveCreate) await Promise.resolve();
  authorized = false;
  resolveCreate();
  assert.equal((await pending).error, 'unauthorized');
  assert.equal(shareCalls, 0);
  authorized = true;
  assert.equal((await fix.adapter.createSession(input)).ok, true);
  assert.equal(createCalls, 1);
  assert.equal(shareCalls, 1);
});

test('failed starts cancel their scoped token', async () => {
  const cancelled = [];
  const fix = createAdapter(undefined, {
    cancellations: {
      create(scope) {
        return {
          signal: new AbortController().signal,
          bindStream() {},
          cancel: (reason) => { cancelled.push([scope, reason]); },
        };
      },
    },
  });
  fix.backend.startChatStream = async () => { throw new Error('offline'); };
  const result = await fix.adapter.send(sendInput({ isEpochLive: () => true }));
  assert.equal(result.error, 'not_reachable');
  assert.deepEqual(cancelled, [[{
    sessionId: 'session_1',
    deviceId: 'device_1',
  }, 'start_failed']]);
});

test('stop targets only the controlled session active stream', async () => {
  const { adapter, backend } = createAdapter();
  backend.active = { session_id: 'session_1', stream_id: 'stream_active' };
  const result = await adapter.stop({
    deviceId: 'device_1',
    sessionId: 'session_1',
    lease: { lease_id: 'lease_1', device_id: 'device_1', session_id: 'session_1' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.reason, 'remote_stop');
  assert.deepEqual(backend.cancelCalls, [{ streamId: 'stream_active', reason: 'user_cancel' }]);
  backend.active = null;
  assert.equal((await adapter.stop({
    deviceId: 'device_1', sessionId: 'session_1',
    lease: { lease_id: 'lease_1', device_id: 'device_1', session_id: 'session_1' },
  })).error, 'not_reachable');
});

test('transcript pages obey count and byte bounds', async () => {
  const backend = new FakeBackend();
  backend.messages = Array.from({ length: 5 }, (_, index) => normalizeMessageFields({
    id: `message_${index + 1}`,
    role: 'assistant',
    kind: 'message',
    content: `content ${index + 1}`,
  }));
  const { adapter } = createAdapter(backend, {
    limits: { TRANSCRIPT_PAGE_MAX_MESSAGES: 2, TRANSCRIPT_PAGE_MAX_BYTES: 10_000 },
  });
  const result = await adapter.transcriptPage({
    sessionId: 'session_1', hasGrant: (id) => id === 'session_1', limit: 50,
  });
  assert.deepEqual(result.data.messages.map((message) => message.id), ['message_4', 'message_5']);
  assert.equal(result.data.has_more, true);
  assert.equal(result.data.next_before, 'message_4');

  const bytes = projector.projectPage(backend.messages, {
    limits: { TRANSCRIPT_PAGE_MAX_MESSAGES: 5, TRANSCRIPT_PAGE_MAX_BYTES: 1 },
  });
  assert.equal(bytes.messages.length, 1);
  assert.equal(bytes.messages[0].truncated, true);
  assert.equal(bytes.has_more, true);
  assert.equal(bytes.next_before, 'message_5');
});

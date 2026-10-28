'use strict';

/* primaryChat.* IPC registration (row 76 slice S2): the nine descriptor-backed
 * channels, the trusted-sender gate, closed-schema validation before any service
 * call, the service-answer mapping, the failure envelope when a service is absent
 * or throws, and the lazy reset-module dispatch. The controls service, the
 * activity log and the reset module are faked; the real ones are owned by other
 * slices. The reset module is injected through the registration's `loadReset`
 * seam (default: a lazy `require('../backend/primary-chat-reset')`). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { registerPrimaryChatIpc, METHODS } = require('../services/main/primary-chat-ipc-registration');
const contract = require('../services/primary-chat-contract');
const { JENNY_SHELL_BRIDGE_DESCRIPTORS } = require('../services/ipc-contract');
const { PRIMARY_ERROR_CODES: CODES } = require('../services/backend/error-codes');

const CHANNELS = {
  getState: 'primary-chat:get-state',
  activity: 'primary-chat:activity',
  permissions: 'primary-chat:permissions',
  pause: 'primary-chat:pause',
  resume: 'primary-chat:resume',
  grantLaunch: 'primary-chat:grant-launch',
  revokeLaunch: 'primary-chat:revoke-launch',
  reset: 'primary-chat:reset',
  forgetPreview: 'primary-chat:forget-preview',
};
const PERMISSION_ID = `lp_${'a'.repeat(32)}`;

function fakeBackend(calls, overrides = {}) {
  const record = (name, answer) => async (...args) => { calls.push([name, ...args]); return answer; };
  return {
    primaryChatControls: {
      getState: record('getState', { ok: true, paused: false }),
      pause: record('pause', { ok: true, paused: true }),
      resume: record('resume', { ok: true, paused: false }),
      grantLaunch: record('grantLaunch', { ok: true, permission: { permission_id: PERMISSION_ID } }),
      revokeLaunch: record('revokeLaunch', { ok: true, permission: { permission_id: PERMISSION_ID } }),
    },
    primaryActivityLog: {
      list: record('list', { ok: true, entries: [], truncated: false }),
      permissions: record('permissions', { ok: true, launch: [], message_grants: [], turn_grants: [] }),
    },
    ...overrides,
  };
}

function fakeReset(calls) {
  return {
    resetPrimaryChat: async (backend, options) => { calls.push(['reset', options]); return { ok: true, cleared: { messages: 0, mail: 0, proposals: 0 }, copy_path: null }; },
    forgetPreview: async () => { calls.push(['forgetPreview']); return { ok: true, memories: 2, pending: 1 }; },
  };
}

function register({ allow = true, backendService, loadReset } = {}) {
  const handlers = new Map();
  registerPrimaryChatIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    backendService,
    authorization: { authorize: () => allow },
    ...(loadReset ? { loadReset } : {}),
  });
  return { handlers, invoke: (channel, payload) => handlers.get(channel)({ sender: {} }, payload) };
}

const V1 = { schema_version: 1 };

test('exactly the nine descriptor-backed invoke channels are registered, and onChanged is a subscription', () => {
  const { handlers } = register({ backendService: {} });
  assert.deepEqual([...handlers.keys()].sort(), Object.values(CHANNELS).sort());
  assert.equal(Object.keys(METHODS).length, 9);
  assert.equal(Object.isFrozen(METHODS), true);
  for (const [method, channel] of Object.entries(CHANNELS)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[`primaryChat.${method}`], { kind: 'invoke', channel });
  }
  assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS['primaryChat.onChanged'], { kind: 'subscribe', channel: 'primary-chat:changed' });
});

test('an untrusted sender reaches no service method', async () => {
  const calls = [];
  const denied = register({ allow: false, backendService: fakeBackend(calls), loadReset: () => fakeReset(calls) });
  for (const channel of Object.values(CHANNELS)) {
    const result = await denied.invoke(channel, V1);
    assert.equal(result.ok, false);
    assert.notEqual(result.schema_version, 1);
  }
  assert.equal(calls.length, 0);
});

test('invalid payloads answer CMP-PRIMARY-0001 without calling any service', async () => {
  const calls = [];
  const { invoke } = register({ backendService: fakeBackend(calls), loadReset: () => fakeReset(calls) });
  const invalid = [
    [CHANNELS.getState, { schema_version: 1, extra: true }],
    [CHANNELS.getState, { schema_version: 2 }],
    [CHANNELS.getState, undefined],
    [CHANNELS.activity, { schema_version: 1, limit: 0 }],
    [CHANNELS.activity, { schema_version: 1, limit: 201 }],
    [CHANNELS.activity, { schema_version: 1, before: 'yesterday' }],
    [CHANNELS.grantLaunch, { schema_version: 1 }],
    [CHANNELS.grantLaunch, { schema_version: 1, project_id: '*', run_modes: [] }],
    [CHANNELS.grantLaunch, { schema_version: 1, project_id: '*', run_modes: ['ask', 'ask'] }],
    [CHANNELS.grantLaunch, { schema_version: 1, project_id: '*', run_modes: ['yolo'] }],
    [CHANNELS.grantLaunch, { schema_version: 1, project_id: '*', max_children_per_turn: 4 }],
    [CHANNELS.grantLaunch, { schema_version: 1, project_id: 'a\nb' }],
    [CHANNELS.revokeLaunch, { schema_version: 1, permission_id: 'lp_zz' }],
    [CHANNELS.revokeLaunch, { schema_version: 1, permission_id: `lp_${'A'.repeat(32)}` }],
    [CHANNELS.reset, { schema_version: 1, forget: 'yes' }],
    [CHANNELS.reset, { schema_version: 1, wipe: true }],
    [CHANNELS.forgetPreview, { schema_version: 1, forget: true }],
  ];
  for (const [channel, payload] of invalid) {
    const result = await invoke(channel, payload);
    assert.equal(result.ok, false, `${channel} ${JSON.stringify(payload)}`);
    assert.equal(result.code, CODES.INVALID_REQUEST);
    assert.equal(result.reason, 'invalid_request');
    assert.equal(result.retryable, false);
  }
  assert.equal(calls.length, 0);
});

test('valid payloads reach the services with defaults filled in, and service answers are wrapped', async () => {
  const calls = [];
  const { invoke } = register({ backendService: fakeBackend(calls), loadReset: () => fakeReset(calls) });
  assert.deepEqual(await invoke(CHANNELS.getState, V1), { schema_version: 1, ok: true, paused: false });
  assert.deepEqual(await invoke(CHANNELS.pause, V1), { schema_version: 1, ok: true, paused: true });
  assert.deepEqual(await invoke(CHANNELS.resume, V1), { schema_version: 1, ok: true, paused: false });
  await invoke(CHANNELS.activity, V1);
  await invoke(CHANNELS.activity, { ...V1, limit: 5, before: '2026-10-25T10:00:00.000Z' });
  await invoke(CHANNELS.permissions, V1);
  await invoke(CHANNELS.grantLaunch, { ...V1, project_id: '*' });
  await invoke(CHANNELS.grantLaunch, { ...V1, project_id: 'proj_1', run_modes: ['auto', 'plan'], max_children_per_turn: 3 });
  await invoke(CHANNELS.revokeLaunch, { ...V1, permission_id: PERMISSION_ID });
  assert.deepEqual(calls, [
    ['getState', {}],
    ['pause', {}],
    ['resume', {}],
    ['list', { limit: 60, before: null }],
    ['list', { limit: 5, before: '2026-10-25T10:00:00.000Z' }],
    ['permissions'],
    ['grantLaunch', { project_id: '*', run_modes: null, max_children_per_turn: 1 }],
    ['grantLaunch', { project_id: 'proj_1', run_modes: ['auto', 'plan'], max_children_per_turn: 3 }],
    ['revokeLaunch', { permission_id: PERMISSION_ID }],
  ]);
});

test('a service refusal maps through the reason classes', async () => {
  const refuse = (reason) => async () => ({ ok: false, reason });
  const backend = fakeBackend([], {
    primaryChatControls: {
      getState: refuse('disabled'), pause: refuse('session_busy'), resume: refuse('not_found'),
      grantLaunch: refuse('unknown_project'), revokeLaunch: refuse('capacity'),
    },
  });
  const { invoke } = register({ backendService: backend });
  const cases = [
    [CHANNELS.pause, V1, CODES.BUSY, 'session_busy', true],
    [CHANNELS.getState, V1, CODES.DISABLED, 'disabled', false],
    [CHANNELS.resume, V1, CODES.NOT_FOUND, 'not_found', false],
    [CHANNELS.grantLaunch, { ...V1, project_id: 'x' }, CODES.UNKNOWN_PROJECT, 'unknown_project', false],
    [CHANNELS.revokeLaunch, { ...V1, permission_id: PERMISSION_ID }, CODES.CAPACITY, 'capacity', false],
  ];
  for (const [channel, payload, code, reason, retryable] of cases) {
    assert.deepEqual(await invoke(channel, payload), { schema_version: 1, ok: false, code, reason, retryable });
  }
  assert.deepEqual(contract.fail('surprise'), {
    schema_version: 1, ok: false, code: CODES.UNAVAILABLE, reason: 'unavailable', retryable: true,
  });
});

test('a missing service and a throwing service answer CMP-PRIMARY-0002 without exception text', async () => {
  const expected = {
    schema_version: 1, ok: false, code: CODES.UNAVAILABLE, reason: 'unavailable', retryable: true,
  };
  const missing = register({ backendService: {}, loadReset: () => undefined });
  for (const [channel, payload] of [
    [CHANNELS.getState, V1], [CHANNELS.activity, V1], [CHANNELS.permissions, V1], [CHANNELS.pause, V1],
    [CHANNELS.resume, V1], [CHANNELS.grantLaunch, { ...V1, project_id: '*' }],
    [CHANNELS.revokeLaunch, { ...V1, permission_id: PERMISSION_ID }], [CHANNELS.reset, V1], [CHANNELS.forgetPreview, V1],
  ]) {
    assert.deepEqual(await missing.invoke(channel, payload), expected, channel);
  }
  const boom = async () => { throw new Error('secret path C:\\Users\\x'); };
  const backend = fakeBackend([], {
    primaryChatControls: { getState: boom, pause: boom, resume: boom, grantLaunch: boom, revokeLaunch: boom },
    primaryActivityLog: { list: boom, permissions: boom },
  });
  const loadReset = () => ({ resetPrimaryChat: boom, forgetPreview: boom });
  const throwing = register({ backendService: backend, loadReset });
  for (const channel of Object.values(CHANNELS)) {
    const payload = channel === CHANNELS.grantLaunch ? { ...V1, project_id: '*' }
      : channel === CHANNELS.revokeLaunch ? { ...V1, permission_id: PERMISSION_ID } : V1;
    const result = await throwing.invoke(channel, payload);
    assert.deepEqual(result, expected, channel);
    assert.doesNotMatch(JSON.stringify(result), /secret|Users/u);
  }
  // A reset module that fails to load answers unavailable too.
  const noModule = register({ backendService: fakeBackend([]), loadReset: () => { throw new Error('Cannot find module'); } });
  assert.deepEqual(await noModule.invoke(CHANNELS.reset, V1), expected);
});

test('reset forwards the validated defaults and an explicit request to the reset module', async () => {
  const calls = [];
  const backend = fakeBackend(calls);
  const { invoke } = register({ backendService: backend, loadReset: () => fakeReset(calls) });
  const defaults = await invoke(CHANNELS.reset, V1);
  assert.equal(defaults.ok, true);
  await invoke(CHANNELS.reset, { ...V1, forget: true, keep_copy: false, memory_opt_out: true });
  const preview = await invoke(CHANNELS.forgetPreview, V1);
  assert.deepEqual(preview, { schema_version: 1, ok: true, memories: 2, pending: 1 });
  assert.deepEqual(calls, [
    ['reset', { forget: false, keep_copy: true, memory_opt_out: false }],
    ['reset', { forget: true, keep_copy: false, memory_opt_out: true }],
    ['forgetPreview'],
  ]);
});

test('a reset refusal maps session_busy to the retryable busy code', async () => {
  const loadReset = () => ({ resetPrimaryChat: async () => ({ ok: false, reason: 'session_busy' }), forgetPreview: async () => ({ ok: false, reason: 'disabled' }) });
  const { invoke } = register({ backendService: fakeBackend([]), loadReset });
  assert.deepEqual(await invoke(CHANNELS.reset, V1), {
    schema_version: 1, ok: false, code: CODES.BUSY, reason: 'session_busy', retryable: true,
  });
  assert.equal((await invoke(CHANNELS.forgetPreview, V1)).code, CODES.DISABLED);
  const copyFailed = () => ({ resetPrimaryChat: async () => ({ ok: false, reason: 'copy_failed' }), forgetPreview: async () => null });
  const failing = register({ backendService: fakeBackend([]), loadReset: copyFailed });
  assert.deepEqual(await failing.invoke(CHANNELS.reset, V1), { schema_version: 1, ok: false, code: CODES.COPY_FAILED, reason: 'copy_failed', retryable: false });
});

test('the contract validators accept the documented boundaries and reject everything else', () => {
  assert.deepEqual(contract.validateActivityRequest({ ...V1, limit: 200 }), { ok: true, value: { limit: 200, before: null } });
  assert.deepEqual(contract.validateGrantLaunchRequest({ ...V1, project_id: 'p'.repeat(128) }).ok, true);
  assert.equal(contract.validateGrantLaunchRequest({ ...V1, project_id: 'p'.repeat(129) }).ok, false);
  assert.equal(contract.validateGrantLaunchRequest({ ...V1, project_id: '' }).ok, false);
  assert.equal(contract.validateEmptyRequest(Object.create({ schema_version: 1 })).ok, false);
  assert.equal(contract.validateEmptyRequest([]).ok, false);
  assert.deepEqual(contract.succeed({ x: 1 }), { schema_version: 1, ok: true, x: 1 });
  assert.equal(contract.SCHEMA_VERSION, 1);
});

'use strict';

// Epoch push (agentic memory v2, row 58 W2): every memory policy epoch bump is
// sent to the sidecar as memory.policy_epoch, best-effort, under one stable
// random epoch_source per Electron process (BackendService).

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  bumpMemoryPolicyEpoch,
  flushMemoryPolicyEpochPush,
  memoryPolicyEpoch,
  readMemorySettings,
} = require('../services/backend/backend-memory');

function serviceWith(request) {
  const calls = [];
  const logs = [];
  const config = { memory: {} };
  return {
    calls,
    logs,
    config,
    configService: { getState: () => config },
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    sidecarClient: {
      request: (method, params) => {
        calls.push({ method, params });
        return request(method, params);
      },
    },
  };
}

test('a bump sends memory.policy_epoch with a stable per-process epoch_source', async () => {
  const service = serviceWith(async (_method, params) => ({ latest: params.policy_epoch }));
  assert.equal(bumpMemoryPolicyEpoch(service, 'one'), 1, 'the bump stays synchronous');
  assert.equal(bumpMemoryPolicyEpoch(service, 'two'), 2);
  await flushMemoryPolicyEpochPush(service);
  assert.deepEqual(service.calls.map(call => call.method), ['memory.policy_epoch', 'memory.policy_epoch']);
  const [first, second] = service.calls.map(call => call.params);
  assert.deepEqual(Object.keys(first).sort(), ['accept_version', 'epoch_source', 'policy_epoch']);
  assert.deepEqual([first.policy_epoch, second.policy_epoch], [1, 2]);
  assert.match(first.epoch_source, /^[0-9a-f-]{36}$/u);
  assert.equal(second.epoch_source, first.epoch_source, 'one source per process');
  const other = serviceWith(async () => ({}));
  bumpMemoryPolicyEpoch(other, 'x');
  await flushMemoryPolicyEpochPush(other);
  assert.notEqual(other.calls[0].params.epoch_source, first.epoch_source, 'a new process takes a new source');
});

test('the lazy settings-signature bump also pushes', async () => {
  const service = serviceWith(async () => ({ latest: 1 }));
  assert.equal(memoryPolicyEpoch(service), 0);
  assert.equal(service.calls.length, 0, 'the first read records the signature without a bump');
  service.config.memory = { pauseSaving: true };
  assert.equal(memoryPolicyEpoch(service), 1);
  await flushMemoryPolicyEpochPush(service);
  assert.deepEqual(service.calls.map(call => [call.method, call.params.policy_epoch]), [['memory.policy_epoch', 1]]);
});

test('push failures are logged at WARN and never throw', async () => {
  const rejecting = serviceWith(async () => { throw Object.assign(new Error('method not found'), { reason: 'method_not_found' }); });
  assert.equal(bumpMemoryPolicyEpoch(rejecting, 'x'), 1);
  await flushMemoryPolicyEpochPush(rejecting);
  const warn = rejecting.logs.find(entry => entry.event === 'memory.policy_epoch_push_failed');
  assert.equal(warn.level, 'WARN');
  assert.deepEqual(Object.keys(warn.details).sort(), ['epoch', 'reason']);

  const throwing = serviceWith(() => { throw new Error('sync failure'); });
  assert.equal(bumpMemoryPolicyEpoch(throwing, 'x'), 1);
  await flushMemoryPolicyEpochPush(throwing);
  assert.equal(throwing.logs.filter(entry => entry.event === 'memory.policy_epoch_push_failed').length, 1);

  const noSidecar = { _emitServiceLog() {} };
  assert.equal(bumpMemoryPolicyEpoch(noSidecar, 'x'), 1);
  await flushMemoryPolicyEpochPush(noSidecar);
  await flushMemoryPolicyEpochPush({});
});

test('takeNotes defaults on: a missing or non-boolean value reads as true', () => {
  const read = memory => readMemorySettings({ configService: { getState: () => ({ memory }) } }).takeNotes;
  assert.equal(read(undefined), true);
  assert.equal(read({}), true);
  assert.equal(read({ takeNotes: 'off' }), true);
  assert.equal(read({ takeNotes: true }), true);
  assert.equal(read({ takeNotes: false }), false);
});

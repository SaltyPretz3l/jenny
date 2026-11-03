'use strict';

// Coverage for services/main/usage-stats-ipc.js: the `usage:get-stats` handler
// behind the Home "Usage" widget (row 98, slice S2).

const test = require('node:test');
const assert = require('node:assert/strict');

const { getBridgeDescriptor } = require('../services/ipc-contract');
const { registerUsageStatsIpc } = require('../services/main/usage-stats-ipc');

const CHANNEL = 'usage:get-stats';
const NOW = new Date(2026, 10, 1, 15, 30);

function createFakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
}

function emptyDay(overrides = {}) {
  return {
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    generation_tokens: 0,
    generation_duration_ms: 0,
    estimated_turns: 0,
    hours: new Array(24).fill(0),
    models: {},
    ...overrides,
  };
}

test('usage.getStats is a declared invoke descriptor on usage:get-stats', () => {
  const descriptor = getBridgeDescriptor('usage.getStats');
  assert.equal(descriptor.kind, 'invoke');
  assert.equal(descriptor.channel, CHANNEL);
});

test('handler returns computed stats from the rollup snapshot', async () => {
  const ipc = createFakeIpcMain();
  let reads = 0;
  const usageHistory = {
    getRollupSnapshot() {
      reads += 1;
      return {
        schema_version: 1,
        first_recorded_at: '',
        days: {
          '2026-11-01': emptyDay({
            turns: 2,
            total_tokens: 120,
            models: {
              local: { provider: 'ollama', turns: 1, total_tokens: 60 },
              cloud: { provider: 'chatgpt', turns: 1, total_tokens: 60 },
            },
          }),
        },
        archived: null,
      };
    },
  };
  registerUsageStatsIpc(ipc, { usageHistory, now: () => NOW });

  const result = await ipc.handlers.get(CHANNEL)({});
  assert.equal(reads, 1);
  assert.equal(result.available, true);
  assert.equal(result.since, '2026-11-01');
  assert.equal(result.ranges['1d'].turns, 2);
  assert.equal(result.ranges['1d'].total_tokens, 120);
  // The default predicate is the shared isLocalEngine: ollama local, chatgpt not.
  assert.equal(result.ranges['1d'].local_share, 0.5);
  assert.equal(result.streak.current, 1);
  assert.equal(result.heatmap.length, 371);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('handler uses an injected local-provider predicate', async () => {
  const ipc = createFakeIpcMain();
  registerUsageStatsIpc(ipc, {
    usageHistory: {
      getRollupSnapshot: () => ({
        days: {
          '2026-11-01': emptyDay({
            turns: 1,
            models: { m: { provider: 'chatgpt', turns: 1, total_tokens: 1 } },
          }),
        },
      }),
    },
    isLocalProvider: (provider) => provider === 'chatgpt',
    now: () => NOW,
  });
  const result = await ipc.handlers.get(CHANNEL)({});
  assert.equal(result.ranges['1d'].local_share, 1);
});

test('missing usageHistory or getRollupSnapshot answers empty stats, not an error', async () => {
  for (const usageHistory of [undefined, null, {}]) {
    const ipc = createFakeIpcMain();
    registerUsageStatsIpc(ipc, { usageHistory, now: () => NOW });
    const result = await ipc.handlers.get(CHANNEL)({});
    assert.equal(result.available, true);
    assert.equal(result.error, undefined);
    assert.equal(result.since, null);
    assert.equal(result.ranges.all.turns, 0);
    assert.equal(result.ranges['7d'].favorite_model, null);
    assert.deepEqual(result.streak, { current: 0, longest: 0 });
    assert.equal(result.heatmap.length, 371);
  }
});

test('a throwing getRollupSnapshot returns the error envelope and logs a bounded reason', async () => {
  const ipc = createFakeIpcMain();
  const logged = [];
  const failure = Object.assign(new Error('C:\\Users\\someone\\secret path exploded'), { code: 'EBUSY' });
  registerUsageStatsIpc(ipc, {
    usageHistory: { getRollupSnapshot() { throw failure; } },
    logger: (level, event, data) => logged.push({ level, event, data }),
    now: () => NOW,
  });
  const result = await ipc.handlers.get(CHANNEL)({});
  assert.equal(result.available, false);
  assert.equal(result.error, 'usage_stats_unavailable');
  assert.equal(result.since, null);
  assert.equal(result.ranges['1d'].turns, 0);
  assert.equal(result.heatmap.length, 371);
  assert.deepEqual(logged, [{ level: 'WARN', event: 'usage.stats_failed', data: { reason: 'EBUSY' } }]);
  assert.equal(JSON.stringify(logged).includes('secret'), false);
});

test('an untrusted sender is refused through the supplied authorization', async () => {
  const ipc = createFakeIpcMain();
  let reads = 0;
  registerUsageStatsIpc(ipc, {
    usageHistory: { getRollupSnapshot() { reads += 1; return null; } },
    authorization: { authorize: () => false },
    now: () => NOW,
  });
  const result = await ipc.handlers.get(CHANNEL)({});
  assert.equal(result.ok, false);
  assert.equal(reads, 0);
});

test('teardown removes the handler and is idempotent', () => {
  const ipc = createFakeIpcMain();
  const teardown = registerUsageStatsIpc(ipc, { usageHistory: null });
  assert.equal(ipc.handlers.has(CHANNEL), true);
  teardown();
  assert.equal(ipc.handlers.has(CHANNEL), false);
  assert.doesNotThrow(() => teardown());
});

'use strict';

// UsageHistoryService <-> durable daily rollup hook (row 98): recording feeds
// the rollup, upserts apply only the difference, chat deletes leave it (owner
// O1), Clear usage wipes it. Rollup internals live in usage-rollup.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { UsageHistoryService } = require('../services/usage-history-service');

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-usage-rollup-hook-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function usage(overrides = {}) {
  return {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    provider: 'ollama',
    model: 'qwen',
    cost_source: 'local_zero',
    cost_usd: 0,
    ...overrides,
  };
}

function rollupTotals(snapshot) {
  let turns = 0;
  let tokens = 0;
  for (const day of Object.values(snapshot.days)) {
    turns += day.turns;
    tokens += day.total_tokens;
  }
  return { turns, tokens };
}

test('recording updates the durable daily rollup and an upsert is not double counted', () => {
  let nowMs = Date.parse('2026-08-17T12:00:00.000Z');
  const service = new UsageHistoryService({ now: () => nowMs });
  service.recordTurnUsage('session-a', usage({ total_tokens: 15 }), { streamId: 'turn-a' });
  assert.deepEqual(rollupTotals(service.getRollupSnapshot()), { turns: 1, tokens: 15 });
  nowMs += 1000;
  service.recordTurnUsage('session-a', usage({ input_tokens: 30, output_tokens: 10, total_tokens: 40 }), {
    streamId: 'turn-a',
  });
  assert.deepEqual(rollupTotals(service.getRollupSnapshot()), { turns: 1, tokens: 40 }, 'same record id: difference only');
  service.recordTurnUsage('session-b', usage({ input_tokens: 4, output_tokens: 3, total_tokens: 7 }), { streamId: 'turn-b' });
  assert.deepEqual(rollupTotals(service.getRollupSnapshot()), { turns: 2, tokens: 47 });
  assert.equal(service.getRollupSnapshot().first_recorded_at, '2026-08-17T12:00:00.000Z');
});

test('retention pruning does not subtract from the rollup and chat resets leave it untouched', () => {
  let nowMs = Date.parse('2026-08-17T12:00:00.000Z');
  const service = new UsageHistoryService({ now: () => nowMs, maxTurns: 1 });
  service.recordTurnUsage('session-a', usage({ total_tokens: 15 }), { streamId: 'turn-a' });
  nowMs += 1000;
  service.recordTurnUsage('session-a', usage({ total_tokens: 20 }), { streamId: 'turn-b' });
  assert.equal(service.getSnapshot().cumulative.turn_count, 1, 'history keeps one turn');
  assert.deepEqual(rollupTotals(service.getRollupSnapshot()), { turns: 2, tokens: 35 }, 'rollup keeps both');
  assert.equal(service.resetSession('session-a').ok, true);
  assert.equal(service.getSnapshot().cumulative.turn_count, 0);
  assert.deepEqual(rollupTotals(service.getRollupSnapshot()), { turns: 2, tokens: 35 }, 'lifetime survives chat deletes');
});

test('clearHistory also clears the rollup', () => {
  const service = new UsageHistoryService({});
  service.recordTurnUsage('session-a', usage(), { streamId: 'turn-a' });
  assert.equal(rollupTotals(service.getRollupSnapshot()).turns, 1);
  assert.deepEqual(service.clearHistory(), { ok: true, cleared_turn_count: 1, durable: false });
  assert.deepEqual(service.getRollupSnapshot().days, {});
  assert.equal(service.getRollupSnapshot().first_recorded_at, '');
});

test('the rollup persists across restarts and seeds from retained rows on first run only', () => {
  withTempDir((userDataPath) => {
    const nowMs = Date.parse('2026-08-17T12:00:00.000Z');
    const first = new UsageHistoryService({ userDataPath, now: () => nowMs });
    first.recordTurnUsage('session-a', usage({ total_tokens: 15 }), { streamId: 'turn-a' });
    assert.ok(fs.existsSync(path.join(userDataPath, 'usage-rollup.json')));
    // Simulate the upgrade: keep the history file, delete the rollup, restart.
    fs.rmSync(path.join(userDataPath, 'usage-rollup.json'));
    const upgraded = new UsageHistoryService({ userDataPath, now: () => nowMs });
    assert.deepEqual(rollupTotals(upgraded.getRollupSnapshot()), { turns: 1, tokens: 15 }, 'seeded from retained rows');
    // Drop the history rows but keep the rollup: the rollup is not re-seeded or reduced.
    upgraded.clearHistory();
    fs.writeFileSync(
      path.join(userDataPath, 'usage-rollup.json'),
      JSON.stringify({ schema_version: 1, days: { '2026-08-17': { turns: 5, total_tokens: 50 } } }),
    );
    const restarted = new UsageHistoryService({ userDataPath, now: () => nowMs });
    assert.deepEqual(rollupTotals(restarted.getRollupSnapshot()), { turns: 5, tokens: 50 });
  });
});

test('a throwing rollup store never fails or alters the turn record', () => {
  const warnings = [];
  const service = new UsageHistoryService({
    logger: (level, event) => warnings.push(`${level}:${event}`),
    rollupStore: {
      load: () => {},
      apply: () => {
        throw Object.assign(new Error('boom'), { code: 'EACCES' });
      },
      clear: () => {},
      snapshot: () => ({}),
    },
  });
  assert.deepEqual(
    service.recordTurnUsage('session-a', usage(), { streamId: 'turn-a' }),
    { recorded: true, durable: false },
  );
  assert.equal(service.getSnapshot().cumulative.turn_count, 1);
  assert.deepEqual(warnings, ['WARN:usage_history.rollup_apply_failed']);
});

test('a throwing rollup load is warned and does not break construction', () => {
  const warnings = [];
  const service = new UsageHistoryService({
    logger: (level, event) => warnings.push(`${level}:${event}`),
    rollupStore: {
      load: () => {
        throw new Error('boom');
      },
      apply: () => {},
      clear: () => {},
      snapshot: () => ({}),
    },
  });
  assert.deepEqual(warnings, ['WARN:usage_history.rollup_load_failed']);
  assert.equal(service.recordTurnUsage('session-a', usage(), { streamId: 'turn-a' }).recorded, true);
});

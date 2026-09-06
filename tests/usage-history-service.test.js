'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  UsageHistoryService,
  buildSpeed,
  buildTotals,
  normalizeTurnRow,
  pruneRows,
} = require('../services/usage-history-service');

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-usage-history-'));
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

test('usage history creates schema v2, discards undated legacy aggregates, and restarts', () => {
  withTempDir((userDataPath) => {
    fs.writeFileSync(path.join(userDataPath, 'cost-tracker.json'), JSON.stringify({ total_cost_usd: 9 }));
    const nowMs = Date.parse('2026-08-17T12:00:00.000Z');
    const service = new UsageHistoryService({ userDataPath, now: () => nowMs });
    assert.equal(fs.existsSync(path.join(userDataPath, 'cost-tracker.json')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataPath, 'usage-history.json'), 'utf8')), {
      schema_version: 2,
      updated_at: '2026-08-17T12:00:00.000Z',
      turns: [],
    });
    service.recordTurnUsage('session-a', usage(), {
      streamId: 'stream-a',
      requestId: 'request-a',
      durationMs: 250,
      terminalType: 'complete',
    });
    const restarted = new UsageHistoryService({ userDataPath, now: () => nowMs });
    const snapshot = restarted.getSnapshot({ sessionId: 'session-a' });
    assert.equal(snapshot.session.total_tokens, 15);
    assert.equal(snapshot.cumulative.turn_count, 1);
    assert.equal(snapshot.cumulative.cost_coverage.local_zero_turns, 1);
    assert.equal(snapshot.recent_turns[0].cost_usd, 0);
  });
});

test('usage history isolates malformed rows, clamps values, and rejects unstable identity', () => {
  withTempDir((userDataPath) => {
    fs.writeFileSync(path.join(userDataPath, 'usage-history.json'), JSON.stringify({
      schema_version: 1,
      turns: [
        null,
        { recorded_at: 'not-a-date', stream_id: 'bad' },
        { recorded_at: '2026-08-17T10:00:00.000Z', record_id: 'forged' },
        {
          recorded_at: '2026-08-17T10:00:00.000Z',
          stream_id: 'stable',
          session_id: 'session-a',
          input_tokens: 1e20,
          output_tokens: -5,
          duration_ms: 1e20,
          provider: 'cloud',
          cost_source: 'provider',
          cost_usd: 'invalid',
        },
      ],
    }));
    const service = new UsageHistoryService({
      userDataPath,
      now: () => Date.parse('2026-08-17T12:00:00.000Z'),
    });
    const row = service.getSnapshot().recent_turns[0];
    assert.equal(row.input_tokens, 1_000_000_000);
    assert.equal(row.output_tokens, 0);
    assert.equal(row.duration_ms, 7 * 24 * 60 * 60 * 1000);
    assert.equal(row.cost_source, 'unavailable');
    assert.equal(row.cost_usd, null);
    assert.deepEqual(service.recordTurnUsage('session-a', usage(), {}), {
      recorded: false,
      reason: 'missing_stable_identity',
    });
  });
});

test('known local providers override conflicting provider-cost claims', () => {
  const row = normalizeTurnRow({
    recorded_at: '2026-08-17T10:00:00.000Z',
    stream_id: 'local-cost-conflict',
    provider: 'ollama',
    cost_source: 'provider',
    cost_usd: 99,
  });

  assert.equal(row.cost_source, 'local_zero');
  assert.equal(row.cost_usd, 0);
});

test('provider cost requires an explicit finite numeric value', () => {
  for (const costUsd of [null, '', false, '0']) {
    const row = normalizeTurnRow({
      recorded_at: '2026-08-17T10:00:00.000Z',
      stream_id: `provider-${String(costUsd)}`,
      provider: 'cloud',
      cost_source: 'provider',
      cost_usd: costUsd,
    });
    assert.equal(row.cost_source, 'unavailable');
    assert.equal(row.cost_usd, null);
  }

  const explicitZero = normalizeTurnRow({
    recorded_at: '2026-08-17T10:00:00.000Z',
    stream_id: 'provider-explicit-zero',
    provider: 'cloud',
    cost_source: 'provider',
    cost_usd: 0,
  });
  assert.equal(explicitZero.cost_source, 'provider');
  assert.equal(explicitZero.cost_usd, 0);
});

test('model totals retain reserved names without mutating object prototypes', () => {
  const totals = buildTotals([
    normalizeTurnRow({
      recorded_at: '2026-08-17T10:00:00.000Z',
      stream_id: 'reserved-proto',
      model: '__proto__',
    }),
    normalizeTurnRow({
      recorded_at: '2026-08-17T10:01:00.000Z',
      stream_id: 'reserved-constructor',
      model: 'constructor',
    }),
  ]);

  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'turn_count'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(totals.models, '__proto__'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(totals.models, 'constructor'), true);
  assert.equal(totals.models.__proto__.turn_count, 1);
  assert.equal(totals.models.constructor.turn_count, 1);
});

test('retention includes the exact 30-day cutoff and deterministically keeps newest 500', () => {
  const nowMs = Date.parse('2026-08-17T12:00:00.000Z');
  const cutoff = nowMs - (30 * 24 * 60 * 60 * 1000);
  const cutoffRows = pruneRows([
    normalizeTurnRow({ stream_id: 'at-cutoff', recorded_at: new Date(cutoff).toISOString() }),
    normalizeTurnRow({ stream_id: 'expired', recorded_at: new Date(cutoff - 1).toISOString() }),
  ].filter(Boolean), {
    nowMs,
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
    maxTurns: 500,
  });
  assert.deepEqual(cutoffRows.map((row) => row.stream_id), ['at-cutoff']);

  const rows = [];
  for (let index = 0; index < 505; index += 1) {
    rows.push(normalizeTurnRow({
      stream_id: `stream-${String(index).padStart(3, '0')}`,
      recorded_at: new Date(cutoff + index).toISOString(),
      provider: 'mock',
    }));
  }
  rows.push(normalizeTurnRow({ stream_id: 'expired', recorded_at: new Date(cutoff - 1).toISOString() }));
  const retained = pruneRows(rows.filter(Boolean), {
    nowMs,
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
    maxTurns: 500,
  });
  assert.equal(retained.length, 500);
  assert.equal(retained[0].stream_id, 'stream-005');
  assert.equal(retained.at(-1).stream_id, 'stream-504');
  assert.equal(retained.some((row) => row.stream_id === 'expired'), false);
});

test('live snapshots enforce the moving cutoff without writing until the next mutation', () => {
  const writes = [];
  const store = {
    readWithStatus: () => ({ missing: true, corrupted: false, value: null }),
    writeImmediate: (value) => writes.push(JSON.parse(JSON.stringify(value))),
  };
  let nowMs = Date.parse('2026-08-17T12:00:00.000Z');
  const service = new UsageHistoryService({ store, now: () => nowMs });
  service.recordTurnUsage('session-a', usage(), { streamId: 'aging-turn' });

  nowMs += 30 * 24 * 60 * 60 * 1000;
  assert.equal(service.getSnapshot().cumulative.turn_count, 1, 'the exact cutoff remains retained');

  nowMs += 1;
  const expiredSnapshot = service.getSnapshot({ sessionId: 'session-a' });
  assert.equal(expiredSnapshot.retention.retained_turns, 0);
  assert.equal(expiredSnapshot.session.turn_count, 0);
  assert.equal(expiredSnapshot.cumulative.turn_count, 0);
  assert.deepEqual(expiredSnapshot.recent_turns, []);
  assert.equal(writes.at(-1).turns.length, 1, 'read paths do not persist retention pruning');
  nowMs += 1000;
  service.recordTurnUsage('session-b', usage(), { streamId: 'new-turn' });
  assert.deepEqual(writes.at(-1).turns.map((row) => row.stream_id), ['new-turn']);
});

test('live retention reads never call a failing store writer', () => {
  let nowMs = Date.parse('2026-08-17T12:00:00.000Z');
  let writes = 0;
  const service = new UsageHistoryService({
    store: {
      readWithStatus: () => ({ missing: true, corrupted: false, value: null }),
      writeImmediate: () => {
        writes += 1;
      },
    },
    now: () => nowMs,
  });
  service.recordTurnUsage('session-a', usage(), { streamId: 'aging-turn' });
  nowMs += (30 * 24 * 60 * 60 * 1000) + 1;

  const snapshot = service.getSnapshot();
  assert.equal(snapshot.cumulative.turn_count, 0);
  assert.equal(snapshot.last_record_error, null);
  assert.equal(writes, 2, 'only initialization and record mutate the store');
});

test('stream identity deduplicates retries and session deletion removes retained rows', () => {
  const writes = [];
  const store = {
    readWithStatus: () => ({ missing: true, corrupted: false, value: null }),
    writeImmediate: (value) => writes.push(JSON.parse(JSON.stringify(value))),
  };
  let nowMs = Date.parse('2026-08-17T12:00:00.000Z');
  const service = new UsageHistoryService({ store, now: () => nowMs });
  service.recordTurnUsage('session-a', usage({ total_tokens: 10 }), { streamId: 'retry' });
  nowMs += 1000;
  service.recordTurnUsage('session-b', usage({ total_tokens: 20 }), { streamId: 'retry' });
  assert.equal(service.getSnapshot().cumulative.turn_count, 1);
  assert.equal(service.getSnapshot().cumulative.total_tokens, 20);
  assert.equal(service.getSnapshot().recent_turns[0].session_id, 'session-b');
  assert.deepEqual(service.resetSession('session-b'), { ok: true, cleared_turn_count: 1, durable: true });
  assert.equal(service.getSnapshot().cumulative.turn_count, 0);
  assert.ok(writes.length >= 4);
});

test('future schema is unavailable and read-only without overwrite', () => {
  let writes = 0;
  const store = {
    readWithStatus: () => ({ missing: false, corrupted: false, value: { schema_version: 3, turns: [] } }),
    writeImmediate: () => { writes += 1; },
  };
  const service = new UsageHistoryService({ store });
  assert.equal(service.getSnapshot().available, false);
  assert.equal(service.getSnapshot().persistence.read_only_reason, 'future_schema');
  assert.equal(service.clearHistory().ok, false);
  assert.equal(writes, 0);
});

test('schema v1 rows migrate to v2 defaults without changing retained token values', () => {
  const writes = [];
  const service = new UsageHistoryService({
    store: {
      readWithStatus: () => ({
        missing: false,
        corrupted: false,
        value: {
          schema_version: 1,
          turns: [{
            recorded_at: '2026-08-17T10:00:00.000Z',
            stream_id: 'legacy-v1',
            input_tokens: 8,
            output_tokens: 3,
            total_tokens: 11,
            terminal_type: 'error',
          }],
        },
      }),
      writeImmediate: (value) => writes.push(value),
    },
    now: () => Date.parse('2026-08-17T12:00:00.000Z'),
  });
  const row = service.getSnapshot().recent_turns[0];
  assert.equal(row.total_tokens, 11);
  assert.equal(row.generation_tokens, 0);
  assert.equal(row.generation_duration_ms, 0);
  assert.equal(row.ttft_ms, 0);
  assert.equal(row.outcome, 'complete');
  assert.equal(row.outcome_detail, '');
  assert.equal(row.estimated, false);
  assert.equal(writes.at(-1).schema_version, 2);
});

test('canonical outcomes, bounded details, speed samples, and per-model aggregates are normalized', () => {
  const rows = [
    normalizeTurnRow({
      recorded_at: '2026-08-17T10:00:00.000Z', stream_id: 'one', model: 'qwen',
      generation_tokens: 10, generation_duration_ms: 1000, ttft_ms: 500,
      outcome: 'canceled', outcome_detail: 'user_cancel', estimated: true,
    }),
    normalizeTurnRow({
      recorded_at: '2026-08-17T10:01:00.000Z', stream_id: 'two', model: 'qwen',
      generation_tokens: 40, generation_duration_ms: 2000, ttft_ms: 100,
      outcome: 'error', outcome_detail: 'provider message must not persist',
    }),
    normalizeTurnRow({
      recorded_at: '2026-08-17T10:02:00.000Z', stream_id: 'three', model: 'other',
      generation_tokens: 100, generation_duration_ms: 0, ttft_ms: 10,
      outcome: 'not-real',
    }),
  ];
  assert.deepEqual(rows.map((row) => row.outcome), ['cancelled', 'error', 'complete']);
  assert.deepEqual(rows.map((row) => row.outcome_detail), ['user_cancel', '', '']);
  assert.deepEqual(buildSpeed(rows), {
    measured_turns: 2,
    tokens_per_second: { median: 10, p10: 10, p90: 20 },
    ttft_ms: { measured_turns: 2, median: 100 },
  });
  const totals = buildTotals(rows);
  assert.equal(totals.generation_tokens, 150);
  assert.equal(totals.generation_duration_ms, 3000);
  assert.equal(totals.estimated_turns, 1);
  assert.equal(totals.outcomes.cancelled, 1);
  assert.equal(totals.models.qwen.speed.measured_turns, 2);
});

test('export scopes are newest-first, capped independently, and do not write', () => {
  const writes = [];
  let nowMs = Date.parse('2026-08-17T12:00:00.000Z');
  const service = new UsageHistoryService({
    store: {
      readWithStatus: () => ({ missing: true, corrupted: false, value: null }),
      writeImmediate: (value) => writes.push(value),
    },
    now: () => nowMs,
  });
  service.recordTurnUsage('session-a', usage(), { streamId: 'a' });
  nowMs += 1000;
  service.recordTurnUsage('session-b', usage(), { streamId: 'b' });
  const writesBeforeReads = writes.length;
  assert.deepEqual(
    service.getExportRows({ scope: 'session', sessionId: 'session-a' }).rows.map((row) => row.stream_id),
    ['a']
  );
  assert.deepEqual(service.getExportRows({ scope: 'all' }).rows.map((row) => row.stream_id), ['b', 'a']);
  assert.equal(service.getExportRows({ scope: 'invalid' }).ok, false);
  assert.equal(writes.length, writesBeforeReads);
});

test('resetSession is non-throwing and preserves rows when persistence fails', () => {
  let fail = false;
  const service = new UsageHistoryService({
    store: {
      readWithStatus: () => ({ missing: true, corrupted: false, value: null }),
      writeImmediate: () => {
        if (fail) { const error = new Error('private'); error.code = 'EIO'; throw error; }
      },
    },
  });
  service.recordTurnUsage('session-a', usage(), { streamId: 'reset-fail' });
  fail = true;
  assert.deepEqual(service.resetSession('session-a'), {
    ok: false,
    cleared_turn_count: 0,
    durable: false,
    error: 'Usage history could not be reset (EIO).',
  });
  assert.equal(service.getSnapshot().cumulative.turn_count, 1);
});

test('corrupt store is unavailable and never overwritten', () => {
  let writes = 0;
  const service = new UsageHistoryService({
    store: {
      readWithStatus: () => ({ missing: false, corrupted: true, value: null }),
      writeImmediate: () => { writes += 1; },
    },
  });
  assert.equal(service.getSnapshot().persistence.read_only_reason, 'corrupt_store');
  assert.throws(
    () => service.recordTurnUsage('session-a', usage(), { streamId: 'stream-a' }),
    /read-only/
  );
  assert.equal(writes, 0);
});

test('clear is write-before-swap and a write failure preserves rows and totals', () => {
  let fail = false;
  const store = {
    readWithStatus: () => ({ missing: true, corrupted: false, value: null }),
    writeImmediate: () => {
      if (fail) {
        const error = new Error('sensitive local path');
        error.code = 'EACCES';
        throw error;
      }
    },
  };
  const service = new UsageHistoryService({ store });
  service.recordTurnUsage('session-a', usage(), { requestId: 'request-a' });
  fail = true;
  const failed = service.clearHistory();
  assert.deepEqual(failed, {
    ok: false,
    cleared_turn_count: 0,
    durable: false,
    error: 'Usage history could not be cleared (EACCES).',
  });
  assert.equal(service.getSnapshot().cumulative.turn_count, 1);
  assert.equal(service.getSnapshot().cumulative.total_tokens, 15);
  fail = false;
  assert.deepEqual(service.clearHistory(), { ok: true, cleared_turn_count: 1, durable: true });
  assert.equal(service.getSnapshot().cumulative.turn_count, 0);
});

test('record write failure preserves prior rows and totals', () => {
  let fail = false;
  const service = new UsageHistoryService({
    store: {
      readWithStatus: () => ({ missing: true, corrupted: false, value: null }),
      writeImmediate: () => {
        if (fail) {
          const error = new Error('private details');
          error.code = 'EIO';
          throw error;
        }
      },
    },
  });
  service.recordTurnUsage('session-a', usage(), { streamId: 'stream-a' });
  fail = true;
  assert.throws(
    () => service.recordTurnUsage('session-b', usage(), { streamId: 'stream-b' }),
    { code: 'EIO' }
  );
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.cumulative.turn_count, 1);
  assert.equal(snapshot.recent_turns[0].stream_id, 'stream-a');
});

test('legacy retirement failure is warned without making usage unavailable', () => {
  withTempDir((userDataPath) => {
    fs.writeFileSync(path.join(userDataPath, 'cost-tracker.json'), '{}');
    const events = [];
    const service = new UsageHistoryService({
      userDataPath,
      logger: (level, event, details) => events.push({ level, event, details }),
      fsImpl: { unlinkSync: () => { const error = new Error('blocked'); error.code = 'EPERM'; throw error; } },
    });
    assert.equal(service.getSnapshot().available, true);
    assert.equal(events.some((entry) => entry.event === 'usage_history.legacy_cost_retire_failed'), true);
    assert.equal(events.find((entry) => entry.event === 'usage_history.legacy_cost_retire_failed').details.errorCode, 'EPERM');
  });
});

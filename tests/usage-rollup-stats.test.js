'use strict';

// Coverage for services/usage-rollup-stats.js: the pure aggregation behind the
// Home "Usage" widget (row 98, slice S2). Every test passes a fixed local-time
// `now`; calendar math is by local date parts, so the expectations hold in any
// host timezone.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeUsageStats,
  defaultIsLocalProvider,
  HEATMAP_DAYS,
  RANGE_KEYS,
} = require('../services/usage-rollup-stats');

// Sunday 2026-11-01 15:30 local.
const NOW = new Date(2026, 10, 1, 15, 30);

function day(overrides = {}) {
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

function rollup(days = {}, extra = {}) {
  return {
    schema_version: 1,
    updated_at: '2026-11-01T20:00:00.000Z',
    first_recorded_at: '',
    days,
    archived: null,
    ...extra,
  };
}

function activeDay(turns = 1, total = 10, extra = {}) {
  return day({ turns, total_tokens: total, ...extra });
}

test('exports the six range keys in display order and a 371-day heatmap window', () => {
  assert.deepEqual(RANGE_KEYS, ['1d', '7d', '30d', '6mo', '1y', 'all']);
  assert.equal(HEATMAP_DAYS, 371);
});

test('each range has the right from/to and sums, and archived merges into all only', () => {
  const stats = computeUsageStats(rollup({
    '2026-11-01': day({ turns: 2, input_tokens: 60, output_tokens: 40, total_tokens: 100 }),
    '2026-10-31': day({ turns: 1, total_tokens: 50 }),
    '2026-10-26': day({ turns: 3, total_tokens: 300 }),
    '2026-10-25': day({ turns: 4, total_tokens: 400 }),
    '2026-10-02': day({ turns: 5, total_tokens: 500 }),
    '2026-05-03': day({ turns: 6, total_tokens: 600 }),
    '2025-11-02': day({ turns: 9, total_tokens: 900 }),
    '2025-11-01': day({ turns: 7, total_tokens: 700 }),
  }, {
    first_recorded_at: new Date(2025, 10, 1, 9).toISOString(),
    archived: {
      from: '2020-01-01', to: '2020-12-31', ...day({ turns: 8, total_tokens: 800 }),
    },
  }), { now: NOW });

  const expected = {
    '1d': ['2026-11-01', 2, 100],
    '7d': ['2026-10-26', 6, 450],
    '30d': ['2026-10-03', 10, 850],
    '6mo': ['2026-05-04', 15, 1350],
    '1y': ['2025-11-02', 30, 2850],
    all: ['2025-11-01', 45, 4350],
  };
  for (const [key, [from, turns, total]] of Object.entries(expected)) {
    const range = stats.ranges[key];
    assert.equal(range.from, from, `${key} from`);
    assert.equal(range.to, '2026-11-01', `${key} to`);
    assert.equal(range.turns, turns, `${key} turns`);
    assert.equal(range.total_tokens, total, `${key} total_tokens`);
  }
  assert.deepEqual(Object.keys(stats.ranges), RANGE_KEYS);
  assert.equal(stats.ranges['1d'].input_tokens, 60);
  assert.equal(stats.ranges['1d'].output_tokens, 40);
  assert.equal(stats.since, '2025-11-01');
});

test('1d is today only, and an idle today reads as zero', () => {
  const stats = computeUsageStats(rollup({
    '2026-10-31': activeDay(5, 500),
  }), { now: NOW });
  assert.equal(stats.ranges['1d'].turns, 0);
  assert.equal(stats.ranges['1d'].total_tokens, 0);
  assert.equal(stats.ranges['1d'].active_days, 0);
  assert.equal(stats.ranges['7d'].turns, 5);
});

test('since falls back to the earliest day or archived.from, else null', () => {
  assert.equal(computeUsageStats(rollup({ '2026-10-31': activeDay() }), { now: NOW }).since, '2026-10-31');
  const withArchive = computeUsageStats(rollup(
    { '2026-10-31': activeDay() },
    { archived: { from: '2019-06-01', to: '2019-06-30', ...day({ turns: 1 }) } }
  ), { now: NOW });
  assert.equal(withArchive.since, '2019-06-01');
  const empty = computeUsageStats(rollup(), { now: NOW });
  assert.equal(empty.since, null);
  assert.equal(empty.ranges.all.from, '2026-11-01');
  assert.equal(empty.ranges.all.to, '2026-11-01');
});

test('favorite model: most turns, then tokens, then name; (other) never wins and is not listed', () => {
  const byTurns = computeUsageStats(rollup({
    '2026-11-01': activeDay(10, 100, {
      models: {
        a: { provider: 'ollama', turns: 2, total_tokens: 900 },
        b: { provider: 'chatgpt', turns: 4, total_tokens: 10 },
        '(other)': { provider: '', turns: 4, total_tokens: 90 },
      },
    }),
  }), { now: NOW });
  const range = byTurns.ranges['1d'];
  assert.deepEqual(range.favorite_model, {
    model: 'b', provider: 'chatgpt', turns: 4, share: 0.4,
  });
  assert.deepEqual(range.top_models.map((m) => m.model), ['b', 'a']);
  assert.deepEqual(range.top_models[1], {
    model: 'a', provider: 'ollama', turns: 2, total_tokens: 900, share: 0.2,
  });

  const tieTokens = computeUsageStats(rollup({
    '2026-11-01': activeDay(6, 60, {
      models: {
        a: { provider: 'ollama', turns: 3, total_tokens: 10 },
        b: { provider: 'ollama', turns: 3, total_tokens: 20 },
      },
    }),
  }), { now: NOW });
  assert.equal(tieTokens.ranges['1d'].favorite_model.model, 'b');

  const tieName = computeUsageStats(rollup({
    '2026-11-01': activeDay(6, 60, {
      models: {
        zed: { provider: 'ollama', turns: 3, total_tokens: 20 },
        alpha: { provider: 'ollama', turns: 3, total_tokens: 20 },
      },
    }),
  }), { now: NOW });
  assert.equal(tieName.ranges['1d'].favorite_model.model, 'alpha');

  const onlyOther = computeUsageStats(rollup({
    '2026-11-01': activeDay(3, 30, { models: { '(other)': { provider: '', turns: 3, total_tokens: 30 } } }),
  }), { now: NOW });
  assert.equal(onlyOther.ranges['1d'].favorite_model, null);
  assert.deepEqual(onlyOther.ranges['1d'].top_models, []);
});

test('model buckets merge across days; top_models caps at five', () => {
  const models = {};
  for (let i = 0; i < 8; i += 1) {
    models[`m${i}`] = { provider: 'ollama', turns: 10 - i, total_tokens: 5 };
  }
  const stats = computeUsageStats(rollup({
    '2026-11-01': activeDay(52, 100, { models }),
  }), { now: NOW });
  const top = stats.ranges['7d'].top_models;
  assert.equal(top.length, 5);
  assert.deepEqual(top.map((m) => m.model), ['m0', 'm1', 'm2', 'm3', 'm4']);
  const wide = computeUsageStats(rollup({
    '2026-11-01': activeDay(5, 5, { models: { x: { provider: 'ollama', turns: 2, total_tokens: 4 } } }),
    '2026-10-31': activeDay(5, 5, { models: { x: { provider: 'ollama', turns: 3, total_tokens: 6 } } }),
  }), { now: NOW });
  assert.deepEqual(wide.ranges['7d'].favorite_model, {
    model: 'x', provider: 'ollama', turns: 5, share: 0.5,
  });
  assert.equal(wide.ranges['7d'].top_models[0].total_tokens, 10);
});

test('local_share uses the predicate on the recorded provider, and is null with no turns', () => {
  const stats = computeUsageStats(rollup({
    '2026-11-01': activeDay(4, 40, {
      models: {
        a: { provider: 'ollama', turns: 1, total_tokens: 1 },
        b: { provider: 'chatgpt', turns: 2, total_tokens: 1 },
        '(other)': { provider: 'ollama', turns: 1, total_tokens: 1 },
      },
    }),
  }), { now: NOW, isLocalProvider: (provider) => provider === 'ollama' });
  assert.equal(stats.ranges['1d'].local_share, 0.5);
  assert.equal(stats.ranges['7d'].local_share, 0.5);
  assert.equal(stats.ranges['1d'].favorite_model.model, 'b');

  const none = computeUsageStats(rollup(), { now: NOW, isLocalProvider: () => true });
  assert.equal(none.ranges['1d'].local_share, null);
  assert.equal(none.ranges.all.local_share, null);
});

test('default local predicate matches the recorded local engine types', () => {
  for (const provider of ['ollama', 'vllm', 'openai-compatible', 'replay', 'mock']) {
    assert.equal(defaultIsLocalProvider(provider), true, provider);
  }
  assert.equal(defaultIsLocalProvider('OLLAMA'), true);
  for (const provider of ['chatgpt', 'codex-cli', 'api-provider', '', null, undefined]) {
    assert.equal(defaultIsLocalProvider(provider), false, String(provider));
  }
  const stats = computeUsageStats(rollup({
    '2026-11-01': activeDay(2, 2, {
      models: {
        a: { provider: 'vllm', turns: 1, total_tokens: 1 },
        b: { provider: 'chatgpt', turns: 1, total_tokens: 1 },
      },
    }),
  }), { now: NOW });
  assert.equal(stats.ranges['1d'].local_share, 0.5);
});

test('streak.current counts back from today, or from yesterday when today is idle', () => {
  const todayActive = computeUsageStats(rollup({
    '2026-11-01': activeDay(),
    '2026-10-31': activeDay(),
    '2026-10-30': activeDay(),
    '2026-10-28': activeDay(),
  }), { now: NOW });
  assert.equal(todayActive.streak.current, 3);

  const todayIdle = computeUsageStats(rollup({
    '2026-11-01': day(),
    '2026-10-31': activeDay(),
    '2026-10-30': activeDay(),
  }), { now: NOW });
  assert.equal(todayIdle.streak.current, 2);

  const broken = computeUsageStats(rollup({
    '2026-10-29': activeDay(),
    '2026-10-28': activeDay(),
  }), { now: NOW });
  assert.equal(broken.streak.current, 0);
  assert.equal(broken.streak.longest, 2);
});

test('streak.longest scans every daily bucket, across month boundaries', () => {
  const stats = computeUsageStats(rollup({
    '2026-09-29': activeDay(),
    '2026-09-30': activeDay(),
    '2026-10-01': activeDay(),
    '2026-10-02': activeDay(),
    '2026-10-04': activeDay(),
    '2026-11-01': activeDay(),
  }), { now: NOW });
  assert.equal(stats.streak.longest, 4);
  assert.equal(stats.streak.current, 1);
});

test('peak_hour is the busiest hour, earliest on ties, null with no turns', () => {
  const hours = new Array(24).fill(0);
  hours[21] = 3;
  hours[9] = 3;
  hours[14] = 1;
  const stats = computeUsageStats(rollup({
    '2026-11-01': activeDay(7, 70, { hours }),
  }), { now: NOW });
  assert.equal(stats.ranges['1d'].peak_hour, 9);

  const merged = new Array(24).fill(0);
  merged[21] = 5;
  const sum = computeUsageStats(rollup({
    '2026-11-01': activeDay(7, 70, { hours }),
    '2026-10-31': activeDay(5, 50, { hours: merged }),
  }), { now: NOW });
  assert.equal(sum.ranges['7d'].peak_hour, 21);
  assert.equal(computeUsageStats(rollup(), { now: NOW }).ranges['1d'].peak_hour, null);
});

test('busiest_day is the max-token day, the most recent on ties, null when none', () => {
  const stats = computeUsageStats(rollup({
    '2026-10-30': activeDay(2, 500),
    '2026-10-31': activeDay(3, 500),
    '2026-10-29': activeDay(9, 100),
  }), { now: NOW });
  assert.deepEqual(stats.ranges['7d'].busiest_day, {
    date: '2026-10-31', total_tokens: 500, turns: 3,
  });
  assert.equal(stats.ranges['1d'].busiest_day, null);
  assert.equal(stats.ranges['7d'].active_days, 3);
});

test('avg_tokens_per_second and estimated_share', () => {
  const stats = computeUsageStats(rollup({
    '2026-11-01': activeDay(4, 40, {
      generation_tokens: 100, generation_duration_ms: 3000, estimated_turns: 1,
    }),
    '2026-10-31': activeDay(0, 0, { generation_tokens: 100, generation_duration_ms: 3000 }),
  }), { now: NOW });
  assert.equal(stats.ranges['1d'].avg_tokens_per_second, 33.3);
  assert.equal(stats.ranges['7d'].avg_tokens_per_second, 33.3);
  assert.equal(stats.ranges['1d'].estimated_share, 0.25);

  const noDuration = computeUsageStats(rollup({
    '2026-11-01': activeDay(2, 20, { generation_tokens: 50 }),
  }), { now: NOW });
  assert.equal(noDuration.ranges['1d'].avg_tokens_per_second, null);
  assert.equal(noDuration.ranges['1d'].estimated_share, 0);
  assert.equal(computeUsageStats(rollup(), { now: NOW }).ranges['1d'].estimated_share, null);
});

test('archived days feed all (totals, models, hours) but not busiest or streak', () => {
  const hours = new Array(24).fill(0);
  hours[3] = 8;
  const stats = computeUsageStats(rollup(
    { '2026-11-01': activeDay(1, 10, { models: { m: { provider: 'ollama', turns: 1, total_tokens: 10 } } }) },
    {
      archived: {
        from: '2020-01-01',
        to: '2020-12-31',
        ...day({
          turns: 8,
          total_tokens: 9000,
          hours,
          models: { m: { provider: 'ollama', turns: 8, total_tokens: 9000 } },
        }),
      },
    }
  ), { now: NOW });
  const all = stats.ranges.all;
  assert.equal(all.turns, 9);
  assert.equal(all.total_tokens, 9010);
  assert.equal(all.favorite_model.turns, 9);
  assert.equal(all.peak_hour, 3);
  assert.deepEqual(all.busiest_day, { date: '2026-11-01', total_tokens: 10, turns: 1 });
  assert.equal(all.active_days, 1);
  assert.equal(stats.streak.longest, 1);
  assert.equal(stats.ranges['1y'].turns, 1);
});

test('heatmap is 371 zero-filled days, oldest first, ending today', () => {
  const stats = computeUsageStats(rollup({
    '2026-11-01': day({ turns: 2, total_tokens: 100 }),
    '2025-10-27': day({ turns: 1, total_tokens: 7 }),
    '2025-10-26': day({ turns: 9, total_tokens: 9 }),
  }), { now: NOW });
  const { heatmap } = stats;
  assert.equal(heatmap.length, 371);
  assert.equal(heatmap[0].date, '2025-10-27');
  assert.deepEqual(heatmap[0], { date: '2025-10-27', total_tokens: 7, turns: 1 });
  assert.deepEqual(heatmap[370], { date: '2026-11-01', total_tokens: 100, turns: 2 });
  assert.deepEqual(heatmap[369], { date: '2026-10-31', total_tokens: 0, turns: 0 });
  assert.equal(heatmap.some((cell) => cell.date === '2025-10-26'), false);
});

test('range edges survive a DST fall-back crossing (2026-11-01 in US zones)', () => {
  const now = new Date(2026, 10, 2, 12);
  const days = {};
  for (const key of ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']) {
    days[key] = activeDay(1, 10);
  }
  days['2026-10-26'] = activeDay(1, 10);
  const stats = computeUsageStats(rollup(days), { now });
  assert.equal(stats.ranges['7d'].from, '2026-10-27');
  assert.equal(stats.ranges['7d'].to, '2026-11-02');
  assert.equal(stats.ranges['7d'].turns, 7);
  assert.equal(stats.ranges['7d'].active_days, 7);
  assert.equal(stats.streak.current, 8);
  const keys = stats.heatmap.map((cell) => cell.date);
  assert.equal(new Set(keys).size, 371);
  assert.equal(keys.filter((key) => key === '2026-11-01').length, 1);
  assert.equal(keys[370], '2026-11-02');
});

test('range edges survive a DST spring-forward crossing (2026-03-08 in US zones)', () => {
  const now = new Date(2026, 2, 10, 0, 30);
  const stats = computeUsageStats(rollup({
    '2026-03-07': activeDay(1, 1),
    '2026-03-08': activeDay(1, 1),
    '2026-03-09': activeDay(1, 1),
    '2026-03-10': activeDay(1, 1),
  }), { now });
  assert.equal(stats.ranges['7d'].from, '2026-03-04');
  assert.equal(stats.ranges['7d'].turns, 4);
  assert.equal(stats.streak.current, 4);
  assert.equal(new Set(stats.heatmap.map((cell) => cell.date)).size, 371);
});

test('garbage input never throws and reads as zero', () => {
  const inputs = [
    null,
    undefined,
    'rollup',
    42,
    [],
    {},
    { days: 5 },
    { days: [] },
    { days: { 'not-a-date': { turns: 4 }, '2026-13-45': { turns: 4 }, '2026-11-01': null } },
    {
      days: {
        '2026-11-01': {
          turns: -5,
          total_tokens: 'lots',
          input_tokens: Infinity,
          hours: 'x',
          models: { a: null, b: { turns: -2, total_tokens: NaN }, c: 7 },
        },
      },
      archived: 'x',
      first_recorded_at: 'yesterday-ish',
    },
    { days: { '2026-11-01': { hours: [1, -1, 'z'] } }, archived: { turns: -1, hours: null } },
  ];
  for (const input of inputs) {
    const stats = computeUsageStats(input, { now: NOW });
    assert.deepEqual(Object.keys(stats.ranges), RANGE_KEYS);
    assert.equal(stats.heatmap.length, 371);
    assert.equal(stats.ranges['1d'].turns, 0);
    assert.equal(stats.ranges['1d'].total_tokens, 0);
    assert.equal(stats.ranges.all.favorite_model, null);
  }
  // Invalid clock and predicate fall back to safe defaults.
  const stats = computeUsageStats(rollup(), { now: new Date('nope'), isLocalProvider: 'not-a-fn' });
  assert.equal(stats.heatmap.length, 371);
  assert.doesNotThrow(() => computeUsageStats());
});

test('the result is JSON-safe and does not mutate the input', () => {
  const input = rollup({
    '2026-11-01': activeDay(2, 100, { models: { m: { provider: 'ollama', turns: 2, total_tokens: 100 } } }),
  });
  const before = JSON.stringify(input);
  const stats = computeUsageStats(input, { now: NOW });
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), stats);
});

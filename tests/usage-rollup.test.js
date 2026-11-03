'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_MODELS_PER_DAY,
  MAX_ROLLUP_DAYS,
  USAGE_ROLLUP_FILE,
  USAGE_ROLLUP_SCHEMA_VERSION,
  applyRowDelta,
  createUsageRollupStore,
  emptyRollup,
  localDateKey,
  normalizeRollup,
  seedFromRows,
} = require('../services/usage-rollup');
const { KNOWN_USER_DATA_CHILDREN } = require('../services/data-lifecycle/cleanup-service');

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-usage-rollup-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Local wall-clock helpers keep the bucketing assertions timezone-independent.
function localIso(year, month, day, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

function dayKey(year, month, day) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

function row(overrides = {}) {
  return {
    record_id: 'stream:a',
    recorded_at: localIso(2026, 3, 10, 9),
    model: 'qwen',
    provider: 'ollama',
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    generation_tokens: 5,
    generation_duration_ms: 100,
    estimated: false,
    ...overrides,
  };
}

function sumDays(rollup) {
  const sum = { turns: 0, total_tokens: 0 };
  for (const day of Object.values(rollup.days)) {
    sum.turns += day.turns;
    sum.total_tokens += day.total_tokens;
  }
  if (rollup.archived) {
    sum.turns += rollup.archived.turns;
    sum.total_tokens += rollup.archived.total_tokens;
  }
  return sum;
}

test('constants and the empty rollup match the contract', () => {
  assert.equal(USAGE_ROLLUP_FILE, 'usage-rollup.json');
  assert.equal(USAGE_ROLLUP_SCHEMA_VERSION, 1);
  assert.equal(MAX_ROLLUP_DAYS, 1830);
  assert.equal(MAX_MODELS_PER_DAY, 12);
  const empty = emptyRollup();
  assert.equal(empty.schema_version, 1);
  assert.deepEqual(empty.days, {});
  assert.equal(empty.archived, null);
  assert.equal(empty.first_recorded_at, '');
  assert.ok(KNOWN_USER_DATA_CHILDREN.includes('usage-rollup.json'), 'Your data / uninstall know the file');
});

test('a new row adds one turn to its local day, hour and model', () => {
  const next = applyRowDelta(emptyRollup(), null, row({ estimated: true }));
  const key = dayKey(2026, 3, 10);
  const day = next.days[key];
  assert.equal(day.turns, 1);
  assert.equal(day.input_tokens, 10);
  assert.equal(day.output_tokens, 5);
  assert.equal(day.total_tokens, 15);
  assert.equal(day.generation_tokens, 5);
  assert.equal(day.generation_duration_ms, 100);
  assert.equal(day.estimated_turns, 1);
  assert.equal(day.hours.length, 24);
  assert.equal(day.hours[9], 1);
  assert.equal(day.hours.reduce((sum, value) => sum + value, 0), 1);
  assert.deepEqual(day.models, { qwen: { provider: 'ollama', turns: 1, total_tokens: 15 } });
  assert.equal(next.first_recorded_at, row().recorded_at);
});

test('applyRowDelta does not mutate its input rollup', () => {
  const base = applyRowDelta(emptyRollup(), null, row());
  const frozen = JSON.stringify(base);
  applyRowDelta(base, null, row({ record_id: 'stream:b' }));
  applyRowDelta(base, row(), null);
  assert.equal(JSON.stringify(base), frozen);
});

test('an upsert applies only the difference and counts the turn once', () => {
  const first = row({ total_tokens: 15, estimated: true });
  const second = row({
    input_tokens: 40,
    output_tokens: 20,
    total_tokens: 60,
    generation_tokens: 20,
    generation_duration_ms: 400,
    estimated: false,
  });
  let rollup = applyRowDelta(emptyRollup(), null, first);
  rollup = applyRowDelta(rollup, first, second);
  const day = rollup.days[dayKey(2026, 3, 10)];
  assert.equal(day.turns, 1);
  assert.equal(day.input_tokens, 40);
  assert.equal(day.total_tokens, 60);
  assert.equal(day.generation_duration_ms, 400);
  assert.equal(day.estimated_turns, 0);
  assert.equal(day.hours[9], 1);
  assert.deepEqual(day.models.qwen, { provider: 'ollama', turns: 1, total_tokens: 60 });
});

test('an upsert that crosses a local day moves the turn between buckets', () => {
  const first = row({ recorded_at: localIso(2026, 3, 10, 23) });
  const second = row({ recorded_at: localIso(2026, 3, 11, 1) });
  let rollup = applyRowDelta(emptyRollup(), null, first);
  rollup = applyRowDelta(rollup, first, second);
  assert.equal(rollup.days[dayKey(2026, 3, 10)], undefined, 'the emptied day is removed');
  assert.equal(rollup.days[dayKey(2026, 3, 11)].turns, 1);
  assert.equal(rollup.days[dayKey(2026, 3, 11)].hours[1], 1);
});

test('prev-only subtraction removes the contribution and drops the empty model and day', () => {
  const only = row();
  const other = row({ record_id: 'stream:b', model: 'llama', total_tokens: 7, input_tokens: 4, output_tokens: 3 });
  let rollup = applyRowDelta(emptyRollup(), null, only);
  rollup = applyRowDelta(rollup, null, other);
  rollup = applyRowDelta(rollup, only, null);
  const day = rollup.days[dayKey(2026, 3, 10)];
  assert.equal(day.turns, 1);
  assert.equal(day.models.qwen, undefined, 'a model at zero turns and tokens is removed');
  assert.equal(day.models.llama.turns, 1);
  rollup = applyRowDelta(rollup, other, null);
  assert.deepEqual(rollup.days, {});
});

test('counters never go negative', () => {
  const rollup = applyRowDelta(emptyRollup(), null, row({ total_tokens: 15 }));
  const heavy = row({ input_tokens: 500, output_tokens: 500, total_tokens: 1000, estimated: true });
  const next = applyRowDelta(rollup, heavy, null);
  assert.deepEqual(next.days, {}, 'over-subtraction clamps to zero and clears the day');
  const ghost = applyRowDelta(emptyRollup(), row(), null);
  assert.deepEqual(ghost.days, {});
  assert.equal(ghost.archived, null);
});

test('rows without a usable timestamp are skipped and hostile model names are safe', () => {
  const skipped = applyRowDelta(emptyRollup(), null, row({ recorded_at: 'not a date' }));
  assert.deepEqual(skipped.days, {});
  const hostile = applyRowDelta(emptyRollup(), null, row({ model: '__proto__', provider: 'x'.repeat(500) }));
  const day = hostile.days[dayKey(2026, 3, 10)];
  assert.equal(Object.keys(day.models).length, 1);
  assert.equal(Object.getPrototypeOf(day.models), Object.prototype, 'the model map keeps its prototype');
  assert.equal(Object.keys(day.models)[0], '__proto__');
  assert.equal(day.models.__proto__.turns, 1);
  assert.equal(Object.values(day.models)[0].provider.length, 160);
  const blank = applyRowDelta(emptyRollup(), null, row({ model: '   ' }));
  assert.deepEqual(Object.keys(blank.days[dayKey(2026, 3, 10)].models), ['unknown']);
  const longName = applyRowDelta(emptyRollup(), null, row({ model: 'm'.repeat(400) }));
  assert.equal(Object.keys(longName.days[dayKey(2026, 3, 10)].models)[0].length, 160);
});

test('local date and hour bucketing follow the process timezone', () => {
  assert.equal(localDateKey(new Date(2026, 0, 2, 0, 5)), '2026-01-02');
  assert.equal(localDateKey(localIso(2026, 12, 31, 23, 59)), '2026-12-31');
  assert.equal(localDateKey('garbage'), '');
  assert.equal(localDateKey(undefined), '');
  let rollup = emptyRollup();
  rollup = applyRowDelta(rollup, null, row({ record_id: 'a', recorded_at: localIso(2026, 5, 1, 0, 10) }));
  rollup = applyRowDelta(rollup, null, row({ record_id: 'b', recorded_at: localIso(2026, 5, 1, 23, 50) }));
  assert.deepEqual(Object.keys(rollup.days), [dayKey(2026, 5, 1)]);
  const hours = rollup.days[dayKey(2026, 5, 1)].hours;
  assert.equal(hours[0], 1);
  assert.equal(hours[23], 1);
});

test('first_recorded_at keeps the earliest row seen', () => {
  let rollup = applyRowDelta(emptyRollup(), null, row({ recorded_at: localIso(2026, 3, 10, 9) }));
  rollup = applyRowDelta(rollup, null, row({ record_id: 'b', recorded_at: localIso(2026, 3, 12, 9) }));
  assert.equal(rollup.first_recorded_at, localIso(2026, 3, 10, 9));
  rollup = applyRowDelta(rollup, null, row({ record_id: 'c', recorded_at: localIso(2026, 3, 1, 9) }));
  assert.equal(rollup.first_recorded_at, localIso(2026, 3, 1, 9));
});

test('days past the cap merge into archived with exact totals and widened bounds', () => {
  let rollup = emptyRollup();
  const total = MAX_ROLLUP_DAYS + 3;
  for (let index = 0; index < total; index += 1) {
    rollup = applyRowDelta(rollup, null, row({
      record_id: `stream:${index}`,
      recorded_at: new Date(2020, 0, 1 + index, 12).toISOString(),
      total_tokens: 10,
      input_tokens: 6,
      output_tokens: 4,
    }));
  }
  assert.equal(Object.keys(rollup.days).length, MAX_ROLLUP_DAYS);
  assert.equal(rollup.archived.turns, 3);
  assert.equal(rollup.archived.total_tokens, 30);
  assert.equal(rollup.archived.from, localDateKey(new Date(2020, 0, 1, 12)));
  assert.equal(rollup.archived.to, localDateKey(new Date(2020, 0, 3, 12)));
  assert.equal(rollup.archived.hours[12], 3);
  assert.deepEqual(rollup.archived.models.qwen, { provider: 'ollama', turns: 3, total_tokens: 30 });
  assert.deepEqual(sumDays(rollup), { turns: total, total_tokens: total * 10 });
  assert.equal(rollup.days[localDateKey(new Date(2020, 0, 1, 12))], undefined);
  // A later upsert of an archived-day row subtracts from the archive.
  const old = row({
    record_id: 'stream:0',
    recorded_at: new Date(2020, 0, 1, 12).toISOString(),
    total_tokens: 10,
    input_tokens: 6,
    output_tokens: 4,
  });
  const trimmed = applyRowDelta(rollup, old, null);
  assert.equal(trimmed.archived.turns, 2);
  assert.equal(trimmed.archived.total_tokens, 20);
});

test('models past the per-day cap fold the smallest into (other)', () => {
  let rollup = emptyRollup();
  const count = MAX_MODELS_PER_DAY + 3;
  for (let index = 0; index < count; index += 1) {
    // Model m0 gets the most turns; later models the fewest.
    for (let repeat = 0; repeat < count - index; repeat += 1) {
      rollup = applyRowDelta(rollup, null, row({
        record_id: `stream:${index}:${repeat}`,
        model: `m${index}`,
        total_tokens: 2,
        input_tokens: 1,
        output_tokens: 1,
      }));
    }
  }
  const day = rollup.days[dayKey(2026, 3, 10)];
  const names = Object.keys(day.models);
  assert.ok(names.length <= MAX_MODELS_PER_DAY);
  assert.ok(names.includes('(other)'));
  assert.ok(names.includes('m0'), 'the largest model is kept');
  assert.ok(!names.includes(`m${count - 1}`), 'the smallest model is folded away');
  let modelTurns = 0;
  let modelTokens = 0;
  for (const entry of Object.values(day.models)) {
    modelTurns += entry.turns;
    modelTokens += entry.total_tokens;
  }
  assert.equal(modelTurns, day.turns, 'folding preserves the turn total');
  assert.equal(modelTokens, day.total_tokens, 'folding preserves the token total');
});

test('seedFromRows builds the rollup and first_recorded_at from retained rows', () => {
  const rows = [
    row({ record_id: 'a', recorded_at: localIso(2026, 3, 12, 9) }),
    row({ record_id: 'b', recorded_at: localIso(2026, 3, 10, 15), model: 'llama' }),
    row({ record_id: 'c', recorded_at: localIso(2026, 3, 10, 16) }),
  ];
  const seeded = seedFromRows(rows);
  assert.equal(seeded.first_recorded_at, localIso(2026, 3, 10, 15));
  assert.equal(seeded.days[dayKey(2026, 3, 10)].turns, 2);
  assert.equal(seeded.days[dayKey(2026, 3, 12)].turns, 1);
  assert.deepEqual(seedFromRows(null).days, {});
  assert.deepEqual(seedFromRows([null, 7, {}]).days, {});
});

test('normalizeRollup bounds untrusted content and never throws', () => {
  for (const raw of [null, undefined, 7, 'x', [], {}, { days: 5 }, { days: [] }]) {
    const rollup = normalizeRollup(raw);
    assert.deepEqual(rollup.days, {});
    assert.equal(rollup.archived, null);
    assert.equal(rollup.schema_version, 1);
  }
  const normalized = normalizeRollup({
    schema_version: 1,
    updated_at: 'nope',
    first_recorded_at: localIso(2026, 3, 10),
    days: {
      '2026-03-10': {
        turns: 3.9,
        input_tokens: -5,
        output_tokens: '12',
        total_tokens: 20,
        generation_tokens: 'abc',
        generation_duration_ms: 50,
        estimated_turns: 1,
        hours: [1, 2, 'x', -1],
        models: {
          qwen: { provider: 'ollama', turns: 3, total_tokens: 20 },
          empty: { provider: 'x', turns: 0, total_tokens: 0 },
          bad: 'nope',
        },
      },
      '2026-13-45': { turns: 1, total_tokens: 1 },
      'not-a-day': { turns: 1, total_tokens: 1 },
      '2026-03-11': 'junk',
    },
    archived: { from: 'zzz', to: '2020-01-01', turns: 1 },
  });
  assert.deepEqual(Object.keys(normalized.days), ['2026-03-10']);
  const day = normalized.days['2026-03-10'];
  assert.equal(day.turns, 3);
  assert.equal(day.input_tokens, 0);
  assert.equal(day.output_tokens, 12);
  assert.equal(day.generation_tokens, 0);
  assert.equal(day.hours.length, 24);
  assert.deepEqual(day.hours.slice(0, 4), [1, 2, 0, 0]);
  assert.deepEqual(Object.keys(day.models), ['qwen']);
  assert.equal(normalized.updated_at, '');
  assert.equal(normalized.archived, null, 'an archive without a valid range is dropped');

  const roundTrip = normalizeRollup(JSON.parse(JSON.stringify(
    applyRowDelta(emptyRollup(), null, row()),
  )));
  assert.equal(roundTrip.days[dayKey(2026, 3, 10)].turns, 1);

  const archived = normalizeRollup({
    archived: { from: '2020-02-01', to: '2020-01-01', turns: 4, total_tokens: 9, hours: [4], models: {} },
  });
  assert.equal(archived.archived.from, '2020-01-01');
  assert.equal(archived.archived.to, '2020-02-01');
  assert.equal(archived.archived.turns, 4);
});

test('normalizeRollup enforces the day cap and the model cap', () => {
  const days = {};
  for (let index = 0; index < MAX_ROLLUP_DAYS + 5; index += 1) {
    days[localDateKey(new Date(2019, 0, 1 + index, 12))] = { turns: 1, total_tokens: 2 };
  }
  const normalized = normalizeRollup({ days });
  assert.equal(Object.keys(normalized.days).length, MAX_ROLLUP_DAYS);
  assert.equal(normalized.archived.turns, 5);
  const models = {};
  for (let index = 0; index < 30; index += 1) {
    models[`m${index}`] = { provider: 'p', turns: index + 1, total_tokens: 1 };
  }
  const folded = normalizeRollup({ days: { '2026-03-10': { turns: 465, total_tokens: 30, models } } });
  assert.ok(Object.keys(folded.days['2026-03-10'].models).length <= MAX_MODELS_PER_DAY);
  assert.ok(folded.days['2026-03-10'].models['(other)']);
});

test('the store works in memory without a path or backing store', () => {
  const store = createUsageRollupStore({});
  store.load([row({ record_id: 'seed' })]);
  assert.equal(store.snapshot().days[dayKey(2026, 3, 10)].turns, 1);
  store.apply(null, row({ record_id: 'next', recorded_at: localIso(2026, 3, 11, 8) }));
  const snapshot = store.snapshot();
  assert.equal(snapshot.days[dayKey(2026, 3, 11)].turns, 1);
  snapshot.days[dayKey(2026, 3, 11)].turns = 99;
  assert.equal(store.snapshot().days[dayKey(2026, 3, 11)].turns, 1, 'snapshot is a deep clone');
  store.clear();
  assert.deepEqual(store.snapshot().days, {});
  assert.equal(store.snapshot().first_recorded_at, '');
});

test('the store seeds from retained rows only when the file is absent', () => {
  withTempDir((userDataPath) => {
    const file = path.join(userDataPath, USAGE_ROLLUP_FILE);
    const nowMs = Date.parse('2026-03-12T12:00:00.000Z');
    const first = createUsageRollupStore({ userDataPath, now: () => nowMs });
    first.load([row({ record_id: 'seed-a' }), row({ record_id: 'seed-b', recorded_at: localIso(2026, 3, 11, 9) })]);
    assert.ok(fs.existsSync(file), 'the first load writes the seeded file');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.schema_version, 1);
    assert.equal(written.updated_at, '2026-03-12T12:00:00.000Z');
    assert.equal(written.first_recorded_at, localIso(2026, 3, 10, 9));
    assert.equal(sumDays(written).turns, 2);

    const second = createUsageRollupStore({ userDataPath });
    second.load([row({ record_id: 'other-1' }), row({ record_id: 'other-2' }), row({ record_id: 'other-3' })]);
    assert.equal(sumDays(second.snapshot()).turns, 2, 'an existing file is not re-seeded');

    second.apply(null, row({ record_id: 'live', recorded_at: localIso(2026, 3, 13, 9) }));
    const third = createUsageRollupStore({ userDataPath });
    third.load([]);
    assert.equal(sumDays(third.snapshot()).turns, 3, 'applied rows persist across a restart');
    assert.equal(third.snapshot().days[dayKey(2026, 3, 13)].turns, 1);
  });
});

test('a corrupt or wrong-shape file is never overwritten (read-only until clear)', () => {
  for (const bytes of ['{not json', 'null', '[1,2]']) {
    withTempDir((userDataPath) => {
      const file = path.join(userDataPath, USAGE_ROLLUP_FILE);
      fs.writeFileSync(file, bytes);
      const store = createUsageRollupStore({ userDataPath });
      assert.doesNotThrow(() => store.load([row()]));
      assert.deepEqual(store.snapshot().days, {}, 'a corrupt file is not re-seeded');
      assert.doesNotThrow(() => store.apply(null, row()));
      assert.equal(store.snapshot().days[dayKey(2026, 3, 10)].turns, 1, 'memory still counts');
      assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the damaged file is kept for recovery');
      store.clear();
      store.apply(null, row());
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).days[dayKey(2026, 3, 10)].turns, 1, 'clear lifts read-only');
    });
  }
});

test('a valid file with malformed content is normalized on load', () => {
  withTempDir((userDataPath) => {
    fs.writeFileSync(path.join(userDataPath, USAGE_ROLLUP_FILE), JSON.stringify({
      schema_version: 1,
      days: { '2026-03-10': { turns: 2, total_tokens: 9 }, bogus: { turns: 1 } },
    }));
    const store = createUsageRollupStore({ userDataPath });
    store.load([]);
    assert.deepEqual(Object.keys(store.snapshot().days), ['2026-03-10']);
  });
});

test('a future-schema file is kept in memory but never overwritten', () => {
  withTempDir((userDataPath) => {
    const file = path.join(userDataPath, USAGE_ROLLUP_FILE);
    const future = JSON.stringify({ schema_version: 9, days: { '2026-03-10': { turns: 2, total_tokens: 9 } } });
    fs.writeFileSync(file, future);
    const store = createUsageRollupStore({ userDataPath });
    store.load([]);
    store.apply(null, row());
    assert.equal(fs.readFileSync(file, 'utf8'), future);
  });
});

test('clear() empties memory and the file; a write failure keeps the data', () => {
  withTempDir((userDataPath) => {
    const file = path.join(userDataPath, USAGE_ROLLUP_FILE);
    const store = createUsageRollupStore({ userDataPath });
    store.load([]);
    store.apply(null, row());
    store.clear();
    assert.deepEqual(store.snapshot().days, {});
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).days, {});
  });
  let failing = false;
  const backing = {
    readWithStatus: () => ({ missing: true, corrupted: false, value: null }),
    writeImmediate: () => {
      if (failing) {
        throw Object.assign(new Error('disk'), { code: 'EACCES' });
      }
    },
  };
  const store = createUsageRollupStore({ store: backing });
  store.load([]);
  store.apply(null, row());
  failing = true;
  assert.throws(() => store.clear(), /disk/);
  assert.equal(store.snapshot().days[dayKey(2026, 3, 10)].turns, 1);
  assert.throws(() => store.apply(null, row({ record_id: 'b' })), /disk/);
  assert.equal(
    store.snapshot().days[dayKey(2026, 3, 10)].turns,
    2,
    'a failed write keeps the in-memory count so the next write persists it',
  );
});

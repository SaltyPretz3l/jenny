'use strict';

// Coverage for the pure ChatGPT plan-usage normalizer (services/backend/
// chatgpt-plan-usage.js). No I/O -- see docs/plans "ChatGPT plan-usage
// meter" W2 "Shapes" for the wire contract this validates against.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PLAN_USAGE_SCHEMA_VERSION,
  PLAN_USAGE_MAX_AGE_MS,
  normalizePlanUsageSnapshot,
  buildPlanUsageRecord,
} = require('../services/backend/chatgpt-plan-usage');

function validSnapshot(overrides = {}) {
  return {
    schema_version: 1,
    primary: { used_percent: 62.0, window_minutes: 300, reset_at: 1756800000 },
    secondary: { used_percent: 18.0, window_minutes: 10080, reset_at: 1757100000 },
    rate_limit_reached_type: 'primary',
    ...overrides,
  };
}

test('PLAN_USAGE_SCHEMA_VERSION is 1 and PLAN_USAGE_MAX_AGE_MS is 7 days', () => {
  assert.equal(PLAN_USAGE_SCHEMA_VERSION, 1);
  assert.equal(PLAN_USAGE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
});

test('a full valid snapshot round-trips with both windows and the reached-type', () => {
  const result = normalizePlanUsageSnapshot(validSnapshot());
  assert.deepEqual(result, {
    schema_version: 1,
    primary: { used_percent: 62, window_minutes: 300, reset_at: 1756800000 },
    secondary: { used_percent: 18, window_minutes: 10080, reset_at: 1757100000 },
    rate_limit_reached_type: 'primary',
  });
});

test('primary-only snapshot omits secondary entirely', () => {
  const result = normalizePlanUsageSnapshot(validSnapshot({ secondary: undefined, rate_limit_reached_type: undefined }));
  assert.deepEqual(result, {
    schema_version: 1,
    primary: { used_percent: 62, window_minutes: 300, reset_at: 1756800000 },
  });
  assert.equal('secondary' in result, false);
  assert.equal('rate_limit_reached_type' in result, false);
});

test('secondary-only snapshot is valid and primary is simply absent from the normalized output', () => {
  const result = normalizePlanUsageSnapshot(validSnapshot({ primary: undefined, rate_limit_reached_type: undefined }));
  assert.deepEqual(result, {
    schema_version: 1,
    secondary: { used_percent: 18, window_minutes: 10080, reset_at: 1757100000 },
  });
  assert.equal('primary' in result, false);
});

test('non-object, array, and null inputs are all rejected', () => {
  assert.equal(normalizePlanUsageSnapshot(null), null);
  assert.equal(normalizePlanUsageSnapshot(undefined), null);
  assert.equal(normalizePlanUsageSnapshot('nope'), null);
  assert.equal(normalizePlanUsageSnapshot(42), null);
  assert.equal(normalizePlanUsageSnapshot([]), null);
  assert.equal(normalizePlanUsageSnapshot([{ schema_version: 1, primary: { used_percent: 1, reset_at: 1_700_000_000 } }]), null);
});

test('wrong or missing schema_version is rejected', () => {
  assert.equal(normalizePlanUsageSnapshot(validSnapshot({ schema_version: 2 })), null);
  assert.equal(normalizePlanUsageSnapshot(validSnapshot({ schema_version: 0 })), null);
  assert.equal(normalizePlanUsageSnapshot(validSnapshot({ schema_version: undefined })), null);
  assert.equal(normalizePlanUsageSnapshot(validSnapshot({ schema_version: '1' })), null, 'a string schema_version must not coerce past the check via Number()');
});

test('both windows malformed collapses the whole snapshot to null', () => {
  const result = normalizePlanUsageSnapshot({
    schema_version: 1,
    primary: { used_percent: 'not-a-number', reset_at: 1_700_000_000 },
    secondary: { used_percent: 50, reset_at: -1 },
  });
  assert.equal(result, null);
});

test('used_percent is clamped into 0..100', () => {
  const result = normalizePlanUsageSnapshot(validSnapshot({
    primary: { used_percent: 150, reset_at: 1_700_000_000 },
    secondary: { used_percent: -30, reset_at: 1_700_000_000 },
  }));
  assert.equal(result.primary.used_percent, 100);
  assert.equal(result.secondary.used_percent, 0);
});

test('non-finite used_percent (NaN, Infinity, non-numeric string) drops only that window', () => {
  for (const badValue of [NaN, Infinity, -Infinity, 'not-a-number', {}, [], null, undefined]) {
    const result = normalizePlanUsageSnapshot(validSnapshot({
      primary: { used_percent: badValue, reset_at: 1_700_000_000 },
    }));
    // secondary in validSnapshot() is still valid, so the snapshot survives
    // with only primary missing.
    assert.equal(result?.primary, undefined, `used_percent=${String(badValue)} should drop primary`);
    assert.ok(result?.secondary, `used_percent=${String(badValue)} should leave secondary intact`);
  }
});

test('window_minutes out of range or non-integer is simply omitted, the window stays valid', () => {
  for (const badValue of [0, -5, 1_051_201, 1.5, 'five', null]) {
    const result = normalizePlanUsageSnapshot(validSnapshot({
      primary: { used_percent: 50, window_minutes: badValue, reset_at: 1_700_000_000 },
    }));
    assert.ok(result.primary, `window_minutes=${String(badValue)} must not drop the window`);
    assert.equal('window_minutes' in result.primary, false);
    assert.equal(result.primary.used_percent, 50);
  }
});

test('window_minutes boundaries 1 and 1_051_200 are accepted', () => {
  const low = normalizePlanUsageSnapshot(validSnapshot({
    primary: { used_percent: 1, window_minutes: 1, reset_at: 1_700_000_000 },
  }));
  const high = normalizePlanUsageSnapshot(validSnapshot({
    primary: { used_percent: 1, window_minutes: 1_051_200, reset_at: 1_700_000_000 },
  }));
  assert.equal(low.primary.window_minutes, 1);
  assert.equal(high.primary.window_minutes, 1_051_200);
});

test('window_minutes may be omitted from the input entirely and the window stays valid', () => {
  const result = normalizePlanUsageSnapshot(validSnapshot({
    primary: { used_percent: 50, reset_at: 1_700_000_000 },
  }));
  assert.ok(result.primary);
  assert.equal('window_minutes' in result.primary, false);
});

test('reset_at out of range drops the window entirely (not just the field)', () => {
  for (const badValue of [999_999_999, 9_007_199_254_740_992, -1, 1.5, 'now', null, undefined]) {
    const result = normalizePlanUsageSnapshot({
      schema_version: 1,
      primary: { used_percent: 50, reset_at: badValue },
      secondary: { used_percent: 20, reset_at: 1_700_000_000 },
    });
    assert.equal(result?.primary, undefined, `reset_at=${String(badValue)} should drop the whole window`);
    assert.ok(result?.secondary, `reset_at=${String(badValue)} should leave the other window intact`);
  }
});

test('reset_at boundaries are inclusive', () => {
  const low = normalizePlanUsageSnapshot(validSnapshot({
    primary: { used_percent: 1, reset_at: 1_000_000_000 },
  }));
  const high = normalizePlanUsageSnapshot(validSnapshot({
    primary: { used_percent: 1, reset_at: 9_007_199_254_740_991 },
  }));
  assert.equal(low.primary.reset_at, 1_000_000_000);
  assert.equal(high.primary.reset_at, 9_007_199_254_740_991);
});

test('rate_limit_reached_type accepts only the primary/secondary enum, else omitted', () => {
  assert.equal(
    normalizePlanUsageSnapshot(validSnapshot({ rate_limit_reached_type: 'secondary' })).rate_limit_reached_type,
    'secondary'
  );
  for (const badValue of ['tertiary', '', 'PRIMARY', 42, null, undefined, {}, []]) {
    const result = normalizePlanUsageSnapshot(validSnapshot({ rate_limit_reached_type: badValue }));
    assert.equal('rate_limit_reached_type' in result, false, `rate_limit_reached_type=${String(badValue)} must be omitted, not echoed`);
  }
});

test('normalizePlanUsageSnapshot never spreads the input: an injected key never survives', () => {
  const result = normalizePlanUsageSnapshot(validSnapshot({ evil: 'payload', primary: { used_percent: 1, reset_at: 1_700_000_000, evil: 'window-payload' } }));
  assert.equal('evil' in result, false);
  assert.equal('evil' in result.primary, false);
  assert.deepEqual(Object.keys(result).sort(), ['primary', 'rate_limit_reached_type', 'schema_version', 'secondary']);
  assert.deepEqual(Object.keys(result.primary).sort(), ['reset_at', 'used_percent']);
});

test('a non-object window (string/array/number) is treated as absent', () => {
  const result = normalizePlanUsageSnapshot(validSnapshot({ primary: 'nope', secondary: [1, 2, 3] }));
  assert.equal(result, null);
});

test('buildPlanUsageRecord builds the persisted shape with a null primary when only secondary is present', () => {
  const snapshot = normalizePlanUsageSnapshot(validSnapshot({ primary: undefined, rate_limit_reached_type: undefined }));
  const record = buildPlanUsageRecord(snapshot, { accountKey: 'abc123', source: 'chat_done', now: () => 555 });
  assert.deepEqual(record, {
    version: 1,
    account_key: 'abc123',
    primary: null,
    secondary: { used_percent: 18, window_minutes: 10080, reset_at: 1757100000 },
    captured_at_ms: 555,
    source: 'chat_done',
  });
});

test('buildPlanUsageRecord includes rate_limit_reached_type only when present, and defaults source to chat_done', () => {
  const snapshot = normalizePlanUsageSnapshot(validSnapshot({ secondary: undefined, rate_limit_reached_type: undefined }));
  const record = buildPlanUsageRecord(snapshot, { accountKey: 'k', now: () => 1 });
  assert.equal('secondary' in record, false);
  assert.equal('rate_limit_reached_type' in record, false);
  assert.equal(record.source, 'chat_done');

  const withReached = normalizePlanUsageSnapshot(validSnapshot());
  const recordWithReached = buildPlanUsageRecord(withReached, { accountKey: 'k', source: 'chat_error', now: () => 1 });
  assert.equal(recordWithReached.rate_limit_reached_type, 'primary');
  assert.equal(recordWithReached.source, 'chat_error');
});

test('buildPlanUsageRecord accepts a plain now value in addition to a now() function', () => {
  const snapshot = normalizePlanUsageSnapshot(validSnapshot());
  const record = buildPlanUsageRecord(snapshot, { accountKey: 'k', now: 999 });
  assert.equal(record.captured_at_ms, 999);
});

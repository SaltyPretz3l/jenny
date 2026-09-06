'use strict';

// Coverage for services/backend/chatgpt-plan-usage-store.js: persistence,
// account-key scoping, TTL, the sign-out clear hook, and failure tolerance.
// See docs/plans "ChatGPT plan-usage meter" W2, seam-failure-contract table.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createChatGptPlanUsageStore, hashAccountId } = require('../services/backend/chatgpt-plan-usage-store');
const { PLAN_USAGE_MAX_AGE_MS } = require('../services/backend/chatgpt-plan-usage');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

function tempFilePath() {
  const dir = createTrackedTempDir('jenny-chatgpt-plan-usage-');
  return path.join(dir, 'chatgpt-plan-usage.json');
}

const VALID_RAW = Object.freeze({
  schema_version: 1,
  primary: { used_percent: 62, window_minutes: 300, reset_at: 1_900_000_000 },
  secondary: { used_percent: 18, window_minutes: 10080, reset_at: 1_900_100_000 },
  rate_limit_reached_type: 'primary',
});

function buildStore(overrides = {}) {
  const filePath = overrides.filePath || tempFilePath();
  return createChatGptPlanUsageStore({
    filePath,
    getAccountId: () => 'acct-1',
    getFeatureFlags: () => ({ chatgpt_plan_meter: true }),
    now: () => 1_000_000,
    ...overrides,
  });
}

test('ingest persists a normalized record and getSnapshot returns it', () => {
  const store = buildStore();
  store.ingest(VALID_RAW, { source: 'chat_done' });
  const snapshot = store.getSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.account_key, hashAccountId('acct-1'));
  assert.equal(snapshot.primary.used_percent, 62);
  assert.equal(snapshot.secondary.used_percent, 18);
  assert.equal(snapshot.rate_limit_reached_type, 'primary');
  assert.equal(snapshot.source, 'chat_done');
  assert.equal(snapshot.captured_at_ms, 1_000_000);
});

test('a cold reopen (new store instance, same file) reads the persisted record', () => {
  const filePath = tempFilePath();
  const first = buildStore({ filePath });
  first.ingest(VALID_RAW, { source: 'chat_error' });

  const second = buildStore({ filePath, now: () => 1_000_500 });
  const snapshot = second.getSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.source, 'chat_error');
  assert.equal(snapshot.primary.used_percent, 62);
});

test('sign-out (any non signed_in auth state) clears the file and emits null', () => {
  const store = buildStore();
  store.ingest(VALID_RAW, { source: 'chat_done' });
  assert.ok(store.getSnapshot());

  const changes = [];
  store.onChange((record) => changes.push(record));

  let statusCallback = null;
  const fakeAuth = {
    onStatusChange(cb) {
      statusCallback = cb;
      return () => { statusCallback = null; };
    },
  };
  store.attachAuthService(fakeAuth);
  assert.ok(typeof statusCallback === 'function');
  statusCallback({ state: 'signed_out' });

  assert.equal(store.getSnapshot(), null);
  assert.deepEqual(changes, [null]);
});

test('attachAuthService does not clear on a signed_in status', () => {
  const store = buildStore();
  store.ingest(VALID_RAW, { source: 'chat_done' });

  let statusCallback = null;
  store.attachAuthService({
    onStatusChange(cb) {
      statusCallback = cb;
      return () => {};
    },
  });
  statusCallback({ state: 'signed_in' });
  assert.ok(store.getSnapshot());
});

test('attachAuthService replaces a prior subscription rather than stacking them', () => {
  const store = buildStore();
  store.ingest(VALID_RAW, { source: 'chat_done' });

  let firstUnsubscribed = false;
  store.attachAuthService({
    onStatusChange: () => () => { firstUnsubscribed = true; },
  });
  let secondCallback = null;
  store.attachAuthService({
    onStatusChange(cb) {
      secondCallback = cb;
      return () => {};
    },
  });
  assert.equal(firstUnsubscribed, true);
  secondCallback({ state: 'error' });
  assert.equal(store.getSnapshot(), null);
});

test('a stale account key (record from a different signed-in account) is refused on read', () => {
  const filePath = tempFilePath();
  const writer = buildStore({ filePath, getAccountId: () => 'acct-old' });
  writer.ingest(VALID_RAW, { source: 'chat_done' });

  const reader = buildStore({ filePath, getAccountId: () => 'acct-new' });
  assert.equal(reader.getSnapshot(), null);

  // The original account can still read it back -- the record itself is intact.
  const originalReader = buildStore({ filePath, getAccountId: () => 'acct-old' });
  assert.ok(originalReader.getSnapshot());
});

test('a record older than the 7-day TTL is dropped on read', () => {
  const filePath = tempFilePath();
  const writer = buildStore({ filePath, now: () => 0 });
  writer.ingest(VALID_RAW, { source: 'chat_done' });

  const freshReader = buildStore({ filePath, now: () => PLAN_USAGE_MAX_AGE_MS });
  assert.ok(freshReader.getSnapshot(), 'exactly at the TTL boundary must still be readable (strictly greater-than expires)');

  const staleReader = buildStore({ filePath, now: () => PLAN_USAGE_MAX_AGE_MS + 1 });
  assert.equal(staleReader.getSnapshot(), null);
});

test('a corrupt JSON file on disk resolves to null without throwing, and the next ingest rewrites it', () => {
  const filePath = tempFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{ not valid json', 'utf8');

  const store = buildStore({ filePath });
  assert.doesNotThrow(() => store.getSnapshot());
  assert.equal(store.getSnapshot(), null);

  store.ingest(VALID_RAW, { source: 'chat_done' });
  assert.ok(store.getSnapshot());
});

test('flag-off (chatgpt_plan_meter === false) makes ingest and getSnapshot both no-ops', () => {
  const filePath = tempFilePath();
  const store = buildStore({ filePath, getFeatureFlags: () => ({ chatgpt_plan_meter: false }) });
  const changes = [];
  store.onChange((record) => changes.push(record));

  store.ingest(VALID_RAW, { source: 'chat_done' });
  assert.equal(store.getSnapshot(), null);
  assert.equal(changes.length, 0);
  assert.equal(fs.existsSync(filePath), false, 'flag-off must not create the file at all');
});

test('an undefined getFeatureFlags result treats the meter as on (default-on)', () => {
  const store = buildStore({ getFeatureFlags: () => ({}) });
  store.ingest(VALID_RAW, { source: 'chat_done' });
  assert.ok(store.getSnapshot());
});

test('malformed raw input to ingest is silently dropped (never persisted, never echoed)', () => {
  const store = buildStore();
  const changes = [];
  store.onChange((record) => changes.push(record));
  store.ingest({ schema_version: 2, primary: { used_percent: 1, reset_at: 1 } }, { source: 'chat_done' });
  assert.equal(store.getSnapshot(), null);
  assert.equal(changes.length, 0);
});

test('a failing write still emits `changed` so the live meter updates', () => {
  const filePath = tempFilePath();
  // Point filePath at a location that cannot be created (a file used as a
  // directory segment) so FileJsonStore's write throws.
  const blockerFile = path.join(path.dirname(filePath), 'blocker-not-a-dir');
  fs.mkdirSync(path.dirname(blockerFile), { recursive: true });
  fs.writeFileSync(blockerFile, 'x', 'utf8');
  const brokenPath = path.join(blockerFile, 'chatgpt-plan-usage.json');

  const warnLogs = [];
  const store = buildStore({
    filePath: brokenPath,
    logger: (level, event, fields) => warnLogs.push({ level, event, fields }),
  });
  const changes = [];
  store.onChange((record) => changes.push(record));

  assert.doesNotThrow(() => store.ingest(VALID_RAW, { source: 'chat_done' }));
  assert.equal(changes.length, 1);
  assert.ok(changes[0], 'the in-memory record is still emitted despite the disk write failing');
  assert.ok(warnLogs.some((entry) => entry.event === 'chatgpt_plan_usage.write_failed'));
});

test('dispose() unsubscribes the auth listener and clears change listeners', () => {
  const store = buildStore();
  let unsubscribed = false;
  store.attachAuthService({
    onStatusChange: () => () => { unsubscribed = true; },
  });
  const changes = [];
  store.onChange((record) => changes.push(record));

  store.dispose();
  assert.equal(unsubscribed, true);

  // A change after dispose must not reach the cleared listener set.
  store.ingest(VALID_RAW, { source: 'chat_done' });
  assert.equal(changes.length, 0);
});

test('dispose() is idempotent', () => {
  const store = buildStore();
  let unsubscribeCalls = 0;
  store.attachAuthService({
    onStatusChange: () => () => { unsubscribeCalls += 1; },
  });
  const changes = [];
  store.onChange((record) => changes.push(record));

  store.dispose();
  store.dispose();

  // The auth listener is released exactly once and listeners stay cleared.
  assert.equal(unsubscribeCalls, 1);
  store.ingest(VALID_RAW, { source: 'chat_done' });
  assert.equal(changes.length, 0);
});

test('clear() deletes the file and getSnapshot returns null afterward', () => {
  const filePath = tempFilePath();
  const store = buildStore({ filePath });
  store.ingest(VALID_RAW, { source: 'chat_done' });
  assert.ok(fs.existsSync(filePath));

  store.clear();
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(store.getSnapshot(), null);
});

test('hashAccountId is deterministic, 16 hex chars, and empty-string-safe', () => {
  const first = hashAccountId('acct-1');
  const second = hashAccountId('acct-1');
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.match(hashAccountId(''), /^[0-9a-f]{16}$/);
  assert.match(hashAccountId(undefined), /^[0-9a-f]{16}$/);
});

test('an empty account id disables scoping: ingest is refused and getSnapshot returns null', () => {
  const filePath = tempFilePath();
  const anonymous = buildStore({ filePath, getAccountId: () => '' });
  anonymous.ingest(VALID_RAW, { source: 'chat_done' });
  assert.equal(fs.existsSync(filePath), false, 'nothing is written under the well-known hash of an empty id');
  assert.equal(anonymous.getSnapshot(), null);

  const signedIn = buildStore({ filePath, getAccountId: () => 'acct-1' });
  signedIn.ingest(VALID_RAW, { source: 'chat_done' });
  assert.ok(signedIn.getSnapshot());
  const throwingGetter = buildStore({ filePath, getAccountId: () => { throw new Error('auth gone'); } });
  assert.equal(throwingGetter.getSnapshot(), null, 'a throwing getter is an empty identity, not the empty-hash identity');
});

test('getSnapshot reads the file once and serves later reads from cache until a write or clear', () => {
  const filePath = tempFilePath();
  const store = buildStore({ filePath });
  store.ingest(VALID_RAW, { source: 'chat_done' });
  const first = store.getSnapshot();
  fs.writeFileSync(filePath, '{ not json', 'utf8');
  assert.deepEqual(store.getSnapshot(), first, 'a foreign disk change is not observed between our own writes');
  store.clear();
  assert.equal(store.getSnapshot(), null);
  store.ingest(VALID_RAW, { source: 'chat_error' });
  assert.equal(store.getSnapshot().source, 'chat_error');
});

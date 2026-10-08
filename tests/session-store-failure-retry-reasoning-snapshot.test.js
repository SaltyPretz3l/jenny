'use strict';

// `failure_retry_reasoning_snapshots` is a legacy session field (schema v22).
// The capture that wrote it and its `failure_retry_reasoning_carry` flag were
// deleted (owner, 2026-10-05): the replay half was never built, so the map was
// data nothing read. Sessions saved while the flag was on must still load and
// round-trip, so the store keeps normalizing the field; nothing writes it now.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ElectronSessionStore,
} = require('../services/backend/electron-session-store');
const {
  normalizeFailureRetryReasoningSnapshots,
} = require('../services/backend/session-failure-retry-reasoning');
const { STORE_SCHEMA_VERSION } = require('../services/backend/session-store-migrations');
const {
  SessionTurnActorRegistry,
} = require('../services/backend/session-turn-actor');
const { buildFeatureFlags } = require('../services/feature-flags');
const {
  cleanupTrackedResources,
} = require('./helpers/resource-cleanup');
const {
  freshStore,
} = require('./helpers/session-truncate-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('the retired carry flag is gone and the store no longer offers a capture', () => {
  assert.equal(Object.hasOwn(buildFeatureFlags({}), 'failure_retry_reasoning_carry'), false);
  assert.equal(
    Object.hasOwn(
      buildFeatureFlags({ JENNY_ENABLE_FAILURE_RETRY_REASONING_CARRY: '1' }),
      'failure_retry_reasoning_carry'
    ),
    false
  );
  const { store } = freshStore();
  assert.equal(typeof store.captureFailureRetryReasoning, 'undefined');
});

function reasoningEntry(id, text, timestamp, thinkingId = '') {
  return { id, text, timestamp, ...(thinkingId ? { thinkingId } : {}) };
}

function appendAttempt(store, sessionId, {
  userId = 'user_1',
  assistantId = 'assistant_stream_1',
  streamId = 'stream_1',
  reasoningEntries = [],
  timestamp = '2026-09-04T00:00:00.000Z',
} = {}) {
  if (!store.getSession(sessionId).messages.some((message) => message.id === userId)) {
    store.appendMessage(sessionId, {
      id: userId,
      role: 'user',
      content: 'Retry me',
      timestamp,
    });
  }
  store.appendMessage(sessionId, {
    id: assistantId,
    role: 'assistant',
    content: 'Failed',
    status: 'runtime_error',
    terminal_status: 'runtime_error',
    parent_stream_id: streamId,
    timestamp,
    reasoning: { source: 'provider', entries: reasoningEntries },
  });
}

function snapshotRecord({
  userId,
  assistantId,
  turnId,
  capturedAt = '2026-09-04T00:00:00.000Z',
  text = 'reasoning',
  capChars = 48_000,
} = {}) {
  return {
    version: 1,
    user_message_id: userId,
    source_assistant_message_id: assistantId,
    source_turn_id: turnId,
    captured_at: capturedAt,
    cap_chars: capChars,
    char_count: text.length,
    truncated: false,
    reasoning_entries: [{
      id: `entry_${userId}`,
      text,
      thinking_id: `thinking_${userId}`,
      timestamp: capturedAt,
    }],
  };
}

test('normalization keeps four snapshots with deterministic oldest eviction', () => {
  const tiedAt = '2026-09-04T00:00:00.000Z';
  const snapshots = normalizeFailureRetryReasoningSnapshots({
    user_old: snapshotRecord({
      userId: 'user_old',
      assistantId: 'assistant_old',
      turnId: 'turn_z',
      capturedAt: '2026-09-03T23:59:59.000Z',
    }),
    user_e: snapshotRecord({ userId: 'user_e', assistantId: 'assistant_e', turnId: 'turn_b', capturedAt: tiedAt }),
    user_d: snapshotRecord({ userId: 'user_d', assistantId: 'assistant_d', turnId: 'turn_a', capturedAt: tiedAt }),
    user_c: snapshotRecord({ userId: 'user_c', assistantId: 'assistant_c', turnId: 'turn_c', capturedAt: tiedAt }),
    user_b: snapshotRecord({ userId: 'user_b', assistantId: 'assistant_b', turnId: 'turn_b', capturedAt: tiedAt }),
    user_a: snapshotRecord({ userId: 'user_a', assistantId: 'assistant_a', turnId: 'turn_a', capturedAt: tiedAt }),
  });

  assert.deepEqual(Object.keys(snapshots).sort(), ['user_b', 'user_c', 'user_d', 'user_e']);
  assert.equal(Object.hasOwn(snapshots, 'user_old'), false);
  assert.equal(Object.hasOwn(snapshots, 'user_a'), false);
});

test('normalization is idempotent when tail capping leaves only whitespace', () => {
  const once = normalizeFailureRetryReasoningSnapshots({
    user_whitespace: snapshotRecord({
      userId: 'user_whitespace',
      assistantId: 'assistant_whitespace',
      turnId: 'turn_whitespace',
      text: 'abc     ',
      capChars: 5,
    }),
  });
  const twice = normalizeFailureRetryReasoningSnapshots(once);

  assert.deepEqual(twice, once);
  assert.deepEqual(once, {});
});

test('production-cap normalization is idempotent and survives a store reload', () => {
  const source = snapshotRecord({
    userId: 'user_production_cap',
    assistantId: 'assistant_production_cap',
    turnId: 'turn_production_cap',
  });
  source.char_count = 48_003;
  source.reasoning_entries = [
    {
      id: 'whitespace_tail',
      text: `abc${' '.repeat(47_995)}`,
      thinking_id: 'thinking_whitespace',
      timestamp: source.captured_at,
    },
    {
      id: 'kept',
      text: 'kept!',
      thinking_id: 'thinking_kept',
      timestamp: source.captured_at,
    },
  ];

  const once = normalizeFailureRetryReasoningSnapshots({ user_production_cap: source });
  const twice = normalizeFailureRetryReasoningSnapshots(once);
  assert.deepEqual(twice, once);
  assert.equal(once.user_production_cap.char_count, 5);
  assert.deepEqual(
    once.user_production_cap.reasoning_entries.map((entry) => entry.id),
    ['kept']
  );

  const { store, userDataPath } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Idempotent retry reasoning' });
  assert.ok(store.updateSession(sessionId, { failure_retry_reasoning_snapshots: once }));
  assert.equal(store.flushSession(sessionId), true);
  store.dispose();

  const reloaded = new ElectronSessionStore(`${userDataPath}\\sessions.json`);
  assert.deepEqual(
    reloaded.getSession(sessionId).failure_retry_reasoning_snapshots,
    once
  );
  reloaded.dispose();
});

test('a v22 session file holding snapshots loads, saves and reloads without error', () => {
  assert.equal(STORE_SCHEMA_VERSION, 24, 'this legacy fixture is written at the current schema');
  const { store, userDataPath } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Saved with the carry on' });
  assert.equal(store.flushSession(sessionId), true);
  store.dispose();

  // Rewrite the on-disk record as a build with the carry enabled left it.
  const sessionFile = path.join(userDataPath, 'sessions', `${sessionId}.json`);
  const persisted = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(persisted.schema_version, 24);
  const legacy = {
    user_1: snapshotRecord({
      userId: 'user_1',
      assistantId: 'assistant_stream_1',
      turnId: 'stream_1',
      text: 'durable',
    }),
  };
  persisted.session.failure_retry_reasoning_snapshots = legacy;
  fs.writeFileSync(sessionFile, JSON.stringify(persisted, null, 2));

  const logs = [];
  const logger = (level, event) => logs.push({ level, event });
  const loaded = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'), { logger });
  assert.equal(loaded.hasPendingMigrations(), false);
  assert.deepEqual(loaded.getSession(sessionId).failure_retry_reasoning_snapshots, legacy);
  assert.ok(loaded.renameSession(sessionId, 'Renamed after the carry was retired'));
  assert.equal(loaded.flushSession(sessionId), true);
  loaded.dispose();

  const reloaded = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'), { logger });
  const session = reloaded.getSession(sessionId);
  assert.equal(session.title, 'Renamed after the carry was retired');
  assert.deepEqual(session.failure_retry_reasoning_snapshots, legacy);
  reloaded.dispose();
  assert.deepEqual(
    JSON.parse(fs.readFileSync(sessionFile, 'utf8')).session.failure_retry_reasoning_snapshots,
    legacy,
    'the saved file keeps the user-authored legacy map'
  );
  assert.equal(logs.some((entry) => entry.level === 'ERROR'), false);
});

test('a failure-retry reservation writes no reasoning snapshot', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Retry without capture' });
  appendAttempt(store, sessionId, {
    reasoningEntries: [reasoningEntry('hidden', 'do not capture', '2026-09-04T00:00:01.000Z')],
  });
  const registry = new SessionTurnActorRegistry();

  // A stale caller still passing the deleted arguments must not revive capture.
  const lease = registry.reserveStart({
    sessionId,
    store,
    activeStreams: new Map(),
    editedMessageId: 'user_1',
    failureRetry: true,
    failureRetryReasoningCarry: true,
  });

  assert.deepEqual(store.getSession(sessionId).failure_retry_reasoning_snapshots, {});
  registry.release(lease, { status: 'test_complete' });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ElectronSessionStore,
} = require('../services/backend/electron-session-store');
const {
  normalizeFailureRetryReasoningSnapshots,
} = require('../services/backend/session-failure-retry-reasoning');
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

test('failure retry reasoning carry is default-off with an environment opt-in', () => {
  assert.equal(buildFeatureFlags({}).failure_retry_reasoning_carry, false);
  assert.equal(
    buildFeatureFlags({ JENNY_ENABLE_FAILURE_RETRY_REASONING_CARRY: '1' })
      .failure_retry_reasoning_carry,
    true
  );
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

test('capture prefers reasoning_phase events and merges duplicate ids latest-snapshot-wins', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Retry reasoning' });
  appendAttempt(store, sessionId, {
    reasoningEntries: [reasoningEntry(
      'message_entry',
      'message fallback must not win',
      '2026-09-04T00:00:01.000Z',
      'message_thinking'
    )],
  });
  store.appendTurnEvents(sessionId, [
    {
      event_id: 'stream_1:reasoning_phase:0',
      turn_id: 'stream_1',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_stream_1',
      source_message_ids: ['assistant_stream_1'],
      payload: {
        thinking_id: 'phase_a',
        entries: [
          { id: 'same', text: 'old', timestamp: '2026-09-04T00:00:02.000Z' },
          { id: '', text: 'anonymous', timestamp: '2026-09-04T00:00:03.000Z' },
        ],
      },
    },
    {
      event_id: 'stream_1:reasoning_phase:1',
      turn_id: 'stream_1',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_stream_1',
      source_message_ids: ['assistant_stream_1'],
      payload: {
        thinking_id: 'phase_b',
        entries: [
          { id: 'same', text: 'latest', timestamp: '2026-09-04T00:00:04.000Z' },
          { id: 'tail', text: 'tail', timestamp: '2026-09-04T00:00:05.000Z' },
        ],
      },
    },
  ]);

  const result = store.captureFailureRetryReasoning(sessionId, 'user_1');
  assert.equal(result.ok, true);
  assert.equal(result.captured, true);

  const snapshot = store.getSession(sessionId).failure_retry_reasoning_snapshots.user_1;
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.source_assistant_message_id, 'assistant_stream_1');
  assert.equal(snapshot.source_turn_id, 'stream_1');
  assert.equal(snapshot.cap_chars, 48_000);
  assert.deepEqual(snapshot.reasoning_entries.map((entry) => ({
    id: entry.id,
    text: entry.text,
    thinking_id: entry.thinking_id,
  })), [
    { id: 'same', text: 'latest', thinking_id: 'phase_b' },
    { id: '', text: 'anonymous', thinking_id: 'phase_a' },
    { id: 'tail', text: 'tail', thinking_id: 'phase_b' },
  ]);
  assert.equal(snapshot.char_count, 'latest'.length + 'anonymous'.length + 'tail'.length);
  assert.equal(snapshot.truncated, false);
});

test('capture falls back to message reasoning entries and keeps the newest 48,000-character tail', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Retry cap' });
  appendAttempt(store, sessionId, {
    reasoningEntries: [
      reasoningEntry('dropped', 'o'.repeat(10_000), '2026-09-04T00:00:01.000Z', 'old_phase'),
      reasoningEntry('trimmed', 'x'.repeat(30_000), '2026-09-04T00:00:02.000Z', 'middle_phase'),
      reasoningEntry('new', 'y'.repeat(30_000), '2026-09-04T00:00:03.000Z', 'new_phase'),
    ],
  });

  const result = store.captureFailureRetryReasoning(sessionId, 'user_1');
  const snapshot = store.getSession(sessionId).failure_retry_reasoning_snapshots.user_1;

  assert.equal(result.ok, true);
  assert.equal(snapshot.cap_chars, 48_000);
  assert.equal(snapshot.char_count, 48_000);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.reasoning_entries.length, 2);
  assert.equal(snapshot.reasoning_entries[0].id, 'trimmed');
  assert.equal(snapshot.reasoning_entries[0].text, 'x'.repeat(18_000));
  assert.equal(snapshot.reasoning_entries[0].thinking_id, 'middle_phase');
  assert.equal(snapshot.reasoning_entries[1].id, 'new');
  assert.equal(snapshot.reasoning_entries[1].text, 'y'.repeat(30_000));
});

test('same-key capture replaces the snapshot and an empty latest attempt removes it', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Retry replacement' });
  appendAttempt(store, sessionId, {
    assistantId: 'assistant_stream_1',
    streamId: 'stream_1',
    reasoningEntries: [reasoningEntry('one', 'first', '2026-09-04T00:00:01.000Z')],
  });
  store.captureFailureRetryReasoning(sessionId, 'user_1');

  appendAttempt(store, sessionId, {
    assistantId: 'assistant_stream_2',
    streamId: 'stream_2',
    reasoningEntries: [reasoningEntry('two', 'second', '2026-09-04T00:00:02.000Z')],
  });
  store.captureFailureRetryReasoning(sessionId, 'user_1');

  let snapshots = store.getSession(sessionId).failure_retry_reasoning_snapshots;
  assert.deepEqual(Object.keys(snapshots), ['user_1']);
  assert.equal(snapshots.user_1.source_assistant_message_id, 'assistant_stream_2');
  assert.equal(snapshots.user_1.reasoning_entries[0].text, 'second');

  appendAttempt(store, sessionId, {
    assistantId: 'assistant_stream_3',
    streamId: 'stream_3',
    reasoningEntries: [],
  });
  const result = store.captureFailureRetryReasoning(sessionId, 'user_1');
  snapshots = store.getSession(sessionId).failure_retry_reasoning_snapshots;
  assert.equal(result.removed, true);
  assert.deepEqual(snapshots, {});
});

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

test('captured snapshots survive a store reload', () => {
  const { store, userDataPath } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Retry reload' });
  appendAttempt(store, sessionId, {
    reasoningEntries: [reasoningEntry('persisted', 'durable', '2026-09-04T00:00:01.000Z')],
  });

  assert.equal(store.captureFailureRetryReasoning(sessionId, 'user_1').ok, true);
  store.dispose();
  const reloaded = new ElectronSessionStore(`${userDataPath}\\sessions.json`);
  const snapshot = reloaded.getSession(sessionId).failure_retry_reasoning_snapshots.user_1;
  assert.equal(snapshot.reasoning_entries[0].text, 'durable');
  assert.equal(snapshot.char_count, 7);
  reloaded.dispose();
});

test('flag-off actor reservation does not capture retry reasoning', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Retry flag off' });
  appendAttempt(store, sessionId, {
    reasoningEntries: [reasoningEntry('hidden', 'do not capture', '2026-09-04T00:00:01.000Z')],
  });
  const registry = new SessionTurnActorRegistry();

  const lease = registry.reserveStart({
    sessionId,
    store,
    activeStreams: new Map(),
    editedMessageId: 'user_1',
    failureRetry: true,
    failureRetryReasoningCarry: false,
  });

  assert.deepEqual(store.getSession(sessionId).failure_retry_reasoning_snapshots, {});
  registry.release(lease, { status: 'test_complete' });
});

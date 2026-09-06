const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCompactionCoordinator,
  describeCompactionResult,
  getCompactionActivity,
} = require('../renderer/shell/renderer-settings-compaction-section.js');

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test('coordinator dedupes per session, projects pending state, and settles persisted success', async () => {
  const gate = deferred();
  const calls = [];
  const state = { currentSessionId: 's1' };
  const coordinator = createCompactionCoordinator({
    state,
    getChatApi: () => ({ compactNow: async (sessionId) => { calls.push(sessionId); return gate.promise; } }),
    callbacks: {
      renderComposerState() { calls.push('render:composer'); },
      renderSettings() { calls.push('render:settings'); },
      appendClientLog(level, event, details) { calls.push({ level, event, details }); },
      onCompactionPersisted(sessionId, result) { calls.push({ sessionId, result }); },
    },
  });

  const first = coordinator.invoke('s1', { source: 'settings' });
  const duplicate = await coordinator.invoke('s1', { source: 'slash' });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'already_pending');
  assert.equal(calls.filter((entry) => entry === 's1').length, 1);
  const pendingActivity = getCompactionActivity(state, 's1');
  assert.equal(pendingActivity.sessionId, 's1');
  assert.equal(pendingActivity.state, 'pending');
  assert.equal(pendingActivity.pending, true);
  assert.equal(pendingActivity.message, 'Compacting context…');
  assert.equal(pendingActivity.tone, 'pending');

  state.currentSessionId = 's2';
  gate.resolve({ status: 'ok', compacted: true, tokens_before: 5000, tokens_after: 1800, snapshot_persisted: true });
  const settled = await first;
  assert.equal(settled.accepted, true);
  assert.equal(settled.activity.state, 'success');
  assert.match(settled.activity.message, /5000 -> 1800 tokens/);
  assert.equal(getCompactionActivity(state, 's2'), null);
  assert.equal(
    calls.some((entry) => entry?.sessionId === 's1' && entry?.result?.tokens_after === 1800),
    true,
    'persisted compaction updates the context-meter seam',
  );
});

test('result descriptions fail closed for malformed persistence and redact downstream detail', () => {
  assert.deepEqual(describeCompactionResult({ status: 'ok', compacted: false }), {
    state: 'success', message: 'Nothing to compact.', tone: 'default', reason: 'not_needed',
  });
  assert.match(describeCompactionResult({ status: 'ok', compacted: true }).message, /could not confirm/i);
  assert.equal(describeCompactionResult({ status: 'ok', compacted: true }).tone, 'warning');
  assert.match(describeCompactionResult({ status: 'ok', compacted: true, snapshot_persisted: false }).message, /could not save/i);
  const failed = describeCompactionResult({ status: 'error', reason: 'compaction_failed', detail: 'token=secret-value C:\\private' });
  assert.equal(failed.message, 'Compaction failed.');
  assert.doesNotMatch(JSON.stringify(failed), /secret-value|C:\\private/);
  assert.equal(describeCompactionResult({ status: 'error', reason: 'token=secret-value' }).reason, 'unknown_reason');
  assert.equal(describeCompactionResult(null).reason, 'malformed_result');
});

test('missing bridge, thrown failures, malformed state, and disposal settle safely', async () => {
  const logs = [];
  const unavailableState = { compactionActivities: { malformed: true } };
  const unavailable = createCompactionCoordinator({
    state: unavailableState,
    getChatApi: () => null,
    callbacks: { appendClientLog: (...args) => logs.push(args) },
  });
  const missing = await unavailable.invoke('s1', { source: 'slash' });
  assert.equal(missing.activity.reason, 'sidecar_unavailable');
  assert.equal(unavailableState.compactionActivities instanceof Map, true);

  const throwing = createCompactionCoordinator({
    state: {},
    getChatApi: () => ({ compactNow: async () => { throw new Error('prompt=private-secret'); } }),
    callbacks: { appendClientLog: (...args) => logs.push(args) },
  });
  const thrown = await throwing.invoke('s2');
  assert.equal(thrown.activity.reason, 'request_failed');
  assert.doesNotMatch(JSON.stringify(logs), /private-secret/);

  const gate = deferred();
  const disposingState = {};
  const disposing = createCompactionCoordinator({
    state: disposingState,
    getChatApi: () => ({ compactNow: () => gate.promise }),
  });
  const pending = disposing.invoke('s3');
  disposing.dispose();
  gate.resolve({ status: 'ok', compacted: true, snapshot_persisted: true });
  const ignored = await pending;
  assert.equal(ignored.reason, 'disposed');
  assert.equal(getCompactionActivity(disposingState, 's3'), null);
});

test('coordinator bounds settled session activity and clears only settled entries', async () => {
  const state = {};
  const coordinator = createCompactionCoordinator({
    state,
    getChatApi: () => ({ compactNow: async () => ({ status: 'error', reason: 'no_active_turn' }) }),
  });
  for (let index = 0; index < 40; index += 1) {
    await coordinator.invoke(`s${index}`);
  }
  assert.equal(state.compactionActivities.size, 32);
  assert.equal(getCompactionActivity(state, 's0'), null);
  assert.equal(coordinator.clearSettled('s39'), true);
  assert.equal(getCompactionActivity(state, 's39'), null);
});

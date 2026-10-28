const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAppCompactionCoordinator,
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

  const omitted = 'Some older messages were omitted from the summarizer input.';
  const compacted = { status: 'ok', compacted: true, tokens_before: 5000, tokens_after: 1800, summary_source_dropped_messages: 4 };
  assert.ok(describeCompactionResult({ ...compacted, snapshot_persisted: true }).message.includes(`tokens. ${omitted} Future turns`));
  assert.ok(describeCompactionResult({ ...compacted, snapshot_persisted: false }).message.includes(`tokens. ${omitted} Could not save`));
  assert.ok(describeCompactionResult(compacted).message.includes(`tokens. ${omitted} Could not confirm`));
  assert.equal(describeCompactionResult({ ...compacted, summary_source_dropped_messages: 0, snapshot_persisted: true }).message.includes('omitted'), false);
  assert.equal(describeCompactionResult({ status: 'ok', compacted: false, summary_source_dropped_messages: 4 }).message.includes('omitted'), false);
});

// Owner gate P1: /compact on a short chat is refused by the sidecar with
// detail `no_reduction` (the summary would not be smaller). That is not a
// failure: it reads as a neutral notice and settles as success, so the slash
// command clears its input.
test('a short chat the summary cannot shrink reads as a neutral notice, not a failure', async () => {
  const shortChat = { status: 'error', reason: 'compaction_failed', detail: 'no_reduction' };
  assert.deepEqual(describeCompactionResult(shortChat), {
    state: 'success', message: 'Nothing to compact yet — this chat is already short.', tone: 'default', reason: 'not_needed',
  });
  // Every other compaction_failed detail keeps the failure copy.
  assert.equal(describeCompactionResult({ ...shortChat, detail: 'summary_not_created' }).message, 'Compaction failed.');
  const state = {};
  const coordinator = createCompactionCoordinator({ state, getChatApi: () => ({ compactNow: async () => shortChat }) });
  const settled = await coordinator.invoke('s1', { source: 'slash' });
  assert.equal(settled.activity.state, 'success');
  assert.equal(settled.activity.emphasis, 'subtle');
  assert.equal(settled.activity.message, 'Nothing to compact yet — this chat is already short.');
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

test('one compaction view: the inline row follows pending, a saved result is the divider, anything else is told once', async () => {
  const events = [];
  const results = [
    { status: 'ok', compacted: true, tokens_before: 5000, tokens_after: 900, snapshot_persisted: true },
    { status: 'ok', compacted: false },
    { status: 'error', reason: 'session_busy' },
  ];
  const coordinator = createCompactionCoordinator({
    state: {},
    getChatApi: () => ({ compactNow: async () => results.shift() }),
    callbacks: {
      onActivityChange: (sessionId, activity) => events.push(['row', sessionId, activity.pending]),
      notifySettled: (activity) => events.push(['told', activity.sessionId, activity.reason, activity.tone]),
    },
  });
  await coordinator.invoke('s1');
  await coordinator.invoke('s1');
  await coordinator.invoke('s1');
  assert.deepEqual(events, [
    ['row', 's1', true], ['row', 's1', false],
    ['row', 's1', true], ['row', 's1', false], ['told', 's1', 'not_needed', 'default'],
    ['row', 's1', true], ['row', 's1', false], ['told', 's1', 'session_busy', 'warning'],
  ]);
});

// The composer is disabled while a compaction is pending (isSendBusy), so the
// settle must re-render it: a missing ctx.renderComposerState kept it locked
// until a chat switch. The app wiring passes it through a ctx overlay
// (renderer-app-controller-composition.js; guarded in renderer-app-split.test.js).
test('the app coordinator re-renders the composer, the activity row and the timeline when a compaction settles', async () => {
  const calls = [];
  const noted = [];
  const state = { streamWaits: { noteSessionCompaction: (sessionId, pending) => noted.push([sessionId, pending]) } };
  const coordinator = createAppCompactionCoordinator({
    state,
    window: { jennyShell: { chat: { compactNow: async () => ({ status: 'ok', compacted: true, tokens_before: 4000, tokens_after: 800, snapshot_persisted: true }) } } },
    renderComposerState: () => calls.push('composer'),
    renderMessages: () => calls.push('messages'),
    refreshSessionSummaries: async () => calls.push('summaries'),
    showToastMessage: () => calls.push('toast'),
  });
  const settled = await coordinator.invoke('s1', { source: 'slash' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled.activity.reason, 'persisted');
  assert.deepEqual(noted, [['s1', true], ['s1', false]]);
  assert.equal(calls.filter((entry) => entry === 'composer').length, 2, 'pending and settled both re-render the composer');
  assert.deepEqual(calls.filter((entry) => entry !== 'composer'), ['summaries', 'messages'], 'the divider repaints after the summary refresh; no toast');
});

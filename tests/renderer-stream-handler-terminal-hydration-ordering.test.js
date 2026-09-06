// Regression coverage for preserved-local-message PLACEMENT during terminal
// hydration merge. mergeTerminalHydratedMessages (renderer-stream-handler-
// terminal.js) keeps a "local-only" message (present in the renderer's live
// list but missing from the store-hydrated snapshot) as a safety net against
// losing it — see renderer-stream-handler-terminal-hydration-dedup.test.js for
// that preservation behavior. This file covers WHERE the preserved message
// lands: it must be reinserted at its original relative position (anchored to
// the nearest preceding message that also exists in the hydrated snapshot),
// not appended after everything else. A concat-at-end merge silently moves a
// preserved user prompt below the assistant reply that answered it, which is
// exactly the ordering bug a live incident surfaced.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeferred } = require('./helpers/deferred');
const {
  createHarness,
  flushMicrotasks,
} = require('./helpers/renderer-stream-handler-buffering-harness');

function createDeferredHydrationHarness(t, { captureLogs = false } = {}) {
  const terminalHydration = createDeferred();
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return terminalHydration.promise;
            },
          },
        },
      },
    },
    ...(captureLogs
      ? {
        callbackOverrides: {
          appendClientLog(level, event, data) {
            logs.push({ level, event, data });
          },
        },
      }
      : {}),
  });
  t.after(() => harness.restore());
  return { harness, terminalHydration, logs };
}

test('terminal hydration reinserts a preserved local-only message at its original position, not the end', async (t) => {
  const { harness, terminalHydration, logs } = createDeferredHydrationHarness(t, { captureLogs: true });

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-order' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-order', aggregate: 'Second answer' });
  const completePromise = harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-order', content: 'Second answer' });
  await flushMicrotasks(20);

  const assistant2 = harness.state.messagesBySession.get('session-1')[0];
  // THE INCIDENT SHAPE: current = [user1, assistant1, user2, assistant2]. The
  // store lost user2 (e.g. a persistence race), so hydrated is the same list
  // MINUS user2. user2 must reappear between assistant1 and assistant2 — its
  // original position — not after assistant2.
  const user1 = { id: 'user_stream-first', role: 'user', content: 'First prompt', status: 'complete' };
  const assistant1 = { id: 'assistant_stream-first', role: 'assistant', content: 'First answer', status: 'complete' };
  const user2 = { id: 'user_local_1700000000010_deadbeef', role: 'user', content: 'Second prompt', status: 'complete' };

  harness.state.messagesBySession.set('session-1', [user1, assistant1, user2, assistant2]);
  terminalHydration.resolve({ data: [user1, assistant1, assistant2] });
  await completePromise;

  const finalMessages = harness.state.messagesBySession.get('session-1');
  assert.deepEqual(
    finalMessages.map((message) => message.id),
    ['user_stream-first', 'assistant_stream-first', 'user_local_1700000000010_deadbeef', 'assistant_stream-order'],
    'the preserved local-only user2 must be reinserted immediately after its anchor (assistant1), not appended at the end'
  );
  assert.equal(
    logs.some((entry) => entry.event === 'stream.terminal_hydration_preserved_local_messages'),
    true,
    'preserving a local-only message should still log the existing WARN event'
  );
});

test('a preserved local-only message with no preceding anchor lands at the front', async (t) => {
  const { harness, terminalHydration } = createDeferredHydrationHarness(t);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-front' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-front', aggregate: 'Answer' });
  const completePromise = harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-front', content: 'Answer' });
  await flushMicrotasks(20);

  const assistantComplete = harness.state.messagesBySession.get('session-1')[0];
  // orphanUser precedes everything in `current`, and its only preceding
  // messages (none) are missing from hydrated — so it has no anchor and must
  // land at the FRONT of the merged output, ahead of all hydrated messages.
  const orphanUser = { id: 'user_local_1700000000020_front0001', role: 'user', content: 'Orphan prompt', status: 'complete' };

  harness.state.messagesBySession.set('session-1', [orphanUser, assistantComplete]);
  terminalHydration.resolve({ data: [assistantComplete] });
  await completePromise;

  const finalMessages = harness.state.messagesBySession.get('session-1');
  assert.deepEqual(
    finalMessages.map((message) => message.id),
    ['user_local_1700000000020_front0001', 'assistant_stream-front'],
    'a local-only message with no preceding anchor must be placed at the front of the merged list'
  );
});

test('order among two preserved local-only messages sharing the same anchor is stable', async (t) => {
  const { harness, terminalHydration } = createDeferredHydrationHarness(t);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-shared' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-shared', aggregate: 'Reply' });
  const completePromise = harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-shared', content: 'Reply' });
  await flushMicrotasks(20);

  const assistantComplete = harness.state.messagesBySession.get('session-1')[0];
  const anchor = { id: 'user_stream-anchor', role: 'user', content: 'Anchor prompt', status: 'complete' };
  // Two local-only messages both immediately following `anchor` in `current`;
  // both missing from hydrated. Their relative order (local-A before local-B)
  // must be preserved after reinsertion.
  const localA = { id: 'user_local_1700000000030_aaaaaaaa', role: 'user', content: 'Local A', status: 'complete' };
  const localB = { id: 'user_local_1700000000031_bbbbbbbb', role: 'user', content: 'Local B', status: 'complete' };

  harness.state.messagesBySession.set('session-1', [anchor, localA, localB, assistantComplete]);
  terminalHydration.resolve({ data: [anchor, assistantComplete] });
  await completePromise;

  const finalMessages = harness.state.messagesBySession.get('session-1');
  assert.deepEqual(
    finalMessages.map((message) => message.id),
    ['user_stream-anchor', 'user_local_1700000000030_aaaaaaaa', 'user_local_1700000000031_bbbbbbbb', 'assistant_stream-shared'],
    'both local-only messages must follow their shared anchor in original relative order'
  );
});

test('existing behavior pin: when hydrated contains everything in current, output equals hydrated exactly', async (t) => {
  const { harness, terminalHydration, logs } = createDeferredHydrationHarness(t, { captureLogs: true });

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-full' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-full', aggregate: 'Complete answer' });
  const completePromise = harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-full', content: 'Complete answer' });
  await flushMicrotasks(20);

  const assistantComplete = harness.state.messagesBySession.get('session-1')[0];
  const user1 = { id: 'user_stream-full', role: 'user', content: 'A prompt', status: 'complete' };

  harness.state.messagesBySession.set('session-1', [user1, assistantComplete]);
  terminalHydration.resolve({ data: [user1, assistantComplete] });
  await completePromise;

  const finalMessages = harness.state.messagesBySession.get('session-1');
  assert.deepEqual(
    finalMessages.map((message) => message.id),
    ['user_stream-full', 'assistant_stream-full'],
    'when hydrated already contains everything, output must equal hydrated exactly with no reordering'
  );
  assert.equal(
    logs.some((entry) => entry.event === 'stream.terminal_hydration_preserved_local_messages'),
    false,
    'nothing should be preserved (and therefore nothing logged) when hydrated has full coverage'
  );
});

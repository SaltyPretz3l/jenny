// Regression coverage for the duplicate user-bubble bug: terminal hydration must
// reconcile an optimistic user message (random `user_local_*` id) against its
// persisted twin (`user_<streamId>`) by content rather than re-appending the
// orphan id at the tail. See mergeTerminalHydratedMessages in
// renderer/chat/renderer-stream-handler-terminal.js.
//
// NOTE: the complete-emit promise blocks on getMessages until the test resolves
// terminalHydration, so it MUST be assigned (not awaited) before the local store
// is mutated and hydration is resolved — awaiting it earlier deadlocks.
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

test('terminal hydration does not re-append an optimistic user bubble already present under its persisted id', async (t) => {
  const { harness, terminalHydration, logs } = createDeferredHydrationHarness(t, { captureLogs: true });

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-dup' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-dup', aggregate: 'An answer' });
  const completePromise = harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-dup', content: 'An answer' });
  await flushMicrotasks(20);

  const localComplete = harness.state.messagesBySession.get('session-1')[0];
  // Local store carries the optimistic user bubble (random user_local_* id) plus a
  // stream-tied tool artifact, so it is longer than the persisted snapshot.
  harness.state.messagesBySession.set('session-1', [
    localComplete,
    {
      id: 'tool_use_stream-dup_call-x',
      role: 'assistant',
      kind: 'tool_use',
      status: 'complete',
      tool_call: { call_id: 'call-x', tool_name: 'Read', parent_stream_id: 'stream-dup' },
    },
    { id: 'user_local_1700000000000_abcd1234', role: 'user', content: 'Hello', status: 'complete' },
  ]);
  // Persisted snapshot holds the SAME prompt under the backend's deterministic id.
  terminalHydration.resolve({
    data: [
      { id: 'user_stream-dup', role: 'user', content: 'Hello', status: 'complete' },
      localComplete,
    ],
  });
  await completePromise;

  const finalMessages = harness.state.messagesBySession.get('session-1');
  assert.deepEqual(
    finalMessages.map((message) => message.id),
    ['user_stream-dup', 'assistant_stream-dup'],
    'the persisted user bubble must appear once and the optimistic copy must not be re-appended'
  );
  assert.equal(
    finalMessages.filter((message) => String(message.id).startsWith('user_local_')).length,
    0,
    'no optimistic user_local_* row should survive once its persisted twin is hydrated'
  );
  assert.equal(
    logs.some((entry) => entry.event === 'stream.terminal_hydration_preserved_local_messages'),
    false,
    'a duplicate optimistic user bubble must not be preserved'
  );
});

test('terminal hydration still preserves a genuinely-new optimistic user prompt with no persisted twin', async (t) => {
  const { harness, terminalHydration, logs } = createDeferredHydrationHarness(t, { captureLogs: true });

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-new' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-new', aggregate: 'First answer' });
  const completePromise = harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-new', content: 'First answer' });
  await flushMicrotasks(20);

  const localComplete = harness.state.messagesBySession.get('session-1')[0];
  // A brand-new prompt typed after the turn — an optimistic user_local_* row whose
  // content is NOT in the hydrated snapshot. Must be kept (not lost), proving the
  // fix keys on content-match, not on the user_local_ prefix.
  harness.state.messagesBySession.set('session-1', [
    localComplete,
    { id: 'user_local_1700000000001_ef567890', role: 'user', content: 'Brand new prompt', status: 'complete' },
  ]);
  terminalHydration.resolve({ data: [localComplete] });
  await completePromise;

  const finalMessages = harness.state.messagesBySession.get('session-1');
  assert.deepEqual(
    finalMessages.map((message) => message.id),
    ['assistant_stream-new', 'user_local_1700000000001_ef567890'],
    'a genuinely-new optimistic prompt with no persisted twin must be preserved'
  );
  assert.equal(
    logs.some((entry) => entry.event === 'stream.terminal_hydration_preserved_local_messages'),
    true,
    'preserving a genuinely-new local prompt should still log'
  );
});

test('terminal hydration preserves only the surplus when the same prompt is sent twice (multiset)', async (t) => {
  const { harness, terminalHydration } = createDeferredHydrationHarness(t);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-multi' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-multi', aggregate: 'An answer' });
  const completePromise = harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-multi', content: 'An answer' });
  await flushMicrotasks(20);

  const localComplete = harness.state.messagesBySession.get('session-1')[0];
  // Two optimistic copies of identical text; only one is persisted. The first
  // consumes the single hydrated match (dropped); the second is genuinely
  // unpersisted and must survive.
  harness.state.messagesBySession.set('session-1', [
    localComplete,
    { id: 'user_local_1700000000002_aaaaaaaa', role: 'user', content: 'Repeat me', status: 'complete' },
    { id: 'user_local_1700000000003_bbbbbbbb', role: 'user', content: 'Repeat me', status: 'complete' },
  ]);
  terminalHydration.resolve({
    data: [
      { id: 'user_stream-multi', role: 'user', content: 'Repeat me', status: 'complete' },
      localComplete,
    ],
  });
  await completePromise;

  const finalMessages = harness.state.messagesBySession.get('session-1');
  assert.deepEqual(
    finalMessages.map((message) => message.id),
    ['user_stream-multi', 'assistant_stream-multi', 'user_local_1700000000003_bbbbbbbb'],
    'exactly one optimistic copy survives when one of two identical prompts is persisted'
  );
});

test('terminal hydration distinguishes attachments-only prompts by attachment id, not just empty content', async (t) => {
  const { harness, terminalHydration } = createDeferredHydrationHarness(t);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-attach' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-attach', aggregate: 'Here you go' });
  const completePromise = harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-attach', content: 'Here you go' });
  await flushMicrotasks(20);

  const localComplete = harness.state.messagesBySession.get('session-1')[0];
  // Two attachments-only optimistic bubbles: both empty text, DIFFERENT attachment
  // ids. The genuinely-new one (image_B) is FIRST; the persisted twin (image_A) is
  // second. Under content-only keying both key to '' and the first row would wrongly
  // consume the single hydrated count, dropping the genuinely-new prompt. The
  // attachment-id digest keeps them distinct so only the persisted image_A is deduped.
  harness.state.messagesBySession.set('session-1', [
    localComplete,
    { id: 'user_local_new_imageB', role: 'user', content: '', status: 'complete', attachments: [{ id: 'image_B', kind: 'image' }] },
    { id: 'user_local_dup_imageA', role: 'user', content: '', status: 'complete', attachments: [{ id: 'image_A', kind: 'image' }] },
  ]);
  terminalHydration.resolve({
    data: [
      { id: 'user_stream-attach', role: 'user', content: '', status: 'complete', attachments: [{ id: 'image_A', kind: 'image' }] },
      localComplete,
    ],
  });
  await completePromise;

  const finalMessages = harness.state.messagesBySession.get('session-1');
  assert.deepEqual(
    finalMessages.map((message) => message.id),
    ['user_stream-attach', 'assistant_stream-attach', 'user_local_new_imageB'],
    'the persisted image_A bubble dedupes; the distinct genuinely-new image_B bubble survives'
  );
});

test('terminal hydration does not collide prompts that differ only in internal whitespace', async (t) => {
  const { harness, terminalHydration } = createDeferredHydrationHarness(t);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-ws' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-ws', aggregate: 'Done' });
  const completePromise = harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-ws', content: 'Done' });
  await flushMicrotasks(20);

  const localComplete = harness.state.messagesBySession.get('session-1')[0];
  // 'a  b' (two spaces) is a genuinely-new prompt placed FIRST; 'a b' (one space) is
  // the persisted twin placed second. The old key collapsed all internal whitespace,
  // so both keyed to 'a b' and the first row ('a  b') would wrongly absorb the single
  // hydrated count and be dropped. Trimming-only keeps internal whitespace distinct.
  harness.state.messagesBySession.set('session-1', [
    localComplete,
    { id: 'user_local_ws_new', role: 'user', content: 'a  b', status: 'complete' },
    { id: 'user_local_ws_dup', role: 'user', content: 'a b', status: 'complete' },
  ]);
  terminalHydration.resolve({
    data: [
      { id: 'user_stream-ws', role: 'user', content: 'a b', status: 'complete' },
      localComplete,
    ],
  });
  await completePromise;

  const finalMessages = harness.state.messagesBySession.get('session-1');
  assert.deepEqual(
    finalMessages.map((message) => message.id),
    ['user_stream-ws', 'assistant_stream-ws', 'user_local_ws_new'],
    'the persisted "a b" bubble dedupes; the distinct "a  b" bubble survives'
  );
});

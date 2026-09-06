'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSendOutbox } = require('../renderer/chat/renderer-send-outbox');
const { createQueuedSendDispatcher } = require('../renderer/chat/renderer-send-outbox-dispatch');
const { createComposerSessionState } = require('../renderer/chat/renderer-composer-session-state');

function makeHarness({ sendResults, maxAutoRetries } = {}) {
  const state = {};
  const outbox = createSendOutbox(state);
  const scheduled = [];
  const logs = [];
  const sendCalls = [];
  const sendOptions = [];
  const cleared = [];
  const results = Array.isArray(sendResults) ? sendResults.slice() : [];
  const dispatch = createQueuedSendDispatcher({
    sendOutbox: outbox,
    getQueuedSend: (sessionId) => outbox.peek(sessionId),
    isSessionBusy: () => false,
    hasPendingToolApprovalForSession: () => false,
    isDockApprovalSteerActive: () => false,
    startPromptSend: async (prompt, options) => {
      sendCalls.push(prompt);
      sendOptions.push(options);
      return results.length ? results.shift() : true;
    },
    renderComposerState: () => {},
    renderSessions: () => {},
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
    setTimeoutImpl: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length - 1;
    },
    clearTimeoutImpl: (timer) => cleared.push(timer),
    ...(maxAutoRetries !== undefined ? { maxAutoRetries } : {}),
  });
  return { outbox, dispatch, scheduled, cleared, logs, sendCalls, sendOptions };
}

test('a failed head auto-retries on a scheduled backoff and drains the queue behind it', async () => {
  const { outbox, dispatch, scheduled, sendCalls } = makeHarness({
    sendResults: [false, true, true],
  });
  outbox.enqueue('s1', { prompt: 'first', status: 'ready' });
  outbox.enqueue('s1', { prompt: 'second', status: 'ready' });

  // First dispatch fails: the head is marked failed with a retry budget and a
  // backoff retry is scheduled — nothing requires a composer or a new turn.
  assert.equal(await dispatch('s1'), false);
  assert.equal(outbox.peek('s1').status, 'failed');
  assert.equal(outbox.peek('s1').failure.autoRetryCount, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 2000);

  // The scheduled retry re-dispatches the same head; success removes it.
  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sendCalls, ['first', 'first']);
  assert.equal(outbox.peek('s1').prompt, 'second');

  // The next drain trigger sends the unblocked second entry.
  assert.equal(await dispatch('s1'), true);
  assert.equal(outbox.peek('s1'), null);
});

test('auto-retry budget is bounded; an exhausted head stays failed until manual retry resets it', async () => {
  const { outbox, dispatch, scheduled, logs } = makeHarness({
    sendResults: [false, false, false, false],
    maxAutoRetries: 2,
  });
  outbox.enqueue('s1', { prompt: 'stuck', status: 'ready' });

  assert.equal(await dispatch('s1'), false);
  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  scheduled[1].callback();
  await new Promise((resolve) => setImmediate(resolve));

  // Third failure exceeds maxAutoRetries=2: no further timer, exhaustion logged.
  assert.equal(scheduled.length, 2);
  assert.equal(outbox.peek('s1').status, 'failed');
  assert.equal(outbox.peek('s1').failure.autoRetryCount, 3);
  assert.ok(logs.some((entry) => entry.event === 'send.outbox_auto_retry_exhausted'));

  // A drain trigger (turn terminal) no longer touches the exhausted head.
  assert.equal(await dispatch('s1'), null);
  assert.equal(outbox.peek('s1').failure.autoRetryCount, 3);

  // Manual retry clears the failure record, restoring the auto-retry budget.
  const readyEntry = outbox.retry(outbox.peek('s1'));
  assert.equal(readyEntry.failure, null);
  assert.equal(await dispatch('s1'), false);
  assert.equal(outbox.peek('s1').failure.autoRetryCount, 1);
});

test('a drain trigger re-dispatches a failed head with remaining budget directly', async () => {
  const { outbox, dispatch, sendCalls } = makeHarness({ sendResults: [false, true] });
  outbox.enqueue('s1', { prompt: 'first', status: 'ready' });
  assert.equal(await dispatch('s1'), false);
  assert.equal(outbox.peek('s1').status, 'failed');

  // A turn terminal for the session calls the dispatcher again; the failed
  // head re-enters the drain without waiting for the backoff timer.
  assert.equal(await dispatch('s1'), true);
  assert.deepEqual(sendCalls, ['first', 'first']);
  assert.equal(outbox.peek('s1'), null);
});

test('a scheduled retry is a no-op when the failed head was removed or replaced meanwhile', async () => {
  const { outbox, dispatch, scheduled, sendCalls } = makeHarness({ sendResults: [false] });
  outbox.enqueue('s1', { prompt: 'first', status: 'ready' });
  assert.equal(await dispatch('s1'), false);
  assert.equal(scheduled.length, 1);

  outbox.remove(outbox.peek('s1'));
  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sendCalls, ['first']);
  assert.equal(outbox.peek('s1'), null);
});

test('duplicate dispatch activation shares one pending operation and one bridge call', async () => {
  let resolveSend;
  const state = {};
  const outbox = createSendOutbox(state);
  let calls = 0;
  const dispatch = createQueuedSendDispatcher({
    sendOutbox: outbox,
    getQueuedSend: (sessionId) => outbox.peek(sessionId),
    isSessionBusy: () => false,
    hasPendingToolApprovalForSession: () => false,
    isDockApprovalSteerActive: () => false,
    startPromptSend: () => { calls += 1; return new Promise((resolve) => { resolveSend = resolve; }); },
    renderComposerState: () => {},
    renderSessions: () => {},
  });
  outbox.enqueue('s1', { prompt: 'only once', status: 'ready' });
  const first = dispatch('s1');
  const second = dispatch('s1');
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveSend(true);
  await first;
});

test('dispatch transfers asset ownership and suppresses a duplicate failed-payload owner', async () => {
  const { outbox, dispatch, sendOptions } = makeHarness({ sendResults: [false] });
  outbox.enqueue('s1', { prompt: 'asset', status: 'ready', attachments: [{ assetPath: 'asset-a' }] });
  await dispatch('s1');
  assert.equal(sendOptions[0].recordFailedPayload, false);
  assert.equal(sendOptions[0].outboxDispatch, true);
  assert.equal(outbox.peek('s1').attachmentOwner, 'outbox');
});

test('background outbox dispatch preserves the target session composer record', async () => {
  const state = {
    currentSessionId: 'session_b',
    attachments: { queued: [{ id: 'b-file' }] },
    composerSessionState: new Map([['session_a', {
      sessionId: 'session_a',
      text: 'draft-a',
      selectionStart: 7,
      selectionEnd: 7,
      attachments: [{ id: 'a-file' }],
      generation: 0,
      draftRevision: 1,
      touchedAtMs: 1,
    }]]),
  };
  const composer = createComposerSessionState({
    state,
    getChatInput: () => ({ value: 'draft-b', selectionStart: 7, selectionEnd: 7 }),
  });
  const outbox = createSendOutbox(state);
  const dispatch = createQueuedSendDispatcher({
    sendOutbox: outbox,
    getQueuedSend: (sessionId) => outbox.peek(sessionId),
    isSessionBusy: () => false,
    hasPendingToolApprovalForSession: () => false,
    isDockApprovalSteerActive: () => false,
    startPromptSend: async (_prompt, options) => {
      composer.captureActive(options.sessionIdOverride, 'background-send');
      return true;
    },
    renderComposerState: () => {},
    renderSessions: () => {},
  });
  outbox.enqueue('session_a', { prompt: 'queued A', status: 'ready' });

  await dispatch('session_a');

  const record = state.composerSessionState.get('session_a');
  assert.equal(record.text, 'draft-a');
  assert.deepEqual(record.attachments, [{ id: 'a-file' }]);
  assert.ok(record.touchedAtMs > 1);
});

test('a stream-scoped stop hold is consumed only by its matching terminal drain', async () => {
  const { outbox, dispatch, sendCalls } = makeHarness();
  outbox.enqueue('s1', { prompt: 'queued after stop', status: 'ready' });
  dispatch.holdNextDispatch('s1', 'stream-stopped');

  assert.equal(await dispatch('s1', { streamId: 'stream-unrelated' }), null);
  assert.deepEqual(sendCalls, []);
  assert.equal(await dispatch('s1', { streamId: 'stream-stopped' }), null);
  assert.deepEqual(sendCalls, []);
  assert.equal(await dispatch('s1', { streamId: 'stream-later' }), true);
  assert.deepEqual(sendCalls, ['queued after stop']);
});

test('dispose cancels every owned auto-retry timer', async () => {
  const { outbox, dispatch, scheduled, cleared } = makeHarness({ sendResults: [false] });
  outbox.enqueue('s1', { prompt: 'retry later', status: 'ready' });
  await dispatch('s1');
  assert.equal(scheduled.length, 1);
  dispatch.dispose();
  assert.deepEqual(cleared, [0]);
});

test('dispose clears retry timers and prevents post-await outbox mutation', async () => {
  const cleared = [];
  let resolveSend;
  const state = {};
  const outbox = createSendOutbox(state);
  const dispatch = createQueuedSendDispatcher({
    sendOutbox: outbox,
    getQueuedSend: (sessionId) => outbox.peek(sessionId),
    isSessionBusy: () => false,
    hasPendingToolApprovalForSession: () => false,
    isDockApprovalSteerActive: () => false,
    startPromptSend: () => new Promise((resolve) => { resolveSend = resolve; }),
    renderComposerState: () => {},
    renderSessions: () => {},
    clearTimeoutImpl: (timer) => cleared.push(timer),
  });
  outbox.enqueue('s1', { prompt: 'pending', status: 'ready' });
  const pending = dispatch('s1');
  await Promise.resolve();
  dispatch.dispose();
  resolveSend(false);
  await pending;
  assert.equal(outbox.peek('s1').status, 'sending');
  assert.deepEqual(cleared, []);
});

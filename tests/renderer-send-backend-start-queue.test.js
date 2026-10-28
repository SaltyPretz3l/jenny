'use strict';

// Row 62: a Send while the engine starts waits in the outbox and drains on the
// ready transition (createBackendStartQueue in renderer/chat/renderer-send-outbox-dispatch.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createControllerHarness } = require('./helpers/send-controller-harness');
const { createBackendStartQueue } = require('../renderer/chat/renderer-send-outbox-dispatch');

test('claim parks only plain sends for a known chat while the engine starts', () => {
  const state = { backend: { phase: 'model_loading' } };
  const queue = createBackendStartQueue({ state, shell: null, getDispatch: () => async () => null });
  assert.equal(queue.claim('chat-1', false), true);
  assert.equal(queue.claim('', false), false, 'no chat yet: nothing to park');
  assert.equal(queue.claim('chat-1', true), false, 'edits, answers and replays never wait here');
  state.backend.phase = 'failed';
  assert.equal(queue.claim('chat-1', false), false, 'an offline backend refuses instead of queueing');
  state.backend.phase = 'ready';
  assert.equal(queue.claim('chat-1', false), false, 'a usable backend sends directly');
  queue.dispose();
});

test('a usable status push drains each parked chat once, after the shell stores the phase', async () => {
  const state = { backend: { phase: 'starting' } };
  let listener = null;
  const timers = [];
  const dispatched = [];
  const queue = createBackendStartQueue({
    state,
    shell: { backend: { onStatus: (fn) => { listener = fn; return () => { listener = null; }; } } },
    getDispatch: () => async (sessionId) => { dispatched.push(sessionId); return true; },
    setTimeoutImpl: (fn) => { timers.push(fn); return timers.length; },
  });
  queue.claim('chat-a', false);
  queue.claim('chat-b', false);
  listener({ phase: 'model_loading' });
  assert.equal(timers.length, 0, 'a still-starting push schedules nothing');
  listener({ phase: 'ready' });
  assert.equal(timers.length, 1);
  state.backend.phase = 'ready';
  timers.shift()();
  await Promise.resolve();
  assert.deepEqual(dispatched, ['chat-a', 'chat-b']);
  listener({ phase: 'ready' });
  assert.equal(timers.length, 0, 'nothing left to drain');
  queue.dispose();
  assert.equal(listener, null, 'dispose unsubscribes');
});

test('a send while the engine starts queues in the outbox and drains once the backend is ready (row 62)', async (t) => {
  let statusListener = null;
  let unsubscribed = 0;
  const harness = createControllerHarness([], {
    chatInputValue: 'Hello during startup',
    backendPhase: 'model_loading',
    shell: {
      backend: {
        onStatus: (listener) => { statusListener = listener; return () => { unsubscribed += 1; }; },
      },
    },
  });
  t.after(() => harness.restore());

  // Red before row 62: a starting backend returned null and the click did nothing.
  const result = await harness.controller.startPromptSend('Hello during startup');
  assert.deepEqual(result, { queued: true, sessionId: 'session-1' });
  assert.equal(harness.calls.startStream.length, 0, 'nothing streams while the engine starts');
  assert.equal(harness.chatInput.value, '', 'the draft moved into the outbox');
  assert.equal(typeof statusListener, 'function');

  statusListener({ phase: 'model_loading' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.calls.startStream.length, 0, 'a non-ready status does not drain');

  harness.state.backend.phase = 'ready';
  statusListener({ phase: 'ready' });
  for (let i = 0; i < 20 && harness.calls.startStream.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(harness.calls.startStream.length, 1, 'the queued message is sent once the backend is ready');
  assert.equal(harness.state.sendOutboxBySession.get('session-1'), undefined, 'the outbox is empty after the drain');

  harness.controller.dispose?.();
  assert.equal(unsubscribed, 1, 'dispose releases the status subscription');
});

test('an offline backend still refuses a send instead of queueing it', async (t) => {
  const harness = createControllerHarness([], { chatInputValue: 'Nobody home', backendPhase: 'failed' });
  t.after(() => harness.restore());
  assert.equal(await harness.controller.startPromptSend('Nobody home'), null);
  assert.equal(harness.state.sendOutboxBySession?.get?.('session-1'), undefined);
  assert.equal(harness.chatInput.value, 'Nobody home');
});

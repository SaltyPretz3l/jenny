const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FLUSH_RENDERABLE_BATCH_SIZE,
  RENDER_FRAME_YIELD_TIMEOUT_MS,
  isRenderableBufferedStreamEvent,
  waitForRenderFrame,
} = require('../renderer/chat/renderer-stream-handler-render-frame');

function createScheduledFrameEnvironment() {
  let frameCallback = null;
  let timeoutCallback = null;
  const calls = {
    canceledFrames: [],
    clearedTimeouts: [],
    timeoutDelays: [],
  };
  const globalRef = {
    requestAnimationFrame(callback) {
      frameCallback = callback;
      return 101;
    },
    cancelAnimationFrame(handle) {
      calls.canceledFrames.push(handle);
    },
    setTimeout(callback, delay) {
      timeoutCallback = callback;
      calls.timeoutDelays.push(delay);
      return 202;
    },
    clearTimeout(handle) {
      calls.clearedTimeouts.push(handle);
    },
  };
  return {
    calls,
    globalRef,
    runFrame() {
      assert.equal(typeof frameCallback, 'function');
      frameCallback(Date.now());
    },
    runTimeout() {
      assert.equal(typeof timeoutCallback, 'function');
      timeoutCallback();
    },
  };
}

test('render-frame helpers identify buffered renderable stream events', () => {
  assert.equal(FLUSH_RENDERABLE_BATCH_SIZE, 5);
  assert.equal(isRenderableBufferedStreamEvent({ type: 'delta' }), true);
  assert.equal(isRenderableBufferedStreamEvent({ type: ' thinking_status ' }), true);
  assert.equal(isRenderableBufferedStreamEvent({ type: 'started' }), false);
  assert.equal(isRenderableBufferedStreamEvent(null), false);
});

test('waitForRenderFrame resolves on animation frame and clears the bounded fallback timer', async () => {
  const env = createScheduledFrameEnvironment();
  const promise = waitForRenderFrame(env.globalRef);

  assert.deepEqual(env.calls.timeoutDelays, [RENDER_FRAME_YIELD_TIMEOUT_MS]);
  env.runFrame();
  await promise;

  assert.deepEqual(env.calls.canceledFrames, [101]);
  assert.deepEqual(env.calls.clearedTimeouts, [202]);
});

test('waitForRenderFrame resolves on fallback timer and cancels the pending animation frame', async () => {
  const env = createScheduledFrameEnvironment();
  const promise = waitForRenderFrame(env.globalRef);

  env.runTimeout();
  await promise;

  assert.deepEqual(env.calls.canceledFrames, [101]);
  assert.deepEqual(env.calls.clearedTimeouts, [202]);
});

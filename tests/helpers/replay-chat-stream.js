'use strict';

// Shared driver for the renderer replay tests: feeds recorded stream payloads
// through the harness shell the way the main process would. `emit` keeps the
// classic "deliver, then settle" step for the assertion region of a case.
// `post` delivers without settling, so the idle setup of a long replayed turn
// can deliver a whole batch and then wait ONCE on the state the batch builds
// (`waitFor`), instead of sleeping a fixed delay after every payload.

const { waitForUiState } = require('./wait-for-ui-state');

const DEFAULT_WAIT_TIMEOUT_MS = 20_000;

// Frame-scheduled work (stream paints, render queues) is queued on the window's
// requestAnimationFrame. Frames run in order, so once a frame requested NOW has
// fired, every frame callback queued before it has run: `flushFrames(window, 2)`
// is the deterministic form of "give the renderer a moment to paint", and a
// callback that chains one more frame is covered by the second pass.
async function flushFrames(window, count = 2) {
  for (let pass = 0; pass < count; pass += 1) {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  }
}

function createReplayEmitter({ window, shell, sessionId, streamId }) {
  let aggregate = '';
  const build = (payload) => {
    const full = { sessionId, streamId, ...payload };
    if (payload.type === 'delta') {
      aggregate += payload.content || '';
      full.aggregate = aggregate;
    }
    return full;
  };
  const post = async (payload) => { await shell.__emitChat(build(payload)); };
  // Deliver, then let `frames` animation frames run so the paints the payload
  // scheduled have landed (see flushFrames).
  const emit = async (payload, frames = 2) => {
    await post(payload);
    await flushFrames(window, frames);
  };
  const postAll = async (payloads) => {
    for (const payload of payloads) await post(payload);
  };
  // Resolves when `predicate()` holds; fails the case with `message` after the timeout.
  const waitFor = (predicate, message, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) => waitForUiState(window, predicate, {
    timeoutMs,
    stepMs: 10,
    message: `timed out waiting for ${message}`,
  });
  const flush = (count) => flushFrames(window, count);
  // The send is accepted once the renderer has registered the stream as active.
  const waitForActiveStream = () => waitFor(() => window.__rendererState.activeStreamId === streamId, `${streamId} to become the active stream`);
  return { emit, post, postAll, waitFor, flush, waitForActiveStream };
}

module.exports = { createReplayEmitter, flushFrames };

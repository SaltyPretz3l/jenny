'use strict';

const assert = require('node:assert/strict');

// Poll until `predicate()` is truthy, yielding to the window's task queue between
// checks. Returns as soon as the condition holds instead of sleeping a fixed
// duration: deterministic (near-zero) latency on a fast machine and robust on a
// slow CI runner, where a fixed `await waitForUi(window, N)` either wastes time
// or flakes when the work lands just after N. Shared across the renderer (jsdom)
// suite.
async function waitForUiState(window, predicate, {
  timeoutMs = 1200,
  stepMs = 20,
  message = 'Timed out waiting for UI state.',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      assert.fail(message);
    }
    await new Promise((resolve) => window.setTimeout(resolve, stepMs));
  }
}

module.exports = { waitForUiState };

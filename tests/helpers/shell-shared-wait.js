'use strict';

const { waitForUiState } = require('./wait-for-ui-state');

/* Waits on the state a fixed sleep used to stand for. It is `waitForUiState` with the settings the shell
 * suites need: a 5 ms step, a 5 s limit, and a predicate that may throw while the element or state it
 * reads has not been built yet (that counts as not yet true). Like `waitForUiState` it fails the case on
 * timeout, naming the condition, so a missed wait is not followed by more waits before anything fails.
 * Use it for a condition that must BECOME true; a case that proves something does NOT happen still
 * needs its settle time. */
function waitForState(window, predicate, { timeoutMs = 5000, tickMs = 5 } = {}) {
  const holds = () => {
    try {
      return Boolean(predicate());
    } catch (_error) {
      return false;
    }
  };
  return waitForUiState(window, holds, {
    timeoutMs,
    stepMs: tickMs,
    message: `Timed out after ${timeoutMs} ms waiting for: ${predicate}`,
  });
}

module.exports = { waitForState };

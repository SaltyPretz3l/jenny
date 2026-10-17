'use strict';

// Overview groups its issues from the renderer's LIVE client-log ring, not from
// the stubbed snapshot entries. Monaco is unavailable by construction in this
// harness (renderer-shell-harness-dom.js stubs ensureScript to resolve false),
// so the renderer logs a genuine WARN renderer.monaco_fallback into the ring at
// boot. That ambient issue flipped the ready case to 'Warnings detected' and
// pushed a second row into the issue list. Seed the shared Monaco state as
// already-reported (it logs once per window) so the ring reflects only what the
// test itself emits.
const QUIET_MONACO_WINDOW_GLOBALS = {
  __jennyMonacoSharedState: {
    ready: false,
    failed: true,
    readyPromise: null,
    loaderConfigured: true,
    failureReason: 'harness',
    loggedFailure: true,
    requireErrorHookInstalled: true,
  },
};

const OBSERVED_SOURCES = {
  electron: { state: 'observed', capture_state: 'capturing', count: 1 },
  renderer: { state: 'observed', capture_state: 'capturing', count: 1 },
  sidecar: { state: 'observed', capture_state: 'capturing', count: 1 },
};

function inventoryRow(inventory, label) {
  return Array.from(inventory.querySelectorAll('div')).find(
    (candidate) => candidate.querySelector('dt')?.textContent === label,
  ) || null;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

module.exports = { QUIET_MONACO_WINDOW_GLOBALS, OBSERVED_SOURCES, inventoryRow, deferred };

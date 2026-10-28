'use strict';

// Per-chat main-process work in short time slices (row 62), yielding to the
// event loop between slices. Run in one go, the startup reconciles and the data
// overview's attachment count read every chat synchronously and blocked the
// main process for seconds on a large history, during boot, while the renderer
// waited on IPC. Reconcile steps catch their own errors.

const { performance } = require('node:perf_hooks');

const SLICE_BUDGET_MS = 8;

// A timer, not setImmediate: Electron pumps its own message loop between
// timer turns, so queued IPC is served while the steps are still running.
// Not unref'd: an awaited run (the data overview) must finish in a host
// where nothing else holds the event loop open.
function yieldToEventLoop() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

async function runStepsInSlices(steps, {
  budgetMs = SLICE_BUDGET_MS,
  now = () => performance.now(),
  yieldImpl = yieldToEventLoop,
} = {}) {
  let sliceStart = now();
  for (const step of steps) {
    step();
    if (now() - sliceStart >= budgetMs) {
      await yieldImpl();
      sliceStart = now();
    }
  }
}

// Same first tick as the setTimeout(() => service.reconcileOnStartup(), 0) it
// replaces; the steps are listed then, after the runtime's restart recovery.
function scheduleSlicedStartupReconcile(service, options = {}) {
  const timer = setTimeout(() => {
    let steps;
    try { steps = service.startupReconcileSteps(); } catch { return; }
    runStepsInSlices(steps, options).catch(() => {});
  }, 0);
  timer.unref?.();
  return timer;
}

module.exports = { SLICE_BUDGET_MS, runStepsInSlices, scheduleSlicedStartupReconcile };

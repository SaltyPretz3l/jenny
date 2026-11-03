'use strict';

// Row 96: the main window's taskbar button mirrors the most recently updated
// live test run (a foreground `tool_test_progress` stream or a running
// background job's progress.json): normal mode, `error` once a failure has
// landed, cleared when no live run remains. Desktop only: hosted mode never
// wires it. Updates are trailing-throttled to 4 per second.

const { isTerminalChatStreamType } = require('../chat-stream-bridge-support');

const MIN_UPDATE_GAP_MS = 250;
const MAX_FINISHED_CALLS = 32;

function createTestProgressTaskbar({
  getMainWindow = () => null,
  enabled = () => true,
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  /** @type {Map<string, {streamId: string, percent: number|null, failed: number, order: number}>} callId -> run */
  const foreground = new Map();
  const finished = new Set(); // call ids whose final event arrived
  /** @type {Map<string, {percent: number, failed: number, order: number}>} jobId -> run */
  const background = new Map();
  let order = 0;
  let applied = null; // {value, mode} last pushed to the taskbar, or null when cleared
  let lastApplyAt = -Infinity;
  let timer = null;
  let disposed = false;

  function liveWindow() {
    const win = getMainWindow();
    return win && !(typeof win.isDestroyed === 'function' && win.isDestroyed()) ? win : null;
  }

  function currentTarget() {
    let best = null;
    for (const run of [...foreground.values(), ...background.values()]) {
      if (run.percent !== null && (!best || run.order > best.order)) best = run;
    }
    return best && { value: Math.min(1, Math.max(0, best.percent / 100)), mode: best.failed > 0 ? 'error' : 'normal' };
  }

  function apply() {
    timer = null;
    const win = liveWindow();
    if (!win) return;
    const target = enabled() ? currentTarget() : null;
    if (!target) {
      if (applied) {
        win.setProgressBar(-1);
        lastApplyAt = now();
      }
      applied = null;
      return;
    }
    if (applied && applied.value === target.value && applied.mode === target.mode) return;
    win.setProgressBar(target.value, { mode: target.mode });
    applied = target;
    lastApplyAt = now();
  }

  function schedule() {
    if (disposed || timer !== null) return;
    const wait = Math.max(0, MIN_UPDATE_GAP_MS - (now() - lastApplyAt));
    if (wait === 0) {
      apply();
      return;
    }
    timer = setTimeoutImpl(apply, wait);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function handleChatStreamEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'tool_test_progress') {
      const callId = String(event.callId || '');
      if (!callId) return;
      // Batches leave the sidecar from several threads: a late or out-of-order one must not revive a run.
      const sequence = Number(event.sequence) || 0;
      if (finished.has(callId) || sequence < (foreground.get(callId)?.sequence ?? 0)) return;
      if (event.final === true) {
        foreground.delete(callId);
        finished.add(callId);
        if (finished.size > MAX_FINISHED_CALLS) finished.delete(finished.values().next().value);
      } else {
        order += 1;
        foreground.set(callId, {
          streamId: String(event.streamId || ''),
          percent: Number.isFinite(event.percent) ? event.percent : null,
          failed: Number(event.failed) || 0,
          order,
          sequence,
        });
      }
      schedule();
      return;
    }
    // Any terminal ends the stream's runs, a Stop or Deny included (unlike
    // isTurnSettledEvent, which only decides whether a chat is woken).
    if (!isTerminalChatStreamType(event.type)) return;
    const streamId = String(event.streamId || '');
    let removed = false;
    for (const [callId, run] of foreground) {
      if (run.streamId === streamId) {
        foreground.delete(callId);
        removed = true;
      }
    }
    if (removed) schedule();
  }

  /** @param {Array<Object>} jobs every tracker snapshot (getState().jobs) */
  function handleBackgroundJobs(jobs) {
    const live = new Set();
    for (const job of Array.isArray(jobs) ? jobs : []) {
      const progress = job && job.progress;
      const running = job && (job.state === 'running' || job.state === 'killing');
      if (!running || !progress || !Number.isFinite(progress.percent)) continue;
      live.add(job.jobId);
      const failed = Number(progress.failed) || 0;
      const previous = background.get(job.jobId);
      if (previous && previous.percent === progress.percent && previous.failed === failed) continue;
      order += 1;
      background.set(job.jobId, { percent: progress.percent, failed, order });
    }
    for (const jobId of [...background.keys()]) {
      if (!live.has(jobId)) background.delete(jobId);
    }
    schedule();
  }

  function dispose() {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
    disposed = true;
    foreground.clear();
    background.clear();
    const win = applied ? liveWindow() : null;
    applied = null;
    if (win) win.setProgressBar(-1);
  }

  return { handleChatStreamEvent, handleBackgroundJobs, dispose };
}

/**
 * Subscribe a taskbar to the backend's chat stream and the background-job
 * tracker. A listener fault must never reach the stream emitter.
 */
function wireTestProgressTaskbar(backendService, backgroundJobTracker, { getMainWindow, log = () => {} } = {}) {
  const taskbar = createTestProgressTaskbar({
    getMainWindow,
    enabled: () => backendService.featureFlags?.test_progress !== false,
  });
  const guarded = (event, work) => {
    try {
      work();
    } catch (error) {
      log('WARN', event, { message: String((error && error.message) || error) });
    }
  };
  backendService.on('chat-stream', (event) => guarded('test_progress_taskbar.stream_failed', () => taskbar.handleChatStreamEvent(event)));
  backgroundJobTracker.onChanged(() => guarded('test_progress_taskbar.jobs_failed', () => taskbar.handleBackgroundJobs(backgroundJobTracker.getState().jobs)));
  return taskbar;
}

module.exports = {
  MIN_UPDATE_GAP_MS,
  createTestProgressTaskbar,
  wireTestProgressTaskbar,
};

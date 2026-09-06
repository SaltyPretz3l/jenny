(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAgentStepUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function resolveAgentStepDisplay(step) {
    if (step && step.terminal === true && step.success === true) {
      return { state: 'ok', dot: 'ok' };
    }
    if (step && step.terminal === true && step.success !== true) {
      return { state: 'error', dot: 'error' };
    }
    const status = String((step && step.status) || '').trim().toLowerCase();
    if (status === 'running') {
      return { state: 'active', dot: 'active' };
    }
    if (status === 'failed') {
      return { state: 'error', dot: 'error' };
    }
    return { state: 'pending', dot: 'pending' };
  }

  function humanizeStage(raw) {
    return String(raw || '').trim().replace(/_/g, ' ');
  }

  function formatElapsed(step) {
    const start = Number(step && step.startedAt);
    const end = Number(step && step.updatedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return '';
    }
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    if (seconds < 60) {
      return seconds + 's';
    }
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder === 0 ? (minutes + 'm') : (minutes + 'm ' + remainder + 's');
  }

  return {
    resolveAgentStepDisplay,
    humanizeStage,
    formatElapsed,
  };
});

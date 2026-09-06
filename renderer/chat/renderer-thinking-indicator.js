/* renderer/chat/renderer-thinking-indicator.js – thinking/streaming indicator state machine (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererThinkingIndicatorUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const SHIMMER_DELAY_MS = 400;
  const MIN_DISPLAY_MS = 2000;
  const DURATION_FEEDBACK_MS = 400;

  function createThinkingIndicator(options) {
    const opts = options || {};
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const scheduleTimeout = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
    const cancelTimeout = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout;

    let mode = 'idle';
    let startedAt = 0;
    let completedAt = 0;
    let shimmerActive = false;
    let durationSeconds = 0;
    let showDurationFeedback = false;
    let shouldAutoHide = false;

    let shimmerTimerId = 0;
    let minDisplayTimerId = 0;
    let autoHideTimerId = 0;
    let durationFeedbackTimerId = 0;
    let minDisplayElapsed = true;
    let completePending = false;

    let onStateChange = opts.onStateChange || null;

    function markStartupAudit(name, details = {}) {
      try {
        globalThis.__jennyStartupAudit?.mark?.(name, details);
      } catch (_error) {
        // Best effort only.
      }
    }

    function notify() {
      if (typeof onStateChange === 'function') {
        onStateChange(getDisplayState());
      }
    }

    function clearAllTimers() {
      if (shimmerTimerId) { cancelTimeout(shimmerTimerId); shimmerTimerId = 0; }
      if (minDisplayTimerId) { cancelTimeout(minDisplayTimerId); minDisplayTimerId = 0; }
      if (autoHideTimerId) { cancelTimeout(autoHideTimerId); autoHideTimerId = 0; }
      if (durationFeedbackTimerId) { cancelTimeout(durationFeedbackTimerId); durationFeedbackTimerId = 0; }
    }

    function startIndicator(newMode) {
      clearAllTimers();
      mode = newMode || 'thinking';
      startedAt = now();
      completedAt = 0;
      shimmerActive = false;
      durationSeconds = 0;
      showDurationFeedback = false;
      shouldAutoHide = false;
      minDisplayElapsed = false;
      completePending = false;

      shimmerTimerId = scheduleTimeout(function enableShimmer() {
        shimmerTimerId = 0;
        shimmerActive = true;
        notify();
      }, SHIMMER_DELAY_MS);

      minDisplayTimerId = scheduleTimeout(function enableMinDisplay() {
        minDisplayTimerId = 0;
        minDisplayElapsed = true;
        if (completePending) {
          finishComplete();
        }
      }, MIN_DISPLAY_MS);

      notify();
      markStartupAudit('thinking-indicator-start', {
        mode,
        shimmerDelayMs: SHIMMER_DELAY_MS,
        minDisplayMs: MIN_DISPLAY_MS,
      });
    }

    function updateIndicator(newMode) {
      if (mode === 'idle') return;
      if (newMode && newMode !== mode) {
        mode = newMode;
      }
      notify();
    }

    function finishComplete() {
      mode = 'idle';
      durationSeconds = Math.round((completedAt - startedAt) / 1000);
      showDurationFeedback = durationSeconds >= 1;
      completePending = false;
      notify();

      if (showDurationFeedback) {
        durationFeedbackTimerId = scheduleTimeout(function hideDurationAndAutoHide() {
          durationFeedbackTimerId = 0;
          showDurationFeedback = false;
          shouldAutoHide = true;
          notify();
        }, DURATION_FEEDBACK_MS);
      } else {
        shouldAutoHide = true;
        notify();
      }
    }

    function completeIndicator() {
      if (mode === 'idle') return;
      completedAt = now();
      shimmerActive = false;
      if (shimmerTimerId) { cancelTimeout(shimmerTimerId); shimmerTimerId = 0; }

      if (minDisplayElapsed) {
        finishComplete();
      } else {
        completePending = true;
        notify();
      }
    }

    function getDisplayState() {
      const active = mode !== 'idle';
      const displayComplete = completedAt > 0 && !completePending;
      return {
        mode,
        shimmerActive: shimmerActive && !displayComplete,
        durationText: showDurationFeedback ? `thought for ${durationSeconds}s` : '',
        shouldShow: active || (completePending) || showDurationFeedback,
        shouldAutoHide,
        durationSeconds,
      };
    }

    function resetIndicator() {
      clearAllTimers();
      mode = 'idle';
      startedAt = 0;
      completedAt = 0;
      shimmerActive = false;
      durationSeconds = 0;
      showDurationFeedback = false;
      shouldAutoHide = false;
      minDisplayElapsed = true;
      completePending = false;
      notify();
    }

    function dispose() {
      clearAllTimers();
      mode = 'idle';
      onStateChange = null;
    }

    return {
      startIndicator,
      updateIndicator,
      completeIndicator,
      getDisplayState,
      resetIndicator,
      dispose,
    };
  }

  return {
    createThinkingIndicator,
    SHIMMER_DELAY_MS,
    MIN_DISPLAY_MS,
    DURATION_FEEDBACK_MS,
  };
});

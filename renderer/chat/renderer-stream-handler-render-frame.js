(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererStreamHandlerRenderFrame = factory(root.stringUtils || {
    normalizeString(value) {
      return String(value || '').trim();
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  const normalizeString = typeof stringUtils.normalizeString === 'function'
    ? stringUtils.normalizeString
    : function fallbackNormalizeString(value) {
      return String(value || '').trim();
    };
  const FLUSH_RENDERABLE_BATCH_SIZE = 5;
  // Hidden or occluded Electron windows can throttle animation frames, so
  // buffered catch-up needs a bounded fallback instead of waiting on rAF alone.
  const RENDER_FRAME_YIELD_TIMEOUT_MS = 32;

  function isRenderableBufferedStreamEvent(payload) {
    const type = normalizeString(payload?.type);
    return type === 'delta' || type === 'thinking_status';
  }

  function waitForRenderFrame(globalRefOverride) {
    const globalRef = globalRefOverride || (typeof globalThis !== 'undefined' ? globalThis : {});
    const requestFrame = typeof globalRef.requestAnimationFrame === 'function'
      ? globalRef.requestAnimationFrame.bind(globalRef)
      : (callback) => globalRef.setTimeout(callback, 16);
    const cancelFrame = typeof globalRef.cancelAnimationFrame === 'function'
      ? globalRef.cancelAnimationFrame.bind(globalRef)
      : (handle) => globalRef.clearTimeout?.(handle);
    const scheduleTimeout = typeof globalRef.setTimeout === 'function'
      ? globalRef.setTimeout.bind(globalRef)
      : null;
    const clearScheduledTimeout = typeof globalRef.clearTimeout === 'function'
      ? globalRef.clearTimeout.bind(globalRef)
      : () => {};
    return new Promise((resolve) => {
      let settled = false;
      let frameHandle = 0;
      let timeoutHandle = null;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (frameHandle) {
          cancelFrame(frameHandle);
        }
        if (timeoutHandle != null) {
          clearScheduledTimeout(timeoutHandle);
        }
        resolve();
      };
      frameHandle = requestFrame(finish);
      if (scheduleTimeout) {
        timeoutHandle = scheduleTimeout(finish, RENDER_FRAME_YIELD_TIMEOUT_MS);
      }
    });
  }

  return {
    FLUSH_RENDERABLE_BATCH_SIZE,
    RENDER_FRAME_YIELD_TIMEOUT_MS,
    isRenderableBufferedStreamEvent,
    waitForRenderFrame,
  };
});

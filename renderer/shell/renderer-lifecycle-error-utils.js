(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererLifecycleErrorUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GLOBAL_ERROR_DEDUPE_WINDOW_MS = 10_000;
  const GLOBAL_ERROR_DEDUPE_CACHE_MAX = 64;
  const ERROR_LOG_DEDUPE_WINDOW_MS = 60_000;
  const ERROR_LOG_DEDUPE_REPORT_LIMIT = 5;
  const ERROR_LOG_DEDUPE_CACHE_MAX = 64;

  function stringifyRejectionReason(reason) {
    if (reason && reason.message) {
      return String(reason.message);
    }
    if (typeof reason === 'string' && reason) {
      return reason;
    }
    if (reason && typeof reason === 'object') {
      try {
        const serialized = JSON.stringify(reason);
        if (serialized && serialized !== '{}') {
          return serialized;
        }
      } catch (_error) {
        /* fall through to a tag below */
      }
      return Object.prototype.toString.call(reason);
    }
    return String(reason || 'Unhandled promise rejection');
  }

  function normalizeGlobalErrorPayload(kind, sourceEvent) {
    if (kind === 'unhandledrejection') {
      // PromiseRejectionEvent.reason is a prototype accessor, so use `in` rather
      // than hasOwnProperty to preserve the rejection payload.
      const reason = sourceEvent && typeof sourceEvent === 'object' && 'reason' in sourceEvent
        ? sourceEvent.reason
        : sourceEvent;
      const message = stringifyRejectionReason(reason);
      const stack = String(reason && reason.stack || '');
      return {
        category: 'unhandled_promise_rejection',
        message,
        stack,
        file: '',
        line: 0,
        column: 0,
        error_code: 'CMP-RENDER-0002',
        retryable: true,
      };
    }
    const error = sourceEvent && sourceEvent.error ? sourceEvent.error : null;
    const eventMessage = String(sourceEvent && sourceEvent.message || '').trim();
    const errorMessage = String(error && error.message || '').trim();
    const normalizedMessage = eventMessage && eventMessage.toLowerCase() !== 'uncaught [object event]'
      ? eventMessage
      : errorMessage || eventMessage || 'Unhandled renderer exception';
    return {
      category: 'uncaught_error',
      message: normalizedMessage,
      stack: String(error && error.stack || ''),
      file: String(sourceEvent && sourceEvent.filename || ''),
      line: Number(sourceEvent && sourceEvent.lineno || 0) || 0,
      column: Number(sourceEvent && sourceEvent.colno || 0) || 0,
      error_code: 'CMP-RENDER-0001',
      retryable: true,
    };
  }

  function getGlobalErrorDedupeKey(errorPayload) {
    return [
      String(errorPayload.error_code || ''),
      String(errorPayload.category || ''),
      String(errorPayload.message || ''),
      String(errorPayload.file || ''),
      Number(errorPayload.line || 0),
      Number(errorPayload.column || 0),
    ].join('|');
  }

  function createRendererErrorLogSink(deps) {
    const settings = deps || {};
    const appendClientLog = typeof settings.appendClientLog === 'function'
      ? settings.appendClientLog
      : function noopAppendClientLog() {};
    const reportRendererError = typeof settings.reportRendererError === 'function'
      ? settings.reportRendererError
      : null;
    const beforeLog = typeof settings.beforeLog === 'function' ? settings.beforeLog : null;
    const getNow = typeof settings.getNow === 'function' ? settings.getNow : () => Date.now();
    const dedupeWindows = new Map();

    function flushWindow(dedupeKey, windowState) {
      dedupeWindows.delete(dedupeKey);
      const suppressedCount = Math.max(0, windowState.count - ERROR_LOG_DEDUPE_REPORT_LIMIT);
      if (suppressedCount > 0) {
        appendClientLog('ERROR', 'renderer.error_suppressed', {
          dedupe_key: dedupeKey,
          suppressed_count: suppressedCount,
          window_ms: ERROR_LOG_DEDUPE_WINDOW_MS,
        });
      }
    }

    function flushExpiredWindows(now) {
      for (const [dedupeKey, windowState] of dedupeWindows) {
        if (now - windowState.windowStart >= ERROR_LOG_DEDUPE_WINDOW_MS) {
          flushWindow(dedupeKey, windowState);
        }
      }
    }

    function logError(payload) {
      if (beforeLog) {
        beforeLog(payload);
      }
      appendClientLog('ERROR', 'renderer.global_error', payload);
      if (reportRendererError) {
        Promise.resolve(reportRendererError(payload)).catch(() => null);
      }
    }

    function report(payload) {
      const now = getNow();
      flushExpiredWindows(now);
      const dedupeKey = payload && payload.dedupe_key;
      if (!dedupeKey) {
        logError(payload);
        return;
      }

      let windowState = dedupeWindows.get(dedupeKey);
      if (!windowState) {
        if (dedupeWindows.size >= ERROR_LOG_DEDUPE_CACHE_MAX) {
          const oldestKey = dedupeWindows.keys().next().value;
          flushWindow(oldestKey, dedupeWindows.get(oldestKey));
        }
        windowState = { windowStart: now, count: 0 };
        dedupeWindows.set(dedupeKey, windowState);
      }
      windowState.count += 1;
      if (windowState.count <= ERROR_LOG_DEDUPE_REPORT_LIMIT) {
        logError(payload);
      }
    }

    return {
      clear() {
        // Detach (page unload) must still write the summary for a storm that
        // never got a later report to flush it.
        for (const [dedupeKey, windowState] of dedupeWindows) {
          flushWindow(dedupeKey, windowState);
        }
        dedupeWindows.clear();
      },
      report,
    };
  }

  function isHandledMonacoGlobalError(kind, sourceEvent) {
    if (kind !== 'error' || !sourceEvent) {
      return false;
    }
    const message = String(sourceEvent.message || '').trim().toLowerCase();
    const filename = String(sourceEvent.filename || sourceEvent.fileName || sourceEvent.target?.src || '').trim().toLowerCase();
    const pointsToMonaco = filename.includes('monaco-editor') || filename.includes('editor.main.js');
    if (!pointsToMonaco) {
      return false;
    }
    const error = sourceEvent.error;
    const errorMessage = String(error && error.message || error || '').trim().toLowerCase();
    const errorStack = String(error && error.stack || '').trim();
    const errorName = String(error && error.name || error?.constructor?.name || '').trim().toLowerCase();
    const hasMeaningfulErrorPayload = Boolean(
      errorStack
      || (errorMessage && errorMessage !== '[object event]' && errorMessage !== 'uncaught [object event]' && errorMessage !== 'script error.')
      || (errorName && errorName !== 'event' && errorName !== 'errorevent' && errorName !== 'progressevent')
    );
    if (hasMeaningfulErrorPayload) {
      return false;
    }
    return !message || message === 'uncaught [object event]' || message === 'script error.';
  }

  function isKnownBenignGlobalError(kind, sourceEvent) {
    if (kind !== 'error' || !sourceEvent) {
      return false;
    }
    const message = String(sourceEvent.message || '').trim();
    return message === 'ResizeObserver loop completed with undelivered notifications.'
      || message === 'ResizeObserver loop limit exceeded';
  }

  // The editor emits cancellation during model/view-state churn. Cancellation
  // is control flow, and requiring both fields avoids suppressing ordinary
  // application errors.
  function isBenignCancellationRejection(kind, sourceEvent) {
    if (kind !== 'unhandledrejection' || !sourceEvent || typeof sourceEvent !== 'object') {
      return false;
    }
    const reason = 'reason' in sourceEvent ? sourceEvent.reason : null;
    return Boolean(reason)
      && typeof reason === 'object'
      && String(reason.name || '') === 'Canceled'
      && String(reason.message || '') === 'Canceled';
  }

  function createRendererGlobalErrorBoundary(deps) {
    const settings = deps || {};
    const windowObject = settings.window || (typeof window !== 'undefined' ? window : null);
    const appendClientLog = typeof settings.appendClientLog === 'function'
      ? settings.appendClientLog
      : function noopAppendClientLog() {};
    const showToastMessage = typeof settings.showToastMessage === 'function'
      ? settings.showToastMessage
      : function noopShowToastMessage() {};
    const reportRendererError = typeof settings.reportRendererError === 'function'
      ? settings.reportRendererError
      : null;
    const reportError = typeof settings.reportError === 'function'
      ? settings.reportError
      : null;
    const getNow = typeof settings.getNow === 'function' ? settings.getNow : () => Date.now();
    const toastSource = settings.toastSource;
    const globalErrorDedupCache = new Map();
    let globalErrorHandler = null;
    let globalUnhandledRejectionHandler = null;

    function maybeShowGlobalErrorToast(errorPayload) {
      const signature = getGlobalErrorDedupeKey(errorPayload);
      const now = getNow();
      for (const [cachedSignature, timestamp] of globalErrorDedupCache) {
        if (now - Number(timestamp || 0) >= GLOBAL_ERROR_DEDUPE_WINDOW_MS) {
          globalErrorDedupCache.delete(cachedSignature);
        }
      }
      const previous = Number(globalErrorDedupCache.get(signature) || 0);
      globalErrorDedupCache.delete(signature);
      globalErrorDedupCache.set(signature, now);
      while (globalErrorDedupCache.size > GLOBAL_ERROR_DEDUPE_CACHE_MAX) {
        globalErrorDedupCache.delete(globalErrorDedupCache.keys().next().value);
      }
      if (previous && now - previous < GLOBAL_ERROR_DEDUPE_WINDOW_MS) {
        return signature;
      }
      /* EH-W9: route through intake when error_intake_routing is on —
       * the global-boundary row yields a deduped auto-dismiss warning
       * toast and an error-center record. The Monaco/ResizeObserver/
       * cancellation noise filters above stay inside the boundary.
       * reportError returns null when routing is off. */
      const routed = reportError
        ? reportError({
          message: 'A runtime error occurred. The app recovered; you can continue.',
          error_code: errorPayload.error_code,
          category: errorPayload.category,
          retryable: errorPayload.retryable,
          options: {
            title: 'Renderer Error',
            source: toastSource,
            dedupeKey: `renderer-global-error:${signature}`,
          },
        }, { origin: 'global-boundary' })
        : null;
      if (!routed) {
        showToastMessage(
          'A runtime error occurred. The app recovered; you can continue.',
          {
            title: 'Renderer Error',
            tone: 'warning',
            source: toastSource,
            dedupeKey: `renderer-global-error:${signature}`,
          }
        );
      }
      return signature;
    }

    const errorLogSink = createRendererErrorLogSink({
      appendClientLog,
      reportRendererError,
      getNow,
      beforeLog: maybeShowGlobalErrorToast,
    });

    function reportRendererGlobalError(kind, sourceEvent) {
      if (isBenignCancellationRejection(kind, sourceEvent)) {
        // Also suppress the devtools "Uncaught (in promise)" default report.
        if (typeof sourceEvent.preventDefault === 'function') {
          sourceEvent.preventDefault();
        }
        return;
      }
      if (isHandledMonacoGlobalError(kind, sourceEvent) || isKnownBenignGlobalError(kind, sourceEvent)) {
        return;
      }
      const errorPayload = normalizeGlobalErrorPayload(kind, sourceEvent);
      const payload = { ...errorPayload, dedupe_key: getGlobalErrorDedupeKey(errorPayload) };
      errorLogSink.report(payload);
    }

    function attach() {
      if (!windowObject || globalErrorHandler || globalUnhandledRejectionHandler) {
        return;
      }
      globalErrorHandler = (event) => {
        reportRendererGlobalError('error', event);
      };
      globalUnhandledRejectionHandler = (event) => {
        reportRendererGlobalError('unhandledrejection', event);
      };
      windowObject.addEventListener('error', globalErrorHandler);
      windowObject.addEventListener('unhandledrejection', globalUnhandledRejectionHandler);
    }

    function detach() {
      globalErrorDedupCache.clear();
      errorLogSink.clear();
      if (!windowObject) {
        return;
      }
      if (globalErrorHandler) {
        windowObject.removeEventListener('error', globalErrorHandler);
        globalErrorHandler = null;
      }
      if (globalUnhandledRejectionHandler) {
        windowObject.removeEventListener('unhandledrejection', globalUnhandledRejectionHandler);
        globalUnhandledRejectionHandler = null;
      }
    }

    return {
      attach,
      detach,
      reportRendererGlobalError,
    };
  }

  return {
    createRendererErrorLogSink,
    createRendererGlobalErrorBoundary,
    isBenignCancellationRejection,
    isHandledMonacoGlobalError,
    isKnownBenignGlobalError,
    normalizeGlobalErrorPayload,
  };
});

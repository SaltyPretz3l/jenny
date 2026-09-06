/**
 * renderer/shared/renderer-katex-runtime-loader.js - Lazy KaTeX runtime.
 *
 * ensureKatexRuntime() loads the engine on the first math render.
 */
/* global window, document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererKatexRuntimeLoader = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RETRY_COOLDOWN_MS = 30000;
  const MAX_LOAD_FAILURES = 3;

  function resolveScriptLoader() {
    if (typeof globalThis !== 'undefined' && globalThis.scriptLoaderUtils) {
      return globalThis.scriptLoaderUtils;
    }
    if (typeof require === 'function') {
      try {
        return require('./script-loader-utils');
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function getKatexScriptUrl() {
    try {
      return new URL('node_modules/katex/dist/katex.min.js', window.location.href).toString();
    } catch (_error) {
      return 'node_modules/katex/dist/katex.min.js';
    }
  }

  function isKatexRuntimeReady() {
    return typeof window !== 'undefined' && window.katex && typeof window.katex.renderToString === 'function';
  }

  let katexRuntimePromise = null;
  let consecutiveFailureCount = 0;
  let lastFailureAt = 0;

  function ensureKatexRuntime() {
    if (isKatexRuntimeReady()) {
      consecutiveFailureCount = 0;
      lastFailureAt = 0;
      return Promise.resolve(true);
    }
    if (typeof window === 'undefined') {
      return Promise.resolve(false);
    }
    if (katexRuntimePromise) {
      return katexRuntimePromise;
    }
    if (consecutiveFailureCount >= MAX_LOAD_FAILURES
        || (consecutiveFailureCount > 0 && Date.now() - lastFailureAt < RETRY_COOLDOWN_MS)) {
      return Promise.resolve(false);
    }
    const src = getKatexScriptUrl();
    let loadPromise;
    if (typeof window.define === 'function' && window.define.amd && typeof window.require === 'function') {
      loadPromise = new Promise((resolve) => {
        try {
          window.require([src], function onAmdLoad(mod) {
            if (!isKatexRuntimeReady() && mod && typeof mod.renderToString === 'function') {
              window.katex = mod;
            }
            resolve(isKatexRuntimeReady());
          }, function onAmdLoadError() {
            resolve(false);
          });
        } catch (_error) {
          resolve(false);
        }
      });
    } else {
      const loader = resolveScriptLoader();
      if (!loader || typeof loader.ensureScript !== 'function') {
        return Promise.resolve(false);
      }
      try {
        loadPromise = loader.ensureScript({
          src,
          isReady: isKatexRuntimeReady,
        });
      } catch (error) {
        loadPromise = Promise.reject(error);
      }
    }
    katexRuntimePromise = Promise.resolve(loadPromise).catch(function onLoadError(error) {
      // A rejected script load must resolve false (never propagate as an
      // unhandled rejection) and enter the same bounded retry path.
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[katex-runtime] failed to load KaTeX runtime:', error);
      }
      return false;
    }).then(function afterLoad(ok) {
      if (ok) {
        consecutiveFailureCount = 0;
        lastFailureAt = 0;
        return true;
      }
      consecutiveFailureCount += 1;
      lastFailureAt = Date.now();
      katexRuntimePromise = null;
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        const duration = consecutiveFailureCount >= MAX_LOAD_FAILURES
          ? 'for the rest of this page'
          : `for ${RETRY_COOLDOWN_MS} ms`;
        console.warn(`[katex-runtime] suppressing KaTeX runtime load retries ${duration}`);
      }
      return false;
    });
    return katexRuntimePromise;
  }

  function _resetForTests() {
    katexRuntimePromise = null;
    consecutiveFailureCount = 0;
    lastFailureAt = 0;
  }

  return {
    ensureKatexRuntime,
    isKatexRuntimeReady,
    _resetForTests,
  };
});

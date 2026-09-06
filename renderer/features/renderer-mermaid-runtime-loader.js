/**
 * renderer/features/renderer-mermaid-runtime-loader.js – Lazy Mermaid runtime.
 *
 * ensureMermaidRuntime() loads the engine on the first direct render and applies
 * protective initialization as soon as it is ready.
 *
 * The iframe preview path (createMermaidFrame / mermaid-frame.html) loads its
 * own mermaid inside the sandbox and does not depend on this module.
 */
/* global window, document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMermaidRuntimeLoader = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function resolveScriptLoader() {
    if (typeof globalThis !== 'undefined' && globalThis.scriptLoaderUtils) {
      return globalThis.scriptLoaderUtils;
    }
    if (typeof require === 'function') {
      try {
        return require('../shared/script-loader-utils');
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function getMermaidScriptUrl() {
    try {
      return new URL('node_modules/mermaid/dist/mermaid.min.js', window.location.href).toString();
    } catch (_error) {
      return 'node_modules/mermaid/dist/mermaid.min.js';
    }
  }

  function isMermaidRuntimeReady() {
    return typeof window !== 'undefined' && window.mermaid && typeof window.mermaid.render === 'function';
  }

  let mermaidRuntimePromise = null;

  function ensureMermaidRuntime() {
    if (isMermaidRuntimeReady()) {
      return Promise.resolve(true);
    }
    if (typeof window === 'undefined') {
      return Promise.resolve(false);
    }
    if (mermaidRuntimePromise) {
      return mermaidRuntimePromise;
    }
    const loader = resolveScriptLoader();
    if (!loader || typeof loader.ensureScript !== 'function') {
      return Promise.resolve(false);
    }
    mermaidRuntimePromise = loader.ensureScript({
      src: getMermaidScriptUrl(),
      isReady: isMermaidRuntimeReady,
    }).then(function afterLoad(ok) {
      if (ok && window.mermaid && typeof window.mermaid.initialize === 'function') {
        // Protective init the eager module-load block used to perform: disable
        // mermaid's startOnLoad auto-run and pin strict security.
        try {
          window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
        } catch (_error) {
          /* best-effort */
        }
      }
      if (!ok) {
        // Let a later render retry a runtime that failed to load.
        mermaidRuntimePromise = null;
      }
      return ok;
    }).catch(function onLoadError(error) {
      // A rejected script load must resolve false (never propagate as an
      // unhandled rejection) and clear the cache so a later render can retry.
      mermaidRuntimePromise = null;
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[mermaid-runtime] failed to load mermaid runtime:', error);
      }
      return false;
    });
    return mermaidRuntimePromise;
  }

  function _resetForTests() {
    mermaidRuntimePromise = null;
  }

  return {
    ensureMermaidRuntime,
    isMermaidRuntimeReady,
    _resetForTests,
  };
});

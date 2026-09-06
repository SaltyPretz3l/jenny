/**
 * renderer/features/renderer-ide-xterm-loader.js – Lazy xterm.js runtime.
 *
 * The terminal and fit addon load sequentially on the first explicit terminal
 * start. An already-ready runtime is a no-op.
 */
/* global window, document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeXtermLoader = factory();
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

  function resolveUrl(relativePath) {
    try {
      return new URL(relativePath, window.location.href).toString();
    } catch (_error) {
      return relativePath;
    }
  }

  function isTerminalReady() {
    return typeof window !== 'undefined' && typeof window.Terminal === 'function';
  }

  function isFitAddonReady() {
    if (typeof window === 'undefined') {
      return false;
    }
    const candidate = window.FitAddon && window.FitAddon.FitAddon
      ? window.FitAddon.FitAddon
      : window.FitAddon;
    return typeof candidate === 'function';
  }

  function isXtermRuntimeReady() {
    return isTerminalReady() && isFitAddonReady();
  }

  let xtermRuntimePromise = null;

  function loadSequential(loader) {
    return loader.ensureScript({
      src: resolveUrl('node_modules/@xterm/xterm/lib/xterm.js'),
      isReady: isTerminalReady,
    }).then(function afterTerminal(terminalOk) {
      if (!terminalOk) {
        return false;
      }
      return loader.ensureScript({
        src: resolveUrl('node_modules/@xterm/addon-fit/lib/addon-fit.js'),
        isReady: isFitAddonReady,
      });
    });
  }

  function ensureXtermRuntime() {
    if (isXtermRuntimeReady()) {
      return Promise.resolve(true);
    }
    if (typeof window === 'undefined') {
      return Promise.resolve(false);
    }
    if (xtermRuntimePromise) {
      return xtermRuntimePromise;
    }
    const loader = resolveScriptLoader();
    if (!loader || typeof loader.ensureScript !== 'function') {
      return Promise.resolve(false);
    }
    xtermRuntimePromise = loadSequential(loader).then(function afterLoad(ok) {
      if (!ok) {
        // Let a later Start attempt retry a runtime that failed to load.
        xtermRuntimePromise = null;
      }
      return ok;
    }).catch(function onLoadError(error) {
      // A rejected script load must resolve false (never propagate as an
      // unhandled rejection) and clear the cache so a later attempt can retry.
      xtermRuntimePromise = null;
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[ide-xterm-loader] failed to load xterm runtime:', error);
      }
      return false;
    });
    return xtermRuntimePromise;
  }

  function _resetForTests() {
    xtermRuntimePromise = null;
  }

  return {
    ensureXtermRuntime,
    isXtermRuntimeReady,
    _resetForTests,
  };
});

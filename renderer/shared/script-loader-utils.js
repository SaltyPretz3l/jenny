/**
 * renderer/shared/script-loader-utils.js – Lazy, idempotent <script> injection.
 *
 * Heavy renderer dependencies (the Monaco AMD loader, the ~3.2 MB Mermaid
 * runtime) are kept out of cold startup and injected on first need. This util
 * injects a <script> once per src and resolves when an expected global has
 * appeared, so call sites keep their existing `globalThis.<x> || require(...)`
 * fallbacks and only pay for these libraries when a feature actually uses them.
 *
 * In Electron renderer: exposes globalThis.scriptLoaderUtils.
 * In Node.js tests: resolves via require() (DOM-less; ensureScript no-ops to
 * `false` when there is no injectable document, letting callers fall back).
 */
/* global window, document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.scriptLoaderUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_TIMEOUT_MS = 15000;

  // In-flight / resolved injection promises keyed by src. A failed load drops
  // its entry so a later attempt can retry; a successful one is cached so
  // concurrent and repeat callers share the single injection.
  const pending = new Map();

  function getInjectableDocument() {
    if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
      return document;
    }
    return null;
  }

  function logEvent(log, level, event, details) {
    if (typeof log === 'function') {
      try {
        log(level, event, details);
        return;
      } catch (_error) {
        /* fall through to console */
      }
    }
    const logger = level === 'ERROR' ? console.error : console.warn;
    if (typeof logger === 'function') {
      logger('[renderer.script-loader]', event, details);
    }
  }

  /**
   * Inject a <script src> once and resolve when `isReady()` reports the
   * expected global is present.
   *
   * @param {object} options
   * @param {string} options.src - script URL (resolved against the document base, like an eager tag).
   * @param {() => boolean} [options.isReady] - readiness predicate (defaults to always-ready).
   * @param {number} [options.timeoutMs]
   * @param {(level: string, event: string, details: object) => void} [options.log]
   * @returns {Promise<boolean>} true once ready; false if unavailable / failed / timed out.
   */
  function ensureScript(options = {}) {
    const src = String(options.src || '').trim();
    const isReady = typeof options.isReady === 'function' ? options.isReady : function alwaysReady() { return true; };
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    const log = typeof options.log === 'function' ? options.log : null;

    function checkReady() {
      try {
        return Boolean(isReady());
      } catch (_error) {
        return false;
      }
    }

    // Already satisfied — the common case for tests and pre-loaded globals.
    if (checkReady()) {
      return Promise.resolve(true);
    }
    if (!src) {
      return Promise.resolve(false);
    }

    const doc = getInjectableDocument();
    if (!doc) {
      return Promise.resolve(false);
    }

    if (pending.has(src)) {
      return pending.get(src);
    }

    const promise = new Promise((resolve) => {
      let settled = false;
      let timeoutId = 0;
      const script = doc.createElement('script');

      function finish(ok) {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = 0;
        }
        if (!ok) {
          // Allow a later attempt to retry a failed/absent dependency, and
          // drop the dead element so the retry injects cleanly.
          pending.delete(src);
          if (script.parentNode) {
            try {
              script.parentNode.removeChild(script);
            } catch (_error) {
              /* ignore */
            }
          }
        }
        resolve(ok);
      }

      function handleLoad() {
        // The script body runs synchronously before `load` fires, so the
        // expected global should already be present.
        finish(checkReady());
      }

      function handleError() {
        logEvent(log, 'WARN', 'renderer.script_load_failed', { src });
        finish(false);
      }

      script.src = src;
      script.async = false;
      script.setAttribute('data-script-loader-src', src);
      script.addEventListener('load', handleLoad);
      script.addEventListener('error', handleError);
      const parent = doc.head || doc.body || doc.documentElement;
      if (!parent || typeof parent.appendChild !== 'function') {
        finish(false);
        return;
      }
      parent.appendChild(script);

      timeoutId = setTimeout(function onTimeout() {
        // Last-chance probe: a `load` event may not fire in every host even
        // when the expected global has appeared.
        finish(checkReady());
      }, timeoutMs);
    });

    pending.set(src, promise);
    return promise;
  }

  function _resetForTests() {
    pending.clear();
  }

  return {
    ensureScript,
    _resetForTests,
  };
});

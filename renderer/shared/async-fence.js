/* renderer/shared/async-fence.js
 *
 * The one shared answer to the renderer's disposal-fence / stale-continuation
 * bug class: async work that resolves after its owner was disposed, or after
 * its target changed, must not touch state or the DOM.
 *
 * Two tiny primitives, composable and dependency-free:
 *
 *   createDisposalFence() — an idempotent disposed latch. `guard(fn)` wraps a
 *   callback/timer/promise continuation so it no-ops once the owner is
 *   disposed; `onDispose(fn)` registers cleanup that runs exactly once (a
 *   registration after dispose fires immediately — late subscribers must not
 *   leak). A throwing cleanup never blocks the rest.
 *
 *   createGenerationGate() — a monotonic retarget counter, the same contract
 *   renderer-artifact-operation-target.js proved out: `capture()` an immutable
 *   token when async work STARTS, `bump()` on every retarget/reset, and check
 *   `isCurrent(token)` after every await before applying results.
 *
 * The canonical fix shape for a Wave B stale-continuation bug:
 *
 *   const token = gate.capture();
 *   const result = await slowWork();
 *   if (fence.isDisposed() || !gate.isCurrent(token)) return;
 *   applyResult(result);
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAsyncFence = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createDisposalFence() {
    let disposed = false;
    let cleanups = [];

    function isDisposed() {
      return disposed;
    }

    function dispose() {
      if (disposed) {
        return false;
      }
      disposed = true;
      const pending = cleanups;
      cleanups = [];
      for (const cleanup of pending) {
        try {
          cleanup();
        } catch (_error) {
          /* one cleanup throwing must not block the rest */
        }
      }
      return true;
    }

    function onDispose(cleanup) {
      if (typeof cleanup !== 'function') {
        return function noop() {};
      }
      if (disposed) {
        try {
          cleanup();
        } catch (_error) {
          /* mirror dispose(): a throwing cleanup is contained */
        }
        return function noop() {};
      }
      cleanups.push(cleanup);
      return function unregister() {
        const index = cleanups.indexOf(cleanup);
        if (index >= 0) {
          cleanups.splice(index, 1);
        }
      };
    }

    function guard(fn) {
      if (typeof fn !== 'function') {
        return function noop() {};
      }
      return function guarded(...args) {
        if (disposed) {
          return undefined;
        }
        return fn.apply(this, args);
      };
    }

    function throwIfDisposed(label) {
      if (disposed) {
        throw new Error(`${String(label || 'async-fence')}: owner is disposed`);
      }
    }

    return { isDisposed, dispose, onDispose, guard, throwIfDisposed };
  }

  function createGenerationGate() {
    let generation = 1;

    function current() {
      return generation;
    }

    function bump() {
      generation += 1;
      return generation;
    }

    function capture() {
      return Object.freeze({ generation });
    }

    function isCurrent(token) {
      return Boolean(token) && token.generation === generation;
    }

    function guard(token, fn) {
      if (typeof fn !== 'function') {
        return function noop() {};
      }
      return function guarded(...args) {
        if (!isCurrent(token)) {
          return undefined;
        }
        return fn.apply(this, args);
      };
    }

    return { current, bump, capture, isCurrent, guard };
  }

  return { createDisposalFence, createGenerationGate };
});

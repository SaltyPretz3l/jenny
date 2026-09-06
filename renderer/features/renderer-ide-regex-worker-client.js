'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeRegexWorkerClient = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const DEFAULT_DEADLINE_MS = 250;
  const MAX_DEADLINE_MS = 5_000;

  function regexError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function defaultCreateWorker() {
    if (typeof globalRef.Worker === 'function') {
      return new globalRef.Worker('./renderer/features/renderer-ide-regex-worker.js');
    }
    if (typeof require === 'function') {
      const { Worker } = require('node:worker_threads');
      const path = require('node:path');
      return new Worker(path.join(__dirname, 'renderer-ide-regex-worker.js'));
    }
    throw regexError('Regex worker is unavailable.', 'REGEX_UNAVAILABLE');
  }

  function createRegexWorkerEvaluator(options) {
    const opts = options || {};
    const createWorker = typeof opts.createWorker === 'function'
      ? opts.createWorker
      : defaultCreateWorker;
    const setTimeoutImpl = typeof opts.setTimeoutImpl === 'function' ? opts.setTimeoutImpl : setTimeout;
    const clearTimeoutImpl = typeof opts.clearTimeoutImpl === 'function' ? opts.clearTimeoutImpl : clearTimeout;
    const defaultDeadlineMs = Number.isSafeInteger(opts.defaultDeadlineMs) && opts.defaultDeadlineMs > 0
      ? Math.min(opts.defaultDeadlineMs, MAX_DEADLINE_MS)
      : DEFAULT_DEADLINE_MS;

    let worker = null;
    let pending = null;
    let nextId = 1;
    let disposed = false;

    function terminateWorker() {
      const current = worker;
      worker = null;
      if (!current) return;
      try {
        const termination = current.terminate();
        termination?.catch?.(() => {});
      } catch (_error) {
        /* best-effort worker cleanup */
      }
    }

    function cleanupRequest(request) {
      if (!request) return;
      if (request.timerId != null) clearTimeoutImpl(request.timerId);
      request.signal?.removeEventListener?.('abort', request.onAbort);
    }

    function rejectPending(error, { terminate = false } = {}) {
      const request = pending;
      pending = null;
      cleanupRequest(request);
      if (terminate) terminateWorker();
      request?.reject(error);
    }

    function handleMessage(raw) {
      const message = raw?.data === undefined ? raw : raw.data;
      if (!pending || Number(message?.id) !== pending.id) return;
      const request = pending;
      pending = null;
      cleanupRequest(request);
      if (message?.ok === true) {
        request.resolve(message.result);
        return;
      }
      request.reject(regexError(
        String(message?.error?.message || 'Regex evaluation failed.'),
        String(message?.error?.code || 'REGEX_EVALUATION_FAILED')
      ));
    }

    function handleWorkerFailure(error) {
      rejectPending(regexError(
        String(error?.message || 'Regex worker failed.'),
        'REGEX_WORKER_FAILED'
      ), { terminate: true });
    }

    function bindWorker(nextWorker) {
      const onMessage = (message) => {
        if (worker === nextWorker) handleMessage(message);
      };
      const onFailure = (error) => {
        if (worker === nextWorker) handleWorkerFailure(error);
      };
      if (typeof nextWorker.addEventListener === 'function') {
        nextWorker.addEventListener('message', onMessage);
        nextWorker.addEventListener('error', onFailure);
        return;
      }
      nextWorker.on?.('message', onMessage);
      nextWorker.on?.('error', onFailure);
      nextWorker.on?.('exit', (code) => {
        if (worker !== nextWorker) return;
        if (pending) handleWorkerFailure(new Error(`Regex worker exited before replying (${code}).`));
        else worker = null;
      });
    }

    function ensureWorker() {
      if (worker) return worker;
      worker = createWorker();
      if (!worker || typeof worker.postMessage !== 'function') {
        worker = null;
        throw regexError('Regex worker is unavailable.', 'REGEX_UNAVAILABLE');
      }
      bindWorker(worker);
      return worker;
    }

    function evaluate(task, evaluateOptions) {
      if (disposed) return Promise.reject(regexError('Regex evaluator is disposed.', 'REGEX_CANCELLED'));
      if (pending) return Promise.reject(regexError('Regex evaluator is busy.', 'REGEX_BUSY'));
      const signal = evaluateOptions?.signal;
      if (signal?.aborted) return Promise.reject(regexError('Regex evaluation was cancelled.', 'REGEX_CANCELLED'));
      const requestedDeadline = Number(evaluateOptions?.deadlineMs);
      const deadlineMs = Number.isSafeInteger(requestedDeadline) && requestedDeadline > 0
        ? Math.min(requestedDeadline, MAX_DEADLINE_MS)
        : defaultDeadlineMs;
      let activeWorker;
      try {
        activeWorker = ensureWorker();
      } catch (error) {
        return Promise.reject(error);
      }

      return new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const onAbort = () => rejectPending(
          regexError('Regex evaluation was cancelled.', 'REGEX_CANCELLED'),
          { terminate: true }
        );
        const timerId = setTimeoutImpl(() => rejectPending(
          regexError(`Regex evaluation exceeded ${deadlineMs} ms.`, 'REGEX_TIMEOUT'),
          { terminate: true }
        ), deadlineMs);
        pending = { id, resolve, reject, signal, onAbort, timerId };
        signal?.addEventListener?.('abort', onAbort, { once: true });
        try {
          activeWorker.postMessage({ id, task });
        } catch (error) {
          rejectPending(regexError(error?.message || 'Regex worker post failed.', 'REGEX_WORKER_FAILED'), {
            terminate: true,
          });
        }
      });
    }

    function cancel() {
      rejectPending(regexError('Regex evaluation was cancelled.', 'REGEX_CANCELLED'), { terminate: true });
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      terminateWorker();
    }

    return { evaluate, cancel, dispose };
  }

  return {
    createRegexWorkerEvaluator,
    DEFAULT_DEADLINE_MS,
    MAX_DEADLINE_MS,
  };
});

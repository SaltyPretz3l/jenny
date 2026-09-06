'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { WORKSPACE_FS_ERROR_CODES } = require('./backend/error-codes');

const ROOT_TRANSITIONING = WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING;
const DEFAULT_BUILD_TIMEOUT_MS = 5_000;
const MAX_BUILD_TIMEOUT_MS = 30_000;

function buildError(message, code = ROOT_TRANSITIONING) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_BUILD_TIMEOUT_MS;
  return Math.min(parsed, MAX_BUILD_TIMEOUT_MS);
}

function buildGraphFromPayload(payload) {
  const { buildGraph } = require('./workspace-file-map-engine');
  const contentByPath = new Map(Array.isArray(payload?.contentEntries) ? payload.contentEntries : []);
  return buildGraph({
    files: Array.isArray(payload?.files) ? payload.files : [],
    readContent(relPath) {
      if (!contentByPath.has(relPath)) {
        throw new Error('workspace-file-map: unreadable file');
      }
      return contentByPath.get(relPath);
    },
    cochangeCommits: Array.isArray(payload?.cochangeCommits) ? payload.cochangeCommits : [],
    tsconfigAliases: payload?.tsconfigAliases,
    budgets: payload?.budgets,
  });
}

if (!isMainThread) {
  try {
    parentPort.postMessage({ ok: true, graph: buildGraphFromPayload(workerData) });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        code: String(error?.code || ROOT_TRANSITIONING).slice(0, 64),
        message: String(error?.message || 'File Map worker failed.').slice(0, 256),
      },
    });
  }
}

class WorkspaceFileMapWorkerBuilder {
  constructor({
    WorkerImpl = Worker,
    workerPath = __filename,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {}) {
    this._Worker = WorkerImpl;
    this._workerPath = workerPath;
    this._setTimeout = setTimeoutImpl;
    this._clearTimeout = clearTimeoutImpl;
    this._active = new Map();
    this._disposed = false;
  }

  build(payload, { signal, timeoutMs } = {}) {
    if (this._disposed) {
      return Promise.reject(buildError('File Map worker owner is disposed.'));
    }
    if (signal?.aborted) {
      return Promise.reject(buildError('File Map build was cancelled.'));
    }

    const deadlineMs = normalizeTimeoutMs(timeoutMs);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let worker;

      const cleanup = () => {
        if (timer) this._clearTimeout(timer);
        timer = null;
        signal?.removeEventListener?.('abort', onAbort);
        if (worker) this._active.delete(worker);
      };
      const stopWorker = () => {
        if (!worker) return;
        try {
          const termination = worker.terminate();
          termination?.catch?.(() => {});
        } catch (_error) {
          /* best-effort worker cleanup */
        }
      };
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        stopWorker();
        callback(value);
      };
      const onAbort = () => {
        settle(reject, buildError('File Map build was cancelled.'));
      };

      try {
        worker = new this._Worker(this._workerPath, { workerData: payload });
        this._active.set(worker, () => {
          settle(reject, buildError('File Map worker owner was disposed.'));
        });
      } catch (error) {
        settle(reject, buildError(error?.message || 'File Map worker failed to start.'));
        return;
      }

      signal?.addEventListener?.('abort', onAbort, { once: true });
      timer = this._setTimeout(() => {
        settle(reject, buildError(`File Map build exceeded ${deadlineMs} ms.`));
      }, deadlineMs);

      worker.once('message', (message) => {
        if (message?.ok === true && message.graph) {
          settle(resolve, message.graph);
          return;
        }
        settle(reject, buildError(message?.error?.message || 'File Map worker failed.'));
      });
      worker.once('error', (error) => {
        settle(reject, buildError(error?.message || 'File Map worker failed.'));
      });
      worker.once('exit', (code) => {
        if (!settled) {
          settle(reject, buildError(`File Map worker exited before producing a result (${code}).`));
        }
      });
    });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const cancel of Array.from(this._active.values())) cancel();
  }
}

module.exports = {
  WorkspaceFileMapWorkerBuilder,
  DEFAULT_BUILD_TIMEOUT_MS,
};

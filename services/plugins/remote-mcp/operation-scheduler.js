'use strict';

const DEFAULT_LIMITS = Object.freeze({ global_inflight: 4, descriptor_inflight: 1,
  global_queue: 16, descriptor_queue: 4 });

class RemoteMcpScheduler {
  constructor(limits = {}) {
    this._limits = { ...DEFAULT_LIMITS, ...limits };
    this._active = new Map();
    this._queue = [];
    this._disposed = false;
  }

  _activeFor(key) { return [...this._active.values()].filter((item) => item.key === key).length; }
  _queuedFor(key) { return this._queue.filter((item) => item.key === key).length; }

  _canRun(key) {
    return this._active.size < this._limits.global_inflight
      && this._activeFor(key) < this._limits.descriptor_inflight;
  }

  submit(key, task, { signal = null } = {}) {
    if (this._disposed) return Promise.resolve({ ok: false, reason: 'scheduler_disposed' });
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'operation_cancelled' });
    if (!this._canRun(key) && (this._queue.length >= this._limits.global_queue
      || this._queuedFor(key) >= this._limits.descriptor_queue)) {
      return Promise.resolve({ ok: false, reason: 'remote_queue_limit_exceeded' });
    }
    return new Promise((resolve) => {
      const item = { id: Symbol(key), key, task, resolve, signal, controller: new AbortController(), abort: null };
      item.abort = () => {
        if (this._active.has(item.id)) item.controller.abort();
        else {
          const index = this._queue.indexOf(item);
          if (index >= 0) { this._queue.splice(index, 1); resolve({ ok: false, reason: 'operation_cancelled' }); }
        }
      };
      signal?.addEventListener('abort', item.abort, { once: true });
      if (this._canRun(key)) this._start(item); else this._queue.push(item);
    });
  }

  async _start(item) {
    this._active.set(item.id, item);
    let result;
    try { result = await item.task(item.controller.signal); }
    catch (_error) { result = { ok: false, reason: 'remote_task_failed' }; }
    finally {
      this._active.delete(item.id);
      item.signal?.removeEventListener('abort', item.abort);
      item.resolve(item.controller.signal.aborted ? { ok: false, reason: 'operation_cancelled' } : result);
      this._drain();
    }
  }

  _drain() {
    if (this._disposed) return;
    for (let index = 0; index < this._queue.length;) {
      const item = this._queue[index];
      if (!this._canRun(item.key)) { index += 1; continue; }
      this._queue.splice(index, 1); this._start(item);
    }
  }

  snapshot() { return { active: this._active.size, queued: this._queue.length }; }

  dispose() {
    this._disposed = true;
    for (const item of this._active.values()) item.controller.abort();
    for (const item of this._queue.splice(0)) {
      item.signal?.removeEventListener('abort', item.abort);
      item.resolve({ ok: false, reason: 'operation_cancelled' });
    }
  }
}

module.exports = { DEFAULT_LIMITS, RemoteMcpScheduler };

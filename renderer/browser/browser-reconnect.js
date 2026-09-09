/* Bounded, disposable reconnect lifecycle for the hosted browser SSE lane. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBrowserReconnect = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_RECONNECT_DELAY_MS = 30_000;

  function computeReconnectDelay(attempt, baseDelayMs = 500, maxDelayMs = MAX_RECONNECT_DELAY_MS, random = Math.random) {
    const safeAttempt = Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
    const base = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 500;
    const maximum = Number.isFinite(maxDelayMs) && maxDelayMs > 0 ? maxDelayMs : MAX_RECONNECT_DELAY_MS;
    const sample = typeof random === 'function' ? Number(random()) : 0.5;
    const boundedSample = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
    const jitter = 0.75 + (boundedSample * 0.5);
    return Math.min(maximum, Math.round(base * (2 ** Math.min(safeAttempt, 20)) * jitter));
  }

  class ReconnectController {
    constructor(options = {}) {
      this.connect = typeof options.connect === 'function' ? options.connect : null;
      this.schedule = typeof options.schedule === 'function' ? options.schedule : setTimeout;
      this.cancelSchedule = typeof options.cancelSchedule === 'function' ? options.cancelSchedule : clearTimeout;
      this.baseDelayMs = Number.isFinite(options.baseDelayMs) && options.baseDelayMs > 0 ? options.baseDelayMs : 500;
      this.maxDelayMs = Number.isFinite(options.maxDelayMs) && options.maxDelayMs > 0 ? options.maxDelayMs : MAX_RECONNECT_DELAY_MS;
      this.random = typeof options.random === 'function' ? options.random : Math.random;
      this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
      this.onConnected = typeof options.onConnected === 'function' ? options.onConnected : null;
      this.onDisconnected = typeof options.onDisconnected === 'function' ? options.onDisconnected : null;
      this.running = false;
      this.attempt = 0;
      this.timer = null;
      this.connection = null;
      this.generation = 0;
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.generation += 1;
      this.attempt = 0;
      this._emit('connecting', { attempt: 0 });
      void this._attempt(this.generation);
    }

    stop() {
      this.running = false;
      this.generation += 1;
      if (this.timer !== null) {
        this.cancelSchedule(this.timer);
        this.timer = null;
      }
      const connection = this.connection;
      this.connection = null;
      try { connection?.close?.(); } catch (_error) { /* disposal is best effort */ }
      this._emit('stopped', {});
    }

    reconnectNow() {
      if (!this.running) return;
      this.generation += 1;
      if (this.timer !== null) {
        this.cancelSchedule(this.timer);
        this.timer = null;
      }
      const connection = this.connection;
      this.connection = null;
      try { connection?.close?.(); } catch (_error) { /* stale stream */ }
      this.attempt = 0;
      this._emit('connecting', { attempt: 0, forced: true });
      void this._attempt(this.generation);
    }

    async _attempt(generation) {
      if (!this.running || generation !== this.generation || !this.connect) return;
      let connection;
      try {
        connection = await this.connect({ attempt: this.attempt });
      } catch (error) {
        this._scheduleRetry(generation, error);
        return;
      }
      if (!this.running || generation !== this.generation) {
        try { connection?.close?.(); } catch (_error) { /* stale connection */ }
        return;
      }
      this.connection = connection || null;
      this.attempt = 0;
      this._emit('connected', {});
      try { this.onConnected?.(connection); } catch (_error) { /* callback cannot break transport */ }
      const done = connection && connection.done && typeof connection.done.then === 'function'
        ? connection.done : Promise.resolve();
      try {
        await done;
        if (!this.running || generation !== this.generation) return;
        this._scheduleRetry(generation, null);
      } catch (error) {
        if (!this.running || generation !== this.generation) return;
        this._scheduleRetry(generation, error);
      }
    }

    _scheduleRetry(generation, error) {
      if (!this.running || generation !== this.generation) return;
      try { this.onDisconnected?.(error || null); } catch (_callbackError) { /* diagnostics only */ }
      if (!this.running || generation !== this.generation) return;
      const attempt = this.attempt;
      const delay = computeReconnectDelay(attempt, this.baseDelayMs, this.maxDelayMs, this.random);
      this.attempt += 1;
      this.connection = null;
      this._emit('reconnecting', { attempt, delay, error: error || null });
      this.timer = this.schedule(() => {
        this.timer = null;
        if (!this.running || generation !== this.generation) return;
        void this._attempt(generation);
      }, delay);
    }

    _emit(state, details) {
      try { this.onStatus?.({ state, ...details }); } catch (_error) { /* status must not stop retries */ }
    }
  }

  return { MAX_RECONNECT_DELAY_MS, computeReconnectDelay, ReconnectController };
});

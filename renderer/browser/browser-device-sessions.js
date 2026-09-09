/* Authenticated hosted-device management for the browser lane. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBrowserDeviceSessions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };


  function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  class BrowserDeviceSessionsController {
    constructor(options = {}) {
      this.bridge = options.bridge || null;
      this.BrowserBridgeError = options.BrowserBridgeError || Error;
      this.normalizeReason = options.normalizeReason;
      this.getState = options.getState || (() => ({}));
      this.getGeneration = options.getGeneration || (() => 0);
      this.isDisposed = options.isDisposed || (() => false);
      this.render = options.render || (() => {});
      this.reconnect = options.reconnect || null;
      this.authSessionsPromise = null;
    }

    reset() {
      this.authSessionsPromise = null;
    }

    async load() {
      const state = this.getState();
      if (this.isDisposed() || !state.authenticated || typeof this.bridge?.listAuthSessions !== 'function') return;
      if (this.authSessionsPromise) return this.authSessionsPromise;
      const generation = this.getGeneration();
      state.authSessionsBusy = true;
      state.authSessionsError = '';
      this.render();
      let request;
      request = (async () => {
        try {
          const result = await this.bridge.listAuthSessions();
          const current = this.getState();
          if (this.isDisposed() || generation !== this.getGeneration() || !current.authenticated) return;
          current.authSessions = Array.isArray(result?.sessions) ? result.sessions : [];
        } catch (error) {
          if (this.isDisposed() || generation !== this.getGeneration()) return;
          if (error instanceof this.BrowserBridgeError && (error.status === 401 || error.code === 'auth_required')) {
            this.getState().authenticated = false;
            this.reconnect?.stop?.();
          }
          if (!this.isDisposed() && generation === this.getGeneration()) this.getState().authSessionsError = this.normalizeReason(error);
        } finally {
          if (this.authSessionsPromise === request) {
            if (!this.isDisposed()) {
              this.getState().authSessionsBusy = false;
              this.render();
            }
            this.authSessionsPromise = null;
          }
        }
      })();
      this.authSessionsPromise = request;
      return request;
    }

    async revoke(sessionId, logout) {
      const id = text(sessionId);
      const state = this.getState();
      if (!id || state.authSessionsBusy || typeof this.bridge?.revokeAuthSession !== 'function') return;
      const generation = this.getGeneration();
      state.authSessionsBusy = true;
      state.authSessionsError = '';
      this.render();
      try {
        const result = await this.bridge.revokeAuthSession(id);
        if (this.isDisposed() || generation !== this.getGeneration() || result?.ok !== true) return;
        const currentId = text(this.bridge.session?.id || this.bridge.session?.session_id);
        if (id === currentId) {
          await logout?.();
          return;
        }
        await this.load();
      } catch (error) {
        if (this.isDisposed() || generation !== this.getGeneration()) return;
        if (error instanceof this.BrowserBridgeError && (error.status === 401 || error.code === 'auth_required')) {
          this.getState().authenticated = false;
          this.reconnect?.stop?.();
        }
        if (!this.isDisposed() && generation === this.getGeneration()) this.getState().authSessionsError = this.normalizeReason(error);
      } finally {
        if (!this.isDisposed() && generation === this.getGeneration()) {
          this.getState().authSessionsBusy = false;
          this.render();
        }
      }
    }
  }

  return { BrowserDeviceSessionsController };
});

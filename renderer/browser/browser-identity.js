/* Owns browser authentication and client re-registration lifetimes. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBrowserIdentity = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };


  const SIGN_OUT_PENDING_KEY = 'jenny.browser.signOutPending';

  function isAuthFailure(error) {
    return error?.status === 401 || error?.code === 'auth_required';
  }

  class BrowserIdentity {
    constructor(app, createState, normalizeReason, storage) {
      this.app = app;
      this.storage = storage || null;
      this.createState = createState;
      this.normalizeReason = normalizeReason;
      this.recovery = null;
      this.lastClientRecovery = 0;
    }

    current(generation) {
      return !this.app.disposed && generation === this.app.authGeneration;
    }

    signOutPending() {
      try {
        const store = this.storage || globalThis.localStorage;
        return store?.getItem(SIGN_OUT_PENDING_KEY) === '1';
      } catch (_error) { return false; }
    }

    markSignOut(unconfirmed) {
      this.app.state.signOutUnconfirmed = unconfirmed;
      try {
        const store = this.storage || globalThis.localStorage;
        if (!store) return;
        if (unconfirmed) store.setItem(SIGN_OUT_PENDING_KEY, '1');
        else store.removeItem(SIGN_OUT_PENDING_KEY);
      } catch (_error) { /* the marker is a best-effort reminder across reloads */ }
    }

    async retryLogout() {
      const app = this.app;
      if (app.disposed || !app.bridge || app.state.busy) return;
      const generation = app.authGeneration;
      app.state.busy = true;
      app.render();
      let confirmed;
      try {
        await app.bridge.bootstrap();
        if (!this.current(generation)) return;
        await app.bridge.logout();
        confirmed = true;
      } catch (error) {
        confirmed = isAuthFailure(error);
      }
      if (!this.current(generation)) return;
      app.state.busy = false;
      this.markSignOut(!confirmed);
      app.render();
    }

    async establish(password) {
      const app = this.app;
      if (app.disposed || !app.bridge || app.state.busy) return;
      if (password === undefined && this.signOutPending()) return this.retryLogout();
      app._markPendingMutationIdentityChanged();
      const generation = ++app.authGeneration;
      app.sessionGeneration += 1;
      app.conversation.reset();
      app._resetBinaryState();
      app.deviceSessions.reset();
      app.state.authSessions = [];
      app.reconnect?.stop();
      app.state.busy = true;
      app.state.error = '';
      app.render();
      try {
        if (password !== undefined) await app.bridge.login(password);
        if (!this.current(generation)) return;
        if (password !== undefined) this.markSignOut(false);
        const bootstrap = await app.bridge.bootstrap();
        if (!this.current(generation)) return;
        app.state.executionEnabled = bootstrap?.tools?.execution === true;
        await app.bridge.registerClient();
        if (!this.current(generation)) return;
        app.state.authenticated = true;
        app.state.connectionState = 'connecting';
        await app._loadSessions();
        if (this.current(generation)) app.reconnect?.start();
      } catch (error) {
        if (this.current(generation)) app._handleStartupError(error);
      } finally {
        if (this.current(generation)) { app.state.busy = false; app.render(); }
      }
    }

    async logout() {
      const app = this.app;
      if (app.disposed) return;
      app._markPendingMutationIdentityChanged();
      const generation = ++app.authGeneration;
      app.sessionGeneration += 1;
      app.state.busy = true;
      app.reconnect?.stop();
      app.conversation.reset();
      app._resetBinaryState();
      app.deviceSessions.reset();
      let confirmed = true;
      try { await app.bridge?.logout(); } catch (error) { confirmed = isAuthFailure(error); }
      if (!this.current(generation)) return;
      app.state = this.createState();
      this.markSignOut(!confirmed);
      app.render();
    }

    failure(error) {
      const app = this.app;
      if (app.disposed) return;
      if (error?.status === 403) {
        if (Date.now() - this.lastClientRecovery < 30_000) {
          app.reconnect?.stop();
          app._setError(jt("browserIdentity.theBrowserClientCouldNotReconnectReloadToRetry", "The browser client could not reconnect. Reload to retry."));
          return;
        }
        this.lastClientRecovery = Date.now();
        void this.recover();
      } else if (error?.code === 'auth_required' || error?.status === 401) {
        app._invalidateAuthentication();
        return;
      } else app.state.statusMessage = jt("browserIdentity.theHostConnectionPausedJennyWillRetryAutomatically", "The host connection paused. Jenny will retry automatically.");
      app.render();
    }

    recover() {
      if (this.recovery || this.app.disposed) return this.recovery;
      const app = this.app;
      const generation = app.authGeneration;
      app.sessionGeneration += 1;
      app.reconnect?.stop();
      app.conversation.reset();
      app.conversation.syncControlFromSnapshot({ control: null });
      app.state.statusMessage = jt("browserIdentity.resynchronizingWithJenny", "Resynchronizing with Jenny…");
      app.render();
      this.recovery = (async () => {
        let attempt = 0;
        while (this.current(generation) && app.state.authenticated) {
          try {
            const bootstrap = await app.bridge.bootstrap();
            if (!this.current(generation)) return;
            app.state.executionEnabled = bootstrap?.tools?.execution === true;
            await app.bridge.registerClient();
            if (!this.current(generation)) return;
            app.bridge.cursor = 0;
            await app._loadSessions();
            if (this.current(generation)) {
              app.state.error = '';
              app.reconnect?.start();
            }
            return;
          } catch (error) {
            if (!this.current(generation)) return;
            if (isAuthFailure(error)) { app._invalidateAuthentication(); return; }
            app._setError(this.normalizeReason(error));
            if (!error?.retryable && !(error?.status >= 500)
              && !['host_unavailable', 'request_timeout', 'events_unavailable'].includes(error?.code)) return;
            const delay = Math.min(30_000, 500 * (2 ** Math.min(attempt++, 6)));
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, delay);
              timer?.unref?.();
            });
          }
        }
      })().finally(() => { this.recovery = null; });
      return this.recovery;
    }
  }

  return { BrowserIdentity };
});

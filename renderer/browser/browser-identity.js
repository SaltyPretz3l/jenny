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


  class BrowserIdentity {
    constructor(app, createState, normalizeReason) {
      this.app = app;
      this.createState = createState;
      this.normalizeReason = normalizeReason;
      this.recovery = null;
      this.lastClientRecovery = 0;
    }

    current(generation) {
      return !this.app.disposed && generation === this.app.authGeneration;
    }

    async establish(password) {
      const app = this.app;
      if (app.disposed || !app.bridge || app.state.busy) return;
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
      try { await app.bridge?.logout(); } catch (_error) { /* credentials are cleared locally */ }
      if (!this.current(generation)) return;
      app.state = this.createState();
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
        try {
          const bootstrap = await app.bridge.bootstrap();
          if (!this.current(generation)) return;
          app.state.executionEnabled = bootstrap?.tools?.execution === true;
          await app.bridge.registerClient();
          if (!this.current(generation)) return;
          app.bridge.cursor = 0;
          await app._loadSessions();
          if (this.current(generation)) app.reconnect?.start();
        } catch (error) {
          if (this.current(generation)) {
            if (error?.status === 401 || error?.code === 'auth_required') app._invalidateAuthentication();
            else app._setError(this.normalizeReason(error));
          }
        } finally { this.recovery = null; }
      })();
      return this.recovery;
    }
  }

  return { BrowserIdentity };
});

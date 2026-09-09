/* Bounded receipt reconciliation for hosted browser mutations. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBrowserMutationRecovery = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };


  const RECEIPT_OPERATIONS = new Set([
    'sessions.create', 'sessions.rename', 'sessions.delete', 'sessions.preferences',
    'chat.send', 'chat.cancel', 'approval.resolve', 'questions.answer', 'questions.decline',
  ]);

  function text(value) { return typeof value === 'string' ? value : ''; }

  class BrowserMutationRecovery {
    constructor(app) {
      this.app = app;
      this.pending = null;
    }

    run(operation, options, commandOptions = {}) {
      if (!RECEIPT_OPERATIONS.has(operation)) return this._execute(operation, options, commandOptions, null);
      const intent = JSON.stringify({ operation, sessionId: text(options.sessionId), params: options.params || {} });
      if (this.pending) {
        if (!this.pending.command || this.pending.intent !== intent) {
          if (!commandOptions.quiet) this.app._setError(jt("browserMutationRecovery.resolveThePreviousHostedChangeBeforeStartingAnother", "Resolve the previous hosted change before starting another."));
          return Promise.resolve(null);
        }
        return this.reconcile().then((outcome) => outcome.resolved ? outcome.result : null);
      }
      const pending = {
        operation,
        intent,
        sessionId: text(options.sessionId),
        requestId: '',
        command: null,
        identityChanged: false,
        quiet: commandOptions.quiet === true,
        ui: operation === 'chat.send' ? {
          draft: this.app.state.draft,
          attachmentIds: (this.app.state.attachments || []).map((item) => text(item?.attachment?.id)),
        } : null,
      };
      this.pending = pending;
      this.app.state.mutationPending = true;
      this.app.render();
      return this._execute(operation, options, commandOptions, pending);
    }

    async _execute(operation, options, commandOptions, pending) {
      const app = this.app;
      const authGeneration = app.authGeneration;
      const sessionGeneration = app.sessionGeneration;
      const current = () => !app.disposed && authGeneration === app.authGeneration
        && sessionGeneration === app.sessionGeneration;
      try {
        const result = await app.bridge.command(operation, options);
        if (pending) this._finish(pending);
        if (!current()) return null;
        app._applyCommandResult(result, options, commandOptions);
        return result;
      } catch (error) {
        const failure = error.payload?.ok === false ? error.payload : null;
        if (pending && this._isAmbiguous(error, failure) && error.command && error.requestId) {
          if (authGeneration !== app.authGeneration || app.disposed) return null;
          pending.command = error.command;
          pending.requestId = error.requestId;
          app.state.statusMessage = jt("browserMutationRecovery.confirmingWhetherTheHostedChangeCompleted", "Confirming whether the hosted change completed…");
          app.render();
          const outcome = await this.reconcile();
          return current() && outcome.resolved ? outcome.result : null;
        }
        if (pending) this._finish(pending);
        if (!current()) return null;
        if (error.status === 401 || error.code === 'auth_required' || error.code === 'CMP-HOST-0002') {
          app._invalidateAuthentication();
          return failure;
        }
        if (failure) app._commandFailure(failure, commandOptions.quiet);
        else if (!commandOptions.quiet) app._setError(app.normalizeReason(error));
        return failure;
      }
    }

    reconcile(options = {}) {
      const pending = this.pending;
      if (!pending) return Promise.resolve({ resolved: false, result: null });
      if (pending.reconcilePromise) return pending.reconcilePromise;
      this.app.state.mutationChecking = true;
      this.app.render();
      const task = this._perform(pending, options).finally(() => {
        if (pending.reconcilePromise === task) pending.reconcilePromise = null;
        if (this.pending === pending) {
          this.app.state.mutationChecking = false;
          this.app.render();
        }
      });
      pending.reconcilePromise = task;
      return task;
    }

    async _perform(pending, { refresh = false } = {}) {
      const app = this.app;
      if (this.pending !== pending) return { resolved: false, result: null };
      if (pending.identityChanged || !pending.command) {
        app.state.statusMessage = jt("browserMutationRecovery.aPreviousHostedChangeHasAnUnknownOutcomeAfter", "A previous hosted change has an unknown outcome after sign-in changed. Review history, then reload Jenny before starting another change.");
        app.render();
        return { resolved: false, result: null };
      }
      const authGeneration = app.authGeneration;
      const current = () => this.pending === pending && !app.disposed
        && authGeneration === app.authGeneration && !pending.identityChanged && Boolean(pending.command);
      let status;
      try { status = await app.bridge.requestStatus(pending.requestId); }
      catch (error) {
        if (!current()) return { resolved: false, result: null };
        if (error.status === 401 || error.code === 'auth_required') app._invalidateAuthentication();
        else this._showUnresolved(jt("browserMutationRecovery.theHostedChangeIsStillUnresolvedCheckAgainAfter", "The hosted change is still unresolved. Check again after the connection recovers."));
        return { resolved: false, result: null };
      }
      if (!current()) return { resolved: false, result: null };
      if (status?.state === 'settled') return this._settled(pending, status.result, refresh);
      if (status?.state === 'unknown') return this._retryExact(pending, refresh);
      this._showUnresolved(status?.state === 'indeterminate'
        ? jt("browserMutationRecovery.theHostCannotSafelyDetermineThisChangeReviewThe", "The host cannot safely determine this change. Review the conversation before retrying.")
        : jt("browserMutationRecovery.theHostedChangeIsStillCompletingCheckAgainShortly", "The hosted change is still completing. Check again shortly."));
      return { resolved: false, result: null };
    }

    async _retryExact(pending, refresh) {
      const app = this.app;
      const authGeneration = app.authGeneration;
      const command = pending.command;
      const current = () => this.pending === pending && !app.disposed
        && authGeneration === app.authGeneration && !pending.identityChanged && pending.command === command;
      if (!current()) return { resolved: false, result: null };
      try {
        const result = await app.bridge.retryCommand(command);
        if (!current()) return { resolved: false, result: null };
        return this._settled(pending, result, refresh);
      } catch (error) {
        if (!current()) return { resolved: false, result: null };
        const failure = error.payload?.ok === false ? error.payload : null;
        if (error.status === 401 || error.code === 'auth_required') app._invalidateAuthentication();
        else if (failure?.error?.reason === 'operation_indeterminate') {
          this._showUnresolved(jt("browserMutationRecovery.theHostCannotSafelyDetermineThisChangeReviewThe", "The host cannot safely determine this change. Review the conversation before retrying."));
        } else if (failure && error.code !== 'request_timeout' && error.code !== 'host_unavailable') {
          this._finish(pending);
          app._commandFailure(failure, pending.quiet);
          return { resolved: true, result: failure };
        } else this._showUnresolved(jt("browserMutationRecovery.theHostedChangeIsStillUnresolvedCheckAgainAfter", "The hosted change is still unresolved. Check again after the connection recovers."));
        return { resolved: false, result: null };
      }
    }

    async _settled(pending, result, refresh) {
      this._finish(pending);
      if (result?.ok === false) this.app._commandFailure(result, pending.quiet);
      if (refresh) await this.app._refreshAfterReconciledMutation(pending, result);
      return { resolved: true, result };
    }

    _finish(pending) {
      if (this.pending !== pending) return;
      this.pending = null;
      this.app.state.mutationPending = false;
      this.app.state.mutationChecking = false;
      this.app.state.statusMessage = '';
      this.app.render();
    }

    _showUnresolved(message) {
      this.app.state.statusMessage = message;
      this.app.render();
    }

    _isAmbiguous(error, failure) {
      if (failure) return false;
      return ['request_timeout', 'host_unavailable', 'invalid_server_response'].includes(error?.code)
        || (error?.retryable === true && Number.isFinite(error?.status) && error.status >= 500);
    }

    markIdentityChanged() {
      if (!this.pending) return;
      this.pending.identityChanged = true;
      this.pending.command = null;
      this.app.state.mutationPending = true;
    }

    dispose() { this.pending = null; }
  }

  return { BrowserMutationRecovery, RECEIPT_OPERATIONS };
});

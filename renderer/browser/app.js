/* Hosted Jenny browser application entrypoint. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    if (root.document?.getElementById('browser-root')) require('./browser-i18n').install(root);
    module.exports = factory(require('./browser-bridge'), require('./browser-reconnect'), require('./browser-view'), require('./browser-assets'), require('./browser-device-sessions'), require('./browser-conversation'), require('./browser-identity'), require('./browser-mutation-recovery'));
    return;
  }
  root.jennyBrowserApp = factory(root.jennyBrowserBridge, root.jennyBrowserReconnect, root.jennyBrowserView, root.jennyBrowserAssets, root.jennyBrowserDeviceSessions, root.jennyBrowserConversation, root.jennyBrowserIdentity, root.jennyBrowserMutationRecovery);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (bridgeModule, reconnectModule, view, assetsModule, deviceModule, conversationModule, identityModule, mutationModule) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const BrowserBridge = bridgeModule?.BrowserBridge;
  const BrowserBridgeError = bridgeModule?.BrowserBridgeError;
  const ReconnectController = reconnectModule?.ReconnectController;
  const BrowserAssetsController = assetsModule?.BrowserAssetsController;
  const BrowserDeviceSessionsController = deviceModule?.BrowserDeviceSessionsController;
  const BrowserConversationController = conversationModule?.BrowserConversationController;
  const BrowserMutationRecovery = mutationModule?.BrowserMutationRecovery;
  const ATTACHMENT_MIME_TYPES = assetsModule?.ATTACHMENT_MIME_TYPES || bridgeModule?.ATTACHMENT_MIME_TYPES || new Set();
  function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }
  function createState() {
    return {
      authenticated: false,
      executionEnabled: false,
      busy: false,
      error: '',
      statusMessage: '',
      connectionState: 'offline',
      sessions: [],
      selectedSessionId: '',
      snapshot: null,
      liveProjection: null,
      activeStreamId: '',
      planMode: false,
      draft: '',
      editingSessionId: '',
      control: { owned: false, ownerClientId: '', generation: 0, expiresAt: 0 },
      controlBusy: false,
      pendingDecisionKey: '',
      mutationPending: false,
      mutationChecking: false,
      composerMode: 'send',
      attachments: [],
      authSessions: [],
      authSessionsOpen: false,
      authSessionsBusy: false,
      authSessionsError: '',
    };
  }
  function normalizeReason(error) {
    const value = text(error?.payload?.error?.reason || error?.code || error?.message);
    const fallback = value.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase()).slice(0, 240) || jt("app.theHostedRequestCouldNotBeCompleted", "The hosted request could not be completed.");
    const backendStrings = typeof require === 'function' ? require('../shared/i18n-backend-strings') : globalThis.jennyBackendStrings;
    return backendStrings?.errorText(error?.payload?.error?.code || error?.code || '', fallback) || fallback;
  }
  function sessionIdFromDataset(target) {
    return text(target?.dataset?.sessionId || target?.closest?.('[data-session-id]')?.dataset?.sessionId);
  }
  class BrowserApp {

    constructor(options = {}) {
      this.root = options.root || (typeof document !== 'undefined' ? document.getElementById('browser-root') : null);
      this.bridge = options.bridge || (typeof BrowserBridge === 'function' ? new BrowserBridge(options.bridgeOptions) : null);
      this.view = options.view || view;
      this.state = options.state || createState();
      this.disposed = false;
      this.eventsBound = false;
      this.sessionGeneration = 0;
      this.authGeneration = 0;
      this.normalizeReason = normalizeReason;
      this.assets = typeof BrowserAssetsController === 'function'
        ? new BrowserAssetsController({
          bridge: this.bridge,
          view: this.view,
          BrowserBridgeError,
          normalizeReason,
          getState: () => this.state,
          getRoot: () => this.root,
          getSessionGeneration: () => this.sessionGeneration,
          isDisposed: () => this.disposed,
          render: () => this.render(),
          setError: (message) => this._setError(message),
        })
        : null;
      this._onClick = (event) => { void this._handleClick(event); };
      this._onInput = (event) => this._handleInput(event);
      this._onChange = (event) => { void this._handleFileChange(event); };
      this._onSegmentedChange = (event) => { void this._handleSegmentedChange(event); };
      this._bindEvents();
      this.render();
      this.reconnect = options.reconnect || (typeof ReconnectController === 'function'
        ? new ReconnectController({
          connect: () => this._connectEvents(),
          onStatus: (status) => this._handleConnectionStatus(status),
          onConnected: () => { void this._handleConnected(); },
           onDisconnected: (error) => this._handleConnectionFailure(error),
         }) : null);
      this.deviceSessions = typeof BrowserDeviceSessionsController === 'function'
        ? new BrowserDeviceSessionsController({
          bridge: this.bridge,
          BrowserBridgeError,
          normalizeReason,
          getState: () => this.state,
          getGeneration: () => this.authGeneration,
          isDisposed: () => this.disposed,
          render: () => this.render(),
          reconnect: this.reconnect,
        })
        : null;
      this.conversation = typeof BrowserConversationController === 'function'
        ? new BrowserConversationController({
          bridge: this.bridge,
          getState: () => this.state,
          getRoot: () => this.root,
          getGeneration: () => this.sessionGeneration,
          bumpGeneration: () => { this.sessionGeneration += 1; },
          isDisposed: () => this.disposed,
          render: () => this.render(),
          command: (operation, options, commandOptions) => this._command(operation, options, commandOptions),
          resetAssets: () => this._resetBinaryState(),
          setError: (message) => this._setError(message),
          getClientId: () => this.bridge?.clientId || '',
          recoverFromEpoch: (epoch) => this._recoverFromEpoch(epoch),
          normalizeReason,
          visibilityTarget: options.visibilityTarget || this.root?.ownerDocument,
          focusTarget: options.focusTarget || this.root?.ownerDocument?.defaultView,
        })
        : null;
      this.identity = new identityModule.BrowserIdentity(this, createState, normalizeReason);
      this.mutationRecovery = new BrowserMutationRecovery(this);
    }

    _bindEvents() {
      if (this.eventsBound || !this.root || typeof this.root.addEventListener !== 'function') return;
      this.root.addEventListener('click', this._onClick);
      this.root.addEventListener('input', this._onInput);
      this.root.addEventListener('change', this._onChange);
      this.root.addEventListener('inv-segmented-change', this._onSegmentedChange);
      this.eventsBound = true;
    }

    async start() {
      if (this.started || this.disposed) return;
      this.started = true;
      if (!this.bridge) { this._setError(jt("app.theBrowserTransportIsUnavailable", "The browser transport is unavailable.")); return; }
      return this.identity.establish();
    }

    login(password) { return this.identity.establish(password); }
    logout() { return this.identity.logout(); }

    async _loadSessions() {
      return this.conversation?.loadSessions();
    }

    async _loadSnapshot(sessionId, options = {}) {
      return this.conversation?.loadSnapshot(sessionId, options);
    }

    async _connectEvents() {
      if (this.disposed || !this.state.authenticated) return null;
      return this.bridge.connectEvents({
        cursor: this.bridge.cursor,
        onEvent: (event) => this._handleEvent(event),
        onError: () => {
          this.state.statusMessage = jt("app.theHostSentAnInvalidLiveEventJennyWill", "The host sent an invalid live event. Jenny will resync on the next update.");
          this.render();
        },
        onEpochMismatch: (epoch) => { void this._recoverFromEpoch(epoch); },
      });
    }

    _handleConnectionStatus(status) {
      if (this.disposed) return;
      this.state.connectionState = text(status?.state, 'connecting');
      if (status?.state === 'connected') this.state.statusMessage = '';
      this.render();
    }

    async _handleConnected() {
      await this._reconcilePendingMutation({ refresh: true });
      const authGeneration = this.authGeneration;
      const sessionGeneration = this.sessionGeneration;
      const sessionId = this.state.selectedSessionId;
      if (sessionId) await this._loadSnapshot(sessionId);
      if (this.disposed || authGeneration !== this.authGeneration
        || sessionGeneration !== this.sessionGeneration || sessionId !== this.state.selectedSessionId) return;
      await this.conversation?.resumeControl();
    }

    _handleConnectionFailure(error) {
      this.conversation?.prepareForResume();
      return this.identity.failure(error);
    }
    _recoverFromEpoch() { return this.identity.recover(); }

    _handleEvent(event) {
      return this.conversation?.handleEvent(event);
    }

    _applyControlEvent(event) {
      return this.conversation?.applyControlEvent(event);
    }

    _applyStreamEvent(event) {
      return this.conversation?.applyStreamEvent(event);
    }

    async _handleClick(event) {
      const action = event.target?.closest?.('[data-action]');
      if (!action || this.disposed) return;
      const id = text(action.dataset.action);
      if (id === 'login-submit') {
        const password = this.root?.querySelector('#login-password')?.value || '';
        if (this.root?.querySelector('#login-password')) this.root.querySelector('#login-password').value = '';
        await this.login(password);
      } else if (id === 'logout') await this.logout();
      else if (id === 'new-session') await this.createSession();
      else if (id === 'select-session') await this.selectSession(sessionIdFromDataset(action));
      else if (id === 'load-older') await this.loadOlder();
      else if (id === 'reload-conversation') await this._loadSnapshot(this.state.selectedSessionId);
      else if (id === 'reconcile-request') await this._reconcilePendingMutation({ refresh: true });
      else if (id === 'rename-session') this.startRename(sessionIdFromDataset(action));
      else if (id === 'cancel-session-title') { this.state.editingSessionId = ''; this.render(); }
      else if (id === 'save-session-title') await this.saveRename(sessionIdFromDataset(action));
      else if (id === 'delete-session') await this.deleteSession(sessionIdFromDataset(action));
      else if (id === 'acquire-control') {
        if (this.state.control?.owned) await this.releaseControl();
        else await this.acquireControl(action.dataset.takeover === 'true');
      }
      else if (id === 'release-control') await this.releaseControl();
      else if (id === 'send-chat') await this.send();
      else if (id === 'cancel-chat') await this.cancel();
      else if (id === 'choose-attachment') this.fileInput?.click?.();
      else if (id === 'remove-attachment') this._removeAttachment(text(action.dataset.queueId));
      else if (id === 'retry-attachment') await this._retryAttachment(text(action.dataset.queueId));
      else if (id === 'open-attachment') await this._openAttachment(text(action.dataset.attachmentId));
      else if (id === 'load-full-message') await this.loadFullMessage(text(action.dataset.messageId));
      else if (id === 'preview-artifact') await this._downloadArtifact(text(action.dataset.artifactId), { preview: true });
      else if (id === 'download-artifact') await this._downloadArtifact(text(action.dataset.artifactId));
      else if (id === 'manage-auth-sessions') {
        this.state.authSessionsOpen = !this.state.authSessionsOpen;
        this.render();
        if (this.state.authSessionsOpen) await this._loadAuthSessions();
      } else if (id === 'revoke-auth-session') await this._revokeAuthSession(text(action.dataset.sessionId));
      else if (id === 'approve-tool' || id === 'deny-tool') await this.resolveApproval(action, id === 'approve-tool');
      else if (id === 'answer-questions') await this.answerQuestions(action);
      else if (id === 'decline-questions') await this.declineQuestions(action);
    }

    _handleInput(event) {
      const target = event.target;
      if (target?.id === 'composer-prompt') {
        this.state.draft = String(target.value || '').slice(0, 100000);
      }
    }

    async _handleFileChange(event) {
      const target = event.target;
      if (!target?.matches?.('[data-browser-file-picker]') || this.disposed) return;
      const files = Array.from(target.files || []);
      target.value = '';
      await this._queueFiles(files);
    }

    async _handleSegmentedChange(event) {
      if (event.detail?.id !== 'plan-mode' || this.state.control?.owned !== true) return;
      const generation = this.sessionGeneration;
      const nextPlan = event.detail.value === 'on';
      if (nextPlan === this.state.planMode) return;
      const previous = this.state.planMode;
      this.state.planMode = nextPlan;
      this.render();
      const result = await this._command('sessions.preferences', {
        sessionId: this.state.selectedSessionId,
        controlGeneration: this.state.control.generation,
        expectedRevision: text(this.state.snapshot?.session?.revision),
        params: { plan_mode: nextPlan },
      });
      if (this.disposed || generation !== this.sessionGeneration) return;
      if (!result?.ok) {
        this.state.planMode = previous;
        this.render();
      }
    }

    async selectSession(sessionId) {
      return this.conversation?.selectSession(sessionId);
    }

    async loadOlder() {
      return this.conversation?.loadOlder();
    }

    async createSession() {
      return this.conversation?.createSession();
    }

    startRename(sessionId) {
      return this.conversation?.startRename(sessionId);
    }

    async saveRename(sessionId) {
      return this.conversation?.saveRename(sessionId);
    }

    async deleteSession(sessionId) {
      return this.conversation?.deleteSession(sessionId);
    }

    async acquireControl(takeover) {
      return this.conversation?.acquireControl(takeover);
    }

    async releaseControl() {
      return this.conversation?.releaseControl();
    }

    _startHeartbeat() {
      return this.conversation?.startHeartbeat();
    }

    _stopHeartbeat() {
      return this.conversation?.stopHeartbeat();
    }

    async _heartbeat() {
      return this.conversation?.heartbeat();
    }

    async send() {
      return this.conversation?.send();
    }

    async cancel() {
      return this.conversation?.cancel();
    }

    async resolveApproval(action, approved) {
      return this.conversation?.resolveApproval(action, approved);
    }

    _questionAnswers() {
      return this.conversation?.questionAnswers() || [];
    }

    async answerQuestions(action) {
      return this.conversation?.answerQuestions(action);
    }

    async declineQuestions(action) {
      return this.conversation?.declineQuestions(action);
    }

    _attachmentFileName(file) {
      return this.assets?._attachmentFileName(file) || '';
    }

    _attachmentFingerprint(file) {
      return this.assets?._attachmentFingerprint(file) || '';
    }

    _attachmentLimit(file, count, imageCount, imageBytes) {
      return this.assets?.attachmentLimit(file, count, imageCount, imageBytes) || '';
    }

    _queueFiles(files) {
      return this.assets?.queueFiles(files);
    }

    _uploadAttachmentItem(item) {
      return this.assets?.uploadAttachmentItem(item);
    }

    _removeAttachment(clientId) {
      return this.assets?.removeAttachment(clientId);
    }

    _retryAttachment(clientId) {
      return this.assets?.retryAttachment(clientId);
    }

    _clearAttachmentQueue() {
      return this.assets?.clearAttachmentQueue();
    }

    _resetBinaryState() {
      return this.assets?.reset();
    }

    _abortFullMessageLoads() {
      return this.assets?.abortFullMessageLoads();
    }

    _abortAttachmentDownloads() {
      return this.assets?.abortAttachmentDownloads();
    }

    _revokeAttachmentUrls() {
      return this.assets?.revokeAttachmentUrls();
    }

    _openAttachment(attachmentId) {
      return this.assets?.openAttachment(attachmentId);
    }

    _attachmentDisplayName(attachmentId) {
      return this.assets?.attachmentDisplayName(attachmentId) || 'attachment';
    }

    loadFullMessage(messageId) {
      return this.assets?.loadFullMessage(messageId);
    }

    _trackArtifactUrl(key, blob) {
      return this.assets?.trackArtifactUrl(key, blob);
    }

    _downloadArtifact(artifactId, options = {}) {
      return this.assets?.downloadArtifact(artifactId, options);
    }

    _abortArtifactDownloads() {
      return this.assets?.abortArtifactDownloads();
    }

    _revokeArtifactUrls() {
      return this.assets?.revokeArtifactUrls();
    }

    async _loadAuthSessions() {
      return this.deviceSessions?.load();
    }

    async _revokeAuthSession(sessionId) {
      return this.deviceSessions?.revoke(sessionId, () => this.logout());
    }
    _commandFailure(result, quiet) {
      const reason = text(result?.error?.reason);
      if (['control_lease_required', 'control_generation_required'].includes(reason)) {
        this.conversation.syncControlFromSnapshot({ control: null });
      }
      if (reason === 'boot_epoch_mismatch') void this._recoverFromEpoch();
      if (['revision_conflict', 'decision_stale', 'question_batch_stale'].includes(reason)) {
        this.state.statusMessage = jt("app.thisConversationChangedElsewhereRefreshing", "This conversation changed elsewhere. Refreshing…");
        if (this.state.selectedSessionId) void this._loadSnapshot(this.state.selectedSessionId);
      }
      if (reason === 'control_lease_unavailable') this.state.statusMessage = jt("app.anotherBrowserControlsThisConversation", "Another browser controls this conversation.");
      if (!quiet) this._setError(normalizeReason({ payload: result }));
    }

    _command(operation, options = {}, commandOptions = {}) {
      return this.mutationRecovery.run(operation, options, commandOptions);
    }
    _applyCommandResult(result, options, commandOptions) {
      if (result?.ok === false) this._commandFailure(result, commandOptions.quiet);
      else if (result?.revision && options.sessionId === this.state.selectedSessionId
        && this.state.snapshot?.session?.session_id === options.sessionId) {
        this.state.snapshot.session.revision = result.revision;
      }
    }
    _markPendingMutationIdentityChanged() { this.mutationRecovery?.markIdentityChanged(); }
    _reconcilePendingMutation(options = {}) { return this.mutationRecovery?.reconcile(options); }
    async _refreshAfterReconciledMutation(pending, result) {
      if (!result?.ok) return;
      const originalSelected = !pending.sessionId || pending.sessionId === this.state.selectedSessionId;
      if (pending.operation === 'sessions.create') {
        await this._loadSessions();
        if (result.session?.session_id) await this.selectSession(result.session.session_id);
        return;
      }
      if (pending.operation === 'sessions.delete') {
        await this._loadSessions();
        return;
      }
      if (pending.operation === 'sessions.rename' && result.session?.session_id) {
        this.state.sessions = this.state.sessions.map((item) =>
          item.session_id === result.session.session_id ? result.session : item);
        this.state.editingSessionId = '';
      }
      if (originalSelected && pending.operation === 'sessions.preferences' && typeof result.session?.plan_mode === 'boolean') {
        this.state.planMode = result.session.plan_mode;
      }
      if (originalSelected && pending.operation === 'chat.send' && result.accepted === true) {
        const currentIds = (this.state.attachments || []).map((item) => text(item?.attachment?.id));
        const unchanged = this.state.draft === pending.ui?.draft
          && JSON.stringify(currentIds) === JSON.stringify(pending.ui?.attachmentIds || []);
        if (unchanged) {
          this.state.draft = '';
          this.state.attachments = [];
        }
        this.state.activeStreamId = text(result.stream_id);
        this.state.statusMessage = jt("app.jennyIsWorking", "Jenny is working…");
      }
      if (this.state.selectedSessionId) await this._loadSnapshot(this.state.selectedSessionId);
    }
    _invalidateAuthentication() {
      if (this.disposed) return;
      this._markPendingMutationIdentityChanged();
      this.authGeneration += 1;
      this.sessionGeneration += 1;
      this.bridge?.clearCredentials?.();
      this.reconnect?.stop();
      this.conversation?.reset();
      this.conversation?.syncControlFromSnapshot({ control: null });
      this.deviceSessions?.reset?.();
      this.state.authenticated = false;
      this.state.connectionState = 'offline';
      this.state.error = jt("app.yourHostedLoginExpiredSignInAgain", "Your hosted login expired. Sign in again.");
      this.render();
    }
    _handleStartupError(error) {
      if (error?.status === 401 || error?.code === 'auth_required' || error?.code === 'AUTH_UNAUTHENTICATED') {
        this.state.authenticated = false;
        this.state.error = '';
      } else {
        this.state.error = normalizeReason(error);
      }
      this.state.connectionState = 'offline';
      this.render();
    }
    _setError(message) {
      this.state.error = text(message);
      this.state.statusMessage = '';
      this.render();
    }
    render() {
      if (this.disposed || !this.root || !this.view?.mount) return;
      this.view.mount(this.root, this.state);
      const controlButton = this.root.querySelector('[data-action="acquire-control"], [data-action="release-control"]');
      if (controlButton) {
        controlButton.dataset.action = this.state.control?.owned ? 'release-control' : 'acquire-control';
      }
      this._ensureFilePicker();
    }
    _ensureFilePicker() {
      const holder = this.root?.querySelector?.('[data-attachment-picker]');
      if (!holder || typeof document === 'undefined' || typeof document.createElement !== 'function') {
        this.fileInput = null;
        return;
      }
      let input = holder.querySelector('[data-browser-file-picker]');
      if (!input) {
        // Native picker created through the DOM namespace; inventory has no file input.
        input = document.createElementNS('http://www.w3.org/1999/xhtml', 'input');
        input.type = 'file';
        input.multiple = true;
        input.accept = Array.from(ATTACHMENT_MIME_TYPES).join(',');
        input.className = 'browser-file-picker';
        input.dataset.browserFilePicker = 'true';
        input.setAttribute('aria-label', jt("app.chooseAttachments", "Choose attachments"));
        holder.appendChild(input);
      }
      this.fileInput = input;
    }
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.reconnect?.stop();
      this._stopHeartbeat();
      if (this.eventsBound) {
        this.root.removeEventListener('click', this._onClick);
        this.root.removeEventListener('input', this._onInput);
        this.root.removeEventListener('change', this._onChange);
        this.root.removeEventListener('inv-segmented-change', this._onSegmentedChange);
        this.eventsBound = false;
      }
      this.authGeneration += 1;
      this.sessionGeneration += 1;
      this.mutationRecovery?.dispose?.();
      this._resetBinaryState();
      this.conversation?.dispose?.();
      this.bridge?.dispose?.();
    }
  }
  function createBrowserApp(options) {
    return new BrowserApp(options);
  }
  if (typeof document !== 'undefined' && document.getElementById('browser-root')) {
    void require('./browser-i18n').load(globalThis).then(() => {
      const app = createBrowserApp({ root: document.getElementById('browser-root') });
      globalThis.jennyHostedApp = app;
      void app.start();
    });
  }
  return { BrowserApp, createBrowserApp, createState, normalizeReason, buildInertArtifactDocument: view?.buildInertArtifactDocument, artifactMimeType: view?.artifactMimeType };
});

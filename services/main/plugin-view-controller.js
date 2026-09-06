'use strict';

const crypto = require('node:crypto');
const { installPluginViewProtocol, PLUGIN_VIEW_SCHEME } = require('./plugin-view-protocol');
const { installPluginViewSessionPolicy, clearPluginViewSession } = require('./plugin-view-session-policy');
const { STAGE7_LIMITS } = require('../plugins/view/stage7-budgets');
const { getBridgeChannel } = require('../ipc-contract');

function refusal(reason) { return { ok: false, reason }; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function withDeadline(promise, timeoutMs, timeoutValue = null) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (timeoutValue !== null) resolve(timeoutValue);
      else reject(new Error('timeout'));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class PluginViewController {
  constructor({ WebContentsView, session, preloadPath, getMainWindow, resolveAsset,
    resolveAttachmentTicket = null,
    onQuarantine = () => {}, log = () => {}, now = () => Date.now(),
    setIntervalFn = setInterval, clearIntervalFn = clearInterval, memoryPollMs = 1000 } = {}) {
    if (typeof WebContentsView !== 'function' || !session?.fromPartition
      || typeof getMainWindow !== 'function') {
      throw new TypeError('plugin view controller dependencies invalid');
    }
    this.WebContentsView = WebContentsView;
    this.session = session;
    this.preloadPath = preloadPath;
    this.getMainWindow = getMainWindow;
    this.resolveAsset = typeof resolveAsset === 'function'
      ? resolveAsset : ({ artifactDigest, path }) => this.generation?.assets?.get(`${artifactDigest}/${path}`) || null;
    this.resolveAttachmentTicket = typeof resolveAttachmentTicket === 'function'
      ? resolveAttachmentTicket : null;
    this.onQuarantine = onQuarantine;
    this.log = log;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.memoryPollMs = memoryPollMs;
    this.generation = null;
    this.active = null;
    this.crashes = new Map();
    this.disposed = false;
    this.lifecycleToken = 0;
    this.onViewDestroyed = () => {};
    this.pendingTeardown = null;
    this.teardownPromise = null;
  }

  setOnViewDestroyed(callback) {
    this.onViewDestroyed = typeof callback === 'function' ? callback : () => {};
  }

  async commitGeneration(prepared) {
    if (this.disposed) return refusal('view_host_disposed');
    if (!prepared || !Number.isSafeInteger(prepared.commit_epoch)) return refusal('view_generation_invalid');
    const destroyed = await this.destroyAll('generation_changed');
    if (destroyed?.ok === false) return destroyed;
    this.generation = prepared;
    return { ok: true };
  }

  async open(descriptor, { bounds, lifecycleEpoch = 0, sessionId = '', sessionIncarnation = '',
    replacementReason = 'view_replaced' } = {}) {
    if (this.disposed || !this.generation) return refusal('view_host_unavailable');
    if (!descriptor || descriptor.commit_epoch !== this.generation.commit_epoch) return refusal('view_authority_stale');
    const replaced = await this.destroyAll(replacementReason);
    if (replaced?.ok === false) return replaced;
    const lifecycleToken = ++this.lifecycleToken;
    const viewInstanceId = `view_${crypto.randomBytes(12).toString('hex')}`;
    const partition = `plugin-view-${viewInstanceId}`;
    const isolatedSession = this.session.fromPartition(partition, { cache: false });
    installPluginViewSessionPolicy(isolatedSession, descriptor.artifact_digest);
    const devToolsEnabled = process.env.NODE_ENV === 'development'
      && process.env.JENNY_PLUGIN_VIEW_DEVTOOLS === '1';
    if (devToolsEnabled) {
      this.log('plugin.view.devtools_enabled', { warning_code: 'sandbox_inspection_mode' });
    }
    const view = new this.WebContentsView({ webPreferences: {
      session: isolatedSession,
      preload: this.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: devToolsEnabled,
    } });
    try {
      await withDeadline(
        installPluginViewProtocol(isolatedSession, {
          resolveAsset: (identity) => identity.artifactDigest === descriptor.artifact_digest
            ? this.resolveAsset(identity) : null,
          resolveAttachment: this.resolveAttachmentTicket
            ? (identity) => this.resolveAttachmentTicket({ ...identity,
              viewInstanceId, generationId: descriptor.generation_id,
              webContentsId: view.webContents.id })
            : null,
          log: this.log,
        }),
        STAGE7_LIMITS.create_deadline_ms,
      );
    } catch (_error) {
      await this._discardUncommittedView(view, isolatedSession);
      return refusal('view_create_failed');
    }
    if (this.lifecycleToken !== lifecycleToken || this.disposed) {
      await this._discardUncommittedView(view, isolatedSession);
      return refusal('view_lifecycle_superseded');
    }
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed?.()) {
      await this._discardUncommittedView(view, isolatedSession);
      return refusal('main_window_unavailable');
    }
    view.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    view.webContents.on?.('will-navigate', (event, url) => {
      if (!url.startsWith(`${PLUGIN_VIEW_SCHEME}://${descriptor.artifact_digest}/`)) event.preventDefault();
    });
    view.webContents.on?.('will-redirect', (event) => event.preventDefault());
    view.webContents.on?.('before-input-event', (event, input) => this._handleInput(event, input));
    view.webContents.on?.('render-process-gone', () => this._recordCrash(descriptor, view));
    view.webContents.on?.('will-attach-webview', (event) => event.preventDefault());
    mainWindow.contentView.addChildView(view);
    view.setVisible?.(false);
    this.active = {
      view, session: isolatedSession, descriptor, viewInstanceId, lifecycleEpoch,
      sessionId: String(sessionId || '').trim(),
      sessionIncarnation: String(sessionIncarnation || '').trim(),
      zoomFactor: 1, bounds: null, memoryWarningEmitted: false, memoryTimer: null,
      restarting: false,
    };
    if (!bounds || !this.setBounds(bounds).ok) {
      await this.destroyAll('view_bounds_required');
      return refusal('view_bounds_required');
    }
    const url = `${PLUGIN_VIEW_SCHEME}://${descriptor.artifact_digest}/${descriptor.content.entry_path}`;
    try {
      await withDeadline(
        view.webContents.loadURL(url),
        STAGE7_LIMITS.ready_deadline_ms,
      );
    } catch (_error) {
      if (this.active?.view === view) await this.destroyAll('view_load_failed');
      else await this._discardUncommittedView(view, isolatedSession);
      return refusal('view_load_failed');
    }
    if (this.lifecycleToken !== lifecycleToken || this.active?.view !== view
      || this.generation?.commit_epoch !== descriptor.commit_epoch) {
      await this._discardUncommittedView(view, isolatedSession);
      return refusal('view_lifecycle_superseded');
    }
    view.setVisible?.(true);
    this._startMemoryMonitor(this.active);
    return { ok: true, view_instance_id: viewInstanceId };
  }

  async _discardUncommittedView(view, isolatedSession) {
    try { view?.webContents?.close?.({ waitForBeforeUnload: false }); } catch (_error) {
      view?.webContents?.destroy?.();
    }
    await clearPluginViewSession(isolatedSession).catch(() => {});
  }

  setBounds(raw) {
    if (!this.active || !raw) return refusal('view_not_open');
    const main = this.getMainWindow();
    const content = main?.getContentBounds?.() || { width: 0, height: 0 };
    const values = [raw.x ?? 0, raw.y ?? 0, raw.width ?? 0, raw.height ?? 0].map(Number);
    if (!values.every(Number.isFinite)) return refusal('view_bounds_invalid');
    const [rawX, rawY, rawWidth, rawHeight] = values;
    const x = clamp(Math.trunc(rawX), 0, content.width);
    const y = clamp(Math.trunc(rawY), 0, content.height);
    const width = clamp(Math.trunc(rawWidth), 0, content.width - x);
    const height = clamp(Math.trunc(rawHeight), 0, content.height - y);
    if (width <= 0 || height <= 0) return refusal('view_bounds_invalid');
    this.active.view.setBounds({ x, y, width, height });
    this.active.bounds = { x, y, width, height };
    return { ok: true };
  }

  setZoom(factor) {
    if (!this.active) return refusal('view_not_open');
    const value = Number(factor);
    if (!Number.isFinite(value)) return refusal('view_zoom_invalid');
    const next = clamp(value, STAGE7_LIMITS.zoom_min_milli / 1000, STAGE7_LIMITS.zoom_max_milli / 1000);
    this.active.view.webContents.setZoomFactor(next);
    this.active.zoomFactor = next;
    return { ok: true, zoom_factor: next };
  }

  focus() { this.active?.view?.webContents?.focus?.(); }

  sendEvent(message) {
    if (!this.active || this.active.view.webContents.isDestroyed?.()) return false;
    this.active.view.webContents.send('plugins:view-event', message);
    return true;
  }

  sendHostCommand(command, detail = {}, expectedViewInstanceId = '') {
    if (!this.active || (expectedViewInstanceId
      && this.active.viewInstanceId !== expectedViewInstanceId)) return false;
    return this._sendHostCommand(command, detail);
  }

  _sendHostCommand(command, detail = {}) {
    const target = this.getMainWindow()?.webContents;
    if (!target || target.isDestroyed?.()) return false;
    target.send(getBridgeChannel('plugins.onViewHostCommand'), { command, ...detail });
    return true;
  }

  _handleInput(event, input = {}) {
    if (!this.active || input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    if (key === 'f6') {
      event.preventDefault();
      this.getMainWindow()?.webContents?.focus?.();
      this._sendHostCommand('focus_chrome');
      return;
    }
    if (input.alt && key === 'left') {
      event.preventDefault();
      this._sendHostCommand('back');
      return;
    }
    if (!input.control && !input.meta) return;
    if (key === '0') {
      event.preventDefault();
      this.setZoom(1);
      this._sendHostCommand('zoom_changed', { zoom_factor: 1 });
      return;
    }
    if (key === '+' || key === '=' || key === '-') {
      event.preventDefault();
      const delta = key === '-' ? -0.1 : 0.1;
      const current = this.active.zoomFactor || 1;
      const result = this.setZoom(Number((current + delta).toFixed(1)));
      if (result.ok) this._sendHostCommand('zoom_changed', { zoom_factor: result.zoom_factor });
    }
  }

  contextForEvent(event) {
    if (!this.active || event?.sender?.id !== this.active.view.webContents.id) return null;
    const descriptor = this.active.descriptor;
    return {
      senderId: event.sender.id,
      origin: `${PLUGIN_VIEW_SCHEME}://${descriptor.artifact_digest}`,
      viewInstanceId: this.active.viewInstanceId,
      contributionId: descriptor.contribution_id,
      artifactDigest: descriptor.artifact_digest,
      commitEpoch: descriptor.commit_epoch,
      lifecycleEpoch: this.active.lifecycleEpoch,
      generationId: descriptor.generation_id,
      publisherId: descriptor.publisher_id,
      pluginId: descriptor.plugin_id,
      sessionId: this.active.sessionId,
      sessionIncarnation: this.active.sessionIncarnation,
      sessionProviderAuthorized: Boolean(
        this.active.sessionId && this.active.sessionIncarnation
      ),
      allowedOperations: descriptor.content.allowed_bridge_operations,
      allowedEventTopics: descriptor.content.allowed_event_topics,
    };
  }

  _startMemoryMonitor(current) {
    if (!current || typeof current.view?.webContents?.getProcessMemoryInfo !== 'function') return;
    const timer = this.setIntervalFn(
      () => { void this._sampleMemory(current.viewInstanceId); },
      this.memoryPollMs,
    );
    timer?.unref?.();
    current.memoryTimer = timer;
  }

  async _sampleMemory(viewInstanceId) {
    const current = this.active;
    if (!current || current.viewInstanceId !== viewInstanceId) return;
    let info;
    try { info = await current.view.webContents.getProcessMemoryInfo(); } catch (_error) {
      this.log('plugin.view.memory_sample_failed', { reason_code: 'memory_sample_failed' });
      return;
    }
    if (this.active !== current || current.viewInstanceId !== viewInstanceId) return;
    const privateKb = Number(info?.private);
    if (!Number.isFinite(privateKb) || privateKb < 0) return;
    const privateBytes = Math.trunc(privateKb * 1024);
    if (privateBytes >= STAGE7_LIMITS.memory_warning_bytes && !current.memoryWarningEmitted) {
      current.memoryWarningEmitted = true;
      this.log('plugin.view.memory_warning', { publisher_id: current.descriptor.publisher_id,
        plugin_id: current.descriptor.plugin_id, private_bytes: privateBytes,
        limit_bytes: STAGE7_LIMITS.memory_warning_bytes });
      this._sendHostCommand('view_state', { state: 'memory_warning' });
    }
    if (privateBytes < STAGE7_LIMITS.memory_hard_bytes) return;
    this.log('plugin.view.memory_hard_limit', { publisher_id: current.descriptor.publisher_id,
      plugin_id: current.descriptor.plugin_id, private_bytes: privateBytes,
      limit_bytes: STAGE7_LIMITS.memory_hard_bytes });
    await this._destroyAndQuarantine(
      { publisher_id: current.descriptor.publisher_id, plugin_id: current.descriptor.plugin_id,
        reason: 'view_memory_hard_limit' },
      'view_memory_hard_limit',
    );
  }

  _recordCrash(descriptor, view) {
    const active = this.active;
    if (!active || active.view !== view || active.restarting) return;
    const key = `${descriptor.publisher_id}/${descriptor.plugin_id}`;
    const cutoff = this.now() - STAGE7_LIMITS.crash_window_ms;
    const crashes = (this.crashes.get(key) || []).filter((time) => time >= cutoff);
    crashes.push(this.now());
    this.crashes.set(key, crashes);
    this.log('plugin.view.crashed', { publisher_id: descriptor.publisher_id,
      plugin_id: descriptor.plugin_id, crash_count: crashes.length });
    if (crashes.length > STAGE7_LIMITS.crash_restarts) {
      void this._destroyAndQuarantine(
        { publisher_id: descriptor.publisher_id, plugin_id: descriptor.plugin_id,
          reason: 'view_crash_circuit_open' },
        'view_crash_circuit_open',
      );
      return;
    }
    active.restarting = true;
    active.view.setVisible?.(false);
    this._sendHostCommand('view_state', { state: 'restarting', crash_count: crashes.length });
    const restart = { descriptor, bounds: active.bounds, lifecycleEpoch: active.lifecycleEpoch,
      sessionId: active.sessionId, sessionIncarnation: active.sessionIncarnation,
      zoomFactor: active.zoomFactor };
    void this._restartAfterCrash(restart);
  }

  async _restartAfterCrash(restart) {
    const result = await this.open(restart.descriptor, {
      bounds: restart.bounds,
      lifecycleEpoch: restart.lifecycleEpoch,
      sessionId: restart.sessionId,
      sessionIncarnation: restart.sessionIncarnation,
      replacementReason: 'view_crash_restart',
    });
    if (!result?.ok) {
      this.log('plugin.view.restart_failed', { publisher_id: restart.descriptor.publisher_id,
        plugin_id: restart.descriptor.plugin_id, reason_code: result?.reason || 'view_restart_failed' });
      this._sendHostCommand('view_state', { state: 'crashed', reason_code: 'view_restart_failed' });
      return;
    }
    if (restart.zoomFactor !== 1) this.setZoom(restart.zoomFactor);
    this._sendHostCommand('view_state', { state: 'ready' });
  }

  async _destroyAndQuarantine(identity, reason) {
    await this.destroyAll(reason);
    try {
      await Promise.resolve(this.onQuarantine(identity));
    } catch (_error) {
      this.log('plugin.view.quarantine_failed', { reason_code: 'view_quarantine_failed' });
    }
  }

  async destroyAll(reason = 'closed') {
    this.lifecycleToken += 1;
    const pendingResult = await this._retryPendingTeardown();
    if (pendingResult?.ok === false) return pendingResult;
    const current = this.active;
    this.active = null;
    if (!current) return { ok: true };
    if (current.memoryTimer !== null) this.clearIntervalFn(current.memoryTimer);
    current.view.setVisible?.(false);
    try { this.getMainWindow()?.contentView?.removeChildView?.(current.view); } catch (_error) { /* already detached */ }
    try { current.view.webContents.close?.({ waitForBeforeUnload: false }); } catch (_error) { current.view.webContents.destroy?.(); }
    await withDeadline(
      clearPluginViewSession(current.session),
      STAGE7_LIMITS.dispose_deadline_ms,
      false,
    ).catch(() => {});
    this.pendingTeardown = {
      viewInstanceId: current.viewInstanceId,
      reason,
      context: {
        sessionId: current.sessionId,
        sessionIncarnation: current.sessionIncarnation,
        generationId: current.descriptor.generation_id,
        publisherId: current.descriptor.publisher_id,
        pluginId: current.descriptor.plugin_id,
      },
    };
    const teardown = await this._retryPendingTeardown();
    this.log('plugin.view.closed', { reason_code: reason });
    return teardown?.ok === false ? teardown : { ok: true };
  }

  async _retryPendingTeardown() {
    if (!this.pendingTeardown) return { ok: true };
    if (this.teardownPromise) return this.teardownPromise;
    const pending = this.pendingTeardown;
    this.teardownPromise = (async () => {
      let result;
      try {
        result = await Promise.resolve(this.onViewDestroyed(
          pending.viewInstanceId,
          pending.reason,
          pending.context,
        )) || { ok: true };
      } catch (_error) {
        result = { ok: false, reason: 'view_teardown_failed' };
      }
      if (result?.ok === false) {
        this.log('plugin.view.teardown_pending', {
          reason_code: result.reason || 'view_teardown_failed',
        });
        return result;
      }
      if (this.pendingTeardown === pending) this.pendingTeardown = null;
      return { ok: true };
    })();
    try {
      return await this.teardownPromise;
    } finally {
      this.teardownPromise = null;
    }
  }

  async dispose() { this.disposed = true; this.generation = null; await this.destroyAll('shutdown'); }
}

module.exports = { PluginViewController };

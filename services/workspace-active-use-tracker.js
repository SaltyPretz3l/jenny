'use strict';

const path = require('node:path');

const { FileJsonStore } = require('./backend/file-json-store');
const { workspaceRootId } = require('./workspace-root-identity');

const STORE_KEY = 'workspaceActiveUseSecondsByWorkspace';
const STORE_FILE = 'workspace-active-use.json';
const MAX_TRACKED_WORKSPACES = 64;
const FLUSH_INTERVAL_MS = 60_000;

function finiteMilliseconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeSeconds(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeStoredCounters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  const entries = [];
  for (const [workspaceId, rawSeconds] of Object.entries(value)) {
    const seconds = normalizeSeconds(rawSeconds);
    if (/^root_[0-9a-f]{24}$/.test(workspaceId) && seconds != null) {
      entries.push([workspaceId, seconds * 1000]);
    }
  }
  return new Map(entries.slice(-MAX_TRACKED_WORKSPACES));
}

function readStore(store) {
  try {
    const raw = store?.read?.({});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (_error) {
    return {};
  }
}

function removeListener(target, event, handler) {
  if (typeof target?.off === 'function') target.off(event, handler);
  else target?.removeListener?.(event, handler);
}

class WorkspaceActiveUseTracker {
  constructor({
    store,
    getWorkspaceRoot,
    getBackendStatus,
    getWindow,
    backendEvents = null,
    configEvents = null,
    appEvents = null,
    now = Date.now,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    flushIntervalMs = FLUSH_INTERVAL_MS,
    logger = null,
  } = {}) {
    this.store = store || null;
    this.getWorkspaceRoot = typeof getWorkspaceRoot === 'function' ? getWorkspaceRoot : () => '';
    this.getBackendStatus = typeof getBackendStatus === 'function' ? getBackendStatus : () => ({});
    this.getWindow = typeof getWindow === 'function' ? getWindow : () => null;
    this.backendEvents = backendEvents;
    this.configEvents = configEvents;
    this.appEvents = appEvents;
    this.now = typeof now === 'function' ? now : Date.now;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.flushIntervalMs = Math.max(1_000, Math.trunc(Number(flushIntervalMs) || FLUSH_INTERVAL_MS));
    this.logger = typeof logger === 'function' ? logger : null;
    this.countersMs = normalizeStoredCounters(readStore(this.store)[STORE_KEY]);
    this.workspaceId = null;
    this.backendReady = false;
    this.windowRef = null;
    this.windowActive = false;
    this.lastObservedMs = finiteMilliseconds(this.now());
    this.intervalHandle = null;
    this.listeners = [];
    this.accrualDirty = false;
    this.started = false;
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this._bind(this.backendEvents, 'backend-status', (status) => {
      this._settle();
      this.backendReady = status?.phase === 'ready';
      this._refreshWindow();
    });
    this._bind(this.configEvents, 'changed', () => {
      this._settle();
      this._refreshWorkspace();
      this.flush();
    });
    this._bind(this.appEvents, 'browser-window-created', (_event, windowRef) => {
      if (windowRef !== this.getWindow()) return;
      this._settle();
      this._attachWindow(windowRef);
    });
    this._bind(this.appEvents, 'before-quit', () => this.flush());
    this._refreshWorkspace();
    this.backendReady = this.getBackendStatus()?.phase === 'ready';
    this._attachWindow(this.getWindow());
    this.intervalHandle = this.setIntervalImpl(() => this.flush(), this.flushIntervalMs);
    this.intervalHandle?.unref?.();
    return this;
  }

  requestFields(workspaceRoot = this.getWorkspaceRoot()) {
    if (!this.started) this.start();
    this._settle();
    this._refreshWorkspace(workspaceRoot);
    this._refreshWindow();
    if (!this.workspaceId || typeof this.store?.read !== 'function'
      || typeof this.store?.write !== 'function') return {};
    this._ensureWorkspace(this.workspaceId);
    return {
      workspace_active_use_seconds: Math.floor(this.countersMs.get(this.workspaceId) / 1000),
    };
  }

  flush() {
    if (!this.started) return false;
    this._settle();
    this._refreshWorkspace();
    this._refreshWindow();
    if (!this.accrualDirty || typeof this.store?.write !== 'function') return false;
    const counters = {};
    for (const [workspaceId, milliseconds] of this.countersMs) {
      counters[workspaceId] = Math.floor(milliseconds / 1000);
    }
    try {
      this.store.write({ ...readStore(this.store), [STORE_KEY]: counters });
      this.accrualDirty = false;
      return true;
    } catch (error) {
      this.logger?.('WARN', 'workspace.active_use_flush_failed', {
        errorType: String(error?.name || 'Error'),
      });
      return false;
    }
  }

  dispose() {
    if (!this.started) return;
    this.flush();
    this.started = false;
    if (this.intervalHandle != null) this.clearIntervalImpl(this.intervalHandle);
    this.intervalHandle = null;
    for (const [target, event, handler] of this.listeners.splice(0)) {
      removeListener(target, event, handler);
    }
    this.windowRef = null;
  }

  _bind(target, event, handler) {
    if (typeof target?.on !== 'function') return;
    target.on(event, handler);
    this.listeners.push([target, event, handler]);
  }

  _attachWindow(windowRef) {
    if (windowRef === this.windowRef) {
      this._refreshWindow();
      return;
    }
    if (this.windowRef) {
      const stale = this.listeners.filter(([target]) => target === this.windowRef);
      for (const [target, event, handler] of stale) removeListener(target, event, handler);
      this.listeners = this.listeners.filter(([target]) => target !== this.windowRef);
    }
    this.windowRef = windowRef || null;
    const onVisibilityChange = () => {
      this._settle();
      this._refreshWindow();
      this.flush();
    };
    for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) {
      this._bind(this.windowRef, event, onVisibilityChange);
    }
    this._bind(this.windowRef, 'closed', () => {
      this._settle();
      this.windowRef = null;
      this.windowActive = false;
      this.flush();
    });
    this._refreshWindow();
  }

  _refreshWorkspace(workspaceRoot = this.getWorkspaceRoot()) {
    const nextId = workspaceRootId(workspaceRoot);
    if (nextId === this.workspaceId) return;
    this.workspaceId = nextId;
    if (nextId) this._ensureWorkspace(nextId);
  }

  _refreshWindow() {
    // Match _attachWindow's empty value while main.js has no window yet.
    const current = this.windowRef || this.getWindow() || null;
    if (current !== this.windowRef) {
      this._attachWindow(current);
      return;
    }
    const alive = current && current.isDestroyed?.() !== true;
    this.windowActive = Boolean(
      alive && current.isVisible?.() === true && current.isFocused?.() === true
    );
  }

  _ensureWorkspace(workspaceId) {
    if (this.countersMs.has(workspaceId)) return;
    while (this.countersMs.size >= MAX_TRACKED_WORKSPACES) {
      this.countersMs.delete(this.countersMs.keys().next().value);
    }
    this.countersMs.set(workspaceId, 0);
  }

  _settle() {
    const observed = finiteMilliseconds(this.now());
    const elapsed = Math.max(0, observed - this.lastObservedMs);
    if (elapsed && this.workspaceId && this.backendReady && this.windowActive) {
      this._ensureWorkspace(this.workspaceId);
      const increment = Math.min(elapsed, 2 * this.flushIntervalMs);
      this.countersMs.set(this.workspaceId, this.countersMs.get(this.workspaceId) + increment);
      this.accrualDirty = true;
    }
    this.lastObservedMs = observed;
  }
}

function createTrackerForService(service, overrides = {}) {
  let electron = {};
  try { electron = require('electron'); } catch (_error) { /* Node unit tests */ }
  const deps = {
    ...(service?.options?.workspaceActiveUseTrackerDeps || {}),
    ...overrides,
  };
  const browserWindow = deps.BrowserWindow || electron.BrowserWindow;
  const app = deps.app || electron.app;
  const logger = typeof service?._emitServiceLog === 'function'
    ? service._emitServiceLog.bind(service) : null;
  const store = deps.store || (typeof app?.getPath === 'function'
    ? new FileJsonStore(path.join(app.getPath('userData'), STORE_FILE), { logger })
    : null);
  return new WorkspaceActiveUseTracker({
    store,
    getWorkspaceRoot: () => service?.configService?.getToolsWorkspaceRoot?.()
      || service?.configService?.getState?.()?.toolsWorkspaceRoot || '',
    getBackendStatus: () => service?.getBackendStatus?.() || service?.currentStatus || {},
    getWindow: deps.getWindow || (() => browserWindow?.getFocusedWindow?.()
      || browserWindow?.getAllWindows?.()[0] || null),
    backendEvents: service,
    configEvents: service?.configService,
    appEvents: app,
    now: deps.now,
    setIntervalImpl: deps.setIntervalImpl,
    clearIntervalImpl: deps.clearIntervalImpl,
    flushIntervalMs: deps.flushIntervalMs,
    logger,
  }).start();
}

function activeUseRequestFields(service, workspaceRoot) {
  try {
    const tracker = service?.workspaceActiveUseTracker
      || createTrackerForService(service);
    if (service && !service.workspaceActiveUseTracker) service.workspaceActiveUseTracker = tracker;
    return tracker?.requestFields?.(workspaceRoot) || {};
  } catch (error) {
    service?._emitServiceLog?.('WARN', 'workspace.active_use_unavailable', {
      errorType: String(error?.name || 'Error'),
    });
    return {};
  }
}

module.exports = {
  FLUSH_INTERVAL_MS,
  MAX_TRACKED_WORKSPACES,
  STORE_KEY,
  WorkspaceActiveUseTracker,
  activeUseRequestFields,
  createTrackerForService,
};

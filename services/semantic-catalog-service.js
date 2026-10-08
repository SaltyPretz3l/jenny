'use strict';

// Semantic catalog scheduler (roadmap row 41). Electron decides WHEN the
// sidecar may catalog the knowledge folders; the sidecar owns the index and
// does the work one bounded `catalog.index_step` at a time. The embedder is a
// user-supplied embedding GGUF in its own managed llama-server
// (services/main/embedding-server-manager.js), so the chat model is never
// evicted. Steps are issued only after QUIET_MS without any main-model work;
// the busy check runs before every step, so new work pauses the catalog at the
// next step boundary (a step is capped at STEP_MAX_SECONDS). A chat never
// waits on a step: steps run on the sidecar's catalog worker, not the chat one.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const { API_VERSION } = require('./backend/sidecar-client');
const { pendingRuntimeInferenceCount } = require('./backend/backend-runtime-inference');

const STATES = Object.freeze({
  OFF: 'off',
  WAITING_MODEL: 'waiting_model',
  IDLE_WAIT: 'idle_wait',
  STARTING_ENGINE: 'starting_engine',
  INDEXING: 'indexing',
  PAUSED_BUSY: 'paused_busy',
  CAUGHT_UP: 'caught_up',
  ERROR: 'error',
});

const DEFAULT_QUIET_MS = 30_000;
const DEFAULT_POLL_MS = 2_000;
// Sample busy while engine start or indexing awaits, so a short turn inside
// either operation still resets the quiet wait.
const ENGINE_START_BUSY_SAMPLE_MS = 250;
const DEFAULT_RESCAN_MS = 10 * 60_000;
const DEFAULT_RETRY_MS = 60_000;
const DEFAULT_UNAVAILABLE_RETRY_MS = 5_000;
// Yield between steps so a turn that starts right after one is seen promptly.
const STEP_GAP_MS = 50;
const STEP_MAX_CHUNKS = 16;
const STEP_MAX_SECONDS = 1.5;
const MAX_ROOTS = 32;
const CATALOG_DB_FILENAME = 'semantic-catalog.db';

// Every signal that the main model (or the GPU it lives on) is in use. Unknown
// or throwing state counts as busy: the catalog is the one that yields.
function isMainModelBusy(backend, { pendingInference = pendingRuntimeInferenceCount } = {}) {
  if (!backend) return true;
  if (backend.activeStreams?.size > 0) return true;
  try {
    if (backend.sessionRuntime?.hasPendingOrAdmittedWork?.() === true) return true;
    if (pendingInference(backend) > 0) return true;
  } catch (_error) {
    return true;
  }
  const gpu = backend.exclusiveGpuCoordinator?.getState?.();
  if (gpu && gpu.state && gpu.state !== 'chat_resident') return true;
  const lifecycle = String(backend._modelLifecycle?.state || '');
  return lifecycle === 'acquiring' || lifecycle === 'loading';
}

function isSidecarReady(backend) {
  const client = backend?.sidecarClient;
  if (!client || client.connected !== true || typeof client.request !== 'function') return false;
  const phase = String(backend.sidecarManager?.getStatus?.()?.phase || 'ready');
  return phase === 'ready';
}

function rootsKey(roots) {
  return roots.join('\n');
}

function comparablePath(value) {
  const text = String(value || '').replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function boundedCounts(raw) {
  const counts = {};
  if (!raw || typeof raw !== 'object') return counts;
  for (const key of ['roots', 'documents', 'indexed', 'pending', 'failed', 'skipped', 'chunks', 'embedded']) {
    const value = Number(raw[key]);
    if (Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }
  return counts;
}

function boundedReasons(raw) {
  const reasons = {};
  if (!raw || typeof raw !== 'object') return reasons;
  for (const [key, value] of Object.entries(raw).slice(0, 16)) {
    const count = Number(value);
    if (/^[a-z0-9_]{1,40}$/.test(key) && Number.isSafeInteger(count) && count > 0) reasons[key] = count;
  }
  return reasons;
}

class SemanticCatalogService extends EventEmitter {
  constructor({
    userDataPath,
    getBackend,
    getSettings,
    isFeatureEnabled,
    embeddingManager,
    resolveModel,
    listRootPaths,
    refreshSidecarConfig,
    logger,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    now = Date.now,
    quietMs = DEFAULT_QUIET_MS,
    pollMs = DEFAULT_POLL_MS,
    rescanMs = DEFAULT_RESCAN_MS,
    retryMs = DEFAULT_RETRY_MS,
    isBusy = isMainModelBusy,
    fsImpl = fs,
  } = {}) {
    super();
    this.dbPath = userDataPath ? path.join(userDataPath, CATALOG_DB_FILENAME) : '';
    this.getBackend = typeof getBackend === 'function' ? getBackend : () => null;
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this.isFeatureEnabled = typeof isFeatureEnabled === 'function' ? isFeatureEnabled : () => false;
    this.embeddingManager = embeddingManager || null;
    this.resolveModel = typeof resolveModel === 'function' ? resolveModel : () => ({ ok: false, reason: 'unavailable' });
    this.listRootPaths = typeof listRootPaths === 'function' ? listRootPaths : () => [];
    this.refreshSidecarConfig = typeof refreshSidecarConfig === 'function' ? refreshSidecarConfig : async () => {};
    this.logger = typeof logger === 'function' ? logger : () => {};
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.now = now;
    this.quietMs = quietMs;
    this.pollMs = pollMs;
    this.rescanMs = rescanMs;
    this.retryMs = retryMs;
    this.isBusy = isBusy;
    this.fsImpl = fsImpl;

    this.state = STATES.OFF;
    this.timer = null;
    this.ticking = false;
    this.started = false;
    this.disposed = false;
    this.lastBusyAt = now();
    this.lastRescanAt = 0;
    this.lastRootsKey = null;
    // The model this service resolved and the embedder it is serving; the
    // sidecar config contribution is built from these only once ready.
    this.model = null;
    this.engine = null;
    this.publishedConfigKey = '';
    this.modelRefusal = null;
    // A change that arrives while a tick is awaiting is re-evaluated as soon
    // as that tick ends, never dropped behind its scheduling.
    this.pendingChange = false;
    // While caught up, the next step is due at this time (or when the roots change).
    this.nextStepAt = 0;
    this.counts = {};
    this.lastStep = null;
    this.lastError = null;
    this.updatedAt = null;
  }

  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.lastBusyAt = this.now();
    this._schedule(0);
  }

  // Settings, flag or knowledge-folder change: re-evaluate now. A changed
  // model clears a previous refusal; changed roots force a rescan.
  notifyChanged(reason = 'changed') {
    if (this.disposed) return;
    if (reason === 'settings') {
      this.modelRefusal = null;
      // A new model, device or toggle gets a fresh start past the embedder's failure backoff.
      this.embeddingManager?.reset?.();
    }
    if (reason === 'roots') this.lastRescanAt = 0;
    this.nextStepAt = 0;
    this.pendingChange = true;
    if (this.started && !this.ticking) this._schedule(0);
  }

  // Quit path: synchronous, never awaits the sidecar.
  dispose() {
    this.disposed = true;
    this._clearTimer();
    try {
      this.embeddingManager?.stopSync?.();
    } catch (error) {
      this._log('WARN', 'semantic_catalog.engine_stop_failed', { message: String(error?.message || error) });
    }
  }

  getStatus() {
    const engineState = this.embeddingManager?.getState?.() || null;
    return {
      state: this.state,
      flagEnabled: this.isFeatureEnabled() === true,
      enabled: this._settings().enabled,
      model: this.model ? {
        name: this.model.name,
        profileId: this.model.profileId,
        dims: this.model.dims,
        device: this.model.device,
      } : null,
      engine: engineState ? { status: engineState.status, lastError: engineState.lastError || null } : null,
      counts: { ...this.counts },
      lastStep: this.lastStep ? { ...this.lastStep } : null,
      lastError: this.lastError ? { ...this.lastError } : null,
      updatedAt: this.updatedAt,
    };
  }

  // getStatus() plus the sidecar's per-folder counts for the Settings rows.
  // The per-folder read is best effort: a busy or stopped sidecar leaves it out.
  async getDetailedStatus() {
    const status = this.getStatus();
    const backend = this.getBackend();
    if (!isSidecarReady(backend) || this.state === STATES.OFF) return { ...status, roots: [] };
    try {
      const result = await backend.sidecarClient.request('catalog.status', { accept_version: API_VERSION });
      if (!result || result.available === false) return { ...status, roots: [] };
      const registered = this._registeredPathsByRealPath();
      const roots = Array.isArray(result.roots) ? result.roots.slice(0, MAX_ROOTS).map((root) => ({
        // The sidecar keys roots by real path; Settings rows show the registered path.
        path: registered.get(comparablePath(root?.path)) || String(root?.path || ''),
        ...boundedCounts(root),
        skippedReasons: boundedReasons(root?.skipped_reasons),
        scanComplete: root?.scan_complete === true,
      })) : [];
      const sizeBytes = Number(result.size_bytes);
      return { ...status, roots, sizeBytes: Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null };
    } catch (_error) {
      return { ...status, roots: [] };
    }
  }

  _registeredPathsByRealPath() {
    const map = new Map();
    for (const rootPath of (this.listRootPaths() || []).slice(0, MAX_ROOTS)) {
      if (typeof rootPath !== 'string' || !rootPath.trim()) continue;
      let real = rootPath;
      try {
        real = this.fsImpl.realpathSync.native ? this.fsImpl.realpathSync.native(rootPath) : this.fsImpl.realpathSync(rootPath);
      } catch (_error) { /* an unavailable folder keeps its registered path */ }
      map.set(comparablePath(real), rootPath);
    }
    return map;
  }

  // Rebuild (catalog on): the sidecar drops every document and the next idle
  // step rescans. Delete (catalog off): the sidecar has released the file, so
  // the files are removed here; a file still held open reports catalog_in_use.
  async purge({ rebuild = false } = {}) {
    this.counts = {};
    this.lastStep = null;
    this.lastRescanAt = 0;
    this.lastRootsKey = null;
    if (this.engine) {
      const backend = this.getBackend();
      if (!isSidecarReady(backend)) return { ok: false, reason: 'sidecar_unavailable' };
      try {
        const result = await backend.sidecarClient.request('catalog.purge', { accept_version: API_VERSION, all: true });
        if (!result || result.ok !== true) return { ok: false, reason: 'purge_failed' };
      } catch (_error) {
        return { ok: false, reason: 'purge_failed' };
      }
      if (rebuild) this._schedule(0);
      this.emit('status', this.getStatus());
      return { ok: true };
    }
    const removed = this.removeCatalogFiles();
    this.emit('status', this.getStatus());
    return removed;
  }

  removeCatalogFiles() {
    if (!this.dbPath) return { ok: false, reason: 'unavailable' };
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        this.fsImpl.unlinkSync(`${this.dbPath}${suffix}`);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        return { ok: false, reason: error?.code === 'EBUSY' || error?.code === 'EPERM' ? 'catalog_in_use' : 'delete_failed' };
      }
    }
    return { ok: true };
  }

  // Contribution merged into the managed-sidecar config. Enabled only while
  // the embedder is ready; the key travels separately as a secret.
  getSidecarConfig() {
    if (!this.engine || !this.model || !this.dbPath) {
      return { semantic_catalog: { enabled: false } };
    }
    return {
      semantic_catalog: {
        enabled: true,
        db_path: this.dbPath,
        base_url: this.engine.baseUrl,
        model_key: this.model.modelKey,
        query_template: this.model.queryTemplate,
        document_template: this.model.documentTemplate,
        dims: this.model.dims,
      },
    };
  }

  getSidecarSecrets() {
    const apiKey = this.engine ? String(this.embeddingManager?.getApiKey?.() || '') : '';
    return apiKey ? { semantic_catalog_api_key: apiKey } : {};
  }

  _settings() {
    const raw = this.getSettings() || {};
    return {
      enabled: raw.enabled !== false,
      modelPath: typeof raw.modelPath === 'string' ? raw.modelPath : '',
      profileId: typeof raw.profileId === 'string' ? raw.profileId : '',
      device: raw.device === 'gpu' ? 'gpu' : 'cpu',
      dims: Number.isSafeInteger(raw.dims) ? raw.dims : 0,
    };
  }

  _log(level, event, details = {}) {
    try {
      this.logger(level, event, details);
    } catch (_error) { /* logging never breaks the scheduler */ }
  }

  _setState(state, { error } = {}) {
    if (error !== undefined) this.lastError = error;
    if (state === this.state && error === undefined) return;
    const previous = this.state;
    this.state = state;
    this.updatedAt = new Date(this.now()).toISOString();
    if (previous !== state && (state === STATES.PAUSED_BUSY || state === STATES.INDEXING)) {
      this._log('INFO', state === STATES.PAUSED_BUSY ? 'semantic_catalog.paused' : 'semantic_catalog.indexing', {
        from: previous,
      });
    }
    this.emit('status', this.getStatus());
  }

  _clearTimer() {
    if (this.timer !== null) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
  }

  _schedule(delayMs) {
    if (this.disposed) return;
    this._clearTimer();
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      void this._tick();
    }, Math.max(0, delayMs));
    this.timer?.unref?.();
  }

  async _tick() {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    this.pendingChange = false;
    let next;
    try {
      next = await this._evaluate();
    } catch (error) {
      this._log('WARN', 'semantic_catalog.tick_failed', { message: String(error?.message || error) });
      next = this.retryMs;
    } finally {
      this.ticking = false;
    }
    if (this.pendingChange) next = 0;
    if (next !== null && !this.disposed) this._schedule(next);
  }

  // One scheduler decision. Returns the delay before the next tick, or null
  // when only notifyChanged() can make progress.
  async _evaluate() {
    const settings = this._settings();
    if (this.isFeatureEnabled() !== true || !settings.enabled) {
      await this._shutdownEngine();
      this._setState(STATES.OFF);
      return this.publishedConfigKey && this.publishedConfigKey !== 'disabled' ? this.retryMs : null;
    }
    if (!settings.modelPath) {
      await this._shutdownEngine();
      this._setState(STATES.WAITING_MODEL);
      return this.publishedConfigKey && this.publishedConfigKey !== 'disabled' ? this.retryMs : null;
    }
    if (this.modelRefusal) return null;

    const backend = this.getBackend();
    const busy = this.isBusy(backend);
    // Busy is tracked on every poll, including while caught up, so a step
    // that comes due always follows a full quiet period.
    if (busy) this.lastBusyAt = this.now();
    if (this.state === STATES.CAUGHT_UP && !this._stepDue()) {
      return Math.max(1, Math.min(this.pollMs, this.nextStepAt - this.now()));
    }
    if (busy) {
      if (this.state !== STATES.ERROR) {
        this._setState(this.engine ? STATES.PAUSED_BUSY : STATES.IDLE_WAIT);
      }
      return this.pollMs;
    }
    const quietFor = this.now() - this.lastBusyAt;
    if (quietFor < this.quietMs) {
      if (this.state !== STATES.ERROR) {
        this._setState(this.engine ? STATES.PAUSED_BUSY : STATES.IDLE_WAIT);
      }
      return Math.min(this.pollMs, this.quietMs - quietFor);
    }
    if (this.state === STATES.PAUSED_BUSY && !this._stepDue()) {
      this._setState(STATES.CAUGHT_UP);
      return Math.max(1, Math.min(this.pollMs, this.nextStepAt - this.now()));
    }
    if (!isSidecarReady(backend)) return this.pollMs;

    const engineReady = await this._watchBusy(backend, () => this._ensureEngine(settings));
    if (!engineReady) return this.state === STATES.ERROR && this.modelRefusal ? null : this.retryMs;
    // Starting the engine and publishing the config take time: re-check
    // before issuing a step, and wait out the quiet period again if any work
    // was seen meanwhile.
    if (this.pendingChange || this.disposed) return 0;
    if (this.isBusy(backend)) this.lastBusyAt = this.now();
    const quietAfterStart = this.now() - this.lastBusyAt;
    if (quietAfterStart < this.quietMs) {
      this._setState(STATES.PAUSED_BUSY);
      return Math.min(this.pollMs, this.quietMs - quietAfterStart);
    }
    const next = await this._watchBusy(backend, () => this._step(backend));
    const quietAfterStep = this.now() - this.lastBusyAt;
    if (this.state !== STATES.ERROR && quietAfterStep < this.quietMs) {
      this._setState(STATES.PAUSED_BUSY);
      return Math.min(this.pollMs, this.quietMs - quietAfterStep);
    }
    return next;
  }

  _currentRoots() {
    return [...new Set((this.listRootPaths() || [])
      .filter((root) => typeof root === 'string' && root.trim())
      .map((root) => root.trim()))].slice(0, MAX_ROOTS);
  }

  _stepDue() {
    return this.now() >= this.nextStepAt || rootsKey(this._currentRoots()) !== this.lastRootsKey;
  }

  async _watchBusy(backend, fn) {
    let timer;
    let watching = true;
    const sample = () => {
      if (!watching) return;
      try {
        if (this.isBusy(backend)) this.lastBusyAt = this.now();
      } catch (_error) {
        this.lastBusyAt = this.now();
      }
      timer = this.setTimeoutImpl(sample, ENGINE_START_BUSY_SAMPLE_MS);
    };
    timer = this.setTimeoutImpl(sample, ENGINE_START_BUSY_SAMPLE_MS);
    try {
      return await fn();
    } finally {
      watching = false;
      this.clearTimeoutImpl(timer);
    }
  }

  async _ensureEngine(settings) {
    const resolved = this.resolveModel(settings);
    if (!resolved || resolved.ok !== true) {
      const reason = String(resolved?.reason || 'unavailable');
      this.modelRefusal = reason;
      await this._shutdownEngine();
      this._setState(STATES.ERROR, { error: { code: 'embedding_model_refused', reason } });
      return false;
    }
    if (!this.engine) this._setState(STATES.STARTING_ENGINE);
    let engine;
    try {
      engine = await this.embeddingManager.ensureRunning({
        modelPath: settings.modelPath,
        device: settings.device,
      });
    } catch (error) {
      this.engine = null;
      const [code, reason] = String(error?.message || error).split(':');
      this._log('WARN', 'semantic_catalog.engine_unavailable', { code });
      await this._publishConfig();
      this._setState(STATES.ERROR, {
        error: reason ? { code: code || 'embedder_failed', reason: reason.slice(0, 40) } : { code: code || 'embedder_failed' },
      });
      return false;
    }
    this.engine = { baseUrl: String(engine.baseUrl || '') };
    this.model = {
      name: String(resolved.name || ''),
      profileId: String(resolved.profileId || 'none'),
      dims: Number.isSafeInteger(resolved.dims) ? resolved.dims : 0,
      device: settings.device,
      queryTemplate: String(resolved.queryTemplate || '{text}'),
      documentTemplate: String(resolved.documentTemplate || '{text}'),
      modelKey: `${String(engine.modelKey || 'model')}:${String(resolved.profileId || 'none')}:${resolved.dims || 0}`,
    };
    await this._publishConfig();
    return true;
  }

  // Push the catalog contribution to the sidecar when it changed (a new port,
  // model, profile or dims), and once more when the engine goes away.
  async _publishConfig() {
    const config = this.getSidecarConfig().semantic_catalog;
    const key = config.enabled ? `${config.base_url}|${config.model_key}|${config.dims}` : 'disabled';
    if (key === this.publishedConfigKey || (key === 'disabled' && this.publishedConfigKey === '')) return;
    try {
      await this.refreshSidecarConfig('semantic_catalog_changed');
      // Remembered only once applied, so a failed refresh is retried next tick.
      this.publishedConfigKey = key;
    } catch (error) {
      this._log('WARN', 'semantic_catalog.config_refresh_failed', { message: String(error?.message || error) });
    }
  }

  async _shutdownEngine() {
    const hadEngine = this.engine !== null;
    this.engine = null;
    this.model = null;
    if (hadEngine) {
      try {
        await this.embeddingManager?.stop?.();
      } catch (error) {
        this._log('WARN', 'semantic_catalog.engine_stop_failed', { message: String(error?.message || error) });
      }
    }
    await this._publishConfig();
  }

  async _step(backend) {
    const roots = this._currentRoots();
    const key = rootsKey(roots);
    const rescan = key !== this.lastRootsKey || this.now() - this.lastRescanAt >= this.rescanMs;
    let result;
    try {
      result = await backend.sidecarClient.request('catalog.index_step', {
        accept_version: API_VERSION,
        roots: roots.map((root) => ({ path: root })),
        budget: { max_chunks: STEP_MAX_CHUNKS, max_seconds: STEP_MAX_SECONDS },
        rescan,
      });
    } catch (error) {
      this._log('WARN', 'semantic_catalog.step_failed', { message: String(error?.message || error).slice(0, 200) });
      this._setState(STATES.ERROR, { error: { code: 'step_failed' } });
      return this.retryMs;
    }
    if (!result || result.available === false) {
      // The sidecar has not applied the catalog config yet.
      return DEFAULT_UNAVAILABLE_RETRY_MS;
    }
    if (rescan) {
      this.lastRescanAt = this.now();
      this.lastRootsKey = key;
    }
    this.counts = boundedCounts(result.counts);
    this.lastStep = result.step && typeof result.step === 'object'
      ? { embedded: Number(result.step.embedded) || 0, elapsedMs: Number(result.step.elapsed_ms) || 0 }
      : null;
    if (result.error && typeof result.error === 'object') {
      this._setState(STATES.ERROR, { error: { code: String(result.error.code || 'step_error').slice(0, 40) } });
      return this.retryMs;
    }
    if (result.more === true) {
      this._setState(STATES.INDEXING, { error: null });
      return STEP_GAP_MS;
    }
    this.nextStepAt = this.lastRescanAt + this.rescanMs;
    this._setState(STATES.CAUGHT_UP, { error: null });
    return this.pollMs;
  }
}

module.exports = {
  CATALOG_DB_FILENAME,
  STATES,
  STEP_MAX_CHUNKS,
  STEP_MAX_SECONDS,
  SemanticCatalogService,
  isMainModelBusy,
};

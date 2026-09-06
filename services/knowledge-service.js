const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { isSensitiveAttachmentPath } = require('./attachment-service');

const KNOWLEDGE_FILENAME = 'knowledge.json';
const KNOWLEDGE_SCHEMA_VERSION = 1;
// Resource-bounds rule (AGENTS.md §9): cap the registry so the sidecar config
// payload and the on-disk file cannot grow unbounded from repeated adds.
const DEFAULT_MAX_ROOTS = 32;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function defaultRealpath(targetPath) {
  return fs.realpathSync.native
    ? fs.realpathSync.native(targetPath)
    : fs.realpathSync(targetPath);
}

function cloneRoot(root = {}) {
  return {
    id: String(root.id || ''),
    path: String(root.path || ''),
    label: String(root.label || ''),
    addedAt: String(root.addedAt || ''),
  };
}

/**
 * User-folder registry of "knowledge roots" persisted to
 * `<userData>/knowledge.json` and published into the managed-sidecar config
 * channel (paths, not secrets). Inert unless the `knowledge_layer` feature
 * flag is enabled AND the user has registered at least one folder.
 */
class KnowledgeService extends EventEmitter {
  constructor({
    userDataPath,
    featureFlagProvider = () => ({}),
    maxRoots = DEFAULT_MAX_ROOTS,
    logger = null,
    refreshManagedConfig = null,
    fsImpl = fs,
    realpathImpl = defaultRealpath,
    isSensitivePathImpl = isSensitiveAttachmentPath,
    nowProvider = () => new Date(),
    idFactory = () => `kbroot_${crypto.randomUUID()}`,
  } = {}) {
    super();
    if (!userDataPath) {
      throw new Error('userDataPath is required for KnowledgeService.');
    }
    this.userDataPath = String(userDataPath);
    this.knowledgePath = path.join(this.userDataPath, KNOWLEDGE_FILENAME);
    this.featureFlagProvider = typeof featureFlagProvider === 'function' ? featureFlagProvider : () => ({});
    this.maxRoots = Math.max(1, Number(maxRoots) || DEFAULT_MAX_ROOTS);
    this.logger = typeof logger === 'function' ? logger : null;
    this.refreshManagedConfig = typeof refreshManagedConfig === 'function' ? refreshManagedConfig : null;
    this.fs = fsImpl || fs;
    this.realpathImpl = typeof realpathImpl === 'function' ? realpathImpl : defaultRealpath;
    this.isSensitivePathImpl = typeof isSensitivePathImpl === 'function'
      ? isSensitivePathImpl
      : isSensitiveAttachmentPath;
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
    this.idFactory = typeof idFactory === 'function' ? idFactory : () => `kbroot_${crypto.randomUUID()}`;
    // Lazy-load: roots hydrate from disk on first access, never at construction
    // (flag-off construction must not touch the filesystem).
    this._roots = null;
    this._readOnlyReason = '';
  }

  _log(level, event, details = {}) {
    if (!this.logger) {
      return;
    }
    this.logger(level, event, details);
  }

  _isFeatureEnabled() {
    let flags;
    try {
      flags = this.featureFlagProvider() || {};
    } catch (_error) {
      return false;
    }
    return flags.knowledge_layer === true;
  }

  // Load + normalize persisted roots. Corrupt JSON or an unknown FUTURE
  // schemaVersion loads empty + warns; never throws.
  _loadRoots() {
    let raw;
    try {
      raw = this.fs.readFileSync(this.knowledgePath, 'utf8');
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this._log('WARN', 'knowledge.read_failed', {
          message: normalizeString(error.message) || 'knowledge.json could not be read.',
          code: normalizeString(error.code),
        });
      }
      return [];
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_error) {
      this._log('WARN', 'knowledge.corrupt_json', {
        message: 'knowledge.json is malformed; loading an empty registry.',
      });
      return [];
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      this._log('WARN', 'knowledge.corrupt_json', {
        message: 'knowledge.json is not an object; loading an empty registry.',
      });
      return [];
    }
    const version = Number(payload.schemaVersion);
    if (Number.isFinite(version) && version > KNOWLEDGE_SCHEMA_VERSION) {
      this._readOnlyReason = 'schema_too_new';
      this._log('WARN', 'knowledge.schema_too_new', {
        message: 'knowledge.json schemaVersion is newer than this build supports; loading an empty registry.',
        foundVersion: version,
        supportedVersion: KNOWLEDGE_SCHEMA_VERSION,
      });
      return [];
    }
    const sourceRoots = Array.isArray(payload.roots) ? payload.roots : [];
    const roots = [];
    for (const [index, entry] of sourceRoots.entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        this._log('WARN', 'knowledge.persisted_root_rejected', {
          index,
          reason: 'invalid_entry',
        });
        continue;
      }
      // A persisted root on a disconnected drive must survive reloads, so a
      // missing path is kept as stored; everything else is validated like addFolder.
      const normalized = this._normalizeRootPath(entry.path, roots, { allowMissing: true });
      if (!normalized.ok) {
        this._log('WARN', 'knowledge.persisted_root_rejected', {
          index,
          reason: normalized.reason,
        });
        continue;
      }
      const id = normalizeString(entry.id) || this.idFactory();
      if (roots.some((root) => root.id === id)) {
        this._log('WARN', 'knowledge.persisted_root_rejected', {
          index,
          reason: 'duplicate_id',
        });
        continue;
      }
      roots.push({
        id,
        path: normalized.path,
        label: normalizeString(entry.label),
        addedAt: normalizeString(entry.addedAt),
      });
    }
    return roots;
  }

  _ensureRoots() {
    if (this._roots === null) {
      this._roots = this._loadRoots();
    }
    return this._roots;
  }

  _normalizeRootPath(inputPath, roots, { allowMissing = false } = {}) {
    const candidate = normalizeString(inputPath);
    if (!candidate || !path.isAbsolute(candidate)) {
      return { ok: false, reason: 'invalid_path' };
    }
    let realPath;
    let missing = false;
    try {
      realPath = this.realpathImpl(candidate);
    } catch (error) {
      const code = normalizeString(error?.code).toUpperCase();
      if (code === 'ENOENT' && allowMissing) {
        realPath = candidate;
        missing = true;
      } else {
        return { ok: false, reason: code === 'ENOENT' ? 'not_found' : 'invalid_path' };
      }
    }
    if (this.isSensitivePathImpl(realPath)) {
      return { ok: false, reason: 'sensitive_path' };
    }
    if (!missing) {
      let stats;
      try {
        stats = this.fs.statSync(realPath);
      } catch (_error) {
        return { ok: false, reason: 'not_found' };
      }
      if (!stats.isDirectory()) {
        return { ok: false, reason: 'not_a_directory' };
      }
    }
    if (roots.some((root) => root.path === realPath)) {
      return { ok: false, reason: 'duplicate' };
    }
    if (roots.length >= this.maxRoots) {
      return { ok: false, reason: 'limit_reached' };
    }
    return { ok: true, path: realPath };
  }

  _persist(roots) {
    const payload = {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      roots: roots.map((root) => ({
        id: root.id,
        path: root.path,
        label: root.label,
        addedAt: root.addedAt,
      })),
    };
    this.fs.mkdirSync(this.userDataPath, { recursive: true });
    this.fs.writeFileSync(this.knowledgePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  _emitChanged(reason) {
    const snapshot = this.getStateSnapshot();
    this.emit('changed', snapshot, { reason });
    if (this.refreshManagedConfig) {
      // Publish the updated roots into the managed-sidecar config channel.
      // Mirrors McpDiscoveryService.refresh(): a structured failure inside the
      // async refresh must not throw across the add/remove result contract.
      Promise.resolve(this.refreshManagedConfig(reason)).catch((error) => {
        this._log('WARN', 'knowledge.managed_config_refresh_failed', {
          reason,
          message: normalizeString(error?.message) || String(error),
        });
      });
    }
  }

  addFolder({ path: inputPath, label } = {}) {
    if (!this._isFeatureEnabled()) {
      return { ok: false, reason: 'feature_disabled' };
    }
    const roots = this._ensureRoots();
    if (this._readOnlyReason) {
      return { ok: false, reason: this._readOnlyReason };
    }
    const normalized = this._normalizeRootPath(inputPath, roots);
    if (!normalized.ok) {
      return normalized;
    }
    const root = {
      id: this.idFactory(),
      path: normalized.path,
      label: normalizeString(label),
      addedAt: this.nowProvider().toISOString(),
    };
    const nextRoots = [...roots, root];
    this._persist(nextRoots);
    this._roots = nextRoots;
    this._emitChanged('knowledge_root_added');
    return { ok: true, root: cloneRoot(root) };
  }

  removeFolder({ id } = {}) {
    if (!this._isFeatureEnabled()) {
      return { ok: false, reason: 'feature_disabled' };
    }
    const targetId = normalizeString(id);
    const roots = this._ensureRoots();
    if (this._readOnlyReason) {
      return { ok: false, reason: this._readOnlyReason };
    }
    const index = roots.findIndex((root) => root.id === targetId);
    if (index === -1) {
      return { ok: false, reason: 'not_found' };
    }
    const nextRoots = [...roots.slice(0, index), ...roots.slice(index + 1)];
    this._persist(nextRoots);
    this._roots = nextRoots;
    this._emitChanged('knowledge_root_removed');
    return { ok: true };
  }

  getStateSnapshot() {
    const enabled = this._isFeatureEnabled();
    if (!enabled) {
      return { schemaVersion: KNOWLEDGE_SCHEMA_VERSION, roots: [], enabled: false };
    }
    return {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      roots: this._ensureRoots().map((root) => cloneRoot(root)),
      enabled: true,
    };
  }

  // Contribution merged into the managed-sidecar config payload. Enabled only
  // when the flag is on AND the user opted in by registering a folder. Roots
  // are absolute realpaths (paths, not secrets — CONFIG channel, not safeStorage).
  getSidecarConfig() {
    if (!this._isFeatureEnabled()) {
      return { tools_knowledge_enabled: false, knowledge_roots: [] };
    }
    const knowledgeRoots = this._ensureRoots().map((root) => root.path);
    return {
      tools_knowledge_enabled: knowledgeRoots.length > 0,
      knowledge_roots: knowledgeRoots,
    };
  }
}

module.exports = {
  KNOWLEDGE_FILENAME,
  KNOWLEDGE_SCHEMA_VERSION,
  DEFAULT_MAX_ROOTS,
  KnowledgeService,
};

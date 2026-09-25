const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { isSensitiveAttachmentPath } = require('./attachment-service');
const { FileJsonStore } = require('./backend/file-json-store');
const { GENERAL_PROJECT_ID, normalizeProjectId } = require('./projects/project-schema');

const KNOWLEDGE_FILENAME = 'knowledge.json';
const KNOWLEDGE_SCHEMA_VERSION = 2;
const LEGACY_KNOWLEDGE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ROOTS = 32;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const CURRENT_DOCUMENT_KEYS = Object.freeze(['revision', 'roots', 'schemaVersion']);
const LEGACY_DOCUMENT_KEYS = Object.freeze(['roots', 'schemaVersion']);
const CURRENT_ROOT_KEYS = Object.freeze(['addedAt', 'id', 'label', 'path', 'project_id']);
const LEGACY_ROOT_KEYS = Object.freeze(['addedAt', 'id', 'label', 'path']);

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
    id: root.id,
    path: root.path,
    label: root.label,
    addedAt: root.addedAt,
    project_id: root.project_id,
  };
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function emptyDocument(revision = 0) {
  return { schemaVersion: KNOWLEDGE_SCHEMA_VERSION, revision, roots: [] };
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
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    logger = null,
    refreshManagedConfig = null,
    fsImpl = fs,
    store = null,
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
    this.maxRoots = Math.min(
      DEFAULT_MAX_ROOTS,
      Math.max(1, Math.trunc(Number(maxRoots) || DEFAULT_MAX_ROOTS))
    );
    this.maxFileBytes = Math.min(
      DEFAULT_MAX_FILE_BYTES,
      Math.max(1, Math.trunc(Number(maxFileBytes) || DEFAULT_MAX_FILE_BYTES))
    );
    this.logger = typeof logger === 'function' ? logger : null;
    this.refreshManagedConfig = typeof refreshManagedConfig === 'function' ? refreshManagedConfig : null;
    this.fs = fsImpl || fs;
    this.store = store || new FileJsonStore(this.knowledgePath);
    this.realpathImpl = typeof realpathImpl === 'function' ? realpathImpl : defaultRealpath;
    this.isSensitivePathImpl = typeof isSensitivePathImpl === 'function'
      ? isSensitivePathImpl
      : isSensitiveAttachmentPath;
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
    this.idFactory = typeof idFactory === 'function' ? idFactory : () => `kbroot_${crypto.randomUUID()}`;
    // Lazy-load: the registry hydrates from disk on first access, never at construction
    // (flag-off construction must not touch the filesystem).
    this._document = null;
    this._readOnlyReason = '';
  }

  _log(level, event, details = {}) {
    try {
      this.logger?.(level, event, details);
    } catch (_error) {
      // Diagnostics cannot alter registry behavior.
    }
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

  _setReadOnly(reason, event, details = {}) {
    this._readOnlyReason = reason;
    this._log('WARN', event, { reason, ...details });
    return emptyDocument();
  }

  _readRawFile() {
    let stats;
    try {
      stats = this.fs.statSync(this.knowledgePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return { missing: true, raw: '' };
      return { error, missing: false, raw: '' };
    }
    if (!stats.isFile() || stats.size > this.maxFileBytes) {
      return {
        oversized: stats.isFile() && stats.size > this.maxFileBytes,
        invalidType: !stats.isFile(),
      };
    }
    try {
      const raw = this.fs.readFileSync(this.knowledgePath, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > this.maxFileBytes) return { oversized: true };
      return { missing: false, raw };
    } catch (error) {
      return { error, missing: false, raw: '' };
    }
  }

  _loadDocument() {
    const read = this._readRawFile();
    if (read.missing) return emptyDocument();
    if (read.oversized) {
      return this._setReadOnly('file_too_large', 'knowledge.file_too_large', {
        maxBytes: this.maxFileBytes,
      });
    }
    if (read.invalidType || read.error) {
      return this._setReadOnly('read_failed', 'knowledge.read_failed', {
        code: normalizeString(read.error?.code),
        message: normalizeString(read.error?.message).slice(0, 240),
      });
    }

    let payload;
    try {
      payload = JSON.parse(read.raw);
    } catch (_error) {
      return this._setReadOnly('malformed_json', 'knowledge.malformed_json');
    }
    if (!isPlainObject(payload) || !Number.isSafeInteger(payload.schemaVersion)) {
      return this._setReadOnly('invalid_schema', 'knowledge.invalid_schema');
    }
    if (payload.schemaVersion > KNOWLEDGE_SCHEMA_VERSION) {
      return this._setReadOnly('schema_too_new', 'knowledge.schema_too_new', {
        foundVersion: payload.schemaVersion,
        supportedVersion: KNOWLEDGE_SCHEMA_VERSION,
      });
    }
    if (payload.schemaVersion === LEGACY_KNOWLEDGE_SCHEMA_VERSION) {
      const legacy = this._validateDocument(payload, { legacy: true });
      if (!legacy.ok) {
        return this._setReadOnly(legacy.reason, 'knowledge.invalid_legacy_schema');
      }
      const migrated = {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        revision: 1,
        roots: legacy.roots.map((root) => ({ ...root, project_id: GENERAL_PROJECT_ID })),
      };
      try {
        this._persistDocument(migrated);
      } catch (error) {
        return this._setReadOnly('migration_write_failed', 'knowledge.migration_write_failed', {
          message: normalizeString(error?.message).slice(0, 240),
        });
      }
      return migrated;
    }
    if (payload.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) {
      return this._setReadOnly('unsupported_schema', 'knowledge.unsupported_schema', {
        foundVersion: payload.schemaVersion,
      });
    }
    const current = this._validateDocument(payload);
    if (!current.ok) return this._setReadOnly(current.reason, 'knowledge.invalid_schema');
    return current.document;
  }

  _validateDocument(payload, { legacy = false } = {}) {
    const expectedDocumentKeys = legacy ? LEGACY_DOCUMENT_KEYS : CURRENT_DOCUMENT_KEYS;
    if (!isPlainObject(payload)
      || !hasExactKeys(payload, expectedDocumentKeys)
      || !Array.isArray(payload.roots)
      || payload.roots.length > this.maxRoots
      || (!legacy && (!Number.isSafeInteger(payload.revision) || payload.revision < 0))) {
      return { ok: false, reason: 'invalid_schema' };
    }
    const roots = [];
    const ids = new Set();
    const projectPaths = new Set();
    for (const entry of payload.roots) {
      const expectedRootKeys = legacy ? LEGACY_ROOT_KEYS : CURRENT_ROOT_KEYS;
      if (!isPlainObject(entry) || !hasExactKeys(entry, expectedRootKeys)) {
        return { ok: false, reason: 'invalid_schema' };
      }
      const id = normalizeString(entry.id);
      const projectId = legacy ? GENERAL_PROJECT_ID : normalizeProjectId(entry.project_id);
      if (!id || id !== entry.id || ids.has(id)
        || typeof entry.label !== 'string'
        || typeof entry.addedAt !== 'string'
        || (!legacy && (!projectId || projectId !== entry.project_id))) {
        return { ok: false, reason: 'invalid_schema' };
      }
      const normalized = this._normalizeRootPath(entry.path, roots, {
        allowMissing: true,
        projectId,
        enforceLimit: false,
      });
      const projectPathKey = `${projectId}\u0000${normalized.path || ''}`;
      if (!normalized.ok
        || (!legacy && normalized.path !== entry.path)
        || projectPaths.has(projectPathKey)) {
        return { ok: false, reason: 'invalid_schema' };
      }
      ids.add(id);
      projectPaths.add(projectPathKey);
      roots.push({
        id: entry.id,
        path: normalized.path,
        label: entry.label,
        addedAt: entry.addedAt,
        ...(legacy ? {} : { project_id: entry.project_id }),
      });
    }
    if (legacy) return { ok: true, roots };
    return {
      ok: true,
      document: { schemaVersion: KNOWLEDGE_SCHEMA_VERSION, revision: payload.revision, roots },
    };
  }

  _ensureDocument() {
    if (this._document === null) this._document = this._loadDocument();
    return this._document;
  }

  _resolveProjectId(projectId) {
    if (projectId === undefined) return { ok: true, projectId: GENERAL_PROJECT_ID };
    const normalized = normalizeProjectId(projectId);
    return normalized
      ? { ok: true, projectId: normalized }
      : { ok: false, reason: 'invalid_project_id' };
  }

  _validateExpectedRevision(expectedRevision, currentRevision) {
    if (expectedRevision === undefined) return { ok: true };
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return { ok: false, reason: 'invalid_expected_revision' };
    }
    if (expectedRevision !== currentRevision) {
      return { ok: false, reason: 'stale_revision', current_revision: currentRevision };
    }
    return { ok: true };
  }

  _normalizeRootPath(
    inputPath,
    roots,
    { allowMissing = false, projectId = GENERAL_PROJECT_ID, enforceLimit = true } = {}
  ) {
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
    if (roots.some((root) => root.project_id === projectId && root.path === realPath)) {
      return { ok: false, reason: 'duplicate' };
    }
    if (enforceLimit && roots.length >= this.maxRoots) {
      return { ok: false, reason: 'limit_reached' };
    }
    return { ok: true, path: realPath };
  }

  _persistDocument(document) {
    const bytes = JSON.stringify(document, null, 2);
    if (Buffer.byteLength(bytes, 'utf8') > this.maxFileBytes) {
      const error = new Error('Knowledge registry exceeds its serialized byte bound.');
      error.code = 'file_too_large';
      throw error;
    }
    const result = this.store.write(document);
    if (result?.durable !== true) {
      const error = new Error('Knowledge registry persistence was not durable.');
      error.code = 'durability_deferred';
      throw error;
    }
  }

  _nextRevision(document) {
    return document.revision < Number.MAX_SAFE_INTEGER ? document.revision + 1 : null;
  }

  _emitChanged(reason, projectId) {
    const snapshot = this.getStateSnapshot({ projectId });
    this.emit('changed', snapshot, { reason, projectId, revision: snapshot.revision });
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

  addFolder({ path: inputPath, label, projectId, expectedRevision } = {}) {
    if (!this._isFeatureEnabled()) return { ok: false, reason: 'feature_disabled' };
    const scope = this._resolveProjectId(projectId);
    if (!scope.ok) return scope;
    const document = this._ensureDocument();
    if (this._readOnlyReason) return { ok: false, reason: this._readOnlyReason };
    const revisionCheck = this._validateExpectedRevision(expectedRevision, document.revision);
    if (!revisionCheck.ok) return revisionCheck;
    const normalized = this._normalizeRootPath(inputPath, document.roots, {
      projectId: scope.projectId,
    });
    if (!normalized.ok) return normalized;
    const id = normalizeString(this.idFactory());
    if (!id || document.roots.some((root) => root.id === id)) {
      return { ok: false, reason: 'id_conflict' };
    }
    const revision = this._nextRevision(document);
    if (revision === null) return { ok: false, reason: 'revision_exhausted' };
    const root = {
      id,
      path: normalized.path,
      label: normalizeString(label),
      addedAt: this.nowProvider().toISOString(),
      project_id: scope.projectId,
    };
    const nextDocument = { ...document, revision, roots: [...document.roots, root] };
    try {
      this._persistDocument(nextDocument);
    } catch (error) {
      if (error?.code === 'file_too_large') return { ok: false, reason: 'file_too_large' };
      throw error;
    }
    this._document = nextDocument;
    this._emitChanged('knowledge_root_added', scope.projectId);
    return { ok: true, root: cloneRoot(root) };
  }

  removeFolder({ id, projectId, expectedRevision } = {}) {
    if (!this._isFeatureEnabled()) return { ok: false, reason: 'feature_disabled' };
    const scope = this._resolveProjectId(projectId);
    if (!scope.ok) return scope;
    const targetId = normalizeString(id);
    const document = this._ensureDocument();
    if (this._readOnlyReason) return { ok: false, reason: this._readOnlyReason };
    const revisionCheck = this._validateExpectedRevision(expectedRevision, document.revision);
    if (!revisionCheck.ok) return revisionCheck;
    const index = document.roots.findIndex(
      (root) => root.id === targetId && root.project_id === scope.projectId
    );
    if (index === -1) return { ok: false, reason: 'not_found' };
    const revision = this._nextRevision(document);
    if (revision === null) return { ok: false, reason: 'revision_exhausted' };
    const nextDocument = {
      ...document,
      revision,
      roots: [...document.roots.slice(0, index), ...document.roots.slice(index + 1)],
    };
    this._persistDocument(nextDocument);
    this._document = nextDocument;
    this._emitChanged('knowledge_root_removed', scope.projectId);
    return { ok: true };
  }

  getStateSnapshot({ projectId } = {}) {
    const enabled = this._isFeatureEnabled();
    const scope = this._resolveProjectId(projectId);
    if (!enabled || !scope.ok) {
      return {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        revision: 0,
        roots: [],
        enabled,
        projectId: scope.ok ? scope.projectId : '',
        readOnly: false,
        reason: scope.ok ? null : scope.reason,
      };
    }
    const document = this._ensureDocument();
    return {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      revision: document.revision,
      roots: this._readOnlyReason
        ? []
        : document.roots
          .filter((root) => root.project_id === scope.projectId)
          .map((root) => cloneRoot(root)),
      enabled: true,
      projectId: scope.projectId,
      readOnly: Boolean(this._readOnlyReason),
      reason: this._readOnlyReason || null,
    };
  }

  // Contribution merged into the managed-sidecar config payload. Enabled only
  // when the flag is on AND the user opted in by registering a folder. Roots
  // are absolute realpaths (paths, not secrets — CONFIG channel, not safeStorage).
  getSidecarConfig({ projectId } = {}) {
    if (!this._isFeatureEnabled()) {
      return { tools_knowledge_enabled: false, knowledge_roots: [] };
    }
    const scope = this._resolveProjectId(projectId);
    if (!scope.ok) return { tools_knowledge_enabled: false, knowledge_roots: [] };
    const document = this._ensureDocument();
    const knowledgeRoots = this._readOnlyReason
      ? []
      : document.roots
        .filter((root) => root.project_id === scope.projectId)
        .map((root) => root.path);
    return {
      tools_knowledge_enabled: knowledgeRoots.length > 0,
      knowledge_roots: [...knowledgeRoots],
    };
  }
}

module.exports = {
  KNOWLEDGE_FILENAME,
  KNOWLEDGE_SCHEMA_VERSION,
  DEFAULT_MAX_ROOTS,
  DEFAULT_MAX_FILE_BYTES,
  KnowledgeService,
};

'use strict';

const { FileJsonStore } = require('../backend/file-json-store');
const {
  PROJECT_STORE_SCHEMA_VERSION,
  createGeneralProject,
  validateProjectDocument,
} = require('./project-schema');

class ProjectStore {
  constructor(filePath, { logger = null, store = null, now = () => new Date().toISOString() } = {}) {
    this.filePath = filePath;
    this._logger = typeof logger === 'function' ? logger : null;
    this._store = store || new FileJsonStore(filePath, { logger: this._logger });
    this._now = typeof now === 'function' ? now : () => new Date().toISOString();
    this._readOnlyReason = '';
    this._document = this._load();
  }

  _defaultDocument() {
    const general = createGeneralProject(this._now());
    return { schema_version: PROJECT_STORE_SCHEMA_VERSION, projects: { [general.id]: general } };
  }

  _load() {
    const fallback = this._defaultDocument();
    const status = this._store.readWithStatus(fallback);
    if (status.corrupted) {
      this._readOnlyReason = 'corrupt_store';
      return fallback;
    }
    if (status.missing) {
      try {
        this._store.write(fallback);
      } catch (error) {
        this._readOnlyReason = 'write_failed';
        this._log('ERROR', 'project_store.initialize_failed', error);
      }
      return fallback;
    }
    const validated = validateProjectDocument(status.value);
    if (!validated.ok) {
      this._readOnlyReason = validated.reason;
      return fallback;
    }
    return validated.document;
  }

  _log(level, event, error) {
    try {
      this._logger?.(level, event, {
        errorCode: error?.code || null,
        errorMessage: String(error?.message || error || '').slice(0, 240),
      });
    } catch (_error) {
      // Logging cannot change persistence behavior.
    }
  }

  getStatus() {
    return {
      schema_version: PROJECT_STORE_SCHEMA_VERSION,
      read_only: Boolean(this._readOnlyReason),
      reason: this._readOnlyReason || null,
    };
  }

  getSnapshot() {
    return structuredClone(this._document);
  }

  // One project, cloned alone: a per-project lookup must not copy the whole
  // document (projects.list captures every project, which made it O(n^2)).
  getProject(projectId) {
    const project = Object.prototype.hasOwnProperty.call(this._document.projects || {}, projectId)
      ? this._document.projects[projectId]
      : null;
    return project ? structuredClone(project) : null;
  }

  replace(document) {
    if (this._readOnlyReason) {
      return { ok: false, durable: false, reason: this._readOnlyReason, read_only: true };
    }
    const validated = validateProjectDocument(document);
    if (!validated.ok) return { ok: false, durable: false, reason: validated.reason };
    try {
      const write = this._store.write(validated.document);
      if (write?.durable !== true) return { ok: false, durable: false, reason: 'durability_deferred' };
      this._document = validated.document;
      return { ok: true, durable: true, document: structuredClone(validated.document) };
    } catch (error) {
      this._log('ERROR', 'project_store.write_failed', error);
      return { ok: false, durable: false, reason: 'write_failed' };
    }
  }

  hasNewerSchema() {
    return this._readOnlyReason === 'future_schema';
  }

  flush() {
    return this._store.flush();
  }

  dispose() {
    this._store.dispose();
  }
}

module.exports = { ProjectStore };

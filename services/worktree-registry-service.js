'use strict';

const path = require('path');
const { FileJsonStore } = require('./backend/file-json-store');
const { normalizeString } = require('../renderer/shared/string-utils');
const {
  WORKTREE_REGISTRY_SCHEMA_VERSION,
} = require('./worktree-registry-schema-version');

/**
 * Persistent registry of known worktrees. Storage shape
 * (file: `<userData>/.jenny/worktrees.json`):
 *
 *   {
 *     "version": 1,
 *     "worktrees": [
 *       {
 *         "id": "wt_01hx",
 *         "repository_root": "/path/to/your/repo",
 *         "worktree_path": "/path/to/your/repo-worktrees/feature-x",
 *         "branch": "jenny/feature-x",
 *         "base_ref": "main",
 *         "owner": { "session_id": "...", "task_id": "..." },
 *         "status": "available" | "missing" | "stale",
 *         "created_at": "2026-05-16T12:00:00.000Z",
 *         "last_checked_at": "2026-05-16T12:00:00.000Z"
 *       }
 *     ]
 *   }
 *
 * If the persisted file declares a version newer than
 * `WORKTREE_REGISTRY_SCHEMA_VERSION`, the service logs a warning and returns
 * an empty state instead of throwing.
 */

const _VALID_STATUSES = new Set(['available', 'missing', 'stale']);

function _emptyState() {
  return Object.freeze({
    version: WORKTREE_REGISTRY_SCHEMA_VERSION,
    worktrees: Object.freeze([]),
  });
}

function _optionalString(value) {
  return typeof value === 'string' ? value : '';
}

function _normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const id = normalizeString(entry.id);
  const worktreePath = normalizeString(entry.worktree_path);
  const repoRoot = normalizeString(entry.repository_root);
  if (!id || !worktreePath || !repoRoot) {
    return null;
  }
  const status = _VALID_STATUSES.has(entry.status) ? entry.status : 'missing';
  const ownerSource = entry.owner && typeof entry.owner === 'object' ? entry.owner : null;
  return Object.freeze({
    id,
    repository_root: repoRoot,
    worktree_path: worktreePath,
    branch: _optionalString(entry.branch),
    base_ref: _optionalString(entry.base_ref),
    owner: Object.freeze({
      session_id: ownerSource && typeof ownerSource.session_id === 'string'
        ? ownerSource.session_id
        : null,
      task_id: ownerSource && typeof ownerSource.task_id === 'string'
        ? ownerSource.task_id
        : null,
    }),
    status,
    created_at: _optionalString(entry.created_at),
    last_checked_at: _optionalString(entry.last_checked_at),
  });
}

class WorktreeRegistryService {
  /**
   * @param {string} filePath - absolute path to the registry JSON file
   * @param {object} [options]
   * @param {function(string, string, object=): void} [options.logger]
   */
  constructor(filePath, options = {}) {
    this._filePath = filePath;
    this._logger = typeof options.logger === 'function' ? options.logger : () => {};
    this._store = new FileJsonStore(filePath, { logger: this._logger });
  }

  /**
   * Return the current registry contents with forward-version + corruption
   * recovery. Always returns an array (possibly empty).
   */
  listAll() {
    return this._readEntries({ forMutation: false });
  }

  _readEntries({ forMutation }) {
    const read = this._store.readWithStatus(_emptyState());
    if (forMutation && read.corrupted) {
      throw new Error('worktree registry is unreadable or corrupted');
    }
    const raw = read.value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      this._logger('WARN', 'worktree_registry.malformed', { filePath: this._filePath });
      if (forMutation) {
        throw new Error('worktree registry is malformed');
      }
      return [];
    }
    const persistedVersion = Number(raw.version);
    if (
      Number.isFinite(persistedVersion)
      && persistedVersion > WORKTREE_REGISTRY_SCHEMA_VERSION
    ) {
      this._logger('WARN', 'worktree_registry.forward_version', {
        persistedVersion,
        knownVersion: WORKTREE_REGISTRY_SCHEMA_VERSION,
        filePath: this._filePath,
      });
      if (forMutation) {
        throw new Error(
          `worktree registry version ${persistedVersion} is newer than supported version ${WORKTREE_REGISTRY_SCHEMA_VERSION}`
        );
      }
      return [];
    }
    const entries = Array.isArray(raw.worktrees) ? raw.worktrees : [];
    const normalized = [];
    for (const entry of entries) {
      const norm = _normalizeEntry(entry);
      if (norm) {
        normalized.push(norm);
      }
    }
    return normalized;
  }

  /**
   * Return a single entry by id, or null if not present.
   */
  getById(id) {
    const normalized = normalizeString(id);
    if (!normalized) return null;
    return this.listAll().find((entry) => entry.id === normalized) || null;
  }

  /**
   * Replace the entire registry contents. Returns true on success. Caller is
   * responsible for ID uniqueness and Phase 2+ Git-state validation.
   */
  saveAll(entries) {
    if (!Array.isArray(entries)) {
      throw new Error('saveAll requires an array of registry entries');
    }
    const normalized = [];
    const seenIds = new Set();
    for (const entry of entries) {
      const norm = _normalizeEntry(entry);
      if (!norm) continue;
      if (seenIds.has(norm.id)) {
        throw new Error(`duplicate worktree id in registry: ${norm.id}`);
      }
      seenIds.add(norm.id);
      normalized.push(norm);
    }
    this._store.write({
      version: WORKTREE_REGISTRY_SCHEMA_VERSION,
      worktrees: normalized,
    });
    return true;
  }

  /**
   * Convenience: append one entry to the registry. Phase 2+ should call this
   * after `git worktree add` succeeds.
   */
  add(entry) {
    const existing = this._readEntries({ forMutation: true });
    const norm = _normalizeEntry(entry);
    if (!norm) {
      throw new Error('worktree entry is malformed');
    }
    if (existing.some((row) => row.id === norm.id)) {
      throw new Error(`duplicate worktree id: ${norm.id}`);
    }
    this.saveAll([...existing, norm]);
    return norm;
  }

  /**
   * Convenience: remove one entry by id. Phase 4 will call this after the
   * dirty-state check + recursive remove succeeds.
   */
  removeById(id) {
    const remaining = this._readEntries({ forMutation: true }).filter((entry) => entry.id !== id);
    this.saveAll(remaining);
  }

  /**
   * Return the storage file path; useful for diagnostics and operations docs.
   */
  get filePath() {
    return this._filePath;
  }
}

function defaultRegistryPath(userDataPath) {
  return path.join(userDataPath, '.jenny', 'worktrees.json');
}

module.exports = {
  WorktreeRegistryService,
  WORKTREE_REGISTRY_SCHEMA_VERSION,
  defaultRegistryPath,
};

'use strict';

// Folder facts behind projects.list (PO review 2026-09-27, D1/D5 + perf):
// does each project's folder still exist, and which project IS the configured
// Workspace folder, compared by real path so a junction or subst drive still
// matches. Probes run asynchronously (fs.promises) and are cached briefly per
// (project id, root_revision, root path), so the handful of list reads one
// rename triggers costs one probe per project, not one per read. A rebind bumps
// root_revision and so misses the cache by construction; bind, choose and
// delete also clear it outright.

const fs = require('node:fs');

const { normalizeWorkspaceRootPath, workspaceRootId } = require('../workspace-root-identity');

const DEFAULT_TTL_MS = 1500;
const MAX_ENTRIES = 1024;

async function probeFolder(rootPath, fsPromises) {
  const normalized = normalizeWorkspaceRootPath(rootPath);
  if (!normalized) return { exists: false, canonical: null };
  try {
    const canonical = normalizeWorkspaceRootPath(await fsPromises.realpath(normalized));
    const stat = await fsPromises.stat(canonical);
    return stat.isDirectory() ? { exists: true, canonical } : { exists: false, canonical: null };
  } catch (_error) {
    // Missing, unplugged or unreadable: the folder cannot be opened either way.
    return { exists: false, canonical: null };
  }
}

class ProjectFolderStatus {
  constructor({ fsPromises = fs.promises, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    this._fs = fsPromises;
    this._ttlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;
    this._now = typeof now === 'function' ? now : Date.now;
    this._entries = new Map();
  }

  _cached(key, compute) {
    const at = this._now();
    const entry = this._entries.get(key);
    if (entry && at - entry.at < this._ttlMs) return entry.promise;
    const promise = Promise.resolve().then(compute);
    this._entries.set(key, { at, promise });
    if (this._entries.size > MAX_ENTRIES) {
      this._entries.delete(this._entries.keys().next().value);
    }
    return promise;
  }

  // { exists, canonical } for any folder path (a project's root or the
  // configured Workspace root).
  folder(rootPath) {
    const key = `folder\u0000${String(rootPath || '')}`;
    return this._cached(key, () => probeFolder(rootPath, this._fs));
  }

  // A project's cached authority key; `compute` runs at most once per TTL for
  // the same (id, root_revision, root path, store state).
  authorityKey(project, storeState, compute) {
    const key = [
      'authority', project.id, project.root_revision, project.root_path || '', storeState || '',
    ].join('\u0000');
    return this._cached(key, compute);
  }

  // The identity a project's folder resolves to today; the stored root id
  // when the folder is gone (it can still be compared, never opened).
  async projectRootKey(project) {
    if (!project?.root_path) return null;
    const folder = await this.folder(project.root_path);
    return folder.exists ? workspaceRootId(folder.canonical) : (project.root_id || null);
  }

  // The configured Workspace root's real identity ('' when none is set).
  async workspaceRootKey(configuredRoot) {
    const root = String(configuredRoot || '').trim();
    if (!root) return '';
    const folder = await this.folder(root);
    return (folder.exists ? workspaceRootId(folder.canonical) : workspaceRootId(root)) || '';
  }

  async isCurrent(project, workspaceKey) {
    if (!workspaceKey || !project?.root_path) return false;
    return (await this.projectRootKey(project)) === workspaceKey;
  }

  invalidate() {
    this._entries.clear();
  }
}

module.exports = { DEFAULT_TTL_MS, ProjectFolderStatus, probeFolder };

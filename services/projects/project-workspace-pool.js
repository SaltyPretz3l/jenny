'use strict';

const fs = require('fs');
const { workspaceRootId } = require('../workspace-root-identity');
const { normalizeProjectId } = require('./project-schema');
const { canonicalizeProjectRoot, canonicalizeProjectRootAsync } = require('./project-service');

function positiveIntegerToken(value) {
  if (typeof value === 'bigint') return value > 0n ? String(value) : null;
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function captureFilesystemIdentity(rootPath, fsImpl) {
  const stat = fsImpl.statSync(rootPath, { bigint: true });
  return filesystemIdentityFromStat(rootPath, stat);
}

function filesystemIdentityFromStat(rootPath, stat) {
  if (!stat.isDirectory()) throw new Error('Project root is not a directory.');
  const deviceId = positiveIntegerToken(stat.dev);
  const inode = positiveIntegerToken(stat.ino);
  // Some filesystems report zero or no stable inode. In that case resolved
  // path identity remains the conservative fallback; hard-link completeness
  // is intentionally not claimed.
  return deviceId && inode ? { device_id: deviceId, inode } : { device_id: null, inode: null };
}

function nullRootAuthority(id, project) {
  return Object.freeze({
    project_id: id,
    root_path: null,
    root_id: null,
    root_revision: project.root_revision,
    device_id: null,
    inode: null,
  });
}

class ProjectWorkspacePool {
  constructor({ projectService, fsImpl = fs } = {}) {
    if (!projectService || typeof projectService.get !== 'function') {
      throw new TypeError('ProjectWorkspacePool requires a project service.');
    }
    this._projectService = projectService;
    this._fs = fsImpl;
  }

  capture(projectId) {
    const id = normalizeProjectId(projectId);
    if (!id) return { ok: false, reason: 'invalid_project_id' };
    const project = this._projectService.get(id);
    if (!project) return { ok: false, reason: 'project_not_found' };
    if (!project.root_path) return { ok: true, authority: nullRootAuthority(id, project) };
    try {
      const rootPath = canonicalizeProjectRoot(project.root_path, { fsImpl: this._fs });
      const rootId = workspaceRootId(rootPath);
      if (rootId !== project.root_id) return { ok: false, reason: 'root_identity_changed' };
      const filesystemIdentity = captureFilesystemIdentity(rootPath, this._fs);
      return { ok: true, authority: Object.freeze({
        project_id: id,
        root_path: rootPath,
        root_id: rootId,
        root_revision: project.root_revision,
        ...filesystemIdentity,
      }) };
    } catch (_error) {
      return { ok: false, reason: 'root_unavailable' };
    }
  }

  // Same authority as capture(), for a record the caller already holds (one
  // list snapshot), with the realpath/stat done asynchronously so a list of
  // projects never blocks the main process on the filesystem.
  async captureRecordAsync(project) {
    const id = normalizeProjectId(project?.id);
    if (!id || id !== project.id) return { ok: false, reason: 'invalid_project_id' };
    if (!project.root_path) return { ok: true, authority: nullRootAuthority(id, project) };
    const fsPromises = this._fs.promises || fs.promises;
    try {
      const rootPath = await canonicalizeProjectRootAsync(project.root_path, { fsPromises });
      const rootId = workspaceRootId(rootPath);
      if (rootId !== project.root_id) return { ok: false, reason: 'root_identity_changed' };
      const stat = await fsPromises.stat(rootPath, { bigint: true });
      const filesystemIdentity = filesystemIdentityFromStat(rootPath, stat);
      return { ok: true, authority: Object.freeze({
        project_id: id,
        root_path: rootPath,
        root_id: rootId,
        root_revision: project.root_revision,
        ...filesystemIdentity,
      }) };
    } catch (_error) {
      return { ok: false, reason: 'root_unavailable' };
    }
  }

  isCurrent(authority) {
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return false;
    const current = this.capture(authority.project_id);
    if (!current.ok) return false;
    return current.authority.project_id === authority.project_id
      && current.authority.root_path === authority.root_path
      && current.authority.root_id === authority.root_id
      && current.authority.root_revision === authority.root_revision
      && current.authority.device_id === authority.device_id
      && current.authority.inode === authority.inode;
  }
}

module.exports = { ProjectWorkspacePool, captureFilesystemIdentity };

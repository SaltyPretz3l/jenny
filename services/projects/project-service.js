'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { containsJennyStateDirSegment, normalizeWorkspaceRootPath, workspaceRootId } = require('../workspace-root-identity');
const { GENERAL_PROJECT_ID, MAX_PROJECTS, normalizeProjectId, normalizeProjectName, normalizeRuntimePreferences } = require('./project-schema');

function defaultIdFactory() {
  return `project_${crypto.randomUUID().replace(/-/gu, '')}`;
}

function canonicalizeProjectRoot(rootPath, { fsImpl = fs } = {}) {
  if (rootPath == null || String(rootPath).trim() === '') return null;
  if (!path.isAbsolute(String(rootPath).trim())) {
    const error = new Error('Project root must be absolute.');
    error.code = 'invalid_root';
    throw error;
  }
  const normalized = normalizeWorkspaceRootPath(rootPath);
  if (!normalized || containsJennyStateDirSegment(normalized)) {
    const error = new Error('Project root is invalid.');
    error.code = 'invalid_root';
    throw error;
  }
  const canonical = normalizeWorkspaceRootPath(
    typeof fsImpl.realpathSync?.native === 'function'
      ? fsImpl.realpathSync.native(normalized)
      : fsImpl.realpathSync(normalized)
  );
  if (!canonical || containsJennyStateDirSegment(canonical)
    || !fsImpl.statSync(canonical).isDirectory()) {
    const error = new Error('Project root must be a directory.');
    error.code = 'invalid_root';
    throw error;
  }
  return canonical;
}

// Async twin of canonicalizeProjectRoot for list-time probes: same checks, but
// the realpath and stat never block the main process.
async function canonicalizeProjectRootAsync(rootPath, { fsPromises = fs.promises } = {}) {
  if (rootPath == null || String(rootPath).trim() === '') return null;
  const normalized = path.isAbsolute(String(rootPath).trim()) ? normalizeWorkspaceRootPath(rootPath) : '';
  if (!normalized || containsJennyStateDirSegment(normalized)) {
    const error = new Error('Project root is invalid.');
    error.code = 'invalid_root';
    throw error;
  }
  const canonical = normalizeWorkspaceRootPath(await fsPromises.realpath(normalized));
  if (!canonical || containsJennyStateDirSegment(canonical)
    || !(await fsPromises.stat(canonical)).isDirectory()) {
    const error = new Error('Project root must be a directory.');
    error.code = 'invalid_root';
    throw error;
  }
  return canonical;
}

function resultFailure(reason, extra = {}) {
  return { ok: false, durable: false, reason, ...extra };
}

class ProjectService {
  constructor({ store, idFactory = defaultIdFactory, now = () => new Date().toISOString(), canonicalizeRoot = canonicalizeProjectRoot } = {}) {
    if (!store || typeof store.getSnapshot !== 'function' || typeof store.replace !== 'function') {
      throw new TypeError('ProjectService requires a project store.');
    }
    this._store = store;
    this._idFactory = idFactory;
    this._now = now;
    this._canonicalizeRoot = canonicalizeRoot;
  }

  // One snapshot, already a private copy: no second clone per project.
  list() {
    return Object.values(this._store.getSnapshot().projects || {})
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  get(projectId) {
    const id = normalizeProjectId(projectId);
    if (!id) return null;
    if (typeof this._store.getProject === 'function') return this._store.getProject(id);
    const project = this._store.getSnapshot().projects?.[id];
    return project ? structuredClone(project) : null;
  }

  create(input = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const normalizedName = normalizeProjectName(source.name);
    if (!normalizedName) return resultFailure('invalid_name');
    const document = this._store.getSnapshot();
    if (Object.keys(document.projects || {}).length >= MAX_PROJECTS) return resultFailure('capacity_exceeded');
    const id = normalizeProjectId(this._idFactory());
    if (!id || document.projects[id]) return resultFailure('project_identity_conflict');
    const now = this._now();
    return this._persistProject(document, {
      id,
      name: normalizedName,
      root_path: null,
      root_id: null,
      root_revision: 0,
      runtime_preferences: normalizeRuntimePreferences(source.runtimePreferences),
      created_at: now,
      updated_at: now,
    });
  }

  update(projectId, patch = {}) {
    const id = normalizeProjectId(projectId);
    if (!id) return resultFailure('invalid_project_id');
    const document = this._store.getSnapshot();
    const current = document.projects?.[id];
    if (!current) return resultFailure('project_not_found');
    const sourcePatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const next = { ...current, updated_at: this._now() };
    if (Object.prototype.hasOwnProperty.call(sourcePatch, 'name')) {
      const name = normalizeProjectName(sourcePatch.name);
      if (!name) return resultFailure('invalid_name');
      next.name = name;
    }
    if (Object.prototype.hasOwnProperty.call(sourcePatch, 'runtimePreferences')) {
      next.runtime_preferences = normalizeRuntimePreferences(sourcePatch.runtimePreferences);
    }
    return this._persistProject(document, next);
  }

  bindRoot(projectId, rootPath, { expectedRevision, beforeChange } = {}) {
    const id = normalizeProjectId(projectId);
    if (!id) return resultFailure('invalid_project_id');
    const document = this._store.getSnapshot();
    const current = document.projects?.[id];
    if (!current) return resultFailure('project_not_found');
    if (expectedRevision !== undefined && Number(expectedRevision) !== current.root_revision) {
      return resultFailure('stale_root_revision', { current_revision: current.root_revision });
    }
    let canonicalRoot;
    try {
      canonicalRoot = this._canonicalizeRoot(rootPath);
    } catch (error) {
      return resultFailure(error?.code === 'invalid_root' ? 'invalid_root' : 'root_unavailable');
    }
    const rootId = canonicalRoot ? workspaceRootId(canonicalRoot) : null;
    if (canonicalRoot === current.root_path && rootId === current.root_id) {
      return { ok: true, durable: true, project: structuredClone(current), unchanged: true };
    }
    // The caller may refuse a real change; an unchanged bind is never refused.
    if (beforeChange && beforeChange() === false) return resultFailure('root_change_refused');
    // The folder is the project: a folder another project already owns is
    // never bound twice (re-picking a moved folder must rebind, not duplicate).
    const owner = rootId
      ? Object.values(document.projects || {}).find((project) => project.id !== id && project.root_id === rootId)
      : null;
    if (owner) {
      return resultFailure('folder_already_project', {
        conflict_project_id: owner.id,
        conflict_project_name: owner.name,
      });
    }
    return this._persistProject(document, {
      ...current,
      root_path: canonicalRoot,
      root_id: rootId,
      root_revision: current.root_revision + 1,
      updated_at: this._now(),
    });
  }

  // Deleting a project drops its entry only. Chats are moved by the application
  // layer beforehand; the folder on disk is never touched.
  remove(projectId) {
    const id = normalizeProjectId(projectId);
    if (!id) return resultFailure('invalid_project_id');
    if (id === GENERAL_PROJECT_ID) return resultFailure('general_protected');
    const document = this._store.getSnapshot();
    const current = document.projects?.[id];
    if (!current) return resultFailure('project_not_found');
    const projects = { ...document.projects };
    delete projects[id];
    const result = this._store.replace({ ...document, projects });
    if (!result.ok) return resultFailure(result.reason, { read_only: result.read_only === true });
    return { ok: true, durable: true, project: structuredClone(current) };
  }

  // Rollback of a refused delete: put the exact removed entry back (same id,
  // root and revision). Refuses rather than overwrite an entry that exists.
  restore(project) {
    const id = normalizeProjectId(project?.id);
    if (!id || id !== project.id) return resultFailure('invalid_project_id');
    const document = this._store.getSnapshot();
    if (document.projects?.[id]) return resultFailure('project_identity_conflict');
    return this._persistProject(document, structuredClone(project));
  }

  _persistProject(document, project) {
    const result = this._store.replace({ ...document, projects: { ...document.projects, [project.id]: project } });
    if (!result.ok) return resultFailure(result.reason, { read_only: result.read_only === true });
    return { ok: true, durable: true, project: structuredClone(result.document.projects[project.id]) };
  }
}

module.exports = {
  ProjectService,
  canonicalizeProjectRoot,
  canonicalizeProjectRootAsync,
  defaultIdFactory,
};

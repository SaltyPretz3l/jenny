'use strict';

const path = require('node:path');

const { PROJECT_ERROR_CODES } = require('../backend/error-codes');
const { GENERAL_PROJECT_ID, normalizeProjectId } = require('./project-schema');
const { ProjectService, canonicalizeProjectRoot } = require('./project-service');
const { ProjectStore } = require('./project-store');
const { ProjectWorkspacePool } = require('./project-workspace-pool');
const { createProjectWorkspaceServiceResolver } = require('./project-workspace-services');

function projectError(code, reason, message) {
  const error = new Error(message);
  error.code = code;
  error.reason = reason;
  return error;
}

function sameOrWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createProjectRootCanonicalizer({ restrictRoots = false, rootBoundary = null } = {}) {
  return (rootPath) => {
    const canonical = canonicalizeProjectRoot(rootPath);
    if (!canonical) return null;
    if (restrictRoots && (!rootBoundary || !sameOrWithin(rootBoundary, canonical))) {
      const error = new Error('Project root is outside the configured host workspace.');
      error.code = 'invalid_root';
      throw error;
    }
    return canonical;
  };
}

class ApplicationProjectAuthority {
  constructor({ store, projectService, workspacePool, sessionStore, restrictRoots, rootBoundary }) {
    this._store = store;
    this._projectService = projectService;
    this._workspacePool = workspacePool;
    this._sessionStore = sessionStore;
    this._restrictRoots = restrictRoots === true;
    this._rootBoundary = rootBoundary;
  }

  captureProject(projectId = GENERAL_PROJECT_ID) {
    const id = normalizeProjectId(projectId);
    if (!id) {
      throw projectError(
        PROJECT_ERROR_CODES.INVALID,
        'invalid_project_id',
        'Project identity is invalid.'
      );
    }
    const status = this._store.getStatus();
    if (status.read_only) {
      throw projectError(
        PROJECT_ERROR_CODES.UNAVAILABLE,
        status.reason || 'project_store_unavailable',
        'Project storage is unavailable.'
      );
    }
    const captured = this._workspacePool.capture(id);
    if (!captured.ok) {
      const notFound = captured.reason === 'project_not_found';
      throw projectError(
        notFound ? PROJECT_ERROR_CODES.NOT_FOUND : PROJECT_ERROR_CODES.UNAVAILABLE,
        captured.reason,
        notFound ? 'Project was not found.' : 'Project authority is unavailable.'
      );
    }
    if (this._restrictRoots && captured.authority.root_path
      && (!this._rootBoundary || !sameOrWithin(this._rootBoundary, captured.authority.root_path))) {
      throw projectError(
        PROJECT_ERROR_CODES.UNAVAILABLE,
        'project_root_outside_host_workspace',
        'Project root is outside the configured host workspace.'
      );
    }
    return captured.authority;
  }

  captureSession(sessionId) {
    if (this._sessionStore.hasNewerSchema?.()) {
      throw projectError(PROJECT_ERROR_CODES.UNAVAILABLE, 'session_schema_too_new',
        'Session storage uses an unsupported version.');
    }
    const id = String(sessionId || '').trim();
    const summary = id ? this._sessionStore.getSessionSummary(id) : null;
    if (!summary) {
      throw projectError(
        PROJECT_ERROR_CODES.NOT_FOUND,
        'session_not_found',
        'Session was not found.'
      );
    }
    if (!normalizeProjectId(summary.project_id)) {
      throw projectError(PROJECT_ERROR_CODES.INVALID, 'invalid_project_id',
        'Project identity is invalid.');
    }
    return this.captureProject(summary.project_id);
  }

  requireCurrent(authority) {
    let current = null;
    try {
      current = this.captureProject(authority?.project_id);
    } catch (_error) {
      // Stale captures have one public failure shape even when their project disappeared.
    }
    if (!current || !this._workspacePool.isCurrent(authority)) {
      throw projectError(
        PROJECT_ERROR_CODES.STALE,
        'project_authority_stale',
        'Project authority is stale.'
      );
    }
    return authority;
  }
}

function initializeApplicationProjects(service, options) {
  const logger = (level, event, details) => service._emitServiceLog(level, event, details);
  const store = new ProjectStore(path.join(options.userDataPath, 'projects.json'), { logger });
  const restrictRoots = options.hostMode === 'server';
  const rootBoundary = restrictRoots && options.projectRootBoundary
    ? canonicalizeProjectRoot(options.projectRootBoundary)
    : null;
  const projectService = new ProjectService({
    store,
    canonicalizeRoot: createProjectRootCanonicalizer({ restrictRoots, rootBoundary }),
  });
  const workspacePool = new ProjectWorkspacePool({ projectService });
  service.projectStore = store;
  service.projectService = projectService;
  service.projectWorkspacePool = workspacePool;
  service.projectAuthority = new ApplicationProjectAuthority({
    store,
    projectService,
    workspacePool,
    sessionStore: service.sessionStore,
    restrictRoots,
    rootBoundary,
  });
  service.resolveProjectWorkspaceServices = createProjectWorkspaceServiceResolver(service);
}

module.exports = {
  ApplicationProjectAuthority,
  createProjectRootCanonicalizer,
  initializeApplicationProjects,
};

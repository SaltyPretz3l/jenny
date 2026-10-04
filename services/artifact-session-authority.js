'use strict';

const { ARTIFACT_ERROR_CODES, artifactError } = require('./artifact-workspace-errors');

const PROJECT_AUTHORITY_FIELDS = Object.freeze([
  'project_id', 'root_path', 'root_id', 'root_revision', 'device_id', 'inode',
]);

function sameProjectAuthority(left, right) {
  return Boolean(left && right)
    && PROJECT_AUTHORITY_FIELDS.every((field) => left[field] === right[field]);
}

class ArtifactSessionAuthority {
  constructor({ configService, projectAuthorityProvider, sanitizeSessionId }) {
    this._configService = configService;
    this._provider = projectAuthorityProvider;
    this._sanitizeSessionId = sanitizeSessionId;
    this.hasProvider = projectAuthorityProvider !== undefined && projectAuthorityProvider !== null;
  }

  getProjectAuthority() {
    if (!this.hasProvider) return null;
    const provider = typeof this._provider === 'function' ? this._provider() : this._provider;
    if (!provider || typeof provider.captureSession !== 'function'
      || typeof provider.requireCurrent !== 'function') {
      throw artifactError(
        ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_UNAVAILABLE,
        'Project artifact authority is unavailable.',
        { reason: 'project_authority_unavailable' }
      );
    }
    return provider;
  }

  async retentionScopes(fsImpl, pathImpl) {
    const provider = this.getProjectAuthority();
    if (!provider) {
      const scope = this.capture('legacy-artifact-session');
      return [{ rootPath: scope.rootPath, assertCurrent: () => this.assertCurrent(scope) }];
    }
    const store = provider._store;
    if (!store || store.getStatus().read_only) throw new Error('Project storage is unavailable.');
    const projects = store.getSnapshot().projects;
    if (!projects || Array.isArray(projects)) throw new Error('Project index is unreadable.');
    const groups = new Map();
    for (const id of Object.keys(projects)) {
      try {
        const authority = provider.captureProject(id);
        if (!authority.root_path) continue;
        const rootPath = await fsImpl.realpath(authority.root_path);
        const stats = await fsImpl.stat(rootPath, { bigint: true });
        provider.requireCurrent(authority);
        if (!stats.isDirectory()) continue;
        const key = stats.dev && stats.ino ? `${stats.dev}:${stats.ino}` : pathImpl.normalize(rootPath);
        if (!groups.has(key)) groups.set(key, { rootPath, authorities: [], stats });
        groups.get(key).authorities.push(authority);
      } catch (_) {
        // Disconnected or stale projects never authorize a sweep.
      }
    }
    return [...groups.values()].map(({ rootPath, authorities, stats }) => ({
      rootPath,
      assertCurrent: async () => {
        if (store.getStatus().read_only) throw new Error('Project storage is unavailable.');
        for (const authority of authorities) provider.requireCurrent(authority);
        const current = await fsImpl.stat(await fsImpl.realpath(rootPath), { bigint: true });
        if (current.dev !== stats.dev || current.ino !== stats.ino) throw new Error('Project root changed.');
        for (const authority of authorities) provider.requireCurrent(authority);
      },
    }));
  }

  async pruneOrphans(owner, activeSessionIds) {
    const { createArtifactRetentionService } = require('./artifact-retention-service');
    const service = createArtifactRetentionService({
      getWorkspaceScopes: () => this.retentionScopes(owner._fs, owner._path),
      getSessionStore: () => this.getProjectAuthority()._sessionStore,
      fsImpl: owner._fs, pathImpl: owner._path, logger: owner._logger,
      caps: { maxUnreferencedAgeMs: 0, maxUnreferencedDirs: 0 },
    });
    const result = await service.sweep({ activeSessionIds: () => [
      ...(typeof activeSessionIds === 'function' ? activeSessionIds() : activeSessionIds || []),
      ...owner._pruneProtectedSessionIds.keys(),
    ], orphanOnly: true });
    return { removed: result.quarantined };
  }

  capture(sessionId, admittedAuthority = null) {
    const safeSessionId = this._sanitizeSessionId(sessionId);
    const provider = this.getProjectAuthority();
    if (!provider) {
      return Object.freeze({
        kind: 'legacy',
        sessionId: safeSessionId,
        rootPath: String(this._configService?.getState?.().toolsWorkspaceRoot || '').trim(),
      });
    }
    const captured = provider.captureSession(safeSessionId);
    if (admittedAuthority) {
      provider.requireCurrent(admittedAuthority);
      if (!sameProjectAuthority(captured, admittedAuthority)) {
        throw artifactError(
          ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_UNAVAILABLE,
          'Artifact session authority is stale.',
          { reason: 'project_authority_stale' }
        );
      }
    }
    const authority = admittedAuthority || captured;
    return Object.freeze({
      kind: 'project',
      sessionId: safeSessionId,
      authority,
      rootPath: String(authority.root_path || '').trim(),
    });
  }

  captureMissing(sessionId, admittedAuthority) {
    const safeSessionId = this._sanitizeSessionId(sessionId);
    const provider = this.getProjectAuthority();
    if (!provider || !admittedAuthority) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_UNAVAILABLE,
        'Deleted-session cleanup requires project authority.',
        { reason: 'project_authority_required' }
      );
    }
    provider.requireCurrent(admittedAuthority);
    try {
      provider.captureSession(safeSessionId);
    } catch (error) {
      if (error?.reason === 'session_not_found') {
        return Object.freeze({
          kind: 'project', sessionId: safeSessionId, authority: admittedAuthority,
          rootPath: String(admittedAuthority.root_path || '').trim(), requireMissingSession: true,
        });
      }
      throw error;
    }
    throw artifactError(
      ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_UNAVAILABLE,
      'Artifact cleanup target is currently owned by a session.',
      { reason: 'artifact_session_reused' }
    );
  }

  assertCurrent(scope) {
    if (scope.kind === 'legacy') {
      const currentRoot = String(this._configService?.getState?.().toolsWorkspaceRoot || '').trim();
      if (currentRoot !== scope.rootPath) {
        throw artifactError(
          ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_UNAVAILABLE,
          'Artifact workspace root changed while the operation was in progress.',
          { reason: 'workspace_root_changed' }
        );
      }
      return scope;
    }
    const provider = this.getProjectAuthority();
    provider.requireCurrent(scope.authority);
    if (scope.requireMissingSession) {
      try {
        provider.captureSession(scope.sessionId);
      } catch (error) {
        if (error?.reason === 'session_not_found') return scope;
        throw error;
      }
      throw artifactError(
        ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_UNAVAILABLE,
        'Artifact cleanup target is currently owned by a session.',
        { reason: 'artifact_session_reused' }
      );
    }
    const current = provider.captureSession(scope.sessionId);
    if (!sameProjectAuthority(current, scope.authority)) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_UNAVAILABLE,
        'Artifact session authority is stale.',
        { reason: 'project_authority_stale' }
      );
    }
    return scope;
  }
}

class SessionArtifactWorkspaceFacade {
  constructor(owner, authority, sessionId, sanitizeSessionId) {
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
      throw new TypeError('Session artifact facade requires a captured project authority.');
    }
    this._owner = owner;
    this._authority = Object.freeze({ ...authority });
    this._sanitizeSessionId = sanitizeSessionId;
    this._sessionId = sanitizeSessionId(sessionId);
  }

  _assertSession(sessionId) {
    const safeSessionId = this._sanitizeSessionId(sessionId);
    if (safeSessionId !== this._sessionId) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.INVALID_SESSION,
        'Artifact session does not match the admitted session authority.'
      );
    }
    return safeSessionId;
  }

  getWorkspaceRoot() {
    return this._owner._captureSessionScope(this._sessionId, this._authority).rootPath;
  }
  requireWorkspaceRoot() {
    return this._owner._requireWorkspaceRootForScope(
      this._owner._captureSessionScope(this._sessionId, this._authority)
    );
  }
  getSessionScratchDir(id) { return this._owner._getSessionScratchDir(this._assertSession(id), this._authority); }
  createArtifact(id, input) { return this._owner._createArtifact(this._assertSession(id), input, this._authority); }
  createBinaryArtifact(id, input) { return this._owner._createBinaryArtifact(this._assertSession(id), input, this._authority); }
  readArtifact(id, artifactId) { return this._owner._readArtifact(this._assertSession(id), artifactId, this._authority); }
  saveArtifact(id, artifactId, content) {
    return this._owner._saveArtifact(this._assertSession(id), artifactId, content, this._authority);
  }
  revealArtifact(id, artifactId) { return this._owner._revealArtifact(this._assertSession(id), artifactId, this._authority); }
  openArtifactExternal(id, artifactId) {
    return this._owner._openArtifactExternal(this._assertSession(id), artifactId, this._authority);
  }
  resolveArtifact(id, artifactId, options) {
    return this._owner._resolveArtifactForSession(this._assertSession(id), artifactId, options, this._authority);
  }
  deleteSessionArtifacts(id) { return this._owner._deleteSessionArtifacts(this._assertSession(id), this._authority); }
  prepareSessionDeletion(id) {
    return this._owner._prepareSessionArtifactDeletion(this._assertSession(id), this._authority);
  }
  deleteArtifact(id, artifactId) { return this._owner._deleteArtifact(this._assertSession(id), artifactId, this._authority); }
  markSessionPruneProtected(id) { return this._owner.markSessionPruneProtected(this._assertSession(id)); }
  cloneSessionArtifactsForBranch(sourceId, targetId, options) {
    this._assertSession(sourceId);
    return this._owner._cloneSessionArtifactsForBranch(sourceId, targetId, options, this._authority);
  }
  pruneOrphanedArtifacts(activeIds) {
    return this._owner._pruneOrphanedArtifacts(activeIds, this._authority, this._sessionId);
  }
}

function createSessionArtifactWorkspaceFacade(owner, authority, sessionId, sanitizeSessionId) {
  return new SessionArtifactWorkspaceFacade(owner, authority, sessionId, sanitizeSessionId);
}

module.exports = {
  ArtifactSessionAuthority,
  createSessionArtifactWorkspaceFacade,
  sameProjectAuthority,
};

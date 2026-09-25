'use strict';

const crypto = require('node:crypto');

const { PROJECT_ERROR_CODES, TOOL_ERROR_CODES } = require('../backend/error-codes');
const { t } = require('../i18n-main');
const { GENERAL_PROJECT_ID, normalizeProjectId } = require('./project-schema');
const { workspaceRootId } = require('../workspace-root-identity');
const { assignSessionProjectDurably } = require('./session-project-assignment');

const REVIEW_DECISIONS = new Set(['auto', 'ask', 'deny', 'dismiss']);

function isPlainRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function failure(code, reason, message, details = {}) {
  return { ok: false, error: { code, reason, message, ...details } };
}

function projectFailure(reason, details = {}) {
  const messages = {
    invalid_name: t('projects.application.invalidName', 'Project name is invalid.'),
    invalid_project_id: t('projects.application.invalidId', 'Project identity is invalid.'),
    invalid_project_request: t('projects.application.invalidRequest', 'Project request is invalid.'),
    project_not_found: t('projects.application.notFound', 'Project was not found.'),
    session_not_found: t('projects.application.sessionNotFound', 'Session was not found.'),
    session_busy: t(
      'projects.application.sessionBusy',
      'The session must be idle before its project can change.'
    ),
    stale_root_revision: t(
      'projects.application.staleRoot',
      'Project root authority changed. Review the current root and try again.'
    ),
    general_root_reserved: t(
      'projects.application.generalRootReserved',
      'The General project cannot own a workspace root.'
    ),
    invalid_root: t('projects.application.invalidRoot', 'Project root is invalid.'),
    workspace_root_unset: t(
      'projects.application.workspaceRootUnset',
      'Choose a Workspace folder first.'
    ),
    workspace_project_unavailable: t(
      'projects.application.workspaceProjectUnavailable',
      'The Workspace folder could not be set up as a project.'
    ),
    general_protected: t(
      'projects.application.generalProtected',
      'The General project cannot be deleted.'
    ),
    project_sessions_busy: t(
      'projects.application.projectSessionsBusy',
      'A chat in this project is still working. Wait for it to finish, then try again.'
    ),
    session_inventory_unavailable: t(
      'projects.application.sessionInventoryUnavailable',
      'The chat list could not be read, so no chat can be proven idle. Try again.'
    ),
  };
  const invalid = [
    'invalid_name', 'invalid_project_id', 'invalid_project_request',
    'general_root_reserved', 'invalid_root', 'workspace_root_unset', 'general_protected',
  ];
  const notFound = ['project_not_found', 'session_not_found'];
  const stale = reason === 'stale_root_revision' || reason === 'project_authority_stale';
  const code = invalid.includes(reason)
    ? PROJECT_ERROR_CODES.INVALID
    : notFound.includes(reason)
      ? PROJECT_ERROR_CODES.NOT_FOUND
      : stale
        ? PROJECT_ERROR_CODES.STALE
        : PROJECT_ERROR_CODES.UNAVAILABLE;
  return failure(
    code,
    reason,
    messages[reason]
      || t('projects.application.storageUnavailable', 'Project storage is unavailable.'),
    details
  );
}

function reviewFailure(reason, message = '', details = {}) {
  const unavailable = reason.includes('store_') || reason.includes('capacity');
  return failure(
    unavailable ? TOOL_ERROR_CODES.EXECUTION_FAILED : TOOL_ERROR_CODES.UNKNOWN,
    reason,
    message || t(
      'projects.application.permissionReviewFailed',
      'Permission review could not be completed.'
    ),
    details
  );
}

function normalizeProjectIdentity(value) {
  const projectId = normalizeProjectId(value);
  return projectId && projectId === value ? projectId : '';
}

function sessionIsBusy(session) {
  return Boolean(
    session?.active_turn
    || session?.pending_question_batch
    || session?.pending_plan_proposal
  );
}

function projectAuthorityKey(authority) {
  const fields = [
    authority?.project_id,
    authority?.root_path,
    authority?.root_id,
    authority?.root_revision,
    authority?.device_id,
    authority?.inode,
  ];
  return `authority_${crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`;
}

class ProjectApplicationService {
  constructor({
    projectService,
    projectStore,
    projectAuthority,
    sessionStore,
    shadowStore = null,
    permissionStore,
    isSessionBusy,
    onPermissionChanged = () => {},
    resolveWorkspaceProject = null,
    resolveWorkspaceRoot = null,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!projectService || typeof projectService.list !== 'function') {
      throw new TypeError('ProjectApplicationService requires projectService.');
    }
    if (!projectStore || typeof projectStore.getStatus !== 'function') {
      throw new TypeError('ProjectApplicationService requires projectStore.');
    }
    if (!projectAuthority || typeof projectAuthority.captureProject !== 'function') {
      throw new TypeError('ProjectApplicationService requires projectAuthority.');
    }
    if (!sessionStore || typeof sessionStore.getSession !== 'function'
      || typeof sessionStore.getSessionSummary !== 'function') {
      throw new TypeError('ProjectApplicationService requires sessionStore.');
    }
    if (typeof isSessionBusy !== 'function') {
      throw new TypeError('ProjectApplicationService requires isSessionBusy.');
    }
    if (!permissionStore || typeof permissionStore.getReviewState !== 'function'
      || typeof permissionStore.resolvePendingReview !== 'function') {
      throw new TypeError('ProjectApplicationService requires permissionStore.');
    }
    this._projects = projectService;
    this._projectStore = projectStore;
    this._authority = projectAuthority;
    this._sessions = sessionStore;
    this._shadow = shadowStore;
    this._permissions = permissionStore;
    this._isSessionBusy = isSessionBusy;
    this._resolveWorkspaceProject = typeof resolveWorkspaceProject === 'function'
      ? resolveWorkspaceProject
      : null;
    this._resolveWorkspaceRoot = typeof resolveWorkspaceRoot === 'function'
      ? resolveWorkspaceRoot
      : () => '';
    this._onPermissionChanged = typeof onPermissionChanged === 'function'
      ? onPermissionChanged
      : () => {};
    this._now = typeof now === 'function' ? now : () => new Date().toISOString();
  }

  listProjects(payload) {
    if (payload !== undefined) return projectFailure('invalid_project_request');
    const status = this._projectStore.getStatus();
    return {
      ok: true,
      projects: this._projects.list().map((project) => this._projectProjection(project)),
      storage: { read_only: status.read_only === true, reason: status.reason || null },
    };
  }

  createProject(payload) {
    if (!hasExactKeys(payload, ['name'])) return projectFailure('invalid_project_request');
    return this._projectResult(this._projects.create({ name: payload.name }));
  }

  renameProject(payload) {
    if (!hasExactKeys(payload, ['name', 'project_id'])) {
      return projectFailure('invalid_project_request');
    }
    const projectId = normalizeProjectIdentity(payload.project_id);
    if (!projectId) return projectFailure('invalid_project_id');
    return this._projectResult(this._projects.update(projectId, { name: payload.name }));
  }

  bindProjectRoot(payload) {
    if (!hasExactKeys(payload, ['expected_root_revision', 'project_id', 'root_path'])) {
      return projectFailure('invalid_project_request');
    }
    const projectId = normalizeProjectIdentity(payload.project_id);
    if (!projectId) return projectFailure('invalid_project_id');
    if (!Number.isSafeInteger(payload.expected_root_revision)
      || payload.expected_root_revision < 0) {
      return projectFailure('invalid_project_request');
    }
    if (payload.root_path !== null
      && (typeof payload.root_path !== 'string' || !payload.root_path.trim())) {
      return projectFailure('invalid_root');
    }
    if (projectId === GENERAL_PROJECT_ID && payload.root_path !== null) {
      return projectFailure('general_root_reserved');
    }
    return this._projectResult(this._projects.bindRoot(projectId, payload.root_path, {
      expectedRevision: payload.expected_root_revision,
    }));
  }

  // "Use this folder": an idle chat adopts the configured Workspace folder's
  // project (provisioned on demand). The same idle-only, durable assignment
  // as assignSessionProject; nothing is retargeted without this explicit call.
  adoptWorkspaceSession(payload) {
    if (!hasExactKeys(payload, ['session_id'])) return projectFailure('invalid_project_request');
    if (!this._resolveWorkspaceProject) return projectFailure('workspace_project_unavailable');
    const resolved = this._resolveWorkspaceProject();
    if (!resolved?.ok) {
      const reason = resolved?.reason === 'workspace_root_unset'
        ? 'workspace_root_unset'
        : 'workspace_project_unavailable';
      return projectFailure(reason, { provisioning_reason: resolved?.reason || null });
    }
    const assigned = this.assignSessionProject({
      project_id: resolved.project.id, session_id: payload.session_id,
    });
    return assigned.ok
      ? { ...assigned, project: this._projectProjection(resolved.project) }
      : assigned;
  }

  // Delete a project: its idle chats move to General first (durably, one by
  // one), then the entry is removed. A busy chat anywhere in the project blocks
  // the whole operation so nothing is half-moved. The folder on disk is never
  // touched; `workspace_bound` tells the caller the configured Workspace
  // folder pointed at this project, so the renderer can clear it.
  deleteProject(payload) {
    if (!hasExactKeys(payload, ['project_id'])) return projectFailure('invalid_project_request');
    const projectId = normalizeProjectIdentity(payload.project_id);
    if (!projectId) return projectFailure('invalid_project_id');
    if (projectId === GENERAL_PROJECT_ID) return projectFailure('general_protected');
    const project = this._projects.get(projectId);
    if (!project) return projectFailure('project_not_found');
    const storage = this._projectStore.getStatus();
    if (storage.read_only === true) return projectFailure(storage.reason || 'project_store_read_only');
    const inventory = this._readSessionInventory();
    if (!inventory) return projectFailure('session_inventory_unavailable');
    const members = inventory.filter((record) => record?.project_id === projectId);
    let busyCount = 0;
    for (const record of members) {
      let busy = true;
      try {
        busy = this._isSessionBusy(record.id) !== false;
      } catch (_error) {
        // An unavailable lifecycle registry cannot prove a chat is idle.
      }
      if (busy || sessionIsBusy(record)) busyCount += 1;
    }
    if (busyCount > 0) return projectFailure('project_sessions_busy', { busy_count: busyCount, reason: 'session_busy' });
    // Moves are all-or-nothing from the caller's view: a failed move or a
    // failed store write puts the already-moved chats back, so a refused delete
    // never leaves chats silently in General under a project that still exists.
    const movedIds = [];
    for (const record of members) {
      const updated = this._assignDurably(record.id, GENERAL_PROJECT_ID);
      if (!updated.ok) {
        const restored = this._restoreProjectMembers(movedIds, projectId);
        return projectFailure(updated.reason, { repair: updated.repair, ...restored });
      }
      movedIds.push(record.id);
    }
    const removed = this._projects.remove(projectId);
    if (!removed?.ok) {
      const restored = this._restoreProjectMembers(movedIds, projectId);
      return projectFailure(removed?.reason || 'project_update_failed', restored);
    }
    return {
      ok: true,
      project: { id: project.id, name: project.name, root_path: project.root_path },
      moved_sessions: movedIds.length,
      workspace_bound: this._workspaceBoundTo(project),
    };
  }

  _assignDurably(sessionId, projectId) {
    return assignSessionProjectDurably({
      sessionStore: this._sessions,
      shadowStore: this._shadow,
      sessionId,
      projectId,
      updatedAt: this._now(),
    });
  }

  // Best-effort rollback of a partial delete. `moved_sessions` reports the
  // chats that could NOT be put back (still in General); zero means clean.
  _restoreProjectMembers(sessionIds, projectId) {
    let restored = 0;
    for (const sessionId of sessionIds) {
      let ok;
      try { ok = this._assignDurably(sessionId, projectId).ok === true; } catch (_error) { ok = false; }
      if (ok) restored += 1;
    }
    return { moved_sessions: sessionIds.length - restored, restored_sessions: restored };
  }

  // null when the inventory cannot be read: a delete must then refuse rather
  // than treat "unknown" as "no chats, none busy".
  _readSessionInventory() {
    const store = this._sessions;
    try {
      if (typeof store.listSessionRecords === 'function') return store.listSessionRecords() || [];
      if (typeof store.listSessions === 'function') return store.listSessions() || [];
    } catch (_error) {
      return null;
    }
    return [];
  }

  _listSessionRecords() {
    const store = this._sessions;
    try {
      if (typeof store.listSessionRecords === 'function') return store.listSessionRecords() || [];
      if (typeof store.listSessions === 'function') return store.listSessions() || [];
    } catch (_error) {
      // Fall through: an unreadable list means no chat can be proven idle.
    }
    return [];
  }

  _workspaceBoundTo(project) {
    if (!project?.root_path) return false;
    try {
      // Canonical identity, not string equality: Windows folders differ in
      // case and separators between the configured root and the store.
      const rootId = workspaceRootId(String(this._resolveWorkspaceRoot() || ''));
      return Boolean(rootId) && rootId === workspaceRootId(project.root_path);
    } catch (_error) {
      return false;
    }
  }

  assignSessionProject(payload) {
    if (!hasExactKeys(payload, ['project_id', 'session_id'])) {
      return projectFailure('invalid_project_request');
    }
    const projectId = normalizeProjectIdentity(payload.project_id);
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
    if (!projectId) return projectFailure('invalid_project_id');
    if (!sessionId || sessionId !== payload.session_id || sessionId.length > 200) {
      return projectFailure('invalid_project_request');
    }
    try {
      this._authority.captureProject(projectId);
    } catch (error) {
      return this._caughtProjectFailure(error);
    }
    const summary = this._sessions.getSessionSummary(sessionId);
    if (!summary) return projectFailure('session_not_found');
    let busy = true;
    try {
      busy = this._isSessionBusy(sessionId) !== false;
    } catch (_error) {
      // An unavailable lifecycle registry cannot prove that assignment is safe.
    }
    if (busy || sessionIsBusy(summary)) return projectFailure('session_busy');
    if (summary.project_id === projectId) return { ok: true, session: summary, unchanged: true };
    const session = this._sessions.getSession(sessionId);
    if (!session || sessionIsBusy(session)) return projectFailure('session_busy');
    const updated = assignSessionProjectDurably({
      sessionStore: this._sessions,
      shadowStore: this._shadow,
      sessionId,
      projectId,
      updatedAt: this._now(),
    });
    return updated.ok
      ? { ok: true, session: updated.session, unchanged: false }
      : projectFailure(updated.reason, { repair: updated.repair });
  }

  getPermissionReviewState(payload) {
    if (payload !== undefined) return reviewFailure('permission_review_request_invalid');
    return this._permissions.getReviewState();
  }

  resolvePermissionReview(payload) {
    if (!isPlainRecord(payload) || !REVIEW_DECISIONS.has(payload.decision)) {
      return reviewFailure('permission_review_request_invalid');
    }
    const auto = payload.decision === 'auto';
    const expectedKeys = auto
      ? ['decision', 'expected_authority_key', 'expected_root_revision', 'project_id', 'review_id']
      : ['decision', 'review_id'];
    if (!hasExactKeys(payload, expectedKeys)) {
      return reviewFailure('permission_review_request_invalid');
    }
    const reviewId = typeof payload.review_id === 'string' ? payload.review_id.trim() : '';
    if (!reviewId || reviewId !== payload.review_id || reviewId.length > 80) {
      return reviewFailure('permission_review_id_invalid');
    }
    let authority;
    if (auto) {
      const projectId = normalizeProjectIdentity(payload.project_id);
      if (!projectId || !Number.isSafeInteger(payload.expected_root_revision)
        || payload.expected_root_revision < 0
        || !/^authority_[a-f0-9]{64}$/u.test(payload.expected_authority_key)) {
        return reviewFailure('permission_review_request_invalid');
      }
      try {
        authority = this._authority.captureProject(projectId);
        if (authority.root_revision !== payload.expected_root_revision
          || projectAuthorityKey(authority) !== payload.expected_authority_key) {
          return projectFailure('stale_root_revision', {
            current_root_revision: authority.root_revision,
          });
        }
        this._authority.requireCurrent?.(authority);
      } catch (error) {
        return this._caughtProjectFailure(error);
      }
    }
    try {
      const result = this._permissions.resolvePendingReview(reviewId, {
        decision: payload.decision,
        ...(auto ? { authority } : {}),
      });
      if (!result?.resolved) {
        return reviewFailure(
          result?.reason === 'not_found' ? 'permission_review_not_found' : result?.reason || 'permission_review_failed'
        );
      }
      try {
        Promise.resolve(this._onPermissionChanged()).catch(() => {});
      } catch (_error) {
        // Durable permission state remains authoritative if refresh notification fails.
      }
      return { ok: true, review: result.review, review_state: this._permissions.getReviewState() };
    } catch (error) {
      return reviewFailure(String(error?.code || 'permission_review_failed'), String(error?.message || ''));
    }
  }

  _projectResult(result) {
    if (!result?.ok) {
      return projectFailure(result?.reason || 'project_update_failed', {
        ...(Number.isSafeInteger(result?.current_revision)
          ? { current_root_revision: result.current_revision }
          : {}),
      });
    }
    return {
      ok: true,
      project: this._projectProjection(result.project),
      unchanged: result.unchanged === true,
    };
  }

  _projectProjection(project) {
    let authorityKey = '';
    try {
      authorityKey = projectAuthorityKey(this._authority.captureProject(project.id));
    } catch (_error) {
      // A disconnected root stays inspectable but cannot be approved.
    }
    return { ...project, authority_key: authorityKey };
  }

  _caughtProjectFailure(error) {
    const reason = String(error?.reason || error?.code || 'project_authority_unavailable');
    if (String(error?.code || '').startsWith('CMP-PROJECT-')) {
      return failure(error.code, reason, String(
        error.message
          || t('projects.application.authorityUnavailable', 'Project authority is unavailable.')
      ));
    }
    return projectFailure(reason);
  }
}

module.exports = {
  ProjectApplicationService,
  hasExactKeys,
  projectAuthorityKey,
  sessionIsBusy,
};

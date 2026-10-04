'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { PROJECT_ERROR_CODES, TOOL_ERROR_CODES } = require('../backend/error-codes');
const { t } = require('../i18n-main');
const { GENERAL_PROJECT_ID, normalizeProjectId } = require('./project-schema');
const { ProjectDeleteOperation } = require('./project-delete-operation');
const { ProjectFolderStatus } = require('./project-folder-status');
const { canonicalizeProjectRootAsync } = require('./project-service');
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
    project_folder_missing: t('projects.application.folderMissing', 'The project folder is missing. Locate it first.'),
    reveal_unavailable: t('projects.application.revealUnavailable', 'The folder could not be opened.'),
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
    folder_already_project: t(
      'projects.application.folderAlreadyProject',
      'That folder already belongs to another project.'
    ),
    project_is_current: t(
      'projects.application.projectIsCurrent',
      'This project is the open Workspace. Open another project before changing its folder.'
    ),
    folder_picker_unavailable: t(
      'projects.application.folderPickerUnavailable',
      'The folder picker is unavailable.'
    ),
    choose_in_progress: t(
      'projects.application.chooseInProgress',
      'A folder picker is already open.'
    ),
    project_memories_unavailable: t(
      'projects.application.memoriesUnavailable',
      'Memories could not be moved to General, so the project was not deleted. Try again.'
    ),
    project_knowledge_unavailable: t(
      'projects.application.knowledgeUnavailable',
      'Knowledge folders could not be moved to General, so the project was not deleted.'
    ),
  };
  const invalid = [
    'invalid_name', 'invalid_project_id', 'invalid_project_request',
    'general_root_reserved', 'invalid_root', 'workspace_root_unset', 'general_protected',
    'folder_already_project', 'project_is_current',
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

// projects.chooseRoot answers with the reason at the top level (the renderer
// branches on it) and keeps the coded error alongside for the shared toasts.
function flatFailure(result) {
  const error = result?.error || {};
  const { code: _code, message: _message, ...details } = error;
  return { ...details, ok: false, reason: error.reason || 'project_update_failed', error };
}

const FAILURE_DETAIL_KEYS = ['conflict_project_id', 'conflict_project_name'];

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
    folderStatus = null,
    knowledgeService = null,
    moveProjectMemories = null,
    projectDeleteJournal = null,
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
    this._folderStatus = folderStatus || new ProjectFolderStatus();
    this._choosingRoot = false;
    this._deleter = new ProjectDeleteOperation({
      projects: projectService,
      projectStore,
      sessions: sessionStore,
      shadow: shadowStore,
      permissions: permissionStore,
      isSessionBusy,
      sessionIsBusy,
      knowledge: typeof knowledgeService?.moveProjectFolders === 'function' ? knowledgeService : null,
      moveMemories: typeof moveProjectMemories === 'function' ? moveProjectMemories : null,
      journal: projectDeleteJournal,
      folderStatus: this._folderStatus,
      isCurrentProject: (project) => this._isCurrentProject(project),
      now: this._now,
      fail: projectFailure,
    });
    this.reconcilePendingProjectDeletes = () => this._deleter.reconcile(); // after each sidecar initialize
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

  // Desktop projects.list: one store snapshot, every existing field, plus
  // `folder_exists` (null for folderless General) and `is_current` (the
  // project's real folder IS the configured Workspace folder's real path).
  // Filesystem probes are async and cached per (project, root_revision).
  async listProjectsWithStatus(payload) {
    if (payload !== undefined) return projectFailure('invalid_project_request');
    const status = this._projectStore.getStatus();
    const storeState = status.read_only === true ? `read_only:${status.reason || ''}` : 'writable';
    const projects = this._projects.list();
    const workspaceKey = await this._folderStatus.workspaceRootKey(this._configuredWorkspaceRoot());
    const rows = await Promise.all(projects.map(async (project) => {
      const [authorityKey, folder, isCurrent] = await Promise.all([
        this._folderStatus.authorityKey(project, storeState, () => this._authorityKeyAsync(project)),
        project.root_path ? this._folderStatus.folder(project.root_path) : null,
        this._folderStatus.isCurrent(project, workspaceKey),
      ]);
      return {
        ...project,
        authority_key: authorityKey,
        folder_exists: folder ? folder.exists === true : null,
        is_current: isCurrent === true,
      };
    }));
    return {
      ok: true,
      projects: rows,
      storage: { read_only: status.read_only === true, reason: status.reason || null },
    };
  }

  async _authorityKeyAsync(project) {
    try {
      const authority = typeof this._authority.captureProjectRecordAsync === 'function'
        ? await this._authority.captureProjectRecordAsync(project)
        : this._authority.captureProject(project.id);
      return projectAuthorityKey(authority);
    } catch (_error) {
      return '';
    }
  }

  _configuredWorkspaceRoot() {
    try {
      return String(this._resolveWorkspaceRoot() || '');
    } catch (_error) {
      return '';
    }
  }

  async _isCurrentProject(project) {
    try {
      const workspaceKey = await this._folderStatus.workspaceRootKey(this._configuredWorkspaceRoot());
      return await this._folderStatus.isCurrent(project, workspaceKey);
    } catch (_error) {
      return false;
    }
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
    if (!Number.isSafeInteger(payload.expected_root_revision) || payload.expected_root_revision < 0) return projectFailure('invalid_project_request');
    if (payload.root_path !== null
      && (typeof payload.root_path !== 'string' || !payload.root_path.trim())) {
      return projectFailure('invalid_root');
    }
    if (projectId === GENERAL_PROJECT_ID && payload.root_path !== null) return projectFailure('general_root_reserved');
    // An admitted tool operation keeps the folder it captured, so a real change
    // waits until no chat in the project is running (as delete does).
    let blocked = null;
    const bound = this._projects.bindRoot(projectId, payload.root_path, {
      expectedRevision: payload.expected_root_revision,
      beforeChange: () => {
        blocked = this._projectRootBusyFailure(projectId);
        return !blocked;
      },
    });
    if (blocked) return blocked;
    const result = this._projectResult(bound);
    if (result.ok && !result.unchanged) this._folderStatus.invalidate();
    return result;
  }

  _projectRootBusyFailure(projectId) {
    let records;
    try {
      records = typeof this._sessions.listSessionRecords === 'function'
        ? this._sessions.listSessionRecords()
        : this._sessions.listSessions?.();
    } catch (_error) {
      return projectFailure('session_inventory_unavailable');
    }
    if (!Array.isArray(records)) return projectFailure('session_inventory_unavailable');
    let busyCount = 0;
    for (const record of records) {
      if (record?.project_id !== projectId) continue;
      let busy = true;
      try {
        busy = this._isSessionBusy(record.id) !== false;
      } catch (_error) {
        // An unavailable lifecycle registry cannot prove that a chat is idle.
      }
      if (busy || sessionIsBusy(record)) busyCount += 1;
    }
    return busyCount > 0
      ? projectFailure('project_sessions_busy', { busy_count: busyCount, reason: 'session_busy' })
      : null;
  }

  // "Locate folder" / "Change folder" (desktop only): main opens the OS picker
  // and binds the pick through bindProjectRoot, so the renderer never sends a
  // path. The project keeps its id and chats. The open Workspace project is
  // refused (its folder is in use), before the picker opens and again after
  // it closes (a Workspace switch may have committed while it was open).
  async chooseProjectRoot(payload, { pickFolder } = {}) {
    if (!hasExactKeys(payload, ['expected_root_revision', 'project_id'])) {
      return flatFailure(projectFailure('invalid_project_request'));
    }
    const projectId = normalizeProjectIdentity(payload.project_id);
    if (!projectId) return flatFailure(projectFailure('invalid_project_id'));
    const revision = payload.expected_root_revision;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      return flatFailure(projectFailure('invalid_project_request'));
    }
    if (projectId === GENERAL_PROJECT_ID) return flatFailure(projectFailure('general_root_reserved'));
    const project = this._projects.get(projectId);
    if (!project) return flatFailure(projectFailure('project_not_found'));
    if (project.root_revision !== revision) {
      return flatFailure(projectFailure('stale_root_revision', { current_root_revision: project.root_revision }));
    }
    this._folderStatus.invalidate();
    if (await this._isCurrentProject(project)) return flatFailure(projectFailure('project_is_current'));
    const blocked = this._projectRootBusyFailure(projectId);
    if (blocked) return flatFailure(blocked);
    if (typeof pickFolder !== 'function') return flatFailure(projectFailure('folder_picker_unavailable'));
    if (this._choosingRoot) return flatFailure(projectFailure('choose_in_progress'));
    this._choosingRoot = true;
    let picked;
    try {
      picked = await pickFolder({
        defaultPath: project.root_path ? path.dirname(project.root_path) : undefined,
      });
    } catch (_error) {
      return flatFailure(projectFailure('folder_picker_unavailable'));
    } finally {
      this._choosingRoot = false;
    }
    const pickedPath = typeof picked?.path === 'string' ? picked.path.trim() : '';
    if (!picked || picked.canceled === true || !pickedPath) return { ok: false, reason: 'canceled' };
    this._folderStatus.invalidate();
    if (await this._isCurrentProject(this._projects.get(projectId) || project)) return flatFailure(projectFailure('project_is_current'));
    const bound = this.bindProjectRoot({
      project_id: projectId, root_path: pickedPath, expected_root_revision: revision,
    });
    return bound.ok
      ? { ok: true, project: bound.project, unchanged: bound.unchanged === true }
      : flatFailure(bound);
  }

  // "Reveal folder" (desktop only): the renderer names a project, main opens
  // that project's own folder in the OS file manager. No path crosses IPC.
  async revealProjectFolder(payload, { openFolder } = {}) {
    if (!hasExactKeys(payload, ['project_id'])) return projectFailure('invalid_project_request');
    const projectId = normalizeProjectIdentity(payload.project_id);
    if (!projectId) return projectFailure('invalid_project_id');
    if (projectId === GENERAL_PROJECT_ID) return projectFailure('general_root_reserved');
    const project = this._projects.get(projectId);
    if (!project) return projectFailure('project_not_found');
    if (typeof project.root_path !== 'string' || !project.root_path.trim()) return projectFailure('project_folder_missing');
    if (typeof openFolder !== 'function') return projectFailure('reveal_unavailable');
    const canonical = await canonicalizeProjectRootAsync(project.root_path).catch(() => null);
    // The probe yielded: open only a folder still registered to this project,
    // at the same revision, whose real path is the identity it was bound to.
    const current = this._projects.get(projectId);
    if (!current) return projectFailure('project_not_found');
    if (!canonical || current.root_path !== project.root_path || current.root_revision !== project.root_revision
      || workspaceRootId(canonical) !== current.root_id) return projectFailure('project_folder_missing');
    try {
      const error = await openFolder(canonical);
      return error ? projectFailure('reveal_unavailable') : { ok: true };
    } catch (_error) {
      return projectFailure('reveal_unavailable');
    }
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

  // Delete a project: its knowledge folders, idle chats and memories move to
  // General in one all-or-nothing operation (project-delete-operation.js).
  async deleteProject(payload) {
    if (!hasExactKeys(payload, ['project_id'])) return projectFailure('invalid_project_request');
    const projectId = normalizeProjectIdentity(payload.project_id);
    if (!projectId) return projectFailure('invalid_project_id');
    if (projectId === GENERAL_PROJECT_ID) return projectFailure('general_protected');
    return this._deleter.run(projectId);
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
      const details = Object.fromEntries(FAILURE_DETAIL_KEYS
        .filter((key) => typeof result?.[key] === 'string')
        .map((key) => [key, result[key]]));
      return projectFailure(result?.reason || 'project_update_failed', {
        ...(Number.isSafeInteger(result?.current_revision)
          ? { current_root_revision: result.current_revision }
          : {}),
        ...details,
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

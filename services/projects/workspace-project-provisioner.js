'use strict';

// The Workspace folder is the project. Choosing a folder provisions (or finds)
// the project bound to it, so chats get file authority the way Claude Code and
// Codex treat their launch directory. General stays the folderless home, and
// existing chats are never retargeted: they adopt the workspace project only
// through an explicit, idle-only assignment (docs/operations/session-runtime.md).

const path = require('node:path');

const { getConfiguredToolsWorkspaceRoot } = require('../backend/managed-sidecar-config');
const { workspaceRootId } = require('../workspace-root-identity');
const { GENERAL_PROJECT_ID, normalizeProjectName } = require('./project-schema');
const { canonicalizeProjectRoot } = require('./project-service');

function failure(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function emit(service, level, event, details) {
  if (typeof service?._emitServiceLog === 'function') service._emitServiceLog(level, event, details);
}

function projectNameForRoot(canonicalRoot) {
  return normalizeProjectName(path.basename(canonicalRoot))
    || normalizeProjectName(canonicalRoot)
    || 'Workspace';
}

// list() is ordered by created_at, so the earliest project bound to the folder
// wins when the owner bound the same folder twice by hand.
function findProjectBoundTo(projectService, canonicalRoot) {
  const rootId = workspaceRootId(canonicalRoot);
  return projectService.list().find((project) => (
    project.root_id === rootId && project.root_path === canonicalRoot
  )) || null;
}

function ensureWorkspaceProject(service, rootPath, { reason = 'unspecified' } = {}) {
  const projectService = service?.projectService;
  if (!projectService || typeof projectService.list !== 'function') {
    return failure('project_service_unavailable');
  }
  // Hosted profiles bind roots through their own reviewed project commands
  // inside the configured mount; nothing is provisioned implicitly there.
  if (service.hostMode === 'server') return failure('host_mode_server');
  const requested = String(rootPath || '').trim();
  if (!requested) return failure('workspace_root_unset');
  const status = service.projectStore?.getStatus?.();
  if (status?.read_only) return failure('project_store_read_only', { store_reason: status.reason || null });
  let canonicalRoot;
  try {
    canonicalRoot = canonicalizeProjectRoot(requested);
  } catch (error) {
    emit(service, 'WARN', 'projects.workspace_project_failed', {
      reason: error?.code === 'invalid_root' ? 'invalid_root' : 'root_unavailable', trigger: reason,
    });
    return failure(error?.code === 'invalid_root' ? 'invalid_root' : 'root_unavailable');
  }
  if (!canonicalRoot) return failure('workspace_root_unset');
  const existing = findProjectBoundTo(projectService, canonicalRoot);
  if (existing) return { ok: true, project: existing, created: false };
  const created = projectService.create({ name: projectNameForRoot(canonicalRoot) });
  if (!created.ok) {
    emit(service, 'WARN', 'projects.workspace_project_failed', { reason: created.reason, trigger: reason });
    return failure(created.reason);
  }
  const bound = projectService.bindRoot(created.project.id, canonicalRoot, { expectedRevision: 0 });
  if (!bound.ok) {
    emit(service, 'WARN', 'projects.workspace_project_failed', {
      reason: bound.reason, trigger: reason, project_id: created.project.id,
    });
    return failure(bound.reason, { project: created.project });
  }
  emit(service, 'INFO', 'projects.workspace_project_provisioned', {
    project_id: bound.project.id, root_id: bound.project.root_id, trigger: reason,
  });
  return { ok: true, project: bound.project, created: true };
}

// New chats land in the configured workspace's project; General only when no
// folder is configured or the folder cannot be provisioned.
function resolveDefaultSessionProjectId(service, { reason = 'session_create' } = {}) {
  const result = ensureWorkspaceProject(service, getConfiguredToolsWorkspaceRoot(service), { reason });
  return result.ok ? result.project.id : GENERAL_PROJECT_ID;
}

module.exports = {
  ensureWorkspaceProject,
  findProjectBoundTo,
  projectNameForRoot,
  resolveDefaultSessionProjectId,
};

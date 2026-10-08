'use strict';

const { SessionExecutionAuthority } = require('../backend/session-execution-authority');
const { ProjectApplicationService } = require('./project-application-service');
const { GENERAL_PROJECT_ID } = require('./project-schema');
const { RuntimeApplicationService } = require('../session-runtime/application-service');
const { ensureWorkspaceProject } = require('./workspace-project-provisioner');
const { getConfiguredToolsWorkspaceRoot } = require('../backend/managed-sidecar-config');
const { moveProjectMemories } = require('../backend/backend-memory');
const { resolveSessionToolDenyList } = require('../backend/backend-service-utils');

function isSessionBusy(service, sessionId) {
  if (service.sessionTurnActors?.hasActiveLifecycle?.(sessionId) !== false) return true;
  if (typeof service.sessionStore.listSessionRecords !== 'function') return true;
  if (service.sessionStore.listSessionRecords().some(record => record.id === sessionId
    && (record.active_turn || record.pending_question_batch))) return true;
  return Boolean(service.sessionRuntime && service.sessionRuntime.hasSessionWork?.(sessionId) !== false);
}

function initializeSessionExecutionAuthority(service) {
  service.runtimeApplicationService = new RuntimeApplicationService({ getRuntime: () => service.sessionRuntime });
  // Minimal embedded/test hosts may omit tool services. They can converse but
  // cannot acquire tool authority through a permissive legacy default.
  const permissionStore = service.toolPermissionStore || {
    getSnapshot: () => ({ version: 3, legacy_policies: {}, rules: [
      { id: 'execution-permission-store-unavailable', decision: 'deny', match: {} },
    ] }),
    getReviewState: () => ({ read_only: true, read_only_reason: 'permission_store_unavailable',
      pending_count: 0, pending: [], history: [] }),
    resolvePendingReview: () => ({ resolved: false, reason: 'permission_store_unavailable' }),
  };
  const knowledgeService = service.knowledgeService || {
    getSidecarConfig: () => ({ tools_knowledge_enabled: false, knowledge_roots: [] }),
  };
  service.sessionExecutionAuthority = new SessionExecutionAuthority({
    projectAuthority: service.projectAuthority,
    permissionStore,
    knowledgeService,
    skillsService: service.skillsService,
    resolveProjectWorkspaceServices: service.resolveProjectWorkspaceServices,
    resolveSessionDisabledTools: (sessionId) => resolveSessionToolDenyList(
      typeof service.sessionStore.getSessionSummary === 'function'
        ? service.sessionStore.getSessionSummary(sessionId)
        : service.sessionStore.getSession(sessionId),
      service.currentStatus?.tools_status
    ),
  });
  // The Workspace folder is the project: the root commit and the "use this
  // folder" affordance both resolve through this one seam.
  service.ensureWorkspaceProject = (rootPath, reason) => (
    ensureWorkspaceProject(service, rootPath, { reason })
  );
  service.projectApplicationService = new ProjectApplicationService({
    projectService: service.projectService, projectStore: service.projectStore,
    projectAuthority: service.projectAuthority, sessionStore: service.sessionStore,
    shadowStore: service.shadowStore, permissionStore,
    isSessionBusy: sessionId => isSessionBusy(service, sessionId),
    resolveWorkspaceProject: () => service.ensureWorkspaceProject(
      getConfiguredToolsWorkspaceRoot(service), 'session_adopt_workspace'
    ),
    resolveWorkspaceRoot: () => getConfiguredToolsWorkspaceRoot(service),
    // Deleting a project moves its knowledge folders and memories to General.
    knowledgeService: service.knowledgeService || null,
    moveProjectMemories: ({ from_project_id: from, to_project_id: to }) => (
      moveProjectMemories(service, from, to)
    ),
    projectDeleteJournal: service.projectDeleteJournal || null,
    // Agent tasks follow their chat between projects (and back on Undo).
    onSessionProjectChanged: ({ sessionId, projectId }) => (
      service.configService?.restampAgentTasksForSession?.(sessionId, projectId)
    ),
    // A deleted project takes its note with it (nothing restores a deleted project);
    // its remaining agent tasks (rail-added, or from chats deleted earlier) move to General.
    // Each step runs on its own: a task re-stamp failure must not keep the note alive, nor the reverse.
    // The delete operation logs `failed` (the project is gone either way; cleanup covers an orphaned note file).
    onProjectDeleted: (projectId) => {
      const failed = [];
      const steps = {
        tasks: () => service.configService?.restampAgentTasksForProject?.(projectId, GENERAL_PROJECT_ID),
        notes: () => service.projectNotesService?.deleteProjectNotes?.(projectId),
      };
      for (const [step, run] of Object.entries(steps)) {
        try {
          const result = run();
          if (result && result.ok === false) failed.push(`${step}:${String(result.reason || 'failed').slice(0, 40)}`);
        } catch (error) {
          failed.push(`${step}:${String(error?.code || error?.message || 'threw').slice(0, 40)}`);
        }
      }
      return { ok: failed.length === 0, failed };
    },
    onPermissionChanged() {
      // Live calls recheck the canonical policy through runtime.operation.
      // Reinitialization must not disturb an admitted turn or its live waiter.
      if (!service.activeStreams?.size) return service.refreshManagedConfig?.('tool_permission_updated');
    },
  });
}

module.exports = { initializeSessionExecutionAuthority, isSessionBusy };

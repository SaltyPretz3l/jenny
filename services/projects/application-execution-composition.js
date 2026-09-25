'use strict';

const { SessionExecutionAuthority } = require('../backend/session-execution-authority');
const { getManagedPluginRuntime } = require('../backend/managed-plugin-runtime');
const { ProjectApplicationService } = require('./project-application-service');
const { RuntimeApplicationService } = require('../session-runtime/application-service');
const { ensureWorkspaceProject } = require('./workspace-project-provisioner');
const { getConfiguredToolsWorkspaceRoot } = require('../backend/managed-sidecar-config');

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
    resolvePluginToolAuthority: (expectedAuthority) => (
      getManagedPluginRuntime(service)?.captureExecutionToolAuthority(expectedAuthority)
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
    onPermissionChanged() {
      // Live calls recheck the canonical policy through runtime.operation.
      // Reinitialization must not disturb an admitted turn or its live waiter.
      if (!service.activeStreams?.size) return service.refreshManagedConfig?.('tool_permission_updated');
    },
  });
}

module.exports = { initializeSessionExecutionAuthority, isSessionBusy };

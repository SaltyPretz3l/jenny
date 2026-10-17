'use strict';

/* services/chat-workspace-wiring.js - composes ChatWorkspaceService against
 * the live desktop backend (row 59 checkpoint 2): the session store and its
 * coordination view store, the session's project authority, the session-scoped
 * Git service, project/worktree registries and the Test Runner activity
 * source. Dependencies resolve lazily through `backendService` because several
 * of them are attached after this composition runs. Desktop only; the hosted
 * composition does not construct it (hosted exposure is a separate decision).
 */

const { createWorkspaceViewStore } = require('./backend/session-coordination-records');
const { ChatWorkspaceService } = require('./chat-workspace-service');
const { previewContext } = require('./backend/context-preview');

function resolveExecutionEnvironment(backendService) {
  if (backendService.hostMode === 'server') return 'hosted';
  const sandbox = backendService.commandSandbox;
  if (sandbox?.enabled === true || backendService.configService?.getState?.()?.commandSandbox?.enabled === true) {
    return 'sandbox';
  }
  return 'local';
}

function createLazyViewStore(backendService) {
  const unavailable = { ok: false, reason: 'unavailable' };
  const withStore = (fn) => {
    const store = backendService.sessionStore;
    return store ? fn(createWorkspaceViewStore(store)) : unavailable;
  };
  return {
    read: (sessionId) => withStore((viewStore) => viewStore.read(sessionId)),
    write: (sessionId, request) => withStore((viewStore) => viewStore.write(sessionId, request)),
  };
}

function createChatWorkspaceService({ backendService, emit = () => {}, log = () => {} }) {
  const service = new ChatWorkspaceService({
    viewStore: createLazyViewStore(backendService),
    getStore: () => backendService.sessionStore || null,
    getContextPreview: (sessionId) => previewContext(backendService, sessionId),
    captureAuthority: (sessionId) => backendService.projectAuthority.captureSession(sessionId),
    resolveGitService: (authority, sessionId) => backendService.resolveProjectWorkspaceServices(
      authority, { sessionId }
    )?.workspaceGitService || null,
    getProject: (projectId) => backendService.projectService?.get?.(projectId) || null,
    // The registry is the worktree service's own persisted list of Jenny-created worktrees.
    getWorktreeEntries: () => backendService.worktreeService?._registryService?.listAll?.() || [],
    getExecutionEnvironment: () => resolveExecutionEnvironment(backendService),
    getWorkspaceTestSource: () => backendService.workspaceTestRunnerService || null,
    // Linked chat turns: the session runtime's work index (read-only; absent when the runtime is not composed).
    getRuntimeStore: () => backendService.sessionRuntime?.store || null,
    isActivityEnabled: () => backendService.featureFlags?.activity_monitor === true,
    emit,
    log: (level, event, details) => log(level, event, details),
  });
  // Terminal context-usage persistence, artifact registration and session
  // completion all surface as chat-stream events; no new producer hook needed.
  backendService.on?.('chat-stream', (event) => service.handleChatStreamEvent(event));
  return service;
}

module.exports = { createChatWorkspaceService, resolveExecutionEnvironment };

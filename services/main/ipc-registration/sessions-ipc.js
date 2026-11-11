const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const { imageEditingAvailable } = require('../../image-edit-reference');
const { seedRememberedBrowserChoice } = require('../../backend/new-chat-browser-seed');

// Sessions domain IPC: backend status/retry, the local auth profile, session
// CRUD, export and fork, session templates, and the per-session artifacts and
// chat images.

function registerSessionIpcHandlers(ipcMain, {
  backendService,
  shellConfigService,
  startDeferredServices,
  workspaceAuthorization,
}) {
  registerIpcInvokeHandlers(ipcMain, {
    'backend.getStatus': () => backendService.getBackendStatus(),
    'backend.retryStart': async () => {
      const status = await backendService.retryStart();
      if (status && status.phase === 'ready') {
        startDeferredServices();
      }
      return status;
    },
    'auth.getState': () => backendService.getAuthState(),
    'auth.updateLocalProfile': (_, payload) => backendService.updateLocalProfile(payload),
    'sessions.list': () => backendService.listSessions(),
    'sessions.create': (_, payload) => backendService.createSession(seedRememberedBrowserChoice(payload, shellConfigService)),
    'sessions.rename': (_, sessionId, title) => backendService.renameSession(sessionId, title),
    'sessions.delete': (_, sessionId, options) => backendService.deleteSession(sessionId, options),
    'sessions.getMessages': (_, sessionId) => backendService.getSessionMessages(sessionId),
    'sessions.setPreferences': (_, sessionId, preferences) =>
      backendService.setSessionPreferences(sessionId, preferences),
    'sessions.setMeta': (_, sessionId, meta) => backendService.setSessionMeta(sessionId, meta),
    'sessions.sweepEmpty': (_, options) => backendService.sweepEmptySessions(options),
    'sessions.editAndTruncate': (_, sessionId, messageId, payload) =>
      backendService.editUserMessageAndTruncate(sessionId, messageId, payload),
    'sessions.exportSession': (_, sessionId) => {
      const { exportSession } = require('../../backend/session-export-import');
      return exportSession(
        backendService.sessionStore,
        sessionId,
        backendService.attachmentAssetStore,
        { includeMemory: backendService.featureFlags?.memory_v2_enabled === true, service: backendService }
      );
    },
    'sessions.forkSession': (_, sessionId, atMessageId, options) => {
      const { forkSessionWithArtifacts } = require('../../backend/session-branching');
      // Only `title` is renderer-authored; never spread the raw payload into
      // fork options (branchSessionId / artifactRewrite are internal seams).
      const requestedTitle = options && typeof options === 'object' && !Array.isArray(options)
        ? options.title
        : '';
      return forkSessionWithArtifacts(
        backendService.sessionStore,
        sessionId,
        atMessageId,
        {
          title: requestedTitle,
          shadowStore: backendService.shadowStore,
          artifactService: backendService.artifactService,
        }
      );
    },
    'templates.list': () => {
      const { SessionTemplateStore } = require('../../backend/session-templates');
      return new SessionTemplateStore(shellConfigService).list();
    },
    'templates.save': (_, template) => {
      const { SessionTemplateStore } = require('../../backend/session-templates');
      return new SessionTemplateStore(shellConfigService).save(template);
    },
    'templates.delete': (_, templateId) => {
      const { SessionTemplateStore } = require('../../backend/session-templates');
      return new SessionTemplateStore(shellConfigService).delete(templateId);
    },
    'templates.apply': (_, templateId) => {
      const { SessionTemplateStore } = require('../../backend/session-templates');
      return new SessionTemplateStore(shellConfigService).apply(
        templateId,
        backendService.sessionStore
      );
    },
  }, workspaceAuthorization);
}

// fileActions / chatImageActions are built by the caller (artifact file actions
// arm an app before-quit listener) so their construction order is unchanged.
function registerArtifactIpcHandlers(ipcMainLike, {
  artifactService,
  backendService,
  fileActions,
  chatImageActions,
  ipcAuthorization,
}) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'artifacts.read': (_, sessionId, artifactId) =>
      artifactService.readArtifact(sessionId, artifactId),
    'artifacts.save': (_, sessionId, artifactId, content) =>
      artifactService.saveArtifact(sessionId, artifactId, content),
    'artifacts.saveAs': (_, sessionId, artifactId) => fileActions.saveAs(sessionId, artifactId),
    'artifacts.copyImage': (_, sessionId, artifactId) => fileActions.copyImage(sessionId, artifactId),
    'artifacts.capabilities': async () => ({ ...await fileActions.capabilities(), ...await imageEditingAvailable(backendService) }),
    'artifacts.openWith': (_, sessionId, artifactId) => fileActions.openWith(sessionId, artifactId),
    'artifacts.reveal': (_, sessionId, artifactId) =>
      artifactService.revealArtifact(sessionId, artifactId),
    'artifacts.openExternal': (_, sessionId, artifactId) =>
      artifactService.openArtifactExternal(sessionId, artifactId),
    'artifacts.delete': (_, sessionId, artifactId) =>
      artifactService.deleteArtifact(sessionId, artifactId),
    'artifacts.deleteSession': (_, sessionId) =>
      artifactService.deleteSessionArtifacts(sessionId),
    'chatImages.copyImage': (_, sessionId, ref) => chatImageActions.copyImage(sessionId, ref),
    'chatImages.saveAs': (_, sessionId, ref) => chatImageActions.saveAs(sessionId, ref),
    'chatImages.reveal': (_, sessionId, ref) => chatImageActions.reveal(sessionId, ref),
  }, ipcAuthorization);
}

module.exports = {
  registerArtifactIpcHandlers,
  registerSessionIpcHandlers,
};

const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const {
  validateChatStartPayload,
} = require('../../backend/generated-chat-lifecycle-contract');
const { CHAT_PROTOCOL_ERROR_CODES } = require('../../backend/error-codes');
const { createAttachmentIpcHandlers } = require('../attachment-ipc-handlers');

// Chat domain IPC: the chat-surface owners (suggested changes, chat workspace,
// proposals, messaging, primary chat, performance, tools settings, session
// runtime), the pending user-question channels, and the turn/stream channels
// with composer attachments. Every batch runs behind the trusted-sender
// authorizer the caller passes in.

function registerChatSurfaceIpcHandlers(ipcMain, {
  app,
  backendService,
  dialog,
  getMainWindow,
  workspaceAuthorization,
  browserSessionService = null,
  workspaceSnapshotStore = null,
  log,
}) {
  require('../suggested-changes-ipc-registration').registerSuggestedChangesIpc(ipcMain, { backendService, authorization: workspaceAuthorization });
  require('../chat-workspace-ipc-registration').registerChatWorkspaceIpc(ipcMain, { backendService, authorization: workspaceAuthorization });
  require('../change-pictures-ipc-registration').registerChangePicturesIpc(ipcMain, {
    app, backendService, browserSessionService, snapshotStore: workspaceSnapshotStore, authorization: workspaceAuthorization, log,
  });
  require('../chat-proposal-ipc-registration').registerChatProposalIpc(ipcMain, { backendService, authorization: workspaceAuthorization });
  require('../chat-messaging-ipc-registration').registerChatMessagingIpc(ipcMain, { backendService, authorization: workspaceAuthorization });
  require('../primary-chat-ipc-registration').registerPrimaryChatIpc(ipcMain, { backendService, authorization: workspaceAuthorization });
  require('../performance-ipc-registration').registerPerformanceIpc(ipcMain, { backendService, authorization: workspaceAuthorization });
  require('../tools-settings-ipc-registration').registerToolsSettingsIpc(ipcMain, {
    backendService, authorization: workspaceAuthorization, dialog, getMainWindow, userDataPath: app.getPath('userData'),
  });
  if (backendService.projectApplicationService) require('../session-runtime-ipc-registration').registerSessionRuntimeIpcHandlers(ipcMain, {
    applicationService: backendService.projectApplicationService, runtimeApplicationService: backendService.runtimeApplicationService, authorization: workspaceAuthorization,
    dialog, getMainWindow, shell: require('electron')?.shell || null, // projects.chooseRoot / revealFolder stay in main
  });
}

function registerChatUserQuestionIpcHandlers(ipcMain, { backendService, workspaceAuthorization }) {
  registerIpcInvokeHandlers(ipcMain, {
    'chat.hasPendingUserQuestions': (_, questionRef) =>
      backendService.hasPendingUserQuestions(questionRef),
    'chat.answerUserQuestions': (_, questionRef, payload) =>
      backendService.answerUserQuestions(questionRef, payload),
    'chat.declineUserQuestions': (_, questionRef) =>
      backendService.declineUserQuestions(questionRef),
  }, workspaceAuthorization);
}

function assertChatStartIpcPayload(payload, { requireEditedMessageId = false, log = null } = {}) {
  const result = validateChatStartPayload(payload, { requireEditedMessageId });
  if (result.ok) return result.value;
  const details = result.error || {};
  if (typeof log === 'function') {
    log('WARN', 'chat.ipc_payload_rejected', {
      code: details.code,
      path: details.path,
      reason: details.reason,
      byteCount: details.byte_count,
    });
  }
  const error = new TypeError(
    `Invalid chat IPC payload: ${String(details.reason || 'invalid_payload')} at ${String(details.path || '$')}`
  );
  error.code = details.code || CHAT_PROTOCOL_ERROR_CODES.INVALID_PAYLOAD;
  error.path = details.path || '$';
  error.reason = details.reason || 'invalid_payload';
  throw error;
}

function registerChatStreamIpcHandlers(ipcMainLike, {
  backendService,
  shellConfigService,
  dialog,
  getMainWindow,
  prepareAttachmentEntries,
  attachmentAssetStore,
  processRef,
  isChildPath,
  log,
  ipcAuthorization,
}) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'chat.startStream': (_, payload) => backendService.startChatStream(
      assertChatStartIpcPayload(payload, { log })
    ),
    'chat.editAndRegenerate': (_, payload) => backendService.editAndRegenerate(
      assertChatStartIpcPayload(payload, { requireEditedMessageId: true, log })
    ),
    'chat.retryUnsavedReply': (_, payload) => backendService.retryUnsavedReply(payload),
    'chat.discardUnsavedReply': (_, payload) => backendService.discardUnsavedReply(payload),
    'chat.getActiveTurnState': (_, sessionId) => backendService.getActiveTurnState(sessionId),
    'chat.cancelStream': (_, streamId, options = {}) => backendService.cancelChatStream(
      streamId,
      options && typeof options === 'object'
        ? (options.cancel_reason || options.cancelReason || options.reason)
        : ''
    ),
    'chat.compactNow': (_, sessionId) => backendService.compactContextNow(sessionId),
    // Only a bounded project id (row 73) and the closed read-only intent cross.
    'handoff.generateNote': (_, sessionId, options) => backendService.generateHandoffNote(sessionId, {
      projectId: typeof options?.projectId === 'string' ? options.projectId.slice(0, 128) : undefined,
      intent: options?.intent === 'orient' ? 'orient' : undefined,
    }),
    ...createAttachmentIpcHandlers({ backendService, shellConfigService, dialog, getMainWindow,
      prepareAttachmentEntries, attachmentAssetStore, processRef, isChildPath, log }),
  }, ipcAuthorization);
}

module.exports = {
  assertChatStartIpcPayload,
  registerChatStreamIpcHandlers,
  registerChatSurfaceIpcHandlers,
  registerChatUserQuestionIpcHandlers,
};

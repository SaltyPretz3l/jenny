const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const {
  validateChatStartPayload,
} = require('../../backend/generated-chat-lifecycle-contract');
const { CHAT_PROTOCOL_ERROR_CODES } = require('../../backend/error-codes');
const { createAttachmentIpcHandlers } = require('../attachment-ipc-handlers');
const { STEER_ITEM_ID_PATTERN, offerUserSteer, withdrawUserSteer } = require('../../backend/user-steer-mid-turn');

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

function invalidSteerPayload(path, reason) {
  const error = new TypeError(`Invalid chat IPC payload: ${reason} at ${path}`);
  error.code = CHAT_PROTOCOL_ERROR_CODES.INVALID_PAYLOAD;
  error.path = path;
  error.reason = reason;
  return error;
}

// Row 180: a steering offer is `{sessionId, itemId, prompt, attachments}`. The session, prompt and attachments
// pass the chat:start-stream validator (structure, budgets, identifier grammar); the item id is the outbox id.
function assertChatSteerIpcPayload(payload, { log = null } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidSteerPayload('$', 'payload_not_object');
  if (Object.keys(payload).some((key) => !['sessionId', 'itemId', 'prompt', 'attachments'].includes(key))) {
    throw invalidSteerPayload('$.[unknown]', 'unknown_field');
  }
  if (typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) throw invalidSteerPayload('$.sessionId', 'identifier_empty');
  if (typeof payload.itemId !== 'string' || !STEER_ITEM_ID_PATTERN.test(payload.itemId)) throw invalidSteerPayload('$.itemId', 'identifier_invalid_grammar');
  const { sessionId, prompt, attachments } = assertChatStartIpcPayload(
    { sessionId: payload.sessionId, prompt: payload.prompt, attachments: payload.attachments ?? [] }, { log }
  );
  return { sessionId, itemId: payload.itemId, prompt, attachments };
}

function assertChatSteerWithdrawIpcPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidSteerPayload('$', 'payload_not_object');
  if (Object.keys(payload).some((key) => !['sessionId', 'itemId'].includes(key))) throw invalidSteerPayload('$.[unknown]', 'unknown_field');
  if (typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) throw invalidSteerPayload('$.sessionId', 'identifier_empty');
  if (typeof payload.itemId !== 'string' || !STEER_ITEM_ID_PATTERN.test(payload.itemId)) throw invalidSteerPayload('$.itemId', 'identifier_invalid_grammar');
  return { sessionId: payload.sessionId, itemId: payload.itemId };
}

// A refusal is an answer, never a rejected invoke: the renderer keeps the item queued for the next turn.
function offerChatSteer(backendService, payload, log) {
  let request;
  try {
    request = assertChatSteerIpcPayload(payload, { log });
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  return offerUserSteer(backendService, request);
}

function withdrawChatSteer(backendService, payload) {
  let request;
  try {
    request = assertChatSteerWithdrawIpcPayload(payload);
  } catch {
    return { ok: false, reason: 'unknown' };
  }
  return withdrawUserSteer(backendService, request);
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
    'chat.offerSteer': (_, payload) => offerChatSteer(backendService, payload, log),
    'chat.withdrawSteer': (_, payload) => withdrawChatSteer(backendService, payload),
    'chat.compactNow': (_, sessionId) => backendService.compactContextNow(sessionId),
    // Row 136: reads which chat goes first on the model; `set` and `clear` are the person's pick.
    'chat.firstSession': (_, request) => backendService.firstChatSession({
      action: ['set', 'clear'].includes(request?.action) ? request.action : 'get',
      sessionId: typeof request?.sessionId === 'string' ? request.sessionId.slice(0, 256) : '',
    }),
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
  assertChatSteerIpcPayload,
  assertChatSteerWithdrawIpcPayload,
  registerChatStreamIpcHandlers,
  registerChatSurfaceIpcHandlers,
  registerChatUserQuestionIpcHandlers,
};

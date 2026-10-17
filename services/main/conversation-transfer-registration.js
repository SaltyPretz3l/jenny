'use strict';

const { t } = require('../i18n-main');

const path = require('node:path');
const { ConversationTransferService } = require('../conversation-transfer-service');
const { ConversationTransferStore } = require('../conversation-transfer-store');
const { JennyConversationAdapter } = require('../jenny-conversation-adapter');
const { CodexConversationAdapter } = require('../codex-conversation-adapter');
const { safeResult, identity } = require('../conversation-transfer-contract');
const { ownedDirectory } = require('../conversation-transfer-assets');
const { isSessionBusy } = require('../backend/chat-stream-admission');
const { registerCloudModels } = require('./cloud-models-registration');
const { readRetiredChatgptPluginFacts } = require('./chatgpt-legacy-plugin-choice');
const { registerIpcInvokeHandlers } = require('../ipc-contract');

function registerConversationTransfer(ipcMain, { backendService, userDataPath, attachmentAssetStore,
  authorization = { authorize: () => false }, log = () => {}, openExternal, openAttachments, env = process.env, service: injectedService } = {}) {
  if (!backendService) return { dispose: async () => {} };
  // Desktop only: hosted entrypoints never compose this local profile adapter.
  let service = injectedService;
  const getService = () => {
    if (service) return service;
    const root = ownedDirectory(userDataPath, 'conversation-transfer');
    const receiptStore = new ConversationTransferStore(root);
    service = new ConversationTransferService({ receiptStore, log, adapters: {
      jenny: new JennyConversationAdapter({ sessionStore: backendService.sessionStore,
        shadowStore: backendService.shadowStore, transferAssetRoot: ownedDirectory(userDataPath, 'conversation-transfer-assets'), attachmentAssetStore: attachmentAssetStore || backendService.attachmentAssetStore,
        isBusy: (sessionId) => isSessionBusy(backendService, { sessionId, store: backendService.sessionStore }) }),
      codex: new CodexConversationAdapter({ env, receiptStore }),
    } });
    return service;
  };
  const invoke = (method) => async (_event, request) => {
    try {
      const result = await getService()[method](request);
      if (method === 'open' && result.destination === 'codex') {
        identity('codex', result.destinationId);
        const open = openExternal || require('electron').shell.openExternal;
        await open('codex://threads/' + result.destinationId);
      }
      if (method === 'attachments') {
        const base = result.destination === 'codex'
          ? path.join(getService().adapters.codex.codexHome, 'jenny-transfer-assets')
          : path.join(userDataPath, 'conversation-transfer-assets');
        const directory = ownedDirectory(base, result.operationId);
        const openFolder = openAttachments || require('electron').shell.openPath;
        const reason = await openFolder(directory);
        if (reason) return { ok: false, reason: 'open_failed', message: t('settings.transfer.folderFailed', "The copied attachments folder could not be opened.") };
      }
      return result;
    } catch (error) {
      const result = safeResult(error);
      log('WARN', 'conversation_transfer.request_failed', { method, reason: result.reason });
      return result;
    }
  };
  registerIpcInvokeHandlers(ipcMain, {
    'conversationTransfer.list': invoke('list'), 'conversationTransfer.preview': invoke('preview'),
    'conversationTransfer.copy': invoke('copy'), 'conversationTransfer.open': invoke('open'),
    'conversationTransfer.attachments': invoke('attachments'),
  }, authorization);
  return { dispose: async () => service?.dispose() };
}
function registerCloudModelsWithTransfer(ipcMain, options) {
  const { app, backendService, shellConfigService, sendBridgeEvent, processRef, authorization, log, getMainLifecycle } = options;
  const cloud = registerCloudModels(ipcMain, { backendService, shellConfigService, sendBridgeEvent,
    processRef, authorization, log, readLegacyPluginFacts: () => readRetiredChatgptPluginFacts({
      userDataDir: app.getPath('userData'), log,
    }) });
  const transfer = registerConversationTransfer(ipcMain, { ...options, userDataPath: app.getPath('userData'),
    env: processRef?.env || process.env });
  const lifecycle = getMainLifecycle?.();
  for (const controller of [cloud, transfer]) {
    if (typeof lifecycle?.registerShutdownTask === 'function') lifecycle.registerShutdownTask(controller.dispose);
    else app?.once?.('will-quit', controller.dispose);
  }
}
module.exports = { registerConversationTransfer, registerCloudModelsWithTransfer };

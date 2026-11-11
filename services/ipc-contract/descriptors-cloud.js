/**
 * Cloud models (ChatGPT sign-in), user API-key providers, settled-history
 * conversation transfer and the Codex CLI engine state.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  // cloudModels.*: Settings > Models "Cloud models" group (plugin platform
  // retirement, stage 2). Never carries token material.
  'cloudModels.getState': invokeMethod('cloud-models:get-state'),
  'cloudModels.setChatgptEnabled': invokeMethod('cloud-models:set-chatgpt-enabled'),
  'cloudModels.chatgptSignIn': invokeMethod('cloud-models:chatgpt-sign-in'),
  'cloudModels.chatgptCancel': invokeMethod('cloud-models:chatgpt-cancel'),
  'cloudModels.chatgptSignOut': invokeMethod('cloud-models:chatgpt-sign-out'),
  'cloudModels.chatgptCompletePasted': invokeMethod('cloud-models:chatgpt-complete-pasted'),
  'cloudModels.chatgptExtendPending': invokeMethod('cloud-models:chatgpt-extend-pending'),
  'cloudModels.chatgptPendingLink': invokeMethod('cloud-models:chatgpt-pending-link'),
  'cloudModels.onChanged': subscribeMethod('cloud-models:changed'),
  // apiProviders.*: Settings > Models user API-key providers (row 78). The key
  // goes in through the write-only setKey and never comes back out.
  'apiProviders.getState': invokeMethod('api-providers:get-state'),
  'apiProviders.addInstance': invokeMethod('api-providers:add-instance'),
  'apiProviders.removeInstance': invokeMethod('api-providers:remove-instance'),
  'apiProviders.renameInstance': invokeMethod('api-providers:rename-instance'),
  'apiProviders.setKey': invokeMethod('api-providers:set-key'),
  'apiProviders.clearKey': invokeMethod('api-providers:clear-key'),
  'apiProviders.discover': invokeMethod('api-providers:discover'),
  'apiProviders.setModelEnabled': invokeMethod('api-providers:set-model-enabled'),
  'apiProviders.setModelPin': invokeMethod('api-providers:set-model-pin'),
  'apiProviders.acknowledgeNotice': invokeMethod('api-providers:acknowledge-notice'),
  'apiProviders.onChanged': subscribeMethod('api-providers:changed'),
  // Desktop-only settled-history copy; main owns receipts and assets.
  'conversationTransfer.list': invokeMethod('conversation-transfer:list'),
  'conversationTransfer.preview': invokeMethod('conversation-transfer:preview'),
  'conversationTransfer.copy': invokeMethod('conversation-transfer:copy'),
  'conversationTransfer.open': invokeMethod('conversation-transfer:open'),
  'conversationTransfer.attachments': invokeMethod('conversation-transfer:attachments'),
  'codexCli.getState': invokeMethod('codex-cli:get-state'),
  'codexCli.refresh': invokeMethod('codex-cli:refresh'),
});

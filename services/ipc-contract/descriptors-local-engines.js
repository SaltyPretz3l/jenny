/**
 * Local engine control: Ollama daemon / tray remediation, the managed
 * llama-server and offline mode.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  // ollamaTray.* namespace: owner-triggered remediation for the Ollama
  // tray-app conflict (detection lives in ollama-tray-conflict.js). Explicit-
  // click actions only — never automatic.
  'ollamaDaemon.stopUserProcess': invokeMethod('ollama-daemon:stop-user-process'),
  'ollamaTray.status': invokeMethod('ollama-tray:status'),
  'ollamaTray.quitTrayApp': invokeMethod('ollama-tray:quit'),
  'ollamaTray.disableStartupShortcut': invokeMethod('ollama-tray:disable-startup'),
  'ollamaTray.restartEngine': invokeMethod('ollama-tray:restart-engine'),
  // llamaServer.* namespace: explicit control and local GGUF discovery for the
  // single managed llama-server process. The manager remains main-process-owned.
  'llamaServer.getStatus': invokeMethod('llama-server:status'),
  'llamaServer.start': invokeMethod('llama-server:start'),
  'llamaServer.stop': invokeMethod('llama-server:stop'),
  'llamaServer.restart': invokeMethod('llama-server:restart'),
  'llamaServer.listLocalGgufs': invokeMethod('llama-server:list-local-ggufs'),
  'llamaServer.chooseGguf': invokeMethod('llama-server:choose-gguf'),
  'llamaServer.chooseLibraryFolder': invokeMethod('llama-server:choose-library-folder'),
  'llamaServer.chooseRuntime': invokeMethod('llama-server:choose-runtime'),
  'llamaServer.planGgufImport': invokeMethod('llama-server:plan-gguf-import'),
  'llamaServer.importGguf': invokeMethod('llama-server:import-gguf'),
  'llamaServer.ggufImportStatus': invokeMethod('llama-server:gguf-import-status'),
  'llamaServer.cancelGgufImport': invokeMethod('llama-server:cancel-gguf-import'),
  // Row 140: a model's MTP drafter and vision projector, downloaded beside it
  // only on request (services/gguf-companion-download.js owns every path).
  'llamaServer.companionStatus': invokeMethod('llama-server:companion-status'),
  'llamaServer.installCompanion': invokeMethod('llama-server:install-companion'),
  'llamaServer.cancelCompanion': invokeMethod('llama-server:cancel-companion'),
  // Row 142: runtime folders and the build a model can run on
  // (services/main/llama-server-runtime-ipc-handlers.js).
  'llamaServer.chooseRuntimeFolder': invokeMethod('llama-server:choose-runtime-folder'),
  'llamaServer.runtimeOptions': invokeMethod('llama-server:runtime-options'),
  'llamaServer.useRuntimeBuild': invokeMethod('llama-server:use-runtime-build'),
  // Row 142 S3: Get a build (services/llama-server-runtime-download.js) and the
  // per-folder build counts for the runtime folders list.
  'llamaServer.runtimeDownloadStart': invokeMethod('llama-server:runtime-download-start'),
  'llamaServer.runtimeDownloadStatus': invokeMethod('llama-server:runtime-download-status'),
  'llamaServer.runtimeDownloadCancel': invokeMethod('llama-server:runtime-download-cancel'),
  'llamaServer.runtimeFolderSummary': invokeMethod('llama-server:runtime-folder-summary'),
  'offline.getState': invokeMethod('offline:get-state'),
  'offline.getDiagnostics': invokeMethod('offline:get-diagnostics'),
  'offline.updateSettings': invokeMethod('offline:update-settings'),
});

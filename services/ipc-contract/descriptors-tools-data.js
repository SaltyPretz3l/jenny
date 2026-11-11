/**
 * Tool approvals and permissions, templates, usage, window state and
 * control, data lifecycle and the ChatGPT plan-usage meter.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  'tools.list': invokeMethod('tools:list'),
  'tools.approve': invokeMethod('tools:approve'),
  'tools.buildAcceptedPlan': invokeMethod('tools:build-accepted-plan'),
  'tools.deny': invokeMethod('tools:deny'),
  'tools.getPermissions': invokeMethod('tools:get-permissions'),
  'tools.clearPermission': invokeMethod('tools:clear-permission'),
  'tools.removePermissionRule': invokeMethod('tools:remove-permission-rule'),
  'templates.list': invokeMethod('templates:list'),
  'templates.save': invokeMethod('templates:save'),
  'templates.delete': invokeMethod('templates:delete'),
  'templates.apply': invokeMethod('templates:apply'),
  'usage.getSnapshot': invokeMethod('usage:get-snapshot'),
  'usage.getStats': invokeMethod('usage:get-stats'),
  'usage.clearHistory': invokeMethod('usage:clear-history'),
  'window.getState': invokeMethod('window:get-state'),
  'window.onStateChanged': subscribeMethod('window:state-changed'),
  // UIUX-003 window-exit dirty guard: main→renderer one-shot request to run the
  // dirty-buffer preflight before a native close, and the renderer→main reply
  // carrying the user's decision (proceed).
  'window.onExitPreflightRequest': subscribeMethod('window:exit-preflight-request'),
  'window.respondExitPreflight': invokeMethod('window:exit-preflight-respond'),
  'dataLifecycle.getOverview': invokeMethod('data-lifecycle:get-overview'),
  'dataLifecycle.chooseArchiveDestination': invokeMethod('data-lifecycle:choose-archive-destination'),
  'dataLifecycle.createArchive': invokeMethod('data-lifecycle:create-archive'),
  'dataLifecycle.previewWorkspaceArchive': invokeMethod('data-lifecycle:preview-workspace-archive'),
  'dataLifecycle.findRestoreCandidates': invokeMethod('data-lifecycle:find-restore-candidates'),
  'dataLifecycle.stageRestore': invokeMethod('data-lifecycle:stage-restore'),
  'dataLifecycle.previewWorkspaceRestore': invokeMethod('data-lifecycle:preview-workspace-restore'),
  'dataLifecycle.restoreWorkspace': invokeMethod('data-lifecycle:restore-workspace'),
  'dataLifecycle.launchUninstallAssistant': invokeMethod('data-lifecycle:launch-uninstall-assistant'),
  'dataLifecycle.syncPortablePreferences': invokeMethod('data-lifecycle:sync-portable-preferences'),
  // Row 95 "Your data": category ids and a preview token only; main resolves every path.
  'dataLifecycle.getStorageUsage': invokeMethod('data-lifecycle:get-storage-usage'),
  'dataLifecycle.previewClear': invokeMethod('data-lifecycle:preview-clear'),
  'dataLifecycle.clearCategory': invokeMethod('data-lifecycle:clear-category'),
  'dataLifecycle.revealCategory': invokeMethod('data-lifecycle:reveal-category'),
  'dataLifecycle.onProgress': subscribeMethod('data-lifecycle:progress'),
  // chatgptPlanUsage.*: composer footer plan-usage ring for the ChatGPT
  // subscription provider (host-owned engine, not the plugin package).
  // getSnapshot is a pull for first paint; onSnapshot pushes on every store
  // change, auth status change, or backend engine-status change. A missing
  // backendService registers neither channel. See docs/plans "ChatGPT
  // plan-usage meter" W2 and services/main/chatgpt-plan-usage-ipc.js.
  'chatgptPlanUsage.getSnapshot': invokeMethod('chatgpt-plan-usage:get-snapshot'),
  'chatgptPlanUsage.onSnapshot': subscribeMethod('chatgpt-plan-usage:snapshot'),
  windowControl: invokeMethod('window:control'),
});

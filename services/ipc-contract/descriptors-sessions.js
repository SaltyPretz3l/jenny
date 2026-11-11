/**
 * Backend status, auth state, sessions, projects, permission review and the
 * session runtime (sessionRuntime.*).
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  'backend.getStatus': invokeMethod('backend:get-status'),
  'backend.retryStart': invokeMethod('backend:retry-start'),
  'backend.onStatus': subscribeMethod('backend:status'),
  'auth.getState': invokeMethod('auth:get-state'),
  'auth.updateLocalProfile': invokeMethod('auth:update-local-profile'),
  'auth.onState': subscribeMethod('auth:state'),
  'sessions.list': invokeMethod('sessions:list'),
  'sessions.create': invokeMethod('sessions:create'),
  'sessions.rename': invokeMethod('sessions:rename'),
  // Optional second argument: { onlyIfIdle: true, expectedUpdatedAt: string }.
  // Refuses busy/plugin-owned/changed sessions without cancelling work; omitted
  // options retain the existing single-chat cancellation/deletion behavior.
  'sessions.delete': invokeMethod('sessions:delete'),
  'sessions.getMessages': invokeMethod('sessions:get-messages'),
  'sessions.setPreferences': invokeMethod('sessions:set-preferences'),
  'sessions.setMeta': invokeMethod('sessions:set-meta'),
  'sessions.sweepEmpty': invokeMethod('sessions:sweep-empty'),
  'sessions.editAndTruncate': invokeMethod('sessions:edit-and-truncate'),
  'projects.list': invokeMethod('projects:list'),
  'projects.create': invokeMethod('projects:create'),
  'projects.delete': invokeMethod('projects:delete'),
  'projects.rename': invokeMethod('projects:rename'),
  'projects.bindRoot': invokeMethod('projects:bind-root'),
  'projects.assignSession': invokeMethod('projects:assign-session'),
  'projects.adoptWorkspace': invokeMethod('projects:adopt-workspace'),
  // Desktop only: { project_id, expected_root_revision }. Main opens the OS
  // folder picker and rebinds the same project; the renderer never sends a path.
  'projects.chooseRoot': invokeMethod('projects:choose-root'),
  'projects.revealFolder': invokeMethod('projects:reveal-folder'),
  'permissionReview.getState': invokeMethod('permission-review:get-state'),
  'permissionReview.resolve': invokeMethod('permission-review:resolve'),
  'sessionRuntime.getSnapshot': invokeMethod('session-runtime:get-snapshot'),
  'sessionRuntime.start': invokeMethod('session-runtime:start'),
  'sessionRuntime.submit': invokeMethod('session-runtime:submit'),
  'sessionRuntime.resume': invokeMethod('session-runtime:resume'),
  'sessionRuntime.pause': invokeMethod('session-runtime:pause'),
  'sessionRuntime.cancel': invokeMethod('session-runtime:cancel'),
  'sessionRuntime.updatePending': invokeMethod('session-runtime:update-pending'),
  'sessionRuntime.updateLimits': invokeMethod('session-runtime:update-limits'),
  'sessionRuntime.getResult': invokeMethod('session-runtime:get-result'),
  'sessionRuntime.getWork': invokeMethod('session-runtime:get-work'),
  'sessions.exportSession': invokeMethod('sessions:export'),
  // Row 94: invalidation `{session_ids, reason}` after an agent changed other chats; the renderer refetches the list.
  'sessions.onChanged': subscribeMethod('sessions:changed'),
  'sessions.forkSession': invokeMethod('sessions:fork'),
});

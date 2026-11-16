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
  // Row 150: project boards (services/main/board-ipc-registration.js). Ids and batches cross, never a
  // path or a whole document; every call resolves, { ok: false, reason: 'disabled' } with the flag off.
  'boards.list': invokeMethod('boards:list'),
  'boards.create': invokeMethod('boards:create'),
  'boards.get': invokeMethod('boards:get'),
  'boards.apply': invokeMethod('boards:apply'),
  'boards.undo': invokeMethod('boards:undo'),
  'boards.redo': invokeMethod('boards:redo'),
  'boards.rename': invokeMethod('boards:rename'),
  'boards.duplicate': invokeMethod('boards:duplicate'),
  'boards.delete': invokeMethod('boards:delete'),
  'boards.restore': invokeMethod('boards:restore'),
  // The link card's "Fetch title" button: one page title through the URL guard, { ok, title } or { ok: false, reason }.
  'boards.fetchLinkTitle': invokeMethod('boards:fetch-link-title'),
  // The cards selected on the Board page, so a turn sent from its docked chat shows them first: { boardId, ids }.
  'boards.setSelection': invokeMethod('boards:set-selection'),
  // Pictures and file cards (slice B7): picture bytes in and out by content hash; a file card's path is checked in
  // main against the board's own project folder, and only a relative path comes back.
  'boards.addAsset': invokeMethod('boards:add-asset'),
  'boards.readAsset': invokeMethod('boards:read-asset'),
  'boards.resolveFile': invokeMethod('boards:resolve-file'),
  'boards.openFile': invokeMethod('boards:open-file'),
  'boards.fileStatus': invokeMethod('boards:file-status'),
  // Jenny's proposed changes (slice C3): the proposals of a board without their operations, and one decision
  // ({ boardId, proposalId, action: accept_additions | accept | reject, n? }). The main process reads replies; the page never does.
  'boards.listProposals': invokeMethod('boards:list-proposals'),
  'boards.decideProposal': invokeMethod('boards:decide-proposal'),
  // A .jennyboard file (slice B10): main shows the dialog and does the IO; { boardId } / { projectId } go in, a base name comes back.
  'boards.exportFile': invokeMethod('boards:export-file'),
  'boards.importFile': invokeMethod('boards:import-file'),
  // Pin to board (slice C5): one chat item becomes one card; chatRefs names the boards that hold cards of one chat.
  'boards.pin': invokeMethod('boards:pin'),
  'boards.chatRefs': invokeMethod('boards:chat-refs'),
  // A board that loads read-only (slice B11): show its file in the file manager, or rename its files aside in the boards
  // folder and take it out of the list. { boardId } goes in; only the aside file's name comes back.
  'boards.revealFile': invokeMethod('boards:reveal-file'),
  'boards.setAside': invokeMethod('boards:set-aside'),
  'boards.onChanged': subscribeMethod('boards:changed'),
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

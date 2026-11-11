/**
 * The per-chat workspace: suggested changes, chat workspace summary, session
 * proposals, addressed chat messages and the primary Jenny chat.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  // suggestedChanges.*: Propose-mode suggestions (row 35). Electron owns the
  // record; accept applies through the sidecar journal. Trusted-sender
  // authorized in services/main/suggested-changes-ipc-registration.js.
  'suggestedChanges.list': invokeMethod('suggested-changes:list'),
  'suggestedChanges.decide': invokeMethod('suggested-changes:decide'),
  'suggestedChanges.comment': invokeMethod('suggested-changes:comment'),
  'suggestedChanges.sendComments': invokeMethod('suggested-changes:send-comments'),
  'suggestedChanges.discardPending': invokeMethod('suggested-changes:discard-pending'),
  'suggestedChanges.accept': invokeMethod('suggested-changes:accept'),
  'suggestedChanges.onChanged': subscribeMethod('suggested-changes:changed'),
  // chatWorkspace.*: per-chat session summary, rail view state and working-tree
  // Changes reads (row 59 checkpoint 2). Closed `{schema_version:1,...}` requests
  // answered with `{schema_version:1, ok, ...}`; trusted-sender authorized in
  // services/main/chat-workspace-ipc-registration.js. onChanged carries only
  // invalidations `{schema_version:1, session_id, revision}`, at most four a
  // second per session; the renderer refetches. Desktop only (no hosted route).
  'chatWorkspace.getSummary': invokeMethod('chat-workspace:get-summary'),
  'chatWorkspace.setView': invokeMethod('chat-workspace:set-view'),
  'chatWorkspace.listChanges': invokeMethod('chat-workspace:list-changes'),
  'chatWorkspace.getChangeDiff': invokeMethod('chat-workspace:get-change-diff'),
  'chatWorkspace.onChanged': subscribeMethod('chat-workspace:changed'),
  // changePictures.*: before and after pictures of the pages a change touched
  // (row 122). The request names a chat, a turn and that turn's change records;
  // the answer carries picture URLs and workspace-relative paths, never file
  // bytes, a workspace path or a git ref. Trusted-sender authorized in
  // services/main/change-pictures-ipc-registration.js. Desktop only.
  'changePictures.capture': invokeMethod('change-pictures:capture'),
  'changePictures.captureWorkingTree': invokeMethod('change-pictures:capture-working-tree'),
  'changePictures.list': invokeMethod('change-pictures:list'),
  // sessionProposals.*: inline Git / command proposals (row 59 checkpoint 3).
  // Closed `{schema_version:1, session_id, ...}` requests answered with
  // `{schema_version:1, ok, ...}`; trusted-sender authorized in
  // services/main/chat-proposal-ipc-registration.js. getCapabilities, setOptions,
  // startAll, confirmRestored and authorizeLaunch answer unsupported_capability
  // until checkpoint 5. onChanged carries only `{schema_version:1, session_id,
  // revision}` invalidations. Desktop only (no hosted route).
  'sessionProposals.get': invokeMethod('session-proposals:get'),
  'sessionProposals.list': invokeMethod('session-proposals:list'),
  'sessionProposals.decide': invokeMethod('session-proposals:decide'),
  'sessionProposals.cancel': invokeMethod('session-proposals:cancel'),
  'sessionProposals.retry': invokeMethod('session-proposals:retry'),
  'sessionProposals.getCapabilities': invokeMethod('session-proposals:get-capabilities'),
  'sessionProposals.setOptions': invokeMethod('session-proposals:set-options'),
  'sessionProposals.startAll': invokeMethod('session-proposals:start-all'),
  'sessionProposals.confirmRestored': invokeMethod('session-proposals:confirm-restored'),
  'sessionProposals.authorizeLaunch': invokeMethod('session-proposals:authorize-launch'),
  'sessionProposals.onChanged': subscribeMethod('session-proposals:changed'),
  // chatMessages.*: addressed session messaging (row 59 checkpoint 4). Closed
  // `{schema_version:1, ...}` requests answered with `{schema_version:1, ok, ...}`;
  // trusted-sender authorized in services/main/chat-messaging-ipc-registration.js.
  // confirmRestored, createGrant, revokeGrant and setReporting answer unsupported
  // until checkpoint 5. onChanged carries only `{schema_version:1, session_id,
  // revision}` invalidations. Desktop only (no hosted route).
  'chatMessages.listRecipients': invokeMethod('chat-messages:list-recipients'),
  'chatMessages.prepare': invokeMethod('chat-messages:prepare'),
  'chatMessages.send': invokeMethod('chat-messages:send'),
  'chatMessages.retry': invokeMethod('chat-messages:retry'),
  'chatMessages.cancel': invokeMethod('chat-messages:cancel'),
  'chatMessages.list': invokeMethod('chat-messages:list'),
  'chatMessages.markRead': invokeMethod('chat-messages:mark-read'),
  'chatMessages.setContextDisposition': invokeMethod('chat-messages:set-context-disposition'),
  'chatMessages.discard': invokeMethod('chat-messages:discard'),
  'chatMessages.confirmRestored': invokeMethod('chat-messages:confirm-restored'),
  'chatMessages.createGrant': invokeMethod('chat-messages:create-grant'),
  'chatMessages.revokeGrant': invokeMethod('chat-messages:revoke-grant'),
  'chatMessages.setReporting': invokeMethod('chat-messages:set-reporting'),
  'chatMessages.onChanged': subscribeMethod('chat-messages:changed'),
  // primaryChat.*: the Jenny chat's launch permission, activity log, Pause and
  // Reset / Forget controls (row 76). Closed `{schema_version:1, ...}` requests
  // answered with `{schema_version:1, ok, ...}` or `{ok:false, code, reason}`;
  // trusted-sender authorized in services/main/primary-chat-ipc-registration.js.
  // onChanged carries only an invalidation; the renderer refetches. Desktop only.
  'primaryChat.getState': invokeMethod('primary-chat:get-state'),
  'primaryChat.activity': invokeMethod('primary-chat:activity'),
  'primaryChat.permissions': invokeMethod('primary-chat:permissions'),
  'primaryChat.pause': invokeMethod('primary-chat:pause'),
  'primaryChat.resume': invokeMethod('primary-chat:resume'),
  'primaryChat.grantLaunch': invokeMethod('primary-chat:grant-launch'),
  'primaryChat.revokeLaunch': invokeMethod('primary-chat:revoke-launch'),
  'primaryChat.addRule': invokeMethod('primary-chat:add-rule'), // row 87 D6
  'primaryChat.revokeRule': invokeMethod('primary-chat:revoke-rule'),
  'primaryChat.reset': invokeMethod('primary-chat:reset'),
  'primaryChat.forgetPreview': invokeMethod('primary-chat:forget-preview'),
  'primaryChat.undoSettingChange': invokeMethod('primary-chat:undo-setting-change'), // row 88 D5
  'primaryChat.undoChatChange': invokeMethod('primary-chat:undo-chat-change'), // row 94 P1
  'primaryChat.getFullAuto': invokeMethod('primary-chat:get-full-auto'), // Full auto armed state
  'primaryChat.armFullAuto': invokeMethod('primary-chat:arm-full-auto'),
  'primaryChat.disarmFullAuto': invokeMethod('primary-chat:disarm-full-auto'),
  'primaryChat.onChanged': subscribeMethod('primary-chat:changed'),
});

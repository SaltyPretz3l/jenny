/**
 * The desktop team client (row 123, slices 1f-1 and 1f-2): joining a team, its connection
 * state and the owner and member commands the Settings Team page needs. Main
 * validates every payload and maps each method onto one host operation
 * (services/team/ipc-methods.js). No method hands out a key, a secret or an
 * address; only inviteReveal and deviceInvite answer with an invite string,
 * because the user must copy it.
 *
 * A team row's `device_fingerprint` is not a key: the host's ten-hex-character
 * fingerprint of this device's public key. The seed and the public key stay in
 * main.
 *
 * Slice 2a-4b adds team chat: nine methods mirroring one team.chat.* operation
 * each, draft get and set, discarding a failed outbox entry, and one push
 * channel (`team.onChat`) for channel counts, message records, the outbox and a
 * cleared team. No chat answer or push carries a request id, key, token or
 * address (services/team/chat-client.js).
 *
 * Slice 2a-4c adds chatSearch, chatTyping and presenceSet, and the `members`,
 * `presence` and `typing` pushes on `team.onChat`.
 *
 * Slice 5-3 adds the reconnect code: teamReconnectCode (a member pastes the code
 * its owner sent; it changes where that team is dialled, never who the host is)
 * and hostReconnectCode (the owner's code for the host this Jenny runs, the one
 * answer besides an invite that the user must copy).
 *
 * Slice 4e adds GPU sharing: shareStatus, shareSet, sharePause and shareStop (local to this
 * Jenny), gpuList, gpuUse and teamModelSet (one host operation each). Sharing state and the
 * team's GPU list ride the `team.onState` push; no answer carries a device id, key or token.
 *
 * Slice 5-6 adds the owner's whole-team operations: hostInventory, hostDelete, hostStartNew, hostOldDelete,
 * hostOldShow, hostExport { password }, hostExportCancel, hostRestorePick and hostRestore { password, ... }. A
 * password is never answered or logged; the export folder and the backup file are picked in main.
 *
 * Slice 3-9 adds shared projects: one method per host operation (services/team/ipc-methods.js PROJECT_OPERATIONS),
 * and one push channel (`team.onProject`) for the project list, an open conversation's rebuilt events, viewers,
 * the lease and transfer progress. No answer or push carries a device id, client id, key, token or host path; an
 * upload or download folder is picked in main.
 *
 * Slice 3-10 adds the "Always allowed" rules: projectRules, projectRuleAdd, projectRuleRemove and projectRuleAnswer
 * (team.project.rules.*); conversationDecide may carry `always`; `team.onProject` gains the kinds `rules_changed`,
 * `rule_requests` and `rule_answered`. conversationCloseAll { team_id } closes every conversation main holds open for
 * the team (the renderer sends it once when its project store is built, after a reload).
 *
 * Slice 2c renderer adds chat attachments: chatUpload (bytes of at most 4 MiB), chatUploadCancel, chatAttachPick
 * (the file dialog opens in main), chatAttachmentImage (a picture as a data: URL, images only), chatAttachmentText (a text file as UTF-8 text, or its first
 * lines with peek), chatAttachmentCopy,
 * chatAttachmentSave (the save dialog opens in main) and chatAttachmentReveal; chatPost may carry attachment_ids.
 *
 * Slice 6-5 adds model sharing: the `model…` methods (services/team/model-ipc.js) and one push channel
 * (`team.onModel`: `state`, `progress`, `received`). No answer or push carries a path, except a root's display path in
 * modelOfferRead's roots; only modelOfferRead and modelProvenance carry hashes and licence text.
 *
 * Row 151 T3 adds team boards: the `board…` methods (services/team/board-ipc.js) and one push channel
 * (`team.onBoard`: `applied`, `refused`, `reloaded`, `gone`, `list_changed`). A board answer carries the board
 * document and no path.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  'team.join': invokeMethod('team:join'),
  'team.status': invokeMethod('team:status'),
  'team.leave': invokeMethod('team:leave'),
  'team.removeTeam': invokeMethod('team:remove-team'),
  'team.members': invokeMethod('team:members'),
  'team.inviteCreate': invokeMethod('team:invite-create'),
  'team.inviteReveal': invokeMethod('team:invite-reveal'),
  'team.inviteRevoke': invokeMethod('team:invite-revoke'),
  'team.inviteList': invokeMethod('team:invite-list'),
  'team.deviceInvite': invokeMethod('team:device-invite'),
  'team.deviceList': invokeMethod('team:device-list'),
  'team.deviceRevoke': invokeMethod('team:device-revoke'),
  'team.memberAdmit': invokeMethod('team:member-admit'),
  'team.memberSetRole': invokeMethod('team:member-set-role'),
  'team.memberRevoke': invokeMethod('team:member-revoke'),
  'team.ownerTransfer': invokeMethod('team:owner-transfer'),
  'team.auditRead': invokeMethod('team:audit-read'),
  'team.rename': invokeMethod('team:rename'),
  'team.profileSet': invokeMethod('team:profile-set'),
  'team.onState': subscribeMethod('team:state'),
  // Slice 1f-2: the team host this Jenny runs. Its state never carries a key, an invite or an address.
  'team.hostDeploy': invokeMethod('team:host-deploy'),
  'team.hostStop': invokeMethod('team:host-stop'),
  'team.hostStatus': invokeMethod('team:host-status'),
  'team.hostRecover': invokeMethod('team:host-recover'),
  'team.onHostState': subscribeMethod('team:host-state'),
  // Slice 2a-4b: team chat in the main process (services/team/chat-client.js).
  'team.chatOverview': invokeMethod('team:chat-overview'),
  'team.chatHistory': invokeMethod('team:chat-history'),
  'team.chatThread': invokeMethod('team:chat-thread'),
  'team.chatPost': invokeMethod('team:chat-post'),
  'team.chatEdit': invokeMethod('team:chat-edit'),
  'team.chatDelete': invokeMethod('team:chat-delete'),
  'team.chatMarkRead': invokeMethod('team:chat-mark-read'),
  'team.chatSetNotify': invokeMethod('team:chat-set-notify'),
  'team.chatFollow': invokeMethod('team:chat-follow'),
  'team.chatDraftGet': invokeMethod('team:chat-draft-get'),
  'team.chatDraftSet': invokeMethod('team:chat-draft-set'),
  'team.chatOutboxDiscard': invokeMethod('team:chat-outbox-discard'),
  // Slice 2a-4c: search, typing and presence.
  'team.chatSearch': invokeMethod('team:chat-search'),
  'team.chatTyping': invokeMethod('team:chat-typing'),
  'team.presenceSet': invokeMethod('team:presence-set'),
  // Reactions, pins, edit history and pinned messages (services/team/chat-marks.js).
  'team.chatReact': invokeMethod('team:chat-react'),
  'team.chatPin': invokeMethod('team:chat-pin'),
  'team.chatEdits': invokeMethod('team:chat-edits'),
  'team.chatPins': invokeMethod('team:chat-pins'),
  // Slice 2d: open a direct conversation (services/team/chat-dm.js).
  'team.chatDmOpen': invokeMethod('team:chat-dm-open'),
  // Row 173: create, rename or set the topic of, archive and delete a custom channel (services/team/chat-channels.js).
  'team.chatChannelCreate': invokeMethod('team:chat-channel-create'),
  'team.chatChannelUpdate': invokeMethod('team:chat-channel-update'),
  'team.chatChannelArchive': invokeMethod('team:chat-channel-archive'),
  'team.chatChannelDelete': invokeMethod('team:chat-channel-delete'),
  // Slice 2c renderer: chat attachments (services/team/chat-attachments.js). Bytes cross at most 4 MiB a file; the
  // file and save dialogs open in main; no answer carries a path.
  'team.chatUpload': invokeMethod('team:chat-upload'),
  'team.chatUploadCancel': invokeMethod('team:chat-upload-cancel'),
  'team.chatAttachPick': invokeMethod('team:chat-attach-pick'),
  'team.chatAttachmentImage': invokeMethod('team:chat-attachment-image'),
  'team.chatAttachmentText': invokeMethod('team:chat-attachment-text'),
  'team.chatAttachmentCopy': invokeMethod('team:chat-attachment-copy'),
  'team.chatAttachmentSave': invokeMethod('team:chat-attachment-save'),
  'team.chatAttachmentReveal': invokeMethod('team:chat-attachment-reveal'),
  'team.onChat': subscribeMethod('team:chat'),
  // Slice 5-3: the reconnect code (services/team/reconnect-code.js).
  'team.teamReconnectCode': invokeMethod('team:team-reconnect-code'),
  'team.hostReconnectCode': invokeMethod('team:host-reconnect-code'),
  // Slice 5-5b: the owner's internet joining setting (services/team/host/host-controller.js).
  'team.hostInternet': invokeMethod('team:host-internet'),
  // Slice 6-7: the owner's model relay setting for this Jenny's own host (services/team/host/host-model-relay.js).
  'team.hostModelRelay': invokeMethod('team:host-model-relay'),
  // Row 123: the owner's project files setting for this Jenny's own host (services/team/host/host-file-tools.js).
  'team.hostFileTools': invokeMethod('team:host-file-tools'),
  // Row 201 (OD-5): the owner's cap on the pool's context length (services/team/host/host-pool-context.js).
  'team.hostPoolContext': invokeMethod('team:host-pool-context'),
  // Slice 4e: sharing this PC's GPU (services/team/node/team-sharing.js) and the team's GPUs (pool-view.js).
  'team.shareStatus': invokeMethod('team:share-status'),
  'team.shareSet': invokeMethod('team:share-set'),
  'team.sharePause': invokeMethod('team:share-pause'),
  'team.shareStop': invokeMethod('team:share-stop'),
  // Row 201 (OD-4): the Ollama models this PC shares (services/team/node/team-sharing.js setOllamaModels / ollamaModels).
  'team.shareOllamaModels': invokeMethod('team:share-ollama-models'),
  'team.gpuList': invokeMethod('team:gpu-list'),
  'team.gpuUse': invokeMethod('team:gpu-use'),
  'team.teamModelSet': invokeMethod('team:team-model-set'),
  // Slice 5-6: delete, start a new team, old teams, export and restore (services/team/host/host-lifecycle.js).
  'team.hostInventory': invokeMethod('team:host-inventory'),
  'team.hostDelete': invokeMethod('team:host-delete'),
  'team.hostStartNew': invokeMethod('team:host-start-new'),
  'team.hostOldDelete': invokeMethod('team:host-old-delete'),
  'team.hostOldShow': invokeMethod('team:host-old-show'),
  'team.hostExport': invokeMethod('team:host-export'),
  'team.hostExportCancel': invokeMethod('team:host-export-cancel'),
  'team.hostRestorePick': invokeMethod('team:host-restore-pick'),
  'team.hostRestore': invokeMethod('team:host-restore'),
  // Row 170: the server page (services/team/host/host-lifecycle.js, host-autostart.js).
  'team.hostAutostart': invokeMethod('team:host-autostart'),
  'team.hostSummary': invokeMethod('team:host-summary'),
  'team.hostOpenFolder': invokeMethod('team:host-open-folder'),
  // Slice 3-9: shared projects, their conversations and file transfers (services/team/team-projects.js).
  'team.projectList': invokeMethod('team:project-list'),
  'team.projectCreate': invokeMethod('team:project-create'),
  'team.projectRename': invokeMethod('team:project-rename'),
  'team.projectDelete': invokeMethod('team:project-delete'),
  'team.projectMembers': invokeMethod('team:project-members'),
  'team.projectAddMember': invokeMethod('team:project-add-member'),
  'team.projectSetMember': invokeMethod('team:project-set-member'),
  'team.projectRemoveMember': invokeMethod('team:project-remove-member'),
  'team.projectLeave': invokeMethod('team:project-leave'),
  'team.projectUnjoined': invokeMethod('team:project-unjoined'),
  'team.projectJoin': invokeMethod('team:project-join'),
  'team.projectAudit': invokeMethod('team:project-audit'),
  'team.projectConversations': invokeMethod('team:project-conversations'),
  'team.conversationCreate': invokeMethod('team:conversation-create'),
  'team.conversationOpen': invokeMethod('team:conversation-open'),
  'team.conversationClose': invokeMethod('team:conversation-close'),
  'team.conversationCloseAll': invokeMethod('team:conversation-close-all'),
  'team.conversationSend': invokeMethod('team:conversation-send'),
  'team.conversationCancel': invokeMethod('team:conversation-cancel'),
  'team.conversationRename': invokeMethod('team:conversation-rename'),
  'team.conversationDelete': invokeMethod('team:conversation-delete'),
  'team.conversationControl': invokeMethod('team:conversation-control'),
  'team.conversationDecide': invokeMethod('team:conversation-decide'),
  'team.conversationAnswer': invokeMethod('team:conversation-answer'),
  'team.conversationDecline': invokeMethod('team:conversation-decline'),
  // Row 172: the conversation's model, thinking effort and tool switches (host op sessions.preferences, leased); row 175
  // item 7: and Plan mode (`plan_mode`). conversationDecide may carry `plan_decision` and `feedback` (row 175, D14).
  'team.conversationPreferences': invokeMethod('team:conversation-preferences'),
  'team.uploadFolder': invokeMethod('team:upload-folder'),
  'team.uploadCancel': invokeMethod('team:upload-cancel'),
  'team.downloadProject': invokeMethod('team:download-project'),
  'team.downloadCancel': invokeMethod('team:download-cancel'),
  // Row 175 wave 5: the reader view of a team project's files (host ops team.project.files.list / .read).
  'team.projectFiles': invokeMethod('team:project-files'),
  'team.projectFileRead': invokeMethod('team:project-file-read'),
  // Row 175 item 6, F13, F18: regenerate, edit and resend, branch, ask a teammate, hand the driver seat (team.project.*).
  'team.projectRegenerate': invokeMethod('team:project-regenerate'),
  'team.projectEditResend': invokeMethod('team:project-edit-resend'),
  'team.projectBranch': invokeMethod('team:project-branch'),
  'team.projectAskTeammate': invokeMethod('team:project-ask-teammate'),
  'team.projectHandDriver': invokeMethod('team:project-hand-driver'),
  // Row 175 F6: the conversation box's unsent text, kept on this PC (services/team/project-drafts.js).
  'team.projectDraftGet': invokeMethod('team:project-draft-get'),
  'team.projectDraftSet': invokeMethod('team:project-draft-set'),
  // Slice 3-10: "Always allowed" (team.project.rules.*).
  'team.projectRules': invokeMethod('team:project-rules'),
  'team.projectRuleAdd': invokeMethod('team:project-rule-add'),
  'team.projectRuleRemove': invokeMethod('team:project-rule-remove'),
  'team.projectRuleAnswer': invokeMethod('team:project-rule-answer'),
  'team.onProject': subscribeMethod('team:project'),
  // Slice 6-5: model sharing (services/team/team-models.js). A model is named by its discovery tag, a root by its index.
  'team.modelState': invokeMethod('team:model-state'),
  'team.modelSendable': invokeMethod('team:model-sendable'),
  'team.modelFiles': invokeMethod('team:model-files'),
  'team.modelReceivers': invokeMethod('team:model-receivers'),
  'team.modelOffer': invokeMethod('team:model-offer'),
  'team.modelWithdraw': invokeMethod('team:model-withdraw'),
  'team.modelSendPause': invokeMethod('team:model-send-pause'),
  'team.modelSendResume': invokeMethod('team:model-send-resume'),
  'team.modelSendStop': invokeMethod('team:model-send-stop'),
  'team.modelOfferRead': invokeMethod('team:model-offer-read'),
  'team.modelAccept': invokeMethod('team:model-accept'),
  'team.modelDecline': invokeMethod('team:model-decline'),
  'team.modelReceivePause': invokeMethod('team:model-receive-pause'),
  'team.modelReceiveResume': invokeMethod('team:model-receive-resume'),
  'team.modelReceiveCancel': invokeMethod('team:model-receive-cancel'),
  'team.modelReceiveRetry': invokeMethod('team:model-receive-retry'),
  'team.modelSetRate': invokeMethod('team:model-set-rate'),
  'team.modelProvenance': invokeMethod('team:model-provenance'),
  'team.onModel': subscribeMethod('team:model'),
  // Row 151 T3: team boards (services/team/team-board-clients.js). A board is named by its team, project and board ids.
  'team.boardList': invokeMethod('team:board-list'),
  'team.boardTrash': invokeMethod('team:board-trash'),
  'team.boardCreate': invokeMethod('team:board-create'),
  'team.boardRename': invokeMethod('team:board-rename'),
  'team.boardDelete': invokeMethod('team:board-delete'),
  'team.boardRestore': invokeMethod('team:board-restore'),
  'team.boardOpen': invokeMethod('team:board-open'),
  'team.boardApply': invokeMethod('team:board-apply'),
  'team.boardClose': invokeMethod('team:board-close'),
  // Row 151 T4 and T5: the pointer and the note lock of an open board, Jenny's proposals, the revert of one batch.
  'team.boardCursor': invokeMethod('team:board-cursor'),
  'team.boardLock': invokeMethod('team:board-lock'),
  'team.boardUnlock': invokeMethod('team:board-unlock'),
  'team.boardProposals': invokeMethod('team:board-proposals'),
  'team.boardProposalAccept': invokeMethod('team:board-proposal-accept'),
  'team.boardProposalReject': invokeMethod('team:board-proposal-reject'),
  'team.boardRevert': invokeMethod('team:board-revert'),
  'team.boardHistory': invokeMethod('team:board-history'),
  // Row 151 T6, member side: a board's pictures, through the host's picture routes.
  'team.boardAssetAdd': invokeMethod('team:board-asset-add'),
  'team.boardAssetRead': invokeMethod('team:board-asset-read'),
  // Row 151 T7: a board copied into a team project whole, through the host's import route.
  'team.boardImport': invokeMethod('team:board-import'),
  'team.onBoard': subscribeMethod('team:board'),
});

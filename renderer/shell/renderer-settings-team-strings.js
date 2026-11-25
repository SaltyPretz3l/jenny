/* Settings > Team words (row 123, slice 1g-1). Every reason and code the team
 * IPC can answer gets one plain sentence here; anything else is the generic
 * sentence with the code, never a raw reason alone. Also the plain words for a
 * team's connection state, roles, the host's state and the activity log, and model sharing's words (`modelWords`). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsTeamStrings = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const CODE_PATTERN = /^(CMP-[A-Z]+-\d{4}|invalid_request)$/;

  // reason -> sentence. Grouped by who answers: the host, main, or the server this PC runs.
  const countOf = (error) => (error && Number.isSafeInteger(error.count) ? error.count : 0);
  const REASONS = {
    team_name_invalid: () => jt('settings.team.reason.nameInvalid', 'Use 1 to 40 characters with no hidden characters.'),
    team_display_name_invalid: () => jt('settings.team.reason.nameInvalid', 'Use 1 to 40 characters with no hidden characters.'),
    team_display_name_taken: () => jt('settings.team.reason.nameTaken', 'That name is already taken in this team. Try another.'),
    team_label_invalid: () => jt('settings.team.reason.nameInvalid', 'Use 1 to 40 characters with no hidden characters.'),
    team_role_invalid: () => jt('settings.team.reason.roleInvalid', 'Pick Member or Read-only.'),
    team_invite_malformed: () => jt('settings.team.reason.inviteMalformed', 'That invite code is not valid. Check that you pasted all of it.'),
    team_public_key_invalid: () => jt('settings.team.reason.keyInvalid', 'The team server refused this device’s key. Ask the owner for a new invite.'),
    team_invite_ttl_invalid: () => jt('settings.team.reason.ttlInvalid', 'Pick an expiry between 1 hour and 7 days.'),
    team_cursor_invalid: () => jt('settings.team.reason.cursorInvalid', 'The activity list changed. Open it again.'),
    member_pending: () => jt('settings.team.reason.memberPending', 'The owner has not let you in yet.'),
    member_revoked: () => jt('settings.team.reason.memberRevoked', 'You no longer have access to this team.'),
    device_revoked: () => jt('settings.team.reason.memberRevoked', 'You no longer have access to this team.'),
    role_forbidden: () => jt('settings.team.reason.roleForbidden', 'Only the owner can do that.'),
    team_not_found: () => jt('settings.team.reason.notFound', 'That team or person is no longer there. The list is updated.'),
    invite_not_valid: () => jt('settings.team.reason.inviteNotValid', 'That invite was used, revoked or has expired. Ask for a new one.'),
    team_hello_required: () => jt('settings.team.reason.reconnect', 'The connection was renewed. Try again.'),
    team_client_too_old: () => jt('settings.team.reason.clientTooOld', 'Update Jenny to connect to this team.'),
    team_server_too_old: () => jt('settings.team.reason.serverTooOld', 'The team server runs an older Jenny. The owner needs to update it.'),
    team_member_state_invalid: () => jt('settings.team.reason.stateChanged', 'That person’s state changed meanwhile. The list is updated.'),
    team_last_owner: () => jt('settings.team.reason.lastOwner', 'A team always has an owner. Make someone else the owner first.'),
    team_owner_transfer_required: () => jt('settings.team.reason.lastOwner', 'A team always has an owner. Make someone else the owner first.'),
    team_host_key_mismatch: () => jt('settings.team.reason.keyMismatch', 'The server’s key does not match this team. Nothing was changed.'),
    node_agent_running: () => jt('settings.team.reason.shareOtherTeam', 'This PC already shares its GPU with another team. Turn that off first.'),
    team_unavailable: () => jt('settings.team.reason.unavailable', 'The team server is not answering. Try again in a moment.'),
    team_transport_down: () => jt('settings.team.reason.transportDown', 'The server lost its network connection.'),
    team_transport_missing: () => jt('settings.team.reason.transportMissing', 'This Jenny is missing its team connection helper, so the server cannot start. Reinstall or update Jenny.'),
    team_key_timeout: () => jt('settings.team.reason.keyTimeout', 'The server did not get its key in time. Start it again.'),
    team_store_failed: () => jt('settings.team.reason.storeFailed', 'The team server could not save the change. Nothing was changed.'),
    team_store_schema_unsupported: () => jt('settings.team.reason.storeNewer', 'The team’s files were written by a newer Jenny. Update Jenny.'),
    team_member_limit: () => jt('settings.team.reason.memberLimit', 'The team is full: eight people, you included.'),
    team_device_limit: () => jt('settings.team.reason.deviceLimit', 'That person already has three devices. Remove one first.'),
    team_invite_limit: () => jt('settings.team.reason.inviteLimit', 'There are eight unused invites. Revoke one first.'),
    team_rate_limit: () => jt('settings.team.reason.rateLimit', 'Too many changes in a minute. Wait a moment and try again.'),
    team_request_invalid: () => jt('settings.team.reason.requestInvalid', 'Jenny could not send that request. Check the fields and try again.'),
    team_join_in_progress: () => jt('settings.team.reason.joinBusy', 'Another join is still running. Wait for it to finish.'),
    team_already_joined: () => jt('settings.team.reason.alreadyJoined', 'This Jenny is already in that team.'),
    team_limit_reached: () => jt('settings.team.reason.teamLimit', 'Jenny can be in four teams at once. Leave one first.'),
    team_disposed: () => jt('settings.team.reason.closing', 'Jenny is closing. Try again after it restarts.'),
    team_host_shutting_down: () => jt('settings.team.reason.closing', 'Jenny is closing. Try again after it restarts.'),
    team_change_unconfirmed: () => jt('settings.team.reason.unconfirmed', 'The server did not confirm the change. Check the list and try again if needed.'),
    team_connection_stopped: () => jt('settings.team.reason.connectionStopped', 'The connection to that team was closed.'),
    team_device_key_unavailable: () => jt('settings.team.reason.storage', 'Jenny cannot use this PC’s secure storage right now.'),
    team_host_key_unavailable: () => jt('settings.team.reason.storage', 'Jenny cannot use this PC’s secure storage right now.'),
    team_device_key_invalid: () => jt('settings.team.reason.deviceKey', 'This device’s key for the team is missing or damaged.'),
    team_device_key_missing: () => jt('settings.team.reason.deviceKey', 'This device’s key for the team is missing or damaged.'),
    team_host_key_invalid: () => jt('settings.team.reason.hostKey', 'The team server’s saved key is damaged.'),
    team_host_key_missing: () => jt('settings.team.reason.hostKeyMissing', 'This PC’s key for this team is missing, so the team cannot be started here. Nothing was changed.'),
    team_host_key_set_aside: () => jt('settings.team.reason.hostKeySetAside', 'This PC’s key for this team is missing because Jenny’s saved credentials file was damaged. Jenny kept the damaged file in its data folder, with a name starting secure-state.json.corrupt. Nothing was changed.'),
    team_public_address_invalid: () => jt('settings.team.reason.publicAddress', 'That public address is not valid. Enter an IP address or a host name, with a port after a colon if it needs one.'),
    team_relay_url_invalid: () => jt('settings.team.reason.relayUrl', 'That relay address is not valid. Enter https:// and the relay’s host name, with an optional port and nothing after it.'),
    team_relay_token_invalid: () => jt('settings.team.reason.relayToken', 'That relay token is not valid. Check that you copied all of it, and enter the relay address with it.'),
    team_host_platform_unavailable: () => jt('settings.team.reason.platform', 'This PC cannot host a team yet.'),
    team_host_exit_unconfirmed: () => jt('settings.team.reason.exitUnconfirmed', 'The old server has not finished closing. Start is available once it has.'),
    team_host_busy: () => jt('settings.team.reason.hostBusy', 'The server is already starting or stopping. Wait a moment.'),
    team_host_port_busy: () => jt('settings.team.reason.portBusy', 'The server’s network port is still in use, so it was not started again. Your new setting is saved. Wait a moment, then start the server.'),
    team_host_config_write_failed: () => jt('settings.team.reason.configWrite', 'Jenny could not write the server’s settings on this PC.'),
    team_host_stopped: () => jt('settings.team.reason.hostStopped', 'The server was stopped before it finished starting.'),
    team_host_not_deployed: () => jt('settings.team.reason.notDeployed', 'This PC has not hosted a team yet.'),
    team_file_tools_windows_unreviewed: () => jt('settings.team.reason.fileToolsWindows', 'Project files are not on Windows yet. They wait for a safety review of how Jenny reaches files on Windows.'),
    team_pool_context_invalid: () => jt('settings.team.reason.poolContextInvalid', 'Use a whole number from 2,048 to 1,048,576 tokens, or leave the field empty for Auto.'),
    team_sharing_invalid: () => jt('settings.team.reason.sharingInvalid', 'Jenny could not save the models to share. Check the list and try again.'),
    team_host_turn_running: () => jt('settings.team.reason.turnRunning', 'A turn is running in a team project. Try again when it finishes.'),
    team_host_start_timeout: () => jt('settings.team.reason.startTimeout', 'The server did not start in time.'),
    team_host_exited: () => jt('settings.team.reason.exited', 'The server stopped unexpectedly.'),
    team_host_stopped_itself: () => jt('settings.team.reason.exited', 'The server stopped unexpectedly.'),
    team_host_stop_timeout: () => jt('settings.team.reason.stopTimeout', 'The server took too long to stop and was ended.'),
    team_host_spawn_failed: () => jt('settings.team.reason.spawn', 'Jenny could not start the server process.'),
    team_owner_recover_needed: () => jt('settings.team.reason.recoverNeeded', 'The server runs, but this Jenny is not signed in to its team. Reclaim ownership below.'),
    team_owner_invite_missing: () => jt('settings.team.reason.ownerInviteMissing', 'The server started but did not sign you in. Stop it and start it again.'),
    team_owner_join_unavailable: () => jt('settings.team.reason.ownerInviteMissing', 'The server started but did not sign you in. Stop it and start it again.'),
    team_recover_local_save_failed: () => jt('settings.team.reason.recoverSave', 'The server accepted you, but this PC could not save it. Run Reclaim ownership again.'),
    // Slice 5-6: joining over the internet, the reconnect code, delete, start a new team, export and restore.
    team_invite_too_new: () => jt('settings.team.reason.inviteTooNew', 'This invite was made by a newer Jenny. Update Jenny, then paste it again.'),
    relay_denied: () => jt('settings.team.reason.relayTurnedAway', 'The owner’s relay turned this PC away. Ask the owner to check the relay’s access token, then restart Jenny. Jenny still tries to connect directly.'),
    relay_unreachable: () => jt('settings.team.reason.relayUnreachable', 'Jenny cannot reach the owner’s relay. The owner’s PC or the relay may be off.'),
    host_name_unresolved: () => jt('settings.team.reason.nameNotFound', 'Jenny cannot find the owner’s address name. It may come back by itself. If it does not, ask the owner for a reconnect code.'),
    team_reconnect_code_malformed: () => jt('settings.team.reason.codeMalformed', 'That reconnect code is not valid. Check that you pasted all of it.'),
    team_reconnect_code_other_team: (error) => jt('settings.team.member.otherTeam', 'That code is for a different team. Ask the owner of {team} for theirs.', { team: teamName(error && error.team ? error.team : null) }),
    team_relay_token_unavailable: () => jt('settings.team.reason.relayTokenStore', 'Jenny cannot read the relay token from this PC’s secure storage right now.'),
    team_host_addresses_unavailable: () => jt('settings.team.reason.noAddresses', 'The server has no address to put in a code yet. Wait a moment and try again.'),
    team_internet_invalid: () => jt('settings.team.reason.internetInvalid', 'The server’s saved internet setting cannot be read. Turn internet joining off and on again.'),
    team_owner_only: () => jt('settings.team.reason.ownerOnly', 'Only the team’s owner can do that. If ownership was handed over, reclaim it first.'),
    team_delete_name_mismatch: () => jt('settings.team.reason.nameMismatch', 'The name you typed is not the team’s name. Nothing was changed.'),
    team_delete_file_held: () => jt('settings.team.reason.fileHeld', 'Not everything could be deleted: a file is open in another program. Nothing else was removed. Close the file, then try again.'),
    team_delete_link: () => jt('settings.team.reason.deleteLink', 'A folder in the team’s files points somewhere else on this PC, so nothing was deleted. Remove that link, then try again.'),
    team_set_aside_failed: () => jt('settings.team.reason.setAside', 'Jenny could not set the old team’s files aside. Nothing was changed.'),
    team_host_key_present: () => jt('settings.team.reason.keyPresent', 'This PC still has the team’s key. Start the team instead.'),
    team_host_key_exists: () => jt('settings.team.reason.keyPresent', 'This PC still has the team’s key. Start the team instead.'),
    team_host_exists: () => jt('settings.team.reason.hostExists', 'This PC already hosts a team. Delete it first, or restore on another PC.'),
    team_old_not_found: () => jt('settings.team.reason.oldGone', 'That old team is no longer on this PC. The list is updated.'),
    team_open_failed: () => jt('settings.team.reason.openFailed', 'Jenny could not open that folder.'),
    team_backup_password_wrong: () => jt('settings.team.reason.backupPassword', 'That password does not open this backup. Nothing was changed.'),
    team_backup_password_short: () => jt('settings.team.reason.backupShort', 'Use at least 10 characters for the backup’s password.'),
    team_backup_too_new: () => jt('settings.team.reason.backupNewer', 'This backup was made by a newer Jenny. Update Jenny, then restore it.'),
    team_backup_unreadable: () => jt('settings.team.reason.backupUnreadable', 'Jenny could not read that file. Nothing was changed.'),
    team_backup_unavailable: () => jt('settings.team.reason.backupUnreadable', 'Jenny could not read that file. Nothing was changed.'),
    team_backup_too_large: () => jt('settings.team.reason.backupLarge', 'This backup is larger than Jenny can restore. Nothing was changed.'),
    team_backup_source_changed: () => jt('settings.team.reason.sourceChanged', 'A file changed while it was being exported. Try again.'),
    team_backup_write_failed: () => jt('settings.team.reason.exportWrite', 'Jenny could not write to that folder. Nothing was saved there.'),
    team_export_write_failed: () => jt('settings.team.reason.exportWrite', 'Jenny could not write to that folder. Nothing was saved there.'),
    team_export_unreadable: () => jt('settings.team.reason.exportRead', 'Jenny could not read the team’s files to export them.'),
    team_export_folder_invalid: () => jt('settings.team.reason.exportFolder', 'Pick a folder outside Jenny’s own data folder.'),
    team_restore_no_file: () => jt('settings.team.reason.restoreNoFile', 'Choose the backup file first.'),
    team_restore_failed: () => jt('settings.team.reason.restoreFailed', 'The team could not be restored. Nothing was changed.'),
    // Owner decision E81 (2026-11-14): a settings file or a member list that does not read says what to do.
    team_host_config_unreadable: () => jt('settings.team.reason.configUnreadable', 'This team’s settings file is damaged or was made by a newer Jenny. Update Jenny, or delete the team and restore it from a backup.'),
    team_members_unreadable: () => jt('settings.team.reason.membersUnreadable', 'This team’s member list is damaged. Delete the team, then restore it from a backup.'),
    // Review of 5-6: a `team-host` that points elsewhere, a full drive, a team the export cannot read whole.
    team_host_link: () => jt('settings.team.reason.hostLink', 'The team’s folder in Jenny’s data folder points somewhere else on this PC, so nothing was changed. Remove that link, then try again.'),
    team_disk_full: () => jt('settings.team.reason.diskFull', 'There is not enough free space on that drive. Nothing was saved. Free some space, then try again.'),
    team_export_links: (error) => jtn('settings.team.reason.exportLinks', countOf(error), {}, '{count} item in the team’s files points somewhere else on this PC, so nothing was exported. Remove that link, then export again.', '{count} items in the team’s files point somewhere else on this PC, so nothing was exported. Remove those links, then export again.'),
    team_export_unreadable_files: (error) => jtn('settings.team.reason.exportUnreadable', countOf(error), {}, '{count} file of the team could not be read, so nothing was exported. Close any program using the team’s files, then export again.', '{count} files of the team could not be read, so nothing was exported. Close any program using the team’s files, then export again.'),
    team_export_too_many: (error) => jtn('settings.team.reason.exportTooMany', countOf(error), {}, 'The team holds more than {count} file, more than Jenny can export. Nothing was exported.', 'The team holds more than {count} files, more than Jenny can export. Nothing was exported.'),
    // A saved team whose file does not load (also a chat write on a store that is not writable): what is wrong
    // only; a Needs repair row adds the advice (repairText).
    team_client_schema_unsupported: () => jt('settings.team.reason.clientNewer', 'This team was saved by a newer Jenny. Update Jenny to use it, or remove it from this PC.'),
    team_client_invalid: () => jt('settings.team.reason.clientInvalid', 'The saved file for this team cannot be read.'),
    team_client_missing: () => jt('settings.team.reason.clientMissing', 'The saved file for this team is missing.'),
    // Team chat (TEAM_CHAT_SPEC, 2a-4b and 2a-4c as built), said in the Team tab.
    team_chat_rate_limit: () => jt('settings.team.reason.chatRateLimit', 'The team server is busy. Jenny will send this again shortly.'),
    disk_pressure: () => jt('settings.team.reason.diskPressure', 'The team server is low on disk space. Jenny will send this again once there is room.'),
    team_chat_not_found: () => jt('settings.team.code.chatNotFound', 'That conversation is not available.'),
    team_not_connected: () => jt('settings.team.reason.notConnected', 'This Jenny is not connected to the team right now.'),
    team_chat_answer_invalid: () => jt('settings.team.reason.chatAnswerInvalid', 'The team server sent an answer Jenny could not read. Try again.'),
    team_answer_invalid: () => REASONS.team_chat_answer_invalid(),
    team_chat_open_failed: () => jt('settings.team.reason.chatOpenFailed', 'Jenny could not open this channel. Try again.'),
    // Shared projects and their conversations (slice 3-9, TEAM_PROJECTS_SPEC "3-9 as built").
    control_lease_unavailable: () => jt('settings.team.reason.leaseUnavailable', 'Someone else is driving this conversation. Wait for them to finish, or take over.'),
    control_turn_active: () => jt('settings.team.reason.turnActive', 'Another person’s turn is still running. You can take over when it ends.'),
    control_lease_required: () => jt('settings.team.reason.leaseRequired', 'You are no longer driving this conversation. Send again to drive it.'),
    revision_conflict: () => jt('settings.team.reason.revisionConflict', 'This conversation changed meanwhile. Try again.'),
    approval_not_viewing: () => jt('settings.team.reason.notViewing', 'Only someone who can write in this project and is viewing this conversation can answer.'),
    approval_prompter_unknown: () => jt('settings.team.reason.prompterUnknown', 'Nobody is known to have asked for this approval, so it cannot be answered here.'),
    decision_stale: () => jt('settings.team.reason.decisionStale', 'That approval or question was already answered or has ended.'),
    team_project_busy: () => jt('settings.team.reason.projectBusy', 'This project cannot be deleted while a turn is running or an approval is waiting in it. Try again when they have finished.'),
    team_project_read_only: () => jt('settings.team.reason.projectReadOnly', 'You can read this project. Only its writers and admins can send.'),
    team_project_files_unavailable: () => jt('settings.team.reason.projectFilesUnavailable', 'This team’s host cannot share project files yet. Conversations and the channel work.'),
    team_project_deleting: () => jt('settings.team.reason.projectDeleting', 'This project is being deleted. Nothing in it can change; the delete finishes when the team’s host next starts.'),
    team_project_last_admin: () => jt('settings.team.reason.projectLastAdmin', 'A project always has an admin. Make someone else an admin first.'),
    team_project_limit: () => jt('settings.team.reason.projectLimit', 'This team has as many projects as it can hold. Delete one first.'),
    team_project_exists: () => jt('settings.team.reason.projectExists', 'That project already exists. The list is updated.'),
    team_project_name_invalid: () => jt('settings.team.reason.projectNameInvalid', 'Use 1 to 80 characters with no hidden characters.'),
    team_project_member_exists: () => jt('settings.team.reason.projectMemberExists', 'That person is already in this project.'),
    team_project_role_capped: () => jt('settings.team.reason.projectRoleCapped', 'That person is read-only in the team, so they can only be a reader here.'),
    team_project_role_invalid: () => jt('settings.team.reason.projectRoleInvalid', 'Pick Admin, Writer or Reader.'),
    project_not_found: () => jt('settings.team.reason.projectNotFound', 'That project is no longer there. The list is updated.'),
    session_not_found: () => jt('settings.team.reason.conversationNotFound', 'That conversation is no longer there. The list is updated.'),
    team_conversation_not_open: () => jt('settings.team.reason.conversationNotOpen', 'Open the conversation first.'),
    team_conversation_open: () => jt('settings.team.reason.conversationOpen', 'That conversation is already open.'),
    team_conversation_limit: () => jt('settings.team.reason.conversationLimit', 'Up to 8 shared conversations can be open at once. Close one first.'),
    team_envelope_invalid: () => REASONS.team_request_invalid(),
    approval_unattended: () => jt('settings.team.reason.approvalUnattended', 'An approval is waiting, and nobody who can answer it is viewing the conversation.'),
    backend_unavailable: () => jt('settings.team.reason.backendUnavailable', 'The team’s host cannot do that right now. Try again in a moment.'),
    control_generation_required: () => REASONS.control_lease_required(),
    // Project file transfers (slice 3-9 commit 3).
    team_transfer_busy: () => jt('settings.team.reason.transferBusy', 'Another upload or download for this team is still running. Wait for it to finish, or cancel it.'),
    team_upload_empty: () => jt('settings.team.reason.uploadEmpty', 'That folder has no files to upload.'),
    team_upload_changed: () => jt('settings.team.reason.uploadChanged', 'A file in the folder changed while it was being uploaded, so the upload stopped. Try again.'),
    team_upload_file_limit: () => jt('settings.team.reason.uploadFileLimit', 'One upload can be at most 2,000 files: upload it in parts.'),
    team_upload_size_limit: () => jt('settings.team.reason.uploadSizeLimit', 'One upload can be at most 512 MB, and one file 64 MB: upload it in parts, or leave out large files.'),
    team_upload_manifest_invalid: () => jt('settings.team.reason.uploadNameClash', 'Two files in that folder would get the same name on the team’s host. Rename one and try again.'),
    team_project_path_invalid: () => jt('settings.team.reason.projectPathInvalid', 'A file or folder name cannot be used on the team’s host. Rename it and try again.'),
    team_upload_unreadable: () => jt('settings.team.reason.uploadUnreadable', 'Jenny could not read that folder.'),
    team_download_changed: () => jt('settings.team.reason.downloadChanged', 'A file on the team’s host changed during the download, so it stopped. Try again.'),
    team_download_folder_not_empty: () => jt('settings.team.reason.downloadNotEmpty', 'Pick an empty folder to download into.'),
    team_download_folder_invalid: () => jt('settings.team.reason.downloadFolderInvalid', 'That is not a folder Jenny can download into. Pick an empty folder.'),
    team_download_write_failed: () => jt('settings.team.reason.downloadWriteFailed', 'Jenny could not save a file in that folder. Nothing partly saved was kept.'),
    team_download_file_too_large: () => jt('settings.team.reason.downloadTooLarge', 'A file is larger than 64 MB, so it was not downloaded. The other files were.'),
    team_project_drafts_unavailable: () => jt('settings.team.reason.projectDraftsUnavailable', 'Jenny could not keep this draft on this PC. The text stays in the box until you send it.'),
    // Row 175 round 2b: conversation actions and plan decisions.
    team_turn_not_latest: () => jt('settings.team.reason.turnNotLatest', 'A newer question was asked since. Only the latest question can be redone.'),
    team_redo_forbidden: () => jt('settings.team.reason.redoForbidden', 'Only the member who asked can do this (a project admin can also regenerate).'),
    session_active: () => jt('settings.team.reason.sessionActive', 'Jenny is still working in this conversation. Try again when the turn ends.'),
    runtime_unavailable: () => jt('settings.team.reason.runtimeUnavailable', 'The team’s host cannot start a turn right now. Try again later.'),
    runtime_submission_refused: () => jt('settings.team.reason.runtimeRefused', 'The team’s host could not start that turn. Try again.'),
    operation_indeterminate: () => jt('settings.team.reason.operationIndeterminate', 'The team’s host may or may not have done that. Reload the conversation to see.'),
    team_branch_refused: () => jt('settings.team.reason.branchRefused', 'The team’s host could not branch from that message.'),
    session_capacity: () => jt('settings.team.reason.sessionCapacity', 'The team’s host holds as many conversations as it can. Delete one first.'),
    team_member_unavailable: () => jt('settings.team.reason.memberUnavailable', 'That member is not in this project any more.'),
    team_hand_refused: () => jt('settings.team.reason.handRefused', 'That member is no longer viewing this conversation or cannot write in it.'),
    plan_decision_invalid: () => jt('settings.team.reason.planDecisionInvalid', 'That plan is no longer waiting for a decision.'),
    team_redo_attachments: () => jt('settings.team.reason.redoAttachments', 'A question with attachments cannot be redone here. Branch from it instead.'),
    application_turn_retry_refused: () => jt('settings.team.reason.turnRetryRefused', 'That turn cannot be redone now. Reload the conversation and try again.'),
    handoff_preparation_retry_refused: () => jt('settings.team.reason.handoffRetryRefused', 'That turn cannot be redone while a hand-off is being prepared.'),
    // Slice 6-7: model sharing (services/team/model-reasons.js, every word; a refusal and a transfer row's reason).
    team_model_sharing_off: () => jt('settings.team.reason.modelSharingOff', 'Model sharing is off, so nothing was sent or received.'),
    team_model_host_too_old: () => jt('settings.team.reason.modelHostTooOld', 'The team’s host runs an older Jenny that cannot share models. The owner needs to update it.'),
    model_not_listed: () => jt('settings.team.reason.modelNotListed', 'Jenny no longer finds that model in your model folders. Refresh the Library and try again.'),
    model_ollama_copy: () => jt('settings.models.share.ollama', 'Only GGUF files in your model folders can be sent. This one is Ollama’s copy.'),
    model_file_not_offered: () => jt('settings.team.reason.modelFileNotOffered', 'That file does not sit beside this model, so it cannot be sent with it.'),
    model_manifest_invalid: () => jt('settings.team.reason.modelManifestInvalid', 'The offer changed since you opened it. Open it again.'),
    model_provenance_too_large: () => jt('settings.team.reason.modelProvenanceTooLarge', 'The licence, address and note are too long together. Shorten them and try again.'),
    model_audience_invalid: () => jt('settings.team.reason.modelAudienceInvalid', 'That person cannot receive models. Pick someone else.'),
    model_read_failed: () => jt('settings.team.reason.modelReadFailed', 'Jenny could not read the model file. Check that it is still there, then offer it again.'),
    model_source_changed: () => jt('settings.models.share.changed', 'This file changed while it was being sent, so sending stopped. Offer it again to send the new file.'),
    model_root_invalid: () => jt('settings.team.reason.modelRootInvalid', 'That folder changed since you opened the offer. Open it again and pick a folder.'),
    model_not_receiving: () => jt('settings.team.reason.modelNotReceiving', 'Nothing is being received for that offer.'),
    model_destination_invalid: () => jt('settings.team.reason.modelDestinationInvalid', 'Jenny cannot save a model in that folder. Pick another one.'),
    model_exists: () => jt('settings.team.reason.modelExists', 'A file with the same name is already in that folder. Jenny never overwrites a model.'),
    model_no_space: () => jt('settings.team.reason.modelNoSpace', 'There is not enough free space in that folder. Free some space, then try again.'),
    model_hash_mismatch: () => jt('settings.team.reason.modelHashMismatch', 'The model did not arrive exactly as it was sent, so nothing was kept.'),
    model_not_gguf: () => jt('settings.team.reason.modelNotGguf', 'This is not a model file Jenny can use, so it was not added.'),
    model_staging_failed: () => jt('settings.team.reason.modelStagingFailed', 'Jenny could not write to that folder. Check the folder, then try again.'),
    model_journal_invalid: () => jt('settings.team.reason.modelJournalInvalid', 'Jenny lost track of this download. Cancel it, then accept the offer again.'),
    model_transfer_interrupted: () => jt('settings.team.reason.modelInterrupted', 'The download was interrupted. What has arrived is kept; resume to carry on.'),
    model_receiver_busy: () => jt('settings.team.reason.modelReceiverBusy', 'Jenny is already receiving a model from this team. Wait for it to finish.'),
    model_receiver_disposed: () => jt('settings.team.reason.closing', 'Jenny is closing. Try again after it restarts.'),
    team_model_manifest_invalid: () => jt('settings.team.reason.modelHostManifest', 'The team’s host refused the offer’s file list. Offer the model again.'),
    team_model_name_invalid: () => jt('settings.team.reason.modelNameInvalid', 'Use a name of 1 to 128 characters with no hidden characters.'),
    team_model_request_invalid: () => jt('settings.team.reason.modelRequestInvalid', 'The team’s host refused that request. Try again.'),
    client_required: () => jt('settings.team.reason.modelClientRequired', 'Update Jenny to share models with this team.'),
    team_model_transfer_stale: () => jt('settings.team.reason.modelTransferStale', 'That transfer changed meanwhile. The list is updated.'),
    team_model_offer_taken: () => jt('settings.team.reason.modelOfferTaken', 'That offer was already taken.'),
    team_model_request_reused: () => jt('settings.team.reason.modelRequestReused', 'That offer is already being sent. The list is updated.'),
    team_model_sender_offline: () => jt('settings.team.reason.modelSenderOffline', 'The sender’s Jenny is not answering. Try again when they are back.'),
    host_unavailable: () => jt('settings.team.reason.unavailable', 'The team server is not answering. Try again in a moment.'),
    team_model_size_limit: () => jt('settings.team.reason.modelSizeLimit', 'This model is larger than the team’s host allows.'),
    team_model_offer_limit: () => jt('settings.team.reason.modelOfferLimit', 'You can have 16 offers open at most. Withdraw one first.'),
    team_model_relay_busy: () => jt('settings.team.reason.modelRelayBusy', 'The team is moving as many models as it can. Try again in a moment.'),
    client_unauthorized: () => jt('settings.team.reason.modelUnauthorized', 'The team’s host did not accept this device. Check that you are still a member.'),
    invalid_command_parameters: () => jt('settings.team.reason.modelRequestInvalid', 'The team’s host refused that request. Try again.'),
    invalid_command_envelope: () => jt('settings.team.reason.modelRequestInvalid', 'The team’s host refused that request. Try again.'),
    unsupported_operation: () => jt('settings.team.reason.modelUnsupported', 'The team’s host runs an older Jenny that cannot do that. The owner needs to update it.'),
    paused_by_sender: () => jt('settings.team.reason.modelPausedBySender', 'The sender paused it.'),
    paused_by_receiver: () => jt('settings.team.reason.modelPausedByReceiver', 'The receiver paused it.'),
    sender_offline: () => jt('settings.team.reason.modelSenderAway', 'The sender’s Jenny is not answering.'),
    idle: () => jt('settings.team.reason.modelIdle', 'The other Jenny is not answering.'),
    cancelled_by_sender: () => jt('settings.team.reason.modelSenderStopped', 'The sender stopped it.'),
    cancelled_by_receiver: () => jt('settings.team.reason.modelReceiverStopped', 'The receiver stopped it.'),
    withdrawn: () => jt('settings.team.reason.modelWithdrawn', 'The sender took the offer back.'),
    declined: () => jt('settings.team.reason.modelDeclined', 'They said no to the offer.'),
    expired: () => jt('settings.team.reason.modelExpired', 'Nobody answered the offer within 24 hours, so it ended.'),
    member_gone: () => jt('settings.team.reason.modelMemberGone', 'That person is no longer in the team.'),
    role_changed: () => jt('settings.team.reason.modelRoleChanged', 'That person’s role changed, so the transfer stopped.'),
    sharing_off: () => jt('settings.team.reason.modelHostSharingOff', 'The team’s host turned model sharing off, so this stopped.'),
    host_stopping: () => jt('settings.team.reason.modelHostStopping', 'The team’s host is stopping, so this stopped.'),
    fulfilled: () => jt('settings.team.reason.modelFulfilled', 'It arrived and was checked.'),
    // Slice 2c renderer: main's own refusals for a picture, a copy and Show in folder.
    team_attachment_not_image: () => jt('settings.team.reason.attachmentNotImage', 'That file is not a picture Jenny can show.'),
    team_attachment_not_text: () => jt('settings.team.reason.attachmentNotText', 'That file is not text Jenny can show.'),
    team_attachment_too_large_for_peek: () => jt('settings.team.reason.attachmentTooLargeForPeek', 'That file is too large for a quick look. Open it to read it.'),
    team_attachment_copy_failed: () => jt('settings.team.reason.attachmentCopyFailed', 'Jenny could not copy that picture.'),
    team_attachment_not_saved: () => jt('settings.team.reason.attachmentNotSaved', 'That file is no longer where Jenny saved it.'),
    team_upload_stale: () => jt('settings.team.reason.uploadStale', 'The upload got out of step with the team’s host. Start it again.'),
    team_upload_limit: () => jt('settings.team.reason.uploadLimit', 'The team’s host is busy with your other transfers. Try again in a moment.'),
    team_project_quota: () => jt('settings.team.reason.projectQuota', 'This project can hold at most 2 GB and 10,000 files. Delete some files first.'),
    team_upload_hash_mismatch: () => jt('settings.team.reason.uploadHashMismatch', 'A file arrived different from what was sent, so the upload stopped. Try again.'),
    team_upload_staging_failed: () => jt('settings.team.reason.uploadStagingFailed', 'The team’s host could not store the upload. Try again later.'),
    team_upload_target_exists: () => jt('settings.team.reason.uploadTargetExists', 'This project already has a folder with that name. Rename your folder and try again.'),
    team_transfer_failed: () => jt('settings.team.reason.transferFailed', 'The transfer stopped unexpectedly. Try again.'),
    team_project_root_unavailable: () => jt('settings.team.reason.projectRootUnavailable', 'The team’s host cannot reach this project’s files right now.'),
    // Slice 3-10: "Always allowed" (team.project.rules.*, approval.resolve's always), said on the project page or the card.
    team_rules_unavailable: () => jt('settings.team.reason.rulesUnavailable', 'The team’s host cannot read this project’s rules right now, so every change asks a person.'),
    team_rules_full: () => jt('settings.team.reason.rulesFull', 'The team’s host cannot keep more rules. Remove some first.'),
    team_rules_invalid: () => jt('settings.team.reason.rulesInvalid', 'The team’s host could not save that rule. Try again.'),
    team_rule_limit: () => jt('settings.team.reason.ruleLimit', 'This project already has 32 rules, the most it can have. Remove one first.'),
    team_rule_exists: () => jt('settings.team.reason.ruleExists', 'That rule is already in force.'),
    team_rule_request_limit: () => jt('settings.team.reason.ruleRequestLimit', 'Allowed once. This project already has 16 requests waiting for its admins, so no new one was sent.'),
    team_rule_request_not_found: () => jt('settings.team.reason.ruleRequestGone', 'That request is no longer waiting.'),
    team_rule_not_found: () => jt('settings.team.reason.ruleGone', 'That rule was already removed.'),
    team_rule_folder_invalid: () => jt('settings.team.reason.ruleFolderInvalid', 'Use a folder inside the project, like posts/drafts, with no hidden folder or “..”.'),
    team_rule_reason_invalid: () => jt('settings.team.reason.ruleReasonInvalid', 'Write a reason of 1 to 200 characters.'),
    team_rule_answer_invalid: () => jt('settings.team.reason.ruleAnswerInvalid', 'Pick the tool and where it applies.'),
    team_rule_always_invalid: () => jt('settings.team.reason.ruleAlwaysInvalid', 'Always allow goes with an allow, never with a deny.'),
    team_rule_tool_invalid: () => jt('settings.team.reason.ruleToolInvalid', 'Only edit_file and write_file can be always allowed.'),
    team_rule_no_project: () => jt('settings.team.reason.ruleNoProject', 'This conversation is not in a shared project, so it has no rules.'),
    team_audit_unavailable: () => jt('settings.team.reason.auditUnavailable', 'The team’s host cannot write its activity log right now, so nothing was changed.'),
    // Team chat writes (slice 2a-5b): said in the composer's hint, the edit box or a row's foot.
    team_chat_stale: () => jt('settings.team.reason.chatStale', 'Someone changed this message first.'),
    team_chat_request_too_large: () => jt('settings.team.reason.chatTooLarge', 'This message is too long to send. Shorten it and try again.'),
    team_chat_draft_limit: () => jt('settings.team.reason.chatDraftLimit', 'Jenny cannot keep more drafts. This text stays here but is not saved as a draft.'),
    team_chat_outbox_full: () => jt('settings.team.reason.chatOutboxFull', 'Too many messages are waiting to send. Wait for them, or delete ones that failed.'),
    team_chat_outbox_expired: () => jt('settings.team.reason.chatOutboxExpired', 'This waited too long to send. Send it again.'),
    team_chat_archived: () => jt('settings.team.reason.chatArchived', 'This channel is archived.'),
    // Slice 2b-2: the host's three refusals of a reaction or a pin, in plain words (they were the generic sentence).
    team_chat_reaction_limit: () => jt('team.react.limitRefused', 'This message already has 20 different reactions, the most it can have.'),
    team_chat_pin_limit: () => jt('team.pin.limitRefused', 'This channel already has 50 pinned messages, the most it can have. Unpin one first.'),
    team_chat_emoji_invalid: () => jt('team.react.emojiInvalid', 'This team does not accept that reaction.'),
    // A direct conversation the host refused to open (slice 2d): said in the New message view.
    team_chat_dm_members_invalid: () => jt('team.dm.membersInvalid', 'Someone you picked is no longer on the team. Pick again.'),
    team_force_local: () => forceLocalText(),
  };

  const CODES = {
    'CMP-TEAM-0001': () => jt('settings.team.code.connection', 'The team server could not be reached.'),
    'CMP-TEAM-0002': () => jt('settings.team.code.version', 'This Jenny and the team server run versions that do not fit. Update the older one.'),
    'CMP-TEAM-0003': () => jt('settings.team.reason.inviteMalformed', 'That invite code is not valid. Check that you pasted all of it.'),
    'CMP-TEAM-0004': () => jt('settings.team.reason.storage', 'Jenny cannot use this PC’s secure storage right now.'),
    'CMP-TEAM-0005': () => jt('settings.team.reason.connectionStopped', 'The connection to that team was closed.'),
    'CMP-TEAM-0006': () => jt('settings.team.code.host', 'The team server on this PC could not be started.'),
    'CMP-TEAM-0007': () => jt('settings.team.code.chatRetry', 'The team server is busy. Jenny will send this again shortly.'),
    'CMP-TEAM-0008': () => jt('settings.team.code.chatNotFound', 'That conversation is not available.'),
    'CMP-TEAM-0009': () => jt('settings.team.code.chatRefused', 'The team server refused this change.'),
    'CMP-TEAM-0010': () => jt('team.engine.unavailable', 'That team model cannot be used right now.'),
    'CMP-TEAM-0011': () => jt('settings.team.code.model', 'Jenny could not send or receive that model.'),
  };

  // E64, the owner's state line: Force local is on, so Team is off on this PC. Also every `team_force_local` refusal.
  function forceLocalText() {
    return jt('settings.team.forceLocal.state', 'Team is off while Force local is on. Nothing is sent to or from this PC.');
  }

  function errorText(error) {
    const reason = error && typeof error.reason === 'string' ? error.reason : '';
    const code = error && typeof error.code === 'string' && CODE_PATTERN.test(error.code) ? error.code : '';
    if (Object.hasOwn(REASONS, reason)) return REASONS[reason](error);
    if (Object.hasOwn(CODES, code)) return CODES[code]();
    return jt('settings.team.error.generic', 'Something went wrong ({code}).', { code: code || jt('settings.team.error.noCode', 'unknown') });
  }

  // A refused reaction or pin (slice 2b-2): three reasons are said per action, as nothing is sent again later.
  // Every other reason, and every other action, keeps `errorText`.
  function markErrorText(error, kind) {
    const reason = error && typeof error.reason === 'string' ? error.reason : '';
    if (reason === 'role_forbidden') return kind === 'pin' ? jt('team.pin.readOnly', 'Read-only members cannot pin.') : jt('team.react.readOnly', 'Read-only members cannot react.');
    if (reason === 'team_chat_rate_limit') return jt('team.mark.busy', 'The team server is busy. Try again in a moment.');
    if (reason === 'disk_pressure') return jt('team.mark.disk', 'The team server is low on disk space, so nothing can be added right now.');
    return errorText(error);
  }

  // Slice 2c renderer: a refused upload, said on its waiting file's second line. Six reasons are worded for an upload
  // only (the owner's approved table); every other action keeps `errorText`. `uploadRetry` says whether Retry is shown.
  const UPLOAD_OFFLINE = new Set(['team_not_connected', 'team_connection_reset', 'team_connection_stopped', 'team_unavailable',
    'team_request_timeout', 'team_request_aborted', '']);
  const UPLOAD_RETRY = new Set(['team_upload_limit', 'team_chat_storage_limit', 'disk_pressure']);
  function uploadOffline(error) {
    const reason = error && typeof error.reason === 'string' ? error.reason : '';
    return UPLOAD_OFFLINE.has(reason) || (error && error.code === 'CMP-TEAM-0001' && !Object.hasOwn(REASONS, reason));
  }
  function uploadErrorText(error) {
    const reason = error && typeof error.reason === 'string' ? error.reason : '';
    if (reason === 'attachment_size_limit') return jt('team.attach.tooLarge', 'Too large: files can be up to 4 MB.');
    if (reason === 'attachment_empty') return jt('team.attach.empty', 'Empty: this file has nothing in it, or it is a folder.');
    if (reason === 'team_upload_limit') return jt('team.attach.uploadLimit', 'Not uploaded. You have 16 files waiting to be sent, the most there can be. Send or remove some first.');
    if (reason === 'team_chat_storage_limit') return jt('team.attach.storageFull', 'Not uploaded. The team’s chat storage is full. Ask the owner to make room.');
    if (reason === 'disk_pressure') return jt('team.attach.diskPressure', 'Not uploaded. The team server is low on disk space, so nothing can be added right now.');
    if (reason === 'display_name_invalid') return jt('team.attach.nameRefused', 'Not uploaded. Jenny cannot send a file with this name. Rename it and try again.');
    if (uploadOffline(error)) return jt('team.attach.offline', 'Not uploaded. This Jenny is not connected to the team right now.');
    return errorText(error);
  }
  function uploadRetry(error) {
    return uploadOffline(error) || UPLOAD_RETRY.has(error && typeof error.reason === 'string' ? error.reason : '');
  }

  function connectionText(state) {
    switch (state) {
      case 'connecting': return jt('settings.team.connection.connecting', 'connecting');
      case 'online': return jt('settings.team.connection.online', 'connected');
      case 'reconnecting': return jt('settings.team.connection.reconnecting', 'reconnecting');
      case 'offline': return jt('settings.team.connection.offline', 'offline');
      case 'pending': return jt('settings.team.connection.pending', 'waiting for the owner to let you in');
      case 'revoked': return jt('settings.team.connection.revoked', 'you no longer have access');
      case 'update_required': return jt('settings.team.connection.update', 'update Jenny to connect');
      case 'needs_repair': return jt('settings.team.connection.needsRepair', 'Needs repair');
      case 'deleted': return jt('settings.team.connection.deleted', 'deleted by its owner');
      case 'force_local': return forceLocalText();
      default: return jt('settings.team.connection.unknown', 'unavailable');
    }
  }

  // The removed team's row: the state and the way back (the invite field sits below the joined list).
  function revokedText() {
    return jt('settings.team.joined.revoked', 'You no longer have access. To come back, ask the owner for a new invite and paste it below.');
  }

  function roleText(role) {
    if (role === 'owner') return jt('settings.team.role.owner', 'Owner');
    if (role === 'member') return jt('settings.team.role.member', 'Member');
    if (role === 'read_only') return jt('settings.team.role.readOnly', 'Read-only');
    return jt('settings.team.connection.unknown', 'unavailable');
  }

  // A device fingerprint (ten hex characters) as the joiner sees it: groups of four, upper case.
  function formatFingerprint(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{4,64}$/i.test(value)) return '';
    return value.toUpperCase().match(/.{1,4}/g).join(' ');
  }

  // The joiner's own device key while they wait to be let in; '' when it is unknown or they are in.
  function ownKeyText(team) {
    const waiting = Boolean(team) && (team.member_state === 'pending' || team.state === 'pending');
    const key = waiting ? formatFingerprint(team.device_fingerprint) : '';
    return key ? jt('settings.team.joined.ownKey', 'Your key: {key}. The owner sees the same characters before letting you in.', { key }) : '';
  }

  // One formatter per locale and options (a language or 12/24-hour change makes a new one).
  const timeFormats = new Map();
  function timeFormat() {
    const tag = globalThis.jennyI18n?.tag?.();
    const options = { dateStyle: 'medium', timeStyle: 'short', ...globalThis.jennyI18n?.timeOptions?.() };
    const key = String(tag || '') + '|' + JSON.stringify(options);
    let format = timeFormats.get(key);
    if (!format) {
      format = new Intl.DateTimeFormat(tag, options);
      timeFormats.set(key, format);
    }
    return format;
  }

  function formatTime(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    try {
      return timeFormat().format(new Date(ms));
    } catch (_error) {
      return new Date(ms).toISOString();
    }
  }

  function deviceCount(n) {
    return jtn('settings.team.people.devices', n, {}, '{count} device', '{count} devices');
  }

  // One audit entry in plain words; `nameOf(member_id)` answers a name, "You" or ''.
  function activityText(entry, nameOf) {
    const someone = jt('settings.team.activity.someone', 'Someone');
    const actor = nameOf(entry.actor_member_id) || someone;
    const subject = entry.name || nameOf(entry.subject_member_id) || someone;
    const params = { actor, subject };
    switch (entry.kind) {
      case 'invite_created': return jt('settings.team.activity.inviteCreated', '{actor} created an invite', params);
      case 'invite_redeemed': return jt('settings.team.activity.inviteRedeemed', '{subject} used an invite', params);
      case 'invite_revoked': return jt('settings.team.activity.inviteRevoked', '{actor} revoked an invite', params);
      case 'member_admitted': return jt('settings.team.activity.memberAdmitted', '{actor} let {subject} in', params);
      case 'role_changed': return jt('settings.team.activity.roleChanged', '{actor} changed {subject}’s role', params);
      case 'member_revoked': return jt('settings.team.activity.memberRevoked', '{actor} removed {subject}', params);
      case 'member_left': return jt('settings.team.activity.memberLeft', '{subject} left the team', params);
      case 'device_added': return jt('settings.team.activity.deviceAdded', '{subject} added a device', params);
      case 'device_revoked': return jt('settings.team.activity.deviceRevoked', '{actor} removed a device of {subject}', params);
      case 'owner_transferred': return jt('settings.team.activity.ownerTransferred', '{actor} made {subject} the owner', params);
      case 'recovery_used': return jt('settings.team.activity.recoveryUsed', '{subject} reclaimed ownership on the server’s PC', params);
      case 'team_renamed': return jt('settings.team.activity.teamRenamed', '{actor} renamed the team', params);
      case 'member_profile_changed': return jt('settings.team.activity.profileChanged', '{actor} changed their name or PC name.', params);
      case 'audit_log_reset': return jt('settings.team.activity.auditLogReset', 'The audit log could not be read and was set aside. A new log starts here.', params);
      case 'invite_name_taken': return jt('settings.team.activity.inviteNameTaken', 'A join was refused because the name was already taken', params);
      // Row 173: a custom channel archived, brought back or deleted; `name` is the channel's (null when it was not clean text).
      case 'chat_channel_archived': return jt('settings.team.activity.channelArchived', '{actor} archived #{channel}', { actor, channel: entry.name || '?' });
      case 'chat_channel_unarchived': return jt('settings.team.activity.channelUnarchived', '{actor} brought back #{channel}', { actor, channel: entry.name || '?' });
      case 'chat_channel_deleted': return jt('settings.team.activity.channelDeleted', '{actor} deleted #{channel}', { actor, channel: entry.name || '?' });
      default: return jt('settings.team.activity.other', '{actor} changed the team', params);
    }
  }

  // Owner decision E73 (2026-11-14): an export whose answer says `backup_left_out` wrote the readable copy only.
  function exportLeftOutText() {
    return jt('settings.team.export.leftOut', 'The member list is damaged, so only the readable copy was saved. This export cannot be restored.');
  }

  // The sentence of a Needs repair row: a file that cannot be read or is gone says what to do about it.
  function repairText(reason) {
    if (reason === 'team_client_invalid' || reason === 'team_client_missing') {
      return jt('settings.team.reason.clientUnreadable', 'The saved file for this team cannot be read. Remove it from this PC, then join again with a new invite.');
    }
    return errorText({ reason });
  }

  // A team's name wherever one is shown; a team that has not told its name yet still has words.
  // A needs_repair team has only its id (nothing is read from its file): the id's short form stands for its name.
  function teamName(team) {
    if (team && team.state === 'needs_repair') {
      const id = String(team.team_id || '');
      return id.length > 13 ? id.slice(0, 13) + '…' : id;
    }
    return (team && team.team_name) || jt('settings.team.joined.unnamed', 'Unnamed team');
  }

  // Model sharing's words (row 123, slice 6-7; TEAM_MODEL_SHARING_SPEC "6-7 as built"): the text helpers the Library
  // rows, the drawers, the Team tab's offer card and Settings › Team share, and the sentences more than one of them says
  // (one i18n key each). Every name, file name and note from another member or the host is hostile text: `clean` drops
  // control, bidi and zero-width characters and cuts it before anything escapes it; `name` is that cut for a person or
  // a team (one bound, NAME_MAX).
  const modelWords = (function () {
    // Bidi embeddings/overrides/isolates and marks, zero-width characters, the BOM and the line separators; C0 and C1
    // controls are dropped by code below (a control range in a regular expression is refused by the lint).
    var HIDDEN = /[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
    var TEXT_MAX = 128; // a model's name, a file name: the default cut
    var NAME_MAX = 64; // a person's or a team's name
    function noControls(text) {
      return Array.from(text, function (ch) { var c = ch.charCodeAt(0); return c < 32 || (c >= 127 && c < 160) ? ' ' : ch; }).join('');
    }

    // Hostile text made safe to show: hidden characters gone, spaces folded, cut at `max` characters (whole code points),
    // marked with "…" unless `plain` (a value that goes back into a payload with that bound).
    function clean(value, max, plain) {
      var text = noControls(String(value == null ? '' : value)).replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
      var points = Array.from(text);
      return points.length > (max || TEXT_MAX) ? points.slice(0, max || TEXT_MAX).join('') + (plain ? '' : '…') : text;
    }
    // The same for a multi-line text a member wrote (a licence, a note): line breaks kept, everything else as `clean`.
    function cleanBlock(value, max, plain) {
      var points = Array.from(String(value == null ? '' : value).split('\n').slice(0, 64).map(function (line) { return clean(line, max); }).join('\n').trim());
      return points.length > max ? points.slice(0, max).join('') + (plain ? '' : '…') : points.join('');
    }

    var count = function (value) { return Number.isFinite(value) && value > 0 ? value : 0; };
    function size(bytes) {
      var format = globalThis.rendererModelLibraryFormatUtils || (typeof require === 'function' ? require('./renderer-model-library-format-utils') : null);
      return format.formatHumanSize(count(bytes)) || jt('settings.models.share.zero', '0 MB');
    }
    function filesText(n, bytes) {
      return jtn('settings.models.share.files', count(n), { size: size(bytes) }, '{count} file · {size}', '{count} files · {size}');
    }
    function name(value) { return clean(value, NAME_MAX); }

    // A refusal or a row's reason word in one sentence.
    function reasonText(reason) { return errorText({ code: 'CMP-TEAM-0011', reason: String(reason || '') }); }

    // ------------------------------------------------------------------ sentences said in more than one place

    function killed() { return jt('settings.models.share.killed', 'Turned off when Jenny started (JENNY_ENABLE_TEAM_MODEL_SHARING=0). Remove that setting and restart Jenny to use model sharing.'); }
    function notConnected(team) { return jt('settings.models.share.offline', 'Not connected to {team}.', { team: team }); }
    // `host`: the host's cleaned name, or '' when it is not known.
    function hostOff(host) {
      return host ? jt('settings.models.share.offBy', '{host} has turned model sharing off for this team.', { host: host })
        : jt('settings.models.share.offByHost', 'The host has turned model sharing off for this team.');
    }
    // On a transfer between two members; left out on the host's own (`host`: the host's cleaned name, or '').
    function relay(host) {
      return jt('settings.models.share.relay', 'This goes through {host}’s computer, which can read it on the way and keeps none of it.',
        { host: host || jt('settings.models.share.theHostLower', 'the host') });
    }
    function readOnly() { return jt('settings.models.share.readOnly', 'Read-only members cannot send or receive models. The owner can change your role.'); }

    return Object.freeze({
      clean: clean, cleanBlock: cleanBlock, name: name, size: size, filesText: filesText, reasonText: reasonText,
      killed: killed, notConnected: notConnected, hostOff: hostOff, readOnly: readOnly, relay: relay, NAME_MAX: NAME_MAX,
    });
  })();

  // Sizes and dates for the team pages, in the app's language (a set-aside team, a backup, the server page).
  function tag() { try { return globalThis.jennyI18n?.tag?.() || undefined; } catch (_error) { return undefined; } }
  function sizeText(bytes) {
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
    let value = Math.max(0, Number(bytes) || 0);
    let i = 0;
    while (value >= 1000 && i < units.length - 1) { value /= 1000; i += 1; }
    try { return new Intl.NumberFormat(tag(), { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: i >= 3 ? 2 : (i ? 1 : 0) }).format(value); } catch (_error) { return Math.round(value) + ' ' + units[i]; }
  }
  // `short`: day and month, with the year only when it is not this one.
  function dateText(ms, short) {
    try {
      const date = new Date(ms);
      const options = short ? { day: 'numeric', month: 'short', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) } : { dateStyle: 'medium' };
      return new Intl.DateTimeFormat(tag(), options).format(date);
    } catch (_error) { return ''; }
  }

  return { tag, sizeText, dateText, modelWords, errorText, exportLeftOutText, forceLocalText, markErrorText, uploadErrorText, uploadRetry, repairText, connectionText, revokedText, roleText, teamName, formatFingerprint, ownKeyText, formatTime, deviceCount, activityText, _reasons: Object.keys(REASONS) };
});

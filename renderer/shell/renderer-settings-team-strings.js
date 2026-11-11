/* Settings > Team words (row 123, slice 1g-1). Every reason and code the team
 * IPC can answer gets one plain sentence here; anything else is the generic
 * sentence with the code, never a raw reason alone. Also the plain words for a
 * team's connection state, roles, the host's state and the activity log. */
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
  const REASONS = {
    team_name_invalid: () => jt('settings.team.reason.nameInvalid', 'Use 1 to 40 characters with no hidden characters.'),
    team_display_name_invalid: () => jt('settings.team.reason.nameInvalid', 'Use 1 to 40 characters with no hidden characters.'),
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
    team_unavailable: () => jt('settings.team.reason.unavailable', 'The team server is not answering. Try again in a moment.'),
    team_transport_down: () => jt('settings.team.reason.transportDown', 'The server lost its network connection.'),
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
    team_host_platform_unavailable: () => jt('settings.team.reason.platform', 'This PC cannot host a team yet.'),
    team_host_exit_unconfirmed: () => jt('settings.team.reason.exitUnconfirmed', 'The old server has not finished closing. Start is available once it has.'),
    team_host_busy: () => jt('settings.team.reason.hostBusy', 'The server is already starting or stopping. Wait a moment.'),
    team_host_config_write_failed: () => jt('settings.team.reason.configWrite', 'Jenny could not write the server’s settings on this PC.'),
    team_host_stopped: () => jt('settings.team.reason.hostStopped', 'The server was stopped before it finished starting.'),
    team_host_not_deployed: () => jt('settings.team.reason.notDeployed', 'This PC has not hosted a team yet.'),
    team_host_start_timeout: () => jt('settings.team.reason.startTimeout', 'The server did not start in time.'),
    team_host_exited: () => jt('settings.team.reason.exited', 'The server stopped unexpectedly.'),
    team_host_stopped_itself: () => jt('settings.team.reason.exited', 'The server stopped unexpectedly.'),
    team_host_stop_timeout: () => jt('settings.team.reason.stopTimeout', 'The server took too long to stop and was ended.'),
    team_host_spawn_failed: () => jt('settings.team.reason.spawn', 'Jenny could not start the server process.'),
    team_owner_recover_needed: () => jt('settings.team.reason.recoverNeeded', 'The server runs, but this Jenny is not signed in to its team. Reclaim ownership below.'),
    team_owner_invite_missing: () => jt('settings.team.reason.ownerInviteMissing', 'The server started but did not sign you in. Stop it and start it again.'),
    team_owner_join_unavailable: () => jt('settings.team.reason.ownerInviteMissing', 'The server started but did not sign you in. Stop it and start it again.'),
    team_recover_local_save_failed: () => jt('settings.team.reason.recoverSave', 'The server accepted you, but this PC could not save it. Run Reclaim ownership again.'),
  };

  const CODES = {
    'CMP-TEAM-0001': () => jt('settings.team.code.connection', 'The team server could not be reached.'),
    'CMP-TEAM-0002': () => jt('settings.team.code.version', 'This Jenny and the team server run versions that do not fit. Update the older one.'),
    'CMP-TEAM-0003': () => jt('settings.team.reason.inviteMalformed', 'That invite code is not valid. Check that you pasted all of it.'),
    'CMP-TEAM-0004': () => jt('settings.team.reason.storage', 'Jenny cannot use this PC’s secure storage right now.'),
    'CMP-TEAM-0005': () => jt('settings.team.reason.connectionStopped', 'The connection to that team was closed.'),
    'CMP-TEAM-0006': () => jt('settings.team.code.host', 'The team server on this PC could not be started.'),
  };

  function errorText(error) {
    const reason = error && typeof error.reason === 'string' ? error.reason : '';
    const code = error && typeof error.code === 'string' && CODE_PATTERN.test(error.code) ? error.code : '';
    if (Object.hasOwn(REASONS, reason)) return REASONS[reason]();
    if (Object.hasOwn(CODES, code)) return CODES[code]();
    return jt('settings.team.error.generic', 'Something went wrong ({code}).', { code: code || jt('settings.team.error.noCode', 'unknown') });
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
      default: return jt('settings.team.connection.unknown', 'unavailable');
    }
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
      default: return jt('settings.team.activity.other', '{actor} changed the team', params);
    }
  }

  return { errorText, connectionText, roleText, formatFingerprint, formatTime, deviceCount, activityText, _reasons: Object.keys(REASONS) };
});

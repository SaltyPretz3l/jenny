'use strict';

// Settings > Team words (row 123, slice 1g-1): every CMP-TEAM code and every
// reason the page can receive (the lists in docs/plans/TEAM_MEMBERSHIP_SPEC.md,
// "Failure reasons", "1f-1 as built" and "1f-2 as built") has its own plain
// sentence; anything else is the generic sentence with the code, never a raw
// reason on its own. The renderer error table carries the eight codes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const strings = require('../renderer/shell/renderer-settings-team-strings');
const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { PROJECT_REASONS } = require('../services/team/project-reasons');
// Slice 6-7: every model sharing reason word (services/team/model-reasons.js); a word with no sentence fails below.
const { MODEL_REASONS } = require('../services/team/model-reasons');

const REASONS = [
  // Failure reasons (host answers)
  'team_name_invalid', 'team_display_name_invalid', 'team_label_invalid', 'team_role_invalid', 'team_invite_malformed',
  // Owner decision E79: a join whose name is taken keeps the invite; the join page says so in the owner's words.
  'team_display_name_taken',
  'team_public_key_invalid', 'team_invite_ttl_invalid', 'team_cursor_invalid',
  'member_pending', 'member_revoked', 'role_forbidden', 'team_not_found', 'invite_not_valid', 'team_hello_required',
  'team_client_too_old', 'team_server_too_old', 'team_member_state_invalid', 'team_last_owner', 'team_owner_transfer_required',
  'team_host_key_mismatch', 'team_unavailable', 'team_transport_down', 'team_transport_missing', 'team_key_timeout', 'team_store_failed',
  'team_store_schema_unsupported', 'team_member_limit', 'team_device_limit', 'team_invite_limit', 'team_rate_limit',
  // 1f-1 as built (refusals in main and the client's own)
  'team_request_invalid', 'team_join_in_progress', 'team_already_joined', 'team_limit_reached', 'team_disposed',
  'team_change_unconfirmed', 'team_connection_stopped', 'device_revoked', 'team_device_key_unavailable',
  'team_device_key_invalid', 'team_device_key_missing',
  // 1f-2 as built (the host this Jenny runs)
  'team_host_platform_unavailable', 'team_host_exit_unconfirmed', 'team_host_busy', 'team_host_key_unavailable',
  'team_host_key_invalid', 'team_host_config_write_failed', 'team_host_stopped', 'team_host_not_deployed',
  'team_host_start_timeout', 'team_host_exited', 'team_host_stopped_itself', 'team_host_stop_timeout',
  'team_host_spawn_failed', 'team_host_shutting_down', 'team_owner_recover_needed', 'team_owner_invite_missing',
  'team_owner_join_unavailable', 'team_recover_local_save_failed',
  // TEAM_CHAT_SPEC 2a-4b and 2a-4c as built (the chat reasons the Team tab can receive, slice 2a-5a)
  'team_chat_rate_limit', 'disk_pressure', 'team_chat_not_found', 'team_not_connected', 'team_chat_answer_invalid',
  'team_chat_open_failed',
  // A lost host key (TEAM_INTERNET_SPEC, the reach verdict and lost key section)
  'team_host_key_missing', 'team_host_key_set_aside',
  // The host's internet setting (slice 5-5b): the three hostInternet field refusals
  'team_public_address_invalid', 'team_relay_url_invalid', 'team_relay_token_invalid', 'team_host_port_busy',
  // Member-side saved-team fixes: a saved team file that does not load (a recovery is refused for it)
  'team_client_invalid', 'team_client_schema_unsupported',
  // E49: an admin answer that fails the member-side check (the chat answer's sentence)
  'team_answer_invalid',
  // TEAM_CHAT_SPEC 2d renderer as built: the host's one refusal of a direct conversation
  'team_chat_dm_members_invalid',
  // TEAM_PROJECTS_SPEC 3-9: the shared-project client's own closed list (services/team/project-reasons.js)
  ...PROJECT_REASONS,
  ...MODEL_REASONS,
  // Row 201 (OD-4, OD-5): the sharer's Ollama share set and the owner's pool context length.
  'team_pool_context_invalid', 'team_sharing_invalid',
];

// Reason-like words in the 3-9 client's source that are event or push names, never failure reasons.
// Row 175: project_notice and project_waiting are team.onProject push kinds; approval_unattended is a host event.
const NOT_REASONS = new Set(['control_changed', 'decision_changed', 'session_changed', 'team_gone', 'team_project_changed',
  'project_notice', 'project_waiting', 'approval_unattended']);

test('every reason word in the shared-project client source is on its closed list (so a missing sentence fails)', () => {
  const dir = path.join(__dirname, '..', 'services', 'team');
  const files = fs.readdirSync(dir).filter((name) => /^(project-|transfer-|team-projects\.js)/u.test(name));
  assert.ok(files.length >= 9, files.join(','));
  const listed = new Set(PROJECT_REASONS);
  for (const name of files) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const [, word] of source.matchAll(/'((?:team|control|approval|decision|revision|project|session|backend)_[a-z_]+)'/gu)) {
      if (!NOT_REASONS.has(word)) assert.ok(listed.has(word), `${name}: ${word} is not in PROJECT_REASONS`);
    }
  }
});

test('every listed reason has its own sentence, never the generic one or the raw reason', () => {
  const generic = strings.errorText({ code: 'CMP-HOST-0001', reason: 'team_reason_nobody_knows' });
  for (const reason of REASONS) {
    const text = strings.errorText({ code: 'CMP-HOST-0001', reason });
    assert.ok(text && text !== generic, `${reason} has a sentence`);
    assert.equal(text.includes(reason), false, `${reason} is not shown raw`);
    assert.match(text, /[.?!]$/, `${reason} is a sentence`);
  }
});

test('a lost host key and a set-aside credentials file each say what happened and that nothing changed', () => {
  assert.equal(strings.errorText({ code: 'CMP-TEAM-0004', reason: 'team_host_key_missing' }),
    'This PC’s key for this team is missing, so the team cannot be started here. Nothing was changed.');
  assert.equal(strings.errorText({ code: 'CMP-TEAM-0004', reason: 'team_host_key_set_aside' }),
    'This PC’s key for this team is missing because Jenny’s saved credentials file was damaged. Jenny kept the damaged '
    + 'file in its data folder, with a name starting secure-state.json.corrupt. Nothing was changed.');
});

test('every CMP-TEAM code has a sentence when the reason is unknown', () => {
  const codes = Object.values(TEAM_ERROR_CODES);
  assert.equal(codes.length, 11);
  const seen = new Set();
  for (const code of codes) {
    const text = strings.errorText({ code, reason: 'team_reason_nobody_knows' });
    assert.equal(text.includes('Something went wrong'), false, code);
    seen.add(text);
  }
  assert.equal(seen.size, 11, 'eleven different sentences');
});

test('an unknown code and reason give the generic sentence with the code', () => {
  assert.equal(strings.errorText({ code: 'CMP-HOST-0009', reason: 'team_new' }), 'Something went wrong (CMP-HOST-0009).');
  assert.equal(strings.errorText(null), 'Something went wrong (unknown).');
  assert.equal(strings.errorText({ code: '<b>x</b>', reason: 1 }), 'Something went wrong (unknown).');
});

test('the renderer error table has a sentence for each CMP-TEAM code', (t) => {
  // The table only replaces the backend text outside English; a stub language makes it answer.
  const saved = globalThis.jennyI18n;
  globalThis.jennyI18n = { tag: () => 'de', t: (_key, fallback) => fallback };
  t.after(() => {
    if (saved === undefined) delete globalThis.jennyI18n; else globalThis.jennyI18n = saved;
    delete require.cache[require.resolve('../renderer/shared/i18n-backend-strings')];
  });
  delete require.cache[require.resolve('../renderer/shared/i18n-backend-strings')];
  const table = require('../renderer/shared/i18n-backend-strings');
  for (const code of Object.values(TEAM_ERROR_CODES)) {
    const text = table.errorText(code, 'BACKEND TEXT');
    assert.ok(text !== 'BACKEND TEXT' && text.length > 0, code);
  }
});

// Fault: needs_repair read as unavailable, or a repair row named
// "Unnamed team" (or after anything but its id).
test('a needs-repair team reads as Needs repair and is named by the short form of its id', () => {
  assert.equal(strings.connectionText('needs_repair'), 'Needs repair');
  assert.equal(strings.teamName({ team_id: 'team_RepairAAAAbbbbCCCCdd', state: 'needs_repair' }), 'team_RepairAA…');
  assert.equal(strings.teamName({ team_id: 'team_short', state: 'needs_repair' }), 'team_short');
  assert.equal(strings.teamName({ team_id: 'team_RepairAAAAbbbbCCCCdd', state: 'online', team_name: null }), 'Unnamed team');
});

// Fault: the shared sentence for a file that cannot be read telling the user to remove the team (the chat
// store answers that reason for a draft or outbox write too), or a missing file read as a generic error.
test('the shared saved-file sentences only say what is wrong; the repair row adds the advice', () => {
  assert.equal(strings.errorText({ reason: 'team_client_invalid' }), 'The saved file for this team cannot be read.');
  assert.equal(strings.errorText({ reason: 'team_client_missing' }), 'The saved file for this team is missing.');
  const advice = 'The saved file for this team cannot be read. Remove it from this PC, then join again with a new invite.';
  assert.equal(strings.repairText('team_client_invalid'), advice);
  assert.equal(strings.repairText('team_client_missing'), advice);
  assert.equal(strings.repairText('team_client_schema_unsupported'), strings.errorText({ reason: 'team_client_schema_unsupported' }));
});

test('key fingerprints read in groups of four, upper case', () => {
  assert.equal(strings.formatFingerprint('7f3a91c205'), '7F3A 91C2 05');
  assert.equal(strings.formatFingerprint('nothex!'), '');
  assert.equal(strings.formatFingerprint(null), '');
});

test('formatTime builds one date formatter per locale and options, not one per call', () => {
  const Real = Intl.DateTimeFormat;
  let built = 0;
  Intl.DateTimeFormat = function CountingFormat(...args) { built += 1; return new Real(...args); };
  try {
    const first = strings.formatTime(Date.UTC(2026, 10, 9, 10, 1));
    strings.formatTime(Date.UTC(2026, 10, 9, 10, 2));
    strings.formatTime(Date.UTC(2026, 10, 9, 10, 3));
    assert.ok(first.length > 0);
    assert.ok(built <= 1, `built ${built} formatters`);
  } finally {
    Intl.DateTimeFormat = Real;
  }
});

test('every membership audit kind the host writes has its own activity sentence', () => {
  const { AUDIT_KINDS } = require('../server/team/audit-log');
  const nameOf = () => 'Olive';
  const generic = strings.activityText({ kind: 'not_a_kind' }, nameOf);
  for (const kind of AUDIT_KINDS) {
    assert.notEqual(strings.activityText({ kind }, nameOf), generic, kind);
  }
  assert.ok(AUDIT_KINDS.includes('audit_log_reset'));
  // Row 173: the chat channel kinds sit in their own list and name the channel.
  const { CHAT_AUDIT_KINDS } = require('../server/team/audit-log');
  for (const kind of CHAT_AUDIT_KINDS) assert.notEqual(strings.activityText({ kind }, nameOf), generic, kind);
  assert.equal(strings.activityText({ kind: 'chat_channel_deleted', actor_member_id: 'member_a', name: 'design' }, nameOf), 'Olive deleted #design');
  assert.equal(strings.activityText({ kind: 'audit_log_reset', actor_member_id: null }, nameOf),
    'The audit log could not be read and was set aside. A new log starts here.');
});

test('slice 2b-2: the host\'s three refusals have their own sentences; reactions and pins say role, rate and disk per action only', () => {
  const generic = 'The team server refused this change.';
  const err = (reason) => ({ code: 'CMP-TEAM-0009', reason });
  assert.equal(strings.errorText(err('team_chat_reaction_limit')), 'This message already has 20 different reactions, the most it can have.');
  assert.equal(strings.errorText(err('team_chat_pin_limit')), 'This channel already has 50 pinned messages, the most it can have. Unpin one first.');
  assert.equal(strings.errorText(err('team_chat_emoji_invalid')), 'This team does not accept that reaction.');
  assert.equal(strings.errorText({ code: 'CMP-TEAM-0009', reason: 'unknown' }), generic, 'the generic sentence stays the fallback');
  assert.equal(strings.markErrorText(err('role_forbidden'), 'react'), 'Read-only members cannot react.');
  assert.equal(strings.markErrorText(err('role_forbidden'), 'pin'), 'Read-only members cannot pin.');
  assert.equal(strings.markErrorText({ code: 'CMP-TEAM-0007', reason: 'team_chat_rate_limit' }, 'pin'), 'The team server is busy. Try again in a moment.');
  assert.equal(strings.markErrorText({ code: 'CMP-TEAM-0007', reason: 'disk_pressure' }, 'react'), 'The team server is low on disk space, so nothing can be added right now.');
  assert.equal(strings.markErrorText(err('team_chat_pin_limit'), 'pin'), strings.errorText(err('team_chat_pin_limit')));
  // The old sentences stay for every other action.
  assert.equal(strings.errorText({ reason: 'role_forbidden' }), 'Only the owner can do that.');
  assert.equal(strings.errorText({ reason: 'team_chat_rate_limit' }), 'The team server is busy. Jenny will send this again shortly.');
  assert.equal(strings.errorText({ reason: 'disk_pressure' }), 'The team server is low on disk space. Jenny will send this again once there is room.');
});

test('slice 2c: the upload refusals read the approved sentences on an upload only; the file refusals of the member client have sentences', () => {
  const up = (reason, code = '') => strings.uploadErrorText({ code, reason });
  assert.equal(up('attachment_size_limit'), 'Too large: files can be up to 4 MB.');
  assert.equal(up('team_not_connected'), 'Not uploaded. This Jenny is not connected to the team right now.');
  assert.equal(up('team_upload_limit'), 'Not uploaded. You have 16 files waiting to be sent, the most there can be. Send or remove some first.');
  assert.equal(up('team_chat_storage_limit'), 'Not uploaded. The team’s chat storage is full. Ask the owner to make room.');
  assert.equal(up('disk_pressure'), 'Not uploaded. The team server is low on disk space, so nothing can be added right now.');
  assert.equal(up('display_name_invalid'), 'Not uploaded. Jenny cannot send a file with this name. Rename it and try again.');
  assert.equal(up('team_chat_not_found'), 'That conversation is not available.');
  assert.deepEqual(['team_not_connected', 'team_upload_limit', 'team_chat_storage_limit', 'disk_pressure', 'display_name_invalid', 'attachment_size_limit']
    .map((reason) => strings.uploadRetry({ code: '', reason })), [true, true, true, true, false, false]);
  for (const reason of ['team_attachment_not_image', 'team_attachment_copy_failed', 'team_attachment_not_saved', 'team_download_write_failed']) {
    assert.notEqual(strings.errorText({ code: 'CMP-TEAM-0009', reason }), 'The team server refused this change.', reason);
  }
  // The old sentences stay for every other action.
  assert.equal(strings.errorText({ reason: 'disk_pressure' }), 'The team server is low on disk space. Jenny will send this again once there is room.');
});

// Owner decisions of 2026-11-14 (E81, E73): a damaged settings file and a damaged member list say what to do, in place
// of the generic note; an export that left the backup out says so.
test('E81: a settings file and a member list that do not read each have the owner\'s sentence', () => {
  assert.equal(strings.errorText({ code: 'CMP-HOST-0001', reason: 'team_host_config_unreadable' }),
    'This team’s settings file is damaged or was made by a newer Jenny. Update Jenny, or delete the team and restore it from a backup.');
  assert.equal(strings.errorText({ code: 'CMP-HOST-0001', reason: 'team_members_unreadable' }),
    'This team’s member list is damaged. Delete the team, then restore it from a backup.');
});

test('E73: an export over a member list that does not read says only the readable copy was saved', () => {
  assert.equal(strings.exportLeftOutText(),
    'The member list is damaged, so only the readable copy was saved. This export cannot be restored.');
});

test('an invite made on the server’s own PC says where it was made; one a member made names the member', () => {
  const nameOf = (id) => (id === 'member_a' ? 'Arjun' : '');
  assert.equal(strings.activityText({ kind: 'invite_created', actor_member_id: null }, nameOf), 'An invite was created on the server’s PC');
  assert.equal(strings.activityText({ kind: 'invite_created', actor_member_id: 'member_a' }, nameOf), 'Arjun created an invite');
});

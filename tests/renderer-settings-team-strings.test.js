'use strict';

// Settings > Team words (row 123, slice 1g-1): every CMP-TEAM code and every
// reason the page can receive (the lists in docs/plans/TEAM_MEMBERSHIP_SPEC.md,
// "Failure reasons", "1f-1 as built" and "1f-2 as built") has its own plain
// sentence; anything else is the generic sentence with the code, never a raw
// reason on its own. The renderer error table carries the six codes.

const test = require('node:test');
const assert = require('node:assert/strict');

const strings = require('../renderer/shell/renderer-settings-team-strings');
const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');

const REASONS = [
  // Failure reasons (host answers)
  'team_name_invalid', 'team_display_name_invalid', 'team_label_invalid', 'team_role_invalid', 'team_invite_malformed',
  'team_public_key_invalid', 'team_invite_ttl_invalid', 'team_cursor_invalid',
  'member_pending', 'member_revoked', 'role_forbidden', 'team_not_found', 'invite_not_valid', 'team_hello_required',
  'team_client_too_old', 'team_server_too_old', 'team_member_state_invalid', 'team_last_owner', 'team_owner_transfer_required',
  'team_host_key_mismatch', 'team_unavailable', 'team_transport_down', 'team_key_timeout', 'team_store_failed',
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
];

test('every listed reason has its own sentence, never the generic one or the raw reason', () => {
  const generic = strings.errorText({ code: 'CMP-HOST-0001', reason: 'team_reason_nobody_knows' });
  for (const reason of REASONS) {
    const text = strings.errorText({ code: 'CMP-HOST-0001', reason });
    assert.ok(text && text !== generic, `${reason} has a sentence`);
    assert.equal(text.includes(reason), false, `${reason} is not shown raw`);
    assert.match(text, /[.?!]$/, `${reason} is a sentence`);
  }
});

test('every CMP-TEAM code has a sentence when the reason is unknown', () => {
  const codes = Object.values(TEAM_ERROR_CODES);
  assert.equal(codes.length, 6);
  const seen = new Set();
  for (const code of codes) {
    const text = strings.errorText({ code, reason: 'team_reason_nobody_knows' });
    assert.equal(text.includes('Something went wrong'), false, code);
    seen.add(text);
  }
  assert.equal(seen.size, 6, 'six different sentences');
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

'use strict';

/* services/primary-settings-contract.js - the closed contract of row 88, the Jenny chat's
 * settings writes (docs/plans/PRIMARY_SETTINGS_WRITES_2026-10-27.md). Pure data shared by the
 * main-side registry (primary-settings-allowlist.js), the `settings_get` / `settings_change`
 * tools, the approval card, undo, the appearance relay and the tests.
 *
 * The key list is the security boundary: nothing secret, no credential, no permission-bearing or
 * security setting is ever on it (plan section 2). Adding a key is a review, not a refactor;
 * tests/primary-settings-never-list.test.js pins this list and the never-list below.
 */

const PRIMARY_SETTINGS_TOOL_NAMES = Object.freeze(['settings_get', 'settings_change']);

const NOTIFICATION_CATEGORY_KEYS = Object.freeze([
  'notifications_category_replies', 'notifications_category_failures', 'notifications_category_permissions',
  'notifications_category_questions', 'notifications_category_reminders',
]);

// Ordered as Settings shows them. `group` names the one writer that owns the key.
const PRIMARY_SETTINGS_GROUPS = Object.freeze({
  time_format_24h: 'chat_ui',
  ui_language: 'chat_ui',
  default_run_mode: 'chat_ui',
  transcript_view_default: 'chat_ui',
  app_zoom_percent: 'window_ui',
  palette: 'appearance',
  typography: 'appearance',
  font_scale: 'appearance',
  chat_width: 'appearance',
  notifications_enabled: 'window_ui',
  notifications_sound: 'window_ui',
  notifications_only_when_unfocused: 'window_ui',
  ...Object.fromEntries(NOTIFICATION_CATEGORY_KEYS.map((key) => [key, 'window_ui'])),
  memory_take_notes: 'memory',
  memory_ask_before_saving: 'memory',
  memory_pause_saving: 'memory',
  memory_use_in_chats: 'memory',
  editor_font_size: 'workspace_ide',
  editor_tab_size: 'workspace_ide',
  editor_auto_save: 'workspace_ide',
});
const PRIMARY_SETTINGS_KEYS = Object.freeze(Object.keys(PRIMARY_SETTINGS_GROUPS));

// The four renderer-owned appearance keys (localStorage, not shell config) -> the renderer's
// appearance preference field. Main reads and writes them only through the appearance relay.
const APPEARANCE_RELAY_FIELDS = Object.freeze({
  palette: 'paletteId',
  typography: 'typographyId',
  font_scale: 'fontScaleId',
  chat_width: 'chatWidthId',
});

// Run modes Jenny may make the default. `auto` is a permission change and stays Settings-only (Q2).
const PRIMARY_SETTINGS_RUN_MODES = Object.freeze(['ask', 'plan', 'propose']);

const PRIMARY_SETTINGS_LIMITS = Object.freeze({
  changes_max: 5, // Q5: one card holds at most five changes
  purpose_chars: 200,
  value_chars: 64, // a string value (enum id, language tag)
  label_chars: 120, // an option label carried on a card or in a relay reply
  options_max: 64, // allowed values listed per key
  relay_timeout_ms: 3000,
});

const CHANGE_ID = /^sc_[0-9a-f]{32}$/;
const RELAY_REQUEST_ID = /^ar_[0-9]{1,12}$/;
// An enum id or language tag as the relay and the history carry it.
const VALUE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

// Tool and undo refusals (`{ ok: false, reason, key? }`). Stable wire strings.
const PRIMARY_SETTINGS_REASONS = Object.freeze({
  invalid_input: 'invalid_input', // the request shape is wrong (schema, count, duplicate key)
  not_allowed: 'not_allowed', // the key is not on the list, or the value is a forbidden one (auto)
  invalid_value: 'invalid_value', // the value fails the key's validation
  unchanged: 'unchanged', // every change already holds its value
  unavailable: 'unavailable', // a reader failed (the appearance relay timed out, no window)
  stale: 'stale', // a value moved between the card and the apply
  apply_failed: 'apply_failed', // a writer failed; earlier writes in the batch were reverted
  disabled: 'disabled', // the kill switch is off
  denied: 'denied', // the user said no on the card
  mode_refused: 'mode_refused', // Plan mode or a read-only chat (the tool refuses before the port; D9)
  not_primary: 'not_primary', // the call is not from the primary Jenny chat
  not_found: 'not_found', // undo: no such change in history
  already_undone: 'already_undone',
  changed_since: 'changed_since', // undo: a key no longer holds the value Jenny set
});

/* Appearance relay wire (main <-> renderer, row 88 D8). Main pushes
 *   appearance:relay-request  { request_id, op: 'read' }
 *                             { request_id, op: 'apply', values: { paletteId?, typographyId?, fontScaleId?, chatWidthId? } }
 * and the renderer answers through the `appearance.respondRelay` invoke with
 *   { request_id, ok: true, values: { paletteId, typographyId, fontScaleId, chatWidthId },
 *     options: { paletteId: [{ value, label }], ... } }
 *   { request_id, ok: false, reason }
 * An apply reply carries the values now in effect. Main fails closed: no window, a timeout, a
 * reply from another sender or a malformed reply resolves `unavailable`, never a guess.
 */
const APPEARANCE_RELAY_OPS = Object.freeze(['read', 'apply']);

module.exports = {
  APPEARANCE_RELAY_FIELDS,
  APPEARANCE_RELAY_OPS,
  CHANGE_ID,
  NOTIFICATION_CATEGORY_KEYS,
  PRIMARY_SETTINGS_GROUPS,
  PRIMARY_SETTINGS_KEYS,
  PRIMARY_SETTINGS_LIMITS,
  PRIMARY_SETTINGS_REASONS,
  PRIMARY_SETTINGS_RUN_MODES,
  PRIMARY_SETTINGS_TOOL_NAMES,
  RELAY_REQUEST_ID,
  VALUE_TOKEN,
};

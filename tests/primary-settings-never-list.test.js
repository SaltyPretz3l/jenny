'use strict';

/* Row 88 security boundary: the closed list of settings the Jenny chat may change
 * (docs/plans/PRIMARY_SETTINGS_WRITES_2026-10-27.md section 2). The key list is pinned
 * exactly, every registry entry writes only its one allowlisted target, nothing on the
 * never-list is reachable, and Auto can never become the default run mode. Changing this
 * file is a security review. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRIMARY_SETTINGS_GROUPS, PRIMARY_SETTINGS_KEYS, PRIMARY_SETTINGS_RUN_MODES,
} = require('../services/primary-settings-contract');
const { PRIMARY_SETTINGS_ALLOWLIST, getPrimarySettingEntry } = require('../services/primary-settings-allowlist');

const EXPECTED_KEYS = [
  'time_format_24h', 'ui_language', 'default_run_mode', 'transcript_view_default', 'app_zoom_percent',
  'palette', 'typography', 'font_scale', 'chat_width',
  'notifications_enabled', 'notifications_sound', 'notifications_only_when_unfocused',
  'notifications_category_replies', 'notifications_category_failures', 'notifications_category_permissions',
  'notifications_category_questions', 'notifications_category_reminders',
  'memory_take_notes', 'memory_ask_before_saving', 'memory_pause_saving', 'memory_use_in_chats',
  'editor_font_size', 'editor_tab_size', 'editor_auto_save',
];

// Config paths no entry may write (plan section 2 "Never on the list"), matched as a prefix of
// an entry's `target`.
const NEVER_TARGETS = [
  'safetyMode', 'autoApproveStreakCap', 'unattendedGuardMinutes', 'commandSandbox', 'sessionRuntime',
  'tools', 'featureOverrides', 'featureFlags', 'workspace', 'primaryChat', 'approvalRules', 'skills',
  'setup', 'engines', 'models', 'apiProviders', 'auth', 'secrets', 'telemetry', 'performanceTelemetry',
  'offline', 'assistantIdentity', 'personality', 'memory.takeNotesSince',
];

const TARGET_PREFIX_BY_GROUP = {
  chat_ui: /^(use24HourTime|uiLanguage|defaultRunMode|chatUi[.]transcriptViewDefault)$/,
  window_ui: /^windowUi\.(appZoomPercent|notifications\.(enabled|sound|onlyWhenUnfocused|categories\.[a-z]+))$/,
  appearance: /^appearance\.(paletteId|typographyId|fontScaleId|chatWidthId)$/,
  memory: /^memory\.(takeNotes|askBeforeSaving|pauseSaving|useInChats)$/,
  workspace_ide: /^workspaceIde\.(fontSize|tabSize|autoSaveMode)$/,
};

test('the key list is exactly the approved allowlist, in contract order', () => {
  assert.deepEqual([...PRIMARY_SETTINGS_KEYS], EXPECTED_KEYS);
  assert.deepEqual(PRIMARY_SETTINGS_ALLOWLIST.map((entry) => entry.id), EXPECTED_KEYS);
  assert.ok(Object.isFrozen(PRIMARY_SETTINGS_ALLOWLIST));
  for (const entry of PRIMARY_SETTINGS_ALLOWLIST) assert.ok(Object.isFrozen(entry), entry.id);
});

test('every entry writes only its one allowlisted target, never a never-list path', () => {
  for (const entry of PRIMARY_SETTINGS_ALLOWLIST) {
    assert.equal(entry.group, PRIMARY_SETTINGS_GROUPS[entry.id], entry.id);
    assert.equal(typeof entry.target, 'string', entry.id);
    assert.match(entry.target, TARGET_PREFIX_BY_GROUP[entry.group], entry.id);
    for (const never of NEVER_TARGETS) {
      assert.equal(entry.target === never || entry.target.startsWith(`${never}.`), false, `${entry.id} -> ${entry.target}`);
    }
  }
  const targets = PRIMARY_SETTINGS_ALLOWLIST.map((entry) => entry.target);
  assert.equal(new Set(targets).size, targets.length, 'one key per target');
});

test('unknown and never-list keys have no entry', () => {
  for (const key of ['safety_mode', 'auto_approve_streak_cap', 'command_sandbox', 'api_key', 'model', 'engine',
    'telemetry', 'offline', 'workspace_root', '__proto__', 'constructor', 'toString', '', null, undefined, 7]) {
    assert.equal(getPrimarySettingEntry(key), null, String(key));
  }
});

test('Auto is never a default run mode Jenny may set (Q2)', async () => {
  assert.deepEqual([...PRIMARY_SETTINGS_RUN_MODES], ['ask', 'plan', 'propose']);
  const entry = getPrimarySettingEntry('default_run_mode');
  for (const value of ['auto', 'AUTO', ' auto', 'plan_plus', 'yolo', '', null, 1]) {
    const verdict = await entry.validate(value, {});
    assert.equal(verdict.ok, false, String(value));
  }
  assert.equal((await entry.validate('auto', {})).reason, 'not_allowed');
  for (const value of PRIMARY_SETTINGS_RUN_MODES) assert.deepEqual(await entry.validate(value, {}), { ok: true, value });
});

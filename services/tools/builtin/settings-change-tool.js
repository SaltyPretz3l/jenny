'use strict';

// `settings_change` (row 88 S2): changes up to five of the closed list of app settings
// (services/primary-settings-contract.js) for the user. Side-effecting with an `ask` policy default and
// never always-allow, so the approval card comes from the normal tool approval path before this runs;
// refused in Plan mode and read-only chats. Shape and key allowlist are checked here, before the port
// (`context.primarySettingsService`, which validates each value and applies the batch all or nothing).
// The caller comes only from the live call binding; no result carries exception text.
const { manifestSchema } = require('./tool-result');
const { checkLiveCall } = require('./propose-tool-support');
const { jsonToolResult, plainInput } = require('./session-directory-tool-support');
const { actionRuleDenial } = require('../../backend/action-rule-gate');
const { RULE_DENIED_MESSAGE } = require('../../primary-action-rules');
const {
  PRIMARY_SETTINGS_KEYS, PRIMARY_SETTINGS_LIMITS, PRIMARY_SETTINGS_REASONS,
} = require('../../primary-settings-contract');

const NAME = 'settings_change';

function validValue(value) {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.length <= PRIMARY_SETTINGS_LIMITS.value_chars;
}

function validChange(change) {
  return plainInput(change, ['key', 'value']) && Object.hasOwn(change, 'key') && Object.hasOwn(change, 'value')
    && typeof change.key === 'string' && change.key.length > 0 && validValue(change.value);
}

function validInput(input) {
  if (!plainInput(input, ['changes', 'purpose']) || !Array.isArray(input.changes)) return false;
  if (input.changes.length < 1 || input.changes.length > PRIMARY_SETTINGS_LIMITS.changes_max) return false;
  if (typeof input.purpose !== 'string' || input.purpose.length < 1
    || input.purpose.length > PRIMARY_SETTINGS_LIMITS.purpose_chars) return false;
  return input.changes.every(validChange) && new Set(input.changes.map((change) => change.key)).size === input.changes.length;
}

// Auto as the default run mode is a permission change and stays Settings-only (the manifest schema already
// refuses it; this is the same rule one layer down).
const forbiddenAuto = (change) => change.key === 'default_run_mode'
  && typeof change.value === 'string' && change.value.trim().toLowerCase() === 'auto';

const result = (value) => jsonToolResult(NAME, 'Settings: change', value, { change_id: value.change_id });
const refused = (reason, extra = {}) => result({ ok: false, reason, ...extra });

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: false, sideEffecting: true,
  summarize: () => 'Settings: change',
  async execute(input = {}, context = {}) {
    if (context.backendService?.featureFlags?.primary_settings_writes === false) {
      return refused(PRIMARY_SETTINGS_REASONS.disabled);
    }
    if (context.readOnly || context.planMode) return refused(PRIMARY_SETTINGS_REASONS.mode_refused);
    if (!validInput(input)) return refused(PRIMARY_SETTINGS_REASONS.invalid_input);
    const unknown = input.changes.find((change) => !PRIMARY_SETTINGS_KEYS.includes(change.key) || forbiddenAuto(change));
    if (unknown) return refused(PRIMARY_SETTINGS_REASONS.not_allowed, { key: unknown.key });
    const live = checkLiveCall(context);
    const port = context.primarySettingsService;
    if (!live.ok || typeof port?.change !== 'function') return refused(PRIMARY_SETTINGS_REASONS.unavailable);
    // Row 87: a user's deny rule refuses the change (the approval path already refused before any card).
    if (actionRuleDenial(context.backendService, { toolName: NAME, sessionId: live.sessionId, turnId: live.turnId, input })) {
      return refused('rule_denied', { message: RULE_DENIED_MESSAGE });
    }
    try {
      const answer = await port.change({
        changes: input.changes.map(({ key, value }) => ({ key, value })),
        session_id: live.sessionId, tool_call_id: String(context.callId || ''),
      });
      return answer && typeof answer === 'object' ? result(answer) : refused(PRIMARY_SETTINGS_REASONS.unavailable);
    } catch (_error) {
      return refused(PRIMARY_SETTINGS_REASONS.unavailable);
    }
  },
};

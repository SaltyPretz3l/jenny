'use strict';

// `settings_get` (row 88 S2): the current values of the closed list of app settings the Jenny chat may
// change (services/primary-settings-contract.js). Read-only, policy `auto`, no card. The answer comes
// from the main-side settings port (`context.primarySettingsService`); this tool only validates the
// request and never puts exception text in a result.
const { manifestSchema } = require('./tool-result');
const { jsonToolResult, plainInput } = require('./session-directory-tool-support');
const { PRIMARY_SETTINGS_KEYS, PRIMARY_SETTINGS_REASONS } = require('../../primary-settings-contract');

const NAME = 'settings_get';

function validKeys(keys) {
  return Array.isArray(keys) && keys.length >= 1 && keys.length <= PRIMARY_SETTINGS_KEYS.length
    && keys.every((key) => typeof key === 'string' && PRIMARY_SETTINGS_KEYS.includes(key))
    && new Set(keys).size === keys.length;
}

const result = (value) => jsonToolResult(NAME, 'Settings: read', value);
const refused = (reason) => result({ ok: false, reason: PRIMARY_SETTINGS_REASONS[reason] });

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: true, sideEffecting: false,
  summarize: () => 'Settings: read',
  async execute(input = {}, context = {}) {
    if (context.backendService?.featureFlags?.primary_settings_writes === false) return refused('disabled');
    if (!plainInput(input, ['keys']) || (Object.hasOwn(input, 'keys') && !validKeys(input.keys))) {
      return refused('invalid_input');
    }
    const port = context.primarySettingsService;
    if (typeof port?.describe !== 'function') return refused('unavailable');
    try {
      // The port re-checks that the caller is the primary Jenny chat (the tool gate offers it nowhere else).
      const caller = { session_id: String(context.sessionId || '') };
      const answer = await port.describe(Object.hasOwn(input, 'keys') ? { keys: [...input.keys], ...caller } : caller);
      return result(answer && typeof answer === 'object' ? answer : { ok: false, reason: PRIMARY_SETTINGS_REASONS.unavailable });
    } catch (_error) {
      return refused('unavailable');
    }
  },
};

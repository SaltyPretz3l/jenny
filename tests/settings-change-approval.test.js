'use strict';

/* Row 88 D3: the settings_change card's rows come from the settings port under this call; a
 * refused or failing port yields a refused card (no rows, a stable reason), never model text. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { SETTINGS_CHANGE_SCOPE, TOOL_NAME, settingsChangeApprovalFields } = require('../services/backend/settings-change-approval');

const ROW = {
  key: 'time_format_24h', label: '24-hour time', label_key: 'primarySettings.key.time_format_24h', kind: 'boolean',
  before: false, after: true, before_label: 'Off', after_label: 'On', extra: 'dropped',
};

test('constants', () => {
  assert.equal(TOOL_NAME, 'settings_change');
  assert.equal(SETTINGS_CHANGE_SCOPE, 'App settings');
});

test('a ready card carries the port rows for this session and call', async () => {
  const calls = [];
  const service = { primarySettings: { prepareCard: async (args) => { calls.push(args); return { ok: true, rows: [ROW] }; } } };
  const changes = [{ key: 'time_format_24h', value: true }];
  const fields = await settingsChangeApprovalFields(service, 'sess_1', 'call_1', { changes, purpose: 'Turn on 24-hour time' });
  assert.deepEqual(calls, [{ session_id: 'sess_1', tool_call_id: 'call_1', changes }]);
  const { extra: _extra, ...row } = ROW;
  assert.deepEqual(fields, { settings_change_approval: { schema_version: 1, state: 'ready', rows: [row] } });
});

test('a refusal keeps its stable reason and key; anything else is unavailable', async () => {
  const refused = (answer) => settingsChangeApprovalFields({ primarySettings: { prepareCard: async () => answer } }, 's', 'c', { changes: [] });
  assert.deepEqual(await refused({ ok: false, reason: 'invalid_value', key: 'palette' }), {
    settings_change_approval: { schema_version: 1, state: 'refused', reason: 'invalid_value', key: 'palette', rows: [] },
  });
  assert.equal((await refused({ ok: false, reason: 'Error: secret path C:/x' })).settings_change_approval.reason, 'unavailable');
  assert.equal((await refused({ ok: true, rows: 'x' })).settings_change_approval.state, 'refused');
  const thrown = await settingsChangeApprovalFields({ primarySettings: { prepareCard: async () => { throw new Error('boom'); } } }, 's', 'c', {});
  assert.equal(thrown.settings_change_approval.reason, 'unavailable');
  assert.equal((await settingsChangeApprovalFields({}, 's', 'c', {})).settings_change_approval.state, 'refused');
});

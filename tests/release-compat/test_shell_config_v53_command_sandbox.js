'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeState, serializeState } = require('../../services/shell-config-state');
test('v53 defaults old profiles off and preserves model and preferences', () => {
 const previous = normalizeState({ version: 52, preferredEngineType: 'ollama', uiLanguage: 'ja', safetyMode: 'paranoid', toolsWorkspaceRoot: 'C:\\work' });
 assert.equal(previous.version, 53);
 assert.deepEqual(previous.commandSandbox, { enabled: false });
 assert.equal(previous.preferredEngineType, 'ollama'); assert.equal(previous.uiLanguage, 'ja'); assert.equal(previous.safetyMode, 'paranoid');
 const enabled = normalizeState({ ...previous, commandSandbox: { enabled: true } });
 assert.deepEqual(serializeState(enabled).commandSandbox, { enabled: true });
 for (const commandSandbox of [null, {}, { enabled: 'false' }, { enabled: 0 }]) {
  assert.equal(normalizeState({ ...previous, commandSandbox }).commandSandbox.enabled, true);
 }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeState, serializeState } = require('../../services/shell-config-state');
test('v53 defaults old profiles off and preserves model and preferences', () => {
 const previous = normalizeState({ version: 52, preferredEngineType: 'ollama', uiLanguage: 'ja', safetyMode: 'paranoid', toolsWorkspaceRoot: 'C:\\work' });
 assert.equal(previous.version, 59);
 // Row 106 adds `mode` additively: a profile that never enabled the sandbox starts in synced.
 assert.deepEqual(previous.commandSandbox, { enabled: false, mode: 'synced' });
 assert.equal(previous.preferredEngineType, 'ollama'); assert.equal(previous.uiLanguage, 'ja'); assert.equal(previous.safetyMode, 'paranoid');
 const enabled = normalizeState({ ...previous, commandSandbox: { enabled: true } });
 // A profile enabled before row 106 keeps the isolated copy.
 assert.deepEqual(serializeState(enabled).commandSandbox, { enabled: true, mode: 'copy' });
 assert.deepEqual(normalizeState({ ...previous, commandSandbox: { enabled: true, mode: 'synced' } }).commandSandbox,
  { enabled: true, mode: 'synced' });
 for (const commandSandbox of [null, {}, { enabled: 'false' }, { enabled: 0 }]) {
  assert.equal(normalizeState({ ...previous, commandSandbox }).commandSandbox.enabled, true);
 }
});

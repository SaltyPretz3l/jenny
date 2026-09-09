'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWorkspaceRootState } = require('../renderer/shell/renderer-settings-support');

test('settings normalization preserves canonical workspace identity across repeated renders', () => {
  const state = { path: 'C:\\workspaces\\résumé folder', status: { state: 'ready', message: '' }, rootId: 'root_123', generation: 7 };
  assert.deepEqual(normalizeWorkspaceRootState(normalizeWorkspaceRootState(state)), state);
});
test('settings accepts the coordinator envelope without deriving identity from a path', () => {
  const state = normalizeWorkspaceRootState({ workspaceRoot: 'C:\\workspaces\\project', context: { rootId: 'root_123', generation: 8 } });
  assert.equal(state.rootId, 'root_123');
  assert.equal(state.generation, 8);
  assert.equal(normalizeWorkspaceRootState({ path: 'C:\\workspaces\\project' }).rootId, '');
});
test('clearing workspace state cannot revive a previous identity', () => {
  assert.equal(normalizeWorkspaceRootState(null).rootId, '');
  assert.equal(normalizeWorkspaceRootState({ rootId: '', context: { rootId: 'old' } }).rootId, '');
  assert.equal(normalizeWorkspaceRootState({ generation: NaN }).generation, 0);
});

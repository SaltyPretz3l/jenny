'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  containsJennyStateDirSegment,
  guardPersistedWorkspaceRoot,
  isJennyStateDirRoot,
  workspaceRootId,
} = require('../services/workspace-root-identity');

test('workspace root IDs are stable and Windows identity is case-insensitive', () => {
  const upper = workspaceRootId('C:/dev/Jenny', { platform: 'win32' });
  const lower = workspaceRootId('c:/dev/jenny', { platform: 'win32' });
  assert.equal(upper, lower);
  assert.match(upper, /^root_[0-9a-f]{24}$/);
});

test('isJennyStateDirRoot rejects only an exact final .jenny segment, case-insensitively', () => {
  assert.equal(isJennyStateDirRoot('C:/dev/jenny/.jenny'), true);
  assert.equal(isJennyStateDirRoot('C:\\dev\\jenny\\.jenny'), true);
  assert.equal(isJennyStateDirRoot('C:/dev/jenny/.jenny/'), true, 'trailing slash is tolerated');
  assert.equal(isJennyStateDirRoot('C:/dev/jenny/.JENNY'), true, 'Windows is case-insensitive');
  assert.equal(isJennyStateDirRoot('C:/dev/jenny/.jenny-stuff'), false, 'not an exact segment match');
  assert.equal(isJennyStateDirRoot('C:/dev/jenny/.jenny/artifacts'), false, 'not the final segment');
  assert.equal(isJennyStateDirRoot(''), false);
});

test('isJennyStateDirRoot strips a trailing-dot/space Windows quirk before comparing', () => {
  assert.equal(isJennyStateDirRoot('C:/dev/jenny/.jenny.'), true, 'single trailing dot');
  assert.equal(isJennyStateDirRoot('C:/dev/jenny/.JENNY...'), true, 'multiple trailing dots + case');
  assert.equal(isJennyStateDirRoot('C:/dev/jenny/.jenny '), true, 'trailing space');
  assert.equal(isJennyStateDirRoot('C:/dev/jenny/.jenny.x'), false, 'still an unrelated lookalike');
  assert.equal(isJennyStateDirRoot('C:/dev/jenny/.jennyx.'), false, 'still an unrelated lookalike');
});

test('containsJennyStateDirSegment rejects .jenny anywhere in the path, not only the final segment', () => {
  assert.equal(containsJennyStateDirSegment('C:/dev/jenny/.jenny/artifacts'), true);
  assert.equal(containsJennyStateDirSegment('C:/dev/jenny/.jenny'), true);
  assert.equal(containsJennyStateDirSegment('C:/dev/jenny/.jenny-stuff/artifacts'), false);
  assert.equal(containsJennyStateDirSegment('C:/dev/jenny'), false);
  assert.equal(containsJennyStateDirSegment(''), false);
});

test('containsJennyStateDirSegment strips trailing-dot/space on a non-final segment', () => {
  assert.equal(containsJennyStateDirSegment('C:/dev/jenny/.jenny \\sub'), true);
  assert.equal(containsJennyStateDirSegment('C:/dev/jenny/.jenny.../artifacts'), true);
  assert.equal(containsJennyStateDirSegment('C:/dev/jenny/.jenny.x/artifacts'), false);
});

test('guardPersistedWorkspaceRoot treats a persisted .jenny root as absent and logs once', () => {
  const logs = [];
  const logger = (level, event, details) => logs.push({ level, event, details });

  const result = guardPersistedWorkspaceRoot('C:/dev/jenny/.jenny', { logger, seam: 'test_seam' });

  assert.equal(result, '');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].event, 'workspace.persisted_root_is_jenny_state_dir');
  assert.equal(logs[0].details.seam, 'test_seam');
});

test('guardPersistedWorkspaceRoot passes through a normal root without logging', () => {
  const logs = [];
  const logger = (level, event, details) => logs.push({ level, event, details });

  const result = guardPersistedWorkspaceRoot('C:/dev/jenny', { logger, seam: 'test_seam' });

  assert.equal(result, 'C:/dev/jenny');
  assert.equal(logs.length, 0);
});

test('guardPersistedWorkspaceRoot tolerates an empty root and a missing logger', () => {
  assert.equal(guardPersistedWorkspaceRoot('', {}), '');
  assert.equal(guardPersistedWorkspaceRoot('C:/dev/jenny/.jenny', {}), '');
});

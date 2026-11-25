'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  AUTO_APPROVE_STREAK_CAP_DEFAULT,
  AUTO_APPROVE_STREAK_CAP_MAX,
  CONFIG_VERSION,
  cloneState,
  normalizeAutoApproveStreakCap,
  normalizeState,
  serializeState,
} = require('../services/shell-config-state');
const { ShellConfigService } = require('../services/shell-config-service');

test('v55 streak-cap constants and normalizer are bounded', async (t) => {
  assert.equal(AUTO_APPROVE_STREAK_CAP_DEFAULT, 250);
  assert.equal(AUTO_APPROVE_STREAK_CAP_MAX, 500);
  assert.equal(Object.isFrozen(AUTO_APPROVE_STREAK_CAP_DEFAULT), true);
  assert.equal(Object.isFrozen(AUTO_APPROVE_STREAK_CAP_MAX), true);
  for (const [input, expected] of [
    [0, 0], ['0', 0], [1, 1], ['30.9', 30], [900, 500],
    [-1, 0], ['nope', 250], [NaN, 250], [null, 250], [undefined, 250], [{}, 250],
  ]) {
    await t.test(`autoApproveStreakCap ${String(input)}`, () => {
      assert.equal(normalizeAutoApproveStreakCap(input), expected);
    });
  }
});

test('v55 migration adds the default and preserves valid forward values', () => {
  const migrated = normalizeState({ version: 54 });
  assert.equal(CONFIG_VERSION, 60);
  assert.equal(migrated.version, 60);
  assert.equal(migrated.autoApproveStreakCap, 250);
  assert.equal(normalizeState({ version: 54, autoApproveStreakCap: 120 }).autoApproveStreakCap, 120);
});

test('cloneState and serializeState round-trip the v55 streak cap', () => {
  const state = normalizeState({ autoApproveStreakCap: '75.8' });
  const cloned = cloneState(state);
  const serialized = serializeState(cloned);
  assert.equal(cloned.autoApproveStreakCap, 75);
  assert.equal(serialized.autoApproveStreakCap, 75);
  assert.deepEqual(normalizeState(serialized), state);
});

test('ShellConfigService persists and exposes the v55 streak cap', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-v55-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const service = new ShellConfigService({ userDataPath });
  const reasons = [];
  service.on('changed', (_state, meta) => reasons.push(meta.reason));

  const snapshot = service.updateChatUiSettings({ autoApproveStreakCap: '75.8' });
  assert.equal(snapshot.autoApproveStreakCap, 75);
  assert.equal(service.getChatUiState().autoApproveStreakCap, 75);
  assert.deepEqual(reasons, ['auto_approve_streak_cap_updated']);

  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getChatUiState().autoApproveStreakCap, 75);
});

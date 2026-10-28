'use strict';

// Agent-driven launches stay quiet: no focus steal, no first-run overlays.
// (The desktop_notifications default lives in feature-flags.test.js.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { isAgentQuietLaunch, shouldRevealWindowInactive } = require('../services/agent-quiet-launch');
const { ShellConfigService } = require('../services/shell-config-service');
const { DISCLOSURE_VERSION } = require('../renderer/features/setup-scenes/scene-utils');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function tempProfile() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-agent-quiet-'));
  trackDirectory(userDataPath);
  return userDataPath;
}

test('agent mode is quiet unless JENNY_AGENT_QUIET turns it off', () => {
  assert.equal(isAgentQuietLaunch({}), false);
  assert.equal(isAgentQuietLaunch({ JENNY_AGENT_DEV: '1' }), true);
  assert.equal(isAgentQuietLaunch({ JENNY_AGENT_DEV: 'true', JENNY_AGENT_QUIET: '0' }), false);
  assert.equal(isAgentQuietLaunch({ JENNY_AGENT_DEV: '0' }), false);
});

test('the window reveals inactive for agent launches; an explicit env value wins', () => {
  assert.equal(shouldRevealWindowInactive({}), false);
  assert.equal(shouldRevealWindowInactive({ JENNY_WINDOW_REVEAL_INACTIVE: '1' }), true);
  assert.equal(shouldRevealWindowInactive({ JENNY_AGENT_DEV: '1' }), true);
  assert.equal(shouldRevealWindowInactive({ JENNY_AGENT_DEV: '1', JENNY_AGENT_QUIET: '0' }), false);
  assert.equal(shouldRevealWindowInactive({ JENNY_AGENT_DEV: '1', JENNY_WINDOW_REVEAL_INACTIVE: '0' }), false);
});

test('a fresh agent profile starts with the disclosure acknowledged and the first run done', () => {
  const userDataPath = tempProfile();
  const service = new ShellConfigService({ userDataPath, env: { JENNY_AGENT_DEV: '1' } });
  const setup = service.getSetupState();
  assert.equal(setup.acknowledgedVersion, DISCLOSURE_VERSION);
  assert.ok(setup.acknowledgedAt);
  assert.equal(setup.steps.acknowledgement, 'done');
  assert.equal(setup.firstRunCompleted, true);
  assert.equal(setup.setupComplete, false, 'setup health is left to the real steps');
  const reloaded = new ShellConfigService({ userDataPath, env: {} });
  assert.equal(reloaded.getSetupState().firstRunCompleted, true, 'the seed is persisted');
});

test('an acknowledged, finished profile is left untouched', () => {
  const userDataPath = tempProfile();
  const plain = new ShellConfigService({ userDataPath, env: {} });
  plain.updateSetupState({
    acknowledgedVersion: DISCLOSURE_VERSION,
    acknowledgedAt: '2026-01-02T03:04:05.000Z',
    firstRunCompleted: true,
    steps: { acknowledgement: 'done' },
  });
  const before = fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8');
  const service = new ShellConfigService({ userDataPath, env: { JENNY_AGENT_DEV: '1' } });
  assert.equal(service.getSetupState().acknowledgedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8'), before);
});

test('normal and opted-out launches keep the first-run overlays', () => {
  for (const env of [{}, { JENNY_AGENT_DEV: '1', JENNY_AGENT_QUIET: '0' }]) {
    const service = new ShellConfigService({ userDataPath: tempProfile(), env });
    const setup = service.getSetupState();
    assert.equal(setup.acknowledgedVersion, '');
    assert.equal(setup.firstRunCompleted, false);
  }
});

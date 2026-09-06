const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFallbacks } = require('../renderer/shell/renderer-fallback-workspace-registry');

test('workspace fallback registry exposes boot-safe state and chrome fallbacks', async () => {
  const fallbacks = buildFallbacks({});
  const stateController = fallbacks.workspaceStateUtils.createWorkspaceStateController({
    onStateChanged() {},
  });
  const chromeController = fallbacks.workspaceChromeUtils.createWorkspaceChromeController();

  assert.equal(typeof stateController.getState, 'function');
  assert.equal(typeof stateController.openSession, 'function');
  assert.equal(typeof stateController.restore, 'function');
  assert.equal(typeof chromeController.renderRail, 'function');
  assert.equal(typeof chromeController.renderSidebarBadges, 'function');

  assert.deepEqual(await stateController.restore(), { activeSessionId: '', openSessionIds: [] });
  assert.deepEqual(stateController.openSession('session-1'), {
    activeSessionId: 'session-1',
    openSessionIds: ['session-1'],
  });
});

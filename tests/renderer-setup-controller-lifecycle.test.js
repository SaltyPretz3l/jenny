/**
 * Setup controller snapshot lifecycle: a failed boot read must not look like a
 * fresh install.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSetupController } = require('../renderer/features/renderer-setup-controller');
const rendererSetupSceneUtils = require('../renderer/features/setup-scenes/scene-utils');

function snapshot(workspaceRoot) {
  return {
    acknowledgedVersion: rendererSetupSceneUtils.DISCLOSURE_VERSION,
    steps: { workspaceRoot, localModel: 'pending', endpoint: 'pending', personality: 'pending', skills: 'pending', capabilities: 'pending' },
  };
}

function makeController(setupService) {
  const logs = [];
  const state = {};
  let hubStarts = 0;
  const controller = createSetupController({
    state,
    setupService,
    dom: {},
    modules: { setupHub: { createSetupHub: () => ({ start() { hubStarts += 1; }, dispose() {} }) } },
    callbacks: { appendClientLog: (level, event) => logs.push([level, event]) },
  });
  return { controller, state, logs, hubStarts: () => hubStarts };
}

for (const [label, getState] of [
  ['throws', async () => { throw new Error('bridge down'); }],
  ['returns null', async () => null],
]) {
  test(`a boot getState that ${label} is not a fresh install, and the next good snapshot starts first run once`, async () => {
    let good = false;
    const h = makeController({ getState: async () => (good ? snapshot('pending') : getState()) });
    await h.controller.init();
    assert.equal(h.state.setup.loaded, false, 'a failed read never marks the snapshot loaded');
    assert.equal(h.hubStarts(), 0, 'no first-run flow over an unknown profile');
    assert.ok(h.logs.some((row) => row[0] === 'WARN' && row[1] === 'setup.init_failed'));
    good = true;
    await h.controller.refresh();
    assert.equal(h.state.setup.loaded, true);
    assert.equal(h.hubStarts(), 1, 'first successful load runs the first-run check');
    await h.controller.refresh();
    assert.equal(h.hubStarts(), 1, 'later refreshes do not restart the flow');
    h.controller.dispose();
  });
}

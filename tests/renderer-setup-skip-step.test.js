const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSetupHub } = require('../renderer/features/renderer-setup-hub');
const { createSetupController } = require('../renderer/features/renderer-setup-controller');
const { createScene: createSetupHubScene } = require('../renderer/features/setup-scenes/scene-setup-hub');
const { normalizeSetupPayload } = require('../renderer/services/renderer-setup-service');
const inventoryStepModal = require('../renderer/inventory/step-modal');

const INITIAL_STEPS = {
  workspace_root: 'pending', local_model: 'pending', endpoint: 'pending',
  personality: 'pending', skills: 'pending', capabilities: 'pending',
};

function snapshot(steps) {
  return normalizeSetupPayload({
    setup_complete: false,
    setup_state: { first_run_completed: false, setup_complete: false, steps },
  });
}

function settle() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

test('hub skips only the selected step per update and never promotes setupComplete', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="homeSetupModalRoot"></div></body></html>');
  const { document } = dom.window;
  const patches = [];
  const persistedSteps = { ...INITIAL_STEPS };
  const setupService = {
    async getState() { return snapshot({ ...persistedSteps }); },
    async updateState(patch) {
      patches.push(patch);
      Object.assign(persistedSteps, patch.steps || {});
      return snapshot({ ...persistedSteps });
    },
    async complete() { throw new Error('per-step skip must never complete setup'); },
    async detectOllama() { return { installed: false, running: false, version: '' }; },
  };
  const controller = createSetupController({
    state: {},
    documentRef: document,
    setupService,
    dom: { homeSetupModalRoot: document.getElementById('homeSetupModalRoot') },
    modules: {
      setupHub: { createSetupHub },
      scenes: { setupHub: createSetupHubScene },
      stepModal: inventoryStepModal,
    },
    callbacks: {
      appendClientLog() {}, showShellErrorToast() {}, showToastMessage() {}, setActiveView() {},
    },
  });
  t.after(() => { controller.dispose(); dom.window.close(); });

  await controller.init();
  const root = document.getElementById('homeSetupModalRoot');
  root.querySelector('[data-action="skipStep"][data-step-id="localModel"]').click();
  await settle();
  root.querySelector('[data-action="skipStep"][data-step-id="skills"]').click();
  await settle();

  assert.deepEqual(patches, [
    { steps: { local_model: 'skipped' } },
    { steps: { skills: 'skipped' } },
  ]);
  assert.deepEqual(persistedSteps, {
    ...INITIAL_STEPS,
    local_model: 'skipped',
    skills: 'skipped',
  });
  assert.equal(patches.some((patch) => patch.setupComplete === true), false);
  assert.equal(root.querySelector('[data-setup-step-id="workspaceRoot"] .setup-hub-glyph').getAttribute('aria-label'), 'Pending');
  assert.equal(root.querySelector('[data-setup-step-id="personality"] .setup-hub-glyph').getAttribute('aria-label'), 'Pending');
});

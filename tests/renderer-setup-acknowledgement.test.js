const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSetupController } = require('../renderer/features/renderer-setup-controller');
const { createSetupHub } = require('../renderer/features/renderer-setup-hub');
const { createScene: createAcknowledgementScene } = require('../renderer/features/setup-scenes/scene-acknowledgement');
const { normalizeSetupPayload } = require('../renderer/services/renderer-setup-service');
const inventoryStepModal = require('../renderer/inventory/step-modal');

function makeBackendPayload(setupState = {}) {
  return {
    setup_complete: setupState.setup_complete === true,
    setup_state: {
      seen: false,
      dismissed: false,
      setup_complete: false,
      first_run_completed: false,
      completed_at: '',
      updated_at: '2026-09-07T12:00:00.000Z',
      acknowledged_version: '',
      acknowledged_at: '',
      steps: {
        acknowledgement: 'pending',
        workspace_root: 'pending',
        local_model: 'pending',
        endpoint: 'pending',
        personality: 'pending',
        skills: 'pending',
        capabilities: 'pending',
      },
      readiness: {},
      ...setupState,
    },
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

function createHarness({
  setupState = {},
  updateState,
  acknowledgementFactory = createAcknowledgementScene,
} = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="appShell"></div><div id="homeSetupModalRoot"></div></body></html>');
  const { document } = dom.window;
  const logs = [];
  const patches = [];
  let hubMounts = 0;
  let workspaceRootMounts = 0;
  let currentSetupState = { ...setupState };
  const setupService = {
    async getState() {
      return normalizeSetupPayload(makeBackendPayload(currentSetupState));
    },
    async updateState(patch) {
      patches.push(patch);
      if (updateState) return updateState(patch, patches.length);
      currentSetupState = {
        ...currentSetupState,
        acknowledged_version: patch.acknowledgedVersion,
        acknowledged_at: patch.acknowledgedAt,
        steps: {
          ...makeBackendPayload(currentSetupState).setup_state.steps,
          ...(currentSetupState.steps || {}),
          ...(patch.steps || {}),
        },
      };
      return normalizeSetupPayload(makeBackendPayload(currentSetupState));
    },
  };
  const controller = createSetupController({
    state: {},
    documentRef: document,
    setupService,
    dom: { homeSetupModalRoot: document.getElementById('homeSetupModalRoot') },
    modules: {
      setupHub: { createSetupHub },
      scenes: {
        acknowledgement: acknowledgementFactory,
        setupHub: () => ({ mount() { hubMounts += 1; }, dispose() {} }),
        workspaceRoot: () => ({ mount() { workspaceRootMounts += 1; }, dispose() {} }),
      },
      stepModal: inventoryStepModal,
    },
    callbacks: {
      appendClientLog(level, event, payload) { logs.push({ level, event, payload }); },
      showShellErrorToast() {},
      showToastMessage() {},
      setActiveView() {},
    },
  });
  return {
    controller,
    document,
    dom,
    logs,
    patches,
    getHubMounts: () => hubMounts,
    getWorkspaceRootMounts: () => workspaceRootMounts,
    close() {
      controller.dispose();
      dom.window.close();
    },
  };
}

test('fresh profile mounts acknowledgement before the linear setup flow', async (t) => {
  const harness = createHarness();
  t.after(() => harness.close());

  await harness.controller.init();

  assert.ok(harness.document.querySelector('[data-step-modal="setupAcknowledgement"]'));
  assert.equal(harness.getHubMounts(), 0);
});

test('Resume keeps an unacknowledged profile gated until Continue persists', async (t) => {
  const harness = createHarness();
  t.after(() => harness.close());

  await harness.controller.init();
  const gate = harness.document.querySelector('[data-step-modal="setupAcknowledgement"]');
  const resumed = harness.controller.resumeSetup();

  assert.ok(gate);
  assert.equal(harness.document.querySelector('[data-step-modal="setupAcknowledgement"]'), gate);
  assert.equal(harness.getHubMounts(), 0);
  assert.equal(harness.patches.length, 0);

  const root = harness.document.getElementById('homeSetupModalRoot');
  root.querySelector('[data-step-modal-action="continue"]').click();
  await settle();

  assert.equal(harness.patches.length, 1);
  assert.equal(harness.getHubMounts(), 1);
  assert.notEqual(harness.controller.resumeSetup(), resumed);
});

test('Continue is available immediately without an acknowledgement checkbox', async (t) => {
  const harness = createHarness();
  t.after(() => harness.close());
  await harness.controller.init();

  const root = harness.document.getElementById('homeSetupModalRoot');
  assert.equal(root.querySelector('input[type="checkbox"]'), null);
  const continueButton = root.querySelector('[data-step-modal-action="continue"]');
  assert.equal(continueButton.disabled, false);
  assert.equal(harness.patches.length, 0);
});

test('Continue persists acknowledgement once and starts the linear flow', async (t) => {
  const harness = createHarness();
  t.after(() => harness.close());
  await harness.controller.init();
  const root = harness.document.getElementById('homeSetupModalRoot');

  root.querySelector('[data-step-modal-action="continue"]').click();
  assert.equal(root.querySelector('[data-step-modal-action="continue"]').disabled, true);
  root.querySelector('[data-step-modal-action="continue"]').click();
  await settle();

  assert.equal(harness.patches.length, 1);
  assert.equal(harness.patches[0].acknowledgedVersion, '1');
  assert.equal(new Date(harness.patches[0].acknowledgedAt).toISOString(), harness.patches[0].acknowledgedAt);
  assert.deepEqual(harness.patches[0].steps, { acknowledgement: 'done' });
  assert.equal(harness.getHubMounts(), 1);
});

test('completed profile is gated, then closes without starting the linear flow', async (t) => {
  const harness = createHarness({ setupState: { setup_complete: true, first_run_completed: true } });
  t.after(() => harness.close());
  await harness.controller.init();
  const root = harness.document.getElementById('homeSetupModalRoot');

  assert.ok(root.querySelector('[data-step-modal="setupAcknowledgement"]'));
  root.querySelector('[data-step-modal-action="continue"]').click();
  await settle();

  assert.equal(harness.patches.length, 1);
  assert.equal(harness.getHubMounts(), 0);
  assert.equal(root.children.length, 0);
});

test('current acknowledgement skips the gate and preserves the existing fresh-profile flow', async (t) => {
  const harness = createHarness({ setupState: { acknowledged_version: '1' } });
  t.after(() => harness.close());

  await harness.controller.init();

  assert.equal(harness.document.querySelector('[data-step-modal="setupAcknowledgement"]'), null);
  assert.equal(harness.getHubMounts(), 1);
});

test('older disclosure acknowledgement mounts the gate again', async (t) => {
  const harness = createHarness({ setupState: { acknowledged_version: '0' } });
  t.after(() => harness.close());

  await harness.controller.init();

  assert.ok(harness.document.querySelector('[data-step-modal="setupAcknowledgement"]'));
  assert.equal(harness.getHubMounts(), 0);
});

test('Escape is ignored while the acknowledgement gate is open', async (t) => {
  const harness = createHarness();
  t.after(() => harness.close());
  await harness.controller.init();

  harness.document.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  harness.document.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  assert.ok(harness.document.querySelector('[data-step-modal="setupAcknowledgement"]'));
  assert.equal(harness.logs.filter((entry) => entry.event === 'setup.acknowledgement_close_ignored').length, 1);
});

test('unchanged snapshot after failed persistence keeps the gate open and permits a successful retry', async (t) => {
  let resolveSuccessfully = false;
  const harness = createHarness({
    updateState(patch) {
      if (!resolveSuccessfully) {
        return normalizeSetupPayload(makeBackendPayload());
      }
      return normalizeSetupPayload(makeBackendPayload({
        acknowledged_version: patch.acknowledgedVersion,
        acknowledged_at: patch.acknowledgedAt,
        steps: { acknowledgement: 'done' },
      }));
    },
  });
  t.after(() => harness.close());
  await harness.controller.init();
  const root = harness.document.getElementById('homeSetupModalRoot');
  const continueButton = root.querySelector('[data-step-modal-action="continue"]');

  continueButton.click();
  await settle();
  assert.equal(continueButton.disabled, false);
  assert.ok(root.querySelector('[data-step-modal="setupAcknowledgement"]'));
  assert.ok(harness.logs.some((entry) => entry.event === 'setup.acknowledgement_persist_failed'));

  resolveSuccessfully = true;
  continueButton.click();
  await settle();
  assert.equal(harness.patches.length, 2);
  assert.equal(harness.getHubMounts(), 1);
});

test('missing acknowledgement scene logs one error and never mounts the hub', async (t) => {
  const harness = createHarness({ acknowledgementFactory: null });
  t.after(() => harness.close());

  await harness.controller.init();
  harness.controller.resumeSetup();
  harness.controller.showFromSettings();

  assert.equal(harness.getHubMounts(), 0);
  assert.equal(
    harness.logs.filter((entry) => entry.level === 'ERROR'
      && entry.event === 'setup.acknowledgement_scene_missing').length,
    1
  );
});

test('Settings scene open routes to acknowledgement while the profile is unacknowledged', async (t) => {
  const harness = createHarness();
  t.after(() => harness.close());
  await harness.controller.init();

  const gate = harness.document.querySelector('[data-step-modal="setupAcknowledgement"]');
  const opened = harness.controller.openScene('workspaceRoot');

  assert.ok(gate);
  assert.equal(opened, harness.controller.resumeSetup());
  assert.equal(harness.document.querySelector('[data-step-modal="setupAcknowledgement"]'), gate);
  assert.equal(harness.getWorkspaceRootMounts(), 0);
  assert.equal(harness.getHubMounts(), 0);
});

test('refresh does not duplicate an open gate and controller disposal tears it down', async (t) => {
  let mounts = 0;
  let disposals = 0;
  const acknowledgementFactory = (options) => {
    const scene = createAcknowledgementScene(options);
    return {
      mount(root) { mounts += 1; scene.mount(root); },
      dispose() { disposals += 1; scene.dispose(); },
    };
  };
  const harness = createHarness({ acknowledgementFactory });
  t.after(() => harness.dom.window.close());

  await harness.controller.init();
  await harness.controller.refresh();
  await harness.controller.init();
  assert.equal(mounts, 1);

  harness.controller.dispose();
  assert.equal(disposals, 1);
});

test('normalizeSetupPayload exposes acknowledgement fields from snake input', () => {
  const snapshot = normalizeSetupPayload(makeBackendPayload({
    acknowledged_version: '1',
    acknowledged_at: '2026-09-07T12:34:56.000Z',
    steps: { acknowledgement: 'done' },
  }));

  assert.equal(snapshot.acknowledgedVersion, '1');
  assert.equal(snapshot.acknowledgedAt, '2026-09-07T12:34:56.000Z');
  assert.equal(snapshot.steps.acknowledgement, 'done');
});

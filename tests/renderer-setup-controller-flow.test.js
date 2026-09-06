/**
 * Setup controller and checklist-hub tests split from tests/renderer-setup.test.js at the
 * file-size ceiling: Escape routing/fallback in the scene modal and checklist
 * hub resume/start positioning through the controller. Controller lifecycle, tiles, and
 * scene-service tests stay in the sibling file; checklist-hub behavior lives
 * in tests/renderer-setup-hub.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { normalizeSetupPayload } = require('../renderer/services/renderer-setup-service');
const { createSetupController } = require('../renderer/features/renderer-setup-controller');
const { createSetupHub } = require('../renderer/features/renderer-setup-hub');
const rendererSetupSceneUtils = require('../renderer/features/setup-scenes/scene-utils');
const { renderSetupSettingsRow } = require('../renderer/shell/renderer-settings-core-renderers');
const inventoryActionButton = require('../renderer/inventory/action-button');
const inventoryStepModal = require('../renderer/inventory/step-modal');

function makeBackendPayload(overrides = {}) {
  return {
    setup_complete: false,
    setup_state: {
      seen: false,
      dismissed: false,
      setup_complete: false,
      completed_at: '',
      updated_at: '2026-05-07T12:00:00.000Z',
      steps: {
        workspace_root: 'pending',
        local_model: 'pending',
        endpoint: 'pending',
        personality: 'pending',
        skills: 'pending',
      },
      readiness: {},
      tools_workspace_root_configured: false,
      mcp_tools_discovered: false,
      assistant_identity: { agentName: 'Jenny', profile: 'balanced', customText: '', updatedAt: '' },
      ...(overrides.setup_state || {}),
    },
    ...overrides,
  };
}

test('Escape routes to the mounted scene modal action, cancel first, and unbinds on close', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="homeSetupModalRoot"></div></body></html>');
  const { document } = dom.window;
  const modalRoot = document.getElementById('homeSetupModalRoot');
  const clicks = [];
  const sceneFactory = () => ({
    mount(rootEl) {
      rootEl.innerHTML = '<button data-step-modal-action="cancel">Cancel</button>'
        + '<button data-step-modal-action="skip">Skip for now</button>';
      rootEl.querySelector('[data-step-modal-action="cancel"]')
        .addEventListener('click', () => clicks.push('cancel'));
      rootEl.querySelector('[data-step-modal-action="skip"]')
        .addEventListener('click', () => clicks.push('skip'));
    },
    dispose() {},
  });
  const controller = createSetupController({
    state: { setup: { steps: {} } },
    documentRef: document,
    setupService: { async getState() { return null; }, subscribePullProgress() { return () => {}; } },
    dom: { homeSetupModalRoot: modalRoot },
    modules: { stepModal: inventoryStepModal, scenes: { setupHub: sceneFactory } },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });

  controller.openScene('setupHub');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(clicks, ['cancel'], 'Escape must click the highest-priority action (cancel over skip)');

  controller.closeModal();
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(clicks, ['cancel'], 'Escape is inert once the scene is closed');

  controller.dispose();
  dom.window.close();
});

test('Escape falls back to skip-tier actions when no cancel/close is rendered', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="homeSetupModalRoot"></div></body></html>');
  const { document } = dom.window;
  const modalRoot = document.getElementById('homeSetupModalRoot');
  const clicks = [];
  const sceneFactory = () => ({
    mount(rootEl) {
      rootEl.innerHTML = '<button data-step-modal-action="skip">Skip for now</button>';
      rootEl.querySelector('[data-step-modal-action="skip"]')
        .addEventListener('click', () => clicks.push('skip'));
    },
    dispose() {},
  });
  const controller = createSetupController({
    state: { setup: { steps: {} } },
    documentRef: document,
    setupService: { async getState() { return null; }, subscribePullProgress() { return () => {}; } },
    dom: { homeSetupModalRoot: modalRoot },
    modules: { stepModal: inventoryStepModal, scenes: { setupHub: sceneFactory } },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });

  controller.openScene('setupHub');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(clicks, ['skip']);

  controller.dispose();
  dom.window.close();
});

test('Escape prefers an in-body pull cancellation and does not close while cancellation is pending', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="homeSetupModalRoot"></div></body></html>');
  const { document } = dom.window;
  const modalRoot = document.getElementById('homeSetupModalRoot');
  const clicks = [];
  const sceneFactory = () => ({
    mount(rootEl) {
      rootEl.innerHTML = '<button data-action="cancelPull">Cancel pull</button>'
        + '<button data-step-modal-action="close">Close</button>';
      rootEl.querySelector('[data-action="cancelPull"]').addEventListener('click', () => clicks.push('cancelPull'));
      rootEl.querySelector('[data-step-modal-action="close"]').addEventListener('click', () => clicks.push('close'));
    },
    dispose() {},
  });
  const controller = createSetupController({
    state: { setup: { steps: {} } },
    documentRef: document,
    setupService: { async getState() { return null; }, subscribePullProgress() { return () => {}; } },
    dom: { homeSetupModalRoot: modalRoot },
    modules: { stepModal: inventoryStepModal, scenes: { localModel: sceneFactory } },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });

  controller.openScene('localModel');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(clicks, ['cancelPull']);

  modalRoot.querySelector('[data-action="cancelPull"]').disabled = true;
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(clicks, ['cancelPull'], 'Close must not win while cancellation is unresolved');

  controller.dispose();
  dom.window.close();
});

test('first-run with partial progress opens the checklist hub', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="homeSetupModalRoot"></div></body></html>');
  const { document } = dom.window;

  const mounted = [];
  const sceneFactory = (name) => () => ({ mount() { mounted.push(name); }, dispose() {} });
  const fakeService = {
    // localModel already done from a previous partial run; first-run incomplete.
    async getState() {
      return normalizeSetupPayload(makeBackendPayload({
        setup_state: { steps: { local_model: 'done' } },
      }));
    },
    async updateState() { return null; },
    subscribePullProgress() { return () => {}; },
  };

  const controller = createSetupController({
    state: {},
    documentRef: document,
    setupService: fakeService,
    dom: { homeSetupModalRoot: document.getElementById('homeSetupModalRoot') },
    modules: {
      setupHub: { createSetupHub },
      scenes: { setupHub: sceneFactory('setupHub') },
    },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });
  await controller.init();

  assert.deepEqual(mounted, ['setupHub']);

  controller.dispose();
  dom.window.close();
});

test('first-run with no recorded progress also opens the checklist hub', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="homeSetupModalRoot"></div></body></html>');
  const { document } = dom.window;

  const mounted = [];
  const sceneFactory = (name) => () => ({ mount() { mounted.push(name); }, dispose() {} });
  const fakeService = {
    async getState() { return normalizeSetupPayload(makeBackendPayload()); },
    async updateState() { return null; },
    subscribePullProgress() { return () => {}; },
  };

  const controller = createSetupController({
    state: {},
    documentRef: document,
    setupService: fakeService,
    dom: { homeSetupModalRoot: document.getElementById('homeSetupModalRoot') },
    modules: {
      setupHub: { createSetupHub },
      scenes: { setupHub: sceneFactory('setupHub') },
    },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });
  await controller.init();

  assert.deepEqual(mounted, ['setupHub']);

  controller.dispose();
  dom.window.close();
});

// --- UIUX-005: renderSetupSettingsRow renders from health, not the raw boolean ---

test('renderSetupSettingsRow shows "Setup complete" only when health is complete', () => {
  const dom = new JSDOM('<!doctype html><div id="summary"></div><div id="actions"></div>');
  const summary = dom.window.document.getElementById('summary');
  const actions = dom.window.document.getElementById('actions');

  renderSetupSettingsRow({
    setupSnapshot: {
      loaded: true,
      setupComplete: true, // stale/buggy-path true, but steps say otherwise
      steps: { workspaceRoot: 'pending', localModel: 'pending', endpoint: 'pending', personality: 'pending', skills: 'pending' },
    },
    setupSettingsSummary: summary,
    setupSettingsActions: actions,
    sceneUtils: rendererSetupSceneUtils,
    actionButton: inventoryActionButton,
  });

  assert.doesNotMatch(summary.textContent, /Setup complete/, 'must not claim completion when required steps are unresolved');
  assert.match(actions.innerHTML, /Resume setup/);
  assert.doesNotMatch(actions.innerHTML, /Run setup again/);
});

test('renderSetupSettingsRow shows "Setup complete" and "Run setup again" once health truly is complete', () => {
  const dom = new JSDOM('<!doctype html><div id="summary"></div><div id="actions"></div>');
  const summary = dom.window.document.getElementById('summary');
  const actions = dom.window.document.getElementById('actions');

  renderSetupSettingsRow({
    setupSnapshot: {
      loaded: true,
      setupComplete: true,
      steps: { workspaceRoot: 'done', localModel: 'done', endpoint: 'done', personality: 'done', skills: 'skipped' },
    },
    setupSettingsSummary: summary,
    setupSettingsActions: actions,
    sceneUtils: rendererSetupSceneUtils,
    actionButton: inventoryActionButton,
  });

  assert.match(summary.textContent, /Setup complete/);
  assert.match(actions.innerHTML, /Run setup again/);
});

// --- UIUX-010/UIUX-005: controller.resumeSetup() opens the hub ---

test('resumeSetup opens the checklist hub regardless of which step is unresolved', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="homeSetupModalRoot"></div></body></html>');
  const { document } = dom.window;

  const mounted = [];
  const sceneFactory = (name) => () => ({ mount() { mounted.push(name); }, dispose() {} });
  const fakeService = {
    // workspaceRoot + localModel done; personality only 'skipped' (not 'done')
    // -- a Resume click must revisit it, unlike the relaunch-resume heuristic.
    async getState() {
      return normalizeSetupPayload(makeBackendPayload({
        setup_state: { steps: { workspace_root: 'done', local_model: 'done', personality: 'skipped' } },
      }));
    },
    async updateState() { return null; },
    subscribePullProgress() { return () => {}; },
  };

  const controller = createSetupController({
    state: {},
    documentRef: document,
    setupService: fakeService,
    dom: { homeSetupModalRoot: document.getElementById('homeSetupModalRoot') },
    modules: {
      setupHub: { createSetupHub },
      scenes: { setupHub: sceneFactory('setupHub') },
    },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });
  await controller.init(); // firstRunCompleted defaults false -> auto-starts too; dispose it first
  controller.dispose();
  mounted.length = 0;

  controller.resumeSetup();

  assert.deepEqual(mounted, ['setupHub']);

  controller.dispose();
  dom.window.close();
});

test('resumeSetup is idempotent: calling it twice in a row keeps a single active hub', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="homeSetupModalRoot"></div></body></html>');
  const { document } = dom.window;

  let mountCount = 0;
  let disposeCount = 0;
  const sceneFactory = () => () => ({ mount() { mountCount += 1; }, dispose() { disposeCount += 1; } });
  const fakeService = {
    async getState() {
      return normalizeSetupPayload(makeBackendPayload({
        setup_state: { first_run_completed: true, steps: { workspace_root: 'done', local_model: 'done' } },
      }));
    },
    async updateState() { return null; },
    subscribePullProgress() { return () => {}; },
  };

  const controller = createSetupController({
    state: {},
    documentRef: document,
    setupService: fakeService,
    dom: { homeSetupModalRoot: document.getElementById('homeSetupModalRoot') },
    modules: {
      setupHub: { createSetupHub },
      scenes: { setupHub: sceneFactory() },
    },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });
  await controller.init(); // firstRunCompleted true -> does not auto-start

  controller.resumeSetup();
  assert.equal(mountCount, 1, 'first resumeSetup call opens the hub');

  controller.resumeSetup();
  assert.equal(mountCount, 1, 'a second resumeSetup call while the hub is active must not remount/duplicate it');
  assert.equal(disposeCount, 0, 'the already-active hub scene must not be torn down by a redundant resume');

  controller.dispose();
  dom.window.close();
});

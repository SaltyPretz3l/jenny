/**
 * Phase 7B unit tests for the renderer setup module trio:
 *   - renderer/services/renderer-setup-service.js
 *   - renderer/features/renderer-setup-controller.js
 * These exercise the bridge wrapper, the tile renderer's gating behavior,
 * and the controller's state lifecycle without booting the full renderer
 * shell — matching the focused shape of tests/renderer-inventory.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSetupService, normalizeSetupPayload } = require('../renderer/services/renderer-setup-service');
const {
  createSetupController,
  allStepsTerminal,
  mergeSetupPayload,
} = require('../renderer/features/renderer-setup-controller');
const { createSetupHub } = require('../renderer/features/renderer-setup-hub');
const { createScene: createFactoryResetScene } = require('../renderer/features/setup-scenes/scene-factory-reset');
const { createScene: createPersonalityScene } = require('../renderer/features/setup-scenes/scene-personality');
const { createScene: createWorkspaceRootScene } = require('../renderer/features/setup-scenes/scene-workspace-root');
const { computeSetupHealth } = require('../services/shell-config-setup-state');
const personalityForm = require('../renderer/features/personality-form');
const rendererSetupSceneUtils = require('../renderer/features/setup-scenes/scene-utils');

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

const LIVE_LOCAL_READINESS = {
  workspace_root: { ready: true, configured: true, status: 'ready' },
  local_model: { ready: true, source: 'model_catalog', model_count: 1 },
  endpoint: { ready: true, source: 'model_catalog' },
};

test('normalizeSetupPayload reshapes snake_case payload into renderer state shape', () => {
  const payload = makeBackendPayload({
    setup_complete: true,
    setup_state: {
      seen: true,
      setup_complete: true,
      completed_at: '2026-05-07T12:00:00.000Z',
      steps: {
        workspace_root: 'done',
        local_model: 'done',
        endpoint: 'done',
        personality: 'done',
        skills: 'skipped',
      },
      tools_workspace_root_configured: true,
      mcp_tools_discovered: true,
      assistant_identity: { agentName: 'Echo', profile: 'creative', customText: 'curious', updatedAt: '2026-05-07T12:00:00.000Z' },
    },
  });
  const normalized = normalizeSetupPayload(payload);
  assert.equal(normalized.setupComplete, true);
  assert.equal(normalized.steps.workspaceRoot, 'done');
  assert.equal(normalized.steps.localModel, 'done');
  assert.equal(normalized.steps.skills, 'skipped');
  assert.equal(normalized.assistantIdentity.agentName, 'Echo');
  assert.equal(normalized.assistantIdentity.profile, 'creative');
  assert.equal(normalized.toolsWorkspaceRootConfigured, true);
  assert.equal(normalized.mcpToolsDiscovered, true);
});

test('normalizeSetupPayload carries readiness metadata and derives workspace root status', () => {
  const payload = makeBackendPayload({
    setup_state: {
      steps: {
        workspace_root: 'done',
        local_model: 'done',
        endpoint: 'done',
        personality: 'done',
        skills: 'skipped',
      },
      readiness: {
        workspace_root: {
          ready: true,
          configured: true,
          status: 'ready',
          message: 'Workspace root is configured.',
          source: 'workspace_root_status',
        },
        local_model: { ready: true, source: 'model_catalog', model_count: 2 },
        endpoint: { ready: true, source: 'model_catalog' },
        personality: { ready: true, source: 'assistant_identity' },
        skills: { ready: false, skipped: true, source: 'mcp_discovery' },
      },
    },
  });

  const normalized = normalizeSetupPayload(payload);

  assert.equal(normalized.steps.workspaceRoot, 'done');
  assert.equal(normalized.toolsWorkspaceRootConfigured, true);
  assert.equal(normalized.workspaceRootStatus.state, 'ready');
  assert.equal(normalized.readiness.localModel.ready, true);
  assert.equal(normalized.readiness.localModel.modelCount, 2);
  assert.equal(normalized.readiness.skills.skipped, true);
});

test('createSetupService wraps the bridge and forwards updateState patches', async () => {
  const calls = [];
  const fakeBridge = {
    setup: {
      async getState() { return makeBackendPayload(); },
      async updateState(patch) {
        calls.push({ method: 'updateState', patch });
        return makeBackendPayload({
          setup_state: {
            steps: { workspace_root: 'done', local_model: 'pending', endpoint: 'pending', personality: 'pending', skills: 'pending' },
          },
        });
      },
      async complete() {
        calls.push({ method: 'complete' });
        return makeBackendPayload({ setup_complete: true });
      },
      async validateEndpoint(payload) {
        calls.push({ method: 'validateEndpoint', payload });
        return { ok: true, engineType: 'ollama', checkedUrl: 'http://127.0.0.1:11434/api/tags', status: 200, code: 'ok', message: 'ok' };
      },
      async startOllamaPull(payload) {
        calls.push({ method: 'startOllamaPull', payload });
        return { requestId: 'req_1', model: payload.model, status: 'running', summary: 'Starting' };
      },
      async cancelOllamaPull(payload) {
        calls.push({ method: 'cancelOllamaPull', payload });
        return { cancelled: true, requestId: payload.requestId, model: '', status: 'cancelled', summary: 'Cancelled' };
      },
      onModelPullProgress(listener) {
        calls.push({ method: 'onModelPullProgress' });
        // Synchronously emit one progress payload so the test can assert subscription.
        listener({ requestId: 'req_1', model: 'qwen2.5:3b', status: 'running', summary: 'pulling' });
        return function unsubscribe() { calls.push({ method: 'unsubscribePullProgress' }); };
      },
    },
  };
  const service = createSetupService({
    windowRef: { jennyShell: fakeBridge },
    appendClientLog: () => {},
    toErrorMessage: (e) => String((e && e.message) || e),
  });
  const got = await service.getState();
  assert.equal(got.steps.workspaceRoot, 'pending');
  const updated = await service.updateState({ steps: { workspace_root: 'done' } });
  assert.equal(updated.steps.workspaceRoot, 'done');
  const validation = await service.validateEndpoint({ engineType: 'ollama', apiUrl: 'http://127.0.0.1:11434' });
  assert.equal(validation.ok, true);
  const pullStart = await service.startOllamaPull({ model: 'qwen2.5:3b', requestId: 'req_1' });
  assert.equal(pullStart.requestId, 'req_1');
  let received = null;
  const unsub = service.subscribePullProgress((payload) => { received = payload; });
  assert.equal(received.requestId, 'req_1');
  unsub();
  const cancel = await service.cancelOllamaPull({ requestId: 'req_1', model: 'qwen2.5:3b' });
  assert.equal(cancel.cancelled, true);
  assert.deepEqual(
    calls.map((entry) => entry.method),
    ['updateState', 'validateEndpoint', 'startOllamaPull', 'onModelPullProgress', 'unsubscribePullProgress', 'cancelOllamaPull'],
  );
});

test('createSetupService exposes the bounded factoryReset bridge wrapper', async () => {
  const calls = [];
  const fakeBridge = {
    setup: {
      async factoryReset() {
        calls.push('factoryReset');
        return makeBackendPayload({
          setup_complete: false,
          setup_state: {
            seen: false,
            dismissed: false,
            setup_complete: false,
            steps: {
              workspace_root: 'pending',
              local_model: 'pending',
              endpoint: 'pending',
              personality: 'pending',
              skills: 'pending',
            },
            assistant_identity: { agentName: 'Jenny', profile: 'balanced', customText: '', updatedAt: '' },
          },
        });
      },
    },
  };
  const service = createSetupService({
    windowRef: { jennyShell: fakeBridge },
    appendClientLog: () => {},
    toErrorMessage: (e) => String((e && e.message) || e),
  });

  const snapshot = await service.factoryReset();

  assert.deepEqual(calls, ['factoryReset']);
  assert.equal(snapshot.setupComplete, false);
  assert.equal(snapshot.steps.workspaceRoot, 'pending');
  assert.equal(snapshot.assistantIdentity.agentName, 'Jenny');
});

test('factory reset scene fails closed when factoryReset bridge is unavailable', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const events = [];
  const scene = createFactoryResetScene({
    setupService: {
      async reset() {
        events.push('reset');
      },
    },
    closeModal: () => events.push('close'),
    showHome: () => events.push('home'),
    showToastMessage: () => events.push('toast'),
    showShellErrorToast: (message) => events.push(['error', message]),
    appendClientLog: (_level, eventName) => events.push(['log', eventName]),
  });

  scene.mount(rootEl);
  rootEl.querySelector('[data-step-modal-action="confirm"]').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.includes('reset'), false);
  assert.equal(events.includes('toast'), false);
  assert.equal(events.includes('home'), false);
  assert.ok(events.some((entry) => Array.isArray(entry) && entry[0] === 'error'));
  scene.dispose();
});

test('reset onboarding invokes one backend transaction and reports success only after commit', async () => {
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const rootEl = dom.window.document.getElementById('root');
    const events = [];
    const scene = createFactoryResetScene({
      setupService: {
        async factoryReset() {
          events.push('factory-reset');
          return { factoryResetResult: { completed: true } };
        },
      },
      applySnapshot: () => events.push('snapshot'),
      showHome: () => events.push('home'),
      showToastMessage: () => events.push('toast'),
      closeModal: () => events.push('close'),
    });

    scene.mount(rootEl);
    rootEl.querySelector('[data-step-modal-action="confirm"]').click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(events, [
      'factory-reset', 'snapshot', 'home', 'toast', 'close',
    ]);
    scene.dispose();
    dom.window.close();
});

test('reset onboarding surfaces an incomplete backend result without success UI', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const events = [];
  const scene = createFactoryResetScene({
    setupService: {
      async factoryReset() {
        events.push('factory-reset');
        return { factoryResetResult: { completed: false, code: 'write_failed' } };
      },
    },
    showShellErrorToast: () => events.push('error'),
    appendClientLog: () => events.push('log'),
  });

  scene.mount(rootEl);
  rootEl.querySelector('[data-step-modal-action="confirm"]').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['factory-reset', 'log', 'error']);
  scene.dispose();
  dom.window.close();
});

test('workspace root scene uses existing workspace-root bridge result shapes', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const events = [];
  const scene = createWorkspaceRootScene({
    state: {},
    workspaceRootService: {
      async getState() {
        return {
          workspaceRoot: 'C:/dev/jenny',
          workspaceRootStatus: { state: 'ready', message: 'Ready.' },
        };
      },
    },
    chooseWorkspaceRoot: async () => ({
      workspaceRoot: {
        path: 'C:/dev/jenny',
        status: { state: 'ready', message: 'Ready.' },
      },
    }),
    markStep: async (step, status) => events.push(['mark', step, status]),
    closeModal: () => events.push('close'),
    showToastMessage: (message) => events.push(['toast', message]),
    showShellErrorToast: () => events.push('error'),
    appendClientLog: () => {},
  });

  scene.mount(rootEl);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rootEl.querySelector('#setup-workspace-root-path').value, 'C:/dev/jenny');
  rootEl.querySelector('[data-step-modal-action="browse"]').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    ['mark', 'workspaceRoot', 'done'],
    ['toast', 'Workspace root saved.'],
    'close',
  ]);
  scene.dispose();
  dom.window.close();
});

test('workspace root scene does not advance a blocked root transaction', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const events = [];
  const scene = createWorkspaceRootScene({
    state: {
      toolsWorkspaceRoot: 'G:/old',
      workspaceRootStatus: { state: 'ready', message: 'Ready.' },
    },
    workspaceRootService: {
      async getState() { return { workspaceRoot: 'G:/old', workspaceRootStatus: { state: 'ready' } }; },
    },
    chooseWorkspaceRoot: async () => ({
      blocked: true,
      workspaceRoot: { path: 'G:/old', status: { state: 'ready', message: 'Ready.' } },
      transition: { committed: false, blocked: true, code: 'participants_active' },
    }),
    markStep: async () => events.push('mark'),
    closeModal: () => events.push('close'),
    showToastMessage: () => events.push('toast'),
  });

  scene.mount(rootEl);
  await new Promise((resolve) => setImmediate(resolve));
  rootEl.querySelector('[data-step-modal-action="browse"]').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, []);
  scene.dispose();
  dom.window.close();
});

test('workspace root scene does not treat a failed transition over an existing ready root as success', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const events = [];
  const scene = createWorkspaceRootScene({
    state: {
      toolsWorkspaceRoot: 'G:/old',
      workspaceRootStatus: { state: 'ready', message: 'Ready.' },
    },
    workspaceRootService: {
      async getState() { return { workspaceRoot: 'G:/old', workspaceRootStatus: { state: 'ready' } }; },
    },
    chooseWorkspaceRoot: async () => ({
      committed: false,
      changed: false,
      code: 'commit_failed',
      workspaceRoot: { path: 'G:/old', status: { state: 'ready', message: 'Ready.' } },
    }),
    markStep: async () => events.push('mark'),
    closeModal: () => events.push('close'),
    showToastMessage: () => events.push('toast'),
    showShellErrorToast: () => events.push('error'),
  });

  scene.mount(rootEl);
  await new Promise((resolve) => setImmediate(resolve));
  rootEl.querySelector('[data-step-modal-action="browse"]').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, []);
  assert.match(
    rootEl.querySelector('[role="alert"]').textContent,
    /workspace root was not changed/i
  );
  scene.dispose();
  dom.window.close();
});

test('personality scene saves name, note and About you through personality.save', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const saved = [];
  let savedIdentity = null;
  dom.window.jennyShell = {
    personality: {
      async save(payload) {
        saved.push(payload);
        return { ok: true, agentName: payload.agentName, compiled: { text: '', tokensEstimate: 0 } };
      },
    },
  };
  const scene = createPersonalityScene({
    state: { assistantIdentity: { agentName: 'Jenny' } },
    windowRef: dom.window,
    applyAssistantIdentity: async (identity) => {
      savedIdentity = identity;
      return makeBackendPayload({ setup_state: { assistant_identity: identity } });
    },
    markStep: async () => {},
    closeModal: () => {},
    showToastMessage: () => {},
    showShellErrorToast: () => {},
    appendClientLog: () => {},
  });

  scene.mount(rootEl);
  assert.match(rootEl.textContent, /Personality and name/);
  assert.match(
    rootEl.textContent,
    /Give the assistant a name and say how it should sound\. You can change this any time in Settings\./
  );
  assert.equal(rootEl.querySelector('#setup-personality-custom'), null, 'the custom-text field is retired');

  // A preset pick fills the note; the wizard note starts empty so it is silent.
  const group = rootEl.querySelector('[data-inv-segmented="setup-personality-voice"]');
  assert.ok(group, 'the wizard renders the voice segmented control');
  group.dispatchEvent(new dom.window.CustomEvent('inv-segmented-change', {
    bubbles: true,
    detail: { id: 'setup-personality-voice', value: 'mentor' },
  }));
  assert.equal(rootEl.querySelector('#setup-personality-note').value, personalityForm.PRESETS.mentor);

  rootEl.querySelector('#setup-personality-name').value = 'x'.repeat(120);
  rootEl.querySelector('#setup-personality-user').value = 'Brendan. CST.';
  const saveBtn = rootEl.querySelector('[data-step-modal-action="save"]');
  assert.ok(saveBtn, 'Save button must be present in the personality scene');
  saveBtn.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(saved.length, 1);
  assert.equal(saved[0].agentName.length, 80, 'the name is clamped to 80 chars before it leaves the form');
  assert.equal(saved[0].personality, personalityForm.PRESETS.mentor);
  assert.equal(saved[0].user, 'Brendan. CST.');
  assert.deepEqual(Object.keys(savedIdentity), ['agentName']);
  scene.dispose();
  dom.window.close();
});

test('renderer setup registry is the source for step order, scene mapping, and persistence keys', () => {
  assert.equal(rendererSetupSceneUtils.SETUP_STEP_REGISTRY.length, 6);
  assert.deepEqual(
    rendererSetupSceneUtils.STEP_ORDER,
    rendererSetupSceneUtils.SETUP_STEP_REGISTRY.map((step) => step.id)
  );
  assert.equal(rendererSetupSceneUtils.STEP_SCENE.localModel, 'modelLibrary');
  assert.equal(rendererSetupSceneUtils.snakeStepKey('workspaceRoot'), 'workspace_root');
  assert.equal(rendererSetupSceneUtils.setupStepEyebrow('capabilities'), 'Setup · 6 of 6');
});

test('allStepsTerminal returns true only when every step is done or skipped', () => {
  assert.equal(allStepsTerminal({ a: 'pending', b: 'done' }), false);
  assert.equal(allStepsTerminal({ a: 'done', b: 'skipped' }), true);
  assert.equal(allStepsTerminal({ a: 'error', b: 'done' }), false);
  assert.equal(allStepsTerminal({}), false);
});

test('mergeSetupPayload preserves unspecified branches', () => {
  const base = mergeSetupPayload(null, {
    steps: { workspaceRoot: 'pending' },
    assistantIdentity: { agentName: 'Jenny', profile: 'balanced' },
  });
  const merged = mergeSetupPayload(base, {
    steps: { localModel: 'done' },
  });
  assert.equal(merged.steps.workspaceRoot, 'pending');
  assert.equal(merged.steps.localModel, 'done');
  assert.equal(merged.assistantIdentity.agentName, 'Jenny');
});

test('controller threads persistFeatureSettings into opened scenes', (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { document } = dom.window;
  let capturedDeps = null;
  const persistFeatureSettings = async () => ({ ok: true });
  const state = { setup: { steps: {} } };
  const controller = createSetupController({
    state,
    documentRef: document,
    setupService: {
      async getState() { return normalizeSetupPayload(makeBackendPayload()); },
    },
    persistFeatureSettings,
    dom: { homeSetupModalRoot: null },
    modules: {
      scenes: {
        capabilities: (deps) => {
          capturedDeps = deps;
          return { mount() {}, dispose() {} };
        },
      },
    },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });
  t.after(() => controller.dispose());

  controller.openScene('capabilities');

  assert.ok(capturedDeps, 'capabilities scene factory was invoked');
  assert.equal(capturedDeps.persistFeatureSettings, persistFeatureSettings,
    'scene receives the persistFeatureSettings closure through openScene deps');
});

test('controller seeds state.setup and routes Finish through completeSetup', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const { document } = dom.window;

  let serviceCalls = [];
  const fakeService = {
    async getState() {
      serviceCalls.push('getState');
      return normalizeSetupPayload(makeBackendPayload());
    },
    async updateState(patch) {
      serviceCalls.push({ method: 'updateState', patch });
      return normalizeSetupPayload(makeBackendPayload({
        setup_state: {
          steps: { workspace_root: 'done', local_model: 'pending', endpoint: 'pending', personality: 'pending', skills: 'pending' },
          updated_at: '2026-05-07T12:01:00.000Z',
        },
      }));
    },
    async complete() {
      serviceCalls.push('complete');
      return normalizeSetupPayload(makeBackendPayload({
        setup_complete: true,
        setup_state: {
          setup_complete: true,
          steps: { workspace_root: 'done', local_model: 'done', endpoint: 'done', personality: 'done', skills: 'done' },
        },
      }));
    },
    async reset() { return normalizeSetupPayload(makeBackendPayload()); },
    async validateEndpoint() { return { ok: true }; },
    async startOllamaPull() { return { requestId: 'req_1' }; },
    async cancelOllamaPull() { return { cancelled: true }; },
    subscribePullProgress() { return () => {}; },
  };
  const state = {};
  const controller = createSetupController({
    state,
    documentRef: document,
    setupService: fakeService,
    dom: { homeSetupModalRoot: null },
    modules: {
      scenes: {},
    },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });
  controller.bind();
  await controller.init();
  assert.equal(state.setup.loaded, true);
  assert.equal(state.setup.setupComplete, false, 'setup is incomplete on the seeded payload');
  controller.applySnapshot(normalizeSetupPayload(makeBackendPayload({
    setup_state: {
      steps: {
        workspace_root: 'done', local_model: 'done', endpoint: 'pending',
        personality: 'pending', skills: 'pending', capabilities: 'pending',
      },
      readiness: LIVE_LOCAL_READINESS,
    },
  })));
  await controller.completeSetup();
  assert.equal(state.setup.setupComplete, true);
  controller.dispose();
  dom.window.close();
});

// UIUX-005: leaving a fresh checklist persists firstRunCompleted so it does
// not auto-reopen, but unresolved steps remain untouched and setup stays false.
test('Finish later from a fresh checklist persists firstRunCompleted and leaves setup incomplete', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const { document } = dom.window;

  const calls = [];
  const fakeService = {
    async getState() { return normalizeSetupPayload(makeBackendPayload()); }, // firstRunCompleted defaults false
    async updateState(patch) {
      calls.push({ method: 'updateState', patch });
      return normalizeSetupPayload(makeBackendPayload({
        setup_state: {
          first_run_completed: true,
          steps: makeBackendPayload().setup_state.steps,
        },
      }));
    },
    async complete() {
      calls.push('complete');
      return normalizeSetupPayload(makeBackendPayload({ setup_complete: true, setup_state: { setup_complete: true } }));
    },
    async reset() { return normalizeSetupPayload(makeBackendPayload()); },
    subscribePullProgress() { return () => {}; },
  };

  let finishHub = null;
  function mockSceneFactory(deps) {
    finishHub = deps.finish;
    return { mount() {}, dispose() {} };
  }

  const state = {};
  const controller = createSetupController({
    state,
    documentRef: document,
    setupService: fakeService,
    dom: { homeSetupModalRoot: null },
    modules: {
      setupHub: { createSetupHub },
      scenes: { setupHub: mockSceneFactory },
    },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });
  controller.bind();
  await controller.init();

  assert.equal(typeof finishHub, 'function');
  await finishHub({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const firstRunPersisted = calls.find(
    (c) => c && c.method === 'updateState' && c.patch && c.patch.firstRunCompleted === true
  );
  assert.ok(firstRunPersisted, 'firstRunCompleted persisted on Finish later');
  const skipMarks = calls.filter((c) => c && c.method === 'updateState' && c.patch && c.patch.steps);
  assert.equal(skipMarks.length, 0, 'Finish later leaves every checklist step untouched');
  assert.ok(!calls.includes('complete'), 'backend complete() must not fire when required steps are unresolved');
  const setupCompleteFalsePersisted = calls.find(
    (c) => c && c.method === 'updateState' && c.patch && c.patch.setupComplete === false
  );
  assert.ok(setupCompleteFalsePersisted, 'setupComplete explicitly persisted false instead of left stale-true');
  assert.equal(state.setup.setupComplete, false, 'renderer state reflects an incomplete setup after Finish later');

  controller.dispose();
  dom.window.close();
});

test('controller does not start the setup hub for returning users (firstRunCompleted true)', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { document } = dom.window;

  let hubStarted = false;
  const fakeService = {
    async getState() {
      return normalizeSetupPayload(makeBackendPayload({ setup_state: { first_run_completed: true } }));
    },
    async updateState() {
      return normalizeSetupPayload(makeBackendPayload({ setup_state: { first_run_completed: true } }));
    },
    subscribePullProgress() { return () => {}; },
  };

  const state = {};
  const controller = createSetupController({
    state,
    documentRef: document,
    setupService: fakeService,
    dom: { homeSetupModalRoot: null },
    modules: {
      setupHub: { createSetupHub: () => { hubStarted = true; return { start() {}, dispose() {} }; } },
      scenes: {},
    },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });
  controller.bind();
  await controller.init();

  assert.equal(hubStarted, false, 'setup hub must not start for returning users');
  assert.equal(state.setup.setupComplete, false, 'setup stays incomplete for the returning user');

  controller.dispose();
  dom.window.close();
});

test('controller refreshes when backend readiness changes without updatedAt changing', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { document } = dom.window;
  const pendingPayload = makeBackendPayload({
    setup_state: {
      updated_at: '2026-05-07T12:00:00.000Z',
      readiness: {
        local_model: { ready: false, source: 'runtime_probe_unavailable' },
      },
    },
  });
  const readyPayload = makeBackendPayload({
    setup_state: {
      updated_at: '2026-05-07T12:00:00.000Z',
      steps: {
        workspace_root: 'pending',
        local_model: 'done',
        endpoint: 'pending',
        personality: 'pending',
        skills: 'pending',
      },
      readiness: {
        local_model: { ready: true, source: 'runtime_probe', model_count: 1 },
      },
    },
  });
  let getStateCount = 0;
  const fakeService = {
    async getState() {
      getStateCount += 1;
      return normalizeSetupPayload(getStateCount === 1 ? pendingPayload : readyPayload);
    },
  };
  const state = {};
  const controller = createSetupController({
    state,
    documentRef: document,
    setupService: fakeService,
    dom: { homeSetupModalRoot: null },
    modules: {
      scenes: {},
    },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });

  await controller.init();
  controller.applyBackendStatus(readyPayload);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getStateCount, 2);
  assert.equal(state.setup.steps.localModel, 'done');
  assert.equal(state.setup.readiness.localModel.ready, true);
  controller.dispose();
  dom.window.close();
});

// --- UIUX-005: computeSetupHealth (services/shell-config-setup-state.js) ---

test('computeSetupHealth: all pending -> pending, nothing required resolved', () => {
  const health = computeSetupHealth({ steps: {} });
  assert.equal(health.state, 'pending');
  assert.deepEqual(health.pendingSteps.sort(), ['model', 'workspaceRoot']);
  assert.deepEqual(health.skippedSteps, []);
});

test('computeSetupHealth: workspaceRoot + localModel done -> complete regardless of optional steps', () => {
  const health = computeSetupHealth({
    steps: { workspaceRoot: 'done', localModel: 'done', endpoint: 'pending', personality: 'pending', skills: 'pending', capabilities: 'pending' },
  });
  assert.equal(health.state, 'complete');
  assert.deepEqual(health.pendingSteps, []);
  assert.deepEqual(health.skippedSteps, []);
});

test('computeSetupHealth: workspaceRoot + endpoint done (no localModel) -> complete', () => {
  const health = computeSetupHealth({
    steps: { workspaceRoot: 'done', localModel: 'pending', endpoint: 'done' },
  });
  assert.equal(health.state, 'complete');
});

test('computeSetupHealth: a skip-through (workspaceRoot + both model paths skipped) -> degraded, not complete', () => {
  const health = computeSetupHealth({
    steps: { workspaceRoot: 'skipped', localModel: 'skipped', endpoint: 'skipped' },
  });
  assert.equal(health.state, 'degraded');
  assert.deepEqual(health.pendingSteps, []);
  assert.deepEqual(health.skippedSteps, ['workspaceRoot', 'model']);
});

test('computeSetupHealth: workspaceRoot done, model still pending (only one path skipped) -> pending, not degraded', () => {
  const health = computeSetupHealth({
    steps: { workspaceRoot: 'done', localModel: 'skipped', endpoint: 'pending' },
  });
  assert.equal(health.state, 'pending', 'an unresolved alternate path keeps the requirement open, not "skipped"');
  assert.deepEqual(health.pendingSteps, ['model']);
});

test('computeSetupHealth: an error status on the only unresolved required step counts as pending, not a crash', () => {
  const health = computeSetupHealth({
    steps: { workspaceRoot: 'error', localModel: 'pending', endpoint: 'pending' },
  });
  assert.equal(health.state, 'pending');
  assert.ok(health.pendingSteps.includes('workspaceRoot'));
});

test('computeSetupHealth: malformed/missing steps map does not crash and reports pending', () => {
  assert.doesNotThrow(() => computeSetupHealth(null));
  assert.doesNotThrow(() => computeSetupHealth({}));
  assert.doesNotThrow(() => computeSetupHealth({ steps: 'not-an-object' }));
  assert.doesNotThrow(() => computeSetupHealth({ steps: ['array', 'not', 'object'] }));
  assert.equal(computeSetupHealth(undefined).state, 'pending');
  assert.equal(computeSetupHealth({ steps: null }).state, 'pending');
});

test('computeSetupHealth: an old buggy-path snapshot (setupComplete:true but steps pending) still reports pending/degraded from step truth', () => {
  // Regression for the exact UIUX-005 bug: setupComplete was persisted true
  // unconditionally by the old finishLinearFlow. computeSetupHealth ignores
  // that stale flag entirely and looks only at the steps map.
  const health = computeSetupHealth({
    setupComplete: true,
    steps: { workspaceRoot: 'pending', localModel: 'pending', endpoint: 'pending' },
  });
  assert.notEqual(health.state, 'complete');
});

test('renderer scene-utils computeSetupHealth matches the services twin on the same inputs', () => {
  const samples = [
    { steps: {} },
    { steps: { workspaceRoot: 'done', localModel: 'done' } },
    { steps: { workspaceRoot: 'skipped', localModel: 'skipped', endpoint: 'skipped' } },
    { steps: { workspaceRoot: 'done', localModel: 'skipped', endpoint: 'pending' } },
  ];
  for (const sample of samples) {
    assert.deepEqual(
      rendererSetupSceneUtils.computeSetupHealth(sample),
      computeSetupHealth(sample),
      `mismatch for ${JSON.stringify(sample)}`
    );
  }
});

// renderSetupSettingsRow health-truth coverage lives in
// tests/renderer-setup-controller-flow.test.js (file-size headroom).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSetupHub } = require('../renderer/features/renderer-setup-hub');
const { createSetupController } = require('../renderer/features/renderer-setup-controller');
const { createScene: createSetupHubScene } = require('../renderer/features/setup-scenes/scene-setup-hub');
const sceneUtils = require('../renderer/features/setup-scenes/scene-utils');
const { normalizeSetupPayload } = require('../renderer/services/renderer-setup-service');
const inventoryStepModal = require('../renderer/inventory/step-modal');
const { createShellServiceRegistry } = require('../renderer/shell/renderer-shell-service-registry');

const DEFAULT_STEPS = {
  workspace_root: 'pending', local_model: 'pending', endpoint: 'pending',
  personality: 'pending', skills: 'pending', capabilities: 'pending',
};

function payload({ steps = DEFAULT_STEPS, firstRunCompleted = false, setupComplete = false, completedAt = '',
  readiness = {}, workspaceRoot = '', agentName = 'Jenny', preferredLocalModel = '' } = {}) {
  return normalizeSetupPayload({
    setup_complete: setupComplete,
    setup_state: {
      first_run_completed: firstRunCompleted,
      setup_complete: setupComplete,
      completed_at: completedAt,
      steps: { ...steps },
      readiness,
      tools_workspace_root: workspaceRoot,
      tools_workspace_root_configured: Boolean(workspaceRoot),
      assistant_identity: { agent_name: agentName, profile: 'balanced' },
      preferred_local_model: preferredLocalModel,
    },
  });
}

function settle() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

function buildHarness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="appShell"></div><div id="homeSetupModalRoot"></div></body></html>');
  const { document } = dom.window;
  const patches = [];
  const views = [];
  const sceneDeps = {};
  const mounts = [];
  const logs = [];
  const disposals = [];
  let snapshot = payload(options);
  let completeCalls = 0;
  let releaseCompleteDelay = null;
  const completeDelay = options.completeDelay
    ? new Promise((resolve) => { releaseCompleteDelay = resolve; })
    : null;
  const state = {};
  const setupService = {
    async getState() { return snapshot; },
    async updateState(patch) {
      patches.push(patch);
      if (options.updateStateReject) throw new Error('update failed');
      const nextSteps = { ...DEFAULT_STEPS };
      Object.entries(snapshot.steps || {}).forEach(([key, value]) => {
        nextSteps[sceneUtils.snakeStepKey(key)] = value;
      });
      Object.assign(nextSteps, patch.steps || {});
      snapshot = payload({
        steps: nextSteps,
        firstRunCompleted: patch.firstRunCompleted === true || snapshot.firstRunCompleted,
        setupComplete: patch.setupComplete === false ? false : snapshot.setupComplete,
        completedAt: snapshot.completedAt,
        readiness: options.readiness || {},
        workspaceRoot: options.workspaceRoot || '',
        agentName: options.agentName || 'Jenny',
        preferredLocalModel: options.preferredLocalModel || '',
      });
      return snapshot;
    },
    async complete() {
      completeCalls += 1;
      if (completeDelay) await completeDelay;
      if (completeCalls <= Number(options.completeRefusals || 0)) {
        snapshot = payload({ ...options, setupComplete: false });
        return snapshot;
      }
      snapshot = payload({
        ...options,
        firstRunCompleted: true,
        setupComplete: true,
        completedAt: '2026-08-31T12:00:00.000Z',
      });
      return snapshot;
    },
    detectOllama: options.detectOllama || (async () => ({ installed: false, running: false, version: '' })),
  };
  const factoryFor = (name) => (deps) => {
    sceneDeps[name] = deps;
    return {
      mount(rootElement) {
        mounts.push(name);
        rootElement.innerHTML = '<div data-test-setup-scene="' + name + '">' + name + '</div>';
      },
      dispose() { disposals.push(name); },
    };
  };
  const scenes = { setupHub: createSetupHubScene };
  Object.entries(sceneUtils.STEP_SCENE).forEach(([, sceneName]) => { scenes[sceneName] = factoryFor(sceneName); });
  const controller = createSetupController({
    state,
    documentRef: document,
    setupService,
    dom: { homeSetupModalRoot: document.getElementById('homeSetupModalRoot') },
    modules: options.omitHub
      ? { scenes: {}, stepModal: inventoryStepModal }
      : { setupHub: { createSetupHub }, scenes, stepModal: inventoryStepModal },
    callbacks: {
      appendClientLog(level, event, detail) { logs.push({ level, event, detail }); },
      showShellErrorToast() {}, showToastMessage() {},
      setActiveView(view) { views.push(view); },
    },
  });
  controller.bind();
  t.after(() => { controller.dispose(); dom.window.close(); });
  return {
    controller, document, root: document.getElementById('homeSetupModalRoot'),
    patches, views, sceneDeps, mounts, disposals, setupService, state, logs,
    releaseComplete() {
      if (!releaseCompleteDelay) return;
      var release = releaseCompleteDelay;
      releaseCompleteDelay = null;
      release();
    },
    get completeCalls() { return completeCalls; },
  };
}

test('shell registry gates the hub factories but always registers standalone model scenes', () => {
  const ollamaEngine = () => {};
  const modelLibrary = () => {};
  function captureModules(enabled) {
    let captured = null;
    const registry = createShellServiceRegistry({
      state: { features: { featureFlags: { setup_hub: enabled } } },
      modules: {
        setupServiceUtils: { createSetupService() { return {}; } },
        setupControllerUtils: {
          createSetupController(deps) {
            captured = deps.modules;
            return { bind() {}, dispose() {} };
          },
        },
        setupHubUtils: { createSetupHub },
        setupSceneFactories: { setupHub: createSetupHubScene, ollamaEngine, modelLibrary },
      },
    });
    registry.ensureSetupController();
    return captured;
  }

  const enabled = captureModules(true);
  assert.equal(enabled.setupHub.createSetupHub, createSetupHub);
  assert.equal(enabled.scenes.setupHub, createSetupHubScene);
  assert.equal(enabled.scenes.ollamaEngine, ollamaEngine);
  assert.equal(enabled.scenes.modelLibrary, modelLibrary);

  const disabled = captureModules(false);
  assert.deepEqual(disabled.setupHub, {});
  assert.equal(disabled.scenes.setupHub, undefined);
  assert.equal(disabled.scenes.ollamaEngine, ollamaEngine);
  assert.equal(disabled.scenes.modelLibrary, modelLibrary);
});

test('checklist renders every registry step in order and marks exactly the required specs', async (t) => {
  const h = buildHarness(t, { workspaceRoot: 'C:/dev/jenny', agentName: 'June', preferredLocalModel: 'qwen3:8b' });
  await h.controller.init();

  const rows = [...h.root.querySelectorAll('[data-setup-step-id]')];
  assert.deepEqual(rows.map((row) => row.dataset.setupStepId), sceneUtils.STEP_ORDER);
  assert.deepEqual(rows.filter((row) => row.querySelector('.setup-hub-required')).map((row) => row.dataset.setupStepId),
    ['workspaceRoot', 'localModel']);
  assert.match(rows[0].textContent, /C:\/dev\/jenny/);
  assert.match(rows[1].textContent, /qwen3:8b/);
  assert.match(rows[3].textContent, /June/);
});

test('hub opens standalone steps in any order and their close override returns to the checklist', async (t) => {
  const h = buildHarness(t);
  await h.controller.init();

  h.root.querySelector('[data-action="openStep"][data-step-id="personality"]').click();
  assert.deepEqual(h.mounts, ['personality']);
  h.sceneDeps.personality.closeModal();
  assert.ok(h.root.querySelector('[data-setup-step-id="workspaceRoot"]'));

  h.root.querySelector('[data-action="openStep"][data-step-id="endpoint"]').click();
  assert.deepEqual(h.mounts, ['personality', 'endpoint']);
});

test('per-step skip patches one step, rerenders it, and leaves every other step untouched', async (t) => {
  const h = buildHarness(t);
  await h.controller.init();

  h.root.querySelector('[data-action="skipStep"][data-step-id="personality"]').click();
  await settle();

  assert.deepEqual(h.patches, [{ steps: { personality: 'skipped' } }]);
  assert.match(h.root.querySelector('[data-setup-step-id="personality"]').textContent, /Skipped/);
  for (const stepId of sceneUtils.STEP_ORDER.filter((id) => id !== 'personality')) {
    assert.equal(h.root.querySelector(`[data-setup-step-id="${stepId}"] .setup-hub-glyph`).getAttribute('aria-label'), 'Pending');
  }
});

test('synchronous double-click on Skip persists exactly one step patch', async (t) => {
  const h = buildHarness(t);
  await h.controller.init();

  const skip = h.root.querySelector('[data-action="skipStep"][data-step-id="personality"]');
  skip.click();
  skip.click();
  await settle();

  assert.deepEqual(h.patches, [{ steps: { personality: 'skipped' } }]);
});

test('failed skip persistence keeps the row pending and logs a handled warning', async (t) => {
  const h = buildHarness(t, { updateStateReject: true });
  await h.controller.init();

  h.root.querySelector('[data-action="skipStep"][data-step-id="personality"]').click();
  await settle();

  assert.equal(h.root.querySelector('[data-setup-step-id="personality"] .setup-hub-glyph').getAttribute('aria-label'), 'Pending');
  assert.ok(h.logs.some((entry) => entry.level === 'WARN' && entry.event === 'setup.hub_action_failed'));
});

for (const [name, detectOllama, expected, expectAction] of [
  ['running', async () => ({ installed: true, running: true, version: '0.6.8' }), /Running v0\.6\.8/, false],
  ['upgrade required', async () => ({ installed: true, running: true, version: '0.1.0', upgradeRequired: true }), /Update required/, true],
  ['not running', async () => ({ installed: true, running: false, version: '0.6.8' }), /Not running/, true],
  ['not installed', async () => ({ installed: false, running: false, version: '' }), /Not installed/, true],
  ['rejected', async () => { throw new Error('probe failed'); }, /Not detected/, true],
]) {
  test(`Local engine derived row tolerates ${name} detection`, async (t) => {
    const h = buildHarness(t, { detectOllama });
    await h.controller.init();
    await settle();
    const row = h.root.querySelector('[data-setup-derived="local-engine"]');
    assert.match(row.textContent, expected);
    assert.equal(Boolean(row.querySelector('[data-action="openStep"]')), expectAction);
  });
}

test('Local engine action targets localEngine and mounts the Ollama engine gate', async (t) => {
  const h = buildHarness(t);
  await h.controller.init();
  await settle();

  const action = h.root.querySelector('[data-setup-derived="local-engine"] [data-action="openStep"]');
  assert.ok(action);
  assert.equal(action.dataset.stepId, 'localEngine');
  action.click();
  assert.deepEqual(h.mounts, ['ollamaEngine']);

  h.sceneDeps.ollamaEngine.closeModal();
  assert.ok(h.root.querySelector('[data-setup-derived="local-engine"]'));
});

test('footer health reports complete and Finish setup calls the completion service', async (t) => {
  const ready = {
    workspace_root: { ready: true, configured: true },
    local_model: { ready: true, model_count: 1 },
  };
  const h = buildHarness(t, {
    steps: { ...DEFAULT_STEPS, workspace_root: 'done', local_model: 'done' }, readiness: ready,
  });
  await h.controller.init();
  assert.match(h.root.querySelector('.setup-hub-health').textContent, /2 of 2 required steps complete/);

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  await settle();
  assert.equal(h.completeCalls, 1);
  assert.equal(h.state.setup.setupComplete, true);
});

test('degraded finish gate names the workspace consequence, opens the fix, and Finish anyway stays incomplete', async (t) => {
  const h = buildHarness(t);
  await h.controller.init();
  assert.match(h.root.querySelector('.setup-hub-health').textContent, /0 of 2 required steps complete/);

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  assert.match(h.root.querySelector('.setup-hub-finish-warning').textContent,
    /No workspace root set — file tools will be off until you set one\./);
  h.root.querySelector('[data-action="fixRequired"]').click();
  assert.deepEqual(h.mounts, ['workspaceRoot']);
  h.sceneDeps.workspaceRoot.closeModal();

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  h.root.querySelector('[data-action="finishAnyway"]').click();
  await settle();
  assert.ok(h.patches.some((patch) => patch.firstRunCompleted === true));
  assert.ok(h.patches.some((patch) => patch.setupComplete === false));
  assert.equal(h.completeCalls, 0);
});

test('finish gate names the local-chat consequence when only model access is unresolved', async (t) => {
  const h = buildHarness(t, {
    steps: { ...DEFAULT_STEPS, workspace_root: 'done' },
    workspaceRoot: 'C:/dev/jenny',
  });
  await h.controller.init();
  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();

  const warning = h.root.querySelector('.setup-hub-finish-warning');
  assert.match(warning.textContent, /No model configured — chats can't run locally\./);
  assert.equal(warning.querySelector('[data-action="fixRequired"]').dataset.stepId, 'localModel');
  assert.match(warning.querySelector('[data-action="fixRequired"]').textContent, /Configure model/);
});

test('Escape dismisses finishGateCancel before it reaches Finish later', async (t) => {
  const h = buildHarness(t);
  await h.controller.init();
  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();

  h.document.dispatchEvent(new h.document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.root.querySelector('.setup-hub-finish-warning'), null);
  assert.equal(h.patches.length, 0);

  h.document.dispatchEvent(new h.document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  assert.ok(h.patches.some((patch) => patch.firstRunCompleted === true));
});

test('resumeSetup is idempotent while the hub is active', async (t) => {
  const h = buildHarness(t, { firstRunCompleted: true });
  await h.controller.init();
  h.controller.resumeSetup();
  const firstHub = h.root.querySelector('[data-step-modal="setup-hub"]');
  h.controller.resumeSetup();

  assert.equal(h.root.querySelector('[data-step-modal="setup-hub"]'), firstHub);
  assert.deepEqual(h.views, ['home', 'home']);
});

test('stale empty readiness does not block the backend-authoritative finish attempt', async (t) => {
  // The renderer keeps the stale empty readiness snapshot from app init, while
  // complete() models the backend fresh-probe success.
  const h = buildHarness(t, {
    steps: { ...DEFAULT_STEPS, workspace_root: 'done', local_model: 'done' },
  });
  await h.controller.init();
  assert.match(h.root.querySelector('.setup-hub-health').textContent, /2 of 2 required steps complete/);

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  await settle();

  assert.equal(h.completeCalls, 1, 'the backend completion service is authoritative');
  assert.equal(h.root.querySelector('[data-step-modal="setup-hub"]'), null, 'the setup hub closes');
  assert.equal(h.views.at(-1), 'home', 'the app returns home');
  assert.equal(h.state.setup.setupComplete, true);
});

test('rapid finish clicks coalesce while the backend readiness check is in flight', async (t) => {
  const h = buildHarness(t, {
    steps: { ...DEFAULT_STEPS, workspace_root: 'done', local_model: 'done' },
    completeDelay: true,
  });
  await h.controller.init();

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  const busyFinish = h.root.querySelector('[data-step-modal-action="finishSetup"]');
  busyFinish.click();

  assert.equal(h.completeCalls, 1);
  assert.equal(busyFinish.disabled, true);
  assert.match(busyFinish.textContent, /Checking/);

  h.releaseComplete();
  await settle();
});

test('a completed finish attempt cannot close a step scene that replaced the hub', async (t) => {
  const h = buildHarness(t, {
    steps: { ...DEFAULT_STEPS, workspace_root: 'done', local_model: 'done' },
    completeDelay: true,
  });
  await h.controller.init();

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  h.root.querySelector('[data-action="openStep"][data-step-id="personality"]').click();
  assert.deepEqual(h.mounts, ['personality']);
  assert.ok(h.root.querySelector('[data-test-setup-scene="personality"]'));

  h.releaseComplete();
  await settle();

  assert.deepEqual(h.mounts, ['personality']);
  assert.equal(h.disposals.includes('personality'), false);
  assert.ok(h.root.querySelector('[data-test-setup-scene="personality"]'));

  h.sceneDeps.personality.closeModal();
  assert.ok(h.root.querySelector('[data-step-modal="setup-hub"]'));
});

test('backend refusal keeps the hub open with fresh model-readiness guidance', async (t) => {
  const h = buildHarness(t, {
    steps: { ...DEFAULT_STEPS, workspace_root: 'done', local_model: 'done' },
    completeRefusals: 1,
  });
  await h.controller.init();

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  await settle();

  assert.equal(h.completeCalls, 1);
  assert.ok(h.root.querySelector('[data-step-modal="setup-hub"]'), 'the hub remains mounted');
  const warning = h.root.querySelector('.setup-hub-finish-warning');
  assert.match(warning.textContent, /can't reach a model right now/);
  const fix = warning.querySelector('[data-action="fixRequired"]');
  assert.equal(fix.dataset.stepId, 'localEngine');
  assert.match(fix.textContent, /Check local engine/);

  fix.click();
  assert.deepEqual(h.mounts, ['ollamaEngine']);
});

test('a refused finish can be retried and completed after backend readiness recovers', async (t) => {
  const h = buildHarness(t, {
    steps: { ...DEFAULT_STEPS, workspace_root: 'done', local_model: 'done' },
    completeRefusals: 1,
  });
  await h.controller.init();

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  await settle();
  assert.equal(h.completeCalls, 1);
  assert.ok(h.root.querySelector('.setup-hub-finish-warning'));

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  await settle();

  assert.equal(h.completeCalls, 2);
  assert.equal(h.root.querySelector('[data-step-modal="setup-hub"]'), null);
  assert.equal(h.state.setup.setupComplete, true);
});

test('flag-off Run-setup-again is not auto-finished out from under the user', async (t) => {
  // JENNY_ENABLE_SETUP_HUB=0: no hub factory is registered, so resumeSetup()
  // cannot stand the auto-finish down by assigning activeFlow. The one-shot
  // stand-down ticket must cover the same microtask instead.
  const ready = {
    workspace_root: { ready: true, configured: true },
    local_model: { ready: true, model_count: 1 },
  };
  const allDone = {
    workspace_root: 'done', local_model: 'done', endpoint: 'done',
    personality: 'done', skills: 'done', capabilities: 'done',
  };
  const h = buildHarness(t, {
    omitHub: true, steps: allDone, readiness: ready, firstRunCompleted: true, setupComplete: true,
  });
  await h.controller.init();
  await settle();
  assert.equal(h.completeCalls, 0, 'nothing to finish: it was already complete');

  // Replays handleRunSetupAgain's ordering exactly: reset snapshot, then Resume.
  h.controller.applySnapshot(payload({
    steps: allDone, readiness: ready, firstRunCompleted: true, setupComplete: false,
  }));
  h.controller.resumeSetup();
  await settle();

  assert.equal(h.completeCalls, 0, 'the auto-finish stood down for the flag-off Resume');
  assert.equal(h.state.setup.setupComplete, false, 'the reset the user asked for survives');
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSetupHub } = require('../renderer/features/renderer-setup-hub');
const { createSetupController } = require('../renderer/features/renderer-setup-controller');
const { createScene: createSetupHubScene } = require('../renderer/features/setup-scenes/scene-setup-hub');
const { createShellServiceRegistry } = require('../renderer/shell/renderer-shell-service-registry');

const { DEFAULT_STEPS, payload, settle, buildHarness, MODEL_LOADED_PROBE } = require('./helpers/setup-hub-harness');

test('shell registry registers the hub factories and the standalone model scenes', () => {
  const ollamaEngine = () => {};
  const modelLibrary = () => {};
  function captureModules() {
    let captured = null;
    const registry = createShellServiceRegistry({
      state: {},
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

  const enabled = captureModules();
  assert.equal(enabled.setupHub.createSetupHub, createSetupHub);
  assert.equal(enabled.scenes.setupHub, createSetupHubScene);
  assert.equal(enabled.scenes.ollamaEngine, ollamaEngine);
  assert.equal(enabled.scenes.modelLibrary, modelLibrary);
});

test('hub labels stay local while workspace and personality retain their values', async (t) => {
  const h = buildHarness(t, { workspaceRoot: 'C:/dev/jenny', agentName: 'June', preferredLocalModel: 'qwen3:8b' });
  await h.controller.init();
  const rows = [...h.root.querySelectorAll('[data-setup-step-id]')];
  assert.deepEqual(rows.map(row => row.dataset.setupStepId), ['workspaceRoot', 'personality', 'skills', 'capabilities']);
  assert.equal(h.root.querySelector('.setup-hub-required'), null);
  assert.match(rows[0].textContent, /C:\/dev\/jenny/);
  assert.match(rows[1].querySelector('.setup-hub-row-title').textContent, /June/);
});

test('hub step numbers follow the rendered row order', async (t) => {
  const h = buildHarness(t);
  await h.controller.init();
  const glyphs = [...h.root.querySelectorAll('.setup-hub-list > .setup-hub-row .setup-hub-glyph')];
  assert.deepEqual(glyphs.map((glyph) => glyph.textContent), ['1', '2', '3', '4', '5']);
});

test('hub opens standalone steps in any order and their close override returns to the checklist', async (t) => {
  const h = buildHarness(t);
  await h.controller.init();

  h.root.querySelector('[data-action="openStep"][data-step-id="personality"]').click();
  assert.deepEqual(h.mounts, ['personality']);
  h.sceneDeps.personality.closeModal();
  assert.ok(h.root.querySelector('[data-setup-step-id="workspaceRoot"]'));

  h.root.querySelector('input[value="endpoint"]').click();
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
  for (const stepId of ['workspaceRoot', 'skills', 'capabilities']) {
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

for (const [name, detectOllama, expected, expectedStep] of [
  ['running', async () => ({ installed: true, running: true, version: '0.6.8' }), /Running v0\.6\.8/, 'localModel'],
  ['upgrade required', async () => ({ installed: true, running: true, version: '0.1.0', upgradeRequired: true }), /Update required/, 'localEngine'],
  ['not running', async () => ({ installed: true, running: false, version: '0.6.8' }), /Not running/, 'localEngine'],
  ['not installed', async () => ({ installed: false, running: false, version: '' }), /Not installed/, 'localEngine'],
  ['rejected', async () => { throw new Error('probe failed'); }, /Not detected/, 'localModel'],
]) {
  test(`Model route status tolerates ${name} detection`, async (t) => {
    const h = buildHarness(t, { detectOllama });
    await h.controller.init();
    await settle();
    const row = h.root.querySelector('[data-setup-model-route]');
    assert.match(row.textContent, expected);
    assert.equal(row.querySelector('[data-action="openStep"]').dataset.stepId, expectedStep);
  });
}

test('Local engine action targets localEngine and mounts the Ollama engine gate', async (t) => {
  const h = buildHarness(t);
  await h.controller.init();
  await settle();

  const action = h.root.querySelector('[data-setup-model-route] [data-action="openStep"]');
  assert.ok(action);
  assert.equal(action.dataset.stepId, 'localEngine');
  action.click();
  assert.deepEqual(h.mounts, ['ollamaEngine']);

  h.sceneDeps.ollamaEngine.closeModal();
  assert.ok(h.root.querySelector('[data-setup-model-route]'));
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
  assert.match(h.root.querySelector('.setup-hub-health').textContent, /Start Ollama to chat/);

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  await settle();
  assert.equal(h.completeCalls, 1);
  assert.equal(h.state.setup.setupComplete, true);
});

test('degraded finish gate names the workspace consequence, opens the fix, and Finish anyway stays incomplete', async (t) => {
  const h = buildHarness(t);
  await h.controller.init();
  assert.match(h.root.querySelector('.setup-hub-health').textContent, /Choose a model route to start chatting \u00b7 file tools need a folder/);

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  await settle();
  assert.match(h.root.querySelector('.setup-hub-finish-warning').textContent,
    /No workspace root set — file tools will be off until you set one\./);
  h.root.querySelector('[data-action="fixRequired"]').click();
  assert.deepEqual(h.mounts, ['workspaceRoot']);
  h.sceneDeps.workspaceRoot.closeModal();

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  await settle();
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
  await settle();

  const warning = h.root.querySelector('.setup-hub-finish-warning');
  assert.match(warning.textContent, /No model configured — chats can't run locally\./);
  assert.equal(warning.querySelector('[data-action="fixRequired"]').dataset.stepId, 'localEngine');
  assert.match(warning.querySelector('[data-action="fixRequired"]').textContent, /Configure model/);
});

test('Escape dismisses finishGateCancel before it reaches Finish later', async (t) => {
  const h = buildHarness(t);
  await h.controller.init();
  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  await settle();

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
  assert.match(h.root.querySelector('.setup-hub-health').textContent, /Start Ollama to chat/);

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
  assert.match(fix.textContent, /Check Ollama/);

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

test('the hub re-probes on open and shows the model step an active model already satisfies', async (t) => {
  const h = buildHarness(t, {
    steps: { ...DEFAULT_STEPS, workspace_root: 'done' },
    workspaceRoot: 'C:/dev/jenny',
    freshProbe: MODEL_LOADED_PROBE,
  });
  await h.controller.init();
  await settle();

  assert.ok(h.getStateCalls >= 2, 'the hub asked the backend for a fresh probe');
  assert.match(h.root.querySelector('.setup-hub-health').textContent, /Start Ollama to chat/);
  const modelRow = h.root.querySelector('[data-setup-model-route]');
  assert.equal(modelRow.querySelector('.setup-hub-glyph').getAttribute('aria-label'), 'Done');
});

test('Finish setup re-probes a stale snapshot and completes once an active model satisfies the step', async (t) => {
  const h = buildHarness(t, {
    steps: { ...DEFAULT_STEPS, workspace_root: 'done' },
    workspaceRoot: 'C:/dev/jenny',
    freshProbe: MODEL_LOADED_PROBE,
    // init and the on-open refresh both predate the model load.
    freshProbeAfterCalls: 2,
  });
  await h.controller.init();
  await settle();
  assert.match(h.root.querySelector('.setup-hub-health').textContent, /Choose a model route to start chatting/);

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  await settle();

  assert.equal(h.root.querySelector('.setup-hub-finish-warning'), null, 'no "Setup is not ready" gate');
  assert.equal(h.completeCalls, 1);
  assert.equal(h.state.setup.setupComplete, true);
});

test('Finish setup still gates when the fresh probe finds no model', async (t) => {
  const h = buildHarness(t, {
    steps: { ...DEFAULT_STEPS, workspace_root: 'done' },
    workspaceRoot: 'C:/dev/jenny',
  });
  await h.controller.init();
  await settle();
  const callsBeforeFinish = h.getStateCalls;

  h.root.querySelector('[data-step-modal-action="finishSetup"]').click();
  await settle();

  assert.equal(h.getStateCalls, callsBeforeFinish + 1, 'Finish setup re-probed once');
  assert.match(h.root.querySelector('.setup-hub-finish-warning').textContent, /No model configured/);
  assert.equal(h.completeCalls, 0);
});

test('completeSetup re-probes a stale snapshot before refusing, then completes', async (t) => {
  const h = buildHarness(t, {
    omitHub: true,
    steps: { ...DEFAULT_STEPS, workspace_root: 'done' },
    workspaceRoot: 'C:/dev/jenny',
    freshProbe: MODEL_LOADED_PROBE,
  });
  await h.controller.init();
  assert.equal(h.getStateCalls, 1);

  await h.controller.completeSetup();

  assert.equal(h.getStateCalls, 2, 'completeSetup asked for a fresh probe');
  assert.equal(h.completeCalls, 1);
  assert.equal(h.state.setup.setupComplete, true);
  assert.equal(h.logs.some((entry) => entry.event === 'setup.complete_blocked'), false);
});

test('a rerender from the on-open probe keeps focus on the control the user was on', async (t) => {
  const h = buildHarness(t, {
    steps: { ...DEFAULT_STEPS, workspace_root: 'done' },
    workspaceRoot: 'C:/dev/jenny',
    freshProbe: MODEL_LOADED_PROBE,
    holdFreshProbe: true,
  });
  await h.controller.init();
  await new Promise((resolve) => setTimeout(resolve, 5));
  h.root.querySelector('[data-action="openStep"][data-step-id="personality"]').focus();

  h.releaseFreshProbe();
  await settle();

  assert.match(h.root.querySelector('.setup-hub-health').textContent, /Start Ollama to chat/);
  const focused = h.document.activeElement;
  assert.equal(focused.getAttribute('data-action'), 'openStep');
  assert.equal(focused.getAttribute('data-step-id'), 'personality');
});

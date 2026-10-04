/* Shared setup-hub test harness: payload builder, settle and the controller harness. */
const { JSDOM } = require('jsdom');

const { createSetupHub } = require('../../renderer/features/renderer-setup-hub');
const { createSetupController } = require('../../renderer/features/renderer-setup-controller');
const { createScene: createSetupHubScene } = require('../../renderer/features/setup-scenes/scene-setup-hub');
const sceneUtils = require('../../renderer/features/setup-scenes/scene-utils');
const { normalizeSetupPayload } = require('../../renderer/services/renderer-setup-service');
const inventoryStepModal = require('../../renderer/inventory/step-modal');

const DEFAULT_STEPS = {
  workspace_root: 'pending', local_model: 'pending', endpoint: 'pending',
  personality: 'pending', skills: 'pending', capabilities: 'pending',
};

function payload({ steps = DEFAULT_STEPS, firstRunCompleted = false, setupComplete = false, completedAt = '',
  readiness = {}, workspaceRoot = '', agentName = 'Jenny', preferredLocalModel = '' } = {}) {
  return normalizeSetupPayload({
    setup_complete: setupComplete,
    setup_state: {
      acknowledged_version: '1',
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
  let getStateCalls = 0;
  let freshProbeApplied = false;
  let releaseFreshProbe = null;
  const freshProbeHeld = options.holdFreshProbe
    ? new Promise((resolve) => { releaseFreshProbe = resolve; })
    : null;
  let releaseCompleteDelay = null;
  const completeDelay = options.completeDelay
    ? new Promise((resolve) => { releaseCompleteDelay = resolve; })
    : null;
  const state = {};
  const setupService = {
    async getState() {
      getStateCalls += 1;
      // A later backend probe can see what init's probe could not (a model that finished loading).
      if (options.freshProbe && !freshProbeApplied && getStateCalls > Number(options.freshProbeAfterCalls || 1)) {
        if (freshProbeHeld) await freshProbeHeld;
        freshProbeApplied = true;
        snapshot = payload({ ...options, ...options.freshProbe });
      }
      return snapshot;
    },
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
        ...(freshProbeApplied ? options.freshProbe : {}),
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
    get getStateCalls() { return getStateCalls; },
    releaseFreshProbe() { if (releaseFreshProbe) releaseFreshProbe(); },
  };
}

// F1 (1.2.0 gate C1): Ornith finished loading after app init, so init's probe
// saw no model; the hub must re-probe instead of trusting that snapshot.
const MODEL_LOADED_PROBE = {
  steps: { ...DEFAULT_STEPS, workspace_root: 'done', local_model: 'done', endpoint: 'done' },
  readiness: {
    workspace_root: { ready: true, configured: true },
    local_model: { ready: true, model_count: 1 },
    endpoint: { ready: true, engine_type: 'ollama' },
  },
};

module.exports = { DEFAULT_STEPS, payload, settle, buildHarness, MODEL_LOADED_PROBE };

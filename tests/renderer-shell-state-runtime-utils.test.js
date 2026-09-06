const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createCompanionSafeHandlers,
  createSetupSafeHandlers,
  createShellStateRuntimeUtils,
} = require('../renderer/shell/renderer-shell-state-runtime-utils.js');

test('shell state runtime merges feature payloads and syncs pretext layout dataset', async () => {
  const state = {
    features: {
      tools: { bash: true },
      featureFlags: { pretext_layout: false, old_flag: true },
      featureOverrides: { alpha: false },
      availability: { offline: true },
    },
  };
  const documentElement = { dataset: {} };
  const runtime = createShellStateRuntimeUtils({
    state,
    windowRef: { document: { documentElement } },
  });

  const features = runtime.applyFeatureStatePayload({
    tools: { python: true },
    featureFlags: { pretext_layout: true },
    featureOverrides: { beta: true },
    availability: { local_models: true },
  });

  assert.deepEqual(features.tools, { bash: true, python: true });
  assert.deepEqual(features.featureFlags, { pretext_layout: true, old_flag: true });
  assert.deepEqual(features.featureOverrides, { alpha: false, beta: true });
  assert.deepEqual(features.availability, { offline: true, local_models: true });
  assert.equal(documentElement.dataset.pretextLayout, 'true');
});

test('shell state runtime syncs katex_math onto the markdown-math-utils toggle', () => {
  const markdownMathUtils = require('../renderer/shared/markdown-math-utils.js');
  const previous = markdownMathUtils.isMathRenderingEnabled();
  try {
    const state = { features: { featureFlags: {} } };
    const runtime = createShellStateRuntimeUtils({
      state,
      // No markdownMathUtils on windowRef: the sync falls through to the
      // globalThis/require-cache module instance, same as production.
      windowRef: { document: { documentElement: { dataset: {} } } },
    });

    runtime.applyFeatureStatePayload({ featureFlags: { katex_math: true } });
    assert.equal(markdownMathUtils.isMathRenderingEnabled(), true);

    runtime.applyFeatureStatePayload({ featureFlags: { katex_math: false } });
    assert.equal(markdownMathUtils.isMathRenderingEnabled(), false);

    // A payload that omits the key entirely resolves to disabled, never a
    // stale carry-over of module state... but merge semantics keep the last
    // merged flag value, so assert the merged-state read is what lands.
    runtime.applyFeatureStatePayload({ featureFlags: { katex_math: true } });
    runtime.applyFeatureStatePayload({ tools: {} });
    assert.equal(markdownMathUtils.isMathRenderingEnabled(), true);
  } finally {
    markdownMathUtils.setMathRenderingEnabled(previous);
  }
});

test('shell state runtime leaves surface gallery assets unloaded when the flag is off', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const runtime = createShellStateRuntimeUtils({
    state: { features: { featureFlags: {} } },
    windowRef: dom.window,
  });

  runtime.applyFeatureStatePayload({ featureFlags: { surface_effect_gallery: false } });

  assert.equal(dom.window.document.querySelector('[data-jenny-surface-gallery]'), null);
});

test('shell state runtime loads surface gallery assets and installs the gallery once when enabled', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const reducedMotionQuery = { matches: false };
  const presets = [{ id: 'reactive-grid', label: 'Reactive Grid' }];
  const installCalls = [];
  dom.window.matchMedia = () => reducedMotionQuery;
  dom.window.appearanceUtils = { getSurfaceEffectPresets: () => presets };
  dom.window.rendererSurfaceGalleryUtils = {
    installSurfaceEffectGallery: (deps) => installCalls.push(deps),
  };
  const runtime = createShellStateRuntimeUtils({
    state: { features: { featureFlags: {} } },
    windowRef: dom.window,
  });

  runtime.applyFeatureStatePayload({ featureFlags: { surface_effect_gallery: true } });
  runtime.applyFeatureStatePayload({ featureFlags: { surface_effect_gallery: true } });

  const stylesheet = dom.window.document.querySelector('link[data-jenny-surface-gallery]');
  const script = dom.window.document.querySelector('script[data-jenny-surface-gallery]');
  assert.equal(stylesheet.getAttribute('href'), 'styles/views-surface-gallery.css');
  assert.equal(script.getAttribute('src'), 'renderer/shell/renderer-surface-gallery-utils.js');
  assert.equal(dom.window.document.querySelectorAll('[data-jenny-surface-gallery]').length, 2);

  script.dispatchEvent(new dom.window.Event('load'));
  assert.equal(installCalls.length, 1);
  assert.equal(installCalls[0].windowRef, dom.window);
  assert.equal(installCalls[0].documentRef, dom.window.document);
  assert.equal(installCalls[0].reducedMotionQuery, reducedMotionQuery);
  assert.deepEqual(installCalls[0].getEffectRegistry(), presets);
});

test('shell state runtime ignores stale diagnostics refresh after reset', async () => {
  let resolveRefresh;
  const refreshPayload = {
    generated_at: '2026-04-19T00:00:00.000Z',
    phases: { provider_request_start_to_first_chunk: { p50: 250 } },
  };
  const resetPayload = {
    generated_at: '2026-04-19T00:00:01.000Z',
    phases: {},
  };
  const state = {};
  const runtime = createShellStateRuntimeUtils({
    state,
    windowRef: {
      jennyShell: {
        diagnostics: {
          phasePercentiles: {
            get() {
              return new Promise((resolve) => {
                resolveRefresh = resolve;
              });
            },
            async reset() {
              return resetPayload;
            },
          },
        },
      },
    },
  });

  const refreshPromise = runtime.refreshPhasePercentiles();
  const reset = await runtime.resetPhasePercentiles();
  resolveRefresh(refreshPayload);
  await refreshPromise;

  assert.equal(reset, resetPayload);
  assert.equal(state.phasePercentiles.payload, resetPayload);
  assert.deepEqual(state.phasePercentiles.payload.phases, {});
  assert.equal(state.phasePercentiles.loading, false);
});

test('shell state runtime ignores an older percentile refresh that resolves last', async () => {
  const requests = [];
  const state = {};
  const runtime = createShellStateRuntimeUtils({
    state,
    windowRef: {
      jennyShell: {
        diagnostics: {
          phasePercentiles: {
            get() {
              return new Promise((resolve) => requests.push(resolve));
            },
          },
        },
      },
    },
  });

  const older = runtime.refreshPhasePercentiles({ render: false });
  const newer = runtime.refreshPhasePercentiles({ render: false });
  requests[1]({ generated_at: 'newer' });
  await newer;
  requests[0]({ generated_at: 'older' });
  await older;

  assert.deepEqual(state.phasePercentiles.payload, { generated_at: 'newer' });
  assert.equal(state.phasePercentiles.loading, false);
  assert.equal(state.phasePercentiles.error, '');
});

test('shell companion safe handlers fall back to bridge state and filter defer presets', async () => {
  const state = {
    ui: { activeView: 'settings' },
    companion: {},
  };
  const payload = {
    status: 'ready',
    availableDeferPresets: [
      { preset: 'later', label: 'Later' },
      { preset: '', label: 'Blank preset' },
      { preset: 'missing_label', label: '' },
      null,
    ],
  };
  const handlers = createCompanionSafeHandlers({
    state,
    windowRef: {
      jennyShell: {
        companion: {
          async getState() {
            return payload;
          },
        },
      },
    },
  });

  assert.equal(handlers.shouldRenderHomePanelSafe(), false);
  const result = await handlers.refreshCompanionStateSafe();
  assert.equal(result, payload);
  assert.equal(state.companion, payload);
  assert.deepEqual(handlers.getAvailableCompanionDeferPresets(), [
    { preset: 'later', label: 'Later' },
  ]);

  state.ui.activeView = 'home';
  assert.equal(handlers.shouldRenderHomePanelSafe(), true);
});

// Workspace-root mutations are owned by the injected transactional service.
// This runtime only exposes Settings-friendly result wrappers and must never
// call the legacy preload choose/clear methods itself.

function buildWorkspaceRootRuntime(overrides = {}) {
  const toasts = [];
  const transitionCalls = { choose: [], clear: [] };
  const legacyCalls = { choose: 0, clear: 0 };
  const state = { workspaceRoot: { path: '', status: { state: 'missing', message: '' } } };
  const workspaceRootService = {
    async choose(...args) {
      transitionCalls.choose.push(args);
      return { committed: false, changed: false, canceled: true, code: 'user_canceled' };
    },
    async clear(...args) {
      transitionCalls.clear.push(args);
      return { committed: false, changed: false, canceled: true, code: 'user_canceled' };
    },
    async getState() {
      return { workspaceRoot: '', workspaceRootStatus: { state: 'missing', message: '' } };
    },
  };
  const windowRef = {
    jennyShell: {
      workspaceRoot: {
        choose: async () => { legacyCalls.choose += 1; },
        clear: async () => { legacyCalls.clear += 1; },
      },
    },
  };
  const runtime = createShellStateRuntimeUtils({
    state,
    windowRef,
    workspaceRootService,
    constants: { TOAST_SOURCE: { settings: 'settings' } },
    callbacks: {
      showShellErrorToast: (message, meta) => toasts.push({ message, meta }),
    },
    ...overrides,
  });
  return { runtime, state, windowRef, workspaceRootService, toasts, transitionCalls, legacyCalls };
}

test('workspace-root Settings handler delegates choose only to the transactional service', async () => {
  const { runtime, transitionCalls, legacyCalls, toasts } = buildWorkspaceRootRuntime();

  const chooseResult = await runtime.handleWorkspaceRootChoose();

  assert.equal(transitionCalls.choose.length, 1);
  assert.equal(transitionCalls.clear.length, 0);
  assert.deepEqual(legacyCalls, { choose: 0, clear: 0 });
  assert.equal(chooseResult.transition.code, 'user_canceled');
  assert.deepEqual(chooseResult.workspaceRoot, { path: '', status: { state: 'missing', message: '' } });
  assert.equal(toasts.length, 0, 'the transition owner surfaces failures once');
});

test('refreshWorkspaceRootState captures the canonical rootId/generation from the coordinator context', async () => {
  const { runtime, state, workspaceRootService } = buildWorkspaceRootRuntime();
  // WIDE-030: workspaceRoot.getState() carries the root coordinator context;
  // the renderer must keep rootId + generation so the File Map can key
  // persistence and scan bindings off the CANONICAL identity.
  workspaceRootService.getState = async () => ({
    workspaceRoot: 'C:\\dev\\demo',
    workspaceRootStatus: { state: 'ready', message: 'Ready.' },
    context: { rootPath: 'C:\\dev\\demo', rootId: 'root_abc123', generation: 4, phase: 'ready' },
  });
  await runtime.refreshWorkspaceRootState();
  assert.deepEqual(state.workspaceRoot, {
    path: 'C:\\dev\\demo',
    status: { state: 'ready', message: 'Ready.' },
    rootId: 'root_abc123',
    generation: 4,
  });

  // Context-less payloads leave the identity empty — nothing may persist.
  workspaceRootService.getState = async () => ({
    workspaceRoot: '',
    workspaceRootStatus: { state: 'missing', message: '' },
  });
  await runtime.refreshWorkspaceRootState();
  assert.equal(state.workspaceRoot.rootId, '');
  assert.equal(state.workspaceRoot.generation, 0);
});

test('shell setup safe handlers run setup again by remounting the flow via resumeSetup, not just switching views', async () => {
  const state = { setup: { dismissed: true } };
  const calls = [];
  const snapshot = { dismissed: false, setupComplete: false };
  const controller = {
    applySnapshot(value) {
      calls.push(['apply', value]);
      state.setup = value;
    },
    resumeSetup() {
      calls.push(['resume']);
    },
    showFromSettings() {
      calls.push(['show']);
    },
  };
  const handlers = createSetupSafeHandlers({
    state,
    callbacks: {
      ensureSetupController() {
        calls.push(['ensure']);
        return controller;
      },
      ensureSetupService() {
        return {
          async updateState(value) {
            calls.push(['update', value]);
            return snapshot;
          },
        };
      },
      getSetupController() {
        return controller;
      },
    },
  });

  const result = await handlers.handleRunSetupAgain();

  assert.equal(result, snapshot);
  assert.deepEqual(calls, [
    ['ensure'],
    ['update', { dismissed: false, setupComplete: false }],
    ['apply', snapshot],
    ['resume'],
  ], 'UIUX-005: Run setup again must remount the flow (resumeSetup), not merely switch to Home (showFromSettings)');
});

test('shell setup safe handlers fall back to showFromSettings when the controller has no resumeSetup', async () => {
  const state = { setup: { dismissed: true } };
  const calls = [];
  const snapshot = { dismissed: false, setupComplete: false };
  const controller = {
    applySnapshot(value) {
      calls.push(['apply', value]);
      state.setup = value;
    },
    showFromSettings() {
      calls.push(['show']);
    },
  };
  const handlers = createSetupSafeHandlers({
    state,
    callbacks: {
      ensureSetupController() { return controller; },
      ensureSetupService() {
        return { async updateState() { return snapshot; } };
      },
      getSetupController() { return controller; },
    },
  });

  await handlers.handleRunSetupAgain();

  assert.deepEqual(calls, [['apply', snapshot], ['show']]);
});

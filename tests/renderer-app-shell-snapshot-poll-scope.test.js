'use strict';

// F18a: Ollama catalog discovery ran live on EVERY 15s renderer poll.
//
// bindAppShell creates the snapshot poller unconditionally, with autoStart and
// NO options object, so `refreshOptions.includeModels` was `undefined` and the
// `!== false` test in renderer/shell/renderer-snapshot-refresh.js passed. Every
// tick therefore ran `shell.models.list()` -> 2 loopback HTTP calls, 1 atomic
// catalog-cache file replace and 1 INFO log. The poller is not view-gated, so
// this happened on the chat view too: up to 480 loopback requests and 240
// atomic file replaces an hour for a catalog nothing was displaying.
//
// Two halves: the seam that makes the fix possible, and the call site that has
// to opt in.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSnapshotRefresh } = require('../renderer/shell/renderer-snapshot-refresh');

const ROOT = path.resolve(__dirname, '..');
const BINDINGS_SOURCE = fs.readFileSync(
  path.join(ROOT, 'renderer/app/renderer-app-shell-bindings.js'),
  'utf8'
);

function buildRefresh() {
  const calls = [];
  const state = { backend: { phase: 'ready' }, auth: { authenticated: true } };
  const shell = {
    engines: { async getSettings() { calls.push('engines.getSettings'); return {}; } },
    status: { async get() { calls.push('status.get'); return { ok: true }; } },
    models: { async list() { calls.push('models.list'); return ['a']; } },
    system: { async getStats() { calls.push('system.getStats'); return {}; } },
  };
  const { refreshSnapshots } = createSnapshotRefresh({
    state,
    getShell: () => shell,
    render: () => calls.push('render'),
  });
  return { refreshSnapshots, calls, state };
}

test('refreshSnapshots({ includeModels: false }) skips the Ollama catalog discovery call', async () => {
  const { refreshSnapshots, calls, state } = buildRefresh();

  await refreshSnapshots({ includeModels: false });

  assert.equal(calls.includes('models.list'), false, 'the poll must not run model discovery');
  // Everything the poll actually exists for still happens.
  assert.deepEqual(calls, ['engines.getSettings', 'status.get', 'render']);
  assert.equal(state.modelList, undefined);
});

test('refreshSnapshots with no options still includes models for the deliberate callers', async () => {
  const { refreshSnapshots, calls, state } = buildRefresh();

  await refreshSnapshots();

  assert.equal(calls.includes('models.list'), true);
  assert.deepEqual(state.modelList, ['a']);
});

test('the 15s shell poller opts out of model discovery', () => {
  const pollerCall = BINDINGS_SOURCE.match(
    /createSnapshotPoller\?\.\(\{[\s\S]{0,400}?intervalMs:\s*15000/
  );
  assert.ok(pollerCall, 'the 15s snapshot poller call site must still exist');
  assert.match(
    pollerCall[0],
    /task:\s*\(\)\s*=>\s*refreshSnapshots\(\{\s*includeModels:\s*false\s*\}\)/,
    'the unconditional 15s poller must not run model discovery'
  );
});

test('the model-library picker refresh still requests models', () => {
  // The fix must not starve the three deliberate model-inclusive refreshes.
  // This one is a plain refreshSnapshots?.() with NO options, so it keeps them.
  assert.match(
    BINDINGS_SOURCE,
    /refreshModelPickers:\s*\(\)\s*=>\s*\{\s*callbacks\.refreshSnapshots\?\.\(\)/,
    'the model-library controller must keep its model-inclusive refresh'
  );
  assert.match(
    BINDINGS_SOURCE,
    /ensureSettingsSectionReady/,
    'settings section activation is the other model-inclusive entry point'
  );
});

const vm = require('node:vm');

function buildAppShellPollerHarness() {
  const pollerRecords = [];
  const cleanups = [];
  const calls = {
    modelSync: 0,
    nudgeRender: 0,
    rawIntervals: 0,
    refreshSnapshots: 0,
  };
  const modelLibraryController = {
    bind() {},
    render() {},
    syncFromState() { calls.modelSync += 1; },
    dispose() {},
  };
  const workspaceRootNudgeController = {
    bind() {},
    render() { calls.nudgeRender += 1; },
    dispose() {},
  };
  const windowRef = {
    document: {},
    cancelAnimationFrame() {},
    setInterval() {
      calls.rawIntervals += 1;
      return calls.rawIntervals;
    },
    clearInterval() {},
    rendererAppShellBindingsControllers: {
      bindShellEventControllers() {},
      bindAttachments() {},
    },
    rendererSettingsSnapshotPoll: {
      createSnapshotPoller(options) {
        const record = {
          options,
          stopCalls: 0,
        };
        pollerRecords.push(record);
        return {
          stop() { record.stopCalls += 1; },
        };
      },
    },
    rendererModelLibrary: {
      createModelLibraryController() { return modelLibraryController; },
    },
    rendererWorkspaceRootNudge: {
      createWorkspaceRootNudgeController() { return workspaceRootNudgeController; },
    },
  };
  windowRef.window = windowRef;
  const browserContext = vm.createContext(windowRef);
  vm.runInContext(BINDINGS_SOURCE, browserContext, {
    filename: 'renderer/app/renderer-app-shell-bindings.js',
  });

  const state = {
    ui: { appearance: { surfaceEffectId: 'none' } },
  };
  const callbacks = {
    activateCometIfEnabled() {},
    activateSurfaceEffect() {},
    appendClientLog() {},
    applySurfaceEffect() {},
    async bootstrap() {},
    disposeCometPersonality() {},
    ensureComposerFeatureStateLoaded: async () => {},
    hydrateCachedLazyShellState() {},
    initSetupController: async () => {},
    logSurfaceEffectFailure() {},
    queueDeferredStartupTask() {},
    queueStartupLazyHydration() {},
    refreshComposerToolToggles: async () => {},
    refreshSnapshots: async () => { calls.refreshSnapshots += 1; },
    refreshSuggestions: async () => {},
    refreshWorkspaceRootState: async () => {},
    registerCleanup(cleanup) { cleanups.push(cleanup); },
    renderAll() {},
    runStartupAuditAutoSend: async () => {},
    showShellErrorToast() {},
    signalRendererReadyOnce() {},
    syncWorkspaceFromStore: async () => {},
  };
  const ctx = {
    windowRef,
    documentRef: windowRef.document,
    state,
    constants: {},
    dom: {},
    controllers: {},
    modules: {},
    refs: {
      thinkingIndicatorRenderFrame: {
        get: () => 0,
        set() {},
      },
    },
    callbacks,
  };
  return {
    bindAppShell: windowRef.rendererAppShellBindings.bindAppShell,
    calls,
    cleanups,
    ctx,
    pollerRecords,
    windowRef,
  };
}

test('workspace-root nudge uses the snapshot poller cadence and its registered cleanup stops it', async () => {
  const harness = buildAppShellPollerHarness();

  await harness.bindAppShell(harness.ctx);

  assert.equal(harness.calls.rawIntervals, 0, 'the binding path does not create a raw interval');
  assert.equal(harness.pollerRecords.length, 2, 'snapshot refresh and workspace nudge each create a poller');
  for (const record of harness.pollerRecords) {
    assert.equal(record.options.windowRef, harness.windowRef);
    assert.equal(record.options.intervalMs, 15000);
  }

  let nudgePoller = null;
  for (const record of harness.pollerRecords) {
    const nudgeRendersBefore = harness.calls.nudgeRender;
    const modelSyncsBefore = harness.calls.modelSync;
    await record.options.task();
    if (
      harness.calls.nudgeRender === nudgeRendersBefore + 1
      && harness.calls.modelSync === modelSyncsBefore + 1
    ) {
      nudgePoller = record;
    }
  }
  assert.ok(nudgePoller, 'one real binding task owns both nudge render and model-library sync');

  for (const cleanup of harness.cleanups) cleanup();
  assert.equal(nudgePoller.stopCalls, 1, 'the registered nudge cleanup stops its poller');
});

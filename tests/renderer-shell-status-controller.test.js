const test = require('node:test');
const assert = require('node:assert/strict');

const { createShellStatusController } = require('../renderer/shell/renderer-shell-status-controller.js');
const realActivityPrefsUtils = require('../renderer/shell/renderer-activity-prefs-utils.js');

function createHost() {
  const classes = new Set(['hidden']);
  return {
    innerHTML: '',
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    querySelector() { return null; },
  };
}

/* The backend banner is gone. Startup phases are narrated by the workbench
 * health pill (top-right, no layout shift); only an actionable failure pushes,
 * and it pushes a toast. These cover the store<->controller seam that the last
 * toast defect slipped through. */

function stubStatusDeps() {
  const previous = {
    inventory: global.inventory,
    activityPrefs: global.rendererActivityPrefsUtils,
    lifecycle: global.lifecycleProgressUtils,
  };
  global.rendererActivityPrefsUtils = {
    createActivityPrefsController() {
      return {
        renderComposerStatusNotice() {},
        handleActivityChange() {},
        getRuntimePreferenceSnapshot() { return {}; },
        runRuntimePreferenceActivity: async () => {},
        persistRuntimePreferences: async () => {},
      };
    },
  };
  global.lifecycleProgressUtils = {
    createLifecycleProgressController() {
      return {
        handleLifecycleProgress() {},
        handleBackendStatus() {},
        beginModelSwitch() {},
        updateModelSwitch() {},
        failModelSwitch() {},
        publishLifecycleStatus() {},
      };
    },
  };
  return function restore() {
    global.inventory = previous.inventory;
    global.rendererActivityPrefsUtils = previous.activityPrefs;
    global.lifecycleProgressUtils = previous.lifecycle;
  };
}

function createNoticeHarness(overrides = {}) {
  const toasts = [];
  const dismissed = [];
  const navigations = [];
  const backendState = { phase: 'starting', detail: '', ...(overrides.backend || {}) };
  const controller = createShellStatusController({
    state: {
      currentSessionId: '',
      backend: backendState,
      status: { model_loaded: false },
      ui: { activeView: 'chat' },
    },
    constants: {
      ACTIVITY_SCOPE: {
        backendStarting: 'backend.starting',
        backendRetrying: 'backend.retrying',
        backendFailed: 'backend.failed',
      },
    },
    dom: {
      composerStatusNotice: createHost(),
      startupOverlay: overrides.startupOverlay || null,
      startupOverlayLabel: null,
      startupOverlaySublabel: null,
    },
    callbacks: {
      getCurrentRuntimePreferences() { return {}; },
      getActiveSession() { return null; },
      patchSessionSummary() {},
      syncRuntimeDraftFromActiveSession() {},
      beginActivity() {},
      resolveActivity() {},
      failActivity() {},
      getActivitySnapshot() { return null; },
      getMostRecentActivity() { return null; },
      applyActivityAttributes() {},
      setComposerStatusNotice() {},
      clearComposerStatusNotice() {},
      renderComposerState() {},
      renderSettings() {},
      renderPersonalityEditor() {},
      renderSessions() {},
      getVisibleSessionMessages() { return []; },
      appendClientLog() {},
      getRendererElapsedMs() { return 0; },
      onStartupReady() {},
      openLogs() { navigations.push('logs'); },
      openSettingsSection(section) { navigations.push('settings:' + section); },
      showToastMessage(message, options) { toasts.push({ message, options: options || {} }); return 'toast-1'; },
      dismissToastsBySource(source) { dismissed.push(source); },
      toastSource: 'shell.backend',
    },
  });
  return { controller, toasts, dismissed, navigations, backendState };
}

test('backend notice stays silent for every phase the health pill already narrates', () => {
  const restore = stubStatusDeps();
  try {
    for (const phase of ['ready', 'starting', 'sidecar_spawned', 'model_acquiring', 'model_loading']) {
      const h = createNoticeHarness({ backend: { phase, detail: 'some detail' } });
      h.controller.syncBackendNotice();
      assert.deepEqual(h.toasts, [], phase + ': must not toast');
      assert.deepEqual(h.dismissed, ['shell.backend'], phase + ': clears any stale backend toast');
    }
  } finally {
    restore();
  }
});

test('backend notice raises a danger toast for model_unavailable without forwarding sticky', () => {
  const restore = stubStatusDeps();
  try {
    const h = createNoticeHarness({ backend: { phase: 'model_unavailable', detail: '' } });
    h.controller.syncBackendNotice();

    assert.equal(h.toasts.length, 1, 'exactly one toast');
    const { message, options } = h.toasts[0];
    assert.match(message, /Send a message to retry, or pick another model in Settings\./);
    assert.equal(options.tone, 'danger');
    assert.equal(options.title, 'Model failed to load');
    assert.equal(options.source, 'shell.backend');
    assert.equal(options.dedupeKey, 'shell.backend:model_unavailable');

    /* The store makes danger sticky by default. Forwarding `sticky` at all
     * defeats its hasOwnProperty check and overrides every per-tone default —
     * that is the defect the toast redesign fixed, so assert on absence. */
    assert.equal(Object.prototype.hasOwnProperty.call(options, 'sticky'), false, 'sticky is never forwarded');
    assert.equal(Object.prototype.hasOwnProperty.call(options, 'durationMs'), false, 'durationMs is never forwarded');

    assert.deepEqual(options.actions.map((a) => a.id), ['backend-retry', 'backend-open-models']);
    assert.equal(options.actions[0].kind, 'primary');
  } finally {
    restore();
  }
});

test('backend notice offers Retry and Diagnostics on a hard failure and routes both', () => {
  const restore = stubStatusDeps();
  try {
    const h = createNoticeHarness({ backend: { phase: 'failed', detail: '' } });
    h.controller.syncBackendNotice();

    assert.equal(h.toasts.length, 1);
    const { options } = h.toasts[0];
    assert.equal(options.tone, 'danger');
    assert.deepEqual(options.actions.map((a) => a.id), ['backend-retry', 'backend-open-logs']);

    options.actions[1].onClick();
    assert.deepEqual(h.navigations, ['logs'], 'diagnostics action navigates to logs');
  } finally {
    restore();
  }
});

test('backend notice prefers a concrete backend detail over the canned copy', () => {
  const restore = stubStatusDeps();
  try {
    const h = createNoticeHarness({ backend: { phase: 'failed', detail: 'Port 8765 already in use.' } });
    h.controller.syncBackendNotice();
    assert.equal(h.toasts[0].message, 'Port 8765 already in use.');
  } finally {
    restore();
  }
});

test('backend notice dismisses its toast once the backend recovers', () => {
  const restore = stubStatusDeps();
  try {
    const h = createNoticeHarness({ backend: { phase: 'model_unavailable', detail: '' } });
    h.controller.syncBackendNotice();
    assert.equal(h.toasts.length, 1);
    assert.deepEqual(h.dismissed, []);

    h.backendState.phase = 'ready';
    h.controller.syncBackendNotice();
    assert.equal(h.toasts.length, 1, 'recovery adds no further toast');
    assert.deepEqual(h.dismissed, ['shell.backend'], 'recovery clears the failure toast');
  } finally {
    restore();
  }
});

test('backend notice is idempotent across the render passes that call it', () => {
  const restore = stubStatusDeps();
  try {
    const h = createNoticeHarness({ backend: { phase: 'failed', detail: 'Backend failed.' } });

    /* syncBackendNotice is wired into every render pass. Re-enqueuing an
     * identical toast bumps the store's repeat counter and re-emits to the
     * viewport, so a failure that merely persists would render as a climbing
     * "x2, x3, x4" counter. One condition must read as one toast. */
    for (let i = 0; i < 25; i += 1) { h.controller.syncBackendNotice(); }
    assert.equal(h.toasts.length, 1, '25 render passes produce one toast');

    // A changed detail is a new thing to say, so it does re-notify.
    h.backendState.detail = 'Port 8765 already in use.';
    h.controller.syncBackendNotice();
    h.controller.syncBackendNotice();
    assert.equal(h.toasts.length, 2, 'new detail re-notifies exactly once');
    assert.equal(h.toasts[1].message, 'Port 8765 already in use.');

    // Recovering and failing again must be able to speak up a second time.
    h.backendState.phase = 'ready';
    h.controller.syncBackendNotice();
    h.backendState.phase = 'failed';
    h.controller.syncBackendNotice();
    assert.equal(h.toasts.length, 3, 'a fresh failure after recovery notifies again');
  } finally {
    restore();
  }
});

test('backend notice stays quiet while the startup curtain is still mounted', () => {
  const restore = stubStatusDeps();
  try {
    /* The curtain raises its own fatal alertdialog. A toast underneath it would
     * state the same failure twice — the duplication this change removes. */
    const h = createNoticeHarness({
      backend: { phase: 'failed', detail: 'boom' },
      startupOverlay: { parentNode: {}, querySelector() { return null; } },
    });
    h.controller.syncBackendNotice();
    assert.deepEqual(h.toasts, [], 'no toast while the curtain owns the screen');
    assert.deepEqual(h.dismissed, [], 'and no dismissal either');
  } finally {
    restore();
  }
});

test('retryBackendStart latches so concurrent Retry clicks fire one backend start', async () => {
  const restore = stubStatusDeps();
  const previousShell = global.jennyShell;
  let starts = 0;
  let release = null;
  global.jennyShell = {
    backend: {
      retryStart() {
        starts += 1;
        return new Promise((resolve) => { release = resolve; });
      },
    },
  };
  try {
    const h = createNoticeHarness({ backend: { phase: 'model_unavailable', detail: '' } });
    h.controller.syncBackendNotice();
    const retryAction = h.toasts[0].options.actions[0];

    // Toast Retry and the health-pill popover Retry share this one function.
    retryAction.onClick();
    retryAction.onClick();
    const pending = h.controller.retryBackendStart();

    /* The bridge call is dispatched a microtask later, so let it land before
     * counting — the latch itself is taken synchronously. */
    await Promise.resolve();
    assert.equal(starts, 1, 'in-flight retry is latched');
    assert.equal(typeof release, 'function', 'the single retryStart is still pending');
    release(true);
    await pending;

    h.controller.retryBackendStart();
    await Promise.resolve();
    assert.equal(starts, 2, 'a later retry is allowed once the first settles');
  } finally {
    global.jennyShell = previousShell;
    restore();
  }
});

test('shell status controller forwards activity and lifecycle controller interfaces', async () => {
  const previousActivityPrefsUtils = global.rendererActivityPrefsUtils;
  const previousLifecycleProgressUtils = global.lifecycleProgressUtils;

  const calls = [];
  global.rendererActivityPrefsUtils = {
    createActivityPrefsController() {
      return {
        renderComposerStatusNotice() { calls.push('renderComposerStatusNotice'); },
        handleActivityChange(scope) { calls.push(`activity:${scope}`); },
        getRuntimePreferenceSnapshot() { return { token: 'snapshot' }; },
        runRuntimePreferenceActivity: async () => { calls.push('runRuntimePreferenceActivity'); },
        persistRuntimePreferences: async () => { calls.push('persistRuntimePreferences'); },
      };
    },
  };
  global.lifecycleProgressUtils = {
    createLifecycleProgressController() {
      return {
        handleLifecycleProgress(payload) { calls.push(`progress:${payload.phase}`); },
        handleBackendStatus(payload) { calls.push(`backend:${payload.phase}`); },
        beginModelSwitch() { calls.push('beginModelSwitch'); },
        updateModelSwitch() { calls.push('updateModelSwitch'); },
        failModelSwitch() { calls.push('failModelSwitch'); },
        publishLifecycleStatus() { calls.push('publishLifecycleStatus'); },
      };
    },
  };

  try {
    const controller = createShellStatusController({
      state: { backend: { phase: 'starting' }, ui: {} },
      constants: { ACTIVITY_SCOPE: {} },
      dom: {
        composerStatusNotice: createHost(),
        startupOverlay: null,
        startupOverlayLabel: null,
        startupOverlaySublabel: null,
      },
      callbacks: {
        getCurrentRuntimePreferences() { return {}; },
        getActiveSession() { return null; },
        patchSessionSummary() {},
        syncRuntimeDraftFromActiveSession() {},
        beginActivity() {},
        resolveActivity() {},
        failActivity() {},
        getActivitySnapshot() { return null; },
        getMostRecentActivity() { return null; },
        applyActivityAttributes() {},
        setComposerStatusNotice() {},
        clearComposerStatusNotice() {},
        renderComposerState() {},
        renderSettings() {},
        renderPersonalityEditor() {},
        renderSessions() {},
        getVisibleSessionMessages() { return []; },
        appendClientLog() {},
        getRendererElapsedMs() { return 0; },
        onStartupReady() {},
      },
    });

    controller.renderComposerStatusNotice();
    controller.handleActivityChange('composer.planMode');
    assert.deepEqual(controller.getRuntimePreferenceSnapshot(), { token: 'snapshot' });
    await controller.runRuntimePreferenceActivity({});
    await controller.persistRuntimePreferences({});
    controller.handleLifecycleProgress({ phase: 'model_loading' });
    controller.handleLifecycleBackendStatus({ phase: 'ready' });
    controller.beginModelSwitch();
    controller.updateModelSwitch();
    controller.failModelSwitch();
    controller.publishLifecycleStatus();
    controller.dispose();

    assert.deepEqual(calls, [
      'renderComposerStatusNotice',
      'activity:composer.planMode',
      'runRuntimePreferenceActivity',
      'persistRuntimePreferences',
      'progress:model_loading',
      'backend:ready',
      'beginModelSwitch',
      'updateModelSwitch',
      'failModelSwitch',
      'publishLifecycleStatus',
    ]);
  } finally {
    global.rendererActivityPrefsUtils = previousActivityPrefsUtils;
    global.lifecycleProgressUtils = previousLifecycleProgressUtils;
  }
});

test('shell status controller threads setSessionPreferences into the real activity-prefs persist path', async () => {
  const previousActivityPrefsUtils = global.rendererActivityPrefsUtils;
  const previousLifecycleProgressUtils = global.lifecycleProgressUtils;

  // Use the REAL activity-prefs controller so a wrong/missing callback key
  // surfaces here rather than passing on a stub.
  global.rendererActivityPrefsUtils = realActivityPrefsUtils;
  global.lifecycleProgressUtils = {
    createLifecycleProgressController() {
      return {
        handleLifecycleProgress() {},
        handleBackendStatus() {},
        beginModelSwitch() {},
        updateModelSwitch() {},
        failModelSwitch() {},
        publishLifecycleStatus() {},
      };
    },
  };

  const persistCalls = [];
  try {
    const controller = createShellStatusController({
      state: { backend: { phase: 'starting' }, ui: { activeView: 'chat' } },
      constants: { ACTIVITY_SCOPE: {} },
      dom: {
        composerStatusNotice: createHost(),
        startupOverlay: null,
        startupOverlayLabel: null,
        startupOverlaySublabel: null,
      },
      callbacks: {
        getCurrentRuntimePreferences() {
          return {
            preferredModel: 'm', reasoningEffort: 'high', planMode: false,
            contextPreferences: {
              historyScope: 'recent', includePersonality: true,
              includeMemory: true,
            },
          };
        },
        getActiveSession() { return { id: 'sess-9' }; },
        patchSessionSummary() {},
        setSessionPreferences(id, prefs) { persistCalls.push([id, prefs]); return prefs; },
        syncRuntimeDraftFromActiveSession() {},
        beginActivity() {}, resolveActivity() {}, failActivity() {},
        getActivitySnapshot() { return null; },
        getMostRecentActivity() { return null; },
        applyActivityAttributes() {},
        setComposerStatusNotice() {}, clearComposerStatusNotice() {},
        renderComposerState() {}, renderSettings() {},
        renderPersonalityEditor() {}, renderSessions() {},
        getVisibleSessionMessages() { return []; },
        appendClientLog() {}, getRendererElapsedMs() { return 0; },
        onStartupReady() {},
      },
    });

    await controller.persistRuntimePreferences({});

    assert.equal(persistCalls.length, 1, 'the injected boundary fired through the real controller');
    assert.equal(persistCalls[0][0], 'sess-9');
    assert.equal(persistCalls[0][1].preferred_model, 'm');
  } finally {
    global.rendererActivityPrefsUtils = previousActivityPrefsUtils;
    global.lifecycleProgressUtils = previousLifecycleProgressUtils;
  }
});

test('shell status controller forwards notifyBootViewReady to the lifecycle progress controller', () => {
  const previousActivityPrefsUtils = global.rendererActivityPrefsUtils;
  const previousLifecycleProgressUtils = global.lifecycleProgressUtils;

  let notifyCalls = 0;
  global.rendererActivityPrefsUtils = {
    createActivityPrefsController() {
      return {
        renderComposerStatusNotice() {},
        handleActivityChange() {},
        getRuntimePreferenceSnapshot() { return {}; },
        runRuntimePreferenceActivity: async () => {},
        persistRuntimePreferences: async () => {},
      };
    },
  };
  global.lifecycleProgressUtils = {
    createLifecycleProgressController() {
      return {
        handleLifecycleProgress() {},
        handleBackendStatus() {},
        notifyBootViewReady() { notifyCalls += 1; },
        beginModelSwitch() {},
        updateModelSwitch() {},
        failModelSwitch() {},
        publishLifecycleStatus() {},
      };
    },
  };

  try {
    const controller = createShellStatusController({
      state: { currentSessionId: '', backend: { phase: 'starting' }, status: {}, ui: { activeView: 'home' } },
      constants: { ACTIVITY_SCOPE: {} },
      dom: {
        composerStatusNotice: createHost(),
        startupOverlay: null,
        startupOverlayLabel: null,
        startupOverlaySublabel: null,
      },
      callbacks: {
        getCurrentRuntimePreferences() { return {}; },
        getActiveSession() { return null; },
        patchSessionSummary() {},
        syncRuntimeDraftFromActiveSession() {},
        beginActivity() {}, resolveActivity() {}, failActivity() {},
        getActivitySnapshot() { return null; },
        getMostRecentActivity() { return null; },
        applyActivityAttributes() {},
        setComposerStatusNotice() {}, clearComposerStatusNotice() {},
        renderComposerState() {}, renderSettings() {},
        renderPersonalityEditor() {}, renderSessions() {},
        getVisibleSessionMessages() { return []; },
        appendClientLog() {}, getRendererElapsedMs() { return 0; },
        onStartupReady() {},
      },
    });

    assert.equal(typeof controller.notifyBootViewReady, 'function', 're-exported on the controller');
    controller.notifyBootViewReady();
    assert.equal(notifyCalls, 1, 'forwards through to the lifecycle progress controller');
  } finally {
    global.rendererActivityPrefsUtils = previousActivityPrefsUtils;
    global.lifecycleProgressUtils = previousLifecycleProgressUtils;
  }
});

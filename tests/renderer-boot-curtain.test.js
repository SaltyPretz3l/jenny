'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button.js');
const lifecycleUtils = require('../renderer/shell/renderer-lifecycle-progress-utils.js');
const { createShellStatusController } = require('../renderer/shell/renderer-shell-status-controller.js');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function lifecycleState(activeView = 'chat') {
  return {
    ui: { activeView },
    backend: { phase: 'starting', detail: '' },
    lifecycleProgress: lifecycleUtils.defaultLifecycleProgress(),
  };
}

function createCurtainDom(extraBody = '') {
  return new JSDOM('<!doctype html><html><body>'
    + '<div id="startupOverlay" role="status" aria-live="polite" aria-labelledby="startupOverlayLabel">'
    + '<div class="startup-overlay-wordmark">Jenny</div>'
    + '<div id="startupOverlayProgressBar" role="progressbar" aria-valuenow="0">'
    + '<div id="startupOverlayProgressFill"></div></div>'
    + '<div id="startupOverlayLabel">Starting Jenny</div>'
    + '<div id="startupOverlaySublabel"></div>'
    + '<div id="startupOverlaySecondary"></div>'
    + '<div id="startupOverlayActions"></div></div>'
    + extraBody
    + '</body></html>', { pretendToBeVisual: true });
}

function createController(documentRef, callbacks = {}) {
  return lifecycleUtils.createLifecycleProgressController({
    state: lifecycleState(),
    dom: {
      startupOverlay: documentRef.getElementById('startupOverlay'),
      startupOverlayLabel: documentRef.getElementById('startupOverlayLabel'),
      startupOverlaySublabel: documentRef.getElementById('startupOverlaySublabel'),
      startupOverlaySecondary: documentRef.getElementById('startupOverlaySecondary'),
    },
    callbacks: {
      setTurnStatusPill() {},
      clearTurnStatusPill() {},
      onStartupReady() {},
      ...callbacks,
    },
  });
}

test('index composes one first-child boot surface and removes the auth overlay seam', () => {
  const markup = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const dom = new JSDOM(markup);
  const documentRef = dom.window.document;

  assert.equal(documentRef.body.firstElementChild?.id, 'startupOverlay');
  assert.equal(documentRef.querySelectorAll('#startupOverlay').length, 1);
  assert.equal(documentRef.querySelector('.startup-overlay-wordmark')?.textContent.trim(), 'Jenny');
  assert.equal(documentRef.getElementById('startupOverlayLabel')?.textContent.trim(), 'Starting Jenny');
  assert.equal(documentRef.getElementById('authOverlay'), null);
  assert.equal(documentRef.getElementById('backendRetryButton'), null);
  assert.equal(documentRef.getElementById('backendBanner'), null);
  assert.equal(documentRef.getElementById('statusStrip'), null);
  // Nothing sits between the toprail and the workspace any more, so the
  // workspace can never be pushed down by a transient status surface.
  assert.equal(documentRef.getElementById('topRail')?.nextElementSibling?.id, 'workspace');
  assert.equal(documentRef.getElementById('heroTitle')?.textContent, 'New session');
  const chromeSource = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'chat', 'renderer-render-pipeline-chrome.js'),
    'utf8'
  );
  assert.match(chromeSource, /heroTitle\.textContent = 'New session';/);
  assert.doesNotMatch(chromeSource, /heroTitle\.textContent = 'New Session';/);
  dom.window.close();
});

test('curtain status stays plain text and progress is floored and monotonic', (t) => {
  const previousActionButton = global.inventoryActionButton;
  global.inventoryActionButton = actionButton;
  t.after(() => { global.inventoryActionButton = previousActionButton; });
  const dom = createCurtainDom();
  t.after(() => dom.window.close());
  const documentRef = dom.window.document;
  const controller = createController(documentRef);
  t.after(() => controller.dispose());

  controller.handleLifecycleProgress({
    scenario: 'startup', phase: 'sidecar_spawn', detail: '<b>Launching safely</b>', percent: 0.1,
  });
  assert.equal(documentRef.getElementById('startupOverlayProgressFill').style.width, '6%');
  assert.equal(documentRef.getElementById('startupOverlaySublabel').textContent, '<b>Launching safely</b>');
  assert.equal(documentRef.getElementById('startupOverlaySublabel').querySelector('b'), null);

  controller.handleLifecycleProgress({
    scenario: 'startup', phase: 'ollama_start', detail: 'A stale update', percent: 2,
  });
  assert.equal(documentRef.getElementById('startupOverlayProgressBar').getAttribute('aria-valuenow'), '6');
  assert.equal(documentRef.getElementById('startupOverlayLabel').textContent, 'Starting Jenny');

  controller.handleBackendStatus({ phase: 'model_unavailable' });
  assert.equal(documentRef.getElementById('startupOverlay').dataset.state, 'blocked');
  assert.equal(documentRef.querySelector('[data-action="startup-continue"]')?.textContent, 'Continue');
});

test('curtain removal callback runs only after the mounted surface is gone', (t) => {
  const dom = createCurtainDom();
  t.after(() => dom.window.close());
  const overlay = dom.window.document.getElementById('startupOverlay');
  let readyCalls = 0;
  let removedCalls = 0;
  const controller = createController(dom.window.document, {
    onStartupReady() { readyCalls += 1; },
    onStartupRemoved() {
      assert.equal(overlay.parentNode, null);
      removedCalls += 1;
    },
  });
  t.after(() => controller.dispose());

  controller.notifyBootViewReady('chat');
  controller.handleBackendStatus({ phase: 'ready' });
  assert.equal(readyCalls, 1);
  assert.equal(removedCalls, 0);
  assert.ok(overlay.parentNode);

  const childTransition = new dom.window.Event('transitionend', { bubbles: true });
  Object.defineProperty(childTransition, 'propertyName', { value: 'transform' });
  overlay.querySelector('.startup-overlay-wordmark').dispatchEvent(childTransition);
  assert.ok(overlay.parentNode, 'a descendant transition must not remove the curtain early');

  const opacityTransition = new dom.window.Event('transitionend');
  Object.defineProperty(opacityTransition, 'propertyName', { value: 'opacity' });
  overlay.dispatchEvent(opacityTransition);
  assert.equal(removedCalls, 1);
});

test('non-terminal startup errors become fatal and retry progress restores normal semantics', (t) => {
  const previousActionButton = global.inventoryActionButton;
  global.inventoryActionButton = actionButton;
  t.after(() => { global.inventoryActionButton = previousActionButton; });
  const dom = createCurtainDom('<main id="appShell"><section id="workspace"></section></main>');
  t.after(() => dom.window.close());
  const controller = createController(dom.window.document);
  t.after(() => controller.dispose());
  const overlay = dom.window.document.getElementById('startupOverlay');

  controller.handleLifecycleProgress({
    scenario: 'startup', phase: 'sidecar_spawn', error: 'spawn failed', detail: 'Startup failed.', percent: 10,
  });
  assert.equal(overlay.getAttribute('role'), 'alertdialog');
  assert.equal(dom.window.document.getElementById('appShell').inert, true);

  controller.handleLifecycleProgress({
    scenario: 'startup', phase: 'sidecar_spawn', detail: 'Retrying startup.', percent: 12,
  });
  assert.equal(overlay.getAttribute('role'), 'alertdialog', 'unconfirmed progress cannot clear a fatal dialog');
  controller.handleBackendStatus({ phase: 'sidecar_spawned', detail: 'Retrying startup.' });
  assert.equal(overlay.getAttribute('role'), 'status');
  assert.equal(dom.window.document.getElementById('appShell').inert, false);
});

test('fatal inerting recurses around the exempt window-control branch and restores prior state', () => {
  const dom = createCurtainDom(
    '<main id="appShell"><header><div id="brand"></div>'
    + '<div id="windowControls" data-startup-inert-exempt></div></header>'
    + '<section id="workspace"></section><aside id="alreadyInert"></aside></main>'
  );
  const documentRef = dom.window.document;
  const overlay = documentRef.getElementById('startupOverlay');
  const alreadyInert = documentRef.getElementById('alreadyInert');
  alreadyInert.inert = true;
  const previousActionButton = global.inventoryActionButton;
  global.inventoryActionButton = actionButton;

  lifecycleUtils.presentStartupOverlayFatalError(overlay, { onRetry() {} });
  assert.notEqual(documentRef.getElementById('appShell').inert, true);
  assert.equal(documentRef.getElementById('windowControls').inert, undefined);
  assert.equal(documentRef.getElementById('brand').inert, true);
  assert.equal(documentRef.getElementById('workspace').inert, true);
  assert.equal(alreadyInert.inert, true);

  lifecycleUtils.clearStartupOverlayFatalError(overlay);
  assert.equal(documentRef.getElementById('brand').inert, false);
  assert.equal(documentRef.getElementById('workspace').inert, false);
  assert.equal(alreadyInert.inert, true);
  assert.equal(documentRef.querySelector('[data-startup-fatal-inert]'), null);

  global.inventoryActionButton = previousActionButton;
  dom.window.close();
});

test('surface-effect none suppresses circuit-trace startup', (t) => {
  const previousCore = global.rendererCircuitTraceCore;
  global.rendererCircuitTraceCore = {};
  t.after(() => { global.rendererCircuitTraceCore = previousCore; });
  const dom = createCurtainDom();
  t.after(() => dom.window.close());
  const documentRef = dom.window.document;
  documentRef.documentElement.dataset.surfaceEffect = 'none';
  const originalCreateElement = documentRef.createElement.bind(documentRef);
  let canvasCreations = 0;
  documentRef.createElement = (tagName, options) => {
    if (String(tagName).toLowerCase() === 'canvas') { canvasCreations += 1; }
    return originalCreateElement(tagName, options);
  };
  const controller = createController(documentRef);
  controller.dispose();
  assert.equal(canvasCreations, 0);
});

test('reduced motion suppresses circuit-trace startup', (t) => {
  const previousCore = global.rendererCircuitTraceCore;
  const previousMatchMedia = global.matchMedia;
  global.rendererCircuitTraceCore = {};
  global.matchMedia = (query) => ({ matches: String(query).includes('prefers-reduced-motion') });
  t.after(() => {
    global.rendererCircuitTraceCore = previousCore;
    global.matchMedia = previousMatchMedia;
  });
  const dom = createCurtainDom();
  t.after(() => dom.window.close());
  const documentRef = dom.window.document;
  const originalCreateElement = documentRef.createElement.bind(documentRef);
  let canvasCreations = 0;
  documentRef.createElement = (tagName, options) => {
    if (String(tagName).toLowerCase() === 'canvas') { canvasCreations += 1; }
    return originalCreateElement(tagName, options);
  };
  const controller = createController(documentRef);
  controller.dispose();
  assert.equal(canvasCreations, 0);
});

test('backend failure offers Retry and View logs, and logs handoff dismisses the curtain', (t) => {
  const previousActionButton = global.inventoryActionButton;
  global.inventoryActionButton = actionButton;
  t.after(() => { global.inventoryActionButton = previousActionButton; });
  const dom = createCurtainDom('<main id="appShell"><div id="windowControls" data-startup-inert-exempt></div><section></section></main>');
  t.after(() => dom.window.close());
  let logsOpened = 0;
  const controller = createController(dom.window.document, { openLogs() { logsOpened += 1; } });
  t.after(() => controller.dispose());

  controller.handleBackendStatus({ phase: 'failed', detail: 'Backend failed.' });
  assert.equal(dom.window.document.querySelector('[data-action="startup-retry"]')?.textContent, 'Retry');
  const viewLogs = dom.window.document.querySelector('[data-action="startup-view-logs"]');
  assert.equal(viewLogs?.textContent, 'View logs');
  assert.equal(dom.window.document.getElementById('startupOverlay').getAttribute('role'), 'alertdialog');
  viewLogs.click();
  assert.equal(logsOpened, 1);
  assert.equal(dom.window.document.getElementById('startupOverlay').classList.contains('hidden'), true);
  assert.equal(dom.window.document.getElementById('startupOverlay').getAttribute('role'), 'status');
});

test('slow timer offers manual continuation and emits a bounded diagnostic', () => {
  const previous = {
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    slowMs: global.__JENNY_STARTUP_OVERLAY_SLOW_MS,
    maxMs: global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS,
    actionButton: global.inventoryActionButton,
  };
  const scheduled = [];
  const cleared = [];
  global.setTimeout = (callback, delay) => { scheduled.push({ callback, delay, id: scheduled.length + 1 }); return scheduled.length; };
  global.clearTimeout = (timerId) => { cleared.push(timerId); };
  global.__JENNY_STARTUP_OVERLAY_SLOW_MS = 8;
  global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = 20;
  global.inventoryActionButton = actionButton;
  const dom = createCurtainDom();
  const logs = [];
  try {
    const controller = createController(dom.window.document, {
      appendClientLog(level, event, detail) { logs.push({ level, event, detail }); },
    });
    const slow = scheduled.find((entry) => entry.delay === 8);
    const backstop = scheduled.find((entry) => entry.delay === 20);
    assert.ok(slow);
    assert.ok(backstop, 'slow and hard-backstop timers are independent');
    slow.callback();
    const continueButton = dom.window.document.querySelector('[data-action="startup-continue"]');
    assert.equal(continueButton?.textContent, 'Continue anyway');
    continueButton.click();
    assert.equal(dom.window.document.getElementById('startupOverlay').classList.contains('hidden'), true);
    assert.deepEqual(logs[0], {
      level: 'INFO',
      event: 'startup.curtain_continued',
      detail: { reason: 'slow' },
    });
    controller.dispose();
    const removal = scheduled.find((entry) => entry.delay === 420);
    assert.ok(removal);
    assert.ok(cleared.includes(removal.id), 'disposal clears the pending curtain-removal timer');
  } finally {
    global.setTimeout = previous.setTimeout;
    global.clearTimeout = previous.clearTimeout;
    global.__JENNY_STARTUP_OVERLAY_SLOW_MS = previous.slowMs;
    global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = previous.maxMs;
    global.inventoryActionButton = previous.actionButton;
    dom.window.close();
  }
});

test('blocked state survives the slow threshold and dismisses at the hard backstop', () => {
  const previous = {
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    slowMs: global.__JENNY_STARTUP_OVERLAY_SLOW_MS,
    maxMs: global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS,
    actionButton: global.inventoryActionButton,
  };
  const scheduled = [];
  global.setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; };
  global.clearTimeout = () => {};
  global.__JENNY_STARTUP_OVERLAY_SLOW_MS = 8;
  global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = 20;
  global.inventoryActionButton = actionButton;
  const dom = createCurtainDom();
  const logs = [];
  try {
    const controller = createController(dom.window.document, {
      appendClientLog(level, event, detail) { logs.push({ level, event, detail }); },
    });
    controller.handleBackendStatus({ phase: 'model_unavailable' });
    scheduled.find((entry) => entry.delay === 8).callback();
    const overlay = dom.window.document.getElementById('startupOverlay');
    assert.equal(overlay.dataset.state, 'blocked');
    assert.equal(dom.window.document.querySelector('[data-action="startup-continue"]')?.textContent, 'Continue');
    assert.match(dom.window.document.getElementById('startupOverlaySecondary').textContent, /configured model is unavailable/i);

    scheduled.find((entry) => entry.delay === 20).callback();
    assert.equal(overlay.classList.contains('hidden'), true);
    assert.deepEqual(logs[0], {
      level: 'WARN',
      event: 'startup.curtain_backstop_dismissed',
      detail: { state: 'blocked' },
    });
    controller.dispose();
  } finally {
    global.setTimeout = previous.setTimeout;
    global.clearTimeout = previous.clearTimeout;
    global.__JENNY_STARTUP_OVERLAY_SLOW_MS = previous.slowMs;
    global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = previous.maxMs;
    global.inventoryActionButton = previous.actionButton;
    dom.window.close();
  }
});

test('elapsed backstop waits through a fatal dialog then dismisses on recovery progress', () => {
  const previous = {
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    slowMs: global.__JENNY_STARTUP_OVERLAY_SLOW_MS,
    maxMs: global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS,
    actionButton: global.inventoryActionButton,
  };
  const scheduled = [];
  global.setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; };
  global.clearTimeout = () => {};
  global.__JENNY_STARTUP_OVERLAY_SLOW_MS = 8;
  global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = 20;
  global.inventoryActionButton = actionButton;
  const dom = createCurtainDom('<main id="appShell"><section></section></main>');
  const logs = [];
  try {
    const controller = createController(dom.window.document, {
      appendClientLog(level, event, detail) { logs.push({ level, event, detail }); },
    });
    const overlay = dom.window.document.getElementById('startupOverlay');
    controller.handleBackendStatus({ phase: 'failed', detail: 'Backend failed.' });
    scheduled.find((entry) => entry.delay === 8).callback();
    assert.equal(overlay.dataset.state, 'error', 'slow state must not replace a fatal dialog');
    scheduled.find((entry) => entry.delay === 20).callback();
    assert.equal(overlay.classList.contains('hidden'), false);
    assert.equal(logs.length, 0);

    controller.handleBackendStatus({ phase: 'sidecar_spawned', detail: 'Retrying.' });
    assert.equal(overlay.getAttribute('role'), 'status');
    assert.equal(overlay.dataset.state, 'slow', 'elapsed slow state resumes after fatal recovery');
    assert.equal(overlay.classList.contains('hidden'), true);
    assert.equal(logs[0]?.event, 'startup.curtain_backstop_dismissed');
    controller.dispose();
  } finally {
    global.setTimeout = previous.setTimeout;
    global.clearTimeout = previous.clearTimeout;
    global.__JENNY_STARTUP_OVERLAY_SLOW_MS = previous.slowMs;
    global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = previous.maxMs;
    global.inventoryActionButton = previous.actionButton;
    dom.window.close();
  }
});

test('curtain handoff forwards once and backend Retry stays coalesced', async (t) => {
  const dom = createCurtainDom('');
  const documentRef = dom.window.document;
  const previousGlobals = {
    lifecycleProgressUtils: global.lifecycleProgressUtils,
    rendererActivityPrefsUtils: global.rendererActivityPrefsUtils,
    rendererTurnStatusPill: global.rendererTurnStatusPill,
    inventory: global.inventory,
    inventoryActionButton: global.inventoryActionButton,
    jennyShell: global.jennyShell,
  };
  global.lifecycleProgressUtils = lifecycleUtils;
  global.rendererActivityPrefsUtils = {};
  global.rendererTurnStatusPill = {};
  global.inventoryActionButton = actionButton;
  global.inventory = {};
  let rejectRetry;
  let retryCalls = 0;
  const retryLogs = [];
  global.jennyShell = {
    backend: {
      retryStart() {
        retryCalls += 1;
        return new Promise((_resolve, reject) => { rejectRetry = reject; });
      },
    },
  };
  t.after(() => {
    Object.assign(global, previousGlobals);
    dom.window.close();
  });
  const state = lifecycleState();
  state.backend = { phase: 'ready', detail: '' };
  const toasts = [];
  let removalRefreshes = 0;
  let controller;
  controller = createShellStatusController({
    state,
    constants: { ACTIVITY_SCOPE: {} },
    dom: {
      startupOverlay: documentRef.getElementById('startupOverlay'),
      startupOverlayLabel: documentRef.getElementById('startupOverlayLabel'),
      startupOverlaySublabel: documentRef.getElementById('startupOverlaySublabel'),
      startupOverlaySecondary: documentRef.getElementById('startupOverlaySecondary'),
    },
    callbacks: {
      getMostRecentActivity() { return null; },
      applyActivityAttributes() {},
      appendClientLog(level, event, detail) { retryLogs.push({ level, event, detail }); },
      showToastMessage(message, options) { toasts.push({ message, options: options || {} }); return 'toast'; },
      dismissToastsBySource() {},
      toastSource: 'shell.backend',
      onStartupRemoved() {
        removalRefreshes += 1;
        controller.syncBackendNotice();
      },
    },
  });
  t.after(() => controller.dispose());

  /* While the curtain is mounted it owns the screen: nothing else may speak,
   * even for a failure, because the curtain raises its own fatal dialog. */
  state.backend = { phase: 'failed', detail: 'Backend failed.' };
  controller.syncBackendNotice();
  assert.deepEqual(toasts, [], 'suppressed while the curtain is mounted');

  state.backend = { phase: 'ready', detail: '' };
  controller.notifyBootViewReady('chat');
  controller.handleLifecycleBackendStatus({ phase: 'ready' });
  documentRef.getElementById('startupOverlay').dispatchEvent(new dom.window.Event('transitionend'));
  assert.equal(removalRefreshes, 1, 'notice sync is forwarded once the curtain leaves the DOM');
  assert.equal(documentRef.getElementById('startupOverlay'), null, 'curtain node is gone');

  /* Now the curtain is gone, a failure surfaces — as a toast carrying Retry,
   * not as a banner that shoves the workspace down. */
  state.backend = { phase: 'failed', detail: 'Backend failed.' };
  controller.syncBackendNotice();
  assert.equal(toasts.length, 1, 'failure raises exactly one toast');
  assert.equal(toasts[0].options.tone, 'danger');
  const retryAction = toasts[0].options.actions.find((a) => a.id === 'backend-retry');
  assert.ok(retryAction, 'toast carries a Retry action');

  /* Three entry points, one in-flight call: the toast's Retry, a second click
   * on it, and the health pill popover's Retry all share this latch. */
  retryAction.onClick();
  retryAction.onClick();
  controller.retryBackendStart();
  await Promise.resolve();
  assert.equal(retryCalls, 1, 'concurrent retries coalesce into one backend start');

  /* A rejected retry must log a reason code and never the payload itself. */
  rejectRetry(new Error('sensitive backend payload must not be logged'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(retryLogs.find((entry) => entry.event === 'startup.backend_retry_rejected'), {
    level: 'WARN',
    event: 'startup.backend_retry_rejected',
    detail: { reason: 'retry_start_rejected' },
  });
  assert.ok(
    !JSON.stringify(retryLogs).includes('sensitive backend payload'),
    'the rejection reason is logged, never the error payload'
  );

  /* A bridge without retryStart is reported distinctly rather than throwing. */
  global.jennyShell = { backend: {} };
  await controller.retryBackendStart();
  assert.ok(retryLogs.some((entry) => entry.event === 'startup.backend_retry_rejected'
    && entry.detail.reason === 'retry_unavailable'));
});

test('boot styling owns cluster scale, window-control stacking, reduced motion, and Paper-readable text', () => {
  const foundation = fs.readFileSync(path.join(__dirname, '..', 'styles', 'foundation.css'), 'utf8');
  const shellChrome = fs.readFileSync(path.join(__dirname, '..', 'styles', 'shell-chrome.css'), 'utf8');
  const curtain = fs.readFileSync(path.join(__dirname, '..', 'styles', 'startup-overlay.css'), 'utf8');
  const paper = fs.readFileSync(path.join(__dirname, '..', 'styles', 'palette-paper.css'), 'utf8');

  assert.match(foundation, /--z-boot-curtain:\s*90/);
  assert.match(foundation, /--z-window-controls:\s*95/);
  const rootTokenBlock = curtain.match(/:root\s*\{([\s\S]*?)\}/)?.[1] || '';
  const contentBlock = curtain.match(/\.startup-overlay-content\s*\{([\s\S]*?)\}/)?.[1] || '';
  const hiddenContentBlock = curtain.match(/\.startup-overlay\.hidden \.startup-overlay-content\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert.equal((rootTokenBlock.match(/--startup-[a-z-]+\s*:/g) || []).length, 8);
  assert.match(shellChrome, /\.window-controls\s*\{[\s\S]*z-index:\s*var\(--z-window-controls\)/);
  assert.match(contentBlock, /transform:\s*scale\(1\.5\)/);
  assert.match(contentBlock, /transform-origin:\s*center/);
  assert.match(hiddenContentBlock, /transform:\s*translateY\(-6px\) scale\(1\.5\)/);
  assert.match(curtain, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.startup-overlay\s*\{[\s\S]*transition:\s*none/);
  assert.match(curtain, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.startup-overlay\.hidden \.startup-overlay-content\s*\{[\s\S]*transform:\s*scale\(1\.5\)/);
  assert.match(curtain, /\.startup-overlay\.hidden\s*\{[\s\S]*display:\s*flex\s*!important;[\s\S]*opacity:\s*0/);
  assert.match(paper, /--text-primary:/);
  assert.doesNotMatch(paper, /\.auth-overlay/);
});

for (const restoredView of ['chat', 'logs', 'settings']) {
  test(`restored ${restoredView} waits for its first usable render before curtain dismissal`, async (t) => {
    const app = await loadRendererApp({ persistedActiveView: restoredView });
    t.after(async () => app.dispose());
    await waitForUi(app.window, 50);

    assert.equal(app.window.__rendererState.ui.activeView, restoredView);
    const curtain = app.window.document.getElementById('startupOverlay');
    assert.equal(curtain?.classList.contains('hidden') ?? true, true);
  });
}

test('restored IDE activation failure cannot strand the curtain', async (t) => {
  const app = await loadRendererApp({
    persistedActiveView: 'ide',
    shell: {
      workspaceIde: {
        async getState() { throw new Error('persisted IDE activation failed'); },
      },
    },
  });
  t.after(async () => app.dispose());
  await waitForUi(app.window, 80);

  assert.equal(app.window.__rendererState.ui.activeView, 'ide');
  const curtain = app.window.document.getElementById('startupOverlay');
  assert.equal(curtain?.classList.contains('hidden') ?? true, true);
});

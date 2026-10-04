const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createLifecycleProgressController,
  presentStartupOverlayFatalError,
  clearStartupOverlayFatalError,
  isStartupOverlayFatalActive,
} = require('../renderer/shell/renderer-lifecycle-progress-utils.js');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

function createClassListHost(initialClasses = [], options = {}) {
  const classes = new Set(initialClasses);
  const listeners = new Map();
  const selectorMap = options.selectors || {};
  return {
    innerHTML: '',
    textContent: '',
    attributes: new Map(),
    style: {
      setProperty(name, value) {
        this[name] = value;
      }
    },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    getAttribute(name) {
      return this.attributes.get(name);
    },
    addEventListener(type, listener) {
      const bucket = listeners.get(type) || [];
      bucket.push(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      const bucket = listeners.get(type) || [];
      const index = bucket.indexOf(listener);
      if (index !== -1) {
        bucket.splice(index, 1);
      }
      listeners.set(type, bucket);
    },
    __listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    __dispatch(type, event) {
      (listeners.get(type) || []).slice().forEach((listener) => listener(event));
    },
    parentNode: {
      removeChild() {},
    },
    querySelector(selector) {
      return selectorMap[selector] || null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    },
    disabled: false,
    focus(opts) {
      this.__focusCalls = (this.__focusCalls || 0) + 1;
      this.__lastFocusOpts = opts;
    },
  };
}

async function flushMicrotasks(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

test('startup overlay fails open after the max visible timeout elapses', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    startupOverlayMaxVisibleMs: 50,
  });
  const doc = window.document;
  const startupOverlay = doc.getElementById('startupOverlay');

  assert.ok(startupOverlay, 'expected startup overlay to exist at boot');

  await waitForUi(window, 120);

  assert.equal(startupOverlay.classList.contains('hidden'), true);
});

test('startup overlay uses the quiet-curtain tokens and plain text status host', () => {
  const startupCss = fs.readFileSync(
    path.join(__dirname, '..', 'styles', 'startup-overlay.css'),
    'utf8'
  );

  const rootTokenBlock = startupCss.match(/:root\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.deepEqual((rootTokenBlock.match(/--startup-[a-z-]+:/g) || []), ['--startup-bg:', '--startup-fade-ms:']);
  assert.match(startupCss, /transition: opacity var\(--startup-fade-ms\)/);
  assert.doesNotMatch(startupCss, /startup-overlay-status-row/);
});

test('startup overlay markup has no progress bar and names the line as its label', () => {
  const indexMarkup = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const curtainMarkup = indexMarkup.slice(indexMarkup.indexOf('id="startupOverlay"'), indexMarkup.indexOf('id="appShell"'));

  assert.doesNotMatch(curtainMarkup, /role="progressbar"/);
  assert.doesNotMatch(curtainMarkup, /startupOverlayProgress/);
  assert.match(curtainMarkup, /aria-labelledby="startupOverlaySublabel"/);
  assert.match(curtainMarkup, /data-i18n="setup\.startup\.restoringChats"/);
});

test('curtain message ignores detail, and load facts are read from phase keys, never sentences', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};

  try {
    const startupOverlay = createClassListHost();
    const startupOverlaySublabel = createClassListHost();
    const startupOverlaySecondary = createClassListHost();
    const state = {
      ui: { activeView: 'chat' },
      lifecycleProgress: {
        active: false, scenario: '', phase: '', startedAt: 0, error: '',
      },
    };
    const controller = createLifecycleProgressController({
      state,
      constants: { ACTIVITY_SCOPE: {} },
      dom: { startupOverlay, startupOverlaySublabel, startupOverlaySecondary },
      callbacks: { onStartupReady() {} },
    });

    controller.handleLifecycleProgress({
      scenario: 'startup', phase: 'sidecar_initialize', detail: 'Initializing engine...', stepIndex: 4, stepCount: 7, percent: 57, error: '',
    });
    assert.equal(startupOverlaySublabel.textContent, 'Restoring your chats', 'detail is dropped from the curtain');
    assert.equal(startupOverlay.getAttribute('data-percent'), undefined);

    // Main's wire shape since 2026-09-29: a phase key and facts, no sentence.
    controller.handleLifecycleProgress({
      scenario: 'startup', phase: 'model_loading', facts: { modelId: 'qwen3:8b', elapsedMs: 420 }, error: '', timestamp: 1,
    });
    assert.equal(state.lifecycleProgress.modelId, 'qwen3:8b');
    assert.equal(state.lifecycleProgress.phase, 'model_loading');
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('curtain line reads Restoring your chats, then Opening {view} once the session list is loaded', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const scheduled = [];
  global.setTimeout = (cb, delay) => { scheduled.push({ cb, delay }); return scheduled.length; };
  global.clearTimeout = () => {};
  try {
    const startupOverlaySublabel = createClassListHost();
    const state = {
      ui: { activeView: 'chat' },
      sessionListLoaded: false,
      lifecycleProgress: { active: false, scenario: '', startedAt: 0 },
    };
    createLifecycleProgressController({
      state,
      constants: { ACTIVITY_SCOPE: {} },
      dom: { startupOverlay: createClassListHost(), startupOverlaySublabel, startupOverlaySecondary: createClassListHost() },
      callbacks: { onStartupReady() {} },
    });
    assert.equal(startupOverlaySublabel.textContent, 'Restoring your chats');
    state.sessionListLoaded = true;
    const refresh = scheduled.find((entry) => entry.delay === 250);
    assert.ok(refresh, 'the line re-reads the shell state while the curtain is up');
    refresh.cb();
    assert.equal(startupOverlaySublabel.textContent, 'Opening Chat');
    state.ui.activeView = 'logs';
    scheduled.filter((entry) => entry.delay === 250).pop().cb();
    assert.equal(startupOverlaySublabel.textContent, 'Opening Diagnostics');
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('slow state adds the second line without re-centring: the action row is reserved from the start', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const previousSlow = globalThis.__JENNY_STARTUP_OVERLAY_SLOW_MS;
  const scheduled = [];
  global.setTimeout = (cb, delay) => { scheduled.push({ cb, delay }); return scheduled.length; };
  global.clearTimeout = () => {};
  globalThis.__JENNY_STARTUP_OVERLAY_SLOW_MS = 8;
  try {
    const actions = createClassListHost(['startup-overlay-actions']);
    const startupOverlay = createClassListHost([], { selectors: { '#startupOverlayActions': actions } });
    const startupOverlaySecondary = createClassListHost(['startup-overlay-secondary']);
    createLifecycleProgressController({
      state: { ui: { activeView: 'chat' }, lifecycleProgress: { active: false, scenario: '', startedAt: 0 } },
      constants: { ACTIVITY_SCOPE: {} },
      dom: { startupOverlay, startupOverlaySublabel: createClassListHost(), startupOverlaySecondary },
      callbacks: { onStartupReady() {} },
    });
    assert.equal(actions.classList.contains('startup-overlay-actions'), true);
    scheduled.find((entry) => entry.delay === 8).cb();
    assert.equal(startupOverlay.getAttribute('data-state'), 'slow');
    assert.equal(startupOverlaySecondary.textContent, 'Taking longer than usual');
    assert.equal(actions.classList.contains('startup-overlay-actions'), true, 'the same reserved row carries Continue anyway');

    const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'startup-overlay.css'), 'utf8');
    const rowRule = css.match(/\.startup-overlay-actions\s*\{([\s\S]*?)\}/)?.[1] || '';
    assert.match(rowRule, /min-height:\s*32px/);
    assert.doesNotMatch(css, /\.startup-overlay-actions:empty/, 'the row never collapses, so nothing re-centres');
    const secondaryRule = css.match(/\.startup-overlay-secondary\s*\{([\s\S]*?)\}/)?.[1] || '';
    assert.match(secondaryRule, /min-height:/);
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    globalThis.__JENNY_STARTUP_OVERLAY_SLOW_MS = previousSlow;
  }
});

test('startup overlay skips pointer tilt handlers when reduced motion is requested', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const previousMatchMedia = global.matchMedia;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  global.matchMedia = (query) => ({
    matches: String(query || '').includes('prefers-reduced-motion'),
  });

  try {
    const startupCard = createClassListHost();
    const startupOverlay = createClassListHost([], {
      selectors: {
        '.startup-card': startupCard,
      },
    });
    const state = {
      lifecycleProgress: {
        active: false,
        scenario: '',
        phase: '',
        detail: '',
        stepIndex: 0,
        stepCount: 0,
        percent: 0,
        startedAt: 0,
        error: '',
      },
    };
    createLifecycleProgressController({
      state,
      constants: {
        ACTIVITY_SCOPE: {
          lifecycleStartup: 'lifecycle.startup',
          lifecycleShutdown: 'lifecycle.shutdown',
          lifecycleModelSwitch: 'lifecycle.model-switch',
        },
      },
      dom: {
        startupOverlay,
        startupOverlayLabel: createClassListHost(),
        startupOverlaySublabel: createClassListHost(),
      },
      callbacks: {
        beginActivity() {},
        resolveActivity() {},
        failActivity() {},
        onStartupReady() {},
      },
    });

    assert.equal(startupOverlay.__listenerCount('mousemove'), 0);
    assert.equal(startupOverlay.__listenerCount('mouseleave'), 0);
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    global.matchMedia = previousMatchMedia;
  }
});

test('lifecycle progress keeps the curtain status plain text and renderer-owned', () => {
  const previousInventory = global.inventory;
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
    const renderedModels = [];
  global.inventory = {
    statusRow(model) {
      renderedModels.push({ ...model });
      return `<div class="inv-status-row" data-tone="${String(model.tone || '')}">${String(model.label || '')}:${String(model.badgeText || '')}:${String(model.message || '')}</div>`;
    },
  };
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};

  try {
    const startupOverlay = createClassListHost();
    const startupOverlayLabel = createClassListHost();
    const startupOverlaySublabel = createClassListHost();
    const state = {
      lifecycleProgress: {
        active: false,
        scenario: '',
        phase: '',
        detail: '',
        stepIndex: 0,
        stepCount: 0,
        percent: 0,
        startedAt: 0,
        error: '',
      },
    };
    const controller = createLifecycleProgressController({
      state,
      constants: {
        ACTIVITY_SCOPE: {
          lifecycleStartup: 'lifecycle.startup',
          lifecycleShutdown: 'lifecycle.shutdown',
          lifecycleModelSwitch: 'lifecycle.model-switch',
        },
      },
      dom: {
        startupOverlay,
        startupOverlayLabel,
        startupOverlaySublabel,
      },
      callbacks: {
        beginActivity() {},
        resolveActivity() {},
        failActivity() {},
        onStartupReady() {},
      },
    });

    controller.handleLifecycleProgress({
      scenario: 'startup',
      phase: 'sidecar_initialize',
      detail: 'Initializing engine...',
      stepIndex: 4,
      stepCount: 7,
      percent: 57,
      error: '',
    });

    // The curtain status is deliberately plain text and renderer-owned.
    assert.equal(startupOverlaySublabel.textContent, 'Restoring your chats');
    assert.equal(startupOverlaySublabel.innerHTML, '');
  } finally {
    global.inventory = previousInventory;
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('lifecycle progress keeps fatal state until authoritative backend recovery', () => {
  const previousInventory = global.inventory;
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.inventory = {
    statusRow(model) {
      return `<div class="inv-status-row" data-tone="${String(model.tone || '')}">${String(model.label || '')}:${String(model.badgeText || '')}:${String(model.message || '')}</div>`;
    },
  };
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};

  try {
    const startupOverlay = createClassListHost();
    const startupOverlayLabel = createClassListHost();
    const startupOverlaySublabel = createClassListHost();
    const startupOverlaySecondary = createClassListHost();
    const state = {
      lifecycleProgress: {
        active: false,
        scenario: '',
        phase: '',
        detail: '',
        stepIndex: 0,
        stepCount: 0,
        percent: 0,
        startedAt: 0,
        error: '',
      },
    };
    const controller = createLifecycleProgressController({
      state,
      constants: {
        ACTIVITY_SCOPE: {
          lifecycleStartup: 'lifecycle.startup',
          lifecycleShutdown: 'lifecycle.shutdown',
          lifecycleModelSwitch: 'lifecycle.model-switch',
        },
      },
      dom: {
        startupOverlay,
        startupOverlayLabel,
        startupOverlaySublabel,
        startupOverlaySecondary,
      },
      callbacks: {
        beginActivity() {},
        resolveActivity() {},
        failActivity() {},
        onStartupReady() {},
      },
    });

    // 1. Emit progress with error
    controller.handleLifecycleProgress({
      scenario: 'startup',
      phase: 'ollama_start',
      detail: 'Connection failed',
      stepIndex: 1,
      stepCount: 7,
      percent: 14,
      error: 'Inference engine failed to start',
    });

    assert.equal(startupOverlay.getAttribute('data-state'), 'error');
    assert.equal(startupOverlaySublabel.textContent, 'Jenny could not start');
    assert.match(startupOverlaySecondary.textContent, /Retry restarts the engine/);

    // A late progress event alone cannot prove recovery from the fatal state.
    controller.handleLifecycleProgress({
      scenario: 'startup',
      phase: 'sidecar_initialize',
      detail: 'Initializing engine...',
      stepIndex: 4,
      stepCount: 7,
      percent: 57,
      error: '',
    });

    assert.equal(startupOverlay.getAttribute('data-state'), 'error');

    controller.handleBackendStatus({ phase: 'sidecar_spawned', detail: 'Initializing engine...' });
    assert.equal(startupOverlay.getAttribute('data-state'), undefined);
    assert.equal(startupOverlaySublabel.textContent, 'Restoring your chats');
  } finally {
    global.inventory = previousInventory;
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('lifecycle progress dispose() tears down the startup starfield rAF loop', (t) => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="startupOverlay">'
    + '<canvas id="startupOverlaySky"></canvas><div class="startup-overlay-wordmark">Jenny</div>'
    + '<div id="startupOverlaySublabel"></div></div></body></html>', { pretendToBeVisual: true });
  const previousStarfield = globalThis.rendererStartupStarfield;
  globalThis.rendererStartupStarfield = require('../renderer/shell/renderer-startup-starfield.js');
  t.after(() => {
    globalThis.rendererStartupStarfield = previousStarfield;
    dom.window.close();
  });
  const frames = new Map();
  let nextId = 1;
  dom.window.requestAnimationFrame = (cb) => { const id = nextId++; frames.set(id, cb); return id; };
  dom.window.cancelAnimationFrame = (id) => { frames.delete(id); };
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, fillStyle: '', globalAlpha: 1,
  });
  const flush = (ts) => {
    const pending = Array.from(frames.values());
    frames.clear();
    pending.forEach((cb) => cb(ts));
  };

  const controller = createLifecycleProgressController({
    state: { lifecycleProgress: { active: false, scenario: '', startedAt: 0 } },
    constants: { ACTIVITY_SCOPE: {} },
    dom: {
      startupOverlay: dom.window.document.getElementById('startupOverlay'),
      startupOverlaySublabel: dom.window.document.getElementById('startupOverlaySublabel'),
    },
    callbacks: { onStartupReady() {} },
  });

  assert.ok(frames.size > 0, 'the starfield should schedule a frame at construction');
  flush(16);
  assert.ok(frames.size > 0, 'the starfield loop keeps rescheduling while visible');

  controller.dispose();
  assert.equal(frames.size, 0, 'dispose() must cancel the live starfield frame');
  flush(32);
  assert.equal(frames.size, 0, 'no starfield frame should be scheduled after dispose()');
});

function createStartupGateController(activeView, callbacks = {}) {
  const startupOverlayRetryButton = createClassListHost(['hidden']);
  const startupOverlay = createClassListHost([], {
    selectors: {
      '.startup-card': createClassListHost(),
      '#startupOverlayRetryButton': startupOverlayRetryButton,
    },
  });
  const state = {
    ui: { activeView },
    lifecycleProgress: {
      active: false,
      scenario: '',
      phase: '',
      detail: '',
      stepIndex: 0,
      stepCount: 0,
      percent: 0,
      startedAt: 0,
      error: '',
    },
  };
  const controller = createLifecycleProgressController({
    state,
    constants: {
      ACTIVITY_SCOPE: {
        lifecycleStartup: 'lifecycle.startup',
        lifecycleShutdown: 'lifecycle.shutdown',
        lifecycleModelSwitch: 'lifecycle.model-switch',
      },
    },
    dom: {
      startupOverlay,
      startupOverlayLabel: createClassListHost(),
      startupOverlaySublabel: createClassListHost(),
      startupOverlaySecondary: createClassListHost(),
    },
    callbacks: {
      beginActivity() {},
      resolveActivity() {},
      failActivity() {},
      onStartupReady() {},
      retryBackendStart: callbacks.retryBackendStart,
    },
  });
  return { controller, startupOverlay, startupOverlayRetryButton };
}

test('startup overlay holds for the Home boot view until it reports ready', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  try {
    const { controller, startupOverlay } = createStartupGateController('home');

    controller.handleBackendStatus({ phase: 'ready' });
    assert.equal(
      startupOverlay.classList.contains('hidden'),
      false,
      'overlay must not dismiss on backend-ready alone while Home is still loading'
    );

    controller.notifyBootViewReady();
    controller.notifyShellHydrated();
    assert.equal(
      startupOverlay.classList.contains('hidden'),
      true,
      'overlay dismisses once Home reports its first real render'
    );
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('startup overlay requires first usable render for non-Home boot views too', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  try {
    const { controller, startupOverlay } = createStartupGateController('chat');

    controller.handleBackendStatus({ phase: 'ready' });
    assert.equal(
      startupOverlay.classList.contains('hidden'),
      false,
      'backend readiness alone cannot dismiss a restored view'
    );
    controller.notifyBootViewReady();
    controller.notifyShellHydrated();
    assert.equal(startupOverlay.classList.contains('hidden'), true);
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('startup overlay surfaces a backend failure immediately (UIUX-021: as a modal alertdialog, not a silent dismiss)', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const previousWindow = global.window;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  global.window = { jennyShell: null };
  try {
    const { controller, startupOverlay, startupOverlayRetryButton } = createStartupGateController('home');

    controller.handleBackendStatus({ phase: 'failed', detail: 'sidecar crashed' });

    // UIUX-021 root cause: this used to call dismissStartupOverlay(), which
    // hid AND eventually removed the overlay -- the failure was shown for at
    // most one paint (role="status"/aria-live="polite", non-modal) before
    // vanishing. It must now stay visible as a modal alertdialog instead.
    assert.equal(
      startupOverlay.classList.contains('hidden'),
      false,
      'a backend failure must keep the overlay visible, not hide/remove it'
    );
    assert.equal(startupOverlay.getAttribute('role'), 'alertdialog');
    assert.equal(startupOverlay.getAttribute('aria-modal'), 'true');
    assert.equal(startupOverlay.getAttribute('aria-live'), 'assertive');
    assert.equal(startupOverlay.getAttribute('data-state'), 'error');

    // A real, keyboard-activatable Retry button — not click-anywhere.
    assert.equal(startupOverlayRetryButton.classList.contains('hidden'), false);
    assert.equal(startupOverlayRetryButton.disabled, false);
    assert.equal(startupOverlayRetryButton.__focusCalls >= 1, true, 'focus must transfer onto the dialog/Retry control');
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    global.window = previousWindow;
  }
});

test('a startup error after the curtain has lifted does not resurrect it as a modal (the shell is already in use)', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const previousWindow = global.window;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  global.window = { jennyShell: null };
  try {
    const { controller, startupOverlay, startupOverlayRetryButton } = createStartupGateController('home');
    controller.notifyBootViewReady();
    controller.notifyShellHydrated();
    assert.equal(startupOverlay.classList.contains('hidden'), true, 'the curtain lifts on the shell, before the backend is done');

    controller.handleLifecycleProgress({
      scenario: 'startup', phase: 'sidecar_initialize', facts: {}, error: 'sidecar crashed', timestamp: 2,
    });
    assert.notEqual(startupOverlay.getAttribute('role'), 'alertdialog', 'a lifted curtain never becomes the alertdialog');
    assert.equal(startupOverlayRetryButton.classList.contains('hidden'), true, 'Retry stays on the pill and its toasts, not on a curtain nobody sees');
    assert.equal(Boolean(startupOverlayRetryButton.__focusCalls), false);

    controller.handleBackendStatus({ phase: 'failed', detail: 'sidecar crashed' });
    assert.notEqual(startupOverlay.getAttribute('role'), 'alertdialog');
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    global.window = previousWindow;
  }
});

test('startup overlay Retry delegates to the shared retry coordinator and repeat failures stay modal', async () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  const retryCalls = [];
  try {
    const { controller, startupOverlay, startupOverlayRetryButton } = createStartupGateController('home', {
      retryBackendStart(button) { retryCalls.push(button); return Promise.resolve(); },
    });

    controller.handleBackendStatus({ phase: 'failed', detail: 'sidecar crashed' });
    assert.equal(startupOverlayRetryButton.__listenerCount('click'), 1);

    startupOverlayRetryButton.__dispatch('click');
    await flushMicrotasks();

    assert.deepEqual(retryCalls, [startupOverlayRetryButton]);

    // Repeat failure (retry didn't fix it): stays modal, re-focuses Retry,
    // does not stack a second click listener.
    startupOverlayRetryButton.__focusCalls = 0;
    controller.handleBackendStatus({ phase: 'failed', detail: 'sidecar crashed again' });
    assert.equal(startupOverlay.classList.contains('hidden'), false);
    assert.equal(startupOverlay.getAttribute('role'), 'alertdialog');
    assert.equal(startupOverlayRetryButton.__listenerCount('click'), 1, 'no duplicate listener across repeat failures');
    assert.equal(startupOverlayRetryButton.__focusCalls, 1, 'repeat failure re-announces via a fresh focus move');
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('startup overlay recovers from fatal mode on a subsequent ready status: role/aria-live revert, Retry hides, focus restores', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const previousWindow = global.window;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  global.window = { jennyShell: null };
  try {
    const { controller, startupOverlay, startupOverlayRetryButton } = createStartupGateController('chat');
    const priorFocusTarget = createClassListHost();
    // No real `document` exists in this unit-test context, so
    // presentStartupOverlayFatalError falls back to a null focus-return
    // target; exercise clearStartupOverlayFatalError directly (it is the
    // exact function handleBackendStatus's ready branch calls) with an
    // injected focus-return to prove the restore path.
    presentStartupOverlayFatalError(startupOverlay, { onRetry() {} });
    startupOverlay.__jennyStartupFocusReturn = priorFocusTarget;

    assert.equal(startupOverlay.getAttribute('role'), 'alertdialog');
    assert.equal(startupOverlayRetryButton.classList.contains('hidden'), false);

    controller.handleBackendStatus({ phase: 'ready' });

    assert.equal(startupOverlay.getAttribute('role'), 'status');
    assert.equal(startupOverlay.getAttribute('aria-live'), 'polite');
    assert.equal(startupOverlay.getAttribute('aria-modal'), undefined);
    assert.equal(startupOverlayRetryButton.classList.contains('hidden'), false, 'standalone mock keeps its action node');
    assert.equal(priorFocusTarget.__focusCalls, 1, 'focus restores to whatever had it before the failure');
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    global.window = previousWindow;
  }
});

test('dismissStartupOverlay() never silently drops a fatal-mode overlay (e.g. the fail-open fallback firing mid-failure)', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const previousMaxVisible = globalThis.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS;
  const scheduled = [];
  global.setTimeout = (cb, delay) => { scheduled.push({ cb, delay }); return scheduled.length; };
  global.clearTimeout = () => {};
  globalThis.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = 50;
  try {
    const { controller, startupOverlay } = createStartupGateController('home');

    controller.handleBackendStatus({ phase: 'failed', detail: 'sidecar crashed' });
    assert.equal(startupOverlay.classList.contains('hidden'), false);

    const fallback = scheduled.find((entry) => entry.delay === 50);
    assert.ok(fallback, 'the fail-open fallback timer must be scheduled at construction');
    fallback.cb();

    assert.equal(
      startupOverlay.classList.contains('hidden'),
      false,
      'the fail-open fallback must not force-dismiss a live fatal-error alertdialog'
    );
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    globalThis.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = previousMaxVisible;
  }
});

test('presentStartupOverlayFatalError / clearStartupOverlayFatalError work standalone (UIUX-021: renderer/app.js top-level composition-failure guard uses these with no controller instance)', () => {
  const overlay = createClassListHost([], {
    selectors: { '#startupOverlayRetryButton': createClassListHost(['hidden']) },
  });
  const retryButton = overlay.querySelector('#startupOverlayRetryButton');
  const onRetryCalls = [];

  presentStartupOverlayFatalError(overlay, { onRetry: () => onRetryCalls.push(1) });

  assert.equal(overlay.getAttribute('role'), 'alertdialog');
  assert.equal(overlay.getAttribute('aria-modal'), 'true');
  assert.equal(overlay.getAttribute('aria-live'), 'assertive');
  assert.equal(retryButton.classList.contains('hidden'), false);
  assert.equal(retryButton.__focusCalls, 1);
  assert.equal(isStartupOverlayFatalActive(overlay), true);

  retryButton.__dispatch('click');
  assert.deepEqual(onRetryCalls, [1]);

  clearStartupOverlayFatalError(overlay);

  assert.equal(overlay.getAttribute('role'), 'status');
  assert.equal(overlay.getAttribute('aria-live'), 'polite');
  assert.equal(overlay.getAttribute('aria-modal'), undefined);
  assert.equal(retryButton.classList.contains('hidden'), false, 'clear restores semantics; action rendering owns removal');
  assert.equal(isStartupOverlayFatalActive(overlay), false);

  // Idempotent: a second clear (e.g. app.js's guard firing once more) is a no-op.
  clearStartupOverlayFatalError(overlay);
  assert.equal(overlay.getAttribute('role'), 'status');
});

test('startup overlay fails open via the fallback even while the Home gate is holding', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const previousMaxVisible = globalThis.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS;
  const scheduled = [];
  global.setTimeout = (cb, delay) => { scheduled.push({ cb, delay }); return scheduled.length; };
  global.clearTimeout = () => {};
  // Known fail-open ceiling so the construction-time fallback is identifiable.
  globalThis.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = 50;
  try {
    const { controller, startupOverlay } = createStartupGateController('home');

    // Backend is ready but Home never signals — the gate holds the overlay.
    controller.handleBackendStatus({ phase: 'ready' });
    assert.equal(
      startupOverlay.classList.contains('hidden'),
      false,
      'gate must hold while Home has not reported ready'
    );

    // Fire the fail-open fallback armed unconditionally at construction.
    const fallback = scheduled.find((entry) => entry.delay === 50);
    assert.ok(fallback, 'the fail-open fallback timer must be scheduled at construction');
    fallback.cb();
    assert.equal(
      startupOverlay.classList.contains('hidden'),
      true,
      'the fallback must force-dismiss the overlay even when the boot-view gate is blocking'
    );
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    globalThis.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = previousMaxVisible;
  }
});

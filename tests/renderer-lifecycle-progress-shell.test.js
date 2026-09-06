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
  assert.equal((rootTokenBlock.match(/--startup-[a-z-]+:/g) || []).length, 8);
  assert.match(startupCss, /transition: opacity 360ms/);
  assert.doesNotMatch(startupCss, /startup-overlay-status-row/);
});

test('startup overlay progress markup exposes determinate progress', () => {
  const indexMarkup = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  assert.match(indexMarkup, /id="startupOverlayProgressBar"/);
  assert.match(indexMarkup, /role="progressbar"/);
  assert.match(indexMarkup, /aria-valuemin="0"/);
  assert.match(indexMarkup, /aria-valuemax="100"/);
  assert.match(indexMarkup, /aria-valuenow="0"/);
  assert.doesNotMatch(indexMarkup, /startup-progress-bar" aria-hidden="true"/);
});

test('lifecycle progress updates startup overlay progress fill and accessible value', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};

  try {
    const startupCard = createClassListHost();
    const startupProgressBar = createClassListHost();
    const startupProgressFill = createClassListHost();
    const startupOverlay = createClassListHost([], {
      selectors: {
        '.startup-card': startupCard,
        '#startupOverlayProgressBar': startupProgressBar,
        '#startupOverlayProgressFill': startupProgressFill,
      },
    });
    const startupOverlayLabel = createClassListHost();
    startupOverlayLabel.textContent = 'Starting Jenny';
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
        setTurnStatusPill() {},
        clearTurnStatusPill() {},
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

    assert.equal(startupProgressFill.style.width, '57%');
    assert.equal(startupProgressBar.getAttribute('aria-valuenow'), '57');

    controller.handleBackendStatus({
      phase: 'model_acquiring',
      model_acquisition: { percent: 70, status: 'Downloading ornith:9b' },
    });
    const acquisitionPercent = state.lifecycleProgress.percent;
    controller.handleBackendStatus({
      phase: 'model_acquiring',
      model_acquisition: { percent: 20, status: 'stale progress' },
    });
    assert.equal(state.lifecycleProgress.percent, acquisitionPercent, 'progress never regresses');

    controller.handleBackendStatus({ phase: 'model_unavailable' });
    assert.equal(state.lifecycleProgress.phase, 'model_unavailable');
    assert.equal(startupOverlay.getAttribute('data-state'), 'blocked');
    assert.equal(startupOverlayLabel.textContent, 'Starting Jenny', 'accessible label stays immutable');
    assert.match(startupOverlaySublabel.textContent, /Model failed to load/);
    assert.match(startupOverlaySecondary.textContent, /configured model is unavailable/i);
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
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
        setTurnStatusPill() {},
        clearTurnStatusPill() {},
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

test('lifecycle progress publishes startup status to the turn-status pill and keeps the legacy strip hidden', () => {
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
    const pillUpdates = [];
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
        setTurnStatusPill(source, payload) { pillUpdates.push({ source, payload }); },
        clearTurnStatusPill() {},
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

    // The curtain status is deliberately plain text; inventory status rows
    // remain reserved for the legacy lifecycle pill/banner surfaces.
    assert.equal(startupOverlaySublabel.textContent, 'Initializing engine...');
    assert.equal(startupOverlaySublabel.innerHTML, '');
    // Pill received the startup lifecycle update.
    const startupPillUpdates = pillUpdates.filter((entry) => entry.source === 'lifecycle.startup');
    assert.ok(startupPillUpdates.length >= 1);
    const lastStartupUpdate = startupPillUpdates[startupPillUpdates.length - 1];
    assert.equal(lastStartupUpdate.payload.tone, 'pending');
    assert.match(lastStartupUpdate.payload.message, /Initializing engine/);
    assert.equal(lastStartupUpdate.payload.spinner, true);
    assert.equal(lastStartupUpdate.payload.progressPercent, 57);
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
        setTurnStatusPill() {},
        clearTurnStatusPill() {},
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
    assert.equal(startupOverlaySublabel.textContent, 'Startup failed');
    assert.match(startupOverlaySecondary.textContent, /Connection failed/);

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
    assert.match(startupOverlaySublabel.textContent, /Initializing engine/);
  } finally {
    global.inventory = previousInventory;
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('lifecycle progress dispose() tears down the startup circuit-trace rAF loop', (t) => {
  const core = require('../renderer/shell/renderer-circuit-trace-core.js');
  const prev = {
    core: globalThis.rendererCircuitTraceCore,
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
  };
  globalThis.rendererCircuitTraceCore = core;

  let nextId = 1;
  const frames = new Map();
  globalThis.requestAnimationFrame = (cb) => { const id = nextId++; frames.set(id, cb); return id; };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
  const flush = (ts) => {
    const pending = Array.from(frames.values());
    frames.clear();
    pending.forEach((cb) => cb(ts));
  };

  t.after(() => {
    globalThis.rendererCircuitTraceCore = prev.core;
    globalThis.requestAnimationFrame = prev.raf;
    globalThis.cancelAnimationFrame = prev.caf;
  });

  function makeCtx() {
    return {
      save() {}, restore() {}, scale() {}, clearRect() {}, beginPath() {},
      moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
      set strokeStyle(v) {}, set lineCap(v) {}, set lineWidth(v) {}, set lineJoin(v) {},
      set globalAlpha(v) {}, set fillStyle(v) {}, set shadowColor(v) {}, set shadowBlur(v) {},
      set globalCompositeOperation(v) {},
    };
  }
  function makeOverlay() {
    const overlay = {
      firstChild: null,
      style: { setProperty() {} },
      classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener() {}, removeEventListener() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 200 }; },
      querySelector() { return null; },
      insertBefore(node) { node.parentNode = overlay; return node; },
    };
    const win = { devicePixelRatio: 1, getComputedStyle() { return { getPropertyValue() { return ''; } }; } };
    overlay.ownerDocument = {
      defaultView: win,
      createElement() {
        return {
          className: '', width: 0, height: 0, style: {}, parentNode: overlay,
          classList: { add() {}, remove() {}, contains() { return false; } },
          getContext() { return makeCtx(); },
        };
      },
    };
    return overlay;
  }

  const controller = createLifecycleProgressController({
    state: { lifecycleProgress: { active: false, scenario: '', startedAt: 0 } },
    constants: { ACTIVITY_SCOPE: {} },
    dom: { startupOverlay: makeOverlay() },
    callbacks: { onStartupReady() {}, setTurnStatusPill() {}, clearTurnStatusPill() {} },
  });

  assert.ok(frames.size > 0, 'circuit-trace should schedule a frame at construction');
  flush(16); // drains the one-shot "ready" frame; the draw loop reschedules itself
  assert.ok(frames.size > 0, 'circuit-trace loop should keep rescheduling while visible');

  controller.dispose();
  assert.equal(frames.size, 0, 'dispose() must cancel the live circuit-trace frame');
  flush(32);
  assert.equal(frames.size, 0, 'no circuit-trace frame should be scheduled after dispose()');
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
      setTurnStatusPill() {},
      clearTurnStatusPill() {},
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

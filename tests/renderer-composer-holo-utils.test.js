const test = require('node:test');
const assert = require('node:assert/strict');

const { createComposerHoloController } = require('../renderer/chat/renderer-composer-holo-utils.js');

function createContextRecorder() {
  const strokeCalls = [];
  const clearCalls = [];
  const ctx = {
    globalAlpha: 1,
    lineWidth: 0,
    strokeStyle: null,
    shadowBlur: 0,
    shadowColor: '',
    setTransform() {},
    clearRect(...args) { clearCalls.push(args); },
    createConicGradient() {
      return {
        addColorStop() {},
      };
    },
    save() {},
    beginPath() {},
    roundRect() {},
    stroke() {
      strokeCalls.push({
        lineWidth: this.lineWidth,
        globalAlpha: this.globalAlpha,
      });
    },
    restore() {},
  };
  return { ctx, strokeCalls, clearCalls };
}

function createFrameScheduler() {
  let nextHandle = 1;
  const pending = new Map();
  return {
    request(callback) {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    cancel(handle) { pending.delete(handle); },
    flush(timestamp = 16) {
      const entry = pending.entries().next().value;
      if (!entry) return false;
      pending.delete(entry[0]);
      entry[1](timestamp);
      return true;
    },
    get size() { return pending.size; },
  };
}

function installWindowMock(styleProps, metrics = null) {
  const previousWindow = global.window;
  global.window = {
    devicePixelRatio: 1,
    getComputedStyle() {
      if (metrics) metrics.computedStyleReads += 1;
      return {
        borderRadius: '26px',
        getPropertyValue(name) {
          return Object.prototype.hasOwnProperty.call(styleProps, name)
            ? String(styleProps[name])
            : '';
        },
      };
    },
  };
  return function restoreWindow() {
    global.window = previousWindow;
  };
}

test('composer holo draw scales inference chrome from CSS intensity tokens', () => {
  const { ctx, strokeCalls } = createContextRecorder();
  const restoreWindow = installWindowMock({
    '--composer-holo-border-width': '2.4',
    '--composer-holo-draw-enabled': '1',
    '--composer-holo-draw-stroke-scale': '1.24',
    '--composer-holo-draw-glow-scale': '1.28',
    '--composer-holo-draw-alpha-scale': '1.16',
    '--composer-holo-draw-glow-alpha-scale': '1.22',
  });

  try {
    const controller = createComposerHoloController({
      composer: {},
      composerHolo: {},
      composerHoloContext: ctx,
      composerHoloRuntime: {
        active: true,
        supported: true,
        mode: 'inference',
        cssWidth: 480,
        cssHeight: 96,
        pixelRatio: 1,
      },
      reducedMotionQuery: { matches: false },
    });

    controller.drawComposerHolo();

    assert.equal(strokeCalls.length, 2);
    assert.ok(Math.abs(strokeCalls[0].lineWidth - 8.704) < 0.001);
    assert.ok(Math.abs(strokeCalls[0].globalAlpha - 0.4148) < 0.001);
    assert.ok(Math.abs(strokeCalls[1].lineWidth - 3.224) < 0.001);
  } finally {
    restoreWindow();
  }
});

test('composer holo draw skips rendering when the holo preset disables drawing', () => {
  const { ctx, strokeCalls } = createContextRecorder();
  const restoreWindow = installWindowMock({
    '--composer-holo-border-width': '0',
    '--composer-holo-draw-enabled': '0',
    '--composer-holo-draw-stroke-scale': '0',
    '--composer-holo-draw-glow-scale': '0',
    '--composer-holo-draw-alpha-scale': '0',
    '--composer-holo-draw-glow-alpha-scale': '0',
  });

  try {
    const controller = createComposerHoloController({
      composer: {},
      composerHolo: {},
      composerHoloContext: ctx,
      composerHoloRuntime: {
        active: true,
        supported: true,
        mode: 'typing',
        cssWidth: 480,
        cssHeight: 96,
        pixelRatio: 1,
      },
      reducedMotionQuery: { matches: false },
    });

    controller.drawComposerHolo();

    assert.equal(strokeCalls.length, 0);
  } finally {
    restoreWindow();
  }
});

test('disabled holo clears once and owns no recurring animation frame', () => {
  const { ctx, strokeCalls, clearCalls } = createContextRecorder();
  const scheduler = createFrameScheduler();
  const styleProps = {
    '--sprite-holo-draw-enabled': '0',
    '--sprite-holo-draw-stroke-scale': '0',
    '--sprite-holo-draw-glow-scale': '0',
    '--sprite-holo-draw-alpha-scale': '0',
    '--sprite-holo-draw-glow-alpha-scale': '0',
  };
  const restoreWindow = installWindowMock(styleProps);

  try {
    const runtime = {
      active: false,
      supported: true,
      mode: 'idle',
      cssWidth: 36,
      cssHeight: 36,
      pixelRatio: 1,
      frameHandle: 0,
      angle: 0,
    };
    const controller = createComposerHoloController({
      composer: {},
      composerHolo: {},
      composerHoloContext: ctx,
      composerHoloRuntime: runtime,
      reducedMotionQuery: { matches: false },
      cssVarPrefix: 'sprite-holo',
      requestAnimationFrame: (callback) => scheduler.request(callback),
      cancelAnimationFrame: (handle) => scheduler.cancel(handle),
    });

    controller.setComposerHoloState(true, 'inference');
    assert.equal(scheduler.size, 0);
    assert.equal(clearCalls.length, 1);
    assert.equal(strokeCalls.length, 0);

    controller.setComposerHoloState(true, 'inference');
    assert.equal(scheduler.size, 0);
    assert.equal(clearCalls.length, 2, 'explicit appearance refresh clears once without arming a loop');
  } finally {
    restoreWindow();
  }
});

test('live holo stops immediately when appearance disables drawing', () => {
  const { ctx, strokeCalls, clearCalls } = createContextRecorder();
  const scheduler = createFrameScheduler();
  const styleProps = {
    '--sprite-holo-border-width': '2',
    '--sprite-holo-draw-enabled': '1',
    '--sprite-holo-draw-stroke-scale': '1',
    '--sprite-holo-draw-glow-scale': '1',
    '--sprite-holo-draw-alpha-scale': '1',
    '--sprite-holo-draw-glow-alpha-scale': '1',
  };
  const restoreWindow = installWindowMock(styleProps);

  try {
    const runtime = {
      active: false,
      supported: true,
      mode: 'idle',
      cssWidth: 36,
      cssHeight: 36,
      pixelRatio: 1,
      frameHandle: 0,
      angle: 0,
    };
    const controller = createComposerHoloController({
      composer: {},
      composerHolo: {},
      composerHoloContext: ctx,
      composerHoloRuntime: runtime,
      reducedMotionQuery: { matches: false },
      cssVarPrefix: 'sprite-holo',
      requestAnimationFrame: (callback) => scheduler.request(callback),
      cancelAnimationFrame: (handle) => scheduler.cancel(handle),
    });

    controller.setComposerHoloState(true, 'inference');
    assert.equal(scheduler.size, 1);
    scheduler.flush(16);
    assert.equal(strokeCalls.length, 2);
    assert.equal(scheduler.size, 1);

    styleProps['--sprite-holo-draw-enabled'] = '0';
    controller.setComposerHoloState(true, 'inference');
    assert.equal(scheduler.size, 0, 'appearance refresh cancels the pending live frame');
    assert.equal(clearCalls.length, 2, 'the second clear removes the last live frame');

    controller.setComposerHoloState(false, 'idle');
    assert.equal(scheduler.size, 0);
    assert.equal(strokeCalls.length, 2);
  } finally {
    restoreWindow();
  }
});

test('reduced-motion changes restart only eligible live animation and dispose tears down listeners', () => {
  const { ctx } = createContextRecorder();
  const scheduler = createFrameScheduler();
  const listeners = new Set();
  const mediaQuery = {
    matches: false,
    addEventListener(_event, listener) { listeners.add(listener); },
    removeEventListener(_event, listener) { listeners.delete(listener); },
  };
  let resizeObserverDisconnected = false;
  class TestResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() { resizeObserverDisconnected = true; }
  }
  const restoreWindow = installWindowMock({ '--composer-holo-draw-enabled': '1' });

  try {
    const runtime = { active: false, supported: true, mode: 'idle', frameHandle: 0, angle: 0 };
    const controller = createComposerHoloController({
      composer: {},
      composerHolo: {
        width: 0,
        height: 0,
        getBoundingClientRect() { return { width: 480, height: 96 }; },
      },
      composerHoloContext: ctx,
      composerHoloRuntime: runtime,
      reducedMotionQuery: mediaQuery,
      ResizeObserver: TestResizeObserver,
      requestAnimationFrame: (callback) => scheduler.request(callback),
      cancelAnimationFrame: (handle) => scheduler.cancel(handle),
    });

    controller.initializeComposerHolo();
    assert.equal(listeners.size, 1);
    controller.setComposerHoloState(true, 'typing');
    assert.equal(scheduler.size, 1);

    mediaQuery.matches = true;
    listeners.forEach((listener) => listener());
    assert.equal(scheduler.size, 0);

    mediaQuery.matches = false;
    listeners.forEach((listener) => listener());
    assert.equal(scheduler.size, 1);

    controller.disposeComposerHolo();
    assert.equal(scheduler.size, 0);
    assert.equal(listeners.size, 0);
    assert.equal(resizeObserverDisconnected, true);
    controller.disposeComposerHolo();
    assert.equal(scheduler.size, 0);
  } finally {
    restoreWindow();
  }
});

test('unsupported canvas and missing ResizeObserver degrade without scheduling work', () => {
  const scheduler = createFrameScheduler();
  const runtime = { active: false, supported: false, mode: 'idle', frameHandle: 0, angle: 0 };
  const controller = createComposerHoloController({
    composer: {},
    composerHolo: null,
    composerHoloContext: null,
    composerHoloRuntime: runtime,
    reducedMotionQuery: { matches: false },
    ResizeObserver: null,
    requestAnimationFrame: (callback) => scheduler.request(callback),
    cancelAnimationFrame: (handle) => scheduler.cancel(handle),
  });

  assert.doesNotThrow(() => controller.initializeComposerHolo());
  assert.doesNotThrow(() => controller.setComposerHoloState(true, 'typing'));
  assert.equal(scheduler.size, 0);
  assert.doesNotThrow(() => controller.disposeComposerHolo());
});

test('live frames reuse computed style until an explicit appearance refresh', () => {
  const { ctx, strokeCalls } = createContextRecorder();
  const scheduler = createFrameScheduler();
  const metrics = { computedStyleReads: 0 };
  const styleProps = {
    '--sprite-holo-border-width': '2',
    '--sprite-holo-draw-enabled': '1',
    '--sprite-holo-draw-stroke-scale': '1',
    '--sprite-holo-draw-glow-scale': '1',
    '--sprite-holo-draw-alpha-scale': '1',
    '--sprite-holo-draw-glow-alpha-scale': '1',
  };
  const restoreWindow = installWindowMock(styleProps, metrics);

  try {
    const runtime = {
      active: false,
      supported: true,
      mode: 'idle',
      cssWidth: 36,
      cssHeight: 36,
      pixelRatio: 1,
      frameHandle: 0,
      angle: 0,
    };
    const canvas = {
      width: 36,
      height: 36,
      getBoundingClientRect() { return { width: 36, height: 36 }; },
    };
    const controller = createComposerHoloController({
      composer: {},
      composerHolo: canvas,
      composerHoloContext: ctx,
      composerHoloRuntime: runtime,
      reducedMotionQuery: { matches: false },
      cssVarPrefix: 'sprite-holo',
      requestAnimationFrame: (callback) => scheduler.request(callback),
      cancelAnimationFrame: (handle) => scheduler.cancel(handle),
    });

    controller.setComposerHoloState(true, 'inference');
    assert.equal(metrics.computedStyleReads, 1);
    controller.resizeComposerHoloCanvas();
    assert.equal(strokeCalls.length, 0, 'a live resize defers drawing to the pending animation frame');
    assert.equal(metrics.computedStyleReads, 2);
    scheduler.flush(16);
    scheduler.flush(32);
    assert.equal(metrics.computedStyleReads, 2, 'live frames reuse the transition snapshot');

    styleProps['--sprite-holo-draw-alpha-scale'] = '0.5';
    controller.setComposerHoloState(true, 'inference');
    assert.equal(metrics.computedStyleReads, 3, 'appearance refresh reads the updated CSS once');
    scheduler.flush(48);
    assert.equal(metrics.computedStyleReads, 3);
    controller.disposeComposerHolo();
  } finally {
    restoreWindow();
  }
});

test('uncancellable stale frames cannot duplicate a restarted loop or write after disposal', () => {
  const { ctx, strokeCalls, clearCalls } = createContextRecorder();
  const scheduler = createFrameScheduler();
  const restoreWindow = installWindowMock({ '--sprite-holo-draw-enabled': '1' });

  try {
    const runtime = {
      active: false,
      supported: true,
      mode: 'idle',
      cssWidth: 36,
      cssHeight: 36,
      pixelRatio: 1,
      frameHandle: 0,
      angle: 0,
    };
    const controller = createComposerHoloController({
      composer: {},
      composerHolo: {},
      composerHoloContext: ctx,
      composerHoloRuntime: runtime,
      reducedMotionQuery: { matches: false },
      cssVarPrefix: 'sprite-holo',
      requestAnimationFrame: (callback) => scheduler.request(callback),
      cancelAnimationFrame: () => {},
    });

    controller.setComposerHoloState(true, 'inference');
    controller.setComposerHoloState(false, 'idle');
    controller.setComposerHoloState(true, 'inference');
    assert.equal(scheduler.size, 2);
    scheduler.flush(16);
    assert.equal(scheduler.size, 1, 'the stale generation does not start a second loop');
    assert.equal(strokeCalls.length, 0);

    const clearCount = clearCalls.length;
    controller.disposeComposerHolo();
    scheduler.flush(32);
    assert.equal(runtime.frameHandle, 0);
    assert.equal(clearCalls.length, clearCount, 'a stale callback performs no canvas write after disposal');
    assert.equal(strokeCalls.length, 0);
  } finally {
    restoreWindow();
  }
});

test('partial canvas implementations and post-disposal draw calls fail closed', () => {
  let clearCount = 0;
  const partialContext = {
    setTransform() {},
    clearRect() { clearCount += 1; },
  };
  const restoreWindow = installWindowMock({ '--composer-holo-draw-enabled': '1' });

  try {
    const runtime = {
      active: true,
      supported: true,
      mode: 'typing',
      cssWidth: 36,
      cssHeight: 36,
      pixelRatio: 1,
      frameHandle: 0,
      angle: 0,
    };
    const controller = createComposerHoloController({
      composer: null,
      composerHolo: {},
      composerHoloContext: partialContext,
      composerHoloRuntime: runtime,
      reducedMotionQuery: { matches: false },
      ResizeObserver: null,
    });

    assert.doesNotThrow(() => controller.drawComposerHolo());
    assert.equal(clearCount, 1, 'a partial context is cleared before static CSS takes over');
    assert.doesNotThrow(() => controller.resizeComposerHoloCanvas());
    controller.disposeComposerHolo();
    assert.doesNotThrow(() => controller.drawComposerHolo());
    assert.equal(clearCount, 1, 'disposed controllers reject direct canvas writes');
  } finally {
    restoreWindow();
  }
});

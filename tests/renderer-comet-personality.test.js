const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCometPersonality,
} = require('../renderer/features/renderer-comet-personality');
const {
  createAnchoredOrbit,
} = require('../comet/behaviors/anchored-orbit');
const { createManualScheduler } = require('./helpers/manual-scheduler');

function assertAmbientIdleActivation(entry) {
  assert.equal(entry[0], 'idle-drift');
  assert.deepEqual(entry[1].bounds, { width: 800, height: 600 });
  assert.equal(entry[1].centerX, 240);
  assert.equal(entry[1].centerY, 240);
  assert.equal(entry[1].rangeX, 144);
  assert.ok(Math.abs(entry[1].rangeY - 84) < 1e-9);
}

// Cases that pass no scheduler get the real one, and a terminal event arms a
// REFERENCED 2.5s timer inside the personality. dispose() clears it; nothing
// called it, so this file held the event loop ~2.5s past its last assertion.
const livePersonalities = [];
test.afterEach(() => {
  while (livePersonalities.length) {
    try { livePersonalities.pop().dispose(); } catch { /* already disposed */ }
  }
});

function createHarness(overrides = {}) {
  const calls = {
    activate: [],
    setPosition: [],
    cometStep: [],
  };
  let headPosition = { x: 0, y: 0 };
  const comet = {
    setColorPalette() {},
    setTailLength() {},
    setSpeed() {},
    setPosition() {},
    getHeadPosition() {
      return { x: headPosition.x, y: headPosition.y };
    },
    clearTail() {},
    setVisualScale() {},
    step(timestamp) {
      calls.cometStep.push(timestamp);
    },
  };
  const behaviorEngine = {
    has(name) {
      return ['idle-drift', 'settle', 'alert', 'excited', 'anchored-orbit'].includes(name);
    },
    activate(name, params) {
      calls.activate.push([name, params]);
    },
    setPosition(x, y) {
      calls.setPosition.push([x, y]);
    },
    update() {
      return { x: 0, y: 0 };
    },
    getActiveBehaviorInstance() {
      return null;
    },
  };
  const personality = createCometPersonality({
    behaviorEngine,
    comet,
    scheduler: overrides.scheduler,
    visibilityProvider: overrides.visibilityProvider,
    manualClock: overrides.manualClock,
    container: {
      getBoundingClientRect() {
        return { width: 800, height: 600, top: 0, left: 0 };
      },
      addEventListener() {},
      removeEventListener() {},
    },
    dom: {
      chatInput: {
        getBoundingClientRect() {
          return { left: 0, top: 0, height: 40 };
        },
        addEventListener() {},
        removeEventListener() {},
      },
      chatThreadScroll: {
        getBoundingClientRect() {
          return { left: 0, top: 0, height: 400 };
        },
      },
    },
  });
  livePersonalities.push(personality);
  return {
    personality,
    calls,
    setHeadPosition(x, y) {
      headPosition = { x: x, y: y };
    },
  };
}

function loadCometPersonalityFresh() {
  const modulePath = require.resolve('../renderer/features/renderer-comet-personality');
  delete require.cache[modulePath];
  return require(modulePath);
}

test('done transitions return from happy to idle instead of restoring thinking', () => {
  const scheduler = createManualScheduler();
  const { personality } = createHarness({ scheduler });

  personality.onStreamEvent('thinking');
  assert.equal(personality.getState(), 'thinking');

  personality.onStreamEvent('done');
  assert.equal(personality.getState(), 'happy');

  scheduler.advanceBy(2600);
  assert.equal(personality.getState(), 'idle');
});

test('error transitions return from concerned to idle instead of restoring tool-use/responding', () => {
  const scheduler = createManualScheduler();
  const { personality } = createHarness({ scheduler });

  personality.onStreamEvent('tool-use');
  assert.equal(personality.getState(), 'tool-use');

  personality.onStreamEvent('error');
  assert.equal(personality.getState(), 'concerned');

  scheduler.advanceBy(2600);
  assert.equal(personality.getState(), 'idle');
});

test('approval-wait phase events move comet into alert until the next terminal event', () => {
  const { personality } = createHarness();

  personality.onStreamEvent({
    type: 'phase_started',
    phaseKind: 'approval_wait',
  });
  assert.equal(personality.getState(), 'alert');

  personality.onStreamEvent({
    type: 'complete',
    terminalStatus: 'completed',
  });
  assert.equal(personality.getState(), 'happy');
});

test('cancelled and preempted terminals return comet to idle instead of concerned', () => {
  const { personality } = createHarness();

  personality.onStreamEvent('tool-use');
  assert.equal(personality.getState(), 'tool-use');

  personality.onStreamEvent({
    type: 'error',
    terminalStatus: 'cancelled',
  });
  assert.equal(personality.getState(), 'idle');

  personality.onStreamEvent('thinking');
  personality.onStreamEvent({
    type: 'complete',
    terminalStatus: 'preempted',
  });
  assert.equal(personality.getState(), 'idle');
});

test('new-message triggers alert briefly and then returns to idle', () => {
  const scheduler = createManualScheduler();
  const { personality } = createHarness({ scheduler });

  assert.equal(personality.getState(), 'idle');
  personality.onUserAction('new-message');
  assert.equal(personality.getState(), 'alert');

  scheduler.advanceBy(1600);
  assert.equal(personality.getState(), 'idle');
});

test('transient comet personality states can advance through injected scheduler', () => {
  const scheduler = createManualScheduler();
  const { personality } = createHarness({ scheduler });

  personality.onStreamEvent('thinking');
  assert.equal(personality.getState(), 'thinking');

  personality.onStreamEvent('done');
  assert.equal(personality.getState(), 'happy');

  scheduler.advanceBy(2600);
  assert.equal(personality.getState(), 'idle');
});

test('comet personality animation loop waits for visibility before scheduling frames', () => {
  const scheduler = createManualScheduler();
  let visible = false;
  let notifyVisibility = () => {};
  const { personality } = createHarness({
    scheduler,
    visibilityProvider: {
      shouldRun() {
        return visible;
      },
      subscribe(callback) {
        notifyVisibility = callback;
        return () => {};
      },
    },
  });

  personality.bind();
  assert.equal(scheduler.frameCount(), 0);

  visible = true;
  notifyVisibility();
  assert.equal(scheduler.frameCount(), 1);

  personality.dispose();
});

test('manual clock personality steps the comet from the behavior loop', () => {
  const scheduler = createManualScheduler();
  const { personality, calls } = createHarness({ scheduler, manualClock: true });

  personality.bind();
  assert.equal(scheduler.frameCount(), 1);

  scheduler.drainFrame();
  assert.deepEqual(calls.cometStep, [0]);

  personality.dispose();
});

test('sentiment does not interrupt listening state', () => {
  const { personality } = createHarness();

  personality.setState('listening');
  personality.onSentiment('warm');

  assert.equal(personality.getState(), 'listening');
  personality.dispose();
});

test('unbind disconnects motion observer before rebind', (t) => {
  const originalMutationObserver = globalThis.MutationObserver;
  const originalDocument = globalThis.document;
  const disconnectCalls = [];

  class FakeMutationObserver {
    constructor() {}
    observe() {}
    disconnect() {
      disconnectCalls.push('disconnect');
    }
  }

  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.document = {
    documentElement: { dataset: { motion: 'standard' } },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
  };
  t.after(() => {
    globalThis.MutationObserver = originalMutationObserver;
    globalThis.document = originalDocument;
    loadCometPersonalityFresh();
  });

  const { createCometPersonality: createFreshPersonality } = loadCometPersonalityFresh();
  const scheduler = createManualScheduler();
  const behaviorEngine = {
    has() { return true; },
    activate() {},
    setPosition() {},
    update() { return { x: 10, y: 20 }; },
    setBaseTransitionDuration() {},
  };
  const personality = createFreshPersonality({
    behaviorEngine,
    scheduler,
    comet: {
      setColorPalette() {},
      setTailLength() {},
      setSpeed() {},
      setPosition() {},
      getHeadPosition() { return { x: 10, y: 20 }; },
      clearTail() {},
      setVisualScale() {},
    },
    container: {
      getBoundingClientRect() { return { width: 800, height: 600, top: 0, left: 0 }; },
      addEventListener() {},
      removeEventListener() {},
    },
    dom: {},
  });

  personality.bind();
  personality.unbind();
  personality.bind();
  personality.dispose();

  assert.equal(disconnectCalls.length, 2);
});

test('first idle bind activates ambient drift with explicit non-origin home position', (t) => {
  const { personality, calls } = createHarness();
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    personality.dispose();
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  });

  personality.bind();

  assert.deepEqual(calls.setPosition[0], [240, 240]);
  assertAmbientIdleActivation(calls.activate[0]);
});

test('thinking done idle path seeds non-orbit behaviors from comet head position', () => {
  const scheduler = createManualScheduler();
  const { personality, calls, setHeadPosition } = createHarness({ scheduler });

  personality.onStreamEvent('thinking');
  assert.equal(personality.getState(), 'thinking');
  // anchored-orbit seeds the behavior engine on activation (ambient home fallback for origin-like position)
  assert.deepEqual(calls.setPosition[0], [240, 240]);

  setHeadPosition(321, 222);
  personality.onStreamEvent('done');
  assert.equal(personality.getState(), 'happy');
  assert.deepEqual(calls.setPosition[1], [321, 222]);

  setHeadPosition(410, 305);
  scheduler.advanceBy(2600);
  assert.equal(personality.getState(), 'idle');
  assert.deepEqual(calls.setPosition[2], [410, 305]);
  assertAmbientIdleActivation(calls.activate[calls.activate.length - 1]);
});

test('anchored-orbit advances farther with larger dt values', () => {
  const orbit = createAnchoredOrbit({
    anchorX: 100,
    anchorY: 100,
    radiusX: 40,
    radiusY: 25,
    speed: 1,
  });

  orbit.enter({ x: 140, y: 100 });
  const smallStep = orbit.update(16);

  orbit.enter({ x: 140, y: 100 });
  const largeStep = orbit.update(160);

  const smallDistance = Math.abs(smallStep.y - 100);
  const largeDistance = Math.abs(largeStep.y - 100);

  assert.ok(largeDistance > smallDistance);
});

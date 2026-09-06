const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createComet, PALETTES } = require('../renderer/features/renderer-comet');
const { createIdleDrift } = require('../comet/behaviors/idle-drift');

function makeContainer() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="container" style="width:200px;height:200px;"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const container = dom.window.document.getElementById('container');
  container.getBoundingClientRect = () => ({ top: 0, left: 0, width: 200, height: 200, right: 200, bottom: 200 });
  return { dom, container, window: dom.window };
}

function makeTarget() {
  const el = { getBoundingClientRect: () => ({ top: 50, left: 50, width: 40, height: 40, right: 90, bottom: 90 }) };
  return el;
}

test('createComet returns object with correct API surface', () => {
  const { container } = makeContainer();
  const comet = createComet(container, { reducedMotionQuery: { matches: true } });
  assert.equal(typeof comet.start, 'function');
  assert.equal(typeof comet.stop, 'function');
  assert.equal(typeof comet.setTarget, 'function');
  assert.equal(typeof comet.setColorPalette, 'function');
  assert.equal(typeof comet.dispose, 'function');
  comet.dispose();
});

test('start() creates and appends SVG to container', () => {
  const { container } = makeContainer();
  const comet = createComet(container, { reducedMotionQuery: { matches: true } });
  assert.equal(container.querySelector('svg'), null);
  comet.start();
  const svg = container.querySelector('svg');
  assert.ok(svg);
  assert.equal(svg.classList.contains('chat-comet-svg'), true);
  comet.dispose();
});

test('SVG contains expected child elements', () => {
  const { container } = makeContainer();
  const comet = createComet(container, { reducedMotionQuery: { matches: true } });
  comet.start();
  const svg = container.querySelector('svg');
  assert.ok(svg.querySelector('.comet-tail-glow'));
  assert.ok(svg.querySelector('.comet-tail'));
  assert.ok(svg.querySelector('.comet-outer-glow'));
  assert.ok(svg.querySelector('.comet-head'));
  assert.ok(svg.querySelector('.comet-core'));
  assert.ok(svg.querySelector('defs linearGradient'));
  comet.dispose();
});

test('setTarget() updates without error', () => {
  const { container } = makeContainer();
  const target = makeTarget();
  const comet = createComet(container, { reducedMotionQuery: { matches: true } });
  comet.start();
  comet.setTarget(target);
  const outerGlow = container.querySelector('.comet-outer-glow');
  assert.ok(outerGlow.getAttribute('cx'));
  assert.ok(outerGlow.getAttribute('cy'));
  comet.dispose();
});

test('setColorPalette() switches palette without error', () => {
  const { container } = makeContainer();
  const comet = createComet(container, { reducedMotionQuery: { matches: true } });
  comet.start();
  comet.setColorPalette('responding');
  comet.setColorPalette('tool-use');
  comet.setColorPalette('stalled');
  comet.setColorPalette('thinking');
  comet.dispose();
});

test('stop() does not remove SVG (kept for fade-out)', () => {
  const { container } = makeContainer();
  const comet = createComet(container, { reducedMotionQuery: { matches: true } });
  comet.start();
  comet.stop();
  assert.ok(container.querySelector('svg'));
  comet.dispose();
});

test('dispose() removes SVG from container', () => {
  const { container } = makeContainer();
  const comet = createComet(container, { reducedMotionQuery: { matches: true } });
  comet.start();
  assert.ok(container.querySelector('svg'));
  comet.dispose();
  assert.equal(container.querySelector('svg'), null);
});

test('reduced motion: start() does not schedule rAF loop, renders static glow', () => {
  const { container } = makeContainer();
  const target = makeTarget();
  const comet = createComet(container, { reducedMotionQuery: { matches: true } });
  comet.setTarget(target);
  comet.start();
  const outerGlow = container.querySelector('.comet-outer-glow');
  assert.ok(outerGlow.getAttribute('fill'));
  const tail = container.querySelector('.comet-tail');
  assert.equal(tail.getAttribute('d'), '');
  comet.dispose();
});

test('live reduced-motion changes pause and resume animation until dispose', () => {
  const { container } = makeContainer();
  const callbacks = new Set();
  const scheduled = new Map();
  let nextFrameId = 0;
  const query = {
    matches: false,
    addEventListener(name, callback) {
      if (name === 'change') callbacks.add(callback);
    },
    removeEventListener(name, callback) {
      if (name === 'change') callbacks.delete(callback);
    },
  };
  const comet = createComet(container, {
    reducedMotionQuery: query,
    animationScheduler: {
      requestAnimationFrame(callback) {
        nextFrameId += 1;
        scheduled.set(nextFrameId, callback);
        return nextFrameId;
      },
      cancelAnimationFrame(id) {
        scheduled.delete(id);
      },
    },
  });

  comet.setTarget(makeTarget());
  comet.start();
  assert.equal(callbacks.size, 1);
  assert.equal(scheduled.size, 1);

  query.matches = true;
  for (const callback of callbacks) callback({ matches: true });
  assert.equal(scheduled.size, 0);
  assert.equal(container.querySelector('.comet-tail').getAttribute('d'), '');

  query.matches = false;
  for (const callback of callbacks) callback({ matches: false });
  assert.equal(scheduled.size, 1);

  comet.dispose();
  assert.equal(callbacks.size, 0);
});

test('setTarget interpolates a same-center target resize to the new orbit radius', () => {
  const { container } = makeContainer();
  let rect = { top: 50, left: 50, width: 40, height: 40, right: 90, bottom: 90 };
  const target = { getBoundingClientRect: () => rect };
  const comet = createComet(container, {
    manualClock: true,
    orbitSpeed: Number.MAX_SAFE_INTEGER,
    reducedMotionQuery: { matches: false },
  });

  comet.setTarget(target);
  comet.start();
  comet.step(1);
  for (let index = 1; index <= 15; index += 1) comet.step(1 + (index * 100));
  assert.ok(Number(container.querySelector('.comet-head').getAttribute('cx')) > 97.9);

  rect = { top: 30, left: 30, width: 80, height: 80, right: 110, bottom: 110 };
  comet.setTarget(target);
  for (let index = 16; index <= 30; index += 1) comet.step(1 + (index * 100));
  assert.ok(Number(container.querySelector('.comet-head').getAttribute('cx')) > 117.9);
  comet.dispose();
});

test('start() waits to schedule animation while comet visibility is blocked', () => {
  const { container } = makeContainer();
  const scheduled = [];
  const comet = createComet(container, {
    reducedMotionQuery: { matches: false },
    animationScheduler: {
      requestAnimationFrame(callback) {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelAnimationFrame() {},
    },
    visibilityProvider: {
      shouldRun() {
        return false;
      },
      subscribe() {
        return () => {};
      },
    },
  });

  comet.start();

  assert.equal(scheduled.length, 0);
  assert.ok(container.querySelector('svg'));
  comet.dispose();
});

test('visibility resume schedules the comet animation loop after a hidden start', () => {
  const { container } = makeContainer();
  const scheduled = [];
  let visible = false;
  let notifyVisibility = () => {};
  const comet = createComet(container, {
    reducedMotionQuery: { matches: false },
    animationScheduler: {
      requestAnimationFrame(callback) {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelAnimationFrame() {},
    },
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

  comet.start();
  assert.equal(scheduled.length, 0);

  visible = true;
  notifyVisibility();

  assert.equal(scheduled.length, 1);
  comet.dispose();
});

test('manual clock mode renders only when stepped', () => {
  const { container } = makeContainer();
  const scheduled = [];
  const comet = createComet(container, {
    manualClock: true,
    reducedMotionQuery: { matches: false },
    animationScheduler: {
      requestAnimationFrame(callback) {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelAnimationFrame() {},
    },
  });

  comet.setPosition(30, 40);
  comet.start();
  assert.equal(scheduled.length, 0);

  comet.step(16);
  const head = container.querySelector('.comet-head');
  assert.equal(head.getAttribute('cx'), '30');
  assert.equal(head.getAttribute('cy'), '40');
  assert.equal(scheduled.length, 0);
  comet.dispose();
});

test('manual clock render cache skips identical static frame attribute writes', () => {
  const { container } = makeContainer();
  const comet = createComet(container, {
    manualClock: true,
    reducedMotionQuery: { matches: false },
  });
  comet.setPosition(45, 55);
  comet.start();
  comet.step(16);

  const head = container.querySelector('.comet-head');
  let headWrites = 0;
  const nativeSetAttribute = head.setAttribute.bind(head);
  head.setAttribute = (name, value) => {
    headWrites += 1;
    nativeSetAttribute(name, value);
  };

  comet.step(16);
  assert.equal(headWrites, 0);
  comet.dispose();
});

test('reduced motion static render cache skips identical attribute writes', () => {
  const { container } = makeContainer();
  const comet = createComet(container, { reducedMotionQuery: { matches: true } });
  comet.setPosition(45, 55);
  comet.start();

  const head = container.querySelector('.comet-head');
  let headWrites = 0;
  const nativeSetAttribute = head.setAttribute.bind(head);
  head.setAttribute = (name, value) => {
    headWrites += 1;
    nativeSetAttribute(name, value);
  };

  comet.setPosition(45, 55);
  assert.equal(headWrites, 0);
  comet.dispose();
});

test('PALETTES exports expected keys', () => {
  assert.ok(PALETTES.thinking);
  assert.ok(PALETTES.responding);
  assert.ok(PALETTES['tool-use']);
  assert.ok(PALETTES.stalled);
  assert.equal(PALETTES.thinking.length, 3);
});

test('idle drift with explicit ambient geometry roams across both axes', () => {
  const originalRandom = Math.random;
  const randomValues = [0.13, 0.57, 0.29, 0.81];
  let randomIndex = 0;
  Math.random = () => {
    const value = randomValues[randomIndex % randomValues.length];
    randomIndex += 1;
    return value;
  };

  try {
    const behavior = createIdleDrift({
      centerX: 240,
      centerY: 240,
      rangeX: 144,
      rangeY: 84,
    });
    behavior.enter({ x: 240, y: 240 });

    const positions = [];
    for (let index = 0; index < 1200; index += 1) {
      positions.push(behavior.update(16, { bounds: { width: 800, height: 600 } }));
    }

    const xs = positions.map((point) => point.x);
    const ys = positions.map((point) => point.y);
    const driftX = Math.max(...xs) - Math.min(...xs);
    const driftY = Math.max(...ys) - Math.min(...ys);

    assert.ok(driftX > 20, `expected noticeable x drift, received ${driftX}`);
    assert.ok(driftY > 20, `expected noticeable y drift, received ${driftY}`);
  } finally {
    Math.random = originalRandom;
  }
});

// Context Weave lifecycle suite: frame budget, size settling, reduced motion, DPR
// re-backing, disposal and the token surface. Split from
// renderer-context-weave-utils.test.js to stay under the file-size ceiling; the
// lattice geometry, rest detection, sheen and pluck cases stay there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');
const appearanceUtils = require('../renderer/shared/appearance-utils.js');
const { createRafHarness } = require('./helpers/surface-effect-router-harness.js');
const { buildFixtureContext, withStubbedGlobals } = require('./helpers/surface-effect-conformance.js');
const {
  STYLE_TOKENS,
  HOST_RECT,
  newRecord,
  makeFakeWindow,
  mountController,
  tick,
  settle,
  alphaSet,
  input,
} = require('./helpers/context-weave-fixtures.js');

const TOKENS = Object.keys(STYLE_TOKENS);
// Set by the foundation floor and the calm/expressive motion rules, not tuned
// per palette: it scales pointer gain and pluck amplitude only.
const MOTION_SCALE_TOKEN = '--widget-context-weave-motion-scale';
const RETIRED_TOKENS = [
  '--widget-context-weave-pulse-color',
  '--widget-context-weave-glow-color',
  '--widget-context-weave-bloom',
  '--widget-context-weave-tension',
  '--widget-context-weave-damping',
];

// ── 14: frame budget ────────────────────────────────────────────────────────

test('a focused window paints every tick while moving; an unfocused one caps at ~30 fps', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller, windowRef } = mountController({ raf, record });
    assert.equal(windowRef.listenerCount('focus'), 1, 'window focus is bound through the runtime');
    assert.equal(windowRef.listenerCount('blur'), 1);
    raf.flush(32); raf.flush(48);

    controller.handleInput(input('click', 90, 80, { timeStamp: raf.now }));
    let before = record.frames;
    tick(raf, 10);
    assert.equal(record.frames - before, 10, 'a focused window paints every tick');

    windowRef.fire('blur');
    controller.handleInput(input('click', 90, 80, { timeStamp: raf.now }));
    before = record.frames;
    tick(raf, 20);
    const capped = record.frames - before;
    assert.ok(capped >= 9 && capped <= 11, `an unfocused window caps animated frames (got ${capped})`);

    windowRef.fire('focus');
    controller.handleInput(input('click', 90, 80, { timeStamp: raf.now }));
    before = record.frames;
    tick(raf, 10);
    assert.equal(record.frames - before, 10, 'refocus restores full rate');

    controller.dispose();
    assert.equal(windowRef.listenerCount('focus'), 0, 'dispose removes the focus listener');
    assert.equal(windowRef.listenerCount('blur'), 0, 'dispose removes the blur listener');
  });
});

// ── 15: resize settle ───────────────────────────────────────────────────────

test('a size-only scene change settles over 150 ms before the lattice rebuilds', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller, host } = mountController({ raf, record: newRecord() });
    raf.flush(32); raf.flush(48);
    const original = controller._internals.getLattice();
    const resizeTo = (width) => {
      const rect = { left: 0, top: 0, width, height: 560 };
      controller.refresh(buildFixtureContext({
        hosts: [{ element: host, role: 'chat-left' }], sceneRect: rect, hostRects: [rect],
      }));
    };

    resizeTo(1000);
    assert.equal(controller._internals.getLattice(), original, 'the old cloth is kept at first');
    assert.equal(controller._internals.inspect().resizePending, true);
    assert.equal(controller._internals.inspect().pendingFrameCount, 1, 'the settle runs on frames');
    tick(raf, 5);
    assert.equal(controller._internals.getLattice(), original, 'still the old cloth 80 ms in');

    // A further size change restarts the clock.
    resizeTo(1100);
    tick(raf, 8);
    assert.equal(controller._internals.getLattice(), original, 'the debounce restarts on every size change');

    // Same-size refreshes (occlusion/avoidance churn) must not postpone it.
    resizeTo(1100);
    tick(raf, 5);
    resizeTo(1100);
    const rebuilt = controller._internals.getLattice();
    assert.notEqual(rebuilt, original, 'the lattice rebuilds once the size has held for 150 ms');
    assert.equal(rebuilt.width, 1100, 'and it uses the final size, not an intermediate one');
    settle(raf, controller);
    assert.equal(controller._internals.inspect().resizePending, false);
    assert.equal(controller._internals.inspect().pendingFrameCount, 0, 'then the cloth rests again');

    // A structural change (spacing) is not a resize and rebuilds immediately.
    const beforeSpacing = controller._internals.getLattice();
    host.style.setProperty('--widget-context-weave-spacing', '64');
    controller.refresh(buildFixtureContext({
      hosts: [{ element: host, role: 'chat-left' }],
      sceneRect: { left: 0, top: 0, width: 1100, height: 560 },
      hostRects: [{ left: 0, top: 0, width: 1100, height: 560 }],
    }));
    assert.notEqual(controller._internals.getLattice(), beforeSpacing);
    assert.equal(controller._internals.inspect().resizePending, false);
    controller.dispose();
  });
});

test('reduced motion rebuilds the lattice at once on a size change (no settle frames exist)', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller, host } = mountController({ raf, record: newRecord(), reducedMotion: true });
    const rect = { left: 0, top: 0, width: 1000, height: 560 };
    controller.refresh(buildFixtureContext({
      hosts: [{ element: host, role: 'chat-left' }], sceneRect: rect, hostRects: [rect],
    }));
    assert.equal(controller._internals.getLattice().width, 1000);
    assert.equal(controller._internals.inspect().resizePending, false);
    assert.equal(controller._internals.inspect().pendingFrameCount, 0);
    controller.dispose();
  });
});

// ── 16: reduced motion ──────────────────────────────────────────────────────

test('reduced motion draws the resting lattice once and requests no frames', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller } = mountController({ raf, record, reducedMotion: true });
    assert.equal(controller._internals.inspect().reducedMotion, true);
    assert.equal(controller._internals.inspect().pendingFrameCount, 0);
    assert.ok(record.strokes.length > 0, 'the resting cloth is painted once');

    const before = record.strokes.length;
    controller.handleInput(input('move', 300, 300));
    controller.handleInput(input('click', 80, 80, { timeStamp: 48 }));
    assert.equal(controller._internals.inspect().pluckActive, false, 'reduced motion never plucks');
    assert.equal(controller._internals.inspect().pendingFrameCount, 0, 'and never requests an animation frame');
    assert.ok(record.strokes.length > before, 'it still repaints synchronously on input');
    controller.dispose();
  });
});

test('reduced motion hover is binary: fully on while hovered, off at once on leave or cancel, no pluck', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller } = mountController({ raf, record, reducedMotion: true });
    const resting = Array.from(alphaSet(record)).sort();

    record.strokes.length = 0;
    controller.handleInput(input('move', 200, 200));
    let state = controller._internals.inspect();
    assert.equal(state.pointerFade, 1, 'hover is fully on, with no fade in between');
    assert.ok(alphaSet(record).size > resting.length, 'the hover lights threads');
    const hovered = Array.from(alphaSet(record)).sort();

    record.strokes.length = 0;
    controller.handleInput(input('move', 204, 203));
    assert.deepEqual(Array.from(alphaSet(record)).sort(), hovered, 'nothing accumulates per input event');

    record.strokes.length = 0;
    controller.handleInput(input('click', 60, 60, { timeStamp: 40 }));
    assert.equal(controller._internals.inspect().pluckActive, false, 'no pluck');

    record.strokes.length = 0;
    controller.handleInput(input('leave', 204, 203));
    state = controller._internals.inspect();
    assert.equal(state.pointerFade, 0, 'leave clears the hover at once');
    assert.deepEqual(Array.from(alphaSet(record)).sort(), resting, 'and the next paint is the resting cloth');

    controller.handleInput(input('move', 200, 200));
    record.strokes.length = 0;
    controller.handleInput(input('cancel', 0, 0));
    assert.equal(controller._internals.inspect().pointerFade, 0, 'cancel clears it too');
    assert.deepEqual(Array.from(alphaSet(record)).sort(), resting);
    assert.equal(controller._internals.inspect().pendingFrameCount, 0);
    controller.dispose();
  });
});

// ── 17: device pixel ratio ──────────────────────────────────────────────────

test('a DPR-only change re-backs the canvas on the next painted frame', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const windowRef = makeFakeWindow(1);
    const { controller, host } = mountController({ raf, record: newRecord(), windowRef });
    const canvas = host.children[0];
    assert.equal(canvas.width, HOST_RECT.width);

    windowRef.devicePixelRatio = 1.5;
    assert.equal(canvas.width, HOST_RECT.width, 'nothing re-backs synchronously');
    controller.handleInput(input('move', 100, 100));
    raf.flush(16);
    assert.equal(canvas.width, HOST_RECT.width * 1.5, 'the backing follows the new device pixel ratio');
    assert.equal(canvas.height, HOST_RECT.height * 1.5);
    assert.equal(controller._internals.inspect().entries[0].dpr, 1.5);
    controller.dispose();
  });
});

test('reduced-motion static paints also re-back the canvas after a DPR-only change', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const windowRef = makeFakeWindow(1);
    const { controller, host } = mountController({ raf, record: newRecord(), reducedMotion: true, windowRef });
    const canvas = host.children[0];
    assert.equal(canvas.width, HOST_RECT.width);
    windowRef.devicePixelRatio = 1.5;
    controller.handleInput(input('move', 120, 120));
    assert.equal(canvas.width, HOST_RECT.width * 1.5, 'the static repaint follows the new device pixel ratio');
    controller.dispose();
  });
});

// ── 13: disposal ────────────────────────────────────────────────────────────

test('dispose removes canvases, cancels frames, unregisters listeners, and is safe twice', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller, host, documentRef, reducedMotionQuery } = mountController({ raf, record });
    controller.handleInput(input('move', 200, 200));
    assert.equal(controller._internals.inspect().pendingFrameCount, 1);

    controller.dispose();
    controller.dispose();
    assert.equal(host.children.length, 0);
    assert.equal(raf.size, 0);
    assert.equal(documentRef.listenerCount('visibilitychange'), 0);
    assert.equal(reducedMotionQuery.listenerCount(), 0);
    assert.equal(controller.getStatus().state, 'dormant');
  });
});

// ── token surface ───────────────────────────────────────────────────────────

test('the weave token surface has a schema, a foundation floor, and one override per palette', () => {
  const root = path.resolve(__dirname, '..');
  const foundation = fs.readFileSync(path.join(root, 'styles', 'foundation.css'), 'utf8');
  const palettes = fs.readdirSync(path.join(root, 'styles'))
    .filter((name) => /^palette-.*\.css$/.test(name));
  const paletteCss = palettes.map((name) => [
    name,
    fs.readFileSync(path.join(root, 'styles', name), 'utf8'),
  ]);
  // Derived from the appearance registry rather than a hardcoded count: every
  // preset except the `midnight` baseline (which lives in foundation.css) ships
  // a styles/palette-<id>.css override, and there are no orphan palette files.
  const expectedPaletteFiles = appearanceUtils.getPalettePresets()
    .map((preset) => preset.id)
    .filter((id) => id !== 'midnight')
    .map((id) => `palette-${id}.css`)
    .sort();
  assert.deepEqual(palettes.slice().sort(), expectedPaletteFiles);

  const registryTokens = appearanceUtils.getSurfaceEffectPresets()
    .find((preset) => preset.id === 'context-weave').requiredTokens;
  assert.deepEqual(Array.from(registryTokens).sort(), TOKENS.concat(MOTION_SCALE_TOKEN).sort(),
    'the registry, the runtime schema and these tests must agree on the token set');
  assert.ok(runtime.SURFACE_EFFECT_TOKEN_SCHEMAS[MOTION_SCALE_TOKEN], 'the motion-scale token has a schema');
  assert.match(foundation, new RegExp(`${MOTION_SCALE_TOKEN}:\\s*[^;]+;`), 'and a foundation floor');

  for (const token of TOKENS) {
    assert.ok(runtime.SURFACE_EFFECT_TOKEN_SCHEMAS[token], `${token} has a schema`);
    assert.match(foundation, new RegExp(`${token}:\\s*[^;]+;`), `${token} has a foundation floor`);
    for (const [palette, css] of paletteCss) {
      assert.match(css, new RegExp(`${token}:\\s*[^;]+;`), `${palette} overrides ${token}`);
    }
  }

  // The spring constants, the glow knob and the second/third hue retired with
  // the restyle; they must not survive anywhere as dead tuning.
  for (const token of RETIRED_TOKENS) {
    assert.equal(runtime.SURFACE_EFFECT_TOKEN_SCHEMAS[token], undefined, `${token} has no schema`);
    assert.doesNotMatch(foundation, new RegExp(token), `${token} is gone from foundation.css`);
    for (const [palette, css] of paletteCss) {
      assert.doesNotMatch(css, new RegExp(token), `${token} is gone from ${palette}`);
    }
  }
});
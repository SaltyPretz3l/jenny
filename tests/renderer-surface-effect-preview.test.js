// Settings > Appearance > Background live preview strip (Surface Effects
// review, 2026-08-21, Wave 3).
//
// The point of the module is LIFECYCLE: exactly one controller alive at a
// time, and never one alive behind a closed Settings panel. Every assertion
// below is about that, plus the input-block attribute that keeps the app-wide
// router from also forwarding the preview's pointer events to the live effect.

const test = require('node:test');
const assert = require('node:assert/strict');

const preview = require('../renderer/shell/renderer-surface-effect-preview.js');
const lazyRenderers = require('../renderer/shell/renderer-settings-lazy-renderers.js');
const { getSurfaceEffectPresets } = require('../renderer/shared/appearance-utils.js');

const HOST_RECT = { left: 0, top: 0, width: 480, height: 84 };

function makeHost(rect = HOST_RECT) {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  return {
    tagName: 'DIV',
    textContent: '',
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    hasAttribute(name) { return attributes.has(name); },
    getBoundingClientRect() { return { ...rect }; },
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) { if (listeners.has(name)) listeners.get(name).delete(fn); },
    listenerCount(name) { return listeners.has(name) ? listeners.get(name).size : 0; },
    totalListenerCount() {
      let total = 0;
      listeners.forEach((set) => { total += set.size; });
      return total;
    },
    fire(name, payload) { (listeners.get(name) || new Set()).forEach((fn) => fn(payload)); },
  };
}

// A recording controller stand-in per effect id, so the tests observe the
// bind/refresh/dispose sequence instead of trusting it.
function makeWindowRef() {
  const log = [];
  function makeFactory(effectId) {
    return function factory(options) {
      const controller = {
        effectId,
        disposed: false,
        binds: 0,
        refreshes: 0,
        inputs: [],
        options,
        bind() { controller.binds += 1; log.push(`bind:${effectId}`); },
        refresh() { controller.refreshes += 1; log.push(`refresh:${effectId}`); },
        handleInput(payload) { controller.inputs.push(payload); },
        dispose() { controller.disposed = true; log.push(`dispose:${effectId}`); },
      };
      log.push(`create:${effectId}`);
      windowRef.__controllers.push(controller);
      return controller;
    };
  }
  const windowRef = {
    __controllers: [],
    __log: log,
    rendererReactiveGridUtils: { createReactiveGridController: makeFactory('reactive-grid') },
    rendererPlaylistScrollUtils: { createPlaylistScrollController: makeFactory('playlist-scroll') },
    rendererAtomicBurstUtils: { createAtomicBurstController: makeFactory('atomic-burst') },
    rendererCircuitTraceUtils: { createCircuitTraceController: makeFactory('circuit-trace') },
    rendererContextWeaveUtils: { createContextWeaveController: makeFactory('context-weave') },
    document: { createElement() { return { style: {}, classList: { add() {}, remove() {} } }; } },
  };
  return windowRef;
}

test('the preview covers exactly the shipped non-none effects', () => {
  const windowRef = makeWindowRef();
  const registryIds = getSurfaceEffectPresets()
    .map((entry) => entry.id)
    .filter((id) => id !== 'none')
    .sort();
  const resolvable = registryIds.filter((id) => typeof preview.resolveFactory(windowRef, id) === 'function');
  // A bijection, not a subset: an effect the preview cannot instantiate would
  // silently show the empty label, which is exactly how the dev gallery lost
  // context-weave (F7).
  assert.deepEqual(resolvable, registryIds);
  assert.equal(preview.resolveFactory(windowRef, 'none'), null);
  assert.equal(preview.resolveFactory(windowRef, 'doodle-field'), null);
});

test('mounting an effect binds one controller and marks the host input-blocked', () => {
  const windowRef = makeWindowRef();
  const strip = preview.createSurfaceEffectPreview({ windowRef, documentRef: windowRef.document });
  const host = makeHost();

  strip.render({ host, effectId: 'context-weave', visible: true });

  assert.equal(windowRef.__controllers.length, 1);
  assert.equal(windowRef.__controllers[0].effectId, 'context-weave');
  assert.equal(windowRef.__controllers[0].binds, 1);
  // Without this the app-wide surface-input router would forward the preview's
  // pointer events to the LIVE effect behind Home/Chat -- the same reason the
  // dev gallery stage carries it.
  assert.equal(host.hasAttribute('data-surface-input-block'), true);
  assert.equal(host.getAttribute('aria-hidden'), 'true');
  assert.equal(host.getAttribute('data-widget-modifier'), 'context-weave');
  assert.ok(host.totalListenerCount() > 0, 'the preview drives its own host, not the router');
  strip.dispose();
});

test('switching effects disposes the previous controller before creating the next', () => {
  const windowRef = makeWindowRef();
  const strip = preview.createSurfaceEffectPreview({ windowRef, documentRef: windowRef.document });
  const host = makeHost();

  strip.render({ host, effectId: 'context-weave', visible: true });
  strip.render({ host, effectId: 'circuit-trace', visible: true });
  strip.render({ host, effectId: 'atomic-burst', visible: true });

  assert.deepEqual(windowRef.__log, [
    'create:context-weave', 'bind:context-weave',
    'dispose:context-weave', 'create:circuit-trace', 'bind:circuit-trace',
    'dispose:circuit-trace', 'create:atomic-burst', 'bind:atomic-burst',
  ]);
  const live = windowRef.__controllers.filter((entry) => !entry.disposed);
  assert.equal(live.length, 1, 'never two live at once');
  assert.equal(live[0].effectId, 'atomic-burst');
  strip.dispose();
});

test('re-rendering the same effect refreshes rather than re-instantiating', () => {
  const windowRef = makeWindowRef();
  const strip = preview.createSurfaceEffectPreview({ windowRef, documentRef: windowRef.document });
  const host = makeHost();

  strip.render({ host, effectId: 'reactive-grid', visible: true });
  strip.render({ host, effectId: 'reactive-grid', visible: true });
  strip.render({ host, effectId: 'reactive-grid', visible: true });

  assert.equal(windowRef.__controllers.length, 1);
  assert.equal(windowRef.__controllers[0].binds, 1);
  assert.equal(windowRef.__controllers[0].refreshes, 2);
  strip.dispose();
});

test('selecting none mounts no controller and shows the empty label', () => {
  const windowRef = makeWindowRef();
  const strip = preview.createSurfaceEffectPreview({ windowRef, documentRef: windowRef.document });
  const host = makeHost();

  strip.render({ host, effectId: 'none', visible: true });
  assert.equal(windowRef.__controllers.length, 0);
  assert.equal(host.textContent, preview.EMPTY_LABEL);
  assert.equal(host.classList.contains(preview.EMPTY_CLASS), true);

  strip.render({ host, effectId: 'context-weave', visible: true });
  assert.equal(host.classList.contains(preview.EMPTY_CLASS), false);
  assert.equal(host.textContent, '');

  strip.render({ host, effectId: 'none', visible: true });
  assert.equal(windowRef.__controllers[0].disposed, true, 'switching back to none tears the controller down');
  assert.equal(host.textContent, preview.EMPTY_LABEL);
  strip.dispose();
});

test('an unreachable effect module falls back to the empty label instead of a blank band', () => {
  const windowRef = makeWindowRef();
  delete windowRef.rendererCircuitTraceUtils;
  const strip = preview.createSurfaceEffectPreview({ windowRef, documentRef: windowRef.document });
  const host = makeHost();

  strip.render({ host, effectId: 'circuit-trace', visible: true });
  assert.equal(windowRef.__controllers.length, 0);
  assert.equal(host.textContent, preview.EMPTY_LABEL);
  strip.dispose();
});

test('factory, bind, and refresh failures degrade to the empty preview with cleanup and a bounded warning', () => {
  ['factory', 'bind', 'refresh'].forEach((failurePhase) => {
    const warnings = [];
    const host = makeHost();
    let partialController = null;
    let refreshCalls = 0;
    const windowRef = {
      console: { warn(message) { warnings.push(message); } },
      rendererReactiveGridUtils: {
        createReactiveGridController() {
          if (failurePhase === 'factory') throw new Error('canvas setup failed with private details');
          partialController = {
            bind() {
              if (failurePhase === 'bind') throw new Error('bind failed with private details');
            },
            refresh() {
              refreshCalls += 1;
              if (failurePhase === 'refresh') throw new Error('refresh failed with private details');
            },
            dispose() { partialController.disposed = true; },
          };
          return partialController;
        },
      },
    };
    const strip = preview.createSurfaceEffectPreview({ windowRef, documentRef: {} });

    const firstResult = strip.render({ host, effectId: 'reactive-grid', visible: true });
    const result = failurePhase === 'refresh'
      ? strip.render({ host, effectId: 'reactive-grid', visible: true })
      : firstResult;

    assert.equal(result, null, `${failurePhase} failure returns the empty-preview result`);
    assert.equal(host.textContent, preview.EMPTY_LABEL);
    assert.equal(host.classList.contains(preview.EMPTY_CLASS), true);
    assert.equal(host.totalListenerCount(), 0, `${failurePhase} failure detaches host listeners`);
    assert.equal(strip._internals.inspect().hasController, false);
    if (partialController) assert.equal(partialController.disposed, true, `${failurePhase} partial controller is disposed`);
    if (failurePhase === 'refresh') assert.equal(refreshCalls, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[surface-effect-preview\] (factory|bind|refresh) failed$/);
    assert.doesNotMatch(warnings[0], /private details/);
    strip.dispose();
  });
});

test('the preview never outlives the panel: hiding, unmounting and disposing all tear it down', () => {
  const windowRef = makeWindowRef();
  const strip = preview.createSurfaceEffectPreview({ windowRef, documentRef: windowRef.document });
  const host = makeHost();

  strip.render({ host, effectId: 'context-weave', visible: true });
  assert.equal(strip._internals.inspect().hasController, true);

  // Settings closes (the active view moves away).
  strip.render({ host, effectId: 'context-weave', visible: false });
  assert.equal(windowRef.__controllers[0].disposed, true, 'a hidden panel keeps no controller alive');
  assert.equal(host.totalListenerCount(), 0, 'and no listener on the host');

  // Reopening rebuilds it.
  strip.render({ host, effectId: 'context-weave', visible: true });
  assert.equal(windowRef.__controllers.length, 2);
  assert.equal(strip._internals.inspect().hasController, true);

  // The Appearance section unmounts (no host at all).
  strip.render({ host: null, effectId: 'context-weave', visible: true });
  assert.equal(windowRef.__controllers[1].disposed, true);

  strip.render({ host, effectId: 'context-weave', visible: true });
  strip.dispose();
  strip.dispose();
  assert.equal(windowRef.__controllers.every((entry) => entry.disposed), true, 'dispose is total and idempotent');
  assert.equal(strip._internals.inspect().disposed, true);
  strip.render({ host, effectId: 'context-weave', visible: true });
  assert.equal(windowRef.__controllers.length, 3, 'a disposed strip refuses to mount again');
});

test('host pointer events reach the controller in scene coordinates', () => {
  const windowRef = makeWindowRef();
  const strip = preview.createSurfaceEffectPreview({ windowRef, documentRef: windowRef.document });
  const host = makeHost({ left: 40, top: 12, width: 480, height: 84 });

  strip.render({ host, effectId: 'context-weave', visible: true });
  host.fire('pointermove', { clientX: 100, clientY: 30, pointerId: 1, timeStamp: 8 });
  host.fire('click', { clientX: 100, clientY: 30, pointerId: 1, timeStamp: 12 });

  const inputs = windowRef.__controllers[0].inputs;
  assert.deepEqual(inputs.map((entry) => entry.type), ['move', 'click']);
  assert.equal(inputs[0].surfaceRole, 'chat-left');
  assert.equal(inputs[0].localX, 60);
  assert.equal(inputs[0].localY, 18);
  assert.equal(inputs[0].sceneX, 60);
  assert.equal(inputs[0].sceneY, 18);
  strip.dispose();
});

test('the bind context is a single-host scene with no manager-owned regions', () => {
  const context = preview.buildBindContext(makeHost());
  assert.equal(context.hosts.length, 1);
  assert.equal(context.hosts[0].role, 'chat-left');
  assert.deepEqual(context.layout.sceneRect, context.layout.hostRects[0]);
  assert.deepEqual(context.layout.interactionBlockRects, []);
  assert.deepEqual(context.layout.paintOcclusionRects, []);
  assert.deepEqual(context.layout.spawnAvoidanceRects, []);
  assert.equal(context.staged, false);
});

// ── the copy the strip sits under (F9) ──────────────────────────────────────

test('cost class and recommended palettes render as plain words, not a badge', () => {
  assert.equal(lazyRenderers.buildSurfaceEffectMetaText({ id: 'none' }), '');
  assert.equal(lazyRenderers.buildSurfaceEffectMetaText(null), '');
  assert.equal(
    lazyRenderers.buildSurfaceEffectMetaText({ id: 'a', costClass: 'low', recommendedPalettes: [] }),
    'light on your GPU'
  );
  assert.equal(
    lazyRenderers.buildSurfaceEffectMetaText({ id: 'b', costClass: 'medium', recommendedPalettes: [] }),
    'moderate GPU use'
  );
  assert.equal(
    lazyRenderers.buildSurfaceEffectMetaText({ id: 'c', costClass: 'high', recommendedPalettes: ['obsidian'] }),
    'heavier GPU use · looks best with the obsidian palette'
  );
  // Every shipped effect must produce copy -- an unmapped costClass would
  // silently render an empty line.
  getSurfaceEffectPresets()
    .filter((entry) => entry.id !== 'none')
    .forEach((entry) => {
      assert.ok(lazyRenderers.buildSurfaceEffectMetaText(entry).length > 0, `${entry.id} has a cost line`);
    });
});

test('the field description is bound to the selected preset and never renders empty', () => {
  const descriptionEl = { textContent: '' };
  const metaEl = { textContent: '', hidden: false };

  getSurfaceEffectPresets().forEach((preset) => {
    lazyRenderers.renderSurfaceEffectCopy({ descriptionEl, metaEl, preset });
    assert.equal(descriptionEl.textContent, preset.description);
    assert.ok(descriptionEl.textContent.length > 0);
    assert.equal(metaEl.hidden, preset.id === 'none');
  });

  lazyRenderers.renderSurfaceEffectCopy({ descriptionEl, metaEl, preset: null });
  assert.equal(descriptionEl.textContent, 'An ambient layer behind Home and Chat.');
  assert.equal(metaEl.hidden, true);
});

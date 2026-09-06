// spec-first: pointer-input router suite for
// renderer/app/renderer-app-surface-input.js (Background Effects v3, packet
// S3). Two sections: router `_internals` + listener lifecycle first, then the
// manager-level integration cases (gutter resolution, blocker matrix,
// coalescing, pointer-state clearing, capture, failure containment) driven
// through createSurfaceEffectManager via the shared harness in
// tests/helpers/surface-effect-router-harness.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const surfaceInput = require('../renderer/app/renderer-app-surface-input.js');
const surfaceLayout = require('../renderer/app/renderer-app-surface-layout.js');
const {
  createRafHarness,
  makeFakeController,
  NATIVE_ENTRY,
  NATIVE_CAPTURE_ENTRY,
  NATIVE_ENTRY_2,
  makeFakeEventTarget,
  makeRouterDom,
  makePointerEvent,
  makeRouterManager,
} = require('./helpers/surface-effect-router-harness.js');

// ── Router-internals harness ────────────────────────────────────────────────

function makeFakeElement(rect) {
  const events = makeFakeEventTarget();
  const element = Object.assign({}, events, {
    rect: rect || { left: 0, top: 0, width: 0, height: 0 },
    totalListenerCount() {
      // Reaches into the shared Map via closures captured above: recompute
      // from the per-event-name counts the harness already tracks.
      let total = 0;
      ['pointerenter', 'pointermove', 'pointerleave', 'pointerdown', 'pointerup',
        'pointercancel', 'lostpointercapture', 'click'].forEach((eventName) => {
        total += element.listenerCount(eventName);
      });
      return total;
    },
    getBoundingClientRect() { return element.rect; },
  });
  return element;
}

// Builds a real createSurfaceInputRouter() instance around fake DOM/window/
// document objects. Defaults to a no-op getInputTarget (null) since most
// internals cases here don't need a live target.
function makeRouter(overrides = {}) {
  const raf = overrides.raf || createRafHarness();
  const windowEvents = makeFakeEventTarget();
  const documentRef = overrides.documentRef || Object.assign({ hidden: false }, makeFakeEventTarget());
  const windowRef = Object.assign({
    requestAnimationFrame: raf.requestAnimationFrame,
    cancelAnimationFrame: raf.cancelAnimationFrame,
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
  }, overrides.windowRef || {});
  const dom = overrides.dom || {
    chatView: makeFakeElement({ left: 0, top: 0, width: 800, height: 600 }),
    homeView: makeFakeElement({ left: 0, top: 0, width: 800, height: 600 }),
    chatSurfaceEffectLeft: makeFakeElement({ left: 0, top: 0, width: 400, height: 600 }),
  };
  const cleanups = [];
  const router = surfaceInput.createSurfaceInputRouter(Object.assign({
    windowRef,
    documentRef,
    dom,
    registerCleanup: (fn) => { cleanups.push(fn); },
    getInputTarget: () => null,
    onInputFailure: () => {},
  }, overrides.routerOverrides || {}));
  return {
    router, raf, dom, windowRef, windowEvents, documentRef, cleanups,
  };
}

// ── SURFACE_INPUT_BLOCKER_SELECTOR ──────────────────────────────────────────

test('SURFACE_INPUT_BLOCKER_SELECTOR matches the current interactive-chrome contract', () => {
  const expected = [
    '.composer', '.composer-wrap', '.chat-thread-column', '.chat-empty .hero-stack',
    '.home-card', '.dashboard-card', '.home-panel', '.settings-card', '.settings-nav',
    'button', 'a', 'input', 'select', 'textarea',
    '[role="button"]', '[data-surface-input-block]',
  ];
  const actual = surfaceInput.SURFACE_INPUT_BLOCKER_SELECTOR.split(', ');
  assert.deepEqual(actual, expected);
  assert.equal(surfaceLayout.DEFAULT_INTERACTION_SELECTOR.includes('.chat-thread-column'), false,
    'the hidden or populated thread shell should not become a geometry blocker');
  assert.equal(surfaceLayout.DEFAULT_INTERACTION_SELECTOR.includes('.chat-empty .hero-stack'), false,
    'the empty hero should not become a broad geometry blocker');
  assert.equal(
    surfaceInput.CHAT_AMBIENT_HOVER_SELECTOR,
    '.chat-thread-column, .chat-empty .hero-stack',
  );
});

// ── resolveSurfaceRole ───────────────────────────────────────────────────────

// F1 (2026-08-21): the chat right gutter was `display: none` yet still
// published as a host, so the router had to disambiguate between two rects --
// one of which could never be seen. Chat now publishes exactly one full-bleed
// host, so the role is positional-independent. This test is the guard against
// a second chat host quietly coming back.
test('resolveSurfaceRole maps every chat point to the single full-bleed host', () => {
  const dom = {
    chatView: makeFakeElement({ left: 0, top: 0, width: 1000, height: 600 }),
    homeView: makeFakeElement({ left: 0, top: 0, width: 800, height: 600 }),
    chatSurfaceEffectLeft: makeFakeElement({ left: 0, top: 0, width: 1000, height: 600 }),
  };
  const { router } = makeRouter({ dom });

  [0, 400, 600, 999, 999999, -999].forEach((clientX) => {
    assert.equal(router._internals.resolveSurfaceRole('chat', clientX, 300), 'chat-left');
  });
  // The 'home' surface always resolves to 'home', independent of position.
  assert.equal(router._internals.resolveSurfaceRole('home', 999999, -999), 'home');
});

// ── buildPayload ─────────────────────────────────────────────────────────────

test('buildPayload computes sceneX/sceneY relative to the surface element and carries the full field set', () => {
  const dom = {
    // Deliberately distinct from the gutter rect so sceneX/Y (relative to the
    // surface element) and localX/Y (relative to the resolved gutter host)
    // provably differ.
    chatView: makeFakeElement({ left: 10, top: 10, width: 900, height: 700 }),
    homeView: makeFakeElement({ left: 0, top: 0, width: 800, height: 600 }),
    chatSurfaceEffectLeft: makeFakeElement({ left: 50, top: 20, width: 400, height: 600 }),
  };
  const { router } = makeRouter({ dom });
  const descriptor = { surface: 'chat', element: dom.chatView };
  const event = {
    pointerId: 3,
    pointerType: 'touch',
    isPrimary: false,
    buttons: 1,
    pressure: 0.5,
    timeStamp: 1234,
    clientX: 120,
    clientY: 90,
  };

  const payload = router._internals.buildPayload('move', event, descriptor, 7);

  assert.deepEqual(Object.keys(payload).sort(), [
    'buttons', 'clientX', 'clientY', 'generation', 'isPrimary', 'localX', 'localY',
    'pointerId', 'pointerType', 'pressure', 'sceneX', 'sceneY', 'surfaceRole', 'timeStamp', 'type',
  ]);
  assert.equal(payload.type, 'move');
  assert.equal(payload.pointerId, 3);
  assert.equal(payload.pointerType, 'touch');
  assert.equal(payload.isPrimary, false);
  assert.equal(payload.buttons, 1);
  assert.equal(payload.pressure, 0.5);
  assert.equal(payload.timeStamp, 1234);
  assert.equal(payload.clientX, 120);
  assert.equal(payload.clientY, 90);
  assert.equal(payload.surfaceRole, 'chat-left', 'clientX=120 falls inside the left gutter rect [50, 450)');
  assert.equal(payload.localX, 70, 'relative to the resolved gutter host rect (120 - 50)');
  assert.equal(payload.localY, 70, '(90 - 20)');
  assert.equal(payload.sceneX, 110, 'relative to the surface element (chatView) rect (120 - 10)');
  assert.equal(payload.sceneY, 80, '(90 - 10)');
  assert.equal(payload.generation, 7);
});

test('router uses the manager snapshot for role and coordinates without live geometry reads', () => {
  const delivered = [];
  const dom = {
    chatView: makeFakeElement({ left: 0, top: 0, width: 1000, height: 700 }),
    homeView: makeFakeElement({ left: 0, top: 0, width: 800, height: 600 }),
    // The published host rect deliberately disagrees with a naive live read of
    // chatView, so a regression that measures geometry itself lands elsewhere.
    chatSurfaceEffectLeft: makeFakeElement({ left: 650, top: 20, width: 300, height: 600 }),
  };
  const hosts = [
    { element: dom.chatSurfaceEffectLeft, role: 'chat-left' },
  ];
  const layout = {
    sceneRect: { left: 30, top: 40, width: 920, height: 620 },
    hostRects: [
      { left: 650, top: 20, width: 300, height: 600 },
    ],
    interactionBlockRects: [],
  };
  const { router } = makeRouter({
    dom,
    routerOverrides: {
      getInputTarget: () => ({
        controller: { handleInput: (payload) => delivered.push(payload) },
        effectId: 'x', captureOnPress: false, generation: 4, inputDisabled: false,
        hosts, layout,
      }),
    },
  });
  [dom.chatView, dom.chatSurfaceEffectLeft].forEach((element) => {
    element.getBoundingClientRect = () => { throw new Error('live geometry read'); };
  });

  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', {
    pointerId: 9, clientX: 700, clientY: 100,
    composedPath: () => [{ matches: () => false }, dom.chatView],
  }));

  assert.deepEqual(delivered.map((payload) => payload.type), ['enter', 'press']);
  const press = delivered[1];
  assert.equal(press.surfaceRole, 'chat-left');
  assert.equal(press.sceneX, 670);
  assert.equal(press.sceneY, 60);
  assert.equal(press.localX, 50);
  assert.equal(press.localY, 80);
  router.dispose();
});

test('interactionBlockRects block a non-DOM target while the adjacent point remains live', () => {
  const delivered = [];
  const dom = {
    chatView: makeFakeElement({ left: 0, top: 0, width: 800, height: 600 }),
    homeView: makeFakeElement({ left: 0, top: 0, width: 800, height: 600 }),
    chatSurfaceEffectLeft: makeFakeElement({ left: 0, top: 0, width: 800, height: 600 }),
  };
  const target = {
    controller: { handleInput: (payload) => delivered.push(payload) },
    effectId: 'x', captureOnPress: false, generation: 2, inputDisabled: false,
    hosts: [
      { element: dom.chatSurfaceEffectLeft, role: 'chat-left' },
    ],
    layout: {
      sceneRect: { left: 0, top: 0, width: 800, height: 600 },
      hostRects: [
        { left: 0, top: 0, width: 800, height: 600 },
      ],
      interactionBlockRects: [{ left: 100, top: 100, width: 100, height: 100 }],
    },
  };
  const { router } = makeRouter({
    dom,
    routerOverrides: { getInputTarget: () => target },
  });
  const backgroundPath = () => [{ matches: () => false }, dom.chatView];

  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', {
    clientX: 150, clientY: 150, composedPath: backgroundPath,
  }));
  assert.equal(delivered.length, 0, 'snapshot region blocks even without a matching DOM blocker');

  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', {
    clientX: 201, clientY: 150, composedPath: backgroundPath,
  }));
  assert.deepEqual(delivered.map((payload) => payload.type), ['enter', 'press']);
  router.dispose();
});

// ── dispose ──────────────────────────────────────────────────────────────────

test('dispose is idempotent', () => {
  const delivered = [];
  const controller = { handleInput: (payload) => { delivered.push(payload); } };
  const { router, raf, dom } = makeRouter({
    routerOverrides: {
      getInputTarget: () => ({
        controller, effectId: 'x', captureOnPress: false,
        generation: 1, inputDisabled: false,
      }),
    },
  });
  router.dispose();
  router.dispose();
  // A disposed router is inert, not just non-throwing: events queued against
  // it never reach the controller and nothing new is coalesced.
  dom.chatView.fire('pointermove', { type: 'pointermove', pointerId: 1, clientX: 5, clientY: 5, composedPath: () => [] });
  raf.flush();
  assert.equal(delivered.length, 0, 'no dispatch after dispose');
  assert.equal(router._internals.getPendingMoveCount(), 0, 'no pending moves accumulate after dispose');
});

// ── listener lifecycle ──────────────────────────────────────────────────────

test('registerCleanup removes every DOM, window, and document listener the router attached', () => {
  const dom = {
    chatView: makeFakeElement({ left: 0, top: 0, width: 800, height: 600 }),
    homeView: makeFakeElement({ left: 0, top: 0, width: 800, height: 600 }),
  };
  const documentRef = Object.assign({ hidden: false }, makeFakeEventTarget());
  const { cleanups, windowEvents } = makeRouter({ dom, documentRef });

  const totalBefore = dom.chatView.totalListenerCount() + dom.homeView.totalListenerCount();
  assert.ok(totalBefore > 0, 'the router attached its pointer-event listeners at construction');
  assert.equal(windowEvents.listenerCount('blur'), 1, 'a single blur listener was attached');
  assert.equal(documentRef.listenerCount('visibilitychange'), 1, 'a single visibilitychange listener was attached');
  assert.equal(cleanups.length, 1, 'exactly one cleanup was registered');

  cleanups[0]();

  assert.equal(dom.chatView.totalListenerCount(), 0, 'chatView listeners removed');
  assert.equal(dom.homeView.totalListenerCount(), 0, 'homeView listeners removed');
  assert.equal(windowEvents.listenerCount('blur'), 0, 'window blur listener removed');
  assert.equal(documentRef.listenerCount('visibilitychange'), 0, 'document visibilitychange listener removed');
});

// ── Routed through the manager (moved from the S2 suite for the file cap) ──
// The manager only constructs a router when windowRef.rendererAppSurfaceInput
// exposes createSurfaceInputRouter (renderer-app-surface-effects.js:740-750).
// The S2 manager suite deliberately omits it, so the manager runs router-less
// there -- these cases opt in via the harness's makeRouterManager().

test('surface input routing: host resolution reaches native handleInput with correct role and local coords', () => {
  const controller = makeFakeController();
  const dom = makeRouterDom({
    chatRect: { left: 0, top: 0, width: 800, height: 600 },
    // One full-bleed chat host, offset from the chat view so local coordinates
    // cannot accidentally agree with client coordinates (F1, 2026-08-21).
    leftRect: { left: 40, top: 0, width: 760, height: 600 },
    homeRect: { left: 0, top: 0, width: 800, height: 600 },
  });
  const { manager, raf } = makeRouterManager({
    dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
  });

  manager.activateSurfaceEffect('fake-native');
  raf.flush();

  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', { clientX: 100, clientY: 50 }));
  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', { clientX: 500, clientY: 50 }));

  const presses = controller.calls.handleInput.filter((args) => args[0].type === 'press');
  assert.equal(presses.length, 2);
  assert.equal(presses[0][0].surfaceRole, 'chat-left');
  assert.equal(presses[0][0].localX, 60, 'relative to the full-bleed host rect (100 - 40)');
  assert.equal(presses[0][0].localY, 50);
  assert.equal(presses[1][0].surfaceRole, 'chat-left');
  assert.equal(presses[1][0].localX, 460, 'the far side of the chat view is the same host (500 - 40)');
  assert.equal(presses[1][0].localY, 50);

  dom.homeView.fire('pointerdown', makePointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerId: 2 }));
  const homePresses = controller.calls.handleInput.filter((args) => args[0].type === 'press' && args[0].surfaceRole === 'home');
  assert.equal(homePresses.length, 1);
});

test('surface input routing: blocker matrix blocks every interactive-chrome selector and lets background events through', () => {
  const controller = makeFakeController();
  const dom = makeRouterDom();
  const { manager, raf, surfaceInput } = makeRouterManager({
    dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
  });
  manager.activateSurfaceEffect('fake-native');
  raf.flush();

  const blockerTokens = surfaceInput.SURFACE_INPUT_BLOCKER_SELECTOR.split(', ');
  blockerTokens.forEach((token, index) => {
    const blockerNode = { matches: (selector) => selector.split(', ').indexOf(token) !== -1 };
    dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', {
      pointerId: 100 + index,
      clientX: 10,
      clientY: 10,
      composedPath: () => [blockerNode, dom.chatView],
    }));
  });
  assert.equal(controller.calls.handleInput.length, 0, 'every blocker-matched event never reaches handleInput');

  const bgNode = { matches: () => false };
  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', {
    pointerId: 999, clientX: 10, clientY: 10, composedPath: () => [bgNode, dom.chatView],
  }));
  assert.ok(
    controller.calls.handleInput.some((args) => args[0].type === 'press'),
    'an unblocked background event reaches handleInput',
  );

  // composedPath() fallback: no composedPath function on the event -- the
  // router falls back to target.closest(SURFACE_INPUT_BLOCKER_SELECTOR).
  const before = controller.calls.handleInput.length;
  const fallbackTarget = { closest: (selector) => (selector.indexOf('.composer') !== -1 ? {} : null) };
  dom.chatView.fire('pointerdown', {
    type: 'pointerdown', pointerId: 998, clientX: 10, clientY: 10, target: fallbackTarget,
  });
  assert.equal(controller.calls.handleInput.length, before, 'the closest() fallback still blocks');
});

test('surface input routing: the chat timeline forwards hover but keeps activation with foreground controls', () => {
  const delivered = [];
  const dom = makeRouterDom();
  const target = {
    controller: { handleInput: (payload) => delivered.push(payload) },
    effectId: 'x', captureOnPress: true, generation: 3, inputDisabled: false,
    hosts: [
      { element: dom.chatSurfaceEffectLeft, role: 'chat-left' },
    ],
    layout: {
      sceneRect: { left: 0, top: 0, width: 800, height: 600 },
      hostRects: [
        { left: 0, top: 0, width: 800, height: 600 },
      ],
      interactionBlockRects: [{ left: 100, top: 100, width: 500, height: 400 }],
    },
  };
  const { router, raf } = makeRouter({
    dom,
    routerOverrides: { getInputTarget: () => target },
  });
  const buttonNode = {
    matches: (selector) => selector.split(', ').includes('button'),
  };
  const timelineNode = {
    matches: (selector) => selector === surfaceInput.CHAT_AMBIENT_HOVER_SELECTOR
      || selector.split(', ').includes('.chat-thread-column'),
  };
  const timelinePath = () => [buttonNode, timelineNode, dom.chatView];

  dom.chatView.fire('pointermove', makePointerEvent('pointermove', {
    pointerId: 7, clientX: 200, clientY: 200, composedPath: timelinePath,
  }));
  raf.flush();
  assert.deepEqual(delivered.map((payload) => payload.type), ['enter', 'move'],
    'timeline hover bypasses both its DOM blocker and published interaction rectangle');

  let prevented = 0;
  ['pointerdown', 'pointerup', 'click'].forEach((eventName) => {
    dom.chatView.fire(eventName, makePointerEvent(eventName, {
      pointerId: 7,
      clientX: 200,
      clientY: 200,
      composedPath: timelinePath,
      preventDefault: () => { prevented += 1; },
    }));
  });
  assert.deepEqual(delivered.map((payload) => payload.type), ['enter', 'move'],
    'timeline press, release, and click never reach the effect');
  assert.deepEqual(dom.chatView.captureCalls, [], 'timeline activation never acquires effect capture');
  assert.equal(prevented, 0, 'foreground timeline events are never canceled by the router');
  assert.equal(router._internals.getPointerStateCount(), 1,
    'suppressed activation preserves the live hover state');

  dom.chatView.fire('pointermove', makePointerEvent('pointermove', {
    pointerId: 7, clientX: 220, clientY: 220, composedPath: timelinePath,
  }));
  raf.flush();
  assert.deepEqual(delivered.map((payload) => payload.type), ['enter', 'move', 'move'],
    'continued timeline movement does not synthesize a redundant re-entry');

  const heroNode = {
    matches: (selector) => selector === surfaceInput.CHAT_AMBIENT_HOVER_SELECTOR
      || selector.split(', ').includes('.chat-empty .hero-stack'),
  };
  const emptyHeroPath = () => [buttonNode, heroNode, dom.chatView];
  const beforeHero = delivered.length;
  dom.chatView.fire('pointermove', makePointerEvent('pointermove', {
    pointerId: 8, clientX: 300, clientY: 180, composedPath: emptyHeroPath,
  }));
  raf.flush();
  dom.chatView.fire('click', makePointerEvent('click', {
    pointerId: 8, clientX: 300, clientY: 180, composedPath: emptyHeroPath,
  }));
  assert.deepEqual(delivered.slice(beforeHero).map((payload) => payload.type), ['enter', 'move'],
    'empty-state prompt controls forward hover but keep activation with the foreground');

  const composerNode = {
    matches: (selector) => selector.split(', ').includes('.composer'),
  };
  dom.chatView.fire('pointermove', makePointerEvent('pointermove', {
    pointerId: 7,
    clientX: 20,
    clientY: 550,
    composedPath: () => [composerNode, dom.chatView],
  }));
  assert.equal(delivered.at(-1).type, 'leave', 'composer hover remains spatially blocked');

  const beforeHome = delivered.length;
  const homePanelNode = {
    matches: (selector) => selector.split(', ').includes('.home-panel'),
  };
  dom.homeView.fire('pointermove', makePointerEvent('pointermove', {
    pointerId: 18,
    clientX: 200,
    clientY: 200,
    composedPath: () => [homePanelNode, dom.homeView],
  }));
  raf.flush();
  assert.equal(delivered.length, beforeHome, 'Home content remains fully hover-blocked');

  dom.chatView.fire('pointermove', makePointerEvent('pointermove', {
    pointerId: 9, clientX: 240, clientY: 240, composedPath: timelinePath,
  }));
  raf.flush();
  dom.chatView.fire('pointercancel', makePointerEvent('pointercancel', {
    pointerId: 9, clientX: 240, clientY: 240, composedPath: timelinePath,
  }));
  assert.equal(delivered.at(-1).type, 'cancel', 'timeline cancellation still reaches lifecycle cleanup');
  router.dispose();
});

test('surface input routing: chat ambient hover-only behavior uses the closest fallback', () => {
  const delivered = [];
  const dom = makeRouterDom();
  const target = {
    controller: { handleInput: (payload) => delivered.push(payload) },
    effectId: 'x', captureOnPress: true, generation: 1, inputDisabled: false,
    layout: {
      sceneRect: { left: 0, top: 0, width: 800, height: 600 },
      hostRects: [],
      interactionBlockRects: [{ left: 0, top: 0, width: 800, height: 600 }],
    },
  };
  const { router, raf } = makeRouter({
    dom,
    routerOverrides: { getInputTarget: () => target },
  });
  const fallbackTarget = {
    closest: (selector) => {
      if (selector === surfaceInput.CHAT_AMBIENT_HOVER_SELECTOR) return {};
      if (selector.split(', ').includes('button')) return {};
      return null;
    },
  };
  const event = (type) => ({
    type, pointerId: 4, pointerType: 'mouse', clientX: 100, clientY: 100,
    target: fallbackTarget,
  });

  dom.chatView.fire('pointermove', event('pointermove'));
  raf.flush();
  dom.chatView.fire('pointerdown', event('pointerdown'));
  dom.chatView.fire('pointerup', event('pointerup'));
  dom.chatView.fire('click', event('click'));

  assert.deepEqual(delivered.map((payload) => payload.type), ['enter', 'move'],
    'closest fallback forwards hover and suppresses activation identically');
  assert.deepEqual(dom.chatView.captureCalls, []);
  assert.equal(router._internals.getPointerStateCount(), 1);
  router.dispose();
});

test('surface input routing: a far-side chat click reaches handleInput once without synthetic redispatch', () => {
  const controller = makeFakeController();
  const dom = makeRouterDom({
    leftRect: { left: 400, top: 0, width: 400, height: 600 },
  });
  const { manager, raf } = makeRouterManager({
    dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
  });
  manager.activateSurfaceEffect('fake-native');
  raf.flush();

  dom.chatView.fire('click', makePointerEvent('click', { clientX: 450, clientY: 300 }));

  const clicks = controller.calls.handleInput.filter((args) => args[0].type === 'click');
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0][0].surfaceRole, 'chat-left');
  assert.equal(clicks[0][0].localX, 50);
  assert.equal(dom.chatSurfaceEffectLeft.dispatched.length, 0);
});

test('surface input routing: pointermove is coalesced per pointerId until the rAF flush', () => {
  const controller = makeFakeController();
  const dom = makeRouterDom();
  const { manager, raf } = makeRouterManager({
    dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
  });
  manager.activateSurfaceEffect('fake-native');
  raf.flush();

  dom.chatView.fire('pointermove', makePointerEvent('pointermove', { pointerId: 1, clientX: 10, clientY: 10 }));
  dom.chatView.fire('pointermove', makePointerEvent('pointermove', { pointerId: 1, clientX: 20, clientY: 20 }));
  dom.chatView.fire('pointermove', makePointerEvent('pointermove', { pointerId: 1, clientX: 30, clientY: 30 }));

  assert.equal(
    controller.calls.handleInput.filter((a) => a[0].type === 'move').length,
    0,
    'nothing move-shaped dispatches before the rAF flush',
  );

  raf.flush();

  const moves = controller.calls.handleInput.filter((a) => a[0].type === 'move');
  assert.equal(moves.length, 1, 'three moves for the same pointer coalesce into a single dispatch');
  assert.equal(moves[0][0].clientX, 30, 'the last coordinates win');
  assert.equal(moves[0][0].clientY, 30);
});

test('surface input routing: interleaved pointermove for two pointers dispatches one move per pointer', () => {
  const controller = makeFakeController();
  const dom = makeRouterDom();
  const { manager, raf } = makeRouterManager({
    dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
  });
  manager.activateSurfaceEffect('fake-native');
  raf.flush();

  dom.chatView.fire('pointermove', makePointerEvent('pointermove', { pointerId: 1, clientX: 1, clientY: 1 }));
  dom.chatView.fire('pointermove', makePointerEvent('pointermove', { pointerId: 2, clientX: 2, clientY: 2 }));
  dom.chatView.fire('pointermove', makePointerEvent('pointermove', { pointerId: 1, clientX: 11, clientY: 11 }));
  dom.chatView.fire('pointermove', makePointerEvent('pointermove', { pointerId: 2, clientX: 22, clientY: 22 }));

  raf.flush();

  const moves = controller.calls.handleInput.filter((a) => a[0].type === 'move');
  assert.equal(moves.length, 2, 'one dispatch per pointer id');
  const byPointer = {};
  moves.forEach((args) => { byPointer[args[0].pointerId] = args[0]; });
  assert.equal(byPointer[1].clientX, 11);
  assert.equal(byPointer[2].clientX, 22);
});

test('surface input routing: a pending move flushes synchronously before its boundary event', () => {
  const controller = makeFakeController();
  const dom = makeRouterDom();
  const { manager, raf } = makeRouterManager({
    dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
  });
  manager.activateSurfaceEffect('fake-native');
  raf.flush();

  dom.chatView.fire('pointermove', makePointerEvent('pointermove', { pointerId: 1, clientX: 5, clientY: 5 }));
  dom.chatView.fire('pointerleave', makePointerEvent('pointerleave', { pointerId: 1, clientX: 5, clientY: 5 }));

  const types = controller.calls.handleInput
    .map((a) => a[0].type)
    .filter((t) => t === 'move' || t === 'leave');
  assert.deepEqual(types, ['move', 'leave'], 'the move flushes ahead of the leave, in that order');
});

test('surface input routing: press, release, and click dispatch immediately in event order, never coalesced', () => {
  const controller = makeFakeController();
  const dom = makeRouterDom();
  const { manager, raf } = makeRouterManager({
    dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
  });
  manager.activateSurfaceEffect('fake-native');
  raf.flush();

  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', { pointerId: 1, clientX: 5, clientY: 5 }));
  dom.chatView.fire('pointerup', makePointerEvent('pointerup', { pointerId: 1, clientX: 5, clientY: 5 }));
  dom.chatView.fire('click', makePointerEvent('click', { pointerId: 1, clientX: 5, clientY: 5 }));

  const types = controller.calls.handleInput
    .map((a) => a[0].type)
    .filter((t) => t === 'press' || t === 'release' || t === 'click');
  assert.deepEqual(types, ['press', 'release', 'click']);
  assert.equal(raf.size, 0, 'nothing was deferred to a rAF -- no move was ever queued');
});

test('surface input routing: input queued before an activation bump is dropped on generation mismatch', () => {
  const controllerA = makeFakeController();
  const controllerB = makeFakeController();
  const dom = makeRouterDom();
  const { manager, raf } = makeRouterManager({
    dom,
    registry: [NATIVE_ENTRY, NATIVE_ENTRY_2],
    factories: { 'fake-native': () => controllerA, 'fake-native-2': () => controllerB },
  });
  manager.activateSurfaceEffect('fake-native');
  raf.flush();

  dom.chatView.fire('pointermove', makePointerEvent('pointermove', { pointerId: 1, clientX: 5, clientY: 5 }));
  manager.activateSurfaceEffect('fake-native-2'); // bumps activationGeneration before the move flushes

  raf.flush();

  const movesA = controllerA.calls.handleInput.filter((a) => a[0].type === 'move');
  const movesB = controllerB.calls.handleInput.filter((a) => a[0].type === 'move');
  assert.equal(movesA.length, 0, 'the stale-generation move never reaches the outgoing controller');
  assert.equal(movesB.length, 0, 'nor the incoming one -- the payload carried the old generation');
});

test('surface input routing: pointer state clears on blur, visibility, session switch, and effect switch', async (t) => {
  await t.test('window blur cancels a live native pointer', () => {
    const controller = makeFakeController();
    const dom = makeRouterDom();
    const { manager, raf, windowExtras } = makeRouterManager({
      dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
    });
    manager.activateSurfaceEffect('fake-native');
    raf.flush();
    dom.chatView.fire('pointerenter', makePointerEvent('pointerenter', { pointerId: 1, clientX: 5, clientY: 5 }));

    windowExtras.fire('blur');

    const cancels = controller.calls.handleInput.filter((a) => a[0].type === 'cancel');
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0][0].reason, 'blur');
  });

  await t.test('documentRef visibilitychange with hidden=true clears the live pointer', () => {
    const controller = makeFakeController();
    const dom = makeRouterDom();
    const { manager, raf, documentRef } = makeRouterManager({
      dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
    });
    manager.activateSurfaceEffect('fake-native');
    raf.flush();
    dom.chatView.fire('pointerenter', makePointerEvent('pointerenter', { pointerId: 1, clientX: 5, clientY: 5 }));

    documentRef.hidden = true;
    documentRef.fire('visibilitychange');

    const cancels = controller.calls.handleInput.filter((a) => a[0].type === 'cancel');
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0][0].reason, 'visibility');
  });

  await t.test('session switch via setVisibleActivityScope clears the live pointer', () => {
    const controller = makeFakeController();
    const dom = makeRouterDom();
    const { manager, raf } = makeRouterManager({
      dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
    });
    manager.activateSurfaceEffect('fake-native');
    raf.flush();
    dom.chatView.fire('pointerenter', makePointerEvent('pointerenter', { pointerId: 1, clientX: 5, clientY: 5 }));

    manager.setVisibleActivityScope({ sessionId: 'other' });

    const cancels = controller.calls.handleInput.filter((a) => a[0].type === 'cancel');
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0][0].reason, 'session-switch');
  });

  await t.test('effect switch delivers the clear to the outgoing controller before disposal', () => {
    const controllerA = makeFakeController();
    const controllerB = makeFakeController();
    const dom = makeRouterDom();
    const { manager, raf } = makeRouterManager({
      dom,
      registry: [NATIVE_ENTRY, NATIVE_ENTRY_2],
      factories: { 'fake-native': () => controllerA, 'fake-native-2': () => controllerB },
    });
    manager.activateSurfaceEffect('fake-native');
    raf.flush();
    dom.chatView.fire('pointerenter', makePointerEvent('pointerenter', { pointerId: 1, clientX: 5, clientY: 5 }));

    manager.activateSurfaceEffect('fake-native-2');
    raf.flush();

    const cancelsA = controllerA.calls.handleInput.filter((a) => a[0].type === 'cancel');
    assert.equal(cancelsA.length, 1, 'the outgoing controller receives the clear');
    assert.equal(cancelsA[0][0].reason, 'effect-switch');
    const cancelsB = controllerB.calls.handleInput.filter((a) => a[0].type === 'cancel');
    assert.equal(cancelsB.length, 0, 'the incoming controller never sees a clear meant for the old one');
  });

  await t.test('clearSurfaceInputState called directly clears state with the given reason', () => {
    const controller = makeFakeController();
    const dom = makeRouterDom();
    const { manager, raf } = makeRouterManager({
      dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
    });
    manager.activateSurfaceEffect('fake-native');
    raf.flush();
    dom.chatView.fire('pointerenter', makePointerEvent('pointerenter', { pointerId: 1, clientX: 5, clientY: 5 }));

    manager.clearSurfaceInputState('manual-reason');

    const cancels = controller.calls.handleInput.filter((a) => a[0].type === 'cancel');
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0][0].reason, 'manual-reason');
  });
});

test('surface input routing: blocked-to-live re-entry synthesizes enter before the next native event', () => {
  const controller = makeFakeController();
  const dom = makeRouterDom();
  const { manager, raf } = makeRouterManager({
    dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
  });
  manager.activateSurfaceEffect('fake-native');
  raf.flush();

  const blockerNode = {
    matches: (selector) => selector !== surfaceInput.CHAT_AMBIENT_HOVER_SELECTOR,
  };
  dom.chatView.fire('pointermove', makePointerEvent('pointermove', {
    pointerId: 1, clientX: 5, clientY: 5, composedPath: () => [blockerNode, dom.chatView],
  }));
  assert.equal(controller.calls.handleInput.length, 0, 'blocked while never-live is a pure no-op');

  const bgNode = { matches: () => false };
  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', {
    pointerId: 1, clientX: 5, clientY: 5, composedPath: () => [bgNode, dom.chatView],
  }));

  const types = controller.calls.handleInput.map((a) => a[0].type);
  assert.deepEqual(types, ['enter', 'press'], 'enter synthesizes ahead of the press, in order');
});

test('surface input routing: blocked and high-cardinality pointer ids cannot grow retained state', () => {
  const controller = makeFakeController();
  const target = {
    controller, effectId: 'fake-native', captureOnPress: false,
    generation: 1, inputDisabled: false,
  };
  const { router, dom } = makeRouter({
    routerOverrides: { getInputTarget: () => target },
  });
  const blockerNode = {
    matches: (selector) => selector !== surfaceInput.CHAT_AMBIENT_HOVER_SELECTOR,
  };
  for (let pointerId = 1; pointerId <= 1000; pointerId += 1) {
    dom.chatView.fire('pointermove', makePointerEvent('pointermove', {
      pointerId, composedPath: () => [blockerNode, dom.chatView],
    }));
  }
  assert.equal(router._internals.getPointerStateCount(), 0,
    'never-live blocked pointers allocate no retained state');

  for (let pointerId = 1; pointerId <= 1000; pointerId += 1) {
    dom.chatView.fire('pointermove', makePointerEvent('pointermove', { pointerId }));
  }
  assert.ok(router._internals.getPointerStateCount() <= surfaceInput.MAX_POINTER_STATES,
    'live pointer state stays within the explicit capacity');
  assert.ok(router._internals.getPendingMoveCount() <= surfaceInput.MAX_POINTER_STATES,
    'coalesced move state stays within the same capacity reset boundary');
});

test('surface input routing: captureOnPress acquires and releases pointer capture on the surface element', () => {
  const controller = makeFakeController();
  const dom = makeRouterDom();
  const { manager, raf } = makeRouterManager({
    dom, registry: [NATIVE_CAPTURE_ENTRY], factories: { 'fake-native-capture': () => controller },
  });
  manager.activateSurfaceEffect('fake-native-capture');
  raf.flush();

  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', { pointerId: 7, clientX: 5, clientY: 5 }));
  assert.deepEqual(dom.chatView.captureCalls, [7]);

  dom.chatView.fire('pointerup', makePointerEvent('pointerup', { pointerId: 7, clientX: 5, clientY: 5 }));
  assert.deepEqual(dom.chatView.releaseCalls, [7]);
});

test('surface input routing: an effect without captureOnPress never captures the pointer', () => {
  const controller = makeFakeController();
  const dom = makeRouterDom();
  const { manager, raf } = makeRouterManager({
    dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
  });
  manager.activateSurfaceEffect('fake-native');
  raf.flush();

  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', { pointerId: 7, clientX: 5, clientY: 5 }));
  dom.chatView.fire('pointerup', makePointerEvent('pointerup', { pointerId: 7, clientX: 5, clientY: 5 }));

  assert.deepEqual(dom.chatView.captureCalls, []);
  assert.deepEqual(dom.chatView.releaseCalls, []);
});

test('surface input routing: repeated handleInput failures disable input capability at the policy threshold', () => {
  let shouldThrow = false;
  const controller = makeFakeController({
    onHandleInput: () => { if (shouldThrow) throw new Error('handleInput boom'); },
  });
  const dom = makeRouterDom();
  const { manager, raf } = makeRouterManager({
    dom, registry: [NATIVE_ENTRY], factories: { 'fake-native': () => controller },
  });
  manager.activateSurfaceEffect('fake-native');
  raf.flush();

  shouldThrow = true;
  // pointerdown on a never-live pointer synthesizes enter (failure 1) then
  // dispatches press (failure 2); pointerup dispatches release (failure 3 ->
  // FAILURE_POLICY.inputFailuresBeforeDisable).
  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', { pointerId: 1, clientX: 5, clientY: 5 }));
  dom.chatView.fire('pointerup', makePointerEvent('pointerup', { pointerId: 1, clientX: 5, clientY: 5 }));

  const status = manager.getStatus();
  assert.equal(status.runtimeStateByEffectId['fake-native'].inputDisabled, true);
  assert.equal(status.runtimeStateByEffectId['fake-native'].inputFailures, 3);
  assert.equal(status.activeEffectId, 'fake-native', 'the effect itself stays active -- input is a separate capability');

  const callsBefore = controller.calls.handleInput.length;
  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', { pointerId: 2, clientX: 5, clientY: 5 }));
  assert.equal(controller.calls.handleInput.length, callsBefore, 'further events are not delivered once input-disabled');
});

test('surface input routing: an input-disabled effect never acquires pointer capture', () => {
  let shouldThrow = false;
  const controller = makeFakeController({
    onHandleInput: () => { if (shouldThrow) throw new Error('handleInput boom'); },
  });
  const dom = makeRouterDom();
  const { manager, raf } = makeRouterManager({
    dom, registry: [NATIVE_CAPTURE_ENTRY], factories: { 'fake-native-capture': () => controller },
  });
  manager.activateSurfaceEffect('fake-native-capture');
  raf.flush();

  shouldThrow = true;
  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', { pointerId: 1, clientX: 5, clientY: 5 }));
  dom.chatView.fire('pointerup', makePointerEvent('pointerup', { pointerId: 1, clientX: 5, clientY: 5 }));
  assert.equal(manager.getStatus().runtimeStateByEffectId['fake-native-capture'].inputDisabled, true);

  const capturesBefore = dom.chatView.captureCalls.length;
  dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', { pointerId: 2, clientX: 5, clientY: 5 }));
  assert.equal(dom.chatView.captureCalls.length, capturesBefore,
    'capture acquisition honors the input-disabled flag, not just delivery');
});

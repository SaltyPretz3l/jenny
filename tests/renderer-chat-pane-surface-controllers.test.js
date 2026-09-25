'use strict';

/* renderer-chat-pane-surface-controllers - the per-pane chat surface cluster.
 *
 * Split view W0-1 lifted the construction of ONE pane's surface controllers
 * (scroll coordinator + viewport + pin-to-top) out of the lifecycle composition,
 * which sat at the 1015-line hard cap. The move is invisible by contract: same
 * factories, same option bags, same wiring calls, same dispose order. These
 * tests pin that contract so a later pane-aware slice cannot quietly change it.
 *
 * Dispose order is behaviour. The renderer's cleanup registry pops (LIFO), so
 * the app tears these down pin -> viewport -> scroll today; the cluster's
 * dispose() must reproduce exactly that sequence.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const MODULE_PATH = path.join(
  __dirname, '..', 'renderer', 'chat', 'renderer-chat-pane-surface-controllers.js'
);
const {
  createChatPaneSurfaceControllers,
} = require('../renderer/chat/renderer-chat-pane-surface-controllers.js');

const DOM_KEYS = Object.freeze([
  'chatView', 'chatSurfaceEffects', 'chatSurfaceEffectLeft', 'chatThreadStage',
  'chatThreadColumn', 'composerWrap', 'chatTimeline', 'chatThreadScroll',
]);

function createHarness(overrides = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { window } = dom;
  const nodes = {};
  for (const key of DOM_KEYS) {
    const node = window.document.createElement('div');
    node.id = key;
    window.document.body.appendChild(node);
    nodes[key] = node;
  }

  const calls = [];
  const disposals = [];
  const seen = {};

  const scrollCoordinator = {
    dispose() { disposals.push('scroll'); },
    setViewportController(controller) { calls.push({ call: 'setViewportController', controller }); },
    setPinController(controller) { calls.push({ call: 'setPinController', controller }); },
  };
  const viewportController = {
    disposeViewportController() { disposals.push('viewport'); },
    scrollThreadToTop() { return 'real-scrollThreadToTop'; },
    viewportReveal: { marker: 'reveal' },
  };
  const pinToTopController = {
    dispose() { disposals.push('pin'); },
    bind() {},
  };

  const factories = {
    scrollCoordinatorUtils: {
      createChatScrollCoordinator(options) {
        seen.scroll = options;
        return overrides.scrollReturnsNull ? null : scrollCoordinator;
      },
    },
    viewportUtils: {
      createViewportController(options) {
        seen.viewport = options;
        return overrides.viewportReturnsNull ? null : viewportController;
      },
    },
    pinToTopUtils: overrides.pinFactoryMissing ? {} : {
      createPinToTopController(options) {
        seen.pin = options;
        return pinToTopController;
      },
    },
  };

  const callbackLog = [];
  const callbacks = {
    appendClientLog: (...a) => { callbackLog.push(['appendClientLog', a]); },
    renderJumpControls: (...a) => { callbackLog.push(['renderJumpControls', a]); },
    isStreaming: () => true,
    mergeReasoningEntries: (existing, delta) => [...existing, ...delta],
    deriveFollowLatestFromScroll: () => true,
    shouldAutoScrollThread: () => true,
    escapeSelectorValue: (v) => String(v),
    getCurrentSessionMessages: () => [],
    buildInteractiveRecapViewModel: () => ({}),
    renderMessages: () => {},
    updateAssistantSpritePosition: () => {},
    getWayfinderController: () => overrides.wayfinderController || null,
  };

  const state = { currentSessionId: 'pane-surface-session', ui: {} };

  return {
    window, nodes, calls, disposals, seen, callbackLog, factories, callbacks, state,
    scrollCoordinator, viewportController, pinToTopController,
    build(extra = {}) {
      return createChatPaneSurfaceControllers({
        state,
        windowRef: window,
        constants: { MESSAGE_STATUS: { SENT: 'sent' } },
        dom: nodes,
        factories,
        controllers: { thinkingController: { id: 'thinking' }, reducedMotionQuery: { matches: false } },
        callbacks,
        ...extra,
      });
    },
  };
}

test('the cluster builds all three controllers from the injected factories and dom bundle', () => {
  const harness = createHarness();
  const cluster = harness.build();

  assert.equal(cluster.scrollCoordinator, harness.scrollCoordinator);
  assert.equal(cluster.viewport, harness.viewportController);
  assert.equal(cluster.pinToTop, harness.pinToTopController);

  // The scroll coordinator gets the pane's scroll + timeline nodes and the injected window.
  assert.equal(harness.seen.scroll.scrollContainer, harness.nodes.chatThreadScroll);
  assert.equal(harness.seen.scroll.timelineContainer, harness.nodes.chatTimeline);
  assert.equal(harness.seen.scroll.window, harness.window);
  assert.equal(harness.seen.scroll.state, harness.state);

  // The viewport gets the full eight-node surface bundle, both controllers and the coordinator.
  for (const key of DOM_KEYS) {
    assert.equal(harness.seen.viewport.dom[key], harness.nodes[key], `viewport dom.${key} is injected`);
  }
  assert.deepEqual(Object.keys(harness.seen.viewport.dom).sort(), [...DOM_KEYS].sort());
  assert.equal(harness.seen.viewport.controllers.scrollCoordinator, harness.scrollCoordinator);
  assert.equal(harness.seen.viewport.controllers.thinkingController.id, 'thinking');
  assert.equal(harness.seen.viewport.controllers.reducedMotionQuery.matches, false);
  assert.deepEqual(harness.seen.viewport.constants, { MESSAGE_STATUS: { SENT: 'sent' } });
  assert.equal(harness.seen.viewport.callbacks.renderMessages, harness.callbacks.renderMessages);
  assert.equal(harness.seen.viewport.callbacks.appendClientLog, harness.callbacks.appendClientLog);

  // The pin observer keeps the production selector, offset and listener policy.
  assert.equal(harness.seen.pin.scrollContainer, harness.nodes.chatThreadScroll);
  assert.equal(harness.seen.pin.timelineContainer, harness.nodes.chatTimeline);
  assert.equal(harness.seen.pin.pinnableSelector, '.chat-entry[data-message-role="user"]');
  assert.equal(harness.seen.pin.topOffset, 88);
  assert.equal(harness.seen.pin.listenForScroll, false);
});

test('the cluster hands the viewport and pin controllers back to the scroll coordinator', () => {
  const harness = createHarness();
  const cluster = harness.build();

  assert.deepEqual(
    harness.calls.map((entry) => entry.call),
    ['setViewportController', 'setPinController'],
    'the coordinator is wired to the viewport before the pin controller, as the composition does'
  );
  assert.equal(harness.calls[0].controller, cluster.viewport);
  assert.equal(harness.calls[1].controller, cluster.pinToTop);
});

test('pin onStateChange forwards the pane state to the wayfinder and repaints the jump controls', () => {
  const pinStates = [];
  const harness = createHarness({
    wayfinderController: { setPinState: (payload) => { pinStates.push(payload); } },
  });
  harness.build();

  harness.seen.pin.onStateChange({ visible: true, messageId: 'm-9' });
  assert.deepEqual(pinStates, [{ visible: true, messageId: 'm-9', sessionId: 'pane-surface-session' }]);
  assert.deepEqual(harness.callbackLog.map((entry) => entry[0]), ['renderJumpControls']);
});

test('pin onStateChange survives a wayfinder that does not exist yet', () => {
  // The wayfinder is constructed LATER in the composition than this cluster, so the
  // very first pin callback can land before it exists. It must still repaint the
  // composer jump controls rather than throwing on the missing controller.
  const harness = createHarness();
  harness.build();
  harness.seen.pin.onStateChange({ visible: false });
  assert.deepEqual(harness.callbackLog, [['renderJumpControls', []]]);
});

test('dispose runs pin -> viewport -> scroll exactly once and is idempotent', () => {
  const harness = createHarness();
  const cluster = harness.build();

  cluster.dispose();
  assert.deepEqual(
    harness.disposals,
    ['pin', 'viewport', 'scroll'],
    'the cluster reproduces the app teardown order (the cleanup registry pops LIFO)'
  );

  cluster.dispose();
  cluster.dispose();
  assert.deepEqual(harness.disposals, ['pin', 'viewport', 'scroll'], 'a second dispose is a no-op');
});

test('a dispose that throws does not stop the other two (the registry used to try/catch each)', () => {
  // Before W0-1 the three disposals were separate cleanup-registry entries and
  // renderer/app.js wraps each popped entry in its own try/catch, so a throwing pin
  // dispose could never skip the viewport or the coordinator. Fused into one
  // dispose(), the cluster has to keep that guarantee itself.
  const harness = createHarness();
  harness.pinToTopController.dispose = () => { harness.disposals.push('pin'); throw new Error('pin boom'); };
  harness.viewportController.disposeViewportController = () => { harness.disposals.push('viewport'); throw new Error('viewport boom'); };
  const cluster = harness.build();

  assert.doesNotThrow(() => cluster.dispose());
  assert.deepEqual(harness.disposals, ['pin', 'viewport', 'scroll'], 'every controller is still disposed, in order');
});

test('dispose tolerates a viewport whose disposeViewportController is null', () => {
  const harness = createHarness();
  harness.viewportController.disposeViewportController = null;
  const cluster = harness.build();
  assert.doesNotThrow(() => cluster.dispose());
  assert.deepEqual(harness.disposals, ['pin', 'scroll']);
});

test('dispose is safe when a factory returned nothing', () => {
  const harness = createHarness({ viewportReturnsNull: true, pinFactoryMissing: true });
  const cluster = harness.build();

  assert.equal(cluster.viewport, null);
  assert.equal(cluster.pinToTop, null);
  assert.doesNotThrow(() => cluster.dispose());
  assert.deepEqual(harness.disposals, ['scroll']);
});

test('paneId defaults to 0, is exposed, and an explicit id is carried through', () => {
  const harness = createHarness();
  assert.equal(harness.build().paneId, 0);
  assert.equal(harness.build({ paneId: undefined }).paneId, 0);
  assert.equal(harness.build({ paneId: null }).paneId, 0);
  assert.equal(harness.build({ paneId: 1 }).paneId, 1);
  assert.equal(harness.build({ paneId: 'right' }).paneId, 'right');
});

test('paneId changes nothing about how the controllers are built (W0-1 is invisible)', () => {
  const zero = createHarness();
  zero.build({ paneId: 0 });
  const one = createHarness();
  one.build({ paneId: 7 });

  assert.deepEqual(Object.keys(zero.seen.scroll).sort(), Object.keys(one.seen.scroll).sort());
  assert.deepEqual(Object.keys(zero.seen.viewport).sort(), Object.keys(one.seen.viewport).sort());
  assert.deepEqual(zero.seen.pin.pinnableSelector, one.seen.pin.pinnableSelector);
  assert.deepEqual(zero.seen.pin.topOffset, one.seen.pin.topOffset);
});

test('viewportApi passes the live viewport through and defaults every missing member', () => {
  const live = createHarness();
  const liveCluster = live.build();
  assert.equal(liveCluster.viewportApi.scrollThreadToTop(), 'real-scrollThreadToTop');
  assert.deepEqual(liveCluster.viewportApi.viewportReveal, { marker: 'reveal' });

  const dead = createHarness({ viewportReturnsNull: true });
  const api = dead.build().viewportApi;
  assert.equal(api.viewportReveal, null);
  assert.equal(api.getCurrentMessageById('x'), null);
  assert.equal(api.scrollMessageIntoView('x'), false);
  assert.equal(api.isInteractiveRoundRecapExpanded(), false);
  assert.equal(api.syncThreadScrollState(), true);
  assert.equal(api.getScrollBehavior(), 'auto');
  assert.equal(api.getComposerSafeOffset(), 0);
  assert.equal(api.measureComposerSafeOffset(), 0);
  assert.deepEqual(api.getScrollMetrics(), { scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  assert.deepEqual(api.composerLayoutRuntime, {
    measureCanvas: null, measureContext: null, resizeObserver: null, safeOffset: 0,
  });
  assert.deepEqual(api.getReasoningEntries({ reasoning: { entries: [1, 2] } }), [1, 2]);
  assert.deepEqual(api.getReasoningEntries(undefined), []);
  assert.equal(typeof api.scrollThreadToTop, 'function');
  assert.equal(typeof api.disposeViewportController, 'function');

  const state = { ui: { followLatest: false } };
  dead.state.ui = state.ui;
  api.setFollowLatest(true);
  assert.equal(dead.state.ui.followLatest, true);
});

test('the default mergeMessageReasoning merges through the injected mergeReasoningEntries', () => {
  const harness = createHarness({ viewportReturnsNull: true });
  const api = harness.build().viewportApi;

  assert.deepEqual(
    api.mergeMessageReasoning({ reasoning: { entries: ['a'] } }, { source: 'x', entriesDelta: ['b'] }),
    { source: 'x', entries: ['a', 'b'] }
  );
  assert.deepEqual(
    api.mergeMessageReasoning({ reasoning: { source: 'kept', entries: [] } }, null),
    { source: 'kept', entries: [] }
  );
  assert.deepEqual(api.mergeMessageReasoning({}, { entriesDelta: [] }), { source: 'none', entries: [] });
});

test('the cluster never reaches for the document itself', () => {
  const harness = createHarness();
  const doc = harness.window.document;
  const original = doc.getElementById;
  const lookups = [];
  doc.getElementById = function (id) { lookups.push(id); return original.call(this, id); };
  try {
    const cluster = harness.build();
    cluster.dispose();
  } finally {
    doc.getElementById = original;
  }
  assert.deepEqual(lookups, [], 'nodes arrive through the injected dom bundle, never a fresh lookup');

  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.equal(/getElementById|querySelector\s*\(/.test(source), false,
    'the module resolves no DOM of its own; the composition owns the pane dom bundle');
  assert.equal(/\bdocument\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), false,
    'the module has no document reference outside its header comment');
});

test('the module is UMD and registers the rendererChatPaneSurfaceControllers global', () => {
  // The composition-side proof (the shell builds exactly one cluster through that
  // global) lives in tests/renderer-controller-dispose.test.js; this only pins the
  // module's own export shape.
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.match(source, /root\.rendererChatPaneSurfaceControllers\s*=\s*factory\(\)/);
  assert.match(source, /module\.exports\s*=\s*factory\(\)/);
});
